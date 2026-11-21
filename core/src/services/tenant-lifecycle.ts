import type { AdminContext } from '../controllers/admin/context';
export {};

const userStore = require('../models/user-store');
const { createModuleLogger } = require('./logger');

const tenantLogger = createModuleLogger('tenant');
const DEFAULT_SWEEP_INTERVAL_MS = 10_000;

function kickSockets(ctx: AdminContext, userId: string): void {
    if (!ctx.io) return;
    for (const socket of ctx.io.sockets.sockets.values()) {
        if (String((socket.data as any).userId || '') === userId) socket.disconnect(true);
    }
}

function collectAccountsByOwner(ctx: AdminContext): Map<string, any[]> {
    const byOwner = new Map<string, any[]>();
    try {
        const data = ctx.provider.getAccounts();
        const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
        for (const account of accounts) {
            const ownerId = String(account.ownerId || 'owner');
            const list = byOwner.get(ownerId) || [];
            list.push(account);
            byOwner.set(ownerId, list);
        }
    } catch (error: any) {
        tenantLogger.warn('读取账号列表失败', { error: error?.message || String(error) });
    }
    return byOwner;
}

/**
 * 到期/停用租户：踢掉会话并停止其正在挂机的账号。
 * 每个请求还会再校验一次，这层负责在没有请求时也及时释放 worker。
 */
function sweepExpiredTenants(ctx: AdminContext): { stopped: number; kicked: number } {
    const now = Date.now();
    ctx.tokens.cleanup();
    for (const socket of ctx.io?.sockets.sockets.values() || []) {
        if (!ctx.tokens.has(socket.data.adminToken)) socket.disconnect(true);
    }
    const tenants = userStore.listUsers().filter((user: any) => user.role === 'tenant');
    const byOwner = collectAccountsByOwner(ctx);
    let stopped = 0;
    let kicked = 0;

    const blockedIds = new Set(tenants
        .filter((tenant: any) => tenant.status === 'disabled' || userStore.isExpired(tenant, now))
        .map((tenant: any) => tenant.id));
    const knownIds = new Set(tenants.map((tenant: any) => tenant.id));
    for (const ownerId of byOwner.keys()) {
        if (ownerId !== userStore.OWNER_ID && !knownIds.has(ownerId)) blockedIds.add(ownerId);
    }

    for (const tenantId of blockedIds) {
        ctx.scanTasks?.cancelTenant(String(tenantId));
        kicked += ctx.tokens.deleteByUserId(tenantId);
        kickSockets(ctx, tenantId as string);
        const accounts = byOwner.get(tenantId as string) || [];
        for (const account of accounts) {
            if (!account.running) continue;
            try {
                ctx.provider.stopAccount(account.id, { preserveIntent: true });
                stopped++;
            } catch (error: any) {
                tenantLogger.warn('停止到期账号失败', {
                    accountId: account.id,
                    tenantId,
                    error: error?.message || String(error),
                });
            }
        }
    }

    if (stopped || kicked) {
        tenantLogger.info('到期租户清理完成', { stopped, kicked });
    }
    return { stopped, kicked };
}

function startTenantLifecycle(ctx: AdminContext, options: { intervalMs?: number } = {}): () => void {
    const intervalMs = Math.max(10_000, Number(options.intervalMs) || DEFAULT_SWEEP_INTERVAL_MS);
    const run = (): void => {
        try {
            sweepExpiredTenants(ctx);
        } catch (error: any) {
            tenantLogger.warn('租户生命周期检查失败', { error: error?.message || String(error) });
        }
    };
    const timer = setInterval(run, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    // 启动后立即执行一次，避免重启后过期账号继续挂机。
    setTimeout(run, 2_000).unref?.();
    return () => clearInterval(timer);
}

module.exports = {
    sweepExpiredTenants,
    startTenantLifecycle,
};
