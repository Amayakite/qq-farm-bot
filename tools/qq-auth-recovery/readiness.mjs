import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHECK = '/QQLogin/CheckLoginStatus';
const REFRESH = '/QQLogin/RefreshQRcode';
const GET_QR = '/QQLogin/GetQQLoginQrcode';
const RESTART = '/QQLogin/RestartNapCat';
const STARTUP_WAIT_MS = 12_000;
const RETRY_DELAY_MS = 15_000;
const RECOVERY_DELAYS_MS = [5, 15, 45, 60].map(minutes => minutes * 60_000);
const recoverable = new Set(['offline', 'reconnecting', 'generating_qrcode', 'waiting_qrcode']);

export function logoutConfirmedByWebUi(status) {
  return status?.isLogin === false && recoverable.has(status.loginPhase)
    && status.coreReady !== true && status.qrLoginAccepted !== true;
}

function activeLogin(status) {
  return status?.qrLoginAccepted === true || status?.coreReady === true
    || status?.loginPhase === 'initializing' || status?.loginPhase === 'qrcode_scanned'
    || (typeof status?.loginPhase === 'string' && status.isLogin === true);
}

function unavailable() {
  return Object.assign(new Error('QQ login service has not produced a fresh QR code'), { code: 'QQ_QR_UNAVAILABLE' });
}

function blocked() {
  return Object.assign(new Error('The previous QQ login is still active'), { code: 'LOGOUT_REQUIRED' });
}

function qrFrom(value) {
  if (typeof value === 'string') return value.trim();
  const qr = value?.qrcodeurl ?? value?.qrcode ?? value?.qrCode ?? value?.qrUrl ?? value?.qr_url
    ?? value?.image ?? value?.imageUrl ?? value?.image_url ?? value?.base64;
  return typeof qr === 'string' ? qr.trim() : '';
}

export function requestNapcatRecreate(directory) {
  if (!directory) return undefined;
  return async id => {
    const staging = path.join(directory, id + '.tmp');
    await writeFile(staging, JSON.stringify({ id, at: Date.now() }), { mode: 0o600, flag: 'wx' });
    await rename(staging, path.join(directory, 'request.json'));
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const result = await readFile(path.join(directory, 'response.json'), 'utf8').then(text => JSON.parse(text)).catch(() => null);
      if (result?.id === id) {
        if (result.ok === true) return;
        throw unavailable();
      }
      await sleep(500);
    }
    throw unavailable();
  };
}

export function createQrReadiness({ call, clearCredential, recreate, report = () => {}, now = Date.now, wait = sleep }) {
  let state = 'unknown';
  let retryAfter = 0;
  let recoverAfter = 0;
  let recoveryBackoffIndex = 0;
  let recoveryRequest;

  async function fresh() {
    const current = await call(CHECK);
    if (activeLogin(current)) throw blocked();
    const answer = await call(REFRESH);
    if (answer?.restarting === true) throw unavailable();
    const qr = qrFrom(answer) || qrFrom(await call(GET_QR));
    if (!qr || (typeof current?.loginPhase === 'string' && qr === qrFrom(current))) throw unavailable();
    return qr;
  }

  function succeeded(qr) {
    state = 'ready';
    retryAfter = 0;
    recoverAfter = 0;
    recoveryBackoffIndex = 0;
    return qr;
  }

  async function awaitRestart() {
    const deadline = now() + STARTUP_WAIT_MS;
    while (now() < deadline) {
      await wait(500);
      const current = await call(CHECK).catch(() => null);
      if (activeLogin(current)) throw blocked();
      if (logoutConfirmedByWebUi(current) && current.loginPhase === 'waiting_qrcode' && qrFrom(current)) return;
    }
    // Some clients do not create a QR until the refresh command runs.
  }

  async function recoverContainer() {
    if (!recreate) return undefined;
    const current = await call(CHECK).catch(() => null);
    if (activeLogin(current)) throw blocked();
    if (!logoutConfirmedByWebUi(current)) return undefined;
    recoveryRequest = randomUUID();
    state = 'recreating';
    report('recreate_started');
    try {
      await recreate(recoveryRequest);
      clearCredential();
      await awaitRestart();
      const qr = await fresh();
      report('recreate_succeeded');
      return qr;
    } catch (error) {
      report('recreate_unavailable');
      if (error?.code === 'LOGOUT_REQUIRED') throw error;
    } finally {
      recoveryRequest = undefined;
    }
  }

  return {
    health() {
      const currentTime = now();
      return {
        qrReadiness: state,
        qrRetryAfterMs: Math.max(0, retryAfter - currentTime),
        qrRecoveryRetryAfterMs: Math.max(0, recoverAfter - currentTime),
        qrRecoveryRequest: recoveryRequest,
      };
    },
    invalidate() { state = 'unknown'; retryAfter = 0; },
    async open() {
      if (retryAfter > now()) throw unavailable();
      let failure;
      try { return succeeded(await fresh()); }
      catch (error) {
        if (error?.code === 'LOGOUT_REQUIRED') throw error;
        failure = error;
      }

      const current = await call(CHECK).catch(() => null);
      if (activeLogin(current)) throw blocked();
      const refreshFailed = failure?.code === 'QQ_QR_UNAVAILABLE'
        || /二维码刷新超时|未接受二维码刷新请求|QQ_LOGIN_SERVICE_RESTARTING|QRCode Get Error/i.test(failure?.message || '');
      if (now() >= recoverAfter && refreshFailed && logoutConfirmedByWebUi(current)) {
        // Allow another recovery on demand after backoff, even if no fresh QR has succeeded yet.
        recoverAfter = now() + RECOVERY_DELAYS_MS[recoveryBackoffIndex];
        recoveryBackoffIndex = Math.min(recoveryBackoffIndex + 1, RECOVERY_DELAYS_MS.length - 1);
        state = 'recovering';
        report('recovery_started');
        try {
          await call(RESTART);
          clearCredential();
          await awaitRestart();
          const qr = succeeded(await fresh());
          report('recovery_succeeded');
          return qr;
        } catch (error) {
          report('recovery_unavailable');
          if (error?.code === 'LOGOUT_REQUIRED') throw error;
        }
        const qr = await recoverContainer();
        if (qr) return succeeded(qr);
      }
      state = 'unavailable';
      retryAfter = now() + RETRY_DELAY_MS;
      throw unavailable();
    }
  };
}
