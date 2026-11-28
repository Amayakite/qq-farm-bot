export {};

const { getDataFile } = require('../config/runtime-paths');
const { readJsonFileStrict, writeJsonFileAtomic } = require('../services/json-db');

function getAnnouncement() {
    const data = readJsonFileStrict(getDataFile('announcement.json'), () => ({ enabled: false, content: '', updatedAt: 0 }));
    if (!data || typeof data !== 'object' || typeof data.content !== 'string' || typeof data.enabled !== 'boolean') {
        throw new Error('公告数据格式错误');
    }
    return { enabled: data.enabled, content: data.content, updatedAt: Number(data.updatedAt) || 0 };
}

function saveAnnouncement(input: any) {
    if (typeof input?.content !== 'string' || input.content.length > 2000 || typeof input?.enabled !== 'boolean') {
        throw Object.assign(new Error('公告最多 2000 字'), { code: 'INVALID_ANNOUNCEMENT' });
    }
    const content = input.content.trim();
    if (input.enabled && !content) throw Object.assign(new Error('请输入公告内容'), { code: 'INVALID_ANNOUNCEMENT' });
    const next = { enabled: input.enabled, content, updatedAt: Date.now() };
    writeJsonFileAtomic(getDataFile('announcement.json'), next, 2, 0o600);
    return next;
}

module.exports = { getAnnouncement, saveAnnouncement };
