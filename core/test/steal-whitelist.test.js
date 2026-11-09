const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steal-whitelist-'));
process.env.FARM_DATA_DIR = dataDir;

const store = require('../src/models/store');
const { analyzeFriendLands } = require('../src/services/friend-land-analyzer');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const SEED_A = 900001;
const SEED_B = 900002;
const SEED_C = 900003;

function matureLand(id, seedId) {
  return {
    id,
    plant: {
      id: seedId,
      seed_id: seedId,
      stealable: true,
      phases: [{ phase: 6, begin_time: 1 }],
    },
  };
}

const lands = [matureLand(1, SEED_A), matureLand(2, SEED_B), matureLand(3, SEED_C)];

test('no whitelist steals every mature land', () => {
  const analysis = analyzeFriendLands(lands, 100, 'test', {});
  assert.deepEqual([...analysis.stealable].sort((a, b) => a - b), [1, 2, 3]);
});

test('whitelist restricts stealing to the listed seeds', () => {
  const analysis = analyzeFriendLands(lands, 100, 'test', { stealWhitelist: [SEED_B] });
  assert.deepEqual(analysis.stealable, [2]);
  assert.equal(analysis.stealableInfo.length, 1);
  assert.equal(analysis.stealableInfo[0].landId, 2);
});

test('whitelist records every land it skipped and why', () => {
  const analysis = analyzeFriendLands(lands, 100, 'test', { stealWhitelist: [SEED_B] });
  assert.deepEqual([...analysis.stealSkipped].map(s => s.landId).sort((a, b) => a - b), [1, 3]);
  assert.ok(analysis.stealSkipped.every(s => s.reason === 'whitelist'));
  assert.ok(analysis.stealSkipped.every(s => s.seedId === SEED_A || s.seedId === SEED_C));
});

test('blacklist skips are recorded with their own reason', () => {
  const analysis = analyzeFriendLands(lands, 100, 'test', {
    stealWhitelist: [],
    plantBlacklist: [SEED_C],
  });
  assert.deepEqual(analysis.stealSkipped.map(s => s.landId), [3]);
  assert.equal(analysis.stealSkipped[0].reason, 'blacklist');
});

test('nothing is recorded as skipped when no crop rule is set', () => {
  const analysis = analyzeFriendLands(lands, 100, 'test', {});
  assert.deepEqual(analysis.stealSkipped, []);
});

test('whitelist without a match steals nothing', () => {
  const analysis = analyzeFriendLands(lands, 100, 'test', { stealWhitelist: [123456] });
  assert.deepEqual(analysis.stealable, []);
  assert.deepEqual(analysis.stealableInfo, []);
});

test('empty whitelist keeps the blacklist behaviour', () => {
  const analysis = analyzeFriendLands(lands, 100, 'test', {
    stealWhitelist: [],
    plantBlacklist: [SEED_A],
  });
  assert.deepEqual([...analysis.stealable].sort((a, b) => a - b), [2, 3]);
});

test('whitelist takes precedence over the blacklist', () => {
  const analysis = analyzeFriendLands(lands, 100, 'test', {
    stealWhitelist: [SEED_A],
    plantBlacklist: [SEED_A],
  });
  assert.deepEqual(analysis.stealable, [1]);
});

// 2026-11-09 线上事故：偷完 24 块后服务端仍报可偷（stealable=true、摘要继续
// 报 steal_plant_num），而旧过滤读的是不存在的 steal_player/steal_num，因此
// 同一批地每轮都白进一次门。现在用真实字段 stealers 剔除已偷地块。
test('本人已偷过的地块不再算可偷（stealers 含自己）', () => {
  const withStealers = [
    { id: 1, plant: { id: SEED_A, seed_id: SEED_A, stealable: true, stealers: [100], phases: [{ phase: 6, begin_time: 1 }] } },
    { id: 2, plant: { id: SEED_B, seed_id: SEED_B, stealable: true, stealers: [200], phases: [{ phase: 6, begin_time: 1 }] } },
    { id: 3, plant: { id: SEED_C, seed_id: SEED_C, stealable: true, phases: [{ phase: 6, begin_time: 1 }] } },
  ];
  const analysis = analyzeFriendLands(withStealers, 100, 'test', {});
  assert.deepEqual([...analysis.stealable].sort((a, b) => a - b), [2, 3]);
  assert.deepEqual(analysis.stealableInfo.map(info => info.landId).sort((a, b) => a - b), [2, 3]);
  assert.deepEqual(analysis.stealSkipped.map(item => item.landId), [1]);
  assert.equal(analysis.stealSkipped[0].reason, 'already_stolen');
});

test('stealers 缺省或为空时绝不凭空否认可偷', () => {
  assert.deepEqual(analyzeFriendLands(lands, 100, 'test', {}).stealable.sort((a, b) => a - b), [1, 2, 3]);
  const emptyStealers = [
    { id: 1, plant: { id: SEED_A, seed_id: SEED_A, stealable: true, stealers: [], phases: [{ phase: 6, begin_time: 1 }] } },
  ];
  assert.deepEqual(analyzeFriendLands(emptyStealers, 100, 'test', {}).stealable, [1]);
  // myGid 未知时不能用 0 去匹配，也不应过滤任何地块
  const noSelf = [
    { id: 1, plant: { id: SEED_A, seed_id: SEED_A, stealable: true, stealers: [0], phases: [{ phase: 6, begin_time: 1 }] } },
  ];
  assert.deepEqual(analyzeFriendLands(noSelf, 0, 'test', {}).stealable, [1]);
});

test('getUserState picks up the worker account id from the environment', () => {
  process.env.FARM_ACCOUNT_ID = 'acc-from-env';
  const { getUserState } = require('../src/utils/network');
  assert.equal(getUserState().accountId, 'acc-from-env');
  assert.deepEqual(store.getStealWhitelist(getUserState().accountId), []);
  store.setStealWhitelist('acc-from-env', [SEED_A]);
  assert.deepEqual(store.getStealWhitelist(getUserState().accountId), [SEED_A]);
});

test('store persists the whitelist independently of the blacklist', () => {
  const accountId = 'acc-steal-whitelist';
  assert.deepEqual(store.getStealWhitelist(accountId), []);
  assert.deepEqual(store.setStealWhitelist(accountId, [SEED_A, 'x', 0, null]), [SEED_A]);
  assert.deepEqual(store.getStealWhitelist(accountId), [SEED_A]);
  assert.equal(store.getPlantBlacklist(accountId).includes(SEED_A), false);
  assert.deepEqual(store.setStealWhitelist(accountId, []), []);
  assert.deepEqual(store.getStealWhitelist(accountId), []);
});
