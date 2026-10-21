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
