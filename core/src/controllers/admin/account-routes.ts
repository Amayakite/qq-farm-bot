import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
import { requiresNewCode } from '../../types/account';
export {};

/**
 * Account CRUD routes, account-logs, logs, and settings routes.
 */

const store = require('../../models/store');
const { addOrUpdateAccount, deleteAccount } = store;
const userStore = require('../../models/user-store');
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig, getDevicePresets, getTimeZoneOptions } = require('../../config/config');
const { emitLogsAfterClear } = require('./socket');

const {
    getAccId,
    getAccountIds,
    handleApiError,
    getAccountList,
    resolveAccId,
    filterAccountsForAuth,
    isOwner,
    requireOwner,
} = require('./middleware');

function accountResponse(data: any, auth: any): any {
    const accounts = filterAccountsForAuth(data?.accounts, auth)
        .map(({ code: _code, codeConsumed: _codeConsumed, ...account }: any) => account);
    return isOwner(auth) ? { accounts, nextId: data.nextId } : { accounts };
}

export function persistAndLogAccount(ctx: AdminContext, payload: any, options: { updating: boolean; enableHosting: boolean; remarkRelogin?: boolean }) {
    const data = addOrUpdateAccount(payload, { enableHosting: options.enableHosting });
    const accountId = String(options.updating ? payload.id : data.accounts.at(-1)?.id || '');
    const name = payload.name || accountId;
    try {
        ctx.provider.addAccountLog?.(options.updating ? 'update' : 'add',
            options.remarkRelogin ? `通过备注重新登录账号: ${name}` : options.updating ? `更新账号: ${name}` : `添加账号: ${name}`,
            accountId, payload.name || '');
    } catch { /* The account is already saved even if a log subscriber failed. */ }
    return { data, accountId };
}

export function activateSavedAccount(ctx: AdminContext, accountId: string, updating: boolean, hosting: boolean, name: string) {
    if (hosting && updating) ctx.provider.restartAccount(accountId);
    else if (hosting) ctx.provider.startAccount(accountId);
    else if (updating) ctx.provider.setRuntimeAccountName?.(accountId, name);
}

function mountAccountRoutes(app: Application, ctx: AdminContext): void {

    // API: 账号管理
    app.get('/api/accounts', (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const data = isOwner(auth) ? ctx.provider.getAccounts() : { accounts: getAccountList(ctx, auth) };
            res.json({
                ok: true,
                data: accountResponse(data, auth),
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 更新账号备注（兼容旧接口）
    app.post('/api/account/remark', (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const auth = (req as any).auth;
            const accountId = resolveAccId(ctx, rawRef, auth);
            if (!accountId) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }

            const remark = String(body.remark !== undefined ? body.remark : body.name || '').trim();
            if (!remark) {
                return res.status(400).json({ ok: false, error: 'Missing remark' });
            }

            const data = addOrUpdateAccount({ id: accountId, name: remark });
            if (ctx.provider && typeof ctx.provider.setRuntimeAccountName === 'function') {
                ctx.provider.setRuntimeAccountName(accountId, remark);
            }
            if (ctx.provider && ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('update', `更新账号备注: ${remark}`, accountId, remark);
            }
            res.json({ ok: true, data: accountResponse(data, auth) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/accounts', (req: Request, res: Response) => {
        try {
            const rawBody = (req.body && typeof req.body === 'object') ? req.body : {};
            const requestedName = typeof rawBody.name === 'string' ? rawBody.name.trim() : '';
            const body = typeof rawBody.name === 'string' ? { ...rawBody, name: requestedName } : rawBody;
            if (!requestedName) {
                return res.status(400).json({ ok: false, error: '账号备注不能为空' });
            }
            const auth = (req as any).auth;
            const owner = isOwner(auth);
            const visibleAccounts = getAccountList(ctx, auth);
            const requestedOwnerId = owner ? String(body.ownerId || userStore.OWNER_ID) : auth.user.id;
            const remarkMatchedAccount = !body.id && requestedName
                ? visibleAccounts.find((account: any) => account.ownerId === requestedOwnerId && String(account.name || '').trim() === requestedName)
                : null;
            const isRemarkRelogin = !!remarkMatchedAccount;
            const updateRef = body.id || (remarkMatchedAccount && remarkMatchedAccount.id) || '';
            const isUpdate = !!updateRef;

            const resolvedUpdateId = isUpdate ? resolveAccId(ctx, updateRef, auth) : '';
            if (isUpdate && !resolvedUpdateId) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }

            const payload: any = isUpdate ? { ...body, id: resolvedUpdateId } : { ...body };
            const existing = isUpdate ? visibleAccounts.find((account: any) => String(account.id) === resolvedUpdateId) : null;
            const suppliedCode = typeof payload.code === 'string' && !!payload.code.trim();
            if (suppliedCode) payload.code = payload.code.trim();
            if (suppliedCode && payload.code === existing?.code && (existing.codeConsumed || requiresNewCode(existing.lastRunIssue))) {
                return res.status(409).json({ ok: false, error: '请提供新的登录 Code 或重新扫码', errorType: 'relogin_required' });
            }
            delete payload.ownerId;
            if (!isUpdate) {
                const user = userStore.getUserById(requestedOwnerId);
                if (!user || user.status !== 'active' || userStore.isExpired(user)) {
                    return res.status(400).json({ ok: false, error: '目标用户不存在或不可用' });
                }
                const accountCount = visibleAccounts.filter((account: any) => account.ownerId === requestedOwnerId).length;
                if (user.role === 'tenant' && accountCount >= user.maxAccounts) {
                    return res.status(403).json({
                        ok: false,
                        error: `当前套餐最多只能添加 ${user.maxAccounts} 个账号`,
                        errorType: 'quota_exceeded',
                    });
                }
                payload.ownerId = requestedOwnerId;
            }

            const enableHosting = suppliedCode && (!isUpdate || (existing && userStore.canRunAccounts(existing.ownerId)));
            const { data, accountId } = persistAndLogAccount(ctx, payload, { updating: isUpdate, enableHosting, remarkRelogin: isRemarkRelogin });
            activateSavedAccount(ctx, accountId, isUpdate, enableHosting, payload.name);
            res.json({
                ok: true,
                data: accountResponse(data, auth),
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/accounts/:id', (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const before = getAccountList(ctx, auth);
            const resolvedId = resolveAccId(ctx, req.params.id, auth);
            const target = before.find((account: any) => String(account.id) === resolvedId);
            if (!resolvedId || !target) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }

            ctx.provider.stopAccount(resolvedId);
            if (typeof ctx.provider.clearLogs === 'function') ctx.provider.clearLogs(resolvedId);
            if (typeof ctx.provider.clearAccountLogs === 'function') ctx.provider.clearAccountLogs(resolvedId);
            const data = deleteAccount(resolvedId);
            ctx.scanTasks?.cancelAccount(resolvedId);
            if (ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('delete', `删除账号: ${(target && target.name) || req.params.id}`, resolvedId, target ? target.name : '');
            }
            res.json({ ok: true, data: accountResponse(data, auth) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 账号日志
    app.get('/api/account-logs', (req: Request, res: Response) => {
        try {
            const limit = Math.max(1, Math.min(1000, Number.parseInt(req.query.limit as string) || 100));
            let list: any[] = ctx.provider.getAccountLogs ? ctx.provider.getAccountLogs(Math.max(limit, 300)) : [];
            if (!Array.isArray(list)) list = [];
            if (!isOwner((req as any).auth)) {
                const allowed = new Set(getAccountIds(ctx, (req as any).auth));
                list = list.filter((entry: any) => allowed.has(String(entry?.accountId || ''))).slice(0, limit);
            } else {
                list = list.slice(0, limit);
            }

            // 与当前 web 前端保持一致：直接返回数组
            res.json(list);
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 日志
    app.get('/api/logs', (req: Request, res: Response) => {
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();
        const rawRef = queryAccountIdRaw || req.headers['x-account-id'];
        const id = rawRef === 'all' ? '' : resolveAccId(ctx, rawRef, (req as any).auth);
        if (rawRef && rawRef !== 'all' && !id) {
            return res.status(403).json({ ok: false, error: '无权访问该账号', errorType: 'forbidden_account' });
        }
        const options = {
            limit: Math.max(1, Math.min(1000, Number.parseInt(req.query.limit as string) || 100)),
            tag: req.query.tag || '',
            module: req.query.module || '',
            event: req.query.event || '',
            keyword: req.query.keyword || '',
            isWarn: req.query.isWarn,
            timeFrom: req.query.timeFrom || '',
            timeTo: req.query.timeTo || '',
        };
        // 如果没有指定账号ID，获取当前用户可见账号的日志
        if (!id) {
            const accountIds = getAccountIds(ctx, (req as any).auth);
            if (typeof ctx.provider.getLogsForAccounts === 'function') {
                return res.json({ ok: true, data: ctx.provider.getLogsForAccounts(accountIds, options) });
            }
            const allLogs: any[] = [];

            for (const accId of accountIds) {
                const logs = ctx.provider.getLogs(accId, options);
                if (Array.isArray(logs)) {
                    allLogs.push(...logs);
                }
            }

            // 按时间排序并限制数量
            allLogs.sort((a: any, b: any) => (b.ts || 0) - (a.ts || 0));
            const limitedLogs = allLogs.slice(0, options.limit);

            return res.json({ ok: true, data: limitedLogs });
        }

        // 指定了账号ID且通过权限检查，返回该账号的日志
        const list = ctx.provider.getLogs(id, options);
        res.json({ ok: true, data: list });
    });

    // API: 清空当前账号运行日志
    app.delete('/api/logs', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = ctx.provider.clearLogs(id);

            emitLogsAfterClear(ctx, id);

            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 设置页统一保存（单次写入；运行中账号等待 worker revision ACK）
    app.post('/api/settings/save', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        try {
            const data = await ctx.provider.saveSettings(id, req.body || {});
            const unconfirmed = data && data.status === 'unconfirmed';
            res.status(unconfirmed ? 202 : 200).json({
                ok: !unconfirmed,
                saved: !!(data && data.saved),
                stopped: !!(data && data.status === 'stopped'),
                confirmed: !!(data && data.confirmed),
                unconfirmed: !!unconfirmed,
                status: data?.status,
                code: unconfirmed ? data.confirmationError?.code : undefined,
                error: unconfirmed ? (data.confirmationError?.message || '配置已保存，但 worker 尚未确认应用') : undefined,
                data: data || {},
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 设置面板主题
    app.post('/api/settings/theme', requireOwner, async (req: Request, res: Response) => {
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await ctx.provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 全局品牌色（owner 统一调整所有用户的主色）
    app.post('/api/settings/appearance', requireOwner, (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            if (typeof body.brandColor !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(body.brandColor.trim())) {
                return res.status(400).json({ ok: false, error: '请输入有效的 Hex 颜色' });
            }
            const data = store.setUIBrand({
                brandColor: body.brandColor,
                brandPreset: body.brandPreset,
            });
            if (ctx.io) {
                ctx.io.emit('appearance:update', {
                    brandColor: data.brandColor,
                    brandPreset: data.brandPreset,
                });
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 保存下线提醒配置
    app.post('/api/settings/offline-reminder', requireOwner, async (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const channel = String(body.channel || '').trim().toLowerCase();
            if (channel === 'dingtalk') {
                try {
                    const { buildDingTalkWebhook } = require('../../services/push');
                    buildDingTalkWebhook(body.endpoint, body.token, body.secret);
                } catch (error: any) {
                    return res.status(400).json({ ok: false, error: error?.message || '钉钉 Webhook 地址格式无效' });
                }
            }
            const data = store.setOfflineReminder ? store.setOfflineReminder(body) : {};
            res.json({ ok: true, data: data || {} });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 测试下线提醒推送（不落盘）
    app.post('/api/settings/offline-reminder/test', requireOwner, async (req: Request, res: Response) => {
        try {
            const saved = store.getOfflineReminder ? store.getOfflineReminder() : {};
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const cfg = { ...(saved || {}), ...body };

            const channel = String(cfg.channel || '').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const token = String(cfg.token || '').trim();
            const secret = String(cfg.secret || '').trim();
            const titleBase = String(cfg.title || '账号下线提醒').trim();
            const msgBase = String(cfg.msg || '账号下线').trim();

            if (!channel) {
                return res.status(400).json({ ok: false, error: '推送渠道不能为空' });
            }
            if (channel === 'webhook' && !endpoint) {
                return res.status(400).json({ ok: false, error: 'Webhook 渠道需要填写接口地址' });
            }
            if (channel === 'dingtalk' && !endpoint && !token) {
                return res.status(400).json({ ok: false, error: '钉钉渠道需要填写 Webhook 地址' });
            }
            if (channel !== 'webhook' && channel !== 'dingtalk' && !token) {
                return res.status(400).json({ ok: false, error: '当前推送渠道需要填写 Token' });
            }

            const now = new Date();
            const ts = now.toISOString().replace('T', ' ').slice(0, 19);
            const { sendPushooMessage } = require('../../services/push');
            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                secret,
                title: `${titleBase}（测试）`,
                content: `${msgBase}\n\n这是一条下线提醒测试消息。\n时间: ${ts}`,
            });

            if (!ret) {
                return res.status(400).json({ ok: false, error: '推送失败：无返回结果' });
            }

            const isSuccess = ret.ok ||
                ret.code === 'ok' ||
                ret.code === '0' ||
                String(ret.msg || '').includes('成功') ||
                String(ret.raw?.status || '').toLowerCase() === 'success';

            if (!isSuccess && ret.msg && !String(ret.msg).includes('成功')) {
                return res.status(400).json({ ok: false, error: ret.msg || '推送失败', data: ret });
            }
            return res.json({ ok: true, data: ret, message: ret.msg || '推送成功' });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // API: 获取配置
    app.get('/api/settings', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            // 直接从主进程的 store 读取，确保即使账号未运行也能获取配置
            const intervals = id ? store.getIntervals(id) : {};
            const strategy = id ? store.getPlantingStrategy(id) : null;
            const preferredSeed = id ? store.getPreferredSeed(id) : null;
            const friendQuietHours = id ? store.getFriendQuietHours(id) : null;
            const automation = id ? store.getAutomation(id) : {};
            const stealDelaySeconds = id && (typeof store.getStealDelaySeconds === 'function') ? store.getStealDelaySeconds(id) : 0;
            const plantOrderRandom = id && (typeof store.getPlantOrderRandom === 'function') ? store.getPlantOrderRandom(id) : false;
            const plantDelaySeconds = id && (typeof store.getPlantDelaySeconds === 'function') ? store.getPlantDelaySeconds(id) : 0;
            const fertilizerBuyOrganicCount = id && (typeof store.getFertilizerBuyOrganicCount === 'function') ? store.getFertilizerBuyOrganicCount(id) : 0;
            const fertilizerBuyOrganicThresholdHours = id && (typeof store.getFertilizerBuyOrganicThresholdHours === 'function') ? store.getFertilizerBuyOrganicThresholdHours(id) : 10;
            const fertilizerBuyNormalCount = id && (typeof store.getFertilizerBuyNormalCount === 'function') ? store.getFertilizerBuyNormalCount(id) : 0;
            const fertilizerBuyNormalThresholdHours = id && (typeof store.getFertilizerBuyNormalThresholdHours === 'function') ? store.getFertilizerBuyNormalThresholdHours(id) : 10;
            const fertilizerBuyCheckIntervalMinutes = id && (typeof store.getFertilizerBuyCheckIntervalMinutes === 'function') ? store.getFertilizerBuyCheckIntervalMinutes(id) : 30;
            const bagSeedPriority = id && (typeof store.getBagSeedPriority === 'function') ? store.getBagSeedPriority(id) : [];
            const bagSeedMultiLandReservationEnabled = id && (typeof store.getBagSeedMultiLandReservationEnabled === 'function') ? store.getBagSeedMultiLandReservationEnabled(id) : false;
            const bagSeedLandTypes = id && (typeof store.getBagSeedLandTypes === 'function') ? store.getBagSeedLandTypes(id) : {};
            const bagSeedFallbackStrategy = id && (typeof store.getBagSeedFallbackStrategy === 'function') ? store.getBagSeedFallbackStrategy(id) : 'level';
            const autoAcceptFriendMinLevel = id && (typeof store.getAutoAcceptFriendMinLevel === 'function') ? store.getAutoAcceptFriendMinLevel(id) : 0;
            const autoAcceptRequireOwnLevel = id && (typeof store.getAutoAcceptRequireOwnLevel === 'function') ? store.getAutoAcceptRequireOwnLevel(id) : false;
            const autoAcceptHarvestStealEnabled = id && (typeof store.getAutoAcceptHarvestStealEnabled === 'function') ? store.getAutoAcceptHarvestStealEnabled(id) : true;
            const autoAcceptHarvestStealHarvest = id && (typeof store.getAutoAcceptHarvestStealHarvest === 'function') ? store.getAutoAcceptHarvestStealHarvest(id) : 8;
            const autoAcceptHarvestStealSteal = id && (typeof store.getAutoAcceptHarvestStealSteal === 'function') ? store.getAutoAcceptHarvestStealSteal(id) : 1;
            const ui = store.getUI();
            const offlineReminder = isOwner((req as any).auth) && store.getOfflineReminder
                ? store.getOfflineReminder()
                : { channel: 'webhook', endpoint: '', token: '', secret: '', title: '账号下线提醒', msg: '账号下线', offlineDeleteSec: 0 };
            res.json({ ok: true, data: { intervals, strategy, preferredSeed, friendQuietHours, automation, stealDelaySeconds, plantOrderRandom, plantDelaySeconds, fertilizerBuyOrganicCount, fertilizerBuyOrganicThresholdHours, fertilizerBuyNormalCount, fertilizerBuyNormalThresholdHours, fertilizerBuyCheckIntervalMinutes, bagSeedPriority, bagSeedMultiLandReservationEnabled, bagSeedLandTypes, bagSeedFallbackStrategy, autoAcceptFriendMinLevel, autoAcceptRequireOwnLevel, autoAcceptHarvestStealEnabled, autoAcceptHarvestStealHarvest, autoAcceptHarvestStealSteal, ui, offlineReminder } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 获取默认配置
    app.get('/api/settings/default', (_req: Request, res: Response) => {
        try {
            const defaultConfig = store.getDefaultAccountConfig ? store.getDefaultAccountConfig() : null;
            if (!defaultConfig) {
                return res.status(500).json({ ok: false, error: '无法获取默认配置' });
            }
            res.json({ ok: true, data: defaultConfig });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/device-presets', (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: getDevicePresets() });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/system-config', requireOwner, (_req: Request, res: Response) => {
        try {
            res.json({
                ok: true,
                data: {
                    saved: store.getSystemConfig(),
                    default: getDefaultSystemConfig(),
                    current: getRuntimeConfig(),
                    timeZones: getTimeZoneOptions(),
                    loginSettings: store.getLoginSettings
                        ? store.getLoginSettings()
                        : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' },
                },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/login-config', (req: Request, res: Response) => {
        try {
            const loginSettings = store.getLoginSettings
                ? store.getLoginSettings()
                : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' };
            if (!isOwner((req as any).auth)) {
                // 租户只需要知道哪些登录方式可用，NapCat 地址和签名属于管理员配置。
                return res.json({
                    ok: true,
                    data: {
                        wechatQrLogin: loginSettings.wechatQrLogin,
                        qqQrLogin: loginSettings.qqQrLogin,
                        napCatEndpoint: '',
                        napCatSignature: '',
                    },
                });
            }
            res.json({ ok: true, data: loginSettings });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/login-config', requireOwner, (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const loginSettings = store.setLoginSettings
                ? store.setLoginSettings({
                    wechatQrLogin: body.wechatQrLogin,
                    qqQrLogin: body.qqQrLogin,
                    napCatEndpoint: body.napCatEndpoint,
                    napCatSignature: body.napCatSignature,
                })
                : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' };
            res.json({ ok: true, data: loginSettings });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/system-config', requireOwner, (req: Request, res: Response) => {
        try {
            const { serverUrl, clientVersion, wxClientVersion, platform, os, timeZone, deviceInfo } = req.body || {};
            const saved = store.setSystemConfig({ serverUrl, clientVersion, wxClientVersion, platform, os, timeZone, deviceInfo });
            updateRuntimeConfig(saved);
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig('');
            }
            // Keep live sessions intact. A new login must use a fresh one-time Code.
            res.json({ ok: true, data: { saved, current: getRuntimeConfig() } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/system-config/reset', requireOwner, (_req: Request, res: Response) => {
        try {
            const saved = getDefaultSystemConfig();
            store.setSystemConfig(saved);
            updateRuntimeConfig(saved);
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig('');
            }
            // Keep live sessions intact. A new login must use a fresh one-time Code.
            res.json({ ok: true, data: { saved, current: getRuntimeConfig() } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });
}

module.exports = { mountAccountRoutes, persistAndLogAccount, activateSavedAccount };
