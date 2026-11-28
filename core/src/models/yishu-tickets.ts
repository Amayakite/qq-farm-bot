export {};

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDataDir } = require('../config/runtime-paths');
const { readJsonFileStrict, writeJsonFileAtomic } = require('../services/json-db');
const { getSystemDateKey } = require('../utils/utils');

function normalizeGid(value: unknown): string {
    const gid = String(value ?? '').trim();
    if (!/^[1-9]\d{0,18}$/.test(gid) || BigInt(gid) > 9223372036854775807n) {
        throw Object.assign(new Error('请输入有效的铺主 GID'), { code: 'INVALID_YSHF_SHOP_GID' });
    }
    return gid;
}

function parseTicket(value: unknown): string {
    const text = String(value ?? '').trim();
    if (!text || text.length > 4096) throw Object.assign(new Error('请输入好友分享链接或票据'), { code: 'INVALID_YSHF_TICKET' });
    let decoded = text;
    try { decoded = decodeURIComponent(text); } catch { /* The original text may still contain a ticket. */ }
    const matches = decoded.match(/(?<![a-f\d])(?:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|[a-f\d]{32})(?![a-f\d])/gi) || [];
    const unique = [...new Set(matches.map((match: string) => match.toLowerCase()))];
    if (unique.length !== 1) throw Object.assign(new Error('无法从输入中确定唯一的分享票据'), { code: 'INVALID_YSHF_TICKET' });
    const ticket = unique[0];
    return ticket.length === 32
        ? `${ticket.slice(0, 8)}-${ticket.slice(8, 12)}-${ticket.slice(12, 16)}-${ticket.slice(16, 20)}-${ticket.slice(20)}`
        : ticket;
}

function fileFor(account: any): string {
    if (!account?.id || !account?.ownerId || !Number(account.createdAt)) {
        throw Object.assign(new Error('无法确认账号归属，请刷新后重试'), { code: 'YSHF_ACCOUNT_UNAVAILABLE' });
    }
    const id = crypto.createHash('sha256')
        .update(JSON.stringify([String(account.ownerId), String(account.id), Number(account.createdAt)]))
        .digest('hex');
    return path.join(getDataDir(), 'yishu-share-tickets', id + '.json');
}

function readTickets(account: any): Record<string, { ticket: string; updatedAt: number }> {
    const data = readJsonFileStrict(fileFor(account), () => ({}));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('分享票据数据格式错误');
    return data;
}

function listTickets(account: any): Array<{ gid: string; updatedAt: number; expired: boolean }> {
    const today = getSystemDateKey();
    return Object.entries(readTickets(account)).map(([gid, value]: [string, any]) => ({
        gid, updatedAt: Number(value?.updatedAt) || 0,
        expired: !Number(value?.updatedAt) || getSystemDateKey(Number(value.updatedAt)) !== today,
    }));
}

function saveTicket(account: any, gidInput: unknown, ticketInput: unknown): void {
    const gid = normalizeGid(gidInput);
    const ticket = parseTicket(ticketInput);
    const data = readTickets(account);
    if (!data[gid] && Object.keys(data).length >= 500) throw new Error('分享票据数量已达上限');
    data[gid] = { ticket, updatedAt: Date.now() };
    const dir = path.dirname(fileFor(account));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(fileFor(account), data, 0, 0o600);
}

function removeTicket(account: any, gidInput: unknown): void {
    const gid = normalizeGid(gidInput);
    const data = readTickets(account);
    if (!Object.prototype.hasOwnProperty.call(data, gid)) return;
    delete data[gid];
    writeJsonFileAtomic(fileFor(account), data, 0, 0o600);
}

function ownFile(account: any): string {
    return path.join(getDataDir(), 'yishu-own-share', path.basename(fileFor(account)));
}

function readOwnShare(account: any) {
    const data = readJsonFileStrict(ownFile(account), () => null);
    if (!data) return null;
    const updatedAt = Number(data.updatedAt) || 0;
    if (!updatedAt || getSystemDateKey(updatedAt) !== getSystemDateKey()) return null;
    return { gid: normalizeGid(data.gid), ticket: parseTicket(data.ticket), updatedAt };
}

function saveOwnShare(account: any, gid: unknown, ticket: unknown): void {
    const file = ownFile(account);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(file, { gid: normalizeGid(gid), ticket: parseTicket(ticket), updatedAt: Date.now() }, 0, 0o600);
}

function removeAccountTickets(account: any): void {
    for (const file of [fileFor(account), ownFile(account)]) {
        try { fs.unlinkSync(file); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    }
}

module.exports = { normalizeGid, parseTicket, readTickets, listTickets, saveTicket, removeTicket, readOwnShare, saveOwnShare, removeAccountTickets };
