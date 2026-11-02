const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 种植回包刷新成熟日程（2026-11-01）。
// 背景：runFarmOperation 先取 AllLands 再种植，快照里没有新作物的成熟时刻；
// 如果这批地是全空的，下次空闲按 horizon=0 随机睡 1~120 分钟，短周期作物
// （白萝卜 1 分钟、大葱 20 分钟等 9 种都短于上限）会被睡过成熟点。
// 这里断言 PlantReply.land 里的成熟 begin_time 立刻进入调度口径，
// 不再依赖下一次 AllLands。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plant-maturity-'));
process.env.FARM_DATA_DIR = DATA_DIR;

const realUtils = require('../src/utils/utils');
const fakeNowSec = 1_700_000_000;
const MATURE_AT = fakeNowSec + 1200; // 20 分钟后成熟，短于 120 分钟睡眠上限

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

const utilsPath = require.resolve('../src/utils/utils');
const networkPath = require.resolve('../src/utils/network');
const warehousePath = require.resolve('../src/services/warehouse');
const farmApiPath = require.resolve('../src/services/farm-api');
const fertilizerPath = require.resolve('../src/services/farm-fertilizer');
const analyticsPath = require.resolve('../src/services/analytics');
const storePath = require.resolve('../src/models/store');

const realFarmApi = require('../src/services/farm-api');

require.cache[utilsPath] = mockModule(utilsPath, {
  ...realUtils,
  getServerTimeSec: () => fakeNowSec,
  getServerTimeMs: () => fakeNowSec * 1000,
  log: () => {},
  logWarn: () => {},
});

const EMPTY_LANDS = [1, 2, 3];

function plantedLand(landId, seedId) {
  return {
    id: landId,
    unlocked: true,
    plant: {
      id: 1020050,
      season: 1,
      phases: [
        { phase: 1, begin_time: fakeNowSec },
        { phase: 6, begin_time: MATURE_AT },
      ],
    },
    seed_id: seedId,
  };
}

require.cache[networkPath] = mockModule(networkPath, {
  sendMsgAsync: async (serviceName, methodName) => {
    const { types } = require('../src/utils/proto');
    if (methodName === 'AllLands') {
      // 种植前的快照：三块地全空，没有任何成熟时刻。
      return {
        body: types.AllLandsReply.encode(types.AllLandsReply.create({
          lands: EMPTY_LANDS.map(id => ({ id, unlocked: true })),
        })).finish(),
      };
    }
    if (methodName === 'Plant') {
      // 种植回包带新作物的成熟阶段，这正是被丢掉的信息。
      return {
        body: types.PlantReply.encode(types.PlantReply.create({
          land: EMPTY_LANDS.map(id => plantedLand(id, 20002)),
        })).finish(),
      };
    }
    return { body: new Uint8Array() };
  },
  getUserState: () => ({ accountId: 'fixture-account', level: 200, gold: 1_000_000 }),
  getWsErrorState: () => null,
  isConnected: () => true,
});

require.cache[warehousePath] = mockModule(warehousePath, {
  getBagSeeds: async () => [],
});
require.cache[farmApiPath] = mockModule(farmApiPath, {
  ...realFarmApi,
  getShopInfo: async () => ({
    goods_list: [{ id: 11, item_id: 20002, price: 2, unlocked: true, conds: [], limit_count: 0, bought_num: 0 }],
  }),
  buyGoods: async () => ({ get_items: [], cost_items: [{ id: 1, count: 2 }] }),
  getSeedShopId: async () => 1,
  removePlant: async () => ({}),
  getAllLands: async () => {
    const { types } = require('../src/utils/proto');
    const body = types.AllLandsReply.encode(types.AllLandsReply.create({
      lands: EMPTY_LANDS.map(id => ({ id, unlocked: true })),
    })).finish();
    return types.AllLandsReply.decode(body);
  },
  harvest: async () => ({ land: [] }),
  farming: async () => ({}),
  unlockLand: async () => ({}),
  upgradeLand: async () => ({}),
});
require.cache[fertilizerPath] = mockModule(fertilizerPath, {
  runFertilizerByConfig: async () => ({}),
});
require.cache[analyticsPath] = mockModule(analyticsPath, {
  getPlantRankings: () => [],
});
require.cache[storePath] = mockModule(storePath, {
  getPlantingStrategy: () => 'level',
  getPreferredSeed: () => 0,
  getBagSeedPriority: () => [],
  getBagSeedFallbackStrategy: () => 'level',
  getPrioritize2x2Crops: () => false,
  getPlantOrderRandom: () => false,
  getPlantDelaySeconds: () => 0,
  isAutomationOn: () => true,
  getAutomation: () => ({ farm: true, harvest: true, plant: true, fertilizer: 'none' }),
});

async function loadOrchestrator() {
  await require('../src/utils/proto').loadProto();
  return require('../src/services/farming-orchestrator');
}

test('种植回包里的成熟时刻立刻进入日程，不必等下一次 AllLands', async () => {
  const farm = await loadOrchestrator();
  // 种植前没有任何已知成熟时刻，这正是会长睡的形态。
  assert.equal(farm.getNextMatureInMs(), 0, '初始不应有成熟日程');

  await farm.runFarmOperation('all');

  const dueAt = farm.getNextMatureDueAtMs();
  assert.ok(dueAt > 0, '种植后应获得成熟墙钟');
  const remainMs = dueAt - Date.now();
  // 允许几次校时误差，但必须落在 20 分钟附近，而不是 0 或未知。
  assert.ok(
    Math.abs(remainMs - 1_200_000) < 60_000,
    `成熟墙钟应约为 20 分钟后，实际 ${Math.round(remainMs / 1000)}s`
  );
  assert.ok(farm.getNextMatureInMs() > 0, '成熟倒计时应为正数');
});
