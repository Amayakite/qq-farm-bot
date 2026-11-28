const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { WxLoginService } = require('../dist/services/wx-login/service');

test('WeChat confirm fetches user info and uses nick_name for the session nickname', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    const responses = [
        '{}',
        JSON.stringify({ code: 0, ext_info: { list_s: { login_buffer: { value: ['login-buffer'] } } } }),
        JSON.stringify({ code: 0, nick_name: 'wechat-nickname', head_img_url: 'https://example.test/avatar.jpg' }),
    ];

    global.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const body = responses.shift();
        assert.notEqual(body, undefined);
        return {
            status: 200,
            headers: new Headers(),
            arrayBuffer: async () => Buffer.from(body),
        };
    };

    try {
        const session = {
            cookies: new Map([
                ['openid', 'openid-value'],
                ['accesstoken', 'access-token-value'],
                ['refreshtoken', 'refresh-token-value'],
            ]),
            uuid: 'uuid',
            oauthCode: 'oauth-code',
        };

        await new WxLoginService().confirm(session);

        assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
            '/pc_yyb/pcyyb_oauth',
            '/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth',
            '/pc_yyb/pcyyb_get_user_info',
        ]);
        assert.equal(session.nickname, 'wechat-nickname');
        assert.equal(session.refreshToken, 'refresh-token-value');
        assert.equal(session.accessToken, 'access-token-value');
        const infoHeaders = calls[2].init.headers;
        const timestamp = infoHeaders.get('Ual-Access-Timestamp');
        const nonce = infoHeaders.get('Ual-Access-Nonce');
        assert.equal(infoHeaders.get('Ual-Access-Access-Token'), 'access-token-value');
        assert.equal(infoHeaders.get('Ual-Access-Openid'), 'openid-value');
        assert.equal(
            infoHeaders.get('Ual-Access-Signature'),
            crypto.createHash('md5').update(`${timestamp}${nonce}`).digest('hex'),
        );
    }
    finally {
        global.fetch = originalFetch;
    }
});

test('WeChat rolling token is persisted before the new login buffer is fetched', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    let saved;
    global.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (calls.length === 2) assert.equal(saved.refreshToken, 'rotated-refresh');
        const body = calls.length === 1
            ? { code: 0, user_info: { access_token: 'rotated-access', refresh_token: 'rotated-refresh', openid: 'openid' } }
            : { code: 0, ext_info: { list_s: { login_buffer: { value: ['new-buffer'] } } } };
        return { status: 200, headers: new Headers(), arrayBuffer: async () => Buffer.from(JSON.stringify(body)) };
    };
    try {
        const value = { openid: 'openid', loginBuffer: 'old-buffer', accessToken: 'old-access', refreshToken: 'old-refresh' };
        const result = await new WxLoginService().refreshCredentials(value, rotated => { saved = rotated; });
        assert.equal(result.loginBuffer, 'new-buffer');
        assert.equal(result.refreshToken, 'rotated-refresh');
        assert.deepEqual(calls.map(c => new URL(c.url).pathname), ['/pc_yyb_auth/pcyyb_refresh_token_auth', '/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth']);
        assert.equal(JSON.parse(calls[0].init.body).userInfo.refreshToken, 'old-refresh');
    } finally { global.fetch = originalFetch; }
});
