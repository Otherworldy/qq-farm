'use strict';
// 手动直接登录必须解除“不登录”标记（hold-offline）。
// 反证：旧代码只刷凭证不解除标记，restartWorker 被 worker-manager 的
// autoLogin===false 静默拦掉，接口仍返回 ok，前端误报“直接登录成功”。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-hold-'));
process.env.FARM_DATA_DIR = dataDir;

const store = require('../src/models/store');
const { registerAdminAccountRuntimeRoutes } = require('../src/controllers/admin-account-runtime-routes');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// addOrUpdateAccount 只在 id 不存在时新建；带 id 只更新已有账号，
// 所以夹具先无 id 建号，再按拿到的 id 改 autoLogin。
function seedAccount(autoLogin) {
  let accounts = store.getAccounts().accounts || [];
  if (accounts.length === 0) {
    store.addOrUpdateAccount({ name: 'hold', platform: 'wx', refreshtoken: 'rt' });
    accounts = store.getAccounts().accounts || [];
  }
  const id = String(accounts[0].id);
  store.addOrUpdateAccount({ id, autoLogin });
  return id;
}

function readAccount(id) {
  const data = store.getAccounts();
  return (data.accounts || []).find(item => String(item.id) === id);
}

function register(provider) {
  const routes = new Map();
  const app = {
    post: (route, handler) => routes.set(route, handler),
    get: (route, handler) => routes.set(route, handler),
  };
  registerAdminAccountRuntimeRoutes({
    app,
    provider,
    resolveAccountReference: ref => String(ref),
    canAccessAccount: () => true,
  });
  return routes.get('/api/accounts/:id/relogin');
}

function callRelogin(handler, accountId) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return Promise.resolve(handler({ params: { id: accountId }, headers: {} }, res)).then(() => res);
}

test('manual relogin clears the hold-offline flag so the worker may start', async () => {
  const id = seedAccount(false);
  assert.equal(readAccount(id).autoLogin, false);

  let seenAutoLogin = null;
  const handler = register({
    async refreshAccountCode() {
      // worker 能否被拉起取决于刷新期间的 autoLogin，必须在刷新前就已解除
      seenAutoLogin = readAccount(id).autoLogin;
      return { ok: true };
    },
  });

  const res = await callRelogin(handler, id);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(seenAutoLogin, true, '刷新期间 autoLogin 必须已解除，否则 restartWorker 会被静默跳过');
  assert.equal(readAccount(id).autoLogin, true, '登录成功后保持可自动登录');
});

test('a failed relogin restores the hold-offline flag', async () => {
  const id = seedAccount(false);
  assert.equal(readAccount(id).autoLogin, false);

  const handler = register({ async refreshAccountCode() { return { ok: false }; } });

  const res = await callRelogin(handler, id);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.ok, false);
  assert.equal(readAccount(id).autoLogin, false, '没上号就不能留下会自动拉号的状态');
});

test('a relogin failure for an already-enabled account keeps it enabled', async () => {
  const id = seedAccount(true);

  const handler = register({ async refreshAccountCode() { return { ok: false }; } });

  const res = await callRelogin(handler, id);
  assert.equal(res.statusCode, 409);
  assert.equal(readAccount(id).autoLogin, true);
});
