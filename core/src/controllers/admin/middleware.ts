import type { NextFunction, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const store = require('../../models/store');
const userStore = require('../../models/user-store');
const { normalizeAccountRef, findAccountByRef } = require('../../services/account-resolver');

interface AuthContext {
    session: any;
    user: any;
}

interface AuthenticatedRequest extends Request {
    adminToken?: string;
    auth?: AuthContext;
}

function getClientIp(req: Request): string {
    const address = req.ip || req.socket?.remoteAddress;
    return String(address || 'unknown').replace(/^::ffff:/, '');
}

function isOwner(auth?: AuthContext | null): boolean {
    return String(auth?.user?.role || '') === 'owner';
}

function buildAuthError(status: number, body: any): { status: number; body: any } {
    return { status, body: { ok: false, ...body } };
}

/**
 * 解析 token 对应的会话与用户，并实时校验停用/到期状态。
 * 这样管理员延长或停用租户后，下一个请求就会生效。
 */
function resolveAuthContext(ctx: AdminContext, token: unknown): { auth?: AuthContext; error?: { status: number; body: any } } {
    const key = String(token || '');
    const session = ctx.tokens.get(key);
    if (!session) {
        return { error: buildAuthError(401, { error: 'Unauthorized', errorType: 'unauthorized' }) };
    }
    const user = userStore.getUserById(session.userId);
    if (!user) {
        ctx.tokens.delete(key);
        return { error: buildAuthError(401, { error: '登录状态已失效，请重新登录', errorType: 'unauthorized' }) };
    }
    if (user.status === 'disabled') {
        ctx.tokens.delete(key);
        return {
            error: buildAuthError(403, {
                error: '账号已被停用，请联系管理员',
                errorType: 'tenant_disabled',
            }),
        };
    }
    if (userStore.isExpired(user)) {
        ctx.tokens.delete(key);
        return {
            error: buildAuthError(403, {
                error: '账号已到期，请使用续费码',
                errorType: 'tenant_expired',
                expiresAt: user.expiresAt,
            }),
        };
    }
    return { auth: { session, user } };
}

function createAuthRequired(ctx: AdminContext) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        const token = String(req.headers['x-admin-token'] || '');
        const result = resolveAuthContext(ctx, token);
        if (!result.auth) {
            res.status(result.error!.status).json(result.error!.body);
            return;
        }
        if (result.auth.user.mustChangePassword && !(
            (req.method === 'GET' && ['/auth/validate', '/user/me'].includes(req.path))
            || (req.method === 'POST' && ['/user/change-password', '/logout'].includes(req.path))
        )) {
            res.status(403).json({ ok: false, error: '请先修改初始密码', errorType: 'password_change_required' });
            return;
        }
        req.adminToken = token;
        req.auth = result.auth;
        next();
    };
}

function requireOwner(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    if (!isOwner(req.auth)) {
        res.status(403).json({ ok: false, error: '仅管理员可执行此操作', errorType: 'owner_only' });
        return;
    }
    next();
}

function rawAccountList(ctx: AdminContext): any[] {
    try {
        if (ctx.provider && typeof ctx.provider.getAccounts === 'function') {
            const data = ctx.provider.getAccounts();
            if (Array.isArray(data?.accounts)) return data.accounts;
        }
    } catch {
        // Fall back to persistent storage.
    }
    const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
    return Array.isArray(data.accounts) ? data.accounts : [];
}

function filterAccountsForAuth(accounts: any[], auth?: AuthContext | null): any[] {
    if (!Array.isArray(accounts)) return [];
    if (!auth) return [];
    if (isOwner(auth)) return accounts;
    const ownerId = String(auth.user.id || '');
    if (!ownerId) return [];
    return accounts.filter(account => String(account?.ownerId || 'owner') === ownerId);
}

function getAccountList(ctx: AdminContext, auth?: AuthContext | null): any[] {
    if (auth && !isOwner(auth) && typeof ctx.provider?.getAccountsByOwner === 'function') {
        return filterAccountsForAuth(ctx.provider.getAccountsByOwner(String(auth.user.id)), auth);
    }
    return filterAccountsForAuth(rawAccountList(ctx), auth);
}

function getAccountIds(ctx: AdminContext, auth?: AuthContext | null): string[] {
    return getAccountList(ctx, auth).map((account: any) => String(account.id || '')).filter(Boolean);
}

const isSoftRuntimeError = (err: any): boolean => {
    const message = String(typeof err === 'string' ? err : err?.message || '');
    return message === '账号未运行' || message === 'API Timeout';
};

function isGatewayProtocolError(err: any): boolean {
    const message = String(typeof err === 'string' ? err : err?.message || '').trim().slice(0, 4096);
    return String(err?.name || '') === 'GatewayError'
        || typeof err?.errorMessage === 'string'
        || typeof err?.error_message === 'string'
        || /^(?:[\w-]+\.)+[\w-]+(?:\s[^\r\n]*)?\bcode=\d+(?:\s|$)/.test(message);
}

function getProtocolErrorMessage(err: any): string {
    const direct = String(err?.errorMessage || err?.error_message || '').trim();
    if (direct) return direct;

    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    if (!isGatewayProtocolError(err)) return '';
    const codeMatch = message.match(/\bcode=\d+\b/);
    if (!codeMatch || codeMatch.index === undefined) return '';
    return message.slice(codeMatch.index + codeMatch[0].length).trim();
}

function handleApiError(res: Response, err: any): void {
    const protocolMessage = getProtocolErrorMessage(err);
    const payload: any = {
        ok: false,
        error: protocolMessage || (typeof err === 'string' ? err : err?.message) || 'Unknown error',
    };
    if (protocolMessage) payload.errorMessage = protocolMessage;
    const errorCode = Number(err?.code);
    if (Number.isFinite(errorCode) && errorCode !== 0) payload.errorCode = errorCode;
    if (isSoftRuntimeError(err) || isGatewayProtocolError(err)) {
        res.json(payload);
        return;
    }
    res.status(500).json(payload);
}

function resolveAccId(ctx: AdminContext, rawRef: any, auth?: AuthContext | null): string {
    const input = normalizeAccountRef(rawRef);
    if (!input || !auth) return '';
    const match = typeof ctx.provider?.resolveAccountAccess === 'function'
        ? ctx.provider.resolveAccountAccess(input) : findAccountByRef(rawAccountList(ctx), input);
    return filterAccountsForAuth(match ? [match] : [], auth).length ? String(match.id || '') : '';
}

function getAccId(ctx: AdminContext, req: Request): string {
    const auth = (req as AuthenticatedRequest).auth;
    return resolveAccId(ctx, req.headers['x-account-id'], auth);
}

function buildKnownFriendGidSettings(accountId: string): {
    knownFriendGids: any[];
    knownFriendGidSyncCooldownSec: number;
    friendsListCacheTtlSec: number;
} {
    return {
        knownFriendGids: store.getKnownFriendGids(accountId),
        knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec(accountId),
        friendsListCacheTtlSec: store.getFriendsListCacheTtlSec(accountId),
    };
}

module.exports = {
    getClientIp,
    isOwner,
    resolveAuthContext,
    createAuthRequired,
    requireOwner,
    getAccountList,
    rawAccountList,
    getAccountIds,
    filterAccountsForAuth,
    isSoftRuntimeError,
    isGatewayProtocolError,
    getProtocolErrorMessage,
    handleApiError,
    resolveAccId,
    getAccId,
    buildKnownFriendGidSettings,
};
