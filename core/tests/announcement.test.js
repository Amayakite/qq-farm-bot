const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('only the administrator can publish an announcement visible to tenants', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-announcement-'));
    const previous = process.env.FARM_DATA_DIR;
    process.env.FARM_DATA_DIR = dir;
    const express = require('express');
    const { mountTenantRoutes } = require('../dist/controllers/admin/tenant-routes');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.auth = { user: { id: req.headers['x-fixture-role'] === 'owner' ? 'owner' : 'tenant', username: 'fixture', role: req.headers['x-fixture-role'] || 'tenant' } };
        next();
    });
    mountTenantRoutes(app, { provider: {} });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(async () => { await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.FARM_DATA_DIR; else process.env.FARM_DATA_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const put = (role, body) => fetch(base + '/api/admin/announcement', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-fixture-role': role }, body: JSON.stringify(body) });
    assert.equal((await put('tenant', { enabled: true, content: 'not allowed' })).status, 403);
    assert.equal((await put('owner', { enabled: true, content: '维护通知' })).status, 200);
    assert.equal((await (await fetch(base + '/api/announcement')).json()).data.content, '维护通知');
    assert.equal((await put('owner', { enabled: true, content: 'x'.repeat(2001) })).status, 400);
    assert.equal((await put('owner', { enabled: false, content: '维护通知' })).status, 200);
    assert.equal((await (await fetch(base + '/api/announcement')).json()).data, null);
});
