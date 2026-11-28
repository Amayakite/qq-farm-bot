const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readTickets, listTickets, saveTicket, removeTicket, parseTicket } = require('../dist/models/yishu-tickets');

test('share tickets are account and tenant isolated and survive restart-safe reads', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-tickets-'));
    const previous = process.env.FARM_DATA_DIR;
    process.env.FARM_DATA_DIR = dir;
    t.after(() => {
        if (previous === undefined) delete process.env.FARM_DATA_DIR;
        else process.env.FARM_DATA_DIR = previous;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const first = { id: '1', ownerId: 'tenant-a', createdAt: 100 };
    const otherTenant = { id: '1', ownerId: 'tenant-b', createdAt: 100 };
    const recreated = { id: '1', ownerId: 'tenant-a', createdAt: 101 };
    const ticket = '12345678-1234-1234-1234-123456789abc';
    saveTicket(first, '9001', 'https://example.com/share?ticket=' + ticket);
    assert.equal(readTickets(first)['9001'].ticket, ticket);
    assert.deepEqual(readTickets(otherTenant), {});
    assert.deepEqual(readTickets(recreated), {});
    assert.deepEqual(Object.keys(listTickets(first)[0]).sort(), ['gid', 'updatedAt']);
    assert.equal(JSON.stringify(listTickets(first)).includes(ticket), false);
    const file = path.join(dir, 'yishu-share-tickets', fs.readdirSync(path.join(dir, 'yishu-share-tickets'))[0]);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => saveTicket(first, '../1', ticket));
    assert.throws(() => saveTicket(first, '9001', ticket + ' ' + 'abcdefab-abcd-abcd-abcd-abcdefabcdef'));
    assert.equal(readTickets(first)['9001'].ticket, ticket);
    assert.equal(parseTicket('ABCDEFABCDEFABCDEFABCDEFABCDEFAB'), 'abcdefabcdefabcdefabcdefabcdefab');
    removeTicket(first, '9001');
    assert.deepEqual(readTickets(first), {});
});
