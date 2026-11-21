import assert from 'node:assert/strict';
import test from 'node:test';
import { createQrReadiness, logoutConfirmedByWebUi } from './readiness.mjs';

const offline = { isLogin: false, loginPhase: 'offline', qrLoginAccepted: false, coreReady: false };
const timeout = () => new Error('二维码刷新超时：QQ 登录服务未返回新的二维码');

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

test('an unavailable provider backs off and never loops worker restarts in the same outage', async () => {
  let now = 0;
  let calls = 0;
  let restarts = 0;
  let working = false;
  const reader = createQrReadiness({
    now: () => now,
    wait: async ms => { now += ms; },
    clearCredential() {},
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
  now += 15_001;
  await assert.rejects(reader.open(), { code: 'QQ_QR_UNAVAILABLE' });
  assert.equal(restarts, 1);
  now += 15_001;
  working = true;
  assert.equal(await reader.open(), 'restored-qr');
  assert.equal(reader.health().qrRetryAfterMs, 0);
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
