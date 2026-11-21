export {};
const crypto = require('node:crypto');

interface SessionLike {
    token: string;
    userId: string;
    role: string;
    createdAt: number;
    expiresAt: number;
}

/**
 * 进程内会话表。服务重启后会话失效，客户端需重新登录；
 * 租户的到期/停用状态由鉴权中间件按请求实时校验。
 */
function createSessionStore() {
    const sessions = new Map<string, SessionLike>();

    function create(user: { id: string; role: string }, ttlMs: number): SessionLike {
        const now = Date.now();
        const session: SessionLike = {
            token: crypto.randomBytes(24).toString('hex'),
            userId: String(user.id),
            role: String(user.role),
            createdAt: now,
            expiresAt: now + Math.max(60_000, Number(ttlMs) || 0),
        };
        sessions.set(session.token, session);
        return { ...session };
    }

    function get(token: unknown): SessionLike | null {
        const key = String(token || '');
        if (!key) return null;
        const session = sessions.get(key);
        if (!session) return null;
        if (session.expiresAt <= Date.now()) {
            sessions.delete(key);
            return null;
        }
        return session;
    }

    function has(token: unknown): boolean {
        return get(token) !== null;
    }

    function remove(token: unknown): boolean {
        return sessions.delete(String(token || ''));
    }

    function removeByUserId(userId: unknown): number {
        const id = String(userId || '');
        if (!id) return 0;
        let removed = 0;
        for (const [token, session] of sessions) {
            if (session.userId === id) {
                sessions.delete(token);
                removed++;
            }
        }
        return removed;
    }

    function clear(): void {
        sessions.clear();
    }

    function cleanup(): number {
        const now = Date.now();
        let removed = 0;
        for (const [token, session] of sessions) {
            if (session.expiresAt <= now) {
                sessions.delete(token);
                removed++;
            }
        }
        return removed;
    }

    return {
        create,
        get,
        has,
        delete: remove,
        deleteByUserId: removeByUserId,
        clear,
        cleanup,
        get size() { return sessions.size; },
    };
}

module.exports = { createSessionStore };
