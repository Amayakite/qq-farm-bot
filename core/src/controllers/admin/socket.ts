/**
 * Socket.IO setup and realtime emit functions.
 */
import type { AdminContext } from './context';
export {};

const { Server } = require('socket.io');
const SocketIOServer = Server;
const { getUI } = require('../../models/store');

const {
    resolveAuthContext,
    resolveAccId,
    getAccountList,
    isOwner,
} = require('./middleware');

const OWNER_ALL_ROOM = 'owner:all-accounts';

function leaveAccountRooms(socket: any): void {
    for (const room of socket.rooms) {
        if (room === OWNER_ALL_ROOM || room.startsWith('account:')) socket.leave(room);
    }
}

function currentSocketAuth(ctx: AdminContext, socket: any): any {
    const result = resolveAuthContext(ctx, socket.data.adminToken);
    if (!result.auth || result.auth.user.mustChangePassword) {
        socket.disconnect(true);
        return null;
    }
    return result.auth;
}

function ownedAccountIds(ctx: AdminContext, auth: any): string[] {
    return getAccountList(ctx, auth)
        .map((account: any) => String(account.id || ''))
        .filter(Boolean);
}

function collectLogsForAccounts(ctx: AdminContext, accountIds: string[], limit: number): any[] {
    if (!ctx.provider || typeof ctx.provider.getLogs !== 'function') return [];
    const logs: any[] = [];
    for (const accountId of accountIds) {
        const list = ctx.provider.getLogs(accountId, { limit });
        if (Array.isArray(list)) logs.push(...list);
    }
    logs.sort((a: any, b: any) => (b.ts || 0) - (a.ts || 0));
    return logs.slice(0, limit);
}

function filterAccountLogs(list: any[], accountIds: string[], limit: number): any[] {
    const allowed = new Set(accountIds);
    return (Array.isArray(list) ? list : [])
        .filter((entry: any) => allowed.has(String(entry?.accountId || '')))
        .slice(0, limit);
}

function applySocketSubscription(ctx: AdminContext, socket: any, accountRef: string = ''): void {
    const auth = currentSocketAuth(ctx, socket);
    if (!auth) return;
    const incoming = typeof accountRef === 'string' ? accountRef.trim() : '';
    const specific = !!incoming && incoming !== 'all';
    const resolved = specific ? resolveAccId(ctx, incoming, auth) : '';
    if (specific && !resolved) {
        socket.emit('subscribed', { ok: false, error: 'Account not found' });
        return;
    }
    const owner = isOwner(auth);

    leaveAccountRooms(socket);

    let subscribedIds: string[] = [];
    if (resolved) {
        socket.join(`account:${resolved}`);
        socket.data.accountId = resolved;
        subscribedIds = [resolved];
    } else if (owner) {
        socket.join(OWNER_ALL_ROOM);
        socket.data.accountId = '';
        subscribedIds = ownedAccountIds(ctx, auth);
    } else {
        // 租户的 “all” 只订阅自己名下的账号房间，避免收到其他租户的实时事件。
        subscribedIds = ownedAccountIds(ctx, auth);
        for (const id of subscribedIds) socket.join(`account:${id}`);
        socket.data.accountId = '';
    }
    socket.data.accountIds = subscribedIds;
    socket.emit('subscribed', {
        accountId: socket.data.accountId || 'all',
        accountIds: subscribedIds,
    });

    try {
        const targetId = socket.data.accountId || '';
        if (targetId && ctx.provider && typeof ctx.provider.getStatus === 'function') {
            const currentStatus = ctx.provider.getStatus(targetId);
            socket.emit('status:update', { accountId: targetId, status: currentStatus });
        }
        if (ctx.provider && typeof ctx.provider.getLogs === 'function') {
            const currentLogs = targetId
                ? ctx.provider.getLogs(targetId, { limit: 100 })
                : owner
                    ? ctx.provider.getLogs('', { limit: 100 })
                    : collectLogsForAccounts(ctx, subscribedIds, 100);
            socket.emit('logs:snapshot', {
                accountId: targetId || 'all',
                logs: Array.isArray(currentLogs) ? currentLogs : [],
            });
        }
        if (ctx.provider && typeof ctx.provider.getAccountLogs === 'function') {
            const currentAccountLogs = ctx.provider.getAccountLogs(300);
            socket.emit('account-logs:snapshot', {
                logs: owner
                    ? (Array.isArray(currentAccountLogs) ? currentAccountLogs.slice(0, 100) : [])
                    : filterAccountLogs(currentAccountLogs, subscribedIds, 100),
            });
        }
    } catch {
        // ignore snapshot push errors
    }
}

function setupSocketIO(ctx: AdminContext): void {
    ctx.io = new SocketIOServer(ctx.server as any, {
        path: '/socket.io',
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            allowedHeaders: ['x-admin-token', 'x-account-id'],
        },
    });

    ctx.io.use((socket: any, next: (err?: Error) => void) => {
        const authToken = socket.handshake.auth && socket.handshake.auth.token
            ? String(socket.handshake.auth.token)
            : '';
        const headerToken = socket.handshake.headers && socket.handshake.headers['x-admin-token']
            ? String(socket.handshake.headers['x-admin-token'])
            : '';
        const token = authToken || headerToken;
        const result = resolveAuthContext(ctx, token);
        if (!result.auth || result.auth.user.mustChangePassword) {
            return next(new Error('Unauthorized'));
        }
        socket.data.adminToken = token;
        socket.data.userId = result.auth.user.id;
        return next();
    });

    ctx.io.on('connection', (socket: any) => {
        const initialAccountRef = (socket.handshake.auth && socket.handshake.auth.accountId)
            || (socket.handshake.query && socket.handshake.query.accountId)
            || '';
        applySocketSubscription(ctx, socket, initialAccountRef);
        const { brandColor, brandPreset } = getUI();
        socket.emit('appearance:update', { brandColor, brandPreset });
        socket.emit('ready', { ok: true, ts: Date.now() });

        socket.on('subscribe', (payload: any) => {
            const body = (payload && typeof payload === 'object') ? payload : {};
            applySocketSubscription(ctx, socket, body.accountId || '');
        });
    });
}

function forAccountSubscribers(ctx: AdminContext, id: string, deliver: (socket: any, auth: any) => void): void {
    if (!ctx.io || !id) return;
    const { sockets, adapter } = ctx.io.sockets;
    const subscribers = new Set([...(adapter.rooms.get(`account:${id}`) || []), ...(adapter.rooms.get(OWNER_ALL_ROOM) || [])]);
    for (const socketId of subscribers) {
        const socket = sockets.get(socketId);
        if (!socket) continue;
        const auth = currentSocketAuth(ctx, socket);
        if (!auth) continue;
        if (!isOwner(auth) && resolveAccId(ctx, id, auth) !== id) {
            socket.leave(`account:${id}`);
            continue;
        }
        deliver(socket, auth);
    }
}

function emitRealtimeStatus(ctx: AdminContext, accountId: string, status: any): void {
    const id = String(accountId || '').trim();
    forAccountSubscribers(ctx, id, socket => socket.emit('status:update', { accountId: id, status }));
}

function emitRealtimeLog(ctx: AdminContext, entry: any): void {
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();

    forAccountSubscribers(ctx, id, socket => socket.emit('log:new', payload));
}

function emitRealtimeAccountLog(ctx: AdminContext, entry: any): void {
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();

    forAccountSubscribers(ctx, id, socket => socket.emit('account-log:new', payload));
}

function emitLogsAfterClear(ctx: AdminContext, id: string): void {
    forAccountSubscribers(ctx, id, socket => applySocketSubscription(ctx, socket, socket.data.accountId));
}

module.exports = {
    setupSocketIO,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
    emitLogsAfterClear,
};
