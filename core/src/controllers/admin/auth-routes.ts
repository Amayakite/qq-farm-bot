import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const { version } = require('../../../package.json');
const { CONFIG, getRuntimeConfig } = require('../../config/config');
const { getSchedulerRegistrySnapshot } = require('../../services/scheduler');
const { createModuleLogger } = require('../../services/logger');
const userStore = require('../../models/user-store');
const codeStore = require('../../models/activation-code-store');
const security = require('../../models/auth-security');
const store = require('../../models/store');

const {
    getClientIp,
    createAuthRequired,
    requireOwner,
    getAccId,
    getAccountList,
    handleApiError,
} = require('./middleware');

const adminLogger = createModuleLogger('admin');
const DAY_MS = 86_400_000;

function sessionTtlMs(): number {
    return Math.max(1, Number(CONFIG.sessionTtlHours) || 168) * 3_600_000;
}

function clientUser(user: any): any {
    const publicUser = userStore.publicUser(user);
    return {
        id: publicUser.id,
        username: publicUser.username,
        role: publicUser.role,
        status: publicUser.status,
        expiresAt: publicUser.expiresAt,
        maxAccounts: publicUser.maxAccounts,
        mustChangePassword: publicUser.mustChangePassword,
    };
}

function issueLogin(ctx: AdminContext, res: Response, user: any): any {
    const token = ctx.tokens.create(user, sessionTtlMs());
    const data = {
        token: token.token,
        role: user.role,
        user: clientUser(user),
        mustChangePassword: user.mustChangePassword === true,
        expiresAt: user.expiresAt,
        maxAccounts: user.maxAccounts,
    };
    return res.json({ ok: true, data });
}

function loginStatusCode(errorType: string): number {
    if (errorType === 'rate_limit') return 429;
    if (errorType === 'locked') return 423;
    if (errorType === 'disabled' || errorType === 'expired') return 403;
    return 401;
}

function mountAuthRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);

    app.get('/api/public-config', (_req: Request, res: Response) => {
        const ui = store.getUI ? store.getUI() : {};
        res.json({
            ok: true,
            data: {
                hideUpstreamLinks: CONFIG.hideUpstreamLinks === true,
                siteName: CONFIG.siteName,
                registrationEnabled: true,
                redeemEnabled: true,
                brandColor: ui.brandColor || '#2f6f9f',
                brandPreset: ui.brandPreset || 'ocean',
            },
        });
    });

    app.get('/api/game-version', (_req: Request, res: Response) => {
        const { clientVersion, wxClientVersion } = getRuntimeConfig();
        res.json({ ok: true, clientVersion, wxClientVersion, botVersion: version });
    });

    app.post('/api/login', (req: Request, res: Response) => {
        const { username, password } = req.body || {};
        if (typeof username !== 'string' || !username || username.length > 128
            || typeof password !== 'string' || !password || password.length > 128) {
            return res.status(401).json({ ok: false, error: '请输入用户名和密码' });
        }

        const clientIp = getClientIp(req);
        const result = userStore.validateCredentials(username, password, clientIp);
        if (!result.ok) {
            const status = loginStatusCode(result.error);
            adminLogger.warn('登录失败', { username, error: result.error, ip: clientIp });
            return res.status(status).json({
                ok: false,
                error: result.message,
                errorType: result.error,
                remainingMs: result.remainingMs,
                expiresAt: result.expiresAt,
            });
        }

        adminLogger.info('用户登录成功', { username: result.user.username, role: result.user.role, ip: clientIp });
        return issueLogin(ctx, res, result.user);
    });

    app.post('/api/redeem', (req: Request, res: Response) => {
        const body = req.body || {};
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!code || code.length > 64 || !username || username.length > 128 || !password || password.length > 128) {
            return res.status(400).json({ ok: false, error: '请填写激活码、用户名和密码' });
        }

        const clientIp = getClientIp(req);
        const rateLimit = security.checkRateLimit(clientIp);
        if (!rateLimit.allowed) {
            return res.status(429).json({ ok: false, error: rateLimit.message || '请求过于频繁，请稍后重试', errorType: 'rate_limit' });
        }

        const validation = codeStore.validateCode(code, 'new');
        if (!validation.ok) {
            adminLogger.warn('激活码兑换失败', { error: validation.error, ip: clientIp });
            return res.status(400).json({ ok: false, error: validation.message, errorType: validation.error });
        }

        const record = validation.record;
        const expiresAt = Date.now() + record.days * DAY_MS;
        const created = userStore.createTenant({
            username,
            password,
            expiresAt,
            maxAccounts: record.maxAccounts,
            note: record.note,
            codeId: record.id,
        });
        if (!created.ok) {
            return res.status(400).json({ ok: false, error: created.message, errorType: created.error });
        }

        adminLogger.info('激活码兑换成功', { username, codeHint: record.codeHint, ip: clientIp, expiresAt });
        return issueLogin(ctx, res, created.user);
    });

    app.post('/api/renew', (req: Request, res: Response) => {
        const body = req.body || {};
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!code || code.length > 64 || !username || username.length > 128 || !password || password.length > 128) {
            return res.status(400).json({ ok: false, error: '请填写续费码、用户名和密码' });
        }

        const clientIp = getClientIp(req);
        const rateLimit = security.checkRateLimit(clientIp);
        if (!rateLimit.allowed) {
            return res.status(429).json({ ok: false, error: rateLimit.message || '请求过于频繁，请稍后重试', errorType: 'rate_limit' });
        }

        const validation = codeStore.validateCode(code, 'renew');
        if (!validation.ok) {
            return res.status(400).json({ ok: false, error: validation.message, errorType: validation.error });
        }

        const credential = userStore.findTenantForRenewal(username, password, clientIp, { rateLimitChecked: true });
        if (!credential.ok) {
            return res.status(loginStatusCode(credential.error)).json({
                ok: false,
                error: credential.message,
                errorType: credential.error,
                remainingMs: credential.remainingMs,
            });
        }
        if (credential.user.role !== 'tenant') {
            return res.status(400).json({ ok: false, error: '管理员账号无需续费', errorType: 'not_tenant' });
        }

        const record = validation.record;
        const extended = userStore.extendTenant(credential.user.id, record.days, {
            codeId: record.id,
            maxAccounts: record.maxAccounts,
            targetTenantId: record.targetTenantId,
        });
        if (!extended.ok) {
            return res.status(400).json({ ok: false, error: extended.message, errorType: extended.error });
        }
        adminLogger.info('续费码兑换成功', { username, codeHint: record.codeHint, ip: clientIp, days: record.days });

        const refreshed = userStore.getUserById(credential.user.id);
        return issueLogin(ctx, res, refreshed);
    });

    app.use('/api', authRequired);

    app.post('/api/user/change-password', (req: Request, res: Response) => {
        const { oldPassword, newPassword } = req.body || {};
        if (typeof oldPassword !== 'string' || !oldPassword || oldPassword.length > 128
            || typeof newPassword !== 'string' || !newPassword || newPassword.length > 128) {
            return res.status(400).json({ ok: false, error: '请提供原密码和新密码' });
        }
        const auth: any = (req as any).auth;
        const result = userStore.changePassword(auth.user.id, oldPassword, newPassword);
        if (result.ok) {
            // 修改密码后踢掉该用户的所有旧会话，其他租户不受影响。
            ctx.tokens.deleteByUserId(auth.user.id);
            for (const socket of ctx.io?.sockets.sockets.values() || []) {
                if (socket.data.userId === auth.user.id) socket.disconnect(true);
            }
        }
        return res.json(result);
    });

    app.get('/api/ping', (_req: Request, res: Response) => {
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version } });
    });

    app.get('/api/auth/validate', (req: Request, res: Response) => {
        const auth: any = (req as any).auth;
        res.json({ ok: true, data: { valid: true, user: clientUser(auth.user) } });
    });

    app.get('/api/scheduler', requireOwner, async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            if (ctx.provider && typeof ctx.provider.getSchedulerStatus === 'function') {
                const data = await ctx.provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({
                ok: true,
                data: {
                    runtime: getSchedulerRegistrySnapshot(),
                    worker: null,
                    workerError: 'DataProvider does not support scheduler status',
                },
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/logout', (req: Request, res: Response) => {
        const token = (req as any).adminToken;
        if (token) ctx.tokens.delete(token);
        if (ctx.io && token) {
            for (const socket of ctx.io.sockets.sockets.values()) {
                if (String((socket.data as any).adminToken || '') === String(token)) socket.disconnect(true);
            }
        }
        res.json({ ok: true });
    });

    app.get('/api/user/me', (req: Request, res: Response) => {
        const auth: any = (req as any).auth;
        const accounts = getAccountList(ctx, auth);
        res.json({
            ok: true,
            data: {
                ...clientUser(auth.user),
                accountCount: accounts.length,
            },
        });
    });
}

module.exports = { mountAuthRoutes };
