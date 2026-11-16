const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const tmp = fs.realpathSync(os.tmpdir()); const prefix = path.resolve(tmp, 'farm-worker-api-error-');
assert.ok(prefix.startsWith(tmp + path.sep));
const dataDir = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
const { createScheduler, getSchedulerRegistrySnapshot } = require('../src/services/scheduler');
const { createWorkerManager } = require('../src/runtime/worker-manager');
const rejectionOf = promise => promise.then(() => null, err => err);

function createFakeProc() {
  const handlers = {};
  const sent = [];
  return {
    sent,
    on: (event, cb) => { handlers[event] = cb; },
    emitMessage: msg => handlers.message && handlers.message(msg),
    send: msg => sent.push(msg),
    kill: () => {},
    exitCode: null,
    signalCode: null,
  };
}

function buildManagerHarness() {
  const proc = createFakeProc();
  const workers = {};
  const globalLogs = [];
  const manager = createWorkerManager({
    fork: () => proc,
    WorkerThread: undefined,
    runtimeMode: 'fork',
    processRef: { pkg: false, env: {} },
    mainEntryPath: '',
    workerScriptPath: '',
    workers,
    globalLogs,
    log: () => {},
    addAccountLog: () => {},
    normalizeStatusForPanel: data => data,
    buildConfigSnapshotForAccount: () => ({}),
    getOfflineAutoDeleteMs: () => Infinity,
    triggerOfflineReminder: () => {},
    addOrUpdateAccount: () => {},
    getAccounts: () => ({ accounts: [{ id: 'acct-1', name: 'A', code: 'x', platform: 'qq' }] }),
    deleteAccount: () => {},
  });
  assert.equal(manager.startWorker({ id: 'acct-1', name: 'A', code: 'x', platform: 'qq' }), true);
  const cleanup = () => createScheduler('worker_manager').clearAll();
  return { manager, proc, cleanup };
}

test('元数据两种传输形态保留；畸形/超长/非标量不当业务拒绝；额外属性不透传', { timeout: 5000 }, async () => {
  const { manager, proc, cleanup } = buildManagerHarness();
  try {
    const cases = [
      {
        name: 'JSON 往返保留',
        meta: JSON.parse(JSON.stringify({ business: true, code: 'PET_DIARY_LIMIT' })),
        expectBusiness: true,
        expectCode: 'PET_DIARY_LIMIT',
      },
      {
        name: 'structuredClone 保留',
        meta: structuredClone({ business: true, code: 'PET_DIARY_ALREADY' }),
        expectBusiness: true,
        expectCode: 'PET_DIARY_ALREADY',
      },
      {
        name: '旧式仅 error 字符串',
        meta: undefined,
        expectBusiness: false,
      },
      {
        name: '缺失 business',
        meta: { code: 'PET_DIARY_LIMIT' },
        expectBusiness: false,
      },
      {
        name: 'business 非严格布尔',
        meta: { business: 'true', code: 'PET_DIARY_LIMIT' },
        expectBusiness: false,
      },
      {
        name: 'code 非字符串',
        meta: { business: true, code: 42 },
        expectBusiness: false,
      },
      {
        name: 'code 超长',
        meta: { business: true, code: `PET_DIARY_${'A'.repeat(200)}` },
        expectBusiness: false,
      },
      {
        name: 'code 前缀不符',
        meta: { business: true, code: 'SOMETHING_ELSE' },
        expectBusiness: false,
      },
      {
        name: '数组形态',
        meta: [{ business: true, code: 'PET_DIARY_LIMIT' }],
        expectBusiness: false,
      },
      {
        name: '额外属性不透传',
        meta: {
          business: true, code: 'PET_DIARY_LIMIT',
          stack: 'SECRET_STACK', cause: { secret: true }, extra: ['x'],
        },
        expectBusiness: true,
        expectCode: 'PET_DIARY_LIMIT',
      },
    ];
    for (const c of cases) {
      const promise = manager.callWorkerApi('acct-1', 'operatePetDiary', 'feed', {});
      const call = proc.sent.find(m => m.type === 'api_call');
      assert.ok(call, `api_call dispatched (${c.name})`);
      proc.sent.length = 0;
      proc.emitMessage({
        type: 'api_response', id: call.id, result: null,
        error: '业务拒绝', errorMeta: c.meta,
      });
      const err = await rejectionOf(promise);
      if (c.expectBusiness) {
        assert.equal(err.business, true, `business restored (${c.name})`);
        assert.equal(err.code, c.expectCode, `code restored (${c.name})`);
        assert.equal(err.stack.includes('SECRET_STACK'), false, `stack not passed through (${c.name})`);
        assert.equal('cause' in err, false, `cause not passed through (${c.name})`);
        assert.equal('extra' in err, false, `extra props not passed through (${c.name})`);
      } else {
        assert.notEqual(err.business, true, `not business (${c.name})`);
        assert.equal(err.code, undefined, `no code (${c.name})`);
      }
    }
  } finally {
    cleanup();
  }
});

// ==================== 5. 请求关联：并发、乱序、超时迟到、重复 ====================

test('并发/乱序/重复响应不串单；超时后迟到响应无副作用；成功响应原样返回', { timeout: 5000 }, async () => {
  const { manager, proc, cleanup } = buildManagerHarness();
  try {
    // 成功响应原样返回
    const ok = manager.callWorkerApi('acct-1', 'operatePetDiary', 'draw', {});
    const call1 = proc.sent.find(m => m.type === 'api_call');
    proc.sent.length = 0;
    proc.emitMessage({ type: 'api_response', id: call1.id, result: { action: 'draw', rewards: [1] } });
    assert.deepEqual(await ok, { action: 'draw', rewards: [1] });

    // 并发 + 乱序响应
    const pA = manager.callWorkerApi('acct-1', 'operatePetDiary', 'feed', {});
    const pB = manager.callWorkerApi('acct-1', 'operatePetDiary', 'seeds', {});
    const [callA, callB] = proc.sent.filter(m => m.type === 'api_call');
    proc.sent.length = 0;
    proc.emitMessage({ type: 'api_response', id: callB.id, result: { which: 'B' } });
    proc.emitMessage({ type: 'api_response', id: callA.id, result: { which: 'A' } });
    assert.deepEqual(await pB, { which: 'B' });
    assert.deepEqual(await pA, { which: 'A' });

    // 重复响应：第二次为 no-op，不重复完成、不抛错
    proc.emitMessage({ type: 'api_response', id: callA.id, result: { which: 'A-dup' } });
    proc.emitMessage({ type: 'api_response', id: callB.id, error: 'dup error' });

    // 超时后迟到响应
    const late = manager.callWorkerApi('acct-1', 'operatePetDiary', 'compensation', { _timeoutMs: 5 });
    const callLate = proc.sent.find(m => m.type === 'api_call');
    proc.sent.length = 0;
    await assert.rejects(late, /API Timeout/);
    await new Promise(resolve => setTimeout(resolve, 20));
    proc.emitMessage({ type: 'api_response', id: callLate.id, result: { late: true } });
    proc.emitMessage({ type: 'api_response', id: callLate.id, error: 'late error' });

    // 完成请求不遗留计时器
    const snapshot = getSchedulerRegistrySnapshot('worker_manager');
    const leftover = snapshot.schedulers[0].tasks
      .map(t => t.name).filter(name => name.startsWith('api_timeout_'));
    assert.deepEqual(leftover, []);
  } finally {
    cleanup();
  }
});

// ==================== 6. 旧式 error 字符串响应仍正常拒绝 ====================

test('旧式仅含 error 字符串的响应仍正常拒绝为普通 Error', { timeout: 5000 }, async () => {
  const { manager, proc, cleanup } = buildManagerHarness();
  try {
    const promise = manager.callWorkerApi('acct-1', 'operatePetDiary', 'story', { order: 1 });
    const call = proc.sent.find(m => m.type === 'api_call');
    proc.emitMessage({
      type: 'api_response', id: call.id, result: null, error: '账号未就绪（未登录或连接未打开），请稍后重试',
    });
    const err = await rejectionOf(promise);
    assert.match(err.message, /账号未就绪/);
    assert.notEqual(err.business, true);
    assert.equal(err.code, undefined);
  } finally {
    cleanup();
  }
});
