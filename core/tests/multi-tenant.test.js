const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function load(file, overrides = {}, globals = {}) {
    const filename = path.resolve(__dirname, '../dist', file);
    const realRequire = require('node:module').createRequire(filename);
    const sandbox = {
        require: name => overrides[name] || realRequire(name),
        module: { exports: {} },
        exports: {},
        Buffer,
        __dirname: path.dirname(filename),
        process,
        console,
        setTimeout,
        clearTimeout,
        ...globals,
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return sandbox.module.exports;
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-tenant-'));
}

function runtimePaths(dir) {
    return {
        getDataFile: name => path.join(dir, name),
        ensureDataDir: () => fs.mkdirSync(dir, { recursive: true }),
    };
}

function loadSecurity(dir) {
    return load('models/auth-security.js', { '../config/runtime-paths': runtimePaths(dir) });
}

function loadUserStore(dir, overrides = {}) {
    return load('models/user-store.js', {
        '../config/runtime-paths': runtimePaths(dir),
        './auth-security': loadSecurity(dir),
        ...overrides,
    });
}

function loadCodeStore(dir, users = loadUserStore(dir)) {
    return load('models/activation-code-store.js', {
        '../config/runtime-paths': runtimePaths(dir),
        './user-store': users,
    });
}

test('首次启动为 owner 生成私有的初始密码', () => {
    const dir = tempDir();
    const users = loadUserStore(dir);
    const owner = users.getOwner();
    assert.equal(owner.username, 'admin');
    assert.equal(owner.role, 'owner');
    assert.equal(owner.mustChangePassword, true);
    const bootstrap = path.join(dir, 'owner-bootstrap-password.txt');
    const password = fs.readFileSync(bootstrap, 'utf8').trim();
    assert.equal(users.validateCredentials('admin', 'admin', '127.0.0.1').ok, false);
    assert.equal(users.validateCredentials('admin', password, '127.0.0.1').ok, true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(bootstrap).mode & 0o777, 0o600);
    assert.equal(users.changePassword(owner.id, password, 'owner-new-Password7').ok, true);
    assert.equal(fs.existsSync(bootstrap), false);
});

test('从旧 admin.json 迁移 owner 凭据', () => {
    const dir = tempDir();
    const security = loadSecurity(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'admin.json'), JSON.stringify({
        admin: {
            username: 'root',
            password: security.hashPassword('secret123'),
            createdAt: 123,
            mustChangePassword: false,
        },
    }));
    const users = loadUserStore(dir);
    const owner = users.getOwner();
    assert.equal(owner.username, 'root');
    assert.equal(users.validateCredentials('root', 'secret123', '127.0.0.1').ok, true);
});

test('租户到期拒绝登录，但允许续费后恢复', () => {
    const dir = tempDir();
    const users = loadUserStore(dir);
    const active = users.createTenant({
        username: 'friend_active',
        password: 'abc12345',
        expiresAt: Date.now() + 60_000,
        maxAccounts: 2,
    });
    assert.equal(active.ok, true);
    assert.equal(users.validateCredentials('friend_active', 'abc12345', '127.0.0.1').ok, true);

    const expired = users.createTenant({
        username: 'friend_expired',
        password: 'abc12345',
        expiresAt: Date.now() + 60_000,
        maxAccounts: 2,
    });
    assert.equal(expired.ok, true);
    users.updateTenant(expired.user.id, { expiresAt: Date.now() - 1 });
    const rejected = users.validateCredentials('friend_expired', 'abc12345', '127.0.0.1');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'expired');
    assert.equal(users.findTenantForRenewal('friend_expired', 'abc12345', '127.0.0.1').ok, true);

    const extended = users.extendTenant(expired.user.id, 7);
    assert.equal(extended.ok, true);
    assert.ok(extended.user.expiresAt > Date.now());
    assert.equal(users.validateCredentials('friend_expired', 'abc12345', '127.0.0.1').ok, true);

    assert.equal(users.updateTenant(expired.user.id, { maxAccounts: 0 }).ok, false);
    assert.equal(users.updateTenant(expired.user.id, { maxAccounts: 5 }).ok, true);
});

test('停用租户立即拒绝登录且不能续费', () => {
    const dir = tempDir();
    const users = loadUserStore(dir);
    const created = users.createTenant({
        username: 'friend_disabled',
        password: 'abc12345',
        expiresAt: Date.now() + 60_000,
        maxAccounts: 2,
    });
    users.updateTenant(created.user.id, { status: 'disabled' });
    const result = users.validateCredentials('friend_disabled', 'abc12345', '127.0.0.1');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'disabled');
    assert.equal(users.extendTenant(created.user.id, 7).user.status, 'disabled');
    assert.equal(users.canRunAccounts(created.user.id), false);
    assert.equal(users.canRunAccounts('missing-user'), false);
});

test('激活码生成、兑换、类型校验与吊销', () => {
    const dir = tempDir();
    const users = loadUserStore(dir);
    const codes = loadCodeStore(dir, users);
    const batch = codes.generateCodes({ count: 2, days: 30, type: 'new', maxAccounts: 3 });
    assert.equal(batch.codes.length, 2);
    assert.match(batch.codes[0].code, /^QF-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const first = codes.validateCode(batch.codes[0].code, 'new');
    assert.equal(first.ok, true);
    const created = users.createTenant({
        username: 'redeemed_tenant',
        password: 'tenant-password7',
        expiresAt: Date.now() + 60_000,
        maxAccounts: first.record.maxAccounts,
        codeId: first.record.id,
    });
    assert.equal(created.ok, true);
    assert.equal(codes.validateCode(batch.codes[0].code, 'new').error, 'used_code');
    const reloadedUsers = loadUserStore(dir);
    const reloadedCodes = loadCodeStore(dir, reloadedUsers);
    assert.equal(reloadedCodes.validateCode(batch.codes[0].code, 'new').error, 'used_code');
    assert.equal(reloadedCodes.listCodes({ status: 'redeemed' })[0].redeemedBy, created.user.id);

    const renew = codes.generateCodes({ count: 1, days: 7, type: 'renew', maxAccounts: 3 });
    assert.equal(codes.validateCode(renew.codes[0].code, 'new').error, 'renew_code_required');
    assert.equal(codes.validateCode(renew.codes[0].code, 'renew').ok, true);

    const second = batch.codes[1];
    const record = codes.findByRaw(second.code);
    assert.equal(codes.revokeCode(record.id).ok, true);
    assert.equal(codes.validateCode(second.code, 'new').error, 'revoked_code');
});

test('租户与激活码核销同时提交，写盘失败后可重试', () => {
    const dir = tempDir();
    const jsonDb = require('../dist/services/json-db');
    let failWrite = false;
    const users = loadUserStore(dir, {
        '../services/json-db': {
            ...jsonDb,
            writeJsonFileAtomic: (...args) => {
                if (failWrite) throw new Error('simulated storage failure');
                return jsonDb.writeJsonFileAtomic(...args);
            },
        },
    });
    const codes = loadCodeStore(dir, users);
    const [code] = codes.generateCodes({ count: 1, days: 30, type: 'new', maxAccounts: 3 }).codes;
    const input = {
        username: 'retry_tenant', password: 'tenant-retry7',
        expiresAt: Date.now() + 60_000, maxAccounts: 3, codeId: code.id,
    };
    users.getOwner();
    failWrite = true;
    assert.throws(() => users.createTenant(input), /simulated storage failure/);
    assert.equal(users.findUserByUsername(input.username), null);
    assert.equal(codes.validateCode(code.code, 'new').ok, true);
    failWrite = false;
    assert.equal(users.createTenant(input).ok, true);
    assert.equal(codes.validateCode(code.code, 'new').error, 'used_code');
});

test('未兑换激活码可修改权益并换发，旧码失效且保留同批次关系', () => {
    const dir = tempDir();
    const codes = loadCodeStore(dir);
    const issued = codes.generateCodes({ type: 'new', count: 1, days: 30, maxAccounts: 3 });
    const original = issued.codes[0];
    assert.equal(codes.updateCode(original.id, { redeemBefore: Date.now() - 1 }).error, 'invalid_deadline');
    assert.equal(codes.updateCode(original.id, { targetTenantId: 'sample' }).error, 'invalid_target');
    assert.equal(codes.updateCode(original.id, { days: 12.5 }).error, 'invalid_days');
    assert.equal(codes.updateCode(original.id, { days: 45, maxAccounts: 7, note: '预留' }).ok, true);
    const replacement = codes.replaceCode(original.id, 'owner');
    assert.equal(replacement.ok, true);
    assert.equal(replacement.batchId, issued.batchId);
    const reloaded = loadCodeStore(dir);
    assert.equal(reloaded.validateCode(original.code, 'new').error, 'revoked_code');
    assert.equal(reloaded.replaceCode(original.id, 'owner').error, 'already_replaced');
    const next = reloaded.validateCode(replacement.codes[0].code, 'new').record;
    assert.equal(next.days, 45);
    assert.equal(next.maxAccounts, 7);
    assert.equal(next.note, '预留');
    assert.equal(next.replacesId, original.id);
    const listed = reloaded.listCodes({ batchId: issued.batchId });
    assert.equal(listed.find(record => record.id === original.id).replacedBy, next.id);
    assert.ok(listed.every(record => record.hasFullCode && !Object.hasOwn(record, 'code') && !Object.hasOwn(record, 'codeHash') && !Object.hasOwn(record, 'encryptedCode')));
    assert.equal(reloaded.revealCode(original.id).code, original.code);
    assert.equal(reloaded.revealCode(next.id).code, replacement.codes[0].code);
    const batch = reloaded.revealBatch(issued.batchId);
    assert.equal(batch.codes.length, 1);
    assert.equal(batch.codes[0].id, next.id);
    const saved = fs.readFileSync(path.join(dir, 'activation-codes.json'), 'utf8');
    for (const { code } of [original, replacement.codes[0]]) {
        assert.equal(saved.includes(code), false);
        assert.equal(saved.includes(code.replaceAll('-', '')), false);
    }
});

test('旧版哈希码保留兑换能力，换发后可读取密文；已有密文时不会重建丢失的密钥', () => {
    const dir = tempDir();
    const original = 'QF-AAAA-BBBB-CCCC-DDDD';
    const codeHash = require('node:crypto').createHash('sha256').update(original.replaceAll('-', '')).digest('hex');
    fs.writeFileSync(path.join(dir, 'activation-codes.json'), JSON.stringify({
        codes: [{ id: 'legacy', codeHash, codeHint: 'DDDD', type: 'new', batchId: 'legacy-batch' }],
    }));
    const codes = loadCodeStore(dir);
    assert.equal(codes.validateCode(original, 'new').ok, true);
    assert.equal(codes.revealCode('legacy').error, 'full_code_unavailable');
    assert.equal(codes.revealBatch('legacy-batch').unavailable, 1);
    const replacement = codes.replaceCode('legacy', 'owner').codes[0];
    const key = path.join(dir, 'activation-code-key');
    if (process.platform !== 'win32') assert.equal(fs.statSync(key).mode & 0o777, 0o600);
    assert.equal(loadCodeStore(dir).revealCode(replacement.id).code, replacement.code);
    fs.unlinkSync(key);
    const reloaded = loadCodeStore(dir);
    assert.throws(() => reloaded.revealCode(replacement.id), /密钥文件缺失/);
    assert.throws(() => reloaded.generateCodes({ count: 1 }), /密钥文件缺失/);
    assert.equal(reloaded.validateCode(replacement.code, 'new').ok, true);
    assert.equal(fs.existsSync(key), false);
});

test('指定租户续费码仅由目标租户兑换，核销后保留原权益和兑换人', () => {
    const dir = tempDir();
    const users = loadUserStore(dir);
    const makeTenant = username => users.createTenant({
        username, password: 'tenant-pass7', expiresAt: Date.now() + 60_000, maxAccounts: 2,
    }).user;
    const tenant = makeTenant('renew_owner');
    const other = makeTenant('other_tenant');
    const codes = loadCodeStore(dir, users);
    const batch = codes.generateCodes({ type: 'renew', count: 2, days: 14, maxAccounts: 4, targetTenantId: tenant.id });
    const code = batch.codes[0];
    const terms = { codeId: code.id, maxAccounts: code.maxAccounts, targetTenantId: code.targetTenantId };
    assert.equal(users.extendTenant(other.id, code.days, terms).error, 'wrong_tenant');
    assert.equal(users.getUserById(other.id).expiresAt, other.expiresAt);
    assert.equal(codes.validateCode(code.code, 'renew').ok, true);
    const extended = users.extendTenant(tenant.id, code.days, terms);
    assert.equal(extended.user.expiresAt, tenant.expiresAt + 14 * 86_400_000);
    assert.equal(extended.user.maxAccounts, 4);
    assert.equal(codes.updateCode(code.id, { days: 365 }).error, 'terms_locked');
    assert.equal(codes.updateCode(code.id, { note: '已核对' }).code.redeemedBy, tenant.id);
    assert.equal(codes.replaceCode(code.id, 'owner').error, 'already_redeemed');
    assert.equal(codes.revokeBatch(batch.batchId).revoked, 1);
    assert.equal(codes.validateCode(code.code, 'renew').error, 'used_code');
    assert.equal(codes.validateCode(batch.codes[1].code, 'renew').error, 'revoked_code');
});

test('激活码分页和租户筛选返回稳定的记录与整批可操作数量', () => {
    const dir = tempDir();
    const users = loadUserStore(dir);
    const tenant = users.createTenant({
        username: 'paged_tenant', password: 'tenant-pass7',
        expiresAt: Date.now() + 60_000, maxAccounts: 1,
    }).user;
    const codes = loadCodeStore(dir, users);
    const issued = codes.generateCodes({ count: 30, type: 'renew', days: 7, targetTenantId: tenant.id });
    const filters = { batchId: issued.batchId, search: 'paged_tenant', tenantId: tenant.id, pageSize: 25 };
    const first = codes.listCodesPage({ ...filters, page: 1 });
    const second = codes.listCodesPage({ ...filters, page: 2 });
    assert.equal(first.total, 30);
    assert.equal(first.items.length, 25);
    assert.equal(second.items.length, 5);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 30);
    assert.equal(codes.listCodesPage({ ...filters, status: 'redeemed' }).batch.revocable, 30);
    assert.equal(codes.listCodesPage({ ...filters, status: 'redeemed' }).total, 0);
});

test('管理员操作记录可持久化并按类型和目标检索', () => {
    const dir = tempDir();
    const open = () => load('models/admin-audit-store.js', { '../config/runtime-paths': runtimePaths(dir) });
    const audit = open();
    audit.appendAudit({ actorId: 'owner', actor: 'admin', action: 'code.reveal', codeId: 'record-id' });
    audit.appendAudit({ actorId: 'owner', actor: 'admin', action: 'tenant.quota', tenantId: 'tenant-id', username: 'friend' });
    const restored = open();
    const code = restored.listAudit({ category: 'code', search: 'RECORD-ID', page: 1 });
    assert.equal(code.total, 1);
    assert.equal(code.items[0].actor, 'admin');
    assert.equal(code.items[0].code, undefined);
    assert.equal(restored.listAudit({ category: 'tenant', search: 'friend' }).total, 1);
});

test('托管恢复读取备份中的开关，跳过停用租户和已使用的 Code，并允许取消排队', async () => {
    const dir = tempDir();
    const loadAccounts = pathToData => load('models/store/accounts.js', {
        '../../config/runtime-paths': runtimePaths(pathToData),
        './shared-state': { ACCOUNTS_FILE: path.join(pathToData, 'accounts.json') },
        './account-config': { ensureAccountConfig() {}, removeAccountConfig() {} },
    });
    const accounts = loadAccounts(dir);
    const users = loadUserStore(dir);
    const tenant = users.createTenant({
        username: 'disabled_tenant', password: 'tenant-pass7',
        expiresAt: Date.now() + 60_000, maxAccounts: 2,
    }).user;
    users.updateTenant(tenant.id, { status: 'disabled' });
    for (const [name, ownerId, enableHosting] of [
        ['恢复', 'owner', true], ['手动停止', 'owner', false], ['停用租户', tenant.id, true],
        ['缺少新码', 'owner', true], ['取消恢复', 'owner', true],
    ]) {
        accounts.addOrUpdateAccount({ name, ownerId, code: `fixture-${name}` }, { enableHosting });
    }
    accounts.setAccountRunState('4', { codeConsumed: true });
    assert.equal(accounts.findAccountByRef('1').id, '1');
    accounts.addOrUpdateAccount({ id: '1', qq: '2' });
    assert.equal(accounts.findAccountByRef('2').id, '2');

    const backup = tempDir();
    const [delivery] = loadCodeStore(dir, users).generateCodes({ type: 'new' }).codes;
    fs.cpSync(dir, backup, { recursive: true });
    const restoredAccounts = loadAccounts(backup);
    const restoredUsers = loadUserStore(backup);
    assert.equal(loadCodeStore(backup, restoredUsers).revealCode(delivery.id).code, delivery.code);

    const tasks = [];
    const starts = [];
    const { EventEmitter } = require('node:events');
    class FixtureWorker extends EventEmitter {
        constructor(_filename, options) {
            super();
            this.accountId = options.workerData.accountId;
        }
        postMessage(message) {
            if (message.type === 'start') {
                assert.equal(restoredAccounts.getAccountById(this.accountId).codeConsumed, true);
                starts.push(this.accountId);
            }
            if (message.type === 'stop') this.emit('exit', 0);
        }
    }
    const { createRuntimeEngine } = load('runtime/runtime-engine.js', {
        'node:worker_threads': { Worker: FixtureWorker },
        '../models/store': { ...restoredAccounts, getSystemConfig: () => null },
        '../models/user-store': restoredUsers,
        './runtime-state': { createRuntimeState: () => ({
            workers: {}, globalLogs: [], accountLogs: [], runtimeEvents: new EventEmitter(),
            buildConfigSnapshotForAccount: () => ({}),
            normalizeStatusForPanel: status => status,
            buildDefaultStatus: id => ({ accountId: id, connection: { connected: false } }),
            log() {}, addAccountLog() {},
        }) },
        './relogin-reminder': { createReloginReminderService: () => ({ getOfflineAutoDeleteMs: () => Infinity, triggerOfflineReminder() {} }) },
    }, {
        setTimeout: callback => { tasks.push(callback); return { unref() {} }; },
    });
    const engine = createRuntimeEngine({ runtimeMode: 'thread' });
    await engine.start({ startAdminServer: false });
    assert.equal(engine.dataProvider.getStatus('1').hosting.phase, 'queued');
    assert.equal(engine.dataProvider.getStatus('2').hosting.phase, 'stopped');
    assert.equal(engine.dataProvider.getStatus('3').hosting.phase, 'suspended');
    assert.equal(engine.dataProvider.getStatus('4').hosting.phase, 'relogin_required');
    assert.throws(() => engine.dataProvider.startAccount('4'), { code: 'relogin_required' });
    engine.dataProvider.stopAccount('5');
    while (tasks.length) tasks.shift()();
    assert.deepEqual(starts, ['1']);
    assert.equal(restoredAccounts.getAccountById('5').runEnabled, false);
    assert.equal(engine.dataProvider.getStatus('1').hosting.phase, 'connecting');
    restoredUsers.updateTenant(tenant.id, { status: 'active' });
    engine.dataProvider.recoverTenantAccounts(tenant.id);
    assert.equal(engine.dataProvider.getStatus('3').hosting.phase, 'queued');
    while (tasks.length) tasks.shift()();
    assert.deepEqual(starts, ['1', '3']);
    engine.workers['1'].process.emit('message', { type: 'account_disconnected', source: 'ws_error', code: 400 });
    assert.equal(engine.dataProvider.getStatus('1').hosting.issue.reason, 'login_required');
    assert.equal(restoredAccounts.getAccountById('1').runEnabled, true);
    restoredAccounts.addOrUpdateAccount({ id: '1', code: 'fresh-fixture' });
    engine.dataProvider.restartAccount('1');
    assert.deepEqual(starts, ['1', '3', '1']);
    engine.stopAllAccounts();
});

test('登录失败的锁定在进程重启后保留，且按客户端来源隔离', () => {
    const dir = tempDir();
    const users = loadUserStore(dir);
    users.createTenant({
        username: 'locked_tenant', password: 'tenant-password7',
        expiresAt: Date.now() + 60_000, maxAccounts: 1,
    });
    for (let i = 0; i < 4; i++) {
        assert.equal(users.validateCredentials('locked_tenant', 'incorrect', '127.0.0.1').error, 'invalid_credentials');
    }
    const restarted = loadUserStore(dir);
    assert.equal(restarted.validateCredentials('locked_tenant', 'incorrect', '127.0.0.1').error, 'locked');
    assert.equal(restarted.validateCredentials('locked_tenant', 'tenant-password7', '127.0.0.2').ok, true);
});

test('账号列表按租户过滤，跨租户解析返回空', () => {
    const middleware = load('controllers/admin/middleware.js', {
        '../../models/store': {},
        '../../models/user-store': { getUserById: () => null, isExpired: () => false },
        '../../services/account-resolver': require('../dist/services/account-resolver'),
    });
    const accounts = [
        { id: '1', ownerId: 'owner', name: 'owner-account', uin: '2' },
        { id: '2', ownerId: 'tenant-a', name: 'a-account', uin: '3' },
        { id: '3', ownerId: 'tenant-b', name: 'b-account' },
    ];
    const ctx = { provider: { getAccounts: () => ({ accounts }) } };
    const tenantAuth = { user: { id: 'tenant-a', role: 'tenant' } };
    const ownerAuth = { user: { id: 'owner', role: 'owner' } };

    assert.equal(middleware.getAccountList(ctx, tenantAuth).length, 1);
    assert.equal(middleware.getAccountList(ctx, ownerAuth).length, 3);
    assert.equal(middleware.getAccountList(ctx, null).length, 0);
    assert.equal(middleware.resolveAccId(ctx, '2', tenantAuth), '2');
    assert.equal(middleware.resolveAccId(ctx, '3', tenantAuth), '');
    assert.equal(middleware.resolveAccId(ctx, '3', ownerAuth), '3');
});

test('账号读写响应只包含当前租户可见的账号且不回传 Code', () => {
    const accounts = [
        { id: '1', ownerId: 'owner', name: 'owner-account', code: 'owner-code' },
        { id: '2', ownerId: 'tenant-a', name: 'a-account', code: 'tenant-code' },
    ];
    const auth = { user: { id: 'tenant-a', role: 'tenant' } };
    const store = {
        addOrUpdateAccount: () => ({ accounts, nextId: 3 }),
        deleteAccount: id => ({ accounts: accounts.filter(account => account.id !== id), nextId: 3 }),
    };
    const middleware = load('controllers/admin/middleware.js', { '../../models/store': store });
    const { mountAccountRoutes } = load('controllers/admin/account-routes.js', {
        './middleware': middleware,
        '../../models/store': store,
    });
    const routes = new Map();
    const app = Object.fromEntries(['get', 'post', 'delete'].map(method => [
        method, (route, ...handlers) => routes.set(`${method} ${route}`, handlers.at(-1)),
    ]));
    const ctx = { provider: { getAccounts: () => ({ accounts, nextId: 3 }), stopAccount() {} } };
    mountAccountRoutes(app, ctx);
    const req = { auth, body: { id: '2', remark: 'my remark' }, params: { id: '2' }, headers: {} };
    let data;
    const res = { json: payload => { data = JSON.parse(JSON.stringify(payload)).data; } };
    for (const route of ['get /api/accounts', 'post /api/account/remark']) {
        routes.get(route)(req, res);
        assert.deepEqual(data, { accounts: [{ id: '2', ownerId: 'tenant-a', name: 'a-account' }] });
    }
    routes.get('delete /api/accounts/:id')(req, res);
    assert.deepEqual(data, { accounts: [] });
});

test('首次设置密码的会话仅能验证、退出或修改密码', () => {
    const user = { id: 'owner', role: 'owner', mustChangePassword: true };
    const middleware = load('controllers/admin/middleware.js', {
        '../../models/user-store': { getUserById: () => user, isExpired: () => false },
    });
    const authRequired = middleware.createAuthRequired({ tokens: { get: () => ({ userId: user.id }) } });
    let status;
    const res = { status: value => { status = value; return res; }, json() {} };
    const req = { headers: { 'x-admin-token': 'session' } };
    authRequired({ ...req, method: 'GET', path: '/accounts' }, res, () => assert.fail('accounts are restricted'));
    assert.equal(status, 403);
    let allowed = false;
    authRequired({ ...req, method: 'POST', path: '/user/change-password' }, res, () => { allowed = true; });
    assert.equal(allowed, true);
});

test('实时日志只投递给当前持有账号访问权限的会话', () => {
    const auth = { user: { id: 'tenant-a', role: 'tenant' } };
    const sessions = new Map([['token-a', auth], ['token-b', { user: { id: 'tenant-b', role: 'tenant' } }]]);
    const events = [];
    const sockets = new Map(['a', 'b'].map(id => [id, {
        data: { adminToken: `token-${id}` },
        emit: event => events.push([id, event]),
        disconnect: () => events.push([id, 'disconnect']),
        leave: room => events.push([id, 'leave', room]),
    }]));
    const { emitRealtimeLog } = load('controllers/admin/socket.js', {
        './middleware': {
            resolveAuthContext: (_ctx, token) => ({ auth: sessions.get(token) }),
            isOwner: current => current.user.role === 'owner',
            resolveAccId: (_ctx, id, current) => current.user.id === 'tenant-a' ? id : '',
        },
    });
    const ctx = { io: { sockets: { sockets, adapter: { rooms: new Map([['account:2', new Set(['a', 'b'])]]) } } } };
    emitRealtimeLog(ctx, { accountId: '2' });
    assert.deepEqual(events, [['a', 'log:new'], ['b', 'leave', 'account:2']]);
    events.length = 0;
    sessions.delete('token-a');
    emitRealtimeLog(ctx, { accountId: '2' });
    assert.deepEqual(events[0], ['a', 'disconnect']);
});

test('生命周期巡检停止到期租户的挂机账号并踢掉会话', () => {
    const dir = tempDir();
    const users = loadUserStore(dir);
    const created = users.createTenant({
        username: 'friend_sweep',
        password: 'abc12345',
        expiresAt: Date.now() + 60_000,
        maxAccounts: 2,
    });
    users.updateTenant(created.user.id, { expiresAt: Date.now() - 1 });
    const lifecycle = load('services/tenant-lifecycle.js', {
        '../models/user-store': users,
        './logger': { createModuleLogger: () => ({ info() {}, warn() {} }) },
    });
    const stopped = [];
    let kicked = 0;
    const ctx = {
        provider: {
            getAccounts: () => ({
                accounts: [
                    { id: '10', ownerId: created.user.id, running: true },
                    { id: '11', ownerId: created.user.id, running: false },
                ],
            }),
            stopAccount: id => stopped.push(String(id)),
        },
        tokens: { deleteByUserId: () => { kicked++; return 1; }, cleanup: () => 0 },
    };
    const result = lifecycle.sweepExpiredTenants(ctx);
    assert.deepEqual(stopped, ['10']);
    assert.equal(kicked, 1);
    assert.equal(result.stopped, 1);
});
