import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
import { createQqLoginClient, QQ_MINIAPP_APP_ID } from '../../services/qq-login/service';
export {};

const { resolveAuthContext } = require('./middleware');

const TASK_TTL_MS = 5 * 60_000;
interface LoginTaskOwner {
    token: string;
    timer: NodeJS.Timeout;
    expiresAt: number;
    operation?: 'code' | 'cancel';
    client: ReturnType<typeof createQqLoginClient>;
}
const taskOwners = new Map<string, LoginTaskOwner>();
let creating = false; // The configured NapCat instance only handles one login workflow at a time.

function forgetTask(id: string): void {
    const task = taskOwners.get(id);
    if (task) clearTimeout(task.timer);
    taskOwners.delete(id);
}

function finishTaskOperation(id: string, owner: LoginTaskOwner): void {
    owner.operation = undefined;
    if (owner.expiresAt <= Date.now() && taskOwners.get(id) === owner) forgetTask(id);
}

function findOwnedTask(req: Request, res: Response): LoginTaskOwner | null {
    const token = (req as any).adminToken;
    const task = taskOwners.get(String(req.params.taskId || ''));
    if (!token || !task || task.token !== token) {
        res.status(404).json({ ok: false, error: 'Login task not found or expired' });
        return null;
    }
    return task;
}

function publicTask(task: any) {
    return {
        task_id: task.taskId,
        status: task.status,
        qr_image: task.qrImage,
        expires_at: task.expiresAt,
    };
}

function sendError(res: Response, error: any, fallback: string): void {
    res.json({
        ok: false,
        error: String(error?.message || '').trim() || fallback,
    });
}

function channelBusy(res: Response) {
    return res.status(409).json({ ok: false, errorType: 'qq_login_busy', error: '扫码通道正在使用，空闲后可获取二维码' });
}

function mountQqLoginRoutes(app: Application, ctx: AdminContext): void {
    app.post('/api/qq-login/tasks', async (req: Request, res: Response) => {
        if (creating || taskOwners.size || ctx.scanTasks?.hasPending('qq')) return channelBusy(res);
        creating = true;
        const token = (req as any).adminToken;
        try {
            const client = createQqLoginClient();
            const task = await client.open();
            const { error } = resolveAuthContext(ctx, token);
            if (res.destroyed || error) {
                // No client can receive the task ID and cancel it later.
                await client.release(task.taskId).catch(() => undefined);
                if (!res.destroyed && error) res.status(error.status).json(error.body);
                return;
            }
            const expiresAtMs = task.expiresAt < 1e12 ? task.expiresAt * 1000 : task.expiresAt;
            const ttl = expiresAtMs > Date.now() ? Math.min(expiresAtMs - Date.now(), TASK_TTL_MS) : TASK_TTL_MS;
            const timer = setTimeout(() => {
                if (!taskOwners.get(task.taskId)?.operation) forgetTask(task.taskId);
            }, ttl);
            timer.unref();
            taskOwners.set(task.taskId, { token, timer, expiresAt: Date.now() + ttl, client });
            res.json({ ok: true, data: publicTask(task) });
        }
        catch (error: any) {
            if (!res.destroyed && error?.code === 'WORKFLOW_BUSY') return channelBusy(res);
            if (!res.destroyed) sendError(res, error, 'QQ 登录任务创建失败');
        }
        finally {
            creating = false;
        }
    });

    app.post('/api/qq-login/tasks/:taskId/status', async (req: Request, res: Response) => {
        try {
            const owner = findOwnedTask(req, res);
            if (!owner) return;
            const task = await owner.client.status(String(req.params.taskId || ''));
            if (!findOwnedTask(req, res)) return;
            if (!resolveAuthContext(ctx, (req as any).adminToken).auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            if (!owner.operation && ['cancelled', 'expired', 'failed'].includes(task.status)) forgetTask(task.taskId);
            res.json({ ok: true, data: publicTask(task) });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 登录状态查询失败');
        }
    });

    app.post('/api/qq-login/tasks/:taskId/code', async (req: Request, res: Response) => {
        const owner = findOwnedTask(req, res);
        if (!owner) return;
        if (owner.operation) return res.status(409).json({ ok: false, error: '扫码任务正在处理，请稍候' });
        const taskId = String(req.params.taskId || '');
        owner.operation = 'code';
        try {
            const result = await owner.client.authorize(taskId);
            forgetTask(taskId);
            if (!resolveAuthContext(ctx, (req as any).adminToken).auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            res.json({ ok: true, data: { code: result.code, nickname: result.nickname || '', app_id: QQ_MINIAPP_APP_ID } });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 小程序授权 Code 获取失败');
        }
        finally {
            finishTaskOperation(taskId, owner);
        }
    });

    app.post('/api/qq-login/tasks/:taskId/cancel', async (req: Request, res: Response) => {
        const owner = findOwnedTask(req, res);
        if (!owner) return;
        if (owner.operation) return res.status(409).json({ ok: false, error: '扫码任务结束后会自动释放通道' });
        const taskId = String(req.params.taskId || '');
        owner.operation = 'cancel';
        try {
            await owner.client.release(taskId);
            forgetTask(taskId);
            res.json({ ok: true });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 登录任务取消失败');
        }
        finally {
            finishTaskOperation(taskId, owner);
        }
    });
}

module.exports = { mountQqLoginRoutes };
