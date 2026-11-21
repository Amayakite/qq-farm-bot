const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createScanCoordinator, ScanProblem } = require('../dist/services/account-scan/coordinator');

function target(id, platform = 'qq', accountId) {
    return { tenantId: id, token: 'session-' + id, platform, accountId, name: '' };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('QQ jobs wait for the provider after restart and run in tenant arrival order', async t => {
    let time = 0;
    let starts = 0;
    let releases = 0;
    const stages = [];
    const scans = createScanCoordinator({
        now: () => time,
        checkTarget() {},
        save: () => 'saved-account',
        async open() {
            if (++starts === 1) throw Object.assign(new Error('Old provider lease'), { code: 'WORKFLOW_BUSY' });
            return {
                qrImage: 'fixture-qr-' + starts, expiresAt: time + 120_000,
                poll: async () => ({ status: 'waiting_scan' }),
                authorize: async () => ({ code: 'fixture-code' }),
                release: async () => { releases++; },
            };
        },
        observe: event => stages.push(event),
    });
    t.after(scans.dispose);
    const first = scans.create(target('a'), 'request-a', 'add');
    const second = scans.create(target('b'), 'request-b', 'add');
    assert.equal(scans.create(target('a'), 'request-a', 'add').id, first.id);
    assert.throws(() => scans.replay('session-a', 'request-a', 'different-account'), { errorType: 'scan_request_conflict' });
    assert.throws(() => scans.create({ ...target('a'), token: 'other-a' }, 'another-request', 'add'), { errorType: 'scan_already_active' });
    assert.throws(() => scans.status(first.id, 'session-b'), { statusCode: 404 });
    assert.throws(() => scans.cancel(first.id, 'session-b'), { statusCode: 404 });

    await scans.tick();
    assert.equal(starts, 1);
    assert.equal(scans.status(first.id, 'session-a').status, 'queued');
    assert.equal(scans.status(second.id, 'session-b').status, 'queued');
    await scans.tick();
    assert.equal(starts, 1);
    time = 3_001;
    await scans.tick();
    assert.equal(scans.status(first.id, 'session-a').qrImage, 'fixture-qr-2');
    assert.equal(scans.status(second.id, 'session-b').qrImage, undefined);
    scans.cancel(first.id, 'session-a');
    await scans.tick();
    assert.equal(releases, 1);
    await scans.tick();
    assert.equal(scans.status(second.id, 'session-b').qrImage, 'fixture-qr-3');
    assert.ok(stages.some(event => event.errorType === 'WORKFLOW_BUSY'));
    assert.ok(stages.every(event => !Object.hasOwn(event, 'token') && !Object.hasOwn(event, 'qrImage')));
});

test('authorization finishes when the browser stops polling, with one account write', async t => {
    let time = 10;
    let saves = 0;
    let released = false;
    const started = deferred();
    const finish = deferred();
    const scans = createScanCoordinator({
        now: () => time,
        checkTarget() {},
        save(owner, result) {
            assert.equal(owner.accountId, 'original-account');
            assert.equal(result.code, 'fixture-code');
            saves++;
            return owner.accountId;
        },
        async open() {
            return {
                qrImage: 'fixture-qr', expiresAt: 120_000,
                poll: async () => ({ status: 'confirmed' }),
                authorize() { started.resolve(); return finish.promise; },
                release: async () => { released = true; },
            };
        },
    });
    t.after(scans.dispose);
    const job = scans.create(target('a', 'qq', 'original-account'), 'request-a', 'relogin');
    await scans.tick();
    const authorization = scans.tick();
    await started.promise;
    assert.throws(() => scans.cancel(job.id, 'session-a'), { errorType: 'scan_finishing' });
    time += 130_000;
    await scans.tick();
    finish.resolve({ code: 'fixture-code' });
    await authorization;
    assert.equal(saves, 1);
    assert.equal(released, true);
    const outcome = scans.replay('session-a', 'request-a', 'relogin');
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.accountId, 'original-account');
    assert.equal(outcome.qrImage, undefined);
    assert.equal(outcome.code, undefined);
    await scans.tick();
    assert.equal(saves, 1);
});

test('WeChat tenants run independently and deletion or revocation prevents a late save', async t => {
    let opened = 0;
    let released = 0;
    let time = 0;
    const revoked = new Set();
    const started = deferred();
    const finish = deferred();
    const scans = createScanCoordinator({
        now: () => time,
        checkTarget(owner) { if (revoked.has(owner.tenantId)) throw new ScanProblem(403, 'scan_tenant_unavailable', 'Tenant unavailable'); },
        save: () => assert.fail('Deleted or revoked targets cannot receive an authorization'),
        async open() {
            opened++;
            return {
                qrImage: 'fixture-qr', expiresAt: 120_000,
                poll: async () => ({ status: 'confirmed' }),
                authorize() { started.resolve(); return finish.promise; },
                release: async () => { released++; },
            };
        },
    });
    t.after(scans.dispose);
    const removed = scans.create(target('a', 'wx', 'deleted'), 'request-a', 'relogin');
    const other = scans.create(target('b', 'wx'), 'request-b', 'add');
    await scans.tick();
    assert.equal(opened, 2);
    scans.cancelAccount('deleted');
    const authorization = scans.tick();
    await started.promise;
    revoked.add('b');
    finish.resolve({ code: 'fixture-code' });
    await authorization;
    assert.equal(scans.status(removed.id, 'session-a').status, 'cancelled');
    assert.equal(scans.status(other.id, 'session-b').errorType, 'scan_tenant_unavailable');
    assert.equal(released, 2);

    const abandoned = scans.create(target('c', 'wx'), 'request-c', 'add');
    await scans.tick();
    time = 30_001;
    await scans.tick();
    assert.equal(scans.status(abandoned.id, 'session-c').status, 'expired');
    assert.equal(released, 3);
});

function loadWithMocks(file, mocks) {
    const filename = path.resolve(__dirname, '../dist', file);
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    const sandbox = { require: name => mocks[name] || realRequire(name), module, exports: module.exports };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return module.exports;
}

test('QQ status, authorization and logout stay pinned to the original configured instance', async () => {
    let config = { qqQrLogin: true, napCatEndpoint: 'https://one.test', napCatSignature: 'first-test-signature' };
    let busy = true;
    const calls = [];
    const axios = {
        async get(url) {
            calls.push([url]);
            return { data: { workflowBusy: busy } };
        },
        async post(url, body, options) {
            calls.push([url, options.headers['X-API-Signature']]);
            if (url.endsWith('/code')) return { data: { ok: true, code: 'fixture-code' } };
            if (url.endsWith('/logout')) return { data: { ok: true } };
            return { data: { ok: true, task: { id: 'provider-task', qrImage: 'fixture-qr', status: 'waiting_scan' } } };
        },
    };
    const { createQqLoginClient } = loadWithMocks('services/qq-login/service.js', {
        axios: { default: axios },
        '../../models/store': { getLoginSettings: () => config },
    });
    const client = createQqLoginClient();
    await assert.rejects(client.open(), { code: 'WORKFLOW_BUSY' });
    assert.equal(calls.length, 1);
    busy = false;
    const opened = await client.open();
    config = { ...config, napCatEndpoint: 'https://two.test', napCatSignature: 'second-test-signature' };
    await client.status(opened.taskId, new AbortController().signal);
    await client.authorize(opened.taskId);
    await client.release(opened.taskId);
    assert.ok(calls.every(([url]) => url.startsWith('https://one.test/')));
    assert.ok(calls.filter(([, signature]) => signature).every(([, signature]) => signature === 'first-test-signature'));
});
