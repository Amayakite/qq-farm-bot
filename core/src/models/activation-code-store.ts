export {};
const crypto = require('node:crypto');

const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readJsonFileStrict, writeJsonFileAtomic } = require('../services/json-db');
const { getCodeRedemption } = require('./user-store');

const CODES_FILE: string = getDataFile('activation-codes.json');
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 16;
const CODE_PREFIX = 'QF';

let codes: any[] | null = null;

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

function normalizeRecord(raw: any): any | null {
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
        codeHint: String(raw.codeHint || '').slice(-6),
        type,
        days: Math.max(1, Math.min(3650, Number.parseInt(raw.days, 10) || 30)),
        maxAccounts: Math.max(1, Math.min(100, Number.parseInt(raw.maxAccounts, 10) || 3)),
        redeemBefore: Number(raw.redeemBefore) > 0 ? Number(raw.redeemBefore) : null,
        createdAt: Number(raw.createdAt) || Date.now(),
        createdBy: String(raw.createdBy || 'owner'),
        batchId: String(raw.batchId || ''),
        note: String(raw.note || '').slice(0, 200),
        redeemedAt: Number(raw.redeemedAt) > 0 ? Number(raw.redeemedAt) : null,
        redeemedBy: raw.redeemedBy ? String(raw.redeemedBy) : null,
        revokedAt: Number(raw.revokedAt) > 0 ? Number(raw.revokedAt) : null,
    };
}

function saveCodes(next: any[]): void {
    ensureDataDir();
    writeJsonFileAtomic(CODES_FILE, { codes: next }, 2, 0o600);
    codes = next;
}

function loadCodes(): any[] {
    if (codes) return codes;
    ensureDataDir();
    const raw = readJsonFileStrict(CODES_FILE, () => ({ codes: [] }));
    if (!Array.isArray(raw?.codes)) throw new Error('activation-codes.json 缺少有效的激活码列表');
    const list = raw.codes.map(normalizeRecord);
    if (list.some((record: any) => !record)
        || new Set(list.map((record: any) => record.id)).size !== list.length
        || new Set(list.map((record: any) => record.codeHash)).size !== list.length) {
        throw new Error('activation-codes.json 包含无效或重复的激活码');
    }
    codes = list;
    return codes;
}

function codeStatus(record: any, now = Date.now()): string {
    if (record.redeemedAt || getCodeRedemption(record.id)) return 'redeemed';
    if (record.revokedAt) return 'revoked';
    if (record.redeemBefore && record.redeemBefore <= now) return 'expired';
    return 'unused';
}

function publicCode(record: any): any {
    const redemption = getCodeRedemption(record.id) || record;
    return {
        id: record.id,
        codeHint: record.codeHint,
        type: record.type,
        days: record.days,
        maxAccounts: record.maxAccounts,
        redeemBefore: record.redeemBefore,
        createdAt: record.createdAt,
        createdBy: record.createdBy,
        batchId: record.batchId,
        note: record.note,
        redeemedAt: redemption.redeemedAt,
        redeemedBy: redemption.redeemedBy,
        revokedAt: record.revokedAt,
        status: codeStatus(record),
    };
}

function listCodes(filters: { status?: string; type?: string; batchId?: string } = {}): any[] {
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

function generateCodes(options: {
    count: number;
    days: number;
    type: string;
    maxAccounts: number;
    redeemBefore?: number | null;
    note?: string;
    createdBy?: string;
}): any {
    const count = Math.max(1, Math.min(100, Number.parseInt(options.count as any, 10) || 1));
    const days = Math.max(1, Math.min(3650, Number.parseInt(options.days as any, 10) || 30));
    const type = options.type === 'renew' ? 'renew' : 'new';
    const maxAccounts = Math.max(1, Math.min(100, Number.parseInt(options.maxAccounts as any, 10) || 3));
    const redeemBefore = Number(options.redeemBefore) > 0 ? Number(options.redeemBefore) : null;
    const batchId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const createdBy = String(options.createdBy || 'owner');
    const note = String(options.note || '').slice(0, 200);
    const store = [...loadCodes()];
    const issued: any[] = [];
    const seen = new Set(store.map(record => record.codeHash));

    for (let i = 0; i < count; i++) {
        let normalized = '';
        let hash = '';
        do {
            normalized = randomCode();
            hash = hashCode(normalized);
        } while (seen.has(hash));
        seen.add(hash);
        const record = {
            id: crypto.randomBytes(10).toString('hex'),
            codeHash: hash,
            codeHint: normalized.slice(-4),
            type,
            days,
            maxAccounts,
            redeemBefore,
            createdAt: Date.now(),
            createdBy,
            batchId,
            note,
            redeemedAt: null,
            redeemedBy: null,
            revokedAt: null,
        };
        store.push(record);
        issued.push({
            id: record.id,
            code: formatCode(normalized),
            codeHint: record.codeHint,
            type,
            days,
            maxAccounts,
            redeemBefore,
            batchId,
        });
    }
    saveCodes(store);
    return { ok: true, batchId, codes: issued };
}

function findByRaw(raw: unknown): any | null {
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
    validateCode,
    findByRaw,
    revokeCode,
    revokeBatch,
    stats,
    codeStatus,
};
