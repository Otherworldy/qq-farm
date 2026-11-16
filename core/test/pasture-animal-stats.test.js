/**
 * 牧场动物档案：用真实养殖数据算经验/时、收入/时。
 *
 * 关键约定：没养过的动物查不到档案，购买策略必须退回按价格挑，绝不编造数值。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
process.env.FARM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pasture-stats-'));

const stats = require(path.join(ROOT, 'src/services/pasture-animal-stats.js'));

const HOUR = 3600_000;

function goods(animalId, price) {
    return { goodsId: animalId - 50000, animalId, price, unlocked: true };
}

test('没有档案时查不到，不会编造', () => {
    stats.resetAnimalStatsForTests();
    assert.equal(stats.getAnimalStats(60001), null);
});

test('按放栏→收获的真实周期算出每小时经验与收入', () => {
    stats.resetAnimalStatsForTests();
    const t0 = Date.now() - 2 * HOUR;

    // 记一只鸡：放栏 2 小时前
    stats.recordPlacement(7001, 60001, t0);
    // 这一轮的预期值
    stats.observeAnimals([{
        animalId: 60001, animalInstId: 7001,
        expectedHarvestExp: 30, expectedProduceExp: 10,
        expectedHarvestSells: [{ count: 20 }], expectedProduceSells: [{ count: 60 }],
    }]);
    // 2 小时后收获
    stats.recordHarvest([7001], Date.now());

    const s = stats.getAnimalStats(60001);
    assert.ok(s, '应该建档');
    assert.equal(s.totalExp, 40);
    assert.equal(s.totalGold, 80);
    assert.equal(s.cycleSamples, 1);
    // 周期约 2 小时 → 每小时 20 经验 / 40 金
    assert.ok(Math.abs(s.expPerHour - 20) < 1, `expPerHour 应约 20，实际 ${s.expPerHour}`);
    assert.ok(Math.abs(s.goldPerHour - 40) < 1, `goldPerHour 应约 40，实际 ${s.goldPerHour}`);
});

test('周期样本取中位数，异常值不放大', () => {
    stats.resetAnimalStatsForTests();
    const now = Date.now();
    const cycles = [1 * HOUR, 1 * HOUR, 1 * HOUR, 3 * HOUR];
    for (const [i, ms] of cycles.entries()) {
        stats.recordPlacement(8000 + i, 60002, now - ms);
        stats.observeAnimals([{ animalId: 60002, animalInstId: 8000 + i, expectedHarvestExp: 10 }]);
        stats.recordHarvest([8000 + i], now);
    }
    const s = stats.getAnimalStats(60002);
    assert.equal(s.cycleSamples, 4);
    // 中位数取中间两个（第 2、3 个都是 1h）
    assert.ok(Math.abs(s.cycleMs - 1 * HOUR) < 1000, `中位数应约 1h，实际 ${s.cycleMs}`);
});

test('周期明显不合理（<1 分钟）不采信', () => {
    stats.resetAnimalStatsForTests();
    const now = Date.now();
    stats.recordPlacement(9001, 60003, now - 5_000);
    stats.observeAnimals([{ animalId: 60003, animalInstId: 9001, expectedHarvestExp: 10 }]);
    stats.recordHarvest([9001], now);
    const s = stats.getAnimalStats(60003);
    assert.equal(s.cycleSamples, 0, '5 秒的周期不算样本');
});

test('cheapest 按价格升序', () => {
    const list = [goods(60003, 2712), goods(60001, 2), goods(60002, 1080)];
    assert.deepEqual(stats.rankAnimalGoods(list, 'cheapest').map(g => g.animalId), [60001, 60002, 60003]);
});

test('max_exp：有档案的按每小时经验排，没档案的排后面', () => {
    stats.resetAnimalStatsForTests();
    const now = Date.now();

    // 鸡：1 小时周期，共 10 经验 → 10/h
    stats.recordPlacement(100, 60001, now - 1 * HOUR);
    stats.observeAnimals([{ animalId: 60001, animalInstId: 100, expectedHarvestExp: 10 }]);
    stats.recordHarvest([100], now);

    // 鸭：1 小时周期，共 100 经验 → 100/h
    stats.recordPlacement(200, 60002, now - 1 * HOUR);
    stats.observeAnimals([{ animalId: 60002, animalInstId: 200, expectedHarvestExp: 100 }]);
    stats.recordHarvest([200], now);

    const list = [goods(60001, 2), goods(60002, 1080), goods(60003, 2712)];
    const ranked = stats.rankAnimalGoods(list, 'max_exp').map(g => g.animalId);
    assert.equal(ranked[0], 60002, '每小时经验最高的鸭排第一');
    assert.equal(ranked[1], 60001, '其次是有档案的鸡');
    assert.equal(ranked[2], 60003, '没档案的鹅排最后');
});

test('max_profit：扣掉买入价后比每小时收入', () => {
    stats.resetAnimalStatsForTests();
    const now = Date.now();

    // 鸡：1 小时赚 100，价格 2 → 净 98
    stats.recordPlacement(300, 60001, now - 1 * HOUR);
    stats.observeAnimals([{ animalId: 60001, animalInstId: 300, expectedHarvestSells: [{ count: 100 }] }]);
    stats.recordHarvest([300], now);

    // 鹅：1 小时赚 120，价格 2712 → 净 -2592
    stats.recordPlacement(400, 60003, now - 1 * HOUR);
    stats.observeAnimals([{ animalId: 60003, animalInstId: 400, expectedHarvestSells: [{ count: 120 }] }]);
    stats.recordHarvest([400], now);

    const list = [goods(60003, 2712), goods(60001, 2)];
    const ranked = stats.rankAnimalGoods(list, 'max_profit').map(g => g.animalId);
    assert.equal(ranked[0], 60001, '净收入更高的鸡排第一');
});

test('preferred 把指定动物提到最前，其余按价格', () => {
    const list = [goods(60001, 2), goods(60003, 2712), goods(60002, 1080)];
    const ranked = stats.rankAnimalGoods(list, 'preferred', 60003).map(g => g.animalId);
    assert.equal(ranked[0], 60003);
    assert.deepEqual(ranked.slice(1), [60001, 60002]);
});

test('存档能落盘并重新读回', async () => {
    stats.resetAnimalStatsForTests();
    const now = Date.now();
    stats.recordPlacement(500, 60005, now - 2 * HOUR);
    stats.observeAnimals([{ animalId: 60005, animalInstId: 500, expectedHarvestExp: 50 }]);
    stats.recordHarvest([500], now);

    // 等防抖落盘
    await new Promise(r => setTimeout(r, 2300));
    const file = path.join(process.env.FARM_DATA_DIR, 'pasture-animal-stats.json');
    assert.ok(fs.existsSync(file), '应写出档案文件');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(parsed['60005'], '文件里应有 60005');
    assert.equal(parsed['60005'].harvestExp, 50);
});
