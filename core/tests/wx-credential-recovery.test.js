const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const credentials = require('../dist/models/wx-credentials');
const { createWxCredentialRecovery } = require('../dist/runtime/wx-credential-recovery');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function fixture(t, wxLogin) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wx-recovery-'));
    const previous = process.env.FARM_DATA_DIR;
    process.env.FARM_DATA_DIR = dir;
    let current = { id: '1', ownerId: 'tenant-a', createdAt: 100, platform: 'wx', runEnabled: true, code: 'old-code', codeConsumed: true };
    const initial = { openid: 'wx-user', loginBuffer: 'old-buffer', refreshToken: 'old-refresh', accessToken: 'old-access' };
    credentials.saveWxCredentials(current, initial);
    let running = false;
    let starts = 0;
    let allowed = true;
    const store = {
        getAccountById: id => current && current.id === id ? { ...current } : null,
        addOrUpdateAccount: value => { current = { ...current, ...value, codeConsumed: false, lastRunIssue: null }; },
    };
    const recovery = createWxCredentialRecovery({
        store, credentials, wxLogin, canRun: () => allowed, isRunning: () => running,
        startWorker: () => { running = true; starts++; return true; }, log() {},
    });
    t.after(() => { recovery.stopAll(); if (previous === undefined) delete process.env.FARM_DATA_DIR; else process.env.FARM_DATA_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
    return { recovery, initial, get: () => current, set: value => { current = value; }, setAllowed: value => { allowed = value; }, starts: () => starts };
}

test('one renewal recovers a consumed WeChat code and deduplicates concurrent requests', async t => {
    let renewals = 0;
    const entered = deferred();
    const proceed = deferred();
    const f = fixture(t, {
        async refreshCredentials(old, onRotated) {
            renewals++; entered.resolve(); await proceed.promise;
            const rotated = { ...old, accessToken: 'new-access', refreshToken: 'new-refresh' };
            onRotated(rotated);
            return { ...rotated, loginBuffer: 'new-buffer' };
        },
        async issueCode() { return 'new-code'; },
    });
    const first = f.recovery.recoverNow('1');
    const second = f.recovery.recoverNow('1');
    await entered.promise;
    proceed.resolve();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(renewals, 1);
    assert.equal(f.starts(), 1);
    assert.equal(f.get().code, 'new-code');
    const saved = credentials.readWxCredentials(f.get());
    assert.equal(saved.refreshToken, 'new-refresh');
    assert.equal(saved.loginBuffer, 'new-buffer');
});

test('a newer scan cannot be overwritten by an older in-flight recovery', async t => {
    const waiting = deferred();
    const proceed = deferred();
    const f = fixture(t, {
        async refreshCredentials(old, onRotated) { onRotated({ ...old, refreshToken: 'rotated' }); return { ...old, refreshToken: 'rotated' }; },
        async issueCode() { waiting.resolve(); await proceed.promise; return 'stale-code'; },
    });
    const pending = f.recovery.recoverNow('1');
    await waiting.promise;
    credentials.saveWxCredentials(f.get(), { ...f.initial, refreshToken: 'rescan-refresh', loginBuffer: 'rescan-buffer' });
    proceed.resolve();
    assert.equal(await pending, false);
    assert.equal(f.get().code, 'old-code');
    assert.equal(f.starts(), 0);
    assert.equal(credentials.readWxCredentials(f.get()).refreshToken, 'rescan-refresh');
});

test('rotated token survives a later buffer failure and disabled tenants are not started', async t => {
    const f = fixture(t, {
        async refreshCredentials(old, onRotated) { onRotated({ ...old, refreshToken: 'rotated' }); throw new Error('buffer request failed'); },
        async issueCode() { assert.fail('must not issue a code'); },
    });
    await assert.rejects(f.recovery.recoverNow('1'));
    assert.equal(credentials.readWxCredentials(f.get()).refreshToken, 'rotated');
    f.setAllowed(false);
    assert.equal(await f.recovery.recoverNow('1'), false);
    assert.equal(f.starts(), 0);
});

test('shutdown waits for an in-flight rotated token to be saved', async t => {
    const entered = deferred();
    const proceed = deferred();
    const f = fixture(t, {
        async refreshCredentials(old, onRotated) {
            entered.resolve();
            await proceed.promise;
            onRotated({ ...old, refreshToken: 'shutdown-rotated' });
            assert.fail('shutdown must not start the next credential request');
        },
        async issueCode() { assert.fail('shutdown must not issue a code'); },
    });
    const recovery = f.recovery.recoverNow('1');
    const rejected = assert.rejects(recovery);
    await entered.promise;
    let stopped = false;
    const shutdown = f.recovery.stopAll().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    proceed.resolve();
    await Promise.all([rejected, shutdown]);
    assert.equal(credentials.readWxCredentials(f.get()).refreshToken, 'shutdown-rotated');
    assert.equal(f.starts(), 0);
});
