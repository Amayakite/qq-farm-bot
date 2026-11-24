import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const store = require('../../models/store');
const userStore = require('../../models/user-store');
const codeStore = require('../../models/activation-code-store');
const auditStore = require('../../models/admin-audit-store');
const { CONFIG } = require('../../config/config');
const { createModuleLogger } = require('../../services/logger');
const { getAccountList, rawAccountList, handleApiError, requireOwner } = require('./middleware');

const tenantLogger = createModuleLogger('tenant');

function recordAudit(req: Request, action: string, target: {
    tenantId?: string; username?: string; codeId?: string; batchId?: string; count?: number;
}, required = false): void {
    const actor = (req as any).auth.user;
    try {
        auditStore.appendAudit({ action, actorId: actor.id, actor: actor.username, ...target });
    } catch (error: any) {
        if (required) throw error;
        tenantLogger.warn('管理员操作记录写入失败', { action, actorId: actor.id, ...target, error: error?.message });
    }
}

function kickSockets(ctx: AdminContext, userId: string): void {
    if (!ctx.io) return;
    for (const socket of ctx.io.sockets.sockets.values()) {
        if (String((socket.data as any).userId || '') === userId) socket.disconnect(true);
    }
}

function tenantAccountList(ctx: AdminContext, tenantId: string): any[] {
    return getAccountList(ctx, { user: { id: tenantId, role: 'tenant' } });
}

function tenantSummaries(ctx: AdminContext): any[] {
    const counts = new Map<string, { accountCount: number; runningCount: number }>();
    for (const account of rawAccountList(ctx)) {
        const ownerId = String(account.ownerId || 'owner');
        const count = counts.get(ownerId) || { accountCount: 0, runningCount: 0 };
        count.accountCount++;
        if (account.running === true) count.runningCount++;
        counts.set(ownerId, count);
    }
    return userStore.listUsers()
        .filter((user: any) => user.role === 'tenant')
        .map((user: any) => ({ ...user, ...(counts.get(user.id) || { accountCount: 0, runningCount: 0 }) }))
        .sort((a: any, b: any) => b.createdAt - a.createdAt);
}

function mountTenantRoutes(app: Application, ctx: AdminContext): void {
    app.use('/api/admin', requireOwner);

    app.get('/api/admin/audit', (req: Request, res: Response) => {
        try {
            const data = auditStore.listAudit({
                category: String(req.query.category || ''),
                search: String(req.query.search || ''),
                page: Number(req.query.page),
            });
            return res.json({ ok: true, data });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.get('/api/admin/overview', (_req: Request, res: Response) => {
        const tenants = tenantSummaries(ctx);
        res.json({
            ok: true,
            data: {
                tenants,
                tenantCount: tenants.length,
                activeTenantCount: tenants.filter((tenant: any) => tenant.status === 'active' && (!tenant.expiresAt || tenant.expiresAt > Date.now())).length,
                accountCount: tenants.reduce((sum: number, tenant: any) => sum + tenant.accountCount, 0),
                runningCount: tenants.reduce((sum: number, tenant: any) => sum + tenant.runningCount, 0),
                codes: codeStore.stats(),
            },
        });
    });

    app.get('/api/admin/tenants', (_req: Request, res: Response) => {
        res.json({ ok: true, data: tenantSummaries(ctx) });
    });

    app.post('/api/admin/tenants', (req: Request, res: Response) => {
        try {
            const body = req.body || {};
            const days = Math.max(1, Math.min(3650, Number.parseInt(body.days, 10) || 30));
            const created = userStore.createTenant({
                username: String(body.username || '').trim(),
                password: String(body.password || ''),
                expiresAt: Date.now() + days * 86_400_000,
                maxAccounts: body.maxAccounts !== undefined ? body.maxAccounts : CONFIG.defaultMaxAccounts,
                note: body.note,
            });
            if (!created.ok) return res.status(400).json({ ok: false, error: created.message, errorType: created.error });
            tenantLogger.info('创建租户', { username: created.user.username, days, operator: 'owner' });
            recordAudit(req, 'tenant.create', { tenantId: created.user.id, username: created.user.username });
            return res.json({ ok: true, data: userStore.publicUser(created.user) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/admin/tenants/:id/extend', (req: Request, res: Response) => {
        const previous = userStore.getUserById(req.params.id);
        const result = userStore.extendTenant(req.params.id, (req.body || {}).days);
        if (!result.ok) return res.status(400).json({ ok: false, error: result.message, errorType: result.error });
        tenantLogger.info('延期租户', { id: req.params.id, days: result.days, expiresAt: result.user.expiresAt });
        if (previous && userStore.isExpired(previous)) ctx.provider.recoverTenantAccounts?.(result.user.id);
        recordAudit(req, 'tenant.extend', { tenantId: result.user.id, username: result.user.username });
        return res.json({ ok: true, data: result.user });
    });

    app.post('/api/admin/tenants/:id/status', async (req: Request, res: Response) => {
        const previous = userStore.getUserById(req.params.id);
        const status = String((req.body || {}).status || '');
        const result = userStore.updateTenant(req.params.id, { status });
        if (!result.ok) return res.status(400).json({ ok: false, error: result.message, errorType: result.error });
        if (result.user.status === 'disabled') {
            ctx.scanTasks?.cancelTenant(String(req.params.id));
            ctx.tokens.deleteByUserId(String(req.params.id));
            kickSockets(ctx, String(req.params.id));
            for (const account of tenantAccountList(ctx, String(req.params.id))) {
                try { await ctx.provider.stopAccount(account.id, { preserveIntent: true }); } catch { /* Retry during lifecycle sweep. */ }
            }
        } else if (previous?.status === 'disabled') {
            ctx.provider.recoverTenantAccounts?.(result.user.id);
        }
        tenantLogger.info('更新租户状态', { id: req.params.id, status: result.user.status });
        recordAudit(req, result.user.status === 'disabled' ? 'tenant.disable' : 'tenant.enable', { tenantId: result.user.id, username: result.user.username });
        return res.json({ ok: true, data: result.user });
    });

    app.post('/api/admin/tenants/:id/quota', (req: Request, res: Response) => {
        const result = userStore.updateTenant(req.params.id, { maxAccounts: (req.body || {}).maxAccounts });
        if (!result.ok) return res.status(400).json({ ok: false, error: result.message, errorType: result.error });
        recordAudit(req, 'tenant.quota', { tenantId: result.user.id, username: result.user.username });
        return res.json({ ok: true, data: result.user });
    });

    app.post('/api/admin/tenants/:id/password', (req: Request, res: Response) => {
        const target = userStore.getUserById(req.params.id);
        if (!target || target.role !== 'tenant') return res.status(404).json({ ok: false, error: '租户不存在' });
        const result = userStore.resetPassword(req.params.id, (req.body || {}).password);
        if (!result.ok) return res.status(400).json({ ok: false, error: result.message, errorType: result.error });
        ctx.tokens.deleteByUserId(req.params.id);
        kickSockets(ctx, String(req.params.id));
        tenantLogger.info('重置租户密码', { id: req.params.id });
        recordAudit(req, 'tenant.password', { tenantId: target.id, username: target.username });
        return res.json({ ok: true, data: result.user });
    });

    app.post('/api/admin/tenants/:id/kick', (req: Request, res: Response) => {
        const target = userStore.getUserById(req.params.id);
        if (target?.role !== 'tenant') return res.status(404).json({ ok: false, error: '租户不存在' });
        const removed = ctx.tokens.deleteByUserId(req.params.id);
        kickSockets(ctx, String(req.params.id));
        recordAudit(req, 'tenant.kick', { tenantId: target.id, username: target.username, count: removed });
        return res.json({ ok: true, data: { removed } });
    });

    app.delete('/api/admin/tenants/:id', async (req: Request, res: Response) => {
        const target = userStore.getUserById(req.params.id);
        if (!target || target.role !== 'tenant') return res.status(404).json({ ok: false, error: '租户不存在' });
        const confirm = String((req.body || {}).confirm || req.query.confirm || '');
        if (confirm !== target.username) {
            return res.status(400).json({ ok: false, error: '请输入租户用户名以确认删除', errorType: 'confirm_required' });
        }
        try {
            userStore.updateTenant(target.id, { status: 'disabled' });
            ctx.scanTasks?.cancelTenant(target.id);
            ctx.tokens.deleteByUserId(target.id);
            kickSockets(ctx, target.id);
            const accounts = tenantAccountList(ctx, target.id);
            for (const account of accounts) {
                await ctx.provider.stopAccount(account.id);
                ctx.provider.clearLogs?.(account.id);
                ctx.provider.clearAccountLogs?.(account.id);
                store.deleteAccount(account.id);
            }
            const deleted = userStore.deleteTenant(target.id);
            tenantLogger.warn('删除租户', { id: target.id, username: target.username, accounts: accounts.length });
            recordAudit(req, 'tenant.delete', { tenantId: target.id, username: target.username, count: accounts.length });
            return res.json({ ok: true, data: { ...deleted.user, deletedAccounts: accounts.length } });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.get('/api/admin/codes', (req: Request, res: Response) => {
        const filters = {
            status: String(req.query.status || ''),
            type: String(req.query.type || ''),
            batchId: String(req.query.batchId || ''),
        };
        const data = req.query.page === undefined ? codeStore.listCodes(filters) : codeStore.listCodesPage({
            ...filters,
            tenantId: String(req.query.tenantId || ''),
            search: String(req.query.search || ''),
            page: Number(req.query.page),
            pageSize: Number(req.query.pageSize),
        });
        res.json({ ok: true, data });
    });

    app.get('/api/admin/codes/:id', (req: Request, res: Response) => {
        const code = codeStore.getPublicCode(req.params.id);
        if (!code) return res.status(404).json({ ok: false, error: '激活码不存在' });
        return res.json({ ok: true, data: code });
    });

    app.get('/api/admin/codes/:id/value', (req: Request, res: Response) => {
        try {
            const result = codeStore.revealCode(req.params.id);
            if (!result.ok) {
                return res.status(result.error === 'not_found' ? 404 : 409)
                    .json({ ok: false, error: result.message, errorType: result.error });
            }
            tenantLogger.info('读取完整激活码', { id: req.params.id });
            recordAudit(req, 'code.reveal', { codeId: String(req.params.id) }, true);
            return res.json({ ok: true, data: { code: result.code } });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.get('/api/admin/codes/batch/:batchId/values', (req: Request, res: Response) => {
        try {
            const result = codeStore.revealBatch(req.params.batchId);
            if (!result.ok) return res.status(404).json({ ok: false, error: result.message, errorType: result.error });
            tenantLogger.info('读取批次待兑换码', { batchId: req.params.batchId, count: result.codes.length });
            recordAudit(req, 'code.reveal_batch', { batchId: String(req.params.batchId), count: result.codes.length }, true);
            return res.json({ ok: true, data: result });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/admin/codes', (req: Request, res: Response) => {
        try {
            const body = req.body || {};
            const result = codeStore.generateCodes({
                count: body.count,
                days: body.days,
                type: body.type,
                maxAccounts: body.maxAccounts !== undefined ? body.maxAccounts : CONFIG.defaultMaxAccounts,
                redeemBefore: body.redeemBefore,
                note: body.note,
                targetTenantId: body.targetTenantId,
                createdBy: 'owner',
            });
            if (!result.ok) return res.status(400).json({ ok: false, error: result.message, errorType: result.error });
            tenantLogger.info('生成激活码', { batchId: result.batchId, count: result.codes.length, type: body.type, days: body.days });
            recordAudit(req, 'code.generate', { batchId: result.batchId, count: result.codes.length });
            return res.json({ ok: true, data: result });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.put('/api/admin/codes/:id', (req: Request, res: Response) => {
        try {
            const { days, maxAccounts, redeemBefore, note, targetTenantId } = req.body || {};
            const result = codeStore.updateCode(req.params.id, { days, maxAccounts, redeemBefore, note, targetTenantId });
            if (!result.ok) {
                const status = result.error === 'not_found' ? 404 : result.error === 'terms_locked' ? 409 : 400;
                return res.status(status).json({ ok: false, error: result.message, errorType: result.error });
            }
            tenantLogger.info('修改激活码', { id: req.params.id });
            recordAudit(req, 'code.update', { codeId: result.code.id });
            return res.json({ ok: true, data: result.code });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/admin/codes/:id/replace', (req: Request, res: Response) => {
        try {
            const result = codeStore.replaceCode(req.params.id, 'owner');
            if (!result.ok) {
                const status = result.error === 'not_found' ? 404 : 409;
                return res.status(status).json({ ok: false, error: result.message, errorType: result.error });
            }
            tenantLogger.warn('换发激活码', { id: req.params.id, replacementId: result.codes[0].id, batchId: result.batchId });
            recordAudit(req, 'code.replace', { codeId: String(req.params.id), batchId: result.batchId });
            return res.json({ ok: true, data: result });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/admin/codes/:id/revoke', (req: Request, res: Response) => {
        const result = codeStore.revokeCode(req.params.id);
        if (!result.ok) return res.status(400).json({ ok: false, error: result.message, errorType: result.error });
        tenantLogger.warn('吊销激活码', { id: req.params.id, codeHint: result.code.codeHint });
        recordAudit(req, 'code.revoke', { codeId: result.code.id });
        return res.json({ ok: true, data: result.code });
    });

    app.post('/api/admin/codes/batch/:batchId/revoke', (req: Request, res: Response) => {
        const result = codeStore.revokeBatch(req.params.batchId);
        if (!result.ok) return res.status(400).json({ ok: false, error: result.message, errorType: result.error });
        tenantLogger.warn('吊销激活码批次', { batchId: req.params.batchId, revoked: result.revoked });
        recordAudit(req, 'code.revoke_batch', { batchId: String(req.params.batchId), count: result.revoked });
        return res.json({ ok: true, data: result });
    });
}

module.exports = { mountTenantRoutes };
