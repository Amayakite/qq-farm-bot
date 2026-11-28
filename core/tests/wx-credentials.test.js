const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readWxCredentials, saveWxCredentials, removeWxCredentials } = require('../dist/models/wx-credentials');

test('WeChat credentials are encrypted, scoped to account identity, and replaced with compare-and-swap', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wx-creds-'));
    const previous = process.env.FARM_DATA_DIR;
    process.env.FARM_DATA_DIR = dir;
    t.after(() => { if (previous === undefined) delete process.env.FARM_DATA_DIR; else process.env.FARM_DATA_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
    const a = { id: '1', ownerId: 'tenant-a', createdAt: 100, platform: 'wx' };
    const other = { ...a, ownerId: 'tenant-b' };
    const recreated = { ...a, createdAt: 101 };
    const secret = { openid: 'test-openid', loginBuffer: 'test-login-buffer', refreshToken: 'test-refresh-token', accessToken: 'test-access-token' };
    assert.equal(saveWxCredentials(a, secret), true);
    const original = readWxCredentials(a);
    assert.equal(original.refreshToken, secret.refreshToken);
    assert.equal(readWxCredentials(other), null);
    assert.equal(readWxCredentials(recreated), null);
    const file = path.join(dir, 'wx-credentials', fs.readdirSync(path.join(dir, 'wx-credentials'))[0]);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(secret.refreshToken) && !raw.includes(secret.openid));
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.join(dir, 'wx-credential-key')).mode & 0o777, 0o600);
    }
    assert.equal(saveWxCredentials(a, { ...secret, refreshToken: 'new-token' }, original.revision), true);
    assert.equal(saveWxCredentials(a, secret, original.revision), false);
    assert.equal(readWxCredentials(a).refreshToken, 'new-token');
    fs.unlinkSync(path.join(dir, 'wx-credential-key'));
    assert.throws(() => readWxCredentials(a));
    assert.throws(() => saveWxCredentials(other, secret), /密钥缺失/);
    removeWxCredentials(a);
});
