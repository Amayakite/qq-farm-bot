import assert from 'node:assert/strict';
import test from 'node:test';
import { createQrReadiness, logoutConfirmedByWebUi, logoutNapcat } from './readiness.mjs';

const offline = { isLogin: false, loginPhase: 'offline', qrLoginAccepted: false, coreReady: false };
const timeout = () => new Error('二维码刷新超时：QQ 登录服务未返回新的二维码');

test('an already signed-out client clears a stale logout requirement without using the inactive plugin', async () => {
  const reports = [];
  const result = await logoutNapcat({
    async call(path) {
      assert.ok(path.endsWith('CheckLoginStatus'));
      return { ...offline, loginPhase: 'waiting_qrcode' };
    },
    requestLogout: () => assert.fail('The login plugin is disabled while signed out'),
    clearCredential: () => assert.fail('The worker does not need to restart'),
    report: event => reports.push(event),
  });
  assert.equal(result.loggedOut, true);
  assert.deepEqual(reports, ['already_offline']);
});

test('a logout bridge error clears only after a complete offline status arrives', async () => {
  let time = 0;
  let confirmed = true;
  const bridgeError = new Error('The login plugin disconnected');
  const hooks = {
    now: () => time,
    wait: async ms => { time += ms; },
    async call(path) {
      assert.ok(path.endsWith('CheckLoginStatus'));
      if (time === 0) return { ...offline, loginPhase: 'ready', isLogin: true, coreReady: true };
      if (confirmed && time >= 1_000) return offline;
      return { isLogin: false, loginPhase: 'offline' };
    },
    async requestLogout() { throw bridgeError; },
  };
  assert.equal((await logoutNapcat(hooks)).loggedOut, true);
  assert.equal(time, 1_000);
  confirmed = false;
  time = 0;
  await assert.rejects(logoutNapcat(hooks), error => error === bridgeError);
});

test('a successful bridge waits for explicit logout across a slow worker restart', async () => {
  let time = 0;
  let restartedAt;
  let credentialCleared = false;
  const result = await logoutNapcat({
    now: () => time,
    wait: async ms => { time += ms; },
    async call(path) {
      if (path.endsWith('RestartNapCat')) {
        restartedAt = time;
        throw new Error('Socket closed during restart');
      }
      assert.ok(path.endsWith('CheckLoginStatus'));
      if (restartedAt === undefined) return { ...offline, loginPhase: 'ready', isLogin: true, coreReady: true };
      assert.equal(credentialCleared, true);
      if (time - restartedAt < 3_500) throw new Error('WebUI not accepting connections');
      return offline;
    },
    async requestLogout() { return { loggedOut: true, method: 'fixture' }; },
    clearCredential: () => { credentialCleared = true; },
  });
  assert.deepEqual(result, { loggedOut: true, method: 'fixture', workerRestarted: true });
  assert.ok(time - restartedAt >= 3_500);
});

test('prefers the fresh QR from RefreshQRcode and ignores the prior value', async () => {
  const operations = [];
  const reader = createQrReadiness({
    async call(path) {
      operations.push(path);
      if (path.endsWith('CheckLoginStatus')) return { ...offline, qrcodeurl: 'previous' };
      return { qrcodeurl: 'fresh' };
    },
  });
  assert.equal(await reader.open(), 'fresh');
  assert.deepEqual(operations, ['/QQLogin/CheckLoginStatus', '/QQLogin/RefreshQRcode']);
  assert.equal(reader.health().qrReadiness, 'ready');
});

test('restarts a confirmed offline worker once and returns only a proven new QR', async () => {
  let now = 0;
  let restarted = false;
  let credentialsCleared = 0;
  const reports = [];
  const reader = createQrReadiness({
    now: () => now,
    wait: async ms => { now += ms; },
    clearCredential: () => { credentialsCleared++; },
    report: event => reports.push(event),
    async call(path) {
      if (path.endsWith('CheckLoginStatus')) return restarted
        ? { ...offline, loginPhase: 'waiting_qrcode', qrcodeurl: 'startup-qr' } : offline;
      if (path.endsWith('RestartNapCat')) { restarted = true; return {}; }
      if (!restarted) throw timeout();
      return { qrcodeurl: 'fresh-after-recovery' };
    },
  });
  assert.equal(await reader.open(), 'fresh-after-recovery');
  assert.equal(credentialsCleared, 1);
  assert.deepEqual(reports, ['recovery_started', 'recovery_succeeded']);
});

test('retries failed recovery on demand with bounded backoff and resets after a fresh QR', async () => {
  let now = 0;
  let calls = 0;
  let restarts = 0;
  let recreations = 0;
  let working = false;
  const reader = createQrReadiness({
    now: () => now,
    wait: async ms => { now += ms; },
    clearCredential() {},
    async recreate() { recreations++; },
    async call(path) {
      calls++;
      if (path.endsWith('CheckLoginStatus')) return offline;
      if (path.endsWith('RestartNapCat')) { restarts++; return {}; }
      if (!working) throw timeout();
      return { qrcodeurl: 'restored-qr' };
    },
  });
  await assert.rejects(reader.open(), { code: 'QQ_QR_UNAVAILABLE' });
  const prior = calls;
  await assert.rejects(reader.open(), { code: 'QQ_QR_UNAVAILABLE' });
  assert.equal(calls, prior);
  assert.equal(reader.health().qrRetryAfterMs, 15_000);
  assert.equal(reader.health().qrRecoveryRetryAfterMs, 5 * 60_000 - now);
  now += 15_001;
  await assert.rejects(reader.open(), { code: 'QQ_QR_UNAVAILABLE' });
  assert.equal(restarts, 1);
  assert.equal(recreations, 1);
  reader.invalidate();
  await assert.rejects(reader.open(), { code: 'QQ_QR_UNAVAILABLE' });
  assert.equal(restarts, 1);
  for (const [index, delayMinutes] of [15, 45, 60, 60].entries()) {
    now += reader.health().qrRecoveryRetryAfterMs;
    assert.equal(restarts, index + 1);
    const started = now;
    await assert.rejects(reader.open(), { code: 'QQ_QR_UNAVAILABLE' });
    assert.equal(restarts, index + 2);
    assert.equal(recreations, restarts);
    assert.equal(reader.health().qrRecoveryRetryAfterMs, delayMinutes * 60_000 - (now - started));
  }
  now += 15_000;
  working = true;
  assert.equal(await reader.open(), 'restored-qr');
  assert.equal(reader.health().qrRetryAfterMs, 0);
  assert.equal(reader.health().qrRecoveryRetryAfterMs, 0);
  working = false;
  const started = now;
  await assert.rejects(reader.open(), { code: 'QQ_QR_UNAVAILABLE' });
  assert.equal(restarts, 6);
  assert.equal(reader.health().qrRecoveryRetryAfterMs, 5 * 60_000 - (now - started));
});

test('uses container recreation only after worker recovery fails, then verifies a fresh code', async () => {
  let now = 0;
  let restarts = 0;
  let recreations = 0;
  const reader = createQrReadiness({
    now: () => now,
    wait: async ms => { now += ms; },
    clearCredential() {},
    async recreate(id) {
      assert.equal(reader.health().qrReadiness, 'recreating');
      assert.equal(reader.health().qrRecoveryRequest, id);
      assert.equal(restarts, 1);
      recreations++;
    },
    async call(path) {
      if (path.endsWith('CheckLoginStatus')) return offline;
      if (path.endsWith('RestartNapCat')) { restarts++; return {}; }
      if (!recreations) throw timeout();
      return { qrcodeurl: 'fresh-after-container-recreate' };
    },
  });
  assert.equal(await reader.open(), 'fresh-after-container-recreate');
  assert.equal(reader.health().qrRecoveryRequest, undefined);
  assert.equal(recreations, 1);
});

test('fails closed while another login is active or awaiting its confirmation', async () => {
  for (const state of [{ ...offline, loginPhase: 'initializing', qrLoginAccepted: true },
    { ...offline, loginPhase: 'ready', isLogin: true, coreReady: true },
    { ...offline, loginPhase: 'qrcode_scanned' }]) {
    const reader = createQrReadiness({
      async call(path) { assert.ok(path.endsWith('CheckLoginStatus')); return state; },
    });
    await assert.rejects(reader.open(), { code: 'LOGOUT_REQUIRED' });
    assert.equal(logoutConfirmedByWebUi(state), false);
  }
  assert.equal(logoutConfirmedByWebUi(offline), true);
  assert.equal(logoutConfirmedByWebUi({ isLogin: false }), false);
});

test('does not restart on provider restrictions or return a stale QR after a failed refresh', async () => {
  let requestedGetter = false;
  const reader = createQrReadiness({
    async call(path) {
      if (path.endsWith('CheckLoginStatus')) return { ...offline, loginPhase: 'waiting_qrcode', qrcodeurl: 'prior' };
      if (path.endsWith('RefreshQRcode')) throw new Error('Too many requests');
      requestedGetter = true;
      return { qrcodeurl: 'prior' };
    },
  });
  await assert.rejects(reader.open(), { code: 'QQ_QR_UNAVAILABLE' });
  assert.equal(requestedGetter, false);
});
