export {};

const { randomUUID } = require('node:crypto');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readJsonFileStrict, writeJsonFileAtomic } = require('../services/json-db');
const AUDIT_FILE = getDataFile('admin-audit.json');
const MAX_RECORDS = 2000;

interface AuditEvent {
    id: string;
    at: number;
    actorId: string;
    actor: string;
    action: string;
    tenantId?: string;
    username?: string;
    codeId?: string;
    batchId?: string;
    count?: number;
}

let events: AuditEvent[] | undefined;

function getEvents(): AuditEvent[] {
    if (!events) {
        const saved = readJsonFileStrict(AUDIT_FILE, () => []);
        if (!Array.isArray(saved)) throw new Error('admin-audit.json 格式无效');
        events = saved;
    }
    return events!;
}

function appendAudit(input: Omit<AuditEvent, 'id' | 'at'>): void {
    const next = [{ id: randomUUID(), at: Date.now(), ...input }, ...getEvents().slice(0, MAX_RECORDS - 1)];
    ensureDataDir();
    writeJsonFileAtomic(AUDIT_FILE, next, 2, 0o600);
    events = next;
}

function listAudit(options: { category?: string; search?: string; page?: number }) {
    const keyword = (options.search || '').trim().toLowerCase().slice(0, 200);
    const filtered = getEvents().filter((event) => {
        if (options.category && !event.action.startsWith(`${options.category}.`)) return false;
        return !keyword || [event.actor, event.tenantId, event.username, event.codeId, event.batchId]
            .some(value => value?.toLowerCase().includes(keyword));
    });
    const pageSize = 25;
    const page = Math.max(1, Math.min(Math.ceil(filtered.length / pageSize) || 1, Math.trunc(options.page) || 1));
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
}

module.exports = { appendAudit, listAudit };
