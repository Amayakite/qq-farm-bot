import { createQqLoginClient } from '../qq-login/service';
import { WxLoginService } from '../wx-login/service';
import { ScanProblem } from './coordinator';
import type { ScanPlatform, ScanSession } from './coordinator';

const store = require('../../models/store');
const wxLogin = new WxLoginService();
const WX_APP_ID = 'wx5306c5978fdb76e4';
const WX_QR_TTL_MS = 110_000;

export function assertScanEnabled(platform: ScanPlatform): void {
    const settings = store.getLoginSettings();
    if (platform === 'wx' ? settings?.wechatQrLogin : settings?.qqQrLogin) return;
    throw new ScanProblem(403, 'scan_disabled', platform === 'wx' ? '微信扫码登录未开启' : 'QQ 扫码登录未开启');
}

export async function openScanSession(platform: ScanPlatform): Promise<ScanSession> {
    assertScanEnabled(platform);
    if (platform === 'qq') {
        const client = createQqLoginClient();
        const task = await client.open();
        const expiresAt = task.expiresAt < 1e12 ? task.expiresAt * 1000 : task.expiresAt;
        let loggedOut = false;
        return {
            qrImage: task.qrImage,
            expiresAt: expiresAt || Date.now() + 120_000,
            poll: signal => client.status(task.taskId, signal),
            async authorize() {
                // The QQ provider returns a Code only after its native logout succeeds.
                const credentials = await client.authorize(task.taskId);
                loggedOut = true;
                return credentials;
            },
            async release() {
                if (!loggedOut) await client.release(task.taskId);
            },
        };
    }
    const { session, qr } = await wxLogin.createQrSession();
    return {
        qrImage: `data:image/jpeg;base64,${qr.toString('base64')}`,
        expiresAt: Date.now() + WX_QR_TTL_MS,
        async poll(signal) {
            const status = await wxLogin.poll(session, signal);
            return { status: status === 'waiting' ? 'waiting_scan' : status === 'authorized' ? 'confirmed' : status };
        },
        async authorize() {
            await wxLogin.confirm(session);
            const code = await wxLogin.issueCode(session, WX_APP_ID);
            return { code, nickname: session.nickname };
        },
        async release() {
            wxLogin.destroy(session);
        },
    };
}
