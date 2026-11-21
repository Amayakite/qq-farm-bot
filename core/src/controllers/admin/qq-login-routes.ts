import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
import { cancelLoginTask, createLoginTask, getMiniappCode, QQ_MINIAPP_APP_ID, queryLoginStatus } from '../../services/qq-login/service';
export {};

const { resolveAuthContext } = require('./middleware');

const TASK_TTL_MS = 5 * 60_000;
const taskOwners = new Map<string, { token: string; timer: NodeJS.Timeout }>();
let creating = false; // The configured NapCat instance only handles one login workflow at a time.

function forgetTask(id: string): void {
    const task = taskOwners.get(id);
    if (task) clearTimeout(task.timer);
    taskOwners.delete(id);
}

function checkTaskOwner(req: Request, res: Response, taskId: unknown): boolean {
    const token = (req as any).adminToken;
    if (!token || taskOwners.get(String(taskId || ''))?.token !== token) {
        res.status(404).json({ ok: false, error: 'Login task not found or expired' });
        return false;
    }
    return true;
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

function mountQqLoginRoutes(app: Application, ctx: AdminContext): void {
    app.post('/api/qq-login/tasks', async (req: Request, res: Response) => {
        if (creating || taskOwners.size) {
            return res.status(409).json({ ok: false, error: 'QQ 登录工作流繁忙，请稍后重试' });
        }
        creating = true;
        const token = (req as any).adminToken;
        try {
            const task = await createLoginTask();
            const { error } = resolveAuthContext(ctx, token);
            if (res.destroyed || error) {
                // No client can receive the task ID and cancel it later.
                await cancelLoginTask(task.taskId).catch(() => undefined);
                if (!res.destroyed && error) res.status(error.status).json(error.body);
                return;
            }
            const expiresAtMs = task.expiresAt < 1e12 ? task.expiresAt * 1000 : task.expiresAt;
            const ttl = expiresAtMs > Date.now() ? Math.min(expiresAtMs - Date.now(), TASK_TTL_MS) : TASK_TTL_MS;
            const timer = setTimeout(() => forgetTask(task.taskId), ttl);
            timer.unref();
            taskOwners.set(task.taskId, { token, timer });
            res.json({ ok: true, data: publicTask(task) });
        }
        catch (error: any) {
            if (!res.destroyed) sendError(res, error, 'QQ 登录任务创建失败');
        }
        finally {
            creating = false;
        }
    });

    app.post('/api/qq-login/tasks/:taskId/status', async (req: Request, res: Response) => {
        try {
            if (!checkTaskOwner(req, res, req.params.taskId)) return;
            const task = await queryLoginStatus(String(req.params.taskId || ''));
            if (!checkTaskOwner(req, res, req.params.taskId)) return;
            if (!resolveAuthContext(ctx, (req as any).adminToken).auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            if (['cancelled', 'expired', 'failed'].includes(task.status)) forgetTask(task.taskId);
            res.json({ ok: true, data: publicTask(task) });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 登录状态查询失败');
        }
    });

    app.post('/api/qq-login/tasks/:taskId/code', async (req: Request, res: Response) => {
        try {
            if (!checkTaskOwner(req, res, req.params.taskId)) return;
            const result = await getMiniappCode(String(req.params.taskId || ''));
            if (!checkTaskOwner(req, res, req.params.taskId)) return;
            forgetTask(String(req.params.taskId || ''));
            if (!resolveAuthContext(ctx, (req as any).adminToken).auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            res.json({ ok: true, data: { code: result.code, nickname: result.nickname || '', app_id: QQ_MINIAPP_APP_ID } });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 小程序授权 Code 获取失败');
        }
    });

    app.post('/api/qq-login/tasks/:taskId/cancel', async (req: Request, res: Response) => {
        try {
            if (!checkTaskOwner(req, res, req.params.taskId)) return;
            await cancelLoginTask(String(req.params.taskId || ''));
            forgetTask(String(req.params.taskId || ''));
            res.json({ ok: true });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 登录任务取消失败');
        }
    });
}

module.exports = { mountQqLoginRoutes };
