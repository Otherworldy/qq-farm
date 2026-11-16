/**
 * 牧场分析器测试
 *
 * fixture 用 2026-11-16 真机抓包解出的真实 RanchInfo 结构（字段名与取值原样抄自
 * gate-obt.nqf.qq.com 的 HarvestRanch / GetRanchDetail 回包），
 * 这样分析器一旦按错字段名就会立刻失败。
 */

const test = require('node:test');
const assert = require('node:assert');

const { analyzeRanches, msUntilNextProduce } = require('../src/services/pasture-analyzer');

/** 抓包实测：一只成熟待收的动物（stage 3，can_harvest 未置位但 producing） */
function realRanch(overrides = {}) {
    return {
        ranch_inst_id: 10001,
        capacity: 4,
        animal_count: 4,
        animals: [
            {
                // 可收获
                ranch_inst_id: 10001,
                slot_index: 1,
                animal_inst_id: 7,
                animal_id: 60002,
                stage: 3,
                produce_count: 1,
                can_harvest: true,
                can_feed: false,
                grow_ready_at_ms: 1794811541927,
                produce_ready_at_ms: 1794818744037,
                expected_harvest_exp: 360,
                expected_harvest_sells: [{ id: 1007, count: 2160 }],
                expected_produce_exp: 180,
                expected_produce_sells: [{ id: 1007, count: 1620 }],
                mutation: { mutation_type: 0, tier: 2, weight_final_x10: 150, strokable: true },
            },
            {
                // 需投喂
                ranch_inst_id: 10001,
                slot_index: 2,
                animal_inst_id: 8,
                animal_id: 60002,
                stage: 1,
                can_harvest: false,
                can_feed: true,
                grow_ready_at_ms: 1794814989657,
                infant_ready_at_ms: 1794811389657,
            },
            {
                // 生产中，等时间
                ranch_inst_id: 10001,
                slot_index: 3,
                animal_inst_id: 11,
                animal_id: 60003,
                stage: 4,
                can_harvest: false,
                can_feed: false,
                producing: true,
                produce_ready_at_ms: 1794822956272,
            },
            {
                // 缺草阻塞，不需要投喂（服务端没给 can_feed）
                ranch_inst_id: 10001,
                slot_index: 4,
                animal_inst_id: 12,
                animal_id: 60003,
                stage: 2,
                can_harvest: false,
                can_feed: false,
                grass_blocked: true,
            },
        ],
        grass: { amount: 12, empty_at_ms: 0 },
        shelves: [
            { slot_index: 1, total_remain: 40, can_collect: true, can_steal: false,
                lots: [{ item_id: 1007, remain_num: 40, can_steal: false, stealers: [] }] },
            { slot_index: 2, total_remain: 5, can_collect: false, can_steal: true,
                lots: [{ item_id: 1007, remain_num: 5, can_steal: true, stealers: [999] }] },
        ],
        hazards: [
            { hazard_id: 501, owner: 111, hazard_type: 1 },
        ],
        ...overrides,
    };
}

test('analyzeRanches：按服务端布尔标志分类', () => {
    const a = analyzeRanches([realRanch()], { now: 1794810000000 });

    assert.equal(a.harvestable.length, 1, 'can_harvest=true 的动物进 harvestable');
    assert.equal(a.harvestable[0].animalInstId, 7);
    assert.equal(a.harvestable[0].animalId, 60002);

    assert.equal(a.needFeed.length, 1, 'can_feed=true 的动物进 needFeed');
    assert.equal(a.needFeed[0].animalInstId, 8);

    assert.equal(a.producing.length, 1, 'producing 但不可收获的进 producing');
    assert.equal(a.producing[0].animalInstId, 11);

    assert.equal(a.collectableShelves.length, 1, 'can_collect 的货架');
    assert.equal(a.collectableShelves[0].slotIndex, 1);
    assert.equal(a.collectableShelves[0].lots[0].remainNum, 40);

    assert.equal(a.stealableShelves.length, 1, 'can_steal 的货架');
    assert.equal(a.stealableShelves[0].lots[0].stealerCount, 1);

    assert.equal(a.needClean.length, 1);
    assert.equal(a.needClean[0].hazardId, 501);
});

test('analyzeRanches：草量阈值与空栏', () => {
    const low = analyzeRanches([realRanch()]);
    assert.equal(low.grassAmount, 12);
    assert.equal(low.grassLow, true, '草 12 低于阈值 20');

    const high = analyzeRanches([realRanch({ grass: { amount: 72, empty_at_ms: 0 } })]);
    assert.equal(high.grassLow, false, '草 72 不触发补草');
});

test('analyzeRanches：空栏按 capacity 减已占用推算', () => {
    const ranch = realRanch();
    // 只用掉 slot 1 和 3，2/4 应由分析器算成空栏
    ranch.animals = [ranch.animals[0], ranch.animals[2]];
    ranch.capacity = 4;
    const a = analyzeRanches([ranch]);
    assert.deepEqual(
        a.emptySlots.map(s => s.slotIndex).sort((x, y) => x - y),
        [2, 4],
    );
});

test('analyzeRanches：nextProduceReadyAtMs 只取未来的最近一条', () => {
    const now = 1794810000000;
    const a = analyzeRanches([realRanch()], { now });
    // 1794818744037（收获得）和 1794822956272（生产中）都大于 now，取小的
    assert.equal(a.nextProduceReadyAtMs, 1794818744037);

    // 全部已过期时应为 0（不武装闹钟）
    const past = analyzeRanches([realRanch()], { now: 1794900000000 });
    assert.equal(past.nextProduceReadyAtMs, 0);
});

test('analyzeRanches：hasWork 汇总与标签', () => {
    const a = analyzeRanches([realRanch()]);
    assert.equal(a.hasWork, true);
    assert.match(a.label, /收:1/);
    assert.match(a.label, /喂:1/);
    assert.match(a.label, /灾:1/);

    const empty = analyzeRanches([{
        ranch_inst_id: 10001, capacity: 2, animal_count: 0,
        animals: [], grass: { amount: 100 }, shelves: [], hazards: [],
    }]);
    assert.equal(empty.hasWork, false, '空牧场没有可做的事');
    assert.equal(empty.label, '[]');
});

test('analyzeRanches：脏数据不 crash', () => {
    assert.doesNotThrow(() => analyzeRanches(null));
    assert.doesNotThrow(() => analyzeRanches([]));
    assert.doesNotThrow(() => analyzeRanches([{}]));
    assert.doesNotThrow(() => analyzeRanches([{ animals: null, shelves: null, hazards: null }]));
    const a = analyzeRanches([{ animals: [{}], shelves: [], hazards: [] }]);
    assert.equal(a.harvestable.length, 0);
});

test('analyzeRanches：Long 对象也能取数（protobufjs int64）', () => {
    // protobufjs 解 int64 给的是 Long，分析器必须能吃掉
    const Long = require('long');
    const ranch = realRanch();
    ranch.ranch_inst_id = Long.fromNumber(10001);
    ranch.animals = [{
        ...ranch.animals[0],
        animal_inst_id: Long.fromNumber(7),
        animal_id: Long.fromNumber(60002),
        produce_ready_at_ms: Long.fromNumber(1794818744037),
    }];
    const a = analyzeRanches([ranch], { now: 1794810000000 });
    assert.equal(a.harvestable[0].animalInstId, 7);
    assert.equal(a.harvestable[0].animalId, 60002);
    assert.equal(a.nextProduceReadyAtMs, 1794818744037);
});

test('msUntilNextProduce：无已知时刻返回 0', () => {
    assert.equal(msUntilNextProduce({ nextProduceReadyAtMs: 0 }), 0);
    assert.equal(msUntilNextProduce(null), 0);
    assert.equal(msUntilNextProduce({ nextProduceReadyAtMs: 1000 }, 400), 600);
    assert.equal(msUntilNextProduce({ nextProduceReadyAtMs: 1000 }, 5000), 0, '已过期按 0');
});