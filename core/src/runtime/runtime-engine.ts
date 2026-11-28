import { requiresNewCode } from '../types/account';
import type { Account, AccountIssueReason } from '../types/account';
export {};
const { fork } = require('node:child_process');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const store = require('../models/store');
const { canRunAccounts } = require('../models/user-store');
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig } = require('../config/config');
const { sendPushooMessage } = require('../services/push');
const { createDataProvider } = require('./data-provider');
const { createReloginReminderService } = require('./relogin-reminder');
const { createRuntimeState } = require('./runtime-state');
const { createWorkerManager } = require('./worker-manager');
const { createWxCredentialRecovery } = require('./wx-credential-recovery');
const wxCredentials = require('../models/wx-credentials');

const { listHostedSessions, findAccountSession, stopHostedAccount } = require('../session/ipc');

const OPERATION_KEYS = ['harvest', 'farming', 'fertilize', 'plant', 'steal', 'helpFarming', 'taskClaim', 'sell', 'upgrade'];

interface RuntimeEngineOptions {
    processRef?: any;
    mainEntryPath?: string;
    workerScriptPath?: string;
    runtimeMode?: string;
    onStatusSync?: (accountId: string, status: any, accountName?: string) => void;
    onLog?: (entry: any, accountId?: string, accountName?: string) => void;
    onAccountLog?: (entry: any) => void;
    startAdminServer?: (dataProvider: any) => void;
}

function createRuntimeEngine(options: RuntimeEngineOptions = {}) {
    const processRef = options.processRef || process;
    // Detect if running from source (tsx) or compiled (node)
    const isRunningFromSource = __dirname.includes(`${path.sep}src${path.sep}`);
    const fileExt = isRunningFromSource ? '.ts' : '.js';
    const mainEntryPath = options.mainEntryPath || path.join(__dirname, `../../client${fileExt}`);
    const workerScriptPath = options.workerScriptPath || path.join(__dirname, `../core/worker${fileExt}`);
    const runtimeMode = String(options.runtimeMode || processRef.env.FARM_RUNTIME_MODE || 'thread').toLowerCase();
    const onStatusSync = typeof options.onStatusSync === 'function' ? options.onStatusSync : null;
    const onLog = typeof options.onLog === 'function' ? options.onLog : null;
    const onAccountLog = typeof options.onAccountLog === 'function' ? options.onAccountLog : null;
    const startAdminServer = typeof options.startAdminServer === 'function' ? options.startAdminServer : null;
    const recoveryIntervalMs = Math.max(500, Math.min(60_000, Number(processRef.env.FARM_RESTORE_INTERVAL_MS) || 1500));
    const recoveryQueue = new Set<string>();
    let recoveryTimer: NodeJS.Timeout | undefined;
    let wxRecovery: any;

    const runtimeState = createRuntimeState({
        store,
        operationKeys: OPERATION_KEYS,
    });
    const {
        workers,
        globalLogs: GLOBAL_LOGS,
        accountLogs: ACCOUNT_LOGS,
        runtimeEvents,
        nextConfigRevision,
        buildConfigSnapshotForAccount,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildDefaultStatus,
        filterLogs,
    } = runtimeState;

    const reloginReminder = createReloginReminderService({
        store,
        sendPushooMessage,
        log,
    });

    const {
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        sendConfiguredPush,
    } = reloginReminder;

    const { startWorker, stopWorker, restartWorker, callWorkerApi, startAccountWorker, stopAccountWorker, detachAllWorkers } = createWorkerManager({
        fork,
        WorkerThread: Worker,
        runtimeMode,
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs: GLOBAL_LOGS,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        canStartAccount: (account: Account, sessionId?: string) => {
            const saved = store.getAccountById(account.id);
            return !!saved && saved.code === account.code && saved.createdAt === account.createdAt
                && (sessionId ? saved.runEnabled && canRunAccounts(saved.ownerId) && !requiresNewCode(saved.lastRunIssue) : shouldRestore(saved));
        },
        // Make the one-time Code unavailable before it can reach the worker.
        claimLoginCode: (account: Account) => store.setAccountRunState(account.id, { codeConsumed: true }),
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        sendConfiguredPush,
        addOrUpdateAccount: store.addOrUpdateAccount,
        deleteAccount: store.deleteAccount,
        onStatusSync: publishAccountStatus,
        onRunIssue: recordRunIssue,
        onWorkerLog: (entry: any, accountId: string, accountName?: string) => {
            runtimeEvents.emit('worker_log', { entry, accountId, accountName });
            if (onLog) onLog(entry, accountId, accountName);
        },
    });
    wxRecovery = createWxCredentialRecovery({
        store, credentials: wxCredentials, canRun: canRunAccounts,
        startWorker, isRunning: (id: string) => !!workers[id] && !workers[id].stopping,
        log, onStateChanged: (id: string) => publishAccountStatus(id),
    });
    const dataProvider = createDataProvider({
        workers,
        globalLogs: GLOBAL_LOGS,
        accountLogs: ACCOUNT_LOGS,
        store,
        getAccounts: store.getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        buildConfigSnapshotForAccount,
        broadcastGameConfigReload,
        startWorker: startAccountWorker,
        stopWorker: stopAccountWorker,
        restartWorker,
        canRunAccount: (account: Account) => canRunAccounts(account.ownerId),
        isRecoveryQueued: (id: string) => recoveryQueue.has(id) || wxRecovery.isPending(id),
        hasWxCredentials: (account: Account) => wxRecovery.hasCredentials(account),
        recoverWxAccount: (id: string) => wxRecovery.recoverNow(id),
        stopWxRecovery: (id: string) => wxRecovery.stop(id),
        cancelRecovery: (id: string) => recoveryQueue.delete(id),
        recoverTenantAccounts: queueAccountsForRecovery,
        onRunStateChanged: publishAccountStatus,
    });

    runtimeEvents.on('log', (entry: any) => {
        if (onLog) onLog(entry, entry && entry.accountId ? entry.accountId : '', entry && entry.accountName ? entry.accountName : '');
    });
    runtimeEvents.on('account_log', (entry: any) => {
        if (onAccountLog) onAccountLog(entry);
    });

    function broadcastConfigToWorkers(targetAccountId = ''): void {
        const targetId = String(targetAccountId || '').trim();
        for (const [accId, worker] of Object.entries(workers)) {
            if (targetId && String(accId) !== targetId) continue;
            const snapshot = buildConfigSnapshotForAccount(accId);
            try {
                (worker as any).process.send({ type: 'config_sync', config: snapshot });
            } catch {
                // ignore IPC failures for exited workers
            }
        }
    }

    function broadcastGameConfigReload(): void {
        for (const worker of Object.values(workers)) {
            try {
                (worker as any).process.send({ type: 'reload_config' });
            } catch {
                // ignore IPC failures for exited workers
            }
        }
    }

    function publishAccountStatus(accountId: string, liveStatus?: any, name?: string): void {
        const account = store.getAccountById(accountId);
        if (!account) return;
        const status = liveStatus
            ? { ...liveStatus, hosting: dataProvider.getAccountHosting(accountId), wsError: workers[accountId]?.wsError || null }
            : dataProvider.getStatus(accountId);
        const accountName = name || account.name;
        runtimeEvents.emit('status', { accountId, status, accountName });
        onStatusSync?.(accountId, status, accountName);
    }

    function recordRunIssue(id: string, reason: AccountIssueReason | null): void {
        try {
            store.setAccountRunState(id, { lastRunIssue: reason ? { reason, at: Date.now() } : null });
        } catch (error: any) {
            log('错误', '保存托管状态失败', { accountId: id, reason: error?.message });
        }
        const account = store.getAccountById(id);
        if (reason) wxRecovery?.onDisconnected(account);
        else wxRecovery?.adopt(account);
        if (reason) publishAccountStatus(id);
    }

    function shouldRestore(account: Account): boolean {
        return account.runEnabled && !!account.code && !account.codeConsumed && !requiresNewCode(account.lastRunIssue) && canRunAccounts(account.ownerId);
    }

    function scheduleRecovery(): void {
        if (recoveryTimer || !recoveryQueue.size) return;
        recoveryTimer = setTimeout(() => {
            recoveryTimer = undefined;
            const id = recoveryQueue.values().next().value;
            if (!id) return;
            recoveryQueue.delete(id);
            try {
                const account = store.getAccountById(id);
                if (account && shouldRestore(account)) {
                    if (workers[id]?.stopping) recoveryQueue.add(id);
                    else if (!workers[id]) startWorker(account);
                }
            } catch (error: any) {
                log('错误', '恢复账号托管失败', { accountId: id, reason: error?.message });
            }
            scheduleRecovery();
        }, recoveryIntervalMs);
        recoveryTimer.unref();
    }

    function queueAccountsForRecovery(ownerId?: string): void {
        try {
            const accounts: Account[] = ownerId ? store.getAccountsByOwner(ownerId) : store.getAccounts().accounts;
            for (const account of accounts) {
                const worker = workers[account.id];
                if (account.platform === 'wx' && account.runEnabled && canRunAccounts(account.ownerId)) {
                    wxRecovery.adopt(account, !worker && (account.codeConsumed || !account.code || requiresNewCode(account.lastRunIssue)));
                }
                if (!shouldRestore(account) || (worker && !worker.stopping) || recoveryQueue.has(account.id)) continue;
                recoveryQueue.add(account.id);
                publishAccountStatus(account.id);
            }
        } catch (error: any) {
            log('错误', '读取待恢复账号失败', { reason: error?.message });
        }
        scheduleRecovery();
    }

    async function start(options: { startAdminServer?: boolean; autoStartAccounts?: boolean } = {}): Promise<void> {
        const shouldStartAdminServer = options.startAdminServer !== false;
        const shouldAutoStartAccounts = options.autoStartAccounts !== false;

        const savedSystemConfig = store.getSystemConfig();
        if (savedSystemConfig) {
            updateRuntimeConfig(savedSystemConfig);
            log('系统', `已加载系统配置: serverUrl=${savedSystemConfig.serverUrl}, clientVersion=${savedSystemConfig.clientVersion}, platform=${savedSystemConfig.platform}`);
        }

        if (shouldStartAdminServer && startAdminServer) {
            startAdminServer(dataProvider);
        }

        if (processRef.env.FARM_SESSION_SOCKET) {
            let sessions: any[] | undefined;
            for (let attempt = 0; attempt < 20; attempt++) {
                try { sessions = await listHostedSessions(); break; }
                catch (error) {
                    if (attempt === 19) throw error;
                    if (attempt === 0) log('系统', '等待会话宿主启动');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            const accounts: Account[] = store.getAccounts().accounts;
            for (const session of sessions || []) {
                const account = accounts.find(candidate => findAccountSession([session], candidate));
                // A missing, recreated, disabled or re-authorized account must never
                // inherit an old live connection after the backend comes back.
                if (!account || !account.runEnabled || !account.codeConsumed
                    || !canRunAccounts(account.ownerId) || requiresNewCode(account.lastRunIssue)) {
                    await stopHostedAccount(String(session.accountId), session.accountKey);
                } else {
                    startWorker(account, session.sessionId);
                }
            }
        }
        if (shouldAutoStartAccounts) {
            queueAccountsForRecovery();
        }
    }

    function stopAllAccounts(): void {
        void wxRecovery.stopAll();
        if (recoveryTimer) clearTimeout(recoveryTimer);
        recoveryTimer = undefined;
        recoveryQueue.clear();
        for (const accountId of Object.keys(workers)) {
            stopWorker(accountId);
        }
    }

    return {
        store,
        runtimeEvents,
        workers,
        dataProvider,
        start,
        startAllAccounts: queueAccountsForRecovery,
        stopAllAccounts,
        detachAllWorkers: async () => { await Promise.all([wxRecovery.stopAll(), detachAllWorkers()]); },
        broadcastConfigToWorkers,
        broadcastGameConfigReload,
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        log,
        addAccountLog,
    };
}

module.exports = {
    createRuntimeEngine,
};
