import { randomUUID } from 'node:crypto';

export type ScanPlatform = 'qq' | 'wx';
type ScanStatus = 'queued' | 'creating' | 'waiting_scan' | 'scanned' | 'authorizing' | 'releasing' | 'completed' | 'cancelled' | 'expired' | 'failed';
type TerminalStatus = 'completed' | 'cancelled' | 'expired' | 'failed';
type ProviderStatus = 'waiting_scan' | 'scanned' | 'confirmed' | 'cancelled' | 'expired' | 'failed';

export interface ScanSession {
    qrImage: string;
    expiresAt: number;
    poll(signal: AbortSignal): Promise<{ status: ProviderStatus; qrImage?: string }>;
    authorize(): Promise<{ code: string; nickname?: string }>;
    release(): Promise<void>;
}

export interface ScanTarget {
    platform: ScanPlatform;
    tenantId: string;
    token: string;
    accountId?: string;
    name: string;
}

export class ScanProblem extends Error {
    constructor(public statusCode: number, public errorType: string, message: string) {
        super(message);
    }
}

interface ScanTask {
    id: string;
    requestId: string;
    fingerprint: string;
    target: ScanTarget;
    status: ScanStatus;
    stageAt: number;
    expiresAt: number;
    lastSeen: number;
    retryAt: number;
    busy: boolean;
    stop?: 'cancelled' | 'expired';
    pollAbort?: AbortController;
    session?: ScanSession;
    qrImage?: string;
    accountId?: string;
    error?: string;
    errorType?: string;
}

interface CoordinatorOptions {
    open: (platform: ScanPlatform) => Promise<ScanSession>;
    checkTarget: (target: ScanTarget) => void;
    save: (target: ScanTarget, result: { code: string; nickname?: string }) => string;
    observe?: (entry: { taskId: string; tenantId: string; platform: ScanPlatform; stage: ScanStatus; next: ScanStatus; durationMs: number; errorType?: string }) => void;
    now?: () => number;
}

const QUEUE_TTL_MS = 4 * 60_000;
const CLIENT_TTL_MS = 30_000;
const RESULT_TTL_MS = 5 * 60_000;
const BUSY_RECHECK_MS = 3000;
const MAX_PENDING = 40;
const MAX_RESULTS = 200;
const terminal = new Set<ScanStatus>(['completed', 'cancelled', 'expired', 'failed']);

export function createScanCoordinator({ open, checkTarget, save, observe, now = Date.now }: CoordinatorOptions) {
    const tasks = new Map<string, ScanTask>();
    const requests = new Map<string, ScanTask>();
    const requestKey = (token: string, requestId: string) => `${token}:${requestId}`;

    function publicTask(task: ScanTask) {
        return {
            id: task.id,
            status: task.status,
            platform: task.target.platform,
            expiresAt: task.expiresAt,
            qrImage: task.status === 'waiting_scan' || task.status === 'scanned' ? task.qrImage : undefined,
            accountId: task.accountId,
            error: task.error,
            errorType: task.errorType,
        };
    }

    function transition(task: ScanTask, status: ScanStatus, errorType?: string) {
        if (task.status === status) return;
        const time = now();
        observe?.({ taskId: task.id, tenantId: task.target.tenantId, platform: task.target.platform,
            stage: task.status, next: status, durationMs: time - task.stageAt, errorType });
        task.status = status;
        task.stageAt = time;
    }

    function discard(task: ScanTask) {
        tasks.delete(task.id);
        const key = requestKey(task.target.token, task.requestId);
        if (requests.get(key) === task) requests.delete(key);
    }

    function stopMatching(test: (target: ScanTarget) => boolean) {
        for (const task of tasks.values()) {
            if (!terminal.has(task.status) && test(task.target)) stopTask(task, 'cancelled');
        }
    }

    function stopTask(task: ScanTask, reason: 'cancelled' | 'expired') {
        task.stop = reason;
        task.pollAbort?.abort();
    }

    async function finish(task: ScanTask, status: TerminalStatus, problem?: ScanProblem) {
        task.qrImage = undefined;
        if (task.session) {
            transition(task, 'releasing', problem?.errorType);
            try { await task.session.release(); }
            catch {
                observe?.({ taskId: task.id, tenantId: task.target.tenantId, platform: task.target.platform,
                    stage: 'releasing', next: status, durationMs: now() - task.stageAt, errorType: 'release_failed' });
            }
            task.session = undefined;
        }
        task.error = problem?.message;
        task.errorType = problem?.errorType;
        task.expiresAt = now() + RESULT_TTL_MS;
        transition(task, status, problem?.errorType);
        const results = [...tasks.values()].filter(item => terminal.has(item.status));
        if (results.length <= MAX_RESULTS) return;
        results.sort((a, b) => a.expiresAt - b.expiresAt);
        for (const old of results.slice(0, Math.max(0, results.length - MAX_RESULTS))) discard(old);
    }

    async function advance(task: ScanTask) {
        try {
            if (task.stop) return await finish(task, task.stop);
            checkTarget(task.target);
            if (task.status === 'queued') {
                transition(task, 'creating');
                task.session = await open(task.target.platform);
                if (task.stop || task.expiresAt <= now() || task.session.expiresAt <= now() || task.lastSeen <= now() - CLIENT_TTL_MS) {
                    return await finish(task, task.stop || 'expired');
                }
                checkTarget(task.target);
                task.qrImage = task.session.qrImage;
                task.expiresAt = task.session.expiresAt;
                transition(task, 'waiting_scan');
                return;
            }

            const controller = new AbortController();
            task.pollAbort = controller;
            const state = await task.session!.poll(controller.signal).finally(() => { task.pollAbort = undefined; });
            if (task.stop) return await finish(task, task.stop);
            if (state.qrImage) task.qrImage = state.qrImage;
            if (state.status === 'waiting_scan' || state.status === 'scanned') {
                transition(task, state.status);
                return;
            }
            if (state.status !== 'confirmed') {
                return await finish(task, state.status, state.status === 'failed'
                    ? new ScanProblem(502, 'scan_provider_failed', '扫码授权未完成，请重新获取二维码') : undefined);
            }

            checkTarget(task.target);
            transition(task, 'authorizing');
            task.qrImage = undefined;
            const credentials = await task.session!.authorize();
            if (task.stop) return await finish(task, task.stop);
            checkTarget(task.target);
            task.accountId = save(task.target, credentials);
            await finish(task, 'completed');
        } catch (error: unknown) {
            const code = (error as { code?: string } | null)?.code;
            if (!task.stop && task.status === 'creating' && !task.session && (code === 'WORKFLOW_BUSY' || code === 'LOGOUT_REQUIRED')) {
                task.retryAt = now() + BUSY_RECHECK_MS;
                transition(task, 'queued', code);
                return;
            }
            const problem = error instanceof ScanProblem ? error
                : /^STORAGE_/.test(code || '') ? new ScanProblem(503, 'scan_storage_failed', '账号存储不可用，请联系管理员后重试')
                : new ScanProblem(502, 'scan_provider_failed', task.status === 'creating'
                    ? '获取二维码失败，请稍后重试' : '扫码授权或保存失败，请重新扫码');
            await finish(task, task.stop || 'failed', task.stop ? undefined : problem);
        }
    }

    function tick() {
        const time = now();
        const work: Promise<void>[] = [];
        const qqPending = [...tasks.values()].filter(task => task.target.platform === 'qq' && !terminal.has(task.status));
        const qqHead = qqPending.some(task => task.status !== 'queued') ? undefined : qqPending[0];

        for (const task of tasks.values()) {
            if (terminal.has(task.status)) {
                if (task.expiresAt <= time) discard(task);
                continue;
            }
            if (task.status === 'queued' || task.status === 'creating' || task.status === 'waiting_scan' || task.status === 'scanned') {
                const abandoned = task.status !== 'scanned' && task.lastSeen <= time - CLIENT_TTL_MS;
                if ((task.expiresAt <= time || abandoned) && !task.stop) stopTask(task, 'expired');
            }
            if (task.busy) continue;
            if (!task.stop && task.status === 'queued' && (task.retryAt > time || task.target.platform === 'qq' && task !== qqHead)) continue;
            task.busy = true;
            work.push(advance(task).finally(() => { task.busy = false; }));
        }
        return Promise.all(work);
    }

    const timer = setInterval(() => void tick(), 1000);
    timer.unref();

    function owned(id: string, token: string) {
        const task = tasks.get(id);
        if (!task || task.target.token !== token || terminal.has(task.status) && task.expiresAt <= now()) {
            throw new ScanProblem(404, 'scan_not_found', '扫码任务已失效，请重新获取二维码');
        }
        return task;
    }

    function replay(token: string, requestId: string, fingerprint: string) {
        const task = requests.get(requestKey(token, requestId));
        if (!task || terminal.has(task.status) && task.expiresAt <= now()) return undefined;
        if (task.fingerprint !== fingerprint) throw new ScanProblem(409, 'scan_request_conflict', '请为新的扫码操作重新获取二维码');
        task.lastSeen = now();
        return publicTask(task);
    }

    return {
        replay,
        create(target: ScanTarget, requestId: string, fingerprint: string) {
            const prior = replay(target.token, requestId, fingerprint);
            if (prior) return prior;
            checkTarget(target);
            const pending = [...tasks.values()].filter(task => !terminal.has(task.status));
            if (pending.some(task => task.target.tenantId === target.tenantId && task.target.platform === target.platform)) {
                throw new ScanProblem(409, 'scan_already_active', '当前租户已有同平台扫码任务，请先关闭或等待完成');
            }
            if (pending.length >= MAX_PENDING) throw new ScanProblem(429, 'scan_capacity', '扫码任务较多，请稍后重试');
            const time = now();
            const task: ScanTask = { id: randomUUID(), requestId, fingerprint, target, status: 'queued', stageAt: time,
                expiresAt: time + QUEUE_TTL_MS, lastSeen: time, retryAt: time, busy: false };
            tasks.set(task.id, task);
            requests.set(requestKey(target.token, requestId), task);
            return publicTask(task);
        },
        status(id: string, token: string) {
            const task = owned(id, token);
            task.lastSeen = now();
            return publicTask(task);
        },
        cancel(id: string, token: string) {
            const task = owned(id, token);
            if (task.status === 'authorizing' || task.status === 'releasing' && !task.stop) {
                throw new ScanProblem(409, 'scan_finishing', '扫码授权正在收尾，请稍候');
            }
            if (!terminal.has(task.status)) stopTask(task, 'cancelled');
            return publicTask(task);
        },
        hasPending(platform: ScanPlatform, tenantId?: string) {
            return [...tasks.values()].some(task => !terminal.has(task.status) && task.target.platform === platform
                && (!tenantId || task.target.tenantId === tenantId));
        },
        cancelTenant: (id: string) => stopMatching(target => target.tenantId === id),
        cancelAccount: (id: string) => stopMatching(target => target.accountId === id),
        cancelSession: (token: string) => stopMatching(target => target.token === token),
        tick,
        dispose: () => clearInterval(timer),
    };
}
