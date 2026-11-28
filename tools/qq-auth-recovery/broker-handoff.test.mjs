import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Point this at the patched qq-miniapp-auth server module, with its dependencies installed.
const modulePath = process.env.QQ_AUTH_TEST_MODULE;
test('QQ broker hands the client to the next user after authorization, failure, and cancellation', {
  skip: modulePath ? false : 'Set QQ_AUTH_TEST_MODULE to the patched server.js',
}, async t => {
  let phase = 'waiting_qrcode';
  let qr = 0;
  let logoutCount = 0;
  let bridgeResult;
  let polledResult;
  let holdLogout;
  let onLogout;
  const ready = () => phase === 'ready';
  const qrUrl = () => 'https://example.invalid/qr/' + qr;
  const native = createServer(async (request, response) => {
    const send = payload => response.end(JSON.stringify(payload));
    const data = value => send({ code: 0, data: value });
    switch (request.url) {
      case '/webui/auth/login': return data({ Credential: 'test-credential' });
      case '/webui/QQLogin/CheckLoginStatus':
        return data({ loginPhase: phase, isLogin: ready(), isOffline: false, coreReady: ready(),
          qrLoginAccepted: phase === 'initializing', qrcodeurl: qrUrl() });
      case '/webui/QQLogin/RefreshQRcode':
        if (!['waiting_qrcode', 'qrcode_scanned'].includes(phase)) return send({ code: -1 });
        phase = 'waiting_qrcode';
        qr++;
        return data({ qrcodeurl: qrUrl() });
      case '/webui/QQLogin/GetQQLoginInfo': return data({ nickname: 'fixture' });
      case '/bridge/api/miniapp/login/start': return send(bridgeResult);
      case '/bridge/api/miniapp/login/status/test-task': return send(polledResult);
      case '/bridge/api/qq/logout':
        logoutCount++;
        onLogout?.();
        if (holdLogout) await holdLogout;
        phase = 'waiting_qrcode';
        return send({ loggedOut: true });
      default:
        response.writeHead(404);
        return send({});
    }
  });
  async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    return 'http://127.0.0.1:' + server.address().port;
  }
  const upstream = await listen(native);
  process.env.NAPCAT_WEBUI_API_URL = upstream + '/webui';
  process.env.NAPCAT_WEBUI_TOKEN = 'test-webui-token';
  process.env.API_SIGNING_SECRET = 'test-signature';
  process.env.BRIDGE_URL = upstream + '/bridge';
  const broker = await import(pathToFileURL(modulePath).href);
  const base = await listen(broker.createServer());
  async function post(path, body = {}) {
    const response = await fetch(base + '/api/qq/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Signature': 'test-signature' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    return response.json();
  }
  async function open() {
    const result = await post('login/qrcode');
    assert.equal(result.task?.status, 'waiting_scan', result.code);
    return result.task.id;
  }
  const status = taskId => post('login/status', { taskId });
  const authorize = taskId => post('miniapp/code', { taskId, appId: '1234567890' });
  const cancel = taskId => post('logout', { taskId });

  phase = 'ready';
  let releaseOrphan;
  const orphanStarted = new Promise(resolve => { onLogout = resolve; });
  holdLogout = new Promise(resolve => { releaseOrphan = resolve; });
  const recovery = open();
  try {
    await Promise.race([orphanStarted, recovery.then(() => assert.fail('Orphan recovery finished before logout'))]);
    assert.equal((await post('login/qrcode')).code, 'WORKFLOW_BUSY');
  } finally {
    releaseOrphan();
  }
  const recovered = await recovery;
  assert.equal(logoutCount, 1);
  holdLogout = undefined;
  onLogout = undefined;
  assert.equal((await cancel(recovered)).ok, true);

  for (const finalStatus of ['failed', 'login_required', 'cancelled', 'expired']) {
    for (const pending of [false, true]) {
      const id = await open();
      phase = 'ready';
      bridgeResult = pending ? { status: 'pending', taskId: 'test-task' } : { status: finalStatus };
      polledResult = { status: finalStatus };
      const prior = logoutCount;
      const outcome = await authorize(id);
      assert.equal(outcome.ok, false);
      assert.equal(logoutCount, prior + 1, 'A terminal bridge result must release the native account');
      assert.equal(phase, 'waiting_qrcode');
    }
  }

  const id = await open();
  phase = 'qrcode_scanned';
  assert.equal((await status(id)).task.status, 'scanned');
  phase = 'initializing';
  assert.equal((await status(id)).task.status, 'scanned');
  phase = 'ready';
  bridgeResult = { code: 'fixture-code' };
  let finishLogout;
  const logoutStarted = new Promise(resolve => { onLogout = resolve; });
  holdLogout = new Promise(resolve => { finishLogout = resolve; });
  const authorization = authorize(id);
  try {
    await Promise.race([logoutStarted, authorization.then(() => assert.fail('Authorization completed before logout'))]);
    assert.equal((await post('login/qrcode')).code, 'WORKFLOW_BUSY');
  } finally {
    finishLogout();
  }
  assert.equal((await authorization).code, 'fixture-code');
  holdLogout = undefined;
  onLogout = undefined;

  const abandoned = await open();
  phase = 'ready'; // The browser closes before its next status poll.
  assert.equal((await cancel(abandoned)).ok, true);
  assert.equal(phase, 'waiting_qrcode');
  const scanned = await open();
  phase = 'qrcode_scanned';
  assert.equal((await status(scanned)).task.status, 'scanned');
  const countBeforeCancel = logoutCount;
  assert.equal((await cancel(scanned)).ok, true);
  assert.equal(phase, 'waiting_qrcode');
  assert.equal(logoutCount, countBeforeCancel);
  const next = await open();
  const issued = qr;
  assert.equal((await cancel(next)).ok, true);
  assert.ok(qr > issued, 'Cancel must replace the displayed, unscanned QR');
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.workflowBusy, false);
  assert.equal(health.logoutRecoveryRequired, false);
});
