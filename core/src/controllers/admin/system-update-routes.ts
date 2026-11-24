import type { Application, Request, Response } from 'express';
export {};

const systemUpdate = require('../../services/system-update');
const { requireOwner, handleApiError } = require('./middleware');

function sendUpdateError(res: Response, err: any): void {
    if (Number.isInteger(err?.statusCode)) {
        res.status(err.statusCode).json({
            ok: false,
            error: err?.message || '操作失败',
            code: err?.code,
        });
        return;
    }
    handleApiError(res, err);
}

function mountSystemUpdateRoutes(app: Application): void {
    app.use('/api/system/update', requireOwner);

    app.get('/api/system/update/status', async (_req: Request, res: Response) => {
        try {
            const data = await systemUpdate.getSystemUpdateStatus();
            res.json({ ok: true, data });
        } catch (err: any) {
            sendUpdateError(res, err);
        }
    });

    app.post('/api/system/update/check', async (_req: Request, res: Response) => {
        try {
            const data = await systemUpdate.checkSystemUpdates();
            res.json({ ok: true, data });
        } catch (err: any) {
            sendUpdateError(res, err);
        }
    });

    app.post('/api/system/update/pull', async (_req: Request, res: Response) => {
        try {
            const data = await systemUpdate.pullSystemUpdates();
            res.json({ ok: true, data });
        } catch (err: any) {
            sendUpdateError(res, err);
        }
    });

    app.post('/api/system/update/apply', async (req: Request, res: Response) => {
        try {
            const pullFirst = req.body?.pullFirst !== false;
            const data = await systemUpdate.applySystemUpdate({ pullFirst });
            res.json({ ok: true, data });
        } catch (err: any) {
            sendUpdateError(res, err);
        }
    });

    app.post('/api/system/update/rollback', async (req: Request, res: Response) => {
        try {
            const data = await systemUpdate.rollbackSystemRelease(req.body?.releaseId);
            res.json({ ok: true, data });
        } catch (err: any) {
            sendUpdateError(res, err);
        }
    });

    app.post('/api/system/update/releases/delete', async (req: Request, res: Response) => {
        try {
            const data = await systemUpdate.deleteSystemReleases({
                releaseIds: req.body?.releaseIds,
                cleanOrphans: req.body?.cleanOrphans,
            });
            res.json({ ok: true, data });
        } catch (err: any) {
            sendUpdateError(res, err);
        }
    });

    app.put('/api/system/update/backup-setting', async (req: Request, res: Response) => {
        try {
            const data = await systemUpdate.setSystemBackupEnabled(req.body?.keepBackups);
            res.json({ ok: true, data });
        } catch (err: any) {
            sendUpdateError(res, err);
        }
    });
}

module.exports = { mountSystemUpdateRoutes };
