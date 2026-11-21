import type { LoginSettings } from '../../types/config';
export {};

const axios = require('axios').default;
const store = require('../../models/store');

const QQ_MINIAPP_APP_ID = '1112386029';
const REQUEST_TIMEOUT_MS = 120_000;

export type QqLoginTaskStatus
    = 'waiting_scan'
    | 'scanned'
    | 'confirmed'
    | 'cancelled'
    | 'expired'
    | 'failed';

export interface QqLoginTask {
    taskId: string;
    status: QqLoginTaskStatus;
    qrImage: string;
    expiresAt: number;
}

export interface QqMiniappLoginResult {
    code: string;
    nickname?: string;
}

function loginSettings(): LoginSettings {
    const settings = store.getLoginSettings();
    if (!settings?.qqQrLogin)
        throw new Error('QQ扫码登录未开启');
    if (!settings.napCatEndpoint || !settings.napCatSignature)
        throw new Error('请先配置 NapCat 接口地址和接口签名');
    return settings;
}

function apiUrl(endpoint: string, path: string): string {
    return `${endpoint.replace(/\/+$/, '')}${path}`;
}

function napCatErrorMessage(data: any): string {
    const errorCode = String(data?.code || '').trim().toUpperCase();
    if (/^QRCode Get Error$/i.test(String(data?.error || '').trim()))
        return 'QQ 扫码服务未生成二维码，请稍后刷新';
    if (/\b(?:timeout|timed out)\b/i.test(String(data?.error || '')))
        return 'QQ 扫码服务响应超时，请稍后重试';
    switch (errorCode) {
        case 'SIGNATURE_REQUIRED':
            return 'NapCat 接口签名缺失，请检查配置';
        case 'INVALID_SIGNATURE':
            return 'NapCat 接口签名无效，请检查配置';
        case 'WORKFLOW_BUSY':
            return 'NapCat 登录工作流繁忙，请稍后重试';
        case 'LOGIN_REQUIRED':
            return 'QQ 登录尚未确认，请先完成扫码确认';
        case 'LOGOUT_REQUIRED':
            return '上一位 QQ 登录尚未注销，请稍后重试';
        case 'LOGOUT_FAILED':
            return 'QQ 登录任务注销失败，请稍后重试';
        case 'TASK_EXPIRED':
            return 'QQ 登录任务已过期，请重新获取二维码';
        default:
            return `NapCat 接口返回失败${errorCode ? `（${errorCode}）` : ''}`;
    }
}

function normalizeTask(raw: any): QqLoginTask {
    const task = (raw?.task && typeof raw.task === 'object') ? raw.task : {};
    const taskId = String(task.id || '').trim();
    const status = String(task.status || '').trim() as QqLoginTaskStatus;
    const qrImage = String(task.qrImage || '').trim();
    const expiresAt = Number(task.expiresAt);
    if (!taskId)
        throw new Error('NapCat 返回的登录任务无效');
    return {
        taskId,
        status,
        qrImage,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    };
}

async function requestNapCat(settings: LoginSettings, path: string, body: Record<string, unknown>, requireOk = true, signal?: AbortSignal): Promise<any> {
    let response;
    try {
        response = await axios.post(apiUrl(settings.napCatEndpoint, path), body, {
            timeout: REQUEST_TIMEOUT_MS,
            signal,
            validateStatus: status => status === 200,
            headers: {
                'Content-Type': 'application/json',
                'X-API-Signature': settings.napCatSignature,
            },
        });
    }
    catch (error: any) {
        if (error?.code === 'ECONNABORTED' || error?.message?.includes('timeout'))
            throw new Error('NapCat 接口请求超时，请检查服务状态');
        throw new Error('无法连接 NapCat 接口，请检查地址和服务状态');
    }

    const data = response?.data;
    if (requireOk && (!data || typeof data !== 'object' || data.ok !== true)) {
        throw Object.assign(new Error(napCatErrorMessage(data)), { code: data?.code });
    }
    return data;
}

async function createLoginTask(settings: LoginSettings): Promise<QqLoginTask> {
    const task = normalizeTask(await requestNapCat(settings, '/api/qq/login/qrcode', {}));
    if (!task.qrImage)
        throw new Error('NapCat 未返回新的登录二维码');
    return task;
}

async function queryLoginStatus(taskId: string, settings: LoginSettings, signal?: AbortSignal): Promise<QqLoginTask> {
    const id = String(taskId || '').trim();
    if (!id)
        throw new Error('登录任务 ID 不能为空');
    const data = await requestNapCat(settings, '/api/qq/login/status', {
        taskId: id,
        refresh: false,
    }, false, signal);
    if (data?.ok !== true && !['cancelled', 'expired', 'failed'].includes(data?.task?.status))
        throw new Error(napCatErrorMessage(data));
    return normalizeTask(data);
}

async function getMiniappCode(taskId: string, settings: LoginSettings): Promise<QqMiniappLoginResult> {
    const id = String(taskId || '').trim();
    if (!id)
        throw new Error('登录任务 ID 不能为空');
    const data = await requestNapCat(settings, '/api/qq/miniapp/code', {
        taskId: id,
        appId: QQ_MINIAPP_APP_ID,
    });
    const code = String(data?.code || '').trim();
    if (!code)
        throw new Error('NapCat 未返回小程序授权 Code');
    const nickname = typeof data?.nickname === 'string' ? data.nickname.trim() : '';
    return nickname ? { code, nickname } : { code };
}

async function cancelLoginTask(taskId: string, settings: LoginSettings): Promise<void> {
    const id = String(taskId || '').trim();
    if (!id)
        throw new Error('登录任务 ID 不能为空');
    const data = await requestNapCat(settings, '/api/qq/logout', {
        taskId: id,
    }, false);
    if (data?.ok !== true && data?.code !== 'TASK_EXPIRED')
        throw new Error(napCatErrorMessage(data));
}

function createQqLoginClient() {
    // Every request for a task must reach the instance that issued its QR.
    const settings = { ...loginSettings() };
    return {
        async open() {
            const response = await axios.get(apiUrl(settings.napCatEndpoint, '/api/health'), {
                timeout: 4000,
                validateStatus: status => status === 200 || status === 404 || status === 405,
            }).catch(() => { throw new Error('无法检查 QQ 扫码服务状态'); });
            if (response.data?.workflowBusy === true && response.data?.logoutRecoveryRequired !== true) {
                throw Object.assign(new Error('QQ 扫码通道正在使用'), { code: 'WORKFLOW_BUSY' });
            }
            return createLoginTask(settings);
        },
        status: (id: string, signal?: AbortSignal) => queryLoginStatus(id, settings, signal),
        authorize: (id: string) => getMiniappCode(id, settings),
        release: (id: string) => cancelLoginTask(id, settings),
    };
}

export { createQqLoginClient, QQ_MINIAPP_APP_ID };
