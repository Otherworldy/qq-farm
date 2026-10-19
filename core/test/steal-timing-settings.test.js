const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-steal-timing-'));
process.env.FARM_DATA_DIR = dataDir;
process.env.FARM_ACCOUNT_ID = 'synthetic-steal-timing';

const store = require('../src/models/store');

const sourceRoot = path.join(__dirname, '..');
const workerSrc = fs.readFileSync(path.join(sourceRoot, 'src', 'core', 'worker.js'), 'utf8');
const visitSrc = fs.readFileSync(
  path.join(sourceRoot, 'src', 'services', 'friend-visit.js'),
  'utf8'
);
const limitsSrc = fs.readFileSync(
  path.join(sourceRoot, 'src', 'services', 'friend-operation-limits.js'),
  'utf8'
);

/** 按函数声明切出源码（与管理端既有测试同款的 `\n}` 边界）。 */
function sourceFunction(source, name) {
  const start = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(start, `existing production function ${name}`);
  const end = source.indexOf('\n}', start.index);
  assert.ok(end > start.index);
  return source.slice(start.index, end + 2);
}

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ==================== 偷菜延迟：设置 → store ====================

test('steal delay accepts an explicit zero instead of forcing the old default of one second', () => {
  store.applyConfigSnapshot({ stealDelaySeconds: 0 }, { accountId: 'synthetic-zero' });
  assert.equal(store.getStealDelaySeconds('synthetic-zero'), 0);
  assert.equal(store.getConfigSnapshot('synthetic-zero').stealDelaySeconds, 0);

  store.applyConfigSnapshot({ stealDelaySeconds: 7 }, { accountId: 'synthetic-seven' });
  assert.equal(store.getStealDelaySeconds('synthetic-seven'), 7);

  // 非法与越界值仍被夹回契约范围（0-60 整数）。
  store.applyConfigSnapshot({ stealDelaySeconds: -5 }, { accountId: 'synthetic-clamp-low' });
  assert.equal(store.getStealDelaySeconds('synthetic-clamp-low'), 0);
  store.applyConfigSnapshot({ stealDelaySeconds: 999 }, { accountId: 'synthetic-clamp-high' });
  assert.equal(store.getStealDelaySeconds('synthetic-clamp-high'), 60);
});

test('default account config keeps steal delay at zero so upstream behavior is unchanged', () => {
  const cfg = store.getDefaultAccountConfig();
  assert.equal(cfg.stealDelaySeconds, 0, 'default must not silently add a one second wait');
  // 区间默认值贴近接线前的真实行为（5-8 分钟）。
  assert.equal(cfg.intervals.stealMin, 300);
  assert.equal(cfg.intervals.stealMax, 480);
});

// ==================== 偷菜延迟：store → 真实上场动作 ====================

test('a steal action itself never waits: the delay lives on the maturity clock', () => {
  const waits = [];
  const sent = [];
  const ctx = {
    process: { env: { FARM_ACCOUNT_ID: 'synthetic-steal-timing' } },
    Date,
    types: {
      HarvestRequest: {
        encode: () => ({ finish: () => Buffer.alloc(0) }),
        create: input => input,
      },
      HarvestReply: { decode: () => ({ operation_limits: [] }) },
    },
    toLong: n => n,
    toNum: Number,
    sleep: ms => { waits.push(ms); return Promise.resolve(); },
    pauseSeconds: sec => { waits.push(sec * 1000); return Promise.resolve(); },
    sendMsgAsync: async () => { sent.push('Harvest'); return { body: Buffer.alloc(0) }; },
    withSelfEchoTicket: async (_op, _gid, _lands, rpc) => rpc(),
    updateOperationLimits: () => {},
    require: () => ({ setContentionMode: () => {} }),
  };
  vm.createContext(ctx);
  vm.runInContext(sourceFunction(limitsSrc, 'stealHarvest'), ctx);

  return ctx.stealHarvest(10001, [1, 2]).then(() => {
    // 关键语义：延迟是“成熟时刻 + N”，不是“发送前等 N”。
    assert.deepEqual(waits, [], 'the API boundary must not add a wait');
    assert.equal(sent.length, 1, 'the harvest request still fires once');
  });
});

test('every steal entry converges on the single un-delayed API boundary', () => {
  const start = limitsSrc.indexOf('async function stealHarvest');
  const end = limitsSrc.indexOf('\n}', start);
  const body = limitsSrc.slice(start, end);
  assert.doesNotMatch(body, /pauseSeconds\(/, 'no send-time wait at the API boundary');
  assert.doesNotMatch(body, /getStealDelaySeconds/, 'the delay is applied to due clocks, not here');
  assert.match(body, /setContentionMode\(true, Date\.now\(\) \+ 60_000\)/,
    'the contention grace still renews on every steal');
});

test('no other module can send a friend Harvest outside the single boundary', () => {
  // 全仓只有两处发出 PlantService.Harvest：自家收获（farm-api）与偷菜唯一出口。
  // 新增第三个发送点会绕过竞速宽限与到点偏移，必须当场红。
  const harvestSenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      // 发送点写法可能是同行或换行（friend-operation-limits 就是拆行调用）。
      if (/'gamepb\.plantpb\.PlantService'[\s\S]{0,80}?'Harvest'/.test(text)) {
        harvestSenders.push(path.relative(sourceRoot, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(sourceRoot, 'src'));

  assert.deepEqual(harvestSenders.sort(), [
    'src/services/farm-api.js',
    'src/services/friend-operation-limits.js',
  ], 'friend Harvest must only be sent by the own-farm path and the single steal boundary');
});

// ==================== 到点偏移：成熟时刻 + 延迟 ====================

/** 在沙箱里执行 worker 的偏移函数，返回它算出的偏移。 */
function stealOffsetInWorker({ delaySeconds, dueAt, gaussian }) {
  const ctx = {
    process: { env: { FARM_ACCOUNT_ID: 'synthetic-steal-timing' } },
    getStealDelaySeconds: () => delaySeconds,
    STEAL_DELAY_JITTER_RATIO: 0.05,
    stealDelayOffsetCache: { dueAt: 0, offsetMs: 0 },
    gaussianInt: gaussian || ((min, _max) => min),
  };
  vm.createContext(ctx);
  vm.runInContext(sourceFunction(workerSrc, 'stealDelayOffsetMsFor'), ctx);
  vm.runInContext(sourceFunction(workerSrc, 'effectiveStealDueAt'), ctx);
  return { offsetMs: ctx.stealDelayOffsetMsFor(dueAt), effective: ctx.effectiveStealDueAt(dueAt), ctx };
}

test('the configured seconds shift the maturity clock, not the send', () => {
  const dueAt = 1_760_000_000_000; // 10:00 成熟
  // gaussian 取上界 → 60 秒 + 5% = 63 秒
  const upper = stealOffsetInWorker({
    delaySeconds: 60, dueAt, gaussian: (_min, max) => max,
  });
  assert.equal(upper.offsetMs, 63_000, '60s delay jitters up to +5%');
  assert.equal(upper.effective, dueAt + 63_000, 'the steal fires at maturity + delay');

  // gaussian 取下界 → 60 秒 - 5% = 57 秒
  const lower = stealOffsetInWorker({
    delaySeconds: 60, dueAt, gaussian: (min, _max) => min,
  });
  assert.equal(lower.offsetMs, 57_000, '60s delay jitters down to -5%');

  // 你的例子：60 秒 → 10:01 前后 3 秒
  assert.ok(upper.effective - dueAt >= 57_000 && upper.effective - dueAt <= 63_000,
    '60s of delay lands within +/-3s of the one-minute mark');
});

test('a zero or unreadable delay leaves the maturity clock untouched', () => {
  const dueAt = 1_760_000_000_000;
  for (const delaySeconds of [0, undefined, Number.NaN]) {
    const { offsetMs, effective } = stealOffsetInWorker({ delaySeconds, dueAt });
    assert.equal(offsetMs, 0, 'no delay means no shift');
    assert.equal(effective, dueAt, 'the steal still fires exactly at maturity');
  }
  // 读取设置抛错也不能阻断偷菜。
  const ctx = {
    process: { env: { FARM_ACCOUNT_ID: 'synthetic-steal-timing' } },
    getStealDelaySeconds: () => { throw new Error('store unavailable'); },
    STEAL_DELAY_JITTER_RATIO: 0.05,
    stealDelayOffsetCache: { dueAt: 0, offsetMs: 0 },
    gaussianInt: (min) => min,
  };
  vm.createContext(ctx);
  vm.runInContext(sourceFunction(workerSrc, 'stealDelayOffsetMsFor'), ctx);
  assert.equal(ctx.stealDelayOffsetMsFor(dueAt), 0, 'a broken lookup falls back to no shift');
});

test('the same maturity keeps one offset across repeated re-arms, a new maturity re-rolls', () => {
  const dueAt = 1_760_000_000_000;
  let calls = 0;
  const ctx = {
    process: { env: { FARM_ACCOUNT_ID: 'synthetic-steal-timing' } },
    getStealDelaySeconds: () => 60,
    STEAL_DELAY_JITTER_RATIO: 0.05,
    stealDelayOffsetCache: { dueAt: 0, offsetMs: 0 },
    gaussianInt: (min, max) => { calls += 1; return calls === 1 ? min : max; },
  };
  vm.createContext(ctx);
  vm.runInContext(sourceFunction(workerSrc, 'stealDelayOffsetMsFor'), ctx);

  const first = ctx.stealDelayOffsetMsFor(dueAt);
  const second = ctx.stealDelayOffsetMsFor(dueAt);
  assert.equal(first, 57_000);
  assert.equal(second, first, 're-arming the same maturity must not drift the wake time');
  assert.equal(calls, 1, 'the jitter is drawn once per maturity');

  const next = ctx.stealDelayOffsetMsFor(dueAt + 86_400_000);
  assert.equal(next, 63_000, 'the next crop gets its own jitter draw');
});

test('the sentinel arms and pre-enters against the shifted clock', () => {
  const wake = workerSrc.slice(
    workerSrc.indexOf('function armStealWake'),
    workerSrc.indexOf('async function runStealTick')
  );
  assert.match(wake, /effectiveStealDueAt\(mergeDueAt\(/, 'wake clocks go through the shift');
  assert.match(wake, /markStealDueAt\(dueAt\)/, 'the shifted clock is what stealIsDue sees');

  const sentinel = workerSrc.slice(
    workerSrc.indexOf('function armMaturitySentinel'),
    workerSrc.indexOf('// 偷菜 due 连续')
  );
  assert.match(sentinel, /effectiveStealDueAt\(mergeDueAt\(/,
    'the arming window is measured to the shifted clock, not raw maturity');
  // 预进门复用 armed.dueAt（已是偏移后时刻），因此提前量自动对齐。
  const preEnter = workerSrc.slice(
    workerSrc.indexOf('function armSentinelPreEnter'),
    workerSrc.indexOf('async function runSentinelStrike')
  );
  assert.match(preEnter, /const dueAt = Number\(armed && armed\.dueAt\) \|\| 0;/);
});

test('the push fast lane honours the same maturity offset before firing', () => {
  const ripe = visitSrc.slice(
    visitSrc.indexOf('function fastLaneRipeLandIds'),
    visitSrc.indexOf('async function fastLaneDailyText')
  );
  assert.match(ripe, /delaySec = 0/, 'the ripe filter takes the configured delay');
  assert.match(ripe, /begin \+ delayFloorSec <= serverSec/,
    'a land only counts as ripe once maturity + delay has passed');
  // 抖动下限现在收敛在共享的 stealDelayFloorSec 里，执行器闸门与快车道必须同口径。
  const floorFn = visitSrc.slice(
    visitSrc.indexOf('function stealDelayFloorSec'),
    visitSrc.indexOf('/** 面板配置的偷菜延迟秒数')
  );
  assert.match(floorFn, /Math\.floor\(Number\(delaySec\) \* 0\.95\)/,
    'the shared floor respects the lower jitter bound so it never fires early');
  assert.match(ripe, /stealDelayFloorSec\(delaySec\)/,
    'the fast lane goes through the shared floor, not its own copy');

  const lane = visitSrc.slice(
    visitSrc.indexOf('async function fastLaneSteal'),
    visitSrc.indexOf('async function maybeLurkLeave')
  );
  assert.match(lane, /fastLaneRipeLandIds\(lands, \{ delaySec: stealDelaySec \}\)/,
    'the lane passes the configured delay into the ripe filter');
  assert.doesNotMatch(lane, /pauseSeconds/, 'the lane must not sit and wait');
});

test('fastLaneRipeLandIds only reports lands past maturity plus delay', () => {
  const nowSec = 1_760_000_000;
  const now = nowSec * 1000;
  const land = (id, matureAtSec) => ({
    id,
    plant: { id: 1, phases: [{ phase: 5, begin_time: matureAtSec - 60 }, { phase: 6, begin_time: matureAtSec }] },
  });
  const lands = [
    land(1, nowSec - 120), // 两分钟前就熟了
    land(2, nowSec - 30),  // 刚熟 30 秒
    land(3, nowSec + 30),  // 还没熟
  ];
  const ctx = {
    toNum: Number,
    toTimeSec: toTimeSecForTests,
    Date: { now: () => now },
    stealDelayFloorSec: (delaySec) => Math.max(0, Math.floor(Number(delaySec) * 0.95) || 0),
  };
  vm.createContext(ctx);
  for (const fn of ['landMatureAtSec', 'fastLaneRipeLandIds']) {
    vm.runInContext(sourceFunction(visitSrc, fn), ctx);
  }

  // vm 在另一个 realm 建数组，展开成本 realm 数组再比较原型。
  assert.deepEqual([...ctx.fastLaneRipeLandIds(lands)], [1, 2], 'no delay: everything already ripe');
  assert.deepEqual([...ctx.fastLaneRipeLandIds(lands, { delaySec: 60, now })],
    [1], '60s delay: the 30-second-old crop must wait, the 2-minute-old one is past it');
  assert.deepEqual([...ctx.fastLaneRipeLandIds(lands, { delaySec: 300, now })],
    [], '5-minute delay: even the 2-minute-old crop waits');
});

// ==================== 到点偏移：执行器按地块真实成熟时刻收口 ====================

/** 与生产同口径的秒/毫秒归一，供沙箱注入（landMatureAtSec 读它）。 */
const toTimeSecForTests = (val) => {
  const n = Number(val) || 0;
  if (n <= 0) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : n;
};

function delayGateInSandbox({ lands, stealable, delaySeconds, now }) {
  const ctx = {
    toNum: Number,
    toTimeSec: toTimeSecForTests,
    Date,
    getStealDelaySeconds: () => delaySeconds,
    process: { env: { FARM_ACCOUNT_ID: 'synthetic-steal-timing' } },
    analysis: { stealable: [...stealable], stealableInfo: stealable.map(landId => ({ landId })) },
    lands,
  };
  vm.createContext(ctx);
  for (const fn of ['stealDelayFloorSec', 'configuredStealDelaySec', 'landMatureAtSec', 'applyStealDelayGate']) {
    vm.runInContext(sourceFunction(visitSrc, fn), ctx);
  }
  const gate = ctx.applyStealDelayGate(ctx.analysis, ctx.lands, now == null ? {} : { now });
  return { gate, stealable: [...ctx.analysis.stealable] };
}

test('the executor drops lands still inside the delay window and keeps the ripened-out ones', () => {
  const nowSec = 1_760_000_000;
  const now = nowSec * 1000;
  const land = (id, matureAtSec) => ({
    id,
    plant: { id: 1, phases: [{ phase: 5, begin_time: matureAtSec - 60 }, { phase: 6, begin_time: matureAtSec }] },
  });
  const lands = [
    land(1, nowSec - 120), // 两分钟前就熟了
    land(2, nowSec - 30),  // 刚熟 30 秒
    land(3, nowSec + 30),  // 还没熟
  ];

  // 不设延迟：行为与接线前一致，看到能偷就偷。
  const off = delayGateInSandbox({ lands, stealable: [1, 2], delaySeconds: 0, now });
  assert.deepEqual(off.stealable, [1, 2], 'no delay: every stealable land is left alone');
  assert.equal(off.gate.delayedLands, 0);

  // 60 秒延迟：刚熟 30 秒的地块必须等，两分钟前熟透的照常出手。
  const on = delayGateInSandbox({ lands, stealable: [1, 2], delaySeconds: 60, now });
  assert.deepEqual(on.stealable, [1], 'the 30-second-old crop must wait, the 2-minute-old one is past it');
  assert.equal(on.gate.delayedLands, 1, 'the gate reports how many lands it held back');
  // 重试时刻钳回该地块的真实成熟点，不凭空拉长。
  assert.equal(on.gate.earliestDelayedMatureAtMs, (nowSec - 30) * 1000,
    'the retry is pinned to the real maturity of the held-back land');
});

test('the maturity gate never blocks a crop whose maturity is unknown', () => {
  const now = 1_760_000_000_000;
  // 服务端没给 phases（摘要来的目标、或阶段被裁剪）——无法判断就不拦。
  const lands = [{ id: 1, plant: { id: 1 } }, { id: 2 }, { id: 3, plant: { phases: [] } }];
  const { gate, stealable } = delayGateInSandbox({
    lands, stealable: [1, 2, 3], delaySeconds: 60, now,
  });
  assert.deepEqual(stealable, [1, 2, 3], 'an unknown maturity must not cost us the steal');
  assert.equal(gate.delayedLands, 0);
});

test('the gate holds back a land maturing exactly inside the jitter floor', () => {
  const nowSec = 1_760_000_000;
  const now = nowSec * 1000;
  const land = (id, matureAtSec) => ({
    id,
    plant: { id: 1, phases: [{ phase: 5, begin_time: matureAtSec - 60 }, { phase: 6, begin_time: matureAtSec }] },
  });
  // 60 秒延迟的抖动下限是 57 秒：56 秒前熟的要等，57 秒前熟的已过下界。
  const lands = [land(1, nowSec - 56), land(2, nowSec - 57)];
  const { stealable } = delayGateInSandbox({ lands, stealable: [1, 2], delaySeconds: 60, now });
  assert.deepEqual(stealable, [2],
    'the gate uses the same +/-5% floor as the push fast lane so it can never fire early');
});

// ==================== 被延迟挡下的地块必须钉回盯梢，不能白送 ====================

test('a land held back by the delay is re-armed on the watch clock instead of being lost', () => {
  const fertilizerWatch = require('../src/services/fertilizer-watch');
  const friendVisit = require('../src/services/friend-visit');
  fertilizerWatch.resetFertilizerWatchForTests();
  store.applyConfigSnapshot({ stealDelaySeconds: 60 }, { accountId: 'synthetic-steal-timing' });

  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const lands = [{
    id: 1,
    plant: { id: 1, phases: [{ phase: 5, begin_time: nowSec - 60 }, { phase: 6, begin_time: nowSec - 10 }] },
  }];
  const analysis = { stealable: [1], stealableInfo: [{ landId: 1, name: 'A' }] };

  friendVisit.gateStealByMaturityForTests(424242, '延迟好友', analysis, lands);

  assert.deepEqual(analysis.stealable, [], 'the just-ripened land is held back this round');
  const state = fertilizerWatch.getWatchStateForTests(424242, now);
  assert.ok(state, 'the held-back land must be pinned back onto the watch, not dropped');
  assert.equal(state.status, fertilizerWatch.WATCH_STATUS.PREARM);
  // 盯梢保存原始成熟时刻；偏移由 worker 的 effectiveStealDueAt 统一施加，不叠加两次。
  assert.equal(state.ripeAt, (nowSec - 10) * 1000,
    'the watch keeps the raw maturity so the single worker offset still applies once');
  // 到点时刻不得夹成“现在”：地块已经熟了 10 秒，再夹一次等于把延迟重计一遍，
  // 实际会等成接近 2N（最多约 120 秒），期间菜可能被在线主人收走。
  assert.equal(state.nextVisitAt, (nowSec - 10) * 1000,
    'the elapsed part of the delay must be kept, not restarted from now');

  // 没有延迟时不得凭空布控。
  fertilizerWatch.resetFertilizerWatchForTests();
  store.applyConfigSnapshot({ stealDelaySeconds: 0 }, { accountId: 'synthetic-steal-timing' });
  const fresh = { stealable: [1], stealableInfo: [{ landId: 1, name: 'A' }] };
  friendVisit.gateStealByMaturityForTests(424243, '不延迟好友', fresh, lands);
  assert.deepEqual(fresh.stealable, [1], 'no delay: the steal still fires on the spot');
  assert.equal(fertilizerWatch.getWatchStateForTests(424243, now), null,
    'no delay means no extra watch is invented');
  fertilizerWatch.resetFertilizerWatchForTests();
});

test('the maturity reader uses the same second-based clock as every other phases reader', () => {
  // proto 的 begin_time 是 int64，可能以毫秒出现。假设一个毫秒值被当成秒，
  // 闸门就会恒不成立，把地块永久挡住（fail-closed）——必须与全仓同口径走 toTimeSec。
  const ctx = {
    toNum: Number,
    toTimeSec: toTimeSecForTests,
  };
  vm.createContext(ctx);
  vm.runInContext(sourceFunction(visitSrc, 'landMatureAtSec'), ctx);

  const sec = 1_760_000_000;
  assert.equal(ctx.landMatureAtSec({ plant: { phases: [{ begin_time: sec }] } }), sec,
    'a second-based begin_time passes through');
  assert.equal(ctx.landMatureAtSec({ plant: { phases: [{ begin_time: sec * 1000 }] } }), sec,
    'a millisecond-based begin_time is converted, not treated as seconds');
  assert.equal(ctx.landMatureAtSec({ plant: { phases: [{ beginTime: sec }] } }), sec,
    'the camelCase field is read too');
  assert.equal(ctx.landMatureAtSec({ plant: { phases: [] } }), 0, 'no phases means unknown');
  assert.equal(ctx.landMatureAtSec({ plant: {} }), 0, 'no phases means unknown');
  assert.equal(ctx.landMatureAtSec({}), 0, 'no plant means unknown');
});

// ==================== 旧默认值迁移 ====================

test('legacy 25/30 second defaults are upgraded once and a user-set value stays untouched', () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-steal-migrate-'));
  try {
    fs.writeFileSync(path.join(legacyDir, 'store.json'), JSON.stringify({
      accountConfigs: {
        // 旧面板默认值：从未生效过，应升级为新默认。
        'legacy-account': { intervals: { stealMin: 25, stealMax: 30 } },
        // 用户自己调过的值：必须原样保留。
        'tuned-account': { intervals: { stealMin: 60, stealMax: 90 } },
      },
      userDefaultAccountPlans: {
        alice: { enabled: true, config: { intervals: { stealMin: 25, stealMax: 30 } } },
      },
      ui: { theme: 'dark' },
    }));

    // 独立进程加载，避免污染本文件已缓存的 store 状态。
    // 必须清掉 FARM_ACCOUNT_ID：迁移与回盘只由 master 进程执行。
    const script = `
      process.env.FARM_DATA_DIR = ${JSON.stringify(legacyDir)};
      delete process.env.FARM_ACCOUNT_ID;
      const store = require(${JSON.stringify(path.join(sourceRoot, 'src', 'models', 'store.js'))});
      process.stdout.write(JSON.stringify({
        legacy: store.getIntervals('legacy-account'),
        tuned: store.getIntervals('tuned-account'),
        plan: store.getUserDefaultAccountPlan('alice').config.intervals,
      }));
    `;
    const run = () => JSON.parse(require('node:child_process').execFileSync(
      process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ));

    const first = run();
    assert.equal(first.legacy.stealMin, 300, 'legacy default upgraded to the new minimum');
    assert.equal(first.legacy.stealMax, 480, 'legacy default upgraded to the new maximum');
    assert.equal(first.tuned.stealMin, 60, 'user-tuned minimum preserved');
    assert.equal(first.tuned.stealMax, 90, 'user-tuned maximum preserved');
    assert.equal(first.plan.stealMin, 300, 'default plan templates are migrated too');
    assert.equal(first.plan.stealMax, 480);

    // 迁移只做一次：二次启动不再改动存盘内容。
    const stored = fs.readFileSync(path.join(legacyDir, 'store.json'), 'utf8');
    assert.match(stored, /"stealIntervalDefaultsMigrated": true/);
    const second = run();
    assert.deepEqual(second, first, 'a second start changes nothing');
    assert.equal(fs.readFileSync(path.join(legacyDir, 'store.json'), 'utf8'), stored,
      'no rewrite on the second start');
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

test('the panel interval is converted to runtime milliseconds, and a missing max keeps a real range', () => {
  const ctx = {
    CONFIG: { farmCheckInterval: 8000 },
    getFriendQuietHours: () => ({}),
  };
  vm.createContext(ctx);
  vm.runInContext(sourceFunction(workerSrc, 'normalizeIntervalRangeSec'), ctx);
  vm.runInContext(sourceFunction(workerSrc, 'applyIntervalsToRuntime'), ctx);

  ctx.applyIntervalsToRuntime({ stealMin: 30, stealMax: 45 });
  assert.equal(ctx.CONFIG.stealCheckIntervalMin, 30_000, 'min seconds -> milliseconds');
  assert.equal(ctx.CONFIG.stealCheckIntervalMax, 45_000, 'max seconds -> milliseconds');

  // 只给 min 不给 max：max 必须回到自己的默认（480 秒），不得塌成 min。
  ctx.applyIntervalsToRuntime({ stealMin: 30 });
  assert.equal(ctx.CONFIG.stealCheckIntervalMin, 30_000);
  assert.equal(ctx.CONFIG.stealCheckIntervalMax, 480_000,
    'a missing max keeps the 480 second default instead of collapsing to min');

  // 两端都缺：完整回落 300-480 秒。
  ctx.applyIntervalsToRuntime({});
  assert.equal(ctx.CONFIG.stealCheckIntervalMin, 300_000);
  assert.equal(ctx.CONFIG.stealCheckIntervalMax, 480_000);
});

test('a fresh install migrates nothing and writes no store file', () => {
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-steal-fresh-'));
  try {
    const script = `
      process.env.FARM_DATA_DIR = ${JSON.stringify(freshDir)};
      delete process.env.FARM_ACCOUNT_ID;
      const store = require(${JSON.stringify(path.join(sourceRoot, 'src', 'models', 'store.js'))});
      process.stdout.write(JSON.stringify(store.getIntervals('fresh-account')));
    `;
    const intervals = JSON.parse(require('node:child_process').execFileSync(
      process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ));
    assert.equal(intervals.stealMin, 300);
    assert.equal(intervals.stealMax, 480);
    assert.equal(fs.existsSync(path.join(freshDir, 'store.json')), false,
      'nothing to migrate means zero writes on a fresh install');
  } finally {
    fs.rmSync(freshDir, { recursive: true, force: true });
  }
});

test('an account worker never rewrites the shared store during migration', () => {
  const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-steal-worker-'));
  try {
    fs.writeFileSync(path.join(workerDir, 'store.json'), JSON.stringify({
      accountConfigs: { 'legacy-account': { intervals: { stealMin: 25, stealMax: 30 } } },
      ui: { theme: 'dark' },
    }));
    const before = fs.readFileSync(path.join(workerDir, 'store.json'), 'utf8');
    const script = `
      process.env.FARM_DATA_DIR = ${JSON.stringify(workerDir)};
      process.env.FARM_ACCOUNT_ID = 'legacy-account';
      require(${JSON.stringify(path.join(sourceRoot, 'src', 'models', 'store.js'))});
    `;
    require('node:child_process').execFileSync(
      process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    assert.equal(fs.readFileSync(path.join(workerDir, 'store.json'), 'utf8'), before,
      'worker must leave the migration（和回盘）给 master 进程');
  } finally {
    fs.rmSync(workerDir, { recursive: true, force: true });
  }
});

test('a thread worker never rewrites the shared store during migration', () => {
  // 真实默认形态是 worker_threads（runtime-engine 默认 runtimeMode='thread'）：
  // 它在 require store 之后才把 FARM_ACCOUNT_ID 写进自己的 env，加载瞬间 env 为空，
  // 所以单靠 FARM_ACCOUNT_ID 判定挡不住。用真实 worker 线程复现该时序。
  const { Worker } = require('node:worker_threads');
  const threadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-steal-thread-'));
  try {
    fs.writeFileSync(path.join(threadDir, 'store.json'), JSON.stringify({
      accountConfigs: { 'legacy-account': { intervals: { stealMin: 25, stealMax: 30 } } },
      ui: { theme: 'dark' },
    }));
    const before = fs.readFileSync(path.join(threadDir, 'store.json'), 'utf8');

    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      process.env.FARM_DATA_DIR = workerData.dataDir;
      // 生产 master 不设 FARM_ACCOUNT_ID（各 worker 自己持有），线程默认继承父环境，
      // 所以必须先清掉才能复现真实时序。
      delete process.env.FARM_ACCOUNT_ID;
      // 与生产 worker.js 同款时序：先 require store，再设账号 env。
      require(workerData.storePath);
      if (!process.env.FARM_ACCOUNT_ID) process.env.FARM_ACCOUNT_ID = workerData.accountId;
      parentPort.postMessage('done');
    `;
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        dataDir: threadDir,
        accountId: 'legacy-account',
        storePath: path.join(sourceRoot, 'src', 'models', 'store.js'),
      },
    });

    const done = new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    return done.then(() => {
      assert.equal(fs.readFileSync(path.join(threadDir, 'store.json'), 'utf8'), before,
        'a thread worker must leave the migration write to the master process');
    }).finally(() => worker.terminate());
  } finally {
    // waitForThread 已在上方 finally 里终止线程；此处只清理目录。
    setTimeout(() => fs.rmSync(threadDir, { recursive: true, force: true }), 200).unref?.();
  }
});

// ==================== 偷菜巡查间隔：设置 → CONFIG → 重新发现延迟 ====================

test('the configured steal interval drives the rediscovery delay within its range', () => {
  const ctx = {
    CONFIG: { stealCheckIntervalMin: 20_000, stealCheckIntervalMax: 40_000 },
    STEAL_REDISCOVERY_MIN_MS: 5 * 60_000,
    STEAL_REDISCOVERY_MAX_MS: 8 * 60_000,
    gaussianInt: (min, max) => {
      assert.ok(min >= 20_000 && max <= 40_000, `sampled ${min}-${max} must stay in the configured range`);
      return min;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(sourceFunction(workerSrc, 'stealRediscoveryDelayMs'), ctx);
  assert.equal(ctx.stealRediscoveryDelayMs(), 20_000);
});

test('an unconfigured interval falls back to the five-to-eight-minute baseline', () => {
  for (const config of [{}, { stealCheckIntervalMin: 0, stealCheckIntervalMax: 0 }]) {
    const ctx = {
      CONFIG: config,
      STEAL_REDISCOVERY_MIN_MS: 5 * 60_000,
      STEAL_REDISCOVERY_MAX_MS: 8 * 60_000,
      gaussianInt: (min, max) => {
        assert.equal(min, 5 * 60_000, 'fallback lower bound');
        assert.equal(max, 8 * 60_000, 'fallback upper bound');
        return max;
      },
    };
    vm.createContext(ctx);
    vm.runInContext(sourceFunction(workerSrc, 'stealRediscoveryDelayMs'), ctx);
    // 断言真实返回值，而不是只看 stub 收到的参数。
    assert.equal(ctx.stealRediscoveryDelayMs(), 8 * 60_000);
  }
});

test('an inverted interval is ordered rather than sampled backwards', () => {
  const ctx = {
    CONFIG: { stealCheckIntervalMin: 90_000, stealCheckIntervalMax: 30_000 },
    STEAL_REDISCOVERY_MIN_MS: 5 * 60_000,
    STEAL_REDISCOVERY_MAX_MS: 8 * 60_000,
    gaussianInt: (min, max) => {
      assert.ok(min <= max, `lower bound ${min} must not exceed upper bound ${max}`);
      return min;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(sourceFunction(workerSrc, 'stealRediscoveryDelayMs'), ctx);
  assert.equal(ctx.stealRediscoveryDelayMs(), 30_000, 'explicit values win over the fallback');
});
