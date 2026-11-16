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
// ─── 面板视图（buildPanelView）───

const { buildPanelView } = require('../src/services/pasture-analyzer');

test('buildPanelView：汇总数字与 animals 拍平', () => {
    const now = 1794810000000;
    const a = analyzeRanches([realRanch()], { now });
    const view = buildPanelView(a, now);

    assert.equal(view.summary.animals, 4);
    assert.equal(view.summary.capacity, 4);
    assert.equal(view.summary.emptySlots, 0, '4 个槽位全占');
    assert.equal(view.summary.harvestable, 1);
    assert.equal(view.summary.collectableShelves, 1);
    assert.equal(view.summary.needFeed, 1);
    assert.equal(view.summary.needClean, 1);
    assert.equal(view.summary.grassAmount, 12);
    assert.equal(view.summary.grassLow, true);

    // 四只动物全部进面板 —— 面板是「栏里有什么」，不是「要做什么」。
    // 缺草那只不属于可收/待喂/生产中任何一类，旧实现会把它漏掉，
    // 真机上表现为「刚买的鸡在成长阶段，面板完全看不到」。
    assert.equal(view.animals.length, 4);
    // 填了映射的显示真名，没填的显示 `动物 #<id>` 占位
    assert.ok(view.animals.every(x => x.name && !x.name.includes('undefined')));
    assert.ok(view.animals.some(x => x.name === '鸭'), '60002 应显示「鸭」');
    assert.ok(view.animals.every(x => typeof x.stageName === 'string'));
    // 按槽位升序
    assert.deepEqual(view.animals.map(x => x.slotIndex), [1, 2, 3, 4]);
});

test('buildPanelView：产物成熟倒计时按 now 计算', () => {
    const now = 1794810000000;
    const a = analyzeRanches([realRanch()], { now });
    const view = buildPanelView(a, now);
    const first = view.animals.find(x => x.animalInstId === 7);
    assert.equal(first.readyAtMs, 1794818744037);
    assert.equal(first.readyInSec, Math.ceil((1794818744037 - now) / 1000));
    assert.ok(view.summary.nextReadyInSec > 0);
});

test('buildPanelView：无数据时不 crash', () => {
    assert.doesNotThrow(() => buildPanelView(null));
    const view = buildPanelView(analyzeRanches([]));
    assert.equal(view.summary.animals, 0);
    assert.deepEqual(view.animals, []);
    assert.deepEqual(view.shelves, []);
    assert.deepEqual(view.hazards, []);
    assert.equal(view.summary.nextReadyInSec, 0);
});

test('buildPanelView：货架与灾害带出去重后的条目', () => {
    const view = buildPanelView(analyzeRanches([realRanch()]));
    assert.equal(view.shelves.length, 2, '可收 + 可偷各一条');
    assert.equal(view.hazards.length, 1);
    assert.equal(view.hazards[0].hazardId, 501);
    assert.equal(view.shelves[0].lots, 1);
});

// ─── 中文名映射（PastureNames.json）───

const gameConfig = require('../src/config/gameConfig');

test('中文名映射：已填的动物返回真名', () => {
    // 这些来自商店截图 + 抓包 goods.price 交叉验证（60001=2、60002=1080 ... 60008=12672）
    assert.equal(gameConfig.getPastureAnimalName(60001), '鸡');
    assert.equal(gameConfig.getPastureAnimalName(60002), '鸭');
    assert.equal(gameConfig.getPastureAnimalName(60005), '火鸡');
    assert.equal(gameConfig.getPastureAnimalName(60008), '松鼠');
});

test('中文名映射：28 个动物全部有名字，不留占位', () => {
    // 窝类 60001-60016 + 棚类 70001-70012，价格与抓包逐项对齐
    const nest = [60001, 60002, 60003, 60004, 60005, 60006, 60007, 60008,
        60009, 60010, 60011, 60012, 60013, 60014, 60015, 60016];
    const barn = [70001, 70002, 70003, 70004, 70005, 70006,
        70007, 70008, 70009, 70010, 70011, 70012];
    for (const id of [...nest, ...barn]) {
        const name = gameConfig.getPastureAnimalName(id);
        assert.ok(!name.startsWith('动物 #'), `id ${id} 应该有真名，实际 ${name}`);
    }
    assert.equal(gameConfig.getPastureAnimalName(70001), '羊');
    assert.equal(gameConfig.getPastureAnimalName(70012), '羊驼');
});

test('中文名映射：棚类 70001 与设施 7001001 不混淆', () => {
    assert.equal(gameConfig.getPastureAnimalName(70001), '羊');
    assert.equal(gameConfig.getPastureFacilityName(7001001), '牧草机');
});

test('中文名映射：未登记的返回占位，不编造', () => {
    assert.equal(gameConfig.getPastureAnimalName(6010001), '动物 #6010001');
    assert.equal(gameConfig.getPastureAnimalName(99999), '动物 #99999');
});

test('中文名映射：设施已知，未知给占位', () => {
    assert.equal(gameConfig.getPastureFacilityName(7001001), '牧草机');
    assert.equal(gameConfig.getPastureFacilityName(12345), '设施 #12345');
});

test('中文名映射：id 传 Long/字符串 也能查到', () => {
    const Long = require('long');
    assert.equal(gameConfig.getPastureAnimalName(Long.fromNumber(60001)), '鸡');
    assert.equal(gameConfig.getPastureAnimalName('60002'), '鸭');
});

test('面板视图用的是真名而不是 id', () => {
    const view = buildPanelView(analyzeRanches([realRanch()]));
    const first = view.animals.find(a => a.animalId === 60002);
    assert.equal(first.name, '鸭', 'animal_id 60002 应显示为「鸭」');
});

// ── 面板必须看到「栏里有什么」，而不只是「要做什么」──

test('buildPanelView 包含幼崽和成长阶段的动物', () => {
    const ranches = [{
        ranch_inst_id: 10001,
        capacity: 3,
        grass: { amount: 100 },
        animals: [
            // 幼崽：不可收、不待喂、不生产 —— 三个动作分类都不会收它
            { ranch_inst_id: 10001, slot_index: 1, animal_inst_id: 7, animal_id: 60001, stage: 1 },
            { ranch_inst_id: 10001, slot_index: 2, animal_inst_id: 8, animal_id: 60002, stage: 2 },
            // 可收
            { ranch_inst_id: 10001, slot_index: 3, animal_inst_id: 9, animal_id: 60003, stage: 5, produce_count: 1 },
        ],
    }];

    const analysis = analyzeRanches(ranches);
    assert.equal(analysis.totalAnimals, 3);
    assert.equal(analysis.allAnimals.length, 3, 'analyzeRanches 要保留全量动物');

    const view = buildPanelView(analysis, Date.now());
    assert.equal(view.summary.animals, 3);
    assert.equal(view.animals.length, 3, '面板不能漏掉幼崽和成长中的动物');
    assert.deepEqual(view.animals.map(a => a.slotIndex), [1, 2, 3], '按栏位排序');
    assert.deepEqual(view.animals.map(a => a.stage), [1, 2, 5]);
});

// ── 到了生产阶段却没开工的动物（牧场不像农场种下就长）──

test('analyzeRanches 单独标出需要 TriggerProduce 的动物', () => {
    const ranches = [{
        ranch_inst_id: 10001,
        capacity: 3,
        grass: { amount: 100 },
        animals: [
            // 生产阶段但没在产、也没产物 —— 需要触发
            { ranch_inst_id: 10001, slot_index: 1, animal_inst_id: 7, animal_id: 60001, stage: 3 },
            // 已经在产 —— 不用管
            { ranch_inst_id: 10001, slot_index: 2, animal_inst_id: 8, animal_id: 60001, stage: 3, producing: true },
            // 幼崽 —— 还没到阶段，不能触发
            { ranch_inst_id: 10001, slot_index: 3, animal_inst_id: 9, animal_id: 60001, stage: 1 },
        ],
    }];

    const a = analyzeRanches(ranches);
    assert.equal(a.needsProduce.length, 1, '只有那只停在生产阶段没开工的');
    assert.equal(a.needsProduce[0].animalInstId, 7);

    const view = buildPanelView(a, Date.now());
    assert.equal(view.summary.needsProduce, 1, '面板汇总要带出来');
});

test('analyzeRanches：可收获的动物不再算作待触发', () => {
    const ranches = [{
        ranch_inst_id: 10001,
        capacity: 1,
        grass: { amount: 100 },
        animals: [{
            ranch_inst_id: 10001, slot_index: 1, animal_inst_id: 7, animal_id: 60001,
            stage: 5, can_harvest: true, produce_count: 2,
        }],
    }];
    const a = analyzeRanches(ranches);
    assert.equal(a.needsProduce.length, 0, '有东西可收时不该再去触发生产');
});
