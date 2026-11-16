/**
 * 牧场面板路由测试
 *
 * 路由层只做鉴权 + 转发，所以这里验证的是：鉴权短路、op 白名单、
 * 错误转发。真正的业务逻辑在 services/pasture-*，另有测试覆盖。
 */

const test = require('node:test');
const assert = require('node:assert');

const { registerAdminPastureRoutes, PASTURE_OPS } = require('../src/controllers/admin-pasture-routes');

/** 收集注册的 handler，便于直接调用 */
function buildApp() {
    const routes = { get: {}, post: {} };
    const app = {
        get: (p, h) => { routes.get[p] = h; },
        post: (p, h) => { routes.post[p] = h; },
    };
    return { app, routes };
}

/** 最小 res 桩，记录 status/json */
function buildRes() {
    const out = { statusCode: 200, body: undefined };
    const res = {
        status(code) { out.statusCode = code; return res; },
        json(payload) { out.body = payload; return res; },
    };
    return { res, out };
}

function register(overrides = {}) {
    const { app, routes } = buildApp();
    const calls = [];
    const provider = {
        getPasture: async (accountId) => { calls.push(`get:${accountId}`); return { summary: { animals: 2 } }; },
        doPastureOp: async (accountId, op) => { calls.push(`op:${accountId}:${op}`); return { hadWork: true, actions: [op] }; },
        ...(overrides.provider || {}),
    };
    const errors = [];
    registerAdminPastureRoutes({
        app,
        provider,
        getAccountIdFromRequest: overrides.getAccountIdFromRequest || (() => 1),
        canAccessAccount: overrides.canAccessAccount || (() => true),
        sendProviderError: (res, error) => { errors.push(error.message); res.status(500).json({ ok: false, error: error.message }); },
    });
    return { routes, calls, errors };
}

test('注册了两条路由', () => {
    const { routes } = register();
    assert.ok(routes.get['/api/pasture'], 'GET /api/pasture');
    assert.ok(routes.post['/api/pasture/operate'], 'POST /api/pasture/operate');
});

test('GET /api/pasture：正常转发到 provider', async () => {
    const { routes, calls } = register();
    const { res, out } = buildRes();
    await routes.get['/api/pasture']({ headers: {} }, res);
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.ok, true);
    assert.deepEqual(out.body.data, { summary: { animals: 2 } });
    assert.deepEqual(calls, ['get:1']);
});

test('GET /api/pasture：缺 account 直接 400，不碰 provider', async () => {
    const { routes, calls } = register({ getAccountIdFromRequest: () => null });
    const { res, out } = buildRes();
    await routes.get['/api/pasture']({ headers: {} }, res);
    assert.equal(out.statusCode, 400);
    assert.equal(out.body.ok, false);
    assert.deepEqual(calls, []);
});

test('GET /api/pasture：无权访问返回 403', async () => {
    const { routes, calls } = register({ canAccessAccount: () => false });
    const { res, out } = buildRes();
    await routes.get['/api/pasture']({ headers: {} }, res);
    assert.equal(out.statusCode, 403);
    assert.deepEqual(calls, []);
});

test('GET /api/pasture：provider 报错走 sendProviderError', async () => {
    const { routes, errors } = register({
        provider: { getPasture: async () => { throw new Error('上游挂了'); } },
    });
    const { res, out } = buildRes();
    await routes.get['/api/pasture']({ headers: {} }, res);
    assert.equal(out.statusCode, 500);
    assert.deepEqual(errors, ['上游挂了']);
});

test('POST /api/pasture/operate：白名单内的 op 能转发', async () => {
    for (const op of PASTURE_OPS) {
        const { routes, calls } = register();
        const { res, out } = buildRes();
        await routes.post['/api/pasture/operate']({ headers: {}, body: { op } }, res);
        assert.equal(out.statusCode, 200, `${op} 应被接受`);
        assert.equal(out.body.ok, true);
        assert.deepEqual(calls, [`op:1:${op}`]);
    }
});

test('POST /api/pasture/operate：缺省 op 视为 all', async () => {
    const { routes, calls } = register();
    const { res } = buildRes();
    await routes.post['/api/pasture/operate']({ headers: {}, body: {} }, res);
    assert.deepEqual(calls, ['op:1:all']);
});

test('POST /api/pasture/operate：非法 op 返回 400 且不打 provider', async () => {
    const { routes, calls } = register();
    const { res, out } = buildRes();
    await routes.post['/api/pasture/operate']({ headers: {}, body: { op: 'drop_database' } }, res);
    assert.equal(out.statusCode, 400);
    assert.match(out.body.error, /不支持的操作类型/);
    assert.deepEqual(calls, []);
});

test('POST /api/pasture/operate：provider 报错走 sendProviderError', async () => {
    const { routes, errors } = register({
        provider: { doPastureOp: async () => { throw new Error('执行失败'); } },
    });
    const { res } = buildRes();
    await routes.post['/api/pasture/operate']({ headers: {}, body: { op: 'harvest' } }, res);
    assert.deepEqual(errors, ['执行失败']);
});