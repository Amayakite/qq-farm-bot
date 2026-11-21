import crypto from 'node:crypto';
import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
import { WxLoginService } from '../../services/wx-login/service';
import type { ScanStatus, WxLoginSession } from '../../services/wx-login/service';

export { };

const { resolveAuthContext } = require('./middleware');
const store = require('../../models/store');

const TARGET_APP_ID = 'wx5306c5978fdb76e4';
const TASK_TTL_MS = 110_000;
type Status = ScanStatus | 'ready_for_code' | 'failed';
interface Task { id: string; token: string; ownerId: string; createdAt: number; status: Status; session: WxLoginSession; qr: Buffer; timer: NodeJS.Timeout; code?: string; pending?: Promise<void>; }
const tasks = new Map<string, Task>();
const creating = new Set<string>();
const wxLogin = new WxLoginService();

function hasLegacyWxTask(ownerId: string): boolean {
    return creating.has(ownerId) || [...tasks.values()].some(task => task.ownerId === ownerId && Date.now() - task.createdAt < TASK_TTL_MS);
}

function destroy(task: Task): void {
    if (!tasks.delete(task.id)) return;
    clearTimeout(task.timer);
    wxLogin.destroy(task.session);
    task.code = undefined;
}
function publicTask(task: Task) { return { task_id: task.id, app_id: TARGET_APP_ID, status: task.status, expires_at: Math.floor((task.createdAt + TASK_TTL_MS) / 1000) }; }
function findTask(req: Request, res: Response): Task | null {
    const task = tasks.get(String(req.params.taskId || ''));
    if (!task || task.token !== (req as any).adminToken || Date.now() - task.createdAt >= TASK_TTL_MS) {
        res.status(404).json({ ok: false, error: 'Login task not found or expired' });
        return null;
    }
    return task;
}
async function createTask(ownerId: string, token: string): Promise<Task> {
    const { session, qr } = await wxLogin.createQrSession();
    const timer = setTimeout(() => destroy(task), TASK_TTL_MS);
    timer.unref();
    const task: Task = { id: crypto.randomBytes(32).toString('hex'), token, ownerId, createdAt: Date.now(), status: 'waiting', session, qr, timer };
    tasks.set(task.id, task);
    return task;
}
async function poll(task: Task): Promise<void> { if (task.status === 'authorized' || task.status === 'ready_for_code') return; task.status = await wxLogin.poll(task.session); }
async function confirm(task: Task): Promise<void> {
    if (task.status !== 'authorized') throw new Error('Waiting for scan authorization');
    await wxLogin.confirm(task.session);
    task.status = 'ready_for_code';
}
async function consumeCode(task: Task): Promise<void> { if (task.status !== 'ready_for_code') throw new Error('Login code is not ready'); task.code = await wxLogin.issueCode(task.session, TARGET_APP_ID); }

function mountWxLoginRoutes(app: Application, ctx: AdminContext): void {
    app.post('/api/wx-login/tasks', async (req, res) => {
        if (!store.getLoginSettings().wechatQrLogin) return res.status(403).json({ ok: false, error: '微信扫码登录未开启' });
        if (req.body?.app_id && req.body.app_id !== TARGET_APP_ID) return res.status(400).json({ ok: false, error: 'Unsupported app_id' });
        const { auth, adminToken } = req as any;
        const ownerId = String(auth.user.id);
        const active = [...tasks.values()].filter(task => task.ownerId === ownerId);
        if (creating.has(ownerId) || active.length >= 3 || ctx.scanTasks?.hasPending('wx', ownerId)) {
            return res.status(429).json({ ok: false, error: '扫码登录任务过多，请稍后重试' });
        }
        creating.add(ownerId);
        try {
            const task = await createTask(ownerId, adminToken);
            const { error } = resolveAuthContext(ctx, adminToken);
            if (res.destroyed || error) {
                destroy(task);
                if (!res.destroyed && error) res.status(error.status).json(error.body);
                return;
            }
            res.json({ ok: true, data: { ...publicTask(task), qr_url: `/api/wx-login/tasks/${task.id}/qr` } });
        } catch (error: any) {
            if (!res.destroyed) res.status(502).json({ ok: false, error: error.message });
        } finally {
            creating.delete(ownerId);
        }
    });
    app.get('/api/wx-login/tasks/:taskId/qr', (req, res) => { const task = findTask(req, res); if (task) res.type('jpeg').send(task.qr); });
    app.delete('/api/wx-login/tasks/:taskId', (req, res) => {
        const task = findTask(req, res);
        if (!task) return;
        destroy(task);
        return res.json({ ok: true });
    });
    app.get('/api/wx-login/tasks/:taskId/status', async (req, res) => {
        const task = findTask(req, res);
        if (!task) return;
        try {
            if (task.status === 'waiting' || task.status === 'scanned') {
                if (!task.pending) task.pending = poll(task).finally(() => { task.pending = undefined; });
                await task.pending;
                if (!findTask(req, res)) return;
            }
            const data = publicTask(task);
            if (task.status === 'cancelled' || task.status === 'expired') destroy(task);
            res.json({ ok: true, data });
        } catch (error: any) {
            task.status = 'failed';
            destroy(task);
            res.status(502).json({ ok: false, error: error.message });
        }
    });
    app.post('/api/wx-login/tasks/:taskId/confirm', async (req, res) => {
        const task = findTask(req, res);
        if (!task) return;
        try {
            await task.pending;
            if (!findTask(req, res)) return;
            if (task.status === 'authorized') {
                if (!task.pending) task.pending = confirm(task).finally(() => { task.pending = undefined; });
                await task.pending;
                if (!findTask(req, res)) return;
            }
            if (task.status !== 'ready_for_code') {
                return res.status(409).json({ ok: false, error: '请先完成扫码确认' });
            }
            res.json({ ok: true, data: publicTask(task) });
        } catch (error: any) {
            task.status = 'failed';
            destroy(task);
            res.status(502).json({ ok: false, error: error.message });
        }
    });
    app.post('/api/wx-login/tasks/:taskId/code', async (req, res) => {
        const task = findTask(req, res);
        if (!task) return;
        if (task.pending || task.status !== 'ready_for_code') {
            return res.status(409).json({ ok: false, error: '扫码登录 Code 尚未就绪' });
        }
        try {
            task.pending = consumeCode(task);
            await task.pending;
            if (!findTask(req, res)) return;
            if (!resolveAuthContext(ctx, task.token).auth) {
                destroy(task);
                return res.status(401).json({ ok: false, error: 'Unauthorized' });
            }
            const data = { openid: task.session.openid, app_id: TARGET_APP_ID, code: task.code, nickname: task.session.nickname || '', err_msg: 'login:ok' };
            destroy(task);
            res.json({ ok: true, data });
        } catch (error: any) {
            task.status = 'failed';
            destroy(task);
            res.status(502).json({ ok: false, error: error.message });
        }
    });
}
module.exports = { mountWxLoginRoutes, hasLegacyWxTask };
