import { WxLoginService } from '../services/wx-login/service';
export {};

const TARGET_APP_ID = 'wx5306c5978fdb76e4';
const KEEPALIVE_MS = 30 * 60_000;
const RETRY_MS = 60_000;
const MAX_FAILURES = 3;

/** One manager owns renewal. Never expose stored credentials to the browser or workers. */
function createWxCredentialRecovery(deps: any) {
    const { store, credentials, canRun, startWorker, isRunning, log, onStateChanged } = deps;
    const wxLogin = deps.wxLogin || new WxLoginService();
    const timers = new Map<string, NodeJS.Timeout>();
    const operations = new Map<string, Promise<any>>();
    const recoveries = new Map<string, Promise<boolean>>();
    const failures = new Map<string, number>();
    const scheduledRecoveries = new Set<string>();
    let closed = false;
    let slots = 0;
    const waiting: Array<() => void> = [];

    const accountFor = (id: string) => store.getAccountById(id);
    const eligible = (account: any) => !!account && account.platform === 'wx' && account.runEnabled === true && canRun(account.ownerId);
    const sameIdentity = (a: any, b: any) => !!a && !!b && a.id === b.id && a.ownerId === b.ownerId && a.createdAt === b.createdAt && a.platform === b.platform;
    function hasCredentials(account: any): boolean {
        if (!account || account.platform !== 'wx') return false;
        try { return !!credentials.readWxCredentials(account); } catch { return false; }
    }
    function clear(id: string) {
        const timer = timers.get(id);
        if (timer) clearTimeout(timer);
        timers.delete(id);
        scheduledRecoveries.delete(id);
    }
    async function locked<T>(id: string, action: () => Promise<T>): Promise<T> {
        const previous = operations.get(id) || Promise.resolve();
        const next = previous.catch(() => undefined).then(async () => {
            if (slots < 3) slots++;
            else await new Promise<void>(resolve => waiting.push(resolve));
            try { return await action(); }
            finally {
                const nextWaiter = waiting.shift();
                if (nextWaiter) nextWaiter(); else slots--;
            }
        });
        operations.set(id, next);
        try { return await next; } finally { if (operations.get(id) === next) operations.delete(id); }
    }
    function schedule(id: string, delay: number, recovery = false) {
        clear(id);
        if (closed || !eligible(accountFor(id))) return;
        const timer = setTimeout(() => {
            timers.delete(id);
            scheduledRecoveries.delete(id);
            void tick(id);
        }, delay);
        timer.unref?.();
        timers.set(id, timer);
        if (recovery) scheduledRecoveries.add(id);
        onStateChanged?.(id);
    }
    async function renew(account: any) {
        if (closed || !sameIdentity(account, accountFor(String(account.id))) || !eligible(accountFor(String(account.id)))) {
            throw new Error('账号已停止或不可用');
        }
        let saved = credentials.readWxCredentials(account);
        if (!saved) throw new Error('微信授权不存在');
        let revision = saved.revision;
        const persist = (next: any) => {
            const current = accountFor(String(account.id));
            if (!sameIdentity(account, current) || !credentials.saveWxCredentials(current, next, revision)) {
                throw new Error('微信授权已更新');
            }
            saved = credentials.readWxCredentials(current);
            if (!saved) throw new Error('微信授权已删除');
            revision = saved.revision;
        };
        const fresh = await wxLogin.refreshCredentials(saved, (next: any) => {
            persist(next);
            // Finish saving a rotated token before shutdown; do not start the next request.
            if (closed) throw new Error('服务正在关闭');
        });
        persist(fresh);
        return saved;
    }
    async function doRecover(id: string): Promise<boolean> {
        const account = accountFor(id);
        if (closed || !eligible(account) || isRunning(id) || (account.code && !account.codeConsumed)) return false;
        const originalCode = account.code;
        const saved = await renew(account);
        const session = { cookies: new Map(), uuid: '', loginBuffer: saved.loginBuffer };
        const code = await wxLogin.issueCode(session, TARGET_APP_ID);
        const current = accountFor(id);
        const latest = sameIdentity(account, current) ? credentials.readWxCredentials(current) : null;
        if (closed || !eligible(current) || isRunning(id) || current.code !== originalCode || latest?.revision !== saved.revision) return false;
        if (!code || code === originalCode) throw new Error('微信未签发新的登录凭据');
        store.addOrUpdateAccount({ id, code });
        const updated = accountFor(id);
        if (!eligible(updated) || isRunning(id)) return false;
        return !!(await startWorker(updated));
    }
    function recoverNow(idInput: string): Promise<boolean> {
        const id = String(idInput);
        const pending = recoveries.get(id);
        if (pending) return pending;
        const task = locked(id, () => doRecover(id)).finally(() => {
            if (recoveries.get(id) === task) recoveries.delete(id);
            onStateChanged?.(id);
        });
        recoveries.set(id, task);
        onStateChanged?.(id);
        return task;
    }
    async function tick(id: string) {
        const account = accountFor(id);
        if (closed || !eligible(account) || !hasCredentials(account)) return;
        try {
            if (isRunning(id)) await locked(id, () => renew(account));
            else await recoverNow(id);
            failures.delete(id);
            schedule(id, KEEPALIVE_MS);
        } catch {
            const count = (failures.get(id) || 0) + 1;
            failures.set(id, count);
            log('系统', count >= MAX_FAILURES ? '微信授权自动恢复失败，请重新扫码' : '微信授权续期失败，稍后重试', { accountId: id });
            if (count < MAX_FAILURES) schedule(id, RETRY_MS, !isRunning(id));
        }
    }
    function adopt(account: any, immediate = false) {
        const id = String(account?.id || '');
        if (!id || !eligible(account) || !hasCredentials(account)) return false;
        if (!timers.has(id) && !recoveries.has(id)) schedule(id, immediate ? 1500 + Math.floor(Math.random() * 5000) : KEEPALIVE_MS, immediate);
        return true;
    }
    function onDisconnected(account: any) {
        if (!eligible(account) || !hasCredentials(account)) return;
        failures.delete(String(account.id));
        schedule(String(account.id), RETRY_MS, true);
    }
    function stop(id: string) { clear(String(id)); failures.delete(String(id)); }
    async function stopAll() {
        closed = true;
        for (const id of timers.keys()) clear(id);
        if (!operations.size) return;
        let timeout: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                Promise.allSettled([...operations.values()]),
                new Promise<void>(resolve => { timeout = setTimeout(resolve, 38_000); }),
            ]);
        } finally { if (timeout) clearTimeout(timeout); }
    }
    return { hasCredentials, adopt, onDisconnected, recoverNow, stop, stopAll, isPending: (id: string) => recoveries.has(String(id)) || scheduledRecoveries.has(String(id)) };
}

module.exports = { createWxCredentialRecovery };
