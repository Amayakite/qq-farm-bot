import type { ActivationCodeRecord, ActivationCodeStatus, ActivationCodeType, PublicActivationCode } from '../types/tenant';
export {};
const crypto = require('node:crypto');
const fs = require('node:fs');

const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readJsonFileStrict, writeJsonFileAtomic } = require('../services/json-db');
const { getCodeRedemption, getUserById } = require('./user-store');

const CODES_FILE: string = getDataFile('activation-codes.json');
const CODE_KEY_FILE: string = getDataFile('activation-code-key');
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 16;
const CODE_PREFIX = 'QF';

let codes: ActivationCodeRecord[] | null = null;

type CodeTerms = Pick<ActivationCodeRecord, 'days' | 'maxAccounts' | 'redeemBefore' | 'note' | 'targetTenantId'>;
type IssueTerms = CodeTerms & Pick<ActivationCodeRecord, 'type' | 'batchId' | 'createdBy' | 'replacesId'>;
type CodeChange = Partial<Record<keyof CodeTerms, unknown>>;
type CodeError = { ok: false; error: string; message: string };

function normalizeCode(raw: unknown): string {
    return String(raw || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
}

function hashCode(normalized: string): string {
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function randomCode(): string {
    let body = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
        body += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
    }
    return `${CODE_PREFIX}${body}`;
}

function formatCode(normalized: string): string {
    const prefix = normalized.startsWith(CODE_PREFIX) ? CODE_PREFIX : '';
    const body = prefix ? normalized.slice(prefix.length) : normalized;
    const groups = body.match(/.{1,4}/g) || [body];
    return [prefix, ...groups].filter(Boolean).join('-');
}

function normalizeRecord(raw: any): ActivationCodeRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    let codeHash = String(raw.codeHash || '');
    if (!codeHash && raw.code) {
        // 兼容早期明文存储的测试数据。
        codeHash = hashCode(normalizeCode(raw.code));
    }
    if (!codeHash) return null;
    const type = raw.type === 'renew' ? 'renew' : 'new';
    return {
        id: String(raw.id || codeHash),
        codeHash,
        encryptedCode: typeof raw.encryptedCode === 'string' && raw.encryptedCode ? raw.encryptedCode : null,
        codeHint: String(raw.codeHint || '').slice(-6),
        type,
        days: Math.max(1, Math.min(3650, Number.parseInt(raw.days, 10) || 30)),
        maxAccounts: Math.max(1, Math.min(100, Number.parseInt(raw.maxAccounts, 10) || 3)),
        redeemBefore: Number(raw.redeemBefore) > 0 ? Number(raw.redeemBefore) : null,
        createdAt: Number(raw.createdAt) || Date.now(),
        createdBy: String(raw.createdBy || 'owner'),
        batchId: String(raw.batchId || ''),
        note: String(raw.note || '').slice(0, 200),
        targetTenantId: type === 'renew' && raw.targetTenantId ? String(raw.targetTenantId) : null,
        replacesId: raw.replacesId ? String(raw.replacesId) : null,
        replacedBy: raw.replacedBy ? String(raw.replacedBy) : null,
        redeemedAt: Number(raw.redeemedAt) > 0 ? Number(raw.redeemedAt) : null,
        redeemedBy: raw.redeemedBy ? String(raw.redeemedBy) : null,
        revokedAt: Number(raw.revokedAt) > 0 ? Number(raw.revokedAt) : null,
    };
}

function saveCodes(next: ActivationCodeRecord[]): void {
    ensureDataDir();
    writeJsonFileAtomic(CODES_FILE, { codes: next }, 2, 0o600);
    codes = next;
}

function loadCodes(): ActivationCodeRecord[] {
    if (codes) return codes;
    ensureDataDir();
    const raw = readJsonFileStrict(CODES_FILE, () => ({ codes: [] }));
    if (!Array.isArray(raw?.codes)) throw new Error('activation-codes.json 缺少有效的激活码列表');
    const list = (raw.codes as unknown[]).map(normalizeRecord).filter((record): record is ActivationCodeRecord => record !== null);
    if (list.length !== raw.codes.length
        || new Set(list.map(record => record.id)).size !== list.length
        || new Set(list.map(record => record.codeHash)).size !== list.length) {
        throw new Error('activation-codes.json 包含无效或重复的激活码');
    }
    codes = list;
    return codes;
}

function codeStatus(record: ActivationCodeRecord, now = Date.now()): ActivationCodeStatus {
    if (record.redeemedAt || getCodeRedemption(record.id)) return 'redeemed';
    if (record.revokedAt) return 'revoked';
    if (record.redeemBefore && record.redeemBefore <= now) return 'expired';
    return 'unused';
}

function publicCode(record: ActivationCodeRecord): PublicActivationCode {
    const redemption = getCodeRedemption(record.id) || record;
    return {
        id: record.id,
        codeHint: record.codeHint,
        hasFullCode: !!record.encryptedCode,
        type: record.type,
        days: record.days,
        maxAccounts: record.maxAccounts,
        redeemBefore: record.redeemBefore,
        createdAt: record.createdAt,
        createdBy: record.createdBy,
        batchId: record.batchId,
        note: record.note,
        targetTenantId: record.targetTenantId,
        replacesId: record.replacesId,
        replacedBy: record.replacedBy,
        redeemedAt: redemption.redeemedAt,
        redeemedBy: redemption.redeemedBy,
        revokedAt: record.revokedAt,
        status: codeStatus(record),
    };
}

function listCodes(filters: { status?: string; type?: string; batchId?: string } = {}): PublicActivationCode[] {
    const status = String(filters.status || '').trim();
    const type = String(filters.type || '').trim();
    const batchId = String(filters.batchId || '').trim();
    return loadCodes()
        .filter(record => !status || codeStatus(record) === status)
        .filter(record => !type || record.type === type)
        .filter(record => !batchId || record.batchId === batchId)
        .map(publicCode)
        .sort((a, b) => b.createdAt - a.createdAt);
}

function codeError(error: string, message: string): CodeError {
    return { ok: false, error, message };
}

function validateTerms(type: ActivationCodeType, patch: CodeChange, current?: CodeTerms): { ok: true; terms: CodeTerms } | CodeError {
    const days = patch.days === undefined ? current?.days ?? 30 : patch.days;
    const maxAccounts = patch.maxAccounts === undefined ? current?.maxAccounts ?? 3 : patch.maxAccounts;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650) {
        return codeError('invalid_days', '有效天数须为 1 至 3650 的整数');
    }
    if (typeof maxAccounts !== 'number' || !Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 100) {
        return codeError('invalid_quota', '账号配额须为 1 至 100 的整数');
    }
    const redeemBefore = patch.redeemBefore === undefined ? current?.redeemBefore ?? null : patch.redeemBefore;
    if (redeemBefore !== null && (typeof redeemBefore !== 'number' || !Number.isSafeInteger(redeemBefore)
        || redeemBefore > 8.64e15 || (redeemBefore !== current?.redeemBefore && redeemBefore <= Date.now()))) {
        return codeError('invalid_deadline', '兑换截止时间须晚于当前时间');
    }
    const note = patch.note === undefined ? current?.note ?? '' : patch.note;
    if (typeof note !== 'string' || note.length > 200) {
        return codeError('invalid_note', '备注最多 200 字');
    }
    const targetTenantId = patch.targetTenantId === undefined ? current?.targetTenantId ?? null : patch.targetTenantId;
    if (targetTenantId !== null && (typeof targetTenantId !== 'string' || type !== 'renew'
        || (targetTenantId !== current?.targetTenantId && getUserById(targetTenantId)?.role !== 'tenant'))) {
        return codeError('invalid_target', '仅续费码可绑定现有租户');
    }
    return { ok: true, terms: {
        days,
        maxAccounts,
        redeemBefore: typeof redeemBefore === 'number' ? redeemBefore : null,
        note: note.trim(),
        targetTenantId: typeof targetTenantId === 'string' ? targetTenantId : null,
    } };
}

function readCodeKey(create = false): Buffer {
    try {
        const key = fs.readFileSync(CODE_KEY_FILE);
        if (key.length !== 32) throw new Error('激活码密钥文件无效，请从备份恢复');
        return key;
    } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        if (!create || loadCodes().some(record => record.encryptedCode)) {
            throw new Error('激活码密钥文件缺失，请从备份恢复');
        }
        const key = crypto.randomBytes(32);
        ensureDataDir();
        try {
            fs.writeFileSync(CODE_KEY_FILE, key, { mode: 0o600, flag: 'wx' });
        } catch (writeError: any) {
            if (writeError.code === 'EEXIST') return readCodeKey();
            throw writeError;
        }
        return key;
    }
}

function encryptCode(code: string, recordId: string, key: Buffer): string {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(recordId));
    const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function decryptCode(record: ActivationCodeRecord, key: Buffer): string {
    try {
        const payload = Buffer.from(record.encryptedCode!, 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
        decipher.setAAD(Buffer.from(record.id));
        decipher.setAuthTag(payload.subarray(12, 28));
        const normalized = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
        if (hashCode(normalized) !== record.codeHash) throw new Error('Code hash mismatch');
        return formatCode(normalized);
    } catch {
        throw new Error('无法读取完整激活码，请核对数据与密钥是否来自同一份备份');
    }
}

function deliveryCode(record: ActivationCodeRecord, code: string) {
    const { id, codeHint, type, days, maxAccounts, redeemBefore, batchId, targetTenantId } = record;
    return { id, code, codeHint, type, days, maxAccounts, redeemBefore, batchId, targetTenantId };
}

function issueCode(terms: IssueTerms, seen: Set<string>, key: Buffer) {
    let normalized: string;
    let hash: string;
    do {
        normalized = randomCode();
        hash = hashCode(normalized);
    } while (seen.has(hash));
    seen.add(hash);
    const id = crypto.randomBytes(10).toString('hex');
    const record: ActivationCodeRecord = {
        ...terms,
        id,
        codeHash: hash,
        encryptedCode: encryptCode(normalized, id, key),
        codeHint: normalized.slice(-4),
        createdAt: Date.now(),
        redeemedAt: null,
        redeemedBy: null,
        revokedAt: null,
        replacedBy: null,
    };
    return { record, delivery: deliveryCode(record, formatCode(normalized)) };
}

function generateCodes(options: CodeChange & { count?: unknown; type?: unknown; createdBy?: string }) {
    const count = options.count === undefined ? 1 : options.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100) {
        return codeError('invalid_count', '每批可生成 1 至 100 个激活码');
    }
    const type = options.type === undefined ? 'new' : options.type;
    if (type !== 'new' && type !== 'renew') return codeError('invalid_type', '激活码类型无效');
    const validation = validateTerms(type, options);
    if (!validation.ok) return validation;
    const batchId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const terms = { ...validation.terms, type, batchId, createdBy: options.createdBy || 'owner', replacesId: null } as const;
    const store = [...loadCodes()];
    const seen = new Set(store.map(record => record.codeHash));
    const key = readCodeKey(true);
    const issued = [];
    for (let i = 0; i < count; i++) {
        const { record, delivery } = issueCode(terms, seen, key);
        store.push(record);
        issued.push(delivery);
    }
    saveCodes(store);
    return { ok: true as const, batchId, codes: issued };
}

function updateCode(id: unknown, patch: CodeChange) {
    const store = loadCodes();
    const record = store.find(item => item.id === id);
    if (!record) return codeError('not_found', '激活码不存在');
    const status = codeStatus(record);
    if ((status === 'redeemed' || status === 'revoked')
        && (['days', 'maxAccounts', 'redeemBefore', 'targetTenantId'] as const).some(key => patch[key] !== undefined)) {
        return codeError('terms_locked', '已兑换或已吊销的激活码只可修改备注');
    }
    const validation = validateTerms(record.type, patch, record);
    if (!validation.ok) return validation;
    const updated = { ...record, ...validation.terms };
    saveCodes(store.map(item => item === record ? updated : item));
    return { ok: true as const, code: publicCode(updated) };
}

function replaceCode(id: unknown, createdBy: string) {
    const store = loadCodes();
    const record = store.find(item => item.id === id);
    if (!record) return codeError('not_found', '激活码不存在');
    if (codeStatus(record) === 'redeemed') return codeError('already_redeemed', '已兑换的激活码不能换发');
    if (record.replacedBy) return codeError('already_replaced', '该码已换发，请打开换发后的激活码');
    if (record.targetTenantId && getUserById(record.targetTenantId)?.role !== 'tenant') {
        return codeError('invalid_target', '指定租户已删除。请重新生成续费码');
    }
    const { record: replacement, delivery } = issueCode({
        type: record.type,
        days: record.days,
        maxAccounts: record.maxAccounts,
        redeemBefore: record.redeemBefore && record.redeemBefore > Date.now() ? record.redeemBefore : null,
        targetTenantId: record.targetTenantId,
        batchId: record.batchId || `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
        note: record.note,
        replacesId: record.id,
        createdBy,
    }, new Set(store.map(item => item.codeHash)), readCodeKey(true));
    const revoked = { ...record, revokedAt: record.revokedAt || Date.now(), replacedBy: replacement.id };
    saveCodes([...store.map(item => item === record ? revoked : item), replacement]);
    return { ok: true as const, batchId: replacement.batchId, codes: [delivery] };
}

function revealCode(id: unknown) {
    const record = loadCodes().find(item => item.id === id);
    if (!record) return codeError('not_found', '激活码不存在');
    if (!record.encryptedCode) return codeError('full_code_unavailable', '此码由旧版本生成，完整码无法恢复');
    return { ok: true as const, code: decryptCode(record, readCodeKey()) };
}

function revealBatch(batchId: unknown) {
    const batch = loadCodes().filter(record => record.batchId === batchId);
    if (!batch.length) return codeError('not_found', '批次不存在');
    const available = batch.filter(record => codeStatus(record) === 'unused');
    const copyable = available.filter(record => record.encryptedCode);
    const key = copyable.length ? readCodeKey() : null;
    const codes = key ? copyable.map(record => deliveryCode(record, decryptCode(record, key))) : [];
    return { ok: true as const, batchId, codes, unavailable: available.length - copyable.length };
}

function findByRaw(raw: unknown): ActivationCodeRecord | null {
    const normalized = normalizeCode(raw);
    if (!normalized) return null;
    const hash = hashCode(normalized);
    return loadCodes().find(record => record.codeHash === hash) || null;
}

function validateCode(raw: unknown, expectedType?: string): any {
    const record = findByRaw(raw);
    if (!record) return { ok: false, error: 'invalid_code', message: '激活码无效' };
    const status = codeStatus(record);
    if (status === 'revoked') return { ok: false, error: 'revoked_code', message: '激活码已被吊销' };
    if (status === 'redeemed') return { ok: false, error: 'used_code', message: '激活码已被使用' };
    if (status === 'expired') {
        return { ok: false, error: 'expired_code', message: '激活码已过兑换截止时间' };
    }
    if (expectedType && record.type !== expectedType) {
        return {
            ok: false,
            error: record.type === 'renew' ? 'renew_code_required' : 'new_code_required',
            message: record.type === 'renew' ? '这是续费码，请在续费入口使用' : '这是新用户激活码，请在注册入口使用',
        };
    }
    return { ok: true, record };
}

function revokeCode(id: unknown): any {
    const store = loadCodes();
    const record = store.find(item => item.id === String(id || ''));
    if (!record) return { ok: false, error: 'not_found', message: '激活码不存在' };
    if (codeStatus(record) === 'redeemed') return { ok: false, error: 'already_redeemed', message: '已兑换的激活码不能吊销' };
    if (!record.revokedAt) {
        const revoked = { ...record, revokedAt: Date.now() };
        saveCodes(store.map(item => item === record ? revoked : item));
        return { ok: true, code: publicCode(revoked) };
    }
    return { ok: true, code: publicCode(record) };
}

function revokeBatch(batchId: unknown): any {
    const target = String(batchId || '');
    if (!target) return { ok: false, error: 'invalid_batch', message: '批次无效' };
    let count = 0;
    const next = loadCodes().map(record => {
        if (record.batchId === target && !record.revokedAt && codeStatus(record) !== 'redeemed') {
            count++;
            return { ...record, revokedAt: Date.now() };
        }
        return record;
    });
    if (count) saveCodes(next);
    return { ok: true, revoked: count };
}

function stats(): any {
    const store = loadCodes();
    const now = Date.now();
    const result = {
        total: store.length,
        unused: 0,
        redeemed: 0,
        revoked: 0,
        expired: 0,
        newCodes: 0,
        renewCodes: 0,
        batchCount: new Set(store.map(record => record.batchId).filter(Boolean)).size,
    };
    for (const record of store) {
        const status = codeStatus(record, now);
        result[status]++;
        if (record.type === 'renew') result.renewCodes++;
        else result.newCodes++;
    }
    return result;
}

module.exports = {
    CODES_FILE,
    normalizeCode,
    formatCode,
    loadCodes,
    listCodes,
    generateCodes,
    updateCode,
    replaceCode,
    revealCode,
    revealBatch,
    validateCode,
    findByRaw,
    revokeCode,
    revokeBatch,
    stats,
    codeStatus,
};
