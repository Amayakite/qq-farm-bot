import type { Application, Request, Response } from 'express';
import { createScanCoordinator, ScanProblem } from '../../services/account-scan/coordinator';
import type { ScanTarget } from '../../services/account-scan/coordinator';
import { assertScanEnabled, openScanSession } from '../../services/account-scan/providers';
import { requiresNewCode } from '../../types/account';
import type { AdminContext } from './context';
import { activateSavedAccount, persistAndLogAccount } from './account-routes';

const { isOwner, resolveAuthContext } = require('./middleware');
const { hasLegacyWxTask } = require('./wx-login-routes');
const store = require('../../models/store');
const users = require('../../models/user-store');
const { createModuleLogger } = require('../../services/logger');
const logger = createModuleLogger('account-scan');

export function mountAccountScanRoutes(app: Application, ctx: AdminContext): void {
    function checkTarget(target: ScanTarget) {
        const account = target.accountId ? store.getAccountById(target.accountId) : null;
        const { auth } = resolveAuthContext(ctx, target.token);
        if (!auth || auth.user.mustChangePassword) throw new ScanProblem(401, 'scan_session_expired', '面板会话已失效，请重新登录');
        if (!isOwner(auth) && auth.user.id !== target.tenantId) {
            throw new ScanProblem(404, 'scan_account_not_found', '账号不存在或已删除');
        }
        const tenant = users.getUserById(target.tenantId);
        if (!tenant || tenant.status !== 'active' || users.isExpired(tenant)) {
            throw new ScanProblem(403, 'scan_tenant_unavailable', '所属租户已到期或停用');
        }
        if (target.accountId) {
            if (!account || account.ownerId !== target.tenantId) {
                throw new ScanProblem(404, 'scan_account_not_found', '账号不存在或已删除');
            }
            if (account.platform !== target.platform) throw new ScanProblem(409, 'scan_platform_mismatch', '请选择此账号原有的登录平台');
        } else if (tenant.role === 'tenant' && store.getAccountsByOwner(tenant.id).length >= tenant.maxAccounts) {
            throw new ScanProblem(403, 'scan_quota_exceeded', `当前套餐最多只能添加 ${tenant.maxAccounts} 个账号`);
        }
        assertScanEnabled(target.platform);
    }

    const scans = createScanCoordinator({
        open: openScanSession,
        checkTarget,
        save(target, credentials) {
            const account = target.accountId ? store.getAccountById(target.accountId) : null;
            const code = credentials.code.trim();
            if (!code || (code === account?.code && (account.codeConsumed || requiresNewCode(account.lastRunIssue)))) {
                throw new ScanProblem(409, 'relogin_required', '未获得新的登录授权，请重新扫码');
            }
            const name = target.name || account?.name || credentials.nickname?.trim() || (target.platform === 'qq' ? 'QQ 账号' : '微信账号');
            const updating = !!account;
            const payload = { name, code, platform: target.platform, ...(updating ? { id: account.id } : { ownerId: target.tenantId }) };
            const { accountId } = persistAndLogAccount(ctx, payload, { updating, enableHosting: true });
            try { activateSavedAccount(ctx, accountId, updating, true, name); }
            catch { logger.warn('扫码保存成功，托管启动失败', { accountId }); }
            return accountId;
        },
        observe: entry => logger.info('扫码任务状态', entry),
    });
    ctx.scanTasks = scans;

    function respond(res: Response, action: () => unknown) {
        try { res.json({ ok: true, data: action() }); }
        catch (error: unknown) {
            if (error instanceof ScanProblem) {
                return res.status(error.statusCode).json({ ok: false, error: error.message, errorType: error.errorType });
            }
            logger.warn('扫码任务请求失败');
            res.status(500).json({ ok: false, error: '扫码服务暂不可用' });
        }
    }

    app.post('/api/account-scan/tasks', (req: Request, res: Response) => respond(res, () => {
        const { auth, adminToken } = req as any;
        const { platform, accountId, requestId, name } = req.body || {};
        if ((platform !== 'qq' && platform !== 'wx') || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)
            || (accountId !== undefined && (typeof accountId !== 'string' || !accountId || accountId.length > 128))
            || (name !== undefined && (typeof name !== 'string' || name.length > 120))) {
            throw new ScanProblem(400, 'scan_invalid_request', '扫码参数无效');
        }
        const requestedName = String(name || '').trim();
        const fingerprint = JSON.stringify([platform, accountId || '', requestedName]);
        const prior = scans.replay(adminToken, requestId, fingerprint);
        if (prior) return prior;
        const account = accountId ? store.getAccountById(accountId) : null;
        if (accountId && (!account || (!isOwner(auth) && account.ownerId !== auth.user.id))) {
            throw new ScanProblem(404, 'scan_account_not_found', '账号不存在或已删除');
        }
        const tenantId = account?.ownerId || auth.user.id;
        if (platform === 'wx' && hasLegacyWxTask(tenantId)) {
            throw new ScanProblem(409, 'scan_already_active', '当前租户已有微信扫码任务，请先关闭或等待完成');
        }
        return scans.create({ platform, accountId, tenantId, token: adminToken, name: requestedName },
            requestId, fingerprint);
    }));

    app.get('/api/account-scan/tasks/:taskId', (req, res) => respond(res,
        () => scans.status(String(req.params.taskId), (req as any).adminToken)));
    app.delete('/api/account-scan/tasks/:taskId', (req, res) => respond(res,
        () => scans.cancel(String(req.params.taskId), (req as any).adminToken)));
}
