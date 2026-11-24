import type { Account, AccountIssue, AccountsData } from '../../types/account';
export {};

const { ensureDataDir } = require('../../config/runtime-paths');
const { readJsonFileStrict, writeJsonFileAtomic, storageError } = require('../../services/json-db');

const { ACCOUNTS_FILE } = require('./shared-state');
const { normalizeAccountRef }: { normalizeAccountRef: (ref: unknown) => string } = require('../../services/account-resolver');
let accountsCache: AccountsData | null = null;
let byId = new Map<string, Account>();
let byAlias = new Map<string, Account>();
let byOwner = new Map<string, Account[]>();

function cloneAccount(account: Account): Account {
    return { ...account, lastRunIssue: account.lastRunIssue && { ...account.lastRunIssue } };
}

function cloneAccounts(data: AccountsData): AccountsData {
    return { accounts: data.accounts.map(cloneAccount), nextId: data.nextId };
}

function publishAccounts(data: AccountsData): void {
    byId = new Map();
    byAlias = new Map();
    byOwner = new Map();
    for (const account of data.accounts) {
        if (!byId.has(account.id)) byId.set(account.id, account);
        for (const alias of [account.qq, account.uin].map(normalizeAccountRef)) {
            if (alias && !byAlias.has(alias)) byAlias.set(alias, account);
        }
        const owned = byOwner.get(account.ownerId);
        if (owned) owned.push(account);
        else byOwner.set(account.ownerId, [account]);
    }
    accountsCache = data;
}

function loadAccounts(): AccountsData {
    accountsCache = null;
    try {
        ensureDataDir();
        const raw = readJsonFileStrict(ACCOUNTS_FILE, () => ({ accounts: [], nextId: 1 }));
        if (!raw || !Array.isArray(raw.accounts)) throw new Error('Invalid accounts data');
        const data = normalizeAccountsData(raw);
        if (raw.accounts.some((account: any) => !Number(account?.createdAt))) saveAccounts(data);
        else publishAccounts(data);
        return cloneAccounts(data);
    } catch (error: any) {
        throw storageError('读取', ACCOUNTS_FILE, error);
    }
}

function saveAccounts(data: AccountsData): void {
    let normalized: AccountsData;
    try {
        ensureDataDir();
        normalized = normalizeAccountsData(data);
        writeJsonFileAtomic(ACCOUNTS_FILE, normalized, 2, 0o600);
    }
    catch (error: any) { throw storageError('保存', ACCOUNTS_FILE, error); }
    publishAccounts(normalized);
}

function getAccounts(): AccountsData {
    return accountsCache ? cloneAccounts(accountsCache) : loadAccounts();
}

function getAccountById(id: string): Account | null {
    if (!accountsCache) loadAccounts();
    const account = byId.get(id);
    return account ? cloneAccount(account) : null;
}

function findAccountByRef(ref: unknown): Account | null {
    if (!accountsCache) loadAccounts();
    const key = normalizeAccountRef(ref);
    const account = byId.get(key) || byAlias.get(key);
    return account ? cloneAccount(account) : null;
}

function getAccountsByOwner(id: string): Account[] {
    if (!accountsCache) loadAccounts();
    return (byOwner.get(id) || []).map(cloneAccount);
}

function setAccountRunState(id: string, patch: Partial<Pick<Account, 'runEnabled' | 'lastRunIssue' | 'codeConsumed'>>): Account | null {
    const account = getAccountById(id);
    if (!account) return null;
    const next = { ...account, ...patch };
    if (account.runEnabled !== next.runEnabled || account.codeConsumed !== next.codeConsumed || account.lastRunIssue?.reason !== next.lastRunIssue?.reason
        || account.lastRunIssue?.at !== next.lastRunIssue?.at) {
        const data = getAccounts();
        data.accounts = data.accounts.map(item => item.id === id ? next : item);
        saveAccounts(data);
    }
    return next;
}

function normalizeAccountsData(raw: unknown): AccountsData {
    const data: any = raw && typeof raw === 'object' ? raw : {};
    const accounts: Account[] = (Array.isArray(data.accounts) ? data.accounts : []).map(normalizeAccount);
    const maxId = accounts.reduce((m: number, a: any) => Math.max(m, Number.parseInt(a && a.id, 10) || 0), 0);
    let nextId = Number.parseInt(data.nextId, 10);
    if (!Number.isFinite(nextId) || nextId <= 0) nextId = maxId + 1;
    // 多租户下账号 ID 必须保持单调递增，避免删除后复用 ID 串到其他租户的日志/配置。
    if (nextId <= maxId) nextId = maxId + 1;
    return { accounts, nextId };
}

function normalizeAccount(raw: any): Account {
    const source = raw && typeof raw === 'object' ? raw : {};
    const account: Account = {
        id: normalizeAccountRef(source.id),
        name: String(source.name || ''),
        code: String(source.code || ''),
        platform: String(source.platform || 'qq'),
        uin: String(source.uin || ''),
        qq: String(source.qq || source.uin || ''),
        avatar: String(source.avatar || source.avatarUrl || ''),
        ownerId: String(source.ownerId || 'owner'),
        runEnabled: source.runEnabled === true,
        codeConsumed: source.codeConsumed === true,
        lastRunIssue: normalizeIssue(source.lastRunIssue),
        createdAt: Number(source.createdAt) || Date.now(),
        updatedAt: Number(source.updatedAt) || Date.now(),
    };
    const nick = String(source.nick || '').trim();
    if (nick) account.nick = nick;
    return account;
}

function normalizeIssue(issue: any): AccountIssue | null {
    if (!issue || !['login_required', 'kicked', 'session_lost', 'disconnected', 'worker_failed'].includes(issue.reason)
        || !Number.isFinite(issue.at) || issue.at <= 0) return null;
    return { reason: issue.reason, at: issue.at };
}

function addOrUpdateAccount(acc: Partial<Account> & { avatarUrl?: string }, options: { enableHosting?: boolean } = {}): AccountsData {
    const { ensureAccountConfig } = require('./account-config');
    const data = getAccounts();
    let touchedAccountId = '';
    const source: any = acc || {};
    const cleanAccount: any = {};
    for (const key of ['id', 'name', 'code', 'platform', 'uin', 'qq', 'avatar', 'avatarUrl', 'nick', 'ownerId']) {
        if (source[key] !== undefined) cleanAccount[key] = source[key];
    }
    acc = cleanAccount;
    if (acc.id) {
        const idx = data.accounts.findIndex(a => a.id === acc.id);
        if (idx >= 0) {
            const existing = data.accounts[idx];
            const hasNewCode = typeof acc.code === 'string' && !!acc.code && acc.code !== existing.code;
            data.accounts[idx] = { ...existing, ...acc, updatedAt: Date.now() };
            if (options.enableHosting) data.accounts[idx].runEnabled = true;
            if (hasNewCode) {
                data.accounts[idx].codeConsumed = false;
                data.accounts[idx].lastRunIssue = null;
            }
            touchedAccountId = existing.id;
        }
    } else {
        const id = data.nextId++;
        touchedAccountId = String(id);
        data.accounts.push({
            id: touchedAccountId,
            name: acc.name || `账号${id}`,
            code: acc.code || '',
            platform: acc.platform || 'qq',
            uin: acc.uin ? String(acc.uin) : '',
            qq: acc.qq ? String(acc.qq) : (acc.uin ? String(acc.uin) : ''),
            avatar: acc.avatar || acc.avatarUrl || '',
            ownerId: String(acc.ownerId || 'owner'),
            runEnabled: options.enableHosting === true,
            codeConsumed: false,
            lastRunIssue: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
    }
    if (touchedAccountId) {
        ensureAccountConfig(touchedAccountId);
    }
    saveAccounts(data);
    return data;
}

function deleteAccount(id: unknown): AccountsData {
    const { removeAccountConfig } = require('./account-config');
    const data = getAccounts();
    data.accounts = data.accounts.filter(a => a.id !== String(id));
    removeAccountConfig(id);
    saveAccounts(data);
    return data;
}

module.exports = {
    loadAccounts,
    saveAccounts,
    getAccounts,
    getAccountById,
    findAccountByRef,
    getAccountsByOwner,
    setAccountRunState,
    normalizeAccountsData,
    addOrUpdateAccount,
    deleteAccount,
};
