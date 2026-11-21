export {};
const crypto = require('node:crypto');
const fs = require('node:fs');

const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readJsonFileStrict, writeJsonFileAtomic, writeTextFileAtomic } = require('../services/json-db');
const security = require('./auth-security');

const OWNER_ID = 'owner';
const USERS_FILE: string = getDataFile('users.json');
const LEGACY_ADMIN_FILE: string = getDataFile('admin.json');
const BOOTSTRAP_PASSWORD_FILE: string = getDataFile('owner-bootstrap-password.txt');
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 32;

interface UserRecord {
    id: string;
    username: string;
    password: string;
    role: 'owner' | 'tenant';
    status: 'active' | 'disabled';
    createdAt: number;
    expiresAt: number | null;
    maxAccounts: number;
    mustChangePassword?: boolean;
    note?: string;
    lastLoginAt?: number;
}

let users: UserRecord[] | null = null;
let usersById = new Map<string, UserRecord>();
let usersByUsername = new Map<string, UserRecord>();
interface Redemption { redeemedAt: number; redeemedBy: string }
let redemptions: Record<string, Redemption> = {};

function usernameKey(username: unknown): string {
    return String(username || '').trim().toLowerCase();
}

function validateUsername(username: unknown): { valid: boolean; message?: string } {
    const value = String(username || '').trim();
    if (value.length < MIN_USERNAME_LENGTH) return { valid: false, message: `用户名至少 ${MIN_USERNAME_LENGTH} 位` };
    if (value.length > MAX_USERNAME_LENGTH) return { valid: false, message: `用户名最多 ${MAX_USERNAME_LENGTH} 位` };
    if (!/^\w+$/.test(value)) return { valid: false, message: '用户名只能包含字母、数字和下划线' };
    return { valid: true };
}

function normalizeUser(raw: any): UserRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const username = String(raw.username || '').trim();
    const password = String(raw.password || '');
    if (!username || !password) return null;
    const role = raw.role === 'owner' ? 'owner' : 'tenant';
    const id = String(raw.id || (role === 'owner' ? OWNER_ID : ''));
    if (!id) return null;
    const expiresAt = Number(raw.expiresAt);
    return {
        id,
        username,
        password,
        role,
        status: raw.status === 'disabled' ? 'disabled' : 'active',
        createdAt: Number(raw.createdAt) || Date.now(),
        expiresAt: role === 'owner' ? null : (Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : Date.now()),
        maxAccounts: role === 'owner' ? 0 : Math.max(1, Number.parseInt(raw.maxAccounts, 10) || 1),
        mustChangePassword: raw.mustChangePassword === true || undefined,
        note: String(raw.note || '').slice(0, 200),
        lastLoginAt: Number(raw.lastLoginAt) || undefined,
    };
}

function migrateLegacyAdmin(): UserRecord {
    const legacy = readJsonFileStrict(LEGACY_ADMIN_FILE, () => null);
    const source = legacy && typeof legacy === 'object' ? (legacy.admin || legacy) : null;
    if (legacy !== null && !String(source?.password || '').trim()) throw new Error('admin.json 缺少有效管理员凭据');
    return {
        id: OWNER_ID,
        username: String(source?.username || 'admin').trim() || 'admin',
        password: String(source?.password || ''),
        role: 'owner',
        status: 'active',
        createdAt: Number(source?.createdAt) || Date.now(),
        expiresAt: null,
        maxAccounts: 0,
        mustChangePassword: source?.mustChangePassword === true || undefined,
    };
}

function setInitialPassword(owner: UserRecord): void {
    const configured = process.env.ADMIN_PASSWORD || '';
    if (configured && !security.validatePasswordStrength(configured).valid) {
        throw new Error('ADMIN_PASSWORD 不符合密码强度要求');
    }
    const password = configured || crypto.randomBytes(24).toString('base64url');
    if (!configured) {
        writeTextFileAtomic(BOOTSTRAP_PASSWORD_FILE, password + '\n', 0o600);
    }
    owner.password = security.hashPassword(password);
    owner.mustChangePassword = !configured;
}

function saveUsers(next: UserRecord[], receipts = redemptions): void {
    ensureDataDir();
    writeJsonFileAtomic(USERS_FILE, { users: next, redemptions: receipts }, 2, 0o600);
    publishUsers(next, receipts);
}

function publishUsers(next: UserRecord[], receipts: Record<string, Redemption>): void {
    usersById = new Map(next.map(user => [user.id, user]));
    usersByUsername = new Map(next.map(user => [usernameKey(user.username), user]));
    users = next;
    redemptions = receipts;
}

function loadUsers(): UserRecord[] {
    if (users) return users;
    ensureDataDir();
    const missing = Symbol();
    const raw = readJsonFileStrict(USERS_FILE, () => missing);
    const list = raw === missing ? [migrateLegacyAdmin()] : raw?.users;
    if (!Array.isArray(list)) throw new Error('users.json 缺少有效的用户列表');
    const normalized = raw === missing ? list as UserRecord[] : list.map(normalizeUser) as UserRecord[];
    const owner = normalized.find(user => user?.role === 'owner');
    if (!owner || owner.id !== OWNER_ID || normalized.some(user => !user)
        || normalized.filter(user => user.role === 'owner').length !== 1
        || new Set(normalized.map(user => usernameKey(user.username))).size !== normalized.length
        || new Set(normalized.map(user => user.id)).size !== normalized.length) {
        throw new Error('users.json 包含无效或重复的用户');
    }
    const receipts = raw === missing ? {} : raw.redemptions ?? {};
    if (typeof receipts !== 'object' || !receipts || Array.isArray(receipts)
        || Object.values(receipts).some((entry: any) => !Number.isFinite(entry?.redeemedAt) || typeof entry?.redeemedBy !== 'string')) {
        throw new Error('users.json 包含无效的激活码兑换记录');
    }
    if (!owner.password || security.verifyPassword('admin', owner.password)) {
        setInitialPassword(owner);
        saveUsers(normalized, receipts);
    } else if (raw === missing) {
        saveUsers(normalized, receipts);
    }
    publishUsers(normalized, receipts);
    return normalized;
}

function getCodeRedemption(codeId: string): Redemption | undefined {
    loadUsers();
    return Object.hasOwn(redemptions, codeId) ? redemptions[codeId] : undefined;
}

function saveUser(user: UserRecord, codeId?: string): void {
    const next = loadUsers().filter(record => record.id !== user.id);
    next.push(user);
    const receipts = codeId
        ? { ...redemptions, [codeId]: { redeemedAt: Date.now(), redeemedBy: user.id } }
        : redemptions;
    saveUsers(next, receipts);
}

function getUserById(id: unknown): UserRecord | null {
    const target = String(id || '');
    if (!target) return null;
    loadUsers();
    return usersById.get(target) || null;
}

function findUserByUsername(username: unknown): UserRecord | null {
    const key = usernameKey(username);
    if (!key) return null;
    loadUsers();
    return usersByUsername.get(key) || null;
}

function publicUser(user: UserRecord): any {
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        expiresAt: user.expiresAt,
        maxAccounts: user.maxAccounts,
        mustChangePassword: user.mustChangePassword === true,
        note: user.note || '',
        lastLoginAt: user.lastLoginAt || null,
    };
}

function listUsers(): any[] {
    return loadUsers().map(publicUser);
}

function getOwner(): UserRecord {
    return loadUsers().find(user => user.role === 'owner')!;
}

function isExpired(user: UserRecord, now = Date.now()): boolean {
    return user.role !== 'owner' && user.expiresAt !== null && user.expiresAt <= now;
}

function canRunAccounts(userId: string): boolean {
    const user = getUserById(userId || OWNER_ID);
    return !!user && user.status === 'active' && !isExpired(user);
}

function validateCredentials(
    username: unknown,
    password: unknown,
    ip = 'unknown',
    options: { allowExpired?: boolean; rateLimitChecked?: boolean } = {},
): any {
    if (!options.rateLimitChecked) {
        const rateLimit = security.checkRateLimit(ip);
        if (!rateLimit.allowed) return { ok: false, error: 'rate_limit', ...rateLimit };
    }

    const user = findUserByUsername(username);
    const attemptKey = `user:${usernameKey(username).slice(0, MAX_USERNAME_LENGTH)}:${ip}`;
    const lockout = security.checkLockout(attemptKey);
    if (lockout.locked) return { ok: false, error: 'locked', ...lockout };

    if (!user || !security.verifyPassword(String(password || ''), user.password)) {
        const attempt = security.recordFailedAttemptFor(attemptKey);
        return attempt.locked
            ? { ok: false, error: 'locked', message: attempt.message }
            : {
                ok: false,
                error: 'invalid_credentials',
                message: `用户名或密码错误，剩余尝试次数: ${attempt.remainingAttempts}`,
            };
    }

    security.clearFailedAttemptsFor(attemptKey);

    if (user.status === 'disabled') {
        return { ok: false, error: 'disabled', message: '账号已被停用，请联系管理员' };
    }
    if (!options.allowExpired && isExpired(user)) {
        return { ok: false, error: 'expired', message: '账号已到期，请使用续费码', expiresAt: user.expiresAt };
    }

    const authenticated = {
        ...user,
        password: security.needsRehash(user.password) ? security.hashPassword(String(password)) : user.password,
        lastLoginAt: Date.now(),
    };
    saveUser(authenticated);
    return { ok: true, user: authenticated };
}

function createTenant(options: {
    username: string;
    password: string;
    expiresAt: number;
    maxAccounts: number;
    note?: string;
    codeId?: string;
}): any {
    if (options.codeId && getCodeRedemption(options.codeId)) {
        return { ok: false, error: 'used_code', message: '激活码已被使用' };
    }
    const username = String(options.username || '').trim();
    const validation = validateUsername(username);
    if (!validation.valid) return { ok: false, error: 'invalid_username', message: validation.message };
    const passwordValidation = security.validatePasswordStrength(String(options.password || ''));
    if (!passwordValidation.valid) {
        return { ok: false, error: 'weak_password', message: passwordValidation.errors.join('；') };
    }
    if (findUserByUsername(username)) {
        return { ok: false, error: 'username_taken', message: '用户名已被使用' };
    }
    const expiresAt = Number(options.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return { ok: false, error: 'invalid_expiry', message: '租户有效期无效' };
    }
    const maxAccounts = Math.max(1, Math.min(100, Number.parseInt(String(options.maxAccounts), 10) || 1));
    const user: UserRecord = {
        id: `t_${crypto.randomBytes(8).toString('hex')}`,
        username,
        password: security.hashPassword(String(options.password)),
        role: 'tenant',
        status: 'active',
        createdAt: Date.now(),
        expiresAt,
        maxAccounts,
        note: String(options.note || '').slice(0, 200),
    };
    saveUser(user, options.codeId);
    return { ok: true, user };
}

function updateTenant(id: unknown, patch: { status?: string; expiresAt?: number; maxAccounts?: number; note?: string } = {}): any {
    const current = getUserById(id);
    if (!current || current.role !== 'tenant') return { ok: false, error: 'not_found', message: '租户不存在' };
    const user = { ...current };
    if (patch.status !== undefined) {
        if (patch.status !== 'disabled' && patch.status !== 'active') {
            return { ok: false, error: 'invalid_status', message: '租户状态无效' };
        }
        user.status = patch.status;
    }
    if (patch.expiresAt !== undefined) {
        const expiresAt = Number(patch.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= 0) return { ok: false, error: 'invalid_expiry', message: '有效期无效' };
        user.expiresAt = expiresAt;
    }
    if (patch.maxAccounts !== undefined) {
        const maxAccounts = Number.parseInt(patch.maxAccounts as any, 10);
        if (!Number.isFinite(maxAccounts) || maxAccounts < 1) return { ok: false, error: 'invalid_quota', message: '账号配额至少为 1' };
        user.maxAccounts = Math.min(100, maxAccounts);
    }
    if (patch.note !== undefined) user.note = String(patch.note || '').slice(0, 200);
    saveUser(user);
    return { ok: true, user: publicUser(user) };
}

function extendTenant(id: unknown, days: unknown, redemption?: { codeId: string; maxAccounts: number; targetTenantId?: string | null }): any {
    const current = getUserById(id);
    if (!current || current.role !== 'tenant') return { ok: false, error: 'not_found', message: '租户不存在' };
    if (redemption?.targetTenantId && redemption.targetTenantId !== current.id) {
        return { ok: false, error: 'wrong_tenant', message: '此续费码不适用于当前账号' };
    }
    if (redemption && (current.status === 'disabled' || getCodeRedemption(redemption.codeId))) {
        return { ok: false, error: 'renewal_unavailable', message: '续费码已使用或账号已停用' };
    }
    const parsedDays = Number.parseInt(days as any, 10);
    if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
        return { ok: false, error: 'invalid_days', message: '延期天数无效' };
    }
    const amount = Math.min(3650, parsedDays);
    const base = Math.max(Date.now(), Number(current.expiresAt) || 0);
    const user = { ...current, expiresAt: base + amount * 86_400_000 };
    if (redemption) user.maxAccounts = Math.max(user.maxAccounts, redemption.maxAccounts);
    saveUser(user, redemption?.codeId);
    return { ok: true, user: publicUser(user), days: amount };
}

function changePassword(userId: unknown, oldPassword: unknown, newPassword: unknown): any {
    const user = getUserById(userId);
    if (!user) return { ok: false, error: 'not_found', message: '用户不存在' };
    if (!security.verifyPassword(String(oldPassword || ''), user.password)) {
        return { ok: false, error: 'invalid_password', message: '当前密码错误' };
    }
    return resetPassword(userId, newPassword);
}

function resetPassword(userId: unknown, newPassword: unknown): any {
    const user = getUserById(userId);
    if (!user) return { ok: false, error: 'not_found', message: '用户不存在' };
    const validation = security.validatePasswordStrength(String(newPassword || ''));
    if (!validation.valid) return { ok: false, error: 'weak_password', message: validation.errors.join('；') };
    const updated = { ...user, password: security.hashPassword(String(newPassword)), mustChangePassword: undefined };
    saveUser(updated);
    if (user.role === 'owner' && user.mustChangePassword) {
        try { fs.unlinkSync(BOOTSTRAP_PASSWORD_FILE); } catch (error: any) {
            if (error.code !== 'ENOENT') console.warn('无法删除已失效的管理员初始密码文件');
        }
    }
    return { ok: true, user: publicUser(updated) };
}

function deleteTenant(id: unknown): any {
    const user = getUserById(id);
    if (!user || user.role !== 'tenant') return { ok: false, error: 'not_found', message: '租户不存在' };
    saveUsers(loadUsers().filter(item => item.id !== user.id));
    return { ok: true, user: publicUser(user) };
}

function findTenantForRenewal(username: unknown, password: unknown, ip = 'unknown', options: { rateLimitChecked?: boolean } = {}): any {
    return validateCredentials(username, password, ip, { ...options, allowExpired: true });
}

function countTenants(): number {
    return loadUsers().filter(user => user.role === 'tenant').length;
}

module.exports = {
    OWNER_ID,
    USERS_FILE,
    loadUsers,
    saveUsers,
    getUserById,
    findUserByUsername,
    getOwner,
    listUsers,
    publicUser,
    getCodeRedemption,
    validateUsername,
    validateCredentials,
    createTenant,
    updateTenant,
    extendTenant,
    changePassword,
    resetPassword,
    deleteTenant,
    findTenantForRenewal,
    countTenants,
    isExpired,
    canRunAccounts,
};
