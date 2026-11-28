const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Exercise the real IPC host with a synthetic gateway: no game credentials or
// external network are needed, but the detach and ownership checks are real.
test('session host transfers only the matching account session after backend restart', async (t) => {
    if (process.platform === 'win32') return t.skip('Unix socket permissions are required');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-host-'));
    const socket = path.join(dir, 'host.sock');
    const preload = path.join(dir, 'gateway-stub.cjs');
    fs.writeFileSync(preload, `
      const Module = require('node:module');
      const { EventEmitter } = require('node:events');
      const original = Module._load;
      class FakeGateway extends EventEmitter {
        postMessage(message) {
          if (!message.id) return;
          setImmediate(() => {
            if (message.op === 'open') this.emit('message', { event: 'online', data: {} });
            this.emit('message', { id: message.id, ok: true, result: { synthetic: true } });
          });
        }
        terminate() { return Promise.resolve(); }
      }
      Module._load = function(id, ...rest) {
        return id === 'node:worker_threads' ? { Worker: FakeGateway } : original.call(this, id, ...rest);
      };
    `);
    const env = { ...process.env, FARM_RUNTIME_DIR: dir, FARM_HOST_DATA_DIR: path.join(dir, 'data'), FARM_SESSION_SOCKET: socket };
    const host = spawn(process.execPath, ['-r', preload, path.resolve(__dirname, '../dist/session/host.js')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    host.stderr.on('data', chunk => { stderr += chunk; });
    const oldEnv = { FARM_RUNTIME_DIR: process.env.FARM_RUNTIME_DIR, FARM_SESSION_SOCKET: process.env.FARM_SESSION_SOCKET, FARM_BACKEND_INSTANCE_ID: process.env.FARM_BACKEND_INSTANCE_ID };
    Object.assign(process.env, { FARM_RUNTIME_DIR: dir, FARM_SESSION_SOCKET: socket });
    t.after(async () => {
        host.kill('SIGTERM');
        await new Promise(resolve => host.exitCode !== null ? resolve() : host.once('exit', resolve));
        for (const [key, value] of Object.entries(oldEnv)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    for (let i = 0; !fs.existsSync(socket) && i < 100; i++) {
        if (host.exitCode !== null) throw new Error(`Host exited: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(fs.existsSync(socket), 'host must expose its local socket');
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    const { SessionClient, accountSessionKey, findAccountSession } = require('../dist/session/ipc');
    const setWriter = id => {
        process.env.FARM_BACKEND_INSTANCE_ID = id;
        fs.writeFileSync(path.join(dir, 'backend-writer.lock'), JSON.stringify({ pid: process.pid, role: 'backend', instanceId: id, nonce: id }));
    };
    const account = { id: '101', createdAt: 123, platform: 'qq' };
    const key = accountSessionKey(account);
    setWriter('backend-one');
    const first = await SessionClient.open('backend');
    const opened = await first.call('openSession', { accountId: account.id, accountKey: key, config: { platform: 'qq', code: 'synthetic-only' } });
    assert.equal(opened.session.lifecycle, 'ONLINE');
    first.close();
    setWriter('backend-two');
    const second = await SessionClient.open('backend');
    const list = (await second.call('listSessions')).sessions;
    assert.equal(findAccountSession(list, account).sessionId, opened.session.sessionId);
    assert.equal(findAccountSession(list, { ...account, createdAt: 124 }), undefined);
    assert.equal(findAccountSession(list, { ...account, platform: 'wx' }), undefined);
    await assert.rejects(second.call('attachSession', { accountId: account.id, accountKey: accountSessionKey({ ...account, createdAt: 124 }), sessionId: opened.session.sessionId }));
    const resumed = await second.call('attachSession', { accountId: account.id, accountKey: key, sessionId: opened.session.sessionId });
    assert.equal(resumed.session.sessionId, opened.session.sessionId);
    assert.equal(resumed.snapshot.synthetic, true);
    // A newly elected backend must also be able to stop a disabled/deleted
    // account even if the previous connection has not yet observed closure.
    setWriter('backend-three');
    const third = await SessionClient.open('backend');
    await third.call('stopAccount', { accountId: account.id, accountKey: 'wrong-account' });
    assert.equal((await third.call('listSessions')).sessions.length, 1);
    await third.call('stopAccount', { accountId: account.id, accountKey: key });
    assert.deepEqual((await third.call('listSessions')).sessions, []);
    third.close();
    second.close();
});
