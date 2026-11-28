export {};

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('../config/runtime-paths');
const { writeJsonFileAtomic } = require('../services/json-db');

interface WxCredentials {
    openid: string;
    loginBuffer: string;
    refreshToken: string;
    accessToken: string;
}

function identity(account: any): string {
    if (!account?.id || !account?.ownerId || !Number(account.createdAt) || account.platform !== 'wx') {
        throw new Error('微信账号归属无效');
    }
    return JSON.stringify([String(account.ownerId), String(account.id), Number(account.createdAt)]);
}

function paths(account: any) {
    const dir = path.join(getDataDir(), 'wx-credentials');
    return { dir, key: path.join(getDataDir(), 'wx-credential-key'), file: path.join(dir, crypto.createHash('sha256').update(identity(account)).digest('hex') + '.json') };
}

function keyFor(account: any, create: boolean): Buffer {
    const p = paths(account);
    if (!fs.existsSync(p.key) && create) {
        // Never replace a lost key while encrypted data still exists.
        if (fs.existsSync(p.dir) && fs.readdirSync(p.dir).some((name: string) => name.endsWith('.json'))) {
            throw new Error('微信凭据密钥缺失');
        }
        fs.mkdirSync(path.dirname(p.key), { recursive: true, mode: 0o700 });
        try {
            const fd = fs.openSync(p.key, 'wx', 0o600);
            try { fs.writeFileSync(fd, crypto.randomBytes(32)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        } catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
    }
    const key = fs.readFileSync(p.key);
    if (key.length !== 32) throw new Error('微信凭据密钥无效');
    return key;
}

function readWxCredentials(account: any): (WxCredentials & { revision: string }) | null {
    const p = paths(account);
    if (!fs.existsSync(p.file)) return null;
    const envelope = JSON.parse(fs.readFileSync(p.file, 'utf8'));
    if (envelope?.version !== 1 || typeof envelope.revision !== 'string') throw new Error('微信凭据格式无效');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(account, false), Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(identity(account)));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    const value = JSON.parse(plain.toString('utf8'));
    if (!value || typeof value.openid !== 'string' || !value.openid || typeof value.loginBuffer !== 'string' || !value.loginBuffer
        || typeof value.refreshToken !== 'string' || typeof value.accessToken !== 'string') throw new Error('微信凭据内容无效');
    return { ...value, revision: envelope.revision };
}

function saveWxCredentials(account: any, value: WxCredentials, expectedRevision?: string): boolean {
    if (!value || !value.openid || !value.loginBuffer || !value.refreshToken || !value.accessToken
        || [value.openid, value.loginBuffer, value.refreshToken, value.accessToken].some(v => typeof v !== 'string' || v.length > 65536)) {
        throw new Error('微信凭据不完整');
    }
    const p = paths(account);
    if (expectedRevision !== undefined && readWxCredentials(account)?.revision !== expectedRevision) return false;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(account, true), iv);
    cipher.setAAD(Buffer.from(identity(account)));
    const payload = JSON.stringify({ openid: value.openid, loginBuffer: value.loginBuffer, refreshToken: value.refreshToken, accessToken: value.accessToken });
    const data = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(p.file, { version: 1, revision: crypto.randomUUID(), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }, 0, 0o600);
    return true;
}

function removeWxCredentials(account: any): void {
    try { fs.unlinkSync(paths(account).file); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
}

module.exports = { readWxCredentials, saveWxCredentials, removeWxCredentials };
