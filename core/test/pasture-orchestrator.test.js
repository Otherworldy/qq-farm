/**
 * 牧场编排测试
 *
 * 覆盖三件事：
 * 1. guard（未连接 / 总开关关闭 / 并发重入）能挡住请求；
 * 2. 细分开关真的能筛掉对应操作；
 * 3. 操作顺序固定为 收货架 → 收获 → 投喂 → 清理 → 补草。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

/** 用假实现替换模块（必须在 require 被测模块之前调用） */
function mockModule(relPath, exports) {
    const id = require.resolve(path.join(SRC, relPath));
    require.cache[id] = { id, filename: id, loaded: true, exports };
    return id;
}

const SERVICES = path.join(__dirname, '..', 'src', 'services');

function resetModules() {
    delete require.cache[require.resolve(path.join(SERVICES, 'pasture-orchestrator'))];
    delete require.cache[require.resolve(path.join(SERVICES, 'pasture-api'))];
    delete require.cache[require.resolve(path.join(SERVICES, 'pasture-analyzer'))];
    delete require.cache[require.resolve(path.join(SERVICES, 'daily-events'))];
    delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'utils', 'network'))];
    delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'models', 'store'))];
    delete require.cache[require.resolve(path.join(SERVICES, 'warehouse'))];
}

/** 造一个可收获 + 可投喂 + 有灾害 + 草低 的牧场回包 */
function ranchReply() {
    return {
        ranches: [{
            ranch_inst_id: 10001,
            capacity: 4,
            animal_count: 2,
            animals: [
                { ranch_inst_id: 10001, slot_index: 1, animal_inst_id: 7, animal_id: 60002,
                    stage: 3, can_harvest: true, can_feed: false,
                    produce_ready_at_ms: Date.now() + 600000,
                    expected_harvest_exp: 360 },
                { ranch_inst_id: 10001, slot_index: 2, animal_inst_id: 8, animal_id: 60002,
                    stage: 1, can_harvest: false, can_feed: true },
            ],
            grass: { amount: 5 },
            shelves: [],
            hazards: [{ hazard_id: 501, owner: 111, hazard_type: 1 }],
        }],
    };
}

/** 装好一套 mock，返回调用记录 */
function setupMocks(options = {}) {
    resetModules();
    const calls = [];

    const auto = {
        pasture: true,
        pasture_harvest: true,
        pasture_feed: true,
        pasture_clean: true,
        pasture_grass: true,
        pasture_refill: true,
        pasture_buy_animal: false,
        ...(options.auto || {}),
    };

    mockModule('utils/network', {
        getUserState: () => ({ gid: 10001, accountId: 1 }),
        isConnected: () => options.connected !== false,
        networkEvents: { on() {}, emit() {} },
    });
    mockModule('models/store', {
        isAutomationOn: key => (key === 'pasture' ? auto.pasture : !!auto[key]),
        getAutomation: () => auto,
        getPasturePreferredAnimal: () => options.preferredAnimal || 0,
    });
    mockModule('services/daily-events', { recordEvent: () => {} });

    const api = {
        getRanchDetail: async () => { calls.push('getRanchDetail'); return options.reply || ranchReply(); },
        harvestRanch: async () => { calls.push('harvestRanch'); return { ranches: [] }; },
        feedAnimal: async (targets) => { calls.push('feedAnimal'); calls.push(`feed:${targets.length}`); return { ranches: [] }; },
        cleanAllRanch: async () => { calls.push('cleanAllRanch'); return { ranches: [] }; },
        getFacilityDetail: async () => { calls.push('getFacilityDetail'); return { detail: { feed_machine: { current: 5, capacity: 100 } } }; },
        addFeed: async () => { calls.push('addFeed'); return { state: { current: 6 } }; },
        getBuildingList: async () => { calls.push('getBuildingList'); return { buildings: [] }; },
        triggerProduce: async () => { calls.push('triggerProduce'); return { ranches: [] }; },
        stealProduce: async () => { calls.push('stealProduce'); return { ranches: [] }; },
        getRanchOpTimes: async () => { calls.push('getRanchOpTimes'); return { quotas: [] }; },
        // 第二轮抓包新增
        placeAnimal: async (ranchInstId, animalId) => {
            calls.push('placeAnimal');
            calls.push(`place:${ranchInstId}:${animalId}`);
            return { ranches: [] };
        },
        cleanRanch: async (hazardIds) => {
            calls.push('cleanRanch');
            calls.push(`cleanRanch:${hazardIds.join(',')}`);
            return { ranches: [] };
        },
        strokeAnimal: async () => { calls.push('strokeAnimal'); return { ranches: [] }; },
        getAnimalShop: async () => {
            calls.push('getAnimalShop');
            return { shopId: 4, goods: (options.animalGoods || []) };
        },
        buyGoods: async (goodsId, num, price) => {
            calls.push('buyGoods');
            calls.push(`buy:${goodsId}:${num}:${price}`);
            return { goods: {} };
        },
        isAnimalItemId: id => Number(id) >= 60000 && Number(id) <= 60999,
        RANCH_OP_IDS: [11003, 11008, 11009],
        FEED_MACHINE_FACILITY_ID: 7001001,
    };
    mockModule('services/pasture-api', api);

    // 背包：默认空
    mockModule('services/warehouse', {
        getBag: async () => {
            calls.push('getBag');
            return { item_bag: { items: options.bagItems || [] } };
        },
    });

    const orchestrator = require(path.join(SERVICES, 'pasture-orchestrator'));
    return { orchestrator, calls, auto };
}

test('checkPasture：未连接时不发任何请求', async () => {
    const { orchestrator, calls } = setupMocks({ connected: false });
    const worked = await orchestrator.checkPasture();
    assert.equal(worked, false);
    assert.deepEqual(calls, [], '断线时连详情都不该拉');
});

test('checkPasture：总开关关闭时直接退出', async () => {
    const { orchestrator, calls } = setupMocks({ auto: { pasture: false } });
    const worked = await orchestrator.checkPasture();
    assert.equal(worked, false);
    assert.deepEqual(calls, []);
});

test('runPastureOperation：全开时按 收货架→收获→投喂→清理→补草 执行', async () => {
    const { orchestrator, calls } = setupMocks();
    const result = await orchestrator.runPastureOperation('all');

    assert.equal(result.hadWork, true);
    // 依次发生：拉详情 → 收获 → 投喂 → 清理 → 补草
    assert.equal(calls[0], 'getRanchDetail');
    const harvestIdx = calls.indexOf('harvestRanch');
    const feedIdx = calls.indexOf('feedAnimal');
    // 清理默认走定点 CleanRanch（有 hazard_id 时）
    const cleanIdx = Math.max(calls.indexOf('cleanRanch'), calls.indexOf('cleanAllRanch'));
    const feedMachineIdx = calls.indexOf('addFeed');
    assert.ok(harvestIdx > 0, '应执行收获');
    assert.ok(feedIdx > harvestIdx, '投喂应在收获之后');
    assert.ok(cleanIdx > feedIdx, '清理应在投喂之后');
    assert.ok(feedMachineIdx > cleanIdx, '补草应在最后');
    // fixture 有 2 个空栏但背包没动物、买动物开关关着，所以补栏不入 actions
    assert.deepEqual(result.actions, ['harvest', 'feed', 'clean', 'refill_grass']);
});

test('runPastureOperation：细分开关能单独关掉某一项', async () => {
    const { orchestrator, calls } = setupMocks({
        auto: { pasture_feed: false, pasture_grass: false },
    });
    const result = await orchestrator.runPastureOperation('all');
    assert.ok(result.actions.includes('harvest'), '收获仍应执行');
    assert.ok(result.actions.includes('clean'), '清理仍应执行');
    assert.ok(!result.actions.includes('feed'), '投喂被开关关掉');
    assert.ok(!result.actions.includes('refill_grass'), '补草被开关关掉');
    assert.equal(calls.includes('feedAnimal'), false);
    assert.equal(calls.includes('addFeed'), false);
});

test('runPastureOperation：opType 指定单项时只做那项', async () => {
    const { orchestrator, calls } = setupMocks();
    const result = await orchestrator.runPastureOperation('feed');
    assert.deepEqual(result.actions, ['feed']);
    assert.equal(calls.includes('harvestRanch'), false);
    assert.equal(calls.includes('cleanAllRanch'), false);
});

test('runPastureOperation：空牧场不产生任何操作', async () => {
    // 关掉补栏：空牧场必然有空栏，开着补栏会去查背包，这是正确行为但不属于本用例
    const { orchestrator, calls } = setupMocks({
        auto: { pasture_refill: false },
        reply: { ranches: [{ ranch_inst_id: 10001, capacity: 2, animal_count: 0,
            animals: [], grass: { amount: 100 }, shelves: [], hazards: [] }] },
    });
    const result = await orchestrator.runPastureOperation('all');
    assert.equal(result.hadWork, false);
    assert.deepEqual(result.actions, []);
    assert.deepEqual(calls, ['getRanchDetail'], '只看详情，不做任何操作');
});

test('runPastureOperation：没有牧场数据时安全返回', async () => {
    const { orchestrator } = setupMocks({ reply: { ranches: [] } });
    const result = await orchestrator.runPastureOperation('all');
    assert.equal(result.hadWork, false);
    assert.equal(result.analysis, null);
});

test('补草有冷却：连续两轮不会重复打牧草机', async () => {
    const { orchestrator, calls } = setupMocks();
    await orchestrator.runPastureOperation('all');
    const firstFeedCount = calls.filter(c => c === 'addFeed').length;
    assert.equal(firstFeedCount, 1, '第一轮应补一次');

    await orchestrator.runPastureOperation('all');
    const secondFeedCount = calls.filter(c => c === 'addFeed').length;
    assert.equal(secondFeedCount, 1, '冷却期内第二轮不应再补');
});

test('getNextPastureReadyInMs：拉过详情后能给出剩余毫秒', async () => {
    const { orchestrator } = setupMocks();
    assert.equal(orchestrator.getNextPastureReadyInMs(), 0, '未拉过详情时为 0');
    await orchestrator.runPastureOperation('all');
    const remain = orchestrator.getNextPastureReadyInMs();
    assert.ok(remain > 0, '有未来成熟时刻时应为正数');
    assert.ok(remain <= 600000 + 5000, '不应超过 fixture 的 10 分钟');
});

test('RPC 抛错时 checkPasture 不抛出，只是返回 false', async () => {
    const { orchestrator, calls } = setupMocks();
    // 让详情接口抛一个非网络错误，并记录是否真的被调用过
    let called = 0;
    const apiId = require.resolve(path.join(SERVICES, 'pasture-api'));
    require.cache[apiId].exports.getRanchDetail = async () => {
        called += 1;
        throw new Error('boom');
    };
    // 重新加载编排器让它拿到新的 api 引用
    delete require.cache[require.resolve(path.join(SERVICES, 'pasture-orchestrator'))];
    const fresh = require(path.join(SERVICES, 'pasture-orchestrator'));
    const worked = await fresh.checkPasture();
    assert.equal(worked, false, '出错时不应报告有操作');
    assert.equal(called, 1, '确实尝试过拉详情');
    assert.ok(orchestrator, 'sanity');
    assert.ok(Array.isArray(calls));
});
// ─── 第二轮抓包新增：定点清理优先 ───

test('清理：有 hazard_id 时走 CleanRanch 定点，而不是一键全清', async () => {
    const { orchestrator, calls } = setupMocks();
    const result = await orchestrator.runPastureOperation('clean');
    assert.deepEqual(result.actions, ['clean']);
    assert.ok(calls.includes('cleanRanch'), '应调用定点清理');
    assert.equal(calls.includes('cleanAllRanch'), false, '不应退回一键清理');
    assert.ok(calls.includes('cleanRanch:501'), '应带上 hazard_id');
});

test('清理：拿不到 hazard_id 时才退回一键清理', async () => {
    const reply = ranchReply();
    delete reply.ranches[0].hazards[0].hazard_id;   // hazard_id 缺失
    const { orchestrator, calls } = setupMocks({ reply });
    const result = await orchestrator.runPastureOperation('clean');
    assert.deepEqual(result.actions, ['clean']);
    assert.ok(calls.includes('cleanAllRanch'), '缺 hazard_id 时用一键清理');
    assert.equal(calls.includes('cleanRanch'), false);
});

// ─── 第二轮抓包新增：补栏 ───

test('补栏：背包里有动物就直接放入空栏位', async () => {
    const reply = ranchReply();   // capacity 4，已用 slot 1/2 → 空栏 3/4
    const { orchestrator, calls } = setupMocks({
        reply,
        bagItems: [{ id: 60001, count: 2 }],
    });
    const result = await orchestrator.runPastureOperation('refill');
    assert.deepEqual(result.actions, ['refill_slots']);
    assert.ok(calls.includes('placeAnimal'));
    // 两只库存，两个空栏，应该放两次
    const placeCalls = calls.filter(c => String(c).startsWith('place:'));
    assert.equal(placeCalls.length, 2, '空栏 2 个、库存 2 只，应放 2 次');
    assert.ok(placeCalls.every(c => c.includes(':60001')), '放的是动物种类号 60001');
    assert.equal(calls.includes('buyGoods'), false, '有库存时不该花钱');
});

test('补栏：库存不足且买动物开关关闭时不买', async () => {
    const { orchestrator, calls } = setupMocks({
        reply: ranchReply(),
        bagItems: [],
        auto: { pasture_buy_animal: false },
        animalGoods: [{ goodsId: 10002, animalId: 60001, price: 2, unlocked: true }],
    });
    const result = await orchestrator.runPastureOperation('refill');
    assert.deepEqual(result.actions, []);
    assert.equal(calls.includes('buyGoods'), false, '开关关闭时绝不花钱');
    assert.equal(calls.includes('getAnimalShop'), false, '也不该去查商店');
});

test('补栏：开关打开且余额足够时买最便宜的一只并放入', async () => {
    const { orchestrator, calls } = setupMocks({
        reply: ranchReply(),
        bagItems: [{ id: 1007, count: 5000 }],   // 牧场货币余额 5000
        auto: { pasture_buy_animal: true },
        animalGoods: [
            { goodsId: 10004, animalId: 60003, price: 2712, unlocked: true },
            { goodsId: 10002, animalId: 60001, price: 2, unlocked: true },
        ],
    });
    const result = await orchestrator.runPastureOperation('refill');
    assert.deepEqual(result.actions, ['refill_slots']);
    const buyCall = calls.find(c => String(c).startsWith('buy:'));
    assert.ok(buyCall, '应发起购买');
    assert.ok(buyCall.includes(':10002:1:2'), `应买最便宜的 10002（实际 ${buyCall}）`);
    assert.ok(calls.some(c => String(c).startsWith('place:') && c.includes('60001')),
        '买完立刻放入对应动物');
});

test('补栏：余额不足时不买也不报错', async () => {
    const { orchestrator, calls } = setupMocks({
        reply: ranchReply(),
        bagItems: [{ id: 1007, count: 1 }],      // 只有 1，买不起 1080 的
        auto: { pasture_buy_animal: true },
        animalGoods: [{ goodsId: 10003, animalId: 60002, price: 1080, unlocked: true }],
    });
    const result = await orchestrator.runPastureOperation('refill');
    assert.deepEqual(result.actions, []);
    assert.equal(calls.includes('buyGoods'), false);
});

test('补栏：没有空栏时完全不动', async () => {
    const full = ranchReply();
    full.ranches[0].capacity = 2;   // 已经有 2 只，满了
    const { orchestrator, calls } = setupMocks({
        reply: full,
        bagItems: [{ id: 60001, count: 5 }],
    });
    const result = await orchestrator.runPastureOperation('refill');
    assert.deepEqual(result.actions, []);
    assert.equal(calls.includes('getBag'), false, '没空栏连背包都不查');
});

// ─── 抚摸（用户确认：抚摸能推进产出）───

test('抚摸：对 strokable 的动物每轮各摸一次', async () => {
    const reply = ranchReply();
    // 给两只动物加 strokable
    reply.ranches[0].animals[0].mutation = { strokable: true };
    reply.ranches[0].animals[1].mutation = { strokable: true };
    const { orchestrator, calls } = setupMocks({ reply });

    const result = await orchestrator.runPastureOperation('stroke');
    assert.deepEqual(result.actions, ['stroke']);
    const strokeCalls = calls.filter(c => c === 'strokeAnimal');
    assert.equal(strokeCalls.length, 2, '两只都可摸');
});

test('抚摸：10 分钟冷却内不重复摸同一只', async () => {
    const reply = ranchReply();
    reply.ranches[0].animals[0].mutation = { strokable: true };
    const { orchestrator, calls } = setupMocks({ reply });

    await orchestrator.runPastureOperation('stroke');
    const first = calls.filter(c => c === 'strokeAnimal').length;
    assert.equal(first, 1);

    await orchestrator.runPastureOperation('stroke');
    const second = calls.filter(c => c === 'strokeAnimal').length;
    assert.equal(second, 1, '冷却内第二轮不再摸');
});

test('抚摸：没有 strokable 时不发请求', async () => {
    const { orchestrator, calls } = setupMocks();   // fixture 的 mutation 没有 strokable
    const result = await orchestrator.runPastureOperation('stroke');
    assert.deepEqual(result.actions, []);
    assert.equal(calls.filter(c => c === 'strokeAnimal').length, 0);
});

test('抚摸：单轮最多摸 STROKE_MAX_PER_ROUND 只', async () => {
    const reply = ranchReply();
    reply.ranches[0].animals = Array.from({ length: 10 }, (_, i) => ({
        ranch_inst_id: 10001,
        slot_index: i + 1,
        animal_inst_id: 100 + i,
        animal_id: 60002,
        stage: 1,
        mutation: { strokable: true },
    }));
    reply.ranches[0].capacity = 10;
    const { orchestrator, calls } = setupMocks({ reply });

    await orchestrator.runPastureOperation('stroke');
    assert.equal(
        calls.filter(c => c === 'strokeAnimal').length,
        orchestrator.STROKE_MAX_PER_ROUND,
    );
});

// ─── 空闲防护不能吞掉牧场（真机踩到）───

test('planIdleProtection：牧场临近时不能进入长时防护', () => {
    const { planIdleProtection } = require('../src/utils/idle-protection');
    const now = 1794810000000;
    const base = {
        enabled: true,
        now,
        ownDueAt: 0,
        stealDueAt: 0,
        horizonMs: 10 * 60_000,
        activeMs: 60_000,
    };

    // 农场/帮助都要 7 分钟后，只有牧场是 25 秒后 —— 必须不防护
    const withPasture = planIdleProtection({
        ...base,
        farmAt: now + 7 * 60_000,
        helpAt: now + 7 * 60_000,
        pastureAt: now + 25_000,
    });
    assert.equal(withPasture, 0, '牧场 25 秒后要跑，不能被 7 分钟的防护吞掉');

    // 不传 pastureAt 时行为不变（回归保护）
    const withoutPasture = planIdleProtection({
        ...base,
        farmAt: now + 7 * 60_000,
        helpAt: now + 7 * 60_000,
    });
    assert.ok(withoutPasture > now, '三个定时都在 60 秒外时仍会进入防护');

    // 三者都远，牧场也远时才防护
    const allFar = planIdleProtection({
        ...base,
        farmAt: now + 7 * 60_000,
        helpAt: now + 7 * 60_000,
        pastureAt: now + 6 * 60_000,
    });
    assert.equal(allFar, now + 6 * 60_000, '取三者最早的那个作为唤醒点');
});

// ── 运行策略：优先补栏动物（对应农场的「优先种子」）──

test('补栏：指定优先动物时买它，而不是最便宜的那只', async () => {
    const { orchestrator, calls } = setupMocks({
        reply: ranchReply(),
        bagItems: [{ id: 1007, count: 50000 }],
        auto: { pasture_buy_animal: true },
        preferredAnimal: 60003,
        animalGoods: [
            { goodsId: 10002, animalId: 60001, price: 2, unlocked: true },
            { goodsId: 10003, animalId: 60002, price: 1080, unlocked: true },
            { goodsId: 10004, animalId: 60003, price: 2712, unlocked: true },
        ],
    });
    await orchestrator.runPastureOperation('refill');
    const buyCall = calls.find(c => String(c).startsWith('buy:'));
    assert.ok(buyCall, '应发起购买');
    assert.ok(buyCall.includes(':10004:'), `应买指定的鹅 10004（实际 ${buyCall}）`);
    assert.ok(calls.some(c => String(c).startsWith('place:') && c.includes('60003')),
        '买完放入对应的鹅');
});

test('补栏：没指定优先动物时仍买最便宜的', async () => {
    const { orchestrator, calls } = setupMocks({
        reply: ranchReply(),
        bagItems: [{ id: 1007, count: 50000 }],
        auto: { pasture_buy_animal: true },
        animalGoods: [
            { goodsId: 10002, animalId: 60001, price: 2, unlocked: true },
            { goodsId: 10004, animalId: 60003, price: 2712, unlocked: true },
        ],
    });
    await orchestrator.runPastureOperation('refill');
    const buyCall = calls.find(c => String(c).startsWith('buy:'));
    assert.ok(buyCall && buyCall.includes(':10002:'), `未指定时买最便宜的鸡（实际 ${buyCall}）`);
});

test('补栏：指定的优先动物买不起时退到买得起的', async () => {
    const { orchestrator, calls } = setupMocks({
        reply: ranchReply(),
        bagItems: [{ id: 1007, count: 10 }],
        auto: { pasture_buy_animal: true },
        preferredAnimal: 60003,
        animalGoods: [
            { goodsId: 10002, animalId: 60001, price: 2, unlocked: true },
            { goodsId: 10004, animalId: 60003, price: 2712, unlocked: true },
        ],
    });
    await orchestrator.runPastureOperation('refill');
    const buyCall = calls.find(c => String(c).startsWith('buy:'));
    assert.ok(buyCall && buyCall.includes(':10002:'), `买不起鹅时买鸡（实际 ${buyCall}）`);
});

// ── TriggerProduce 会触发产出，动物留在栏位（实测 3/3 不变）──

test('触发生产：停在生产阶段没开工的动物会被 TriggerProduce 叫醒', async () => {
    const { orchestrator, calls } = setupMocks({
        reply: {
            ranches: [{
                ranch_inst_id: 10001, capacity: 3, grass: { amount: 100 },
                animals: [
                    { ranch_inst_id: 10001, slot_index: 1, animal_inst_id: 7, animal_id: 60001, stage: 3 },
                ],
                shelves: [], hazards: [],
            }],
        },
        auto: { pasture_produce: true },
    });

    const result = await orchestrator.runPastureOperation('all');
    assert.ok(calls.includes('triggerProduce'), '应发 TriggerProduce');
    assert.ok(result.actions.includes('trigger_produce'), '动作里要记下来');
});

test('触发生产：开关关掉就不发请求', async () => {
    const { orchestrator, calls } = setupMocks({
        reply: {
            ranches: [{
                ranch_inst_id: 10001, capacity: 3, grass: { amount: 100 },
                animals: [
                    { ranch_inst_id: 10001, slot_index: 1, animal_inst_id: 7, animal_id: 60001, stage: 3 },
                ],
                shelves: [], hazards: [],
            }],
        },
        auto: { pasture_produce: false },
    });

    await orchestrator.runPastureOperation('all');
    assert.equal(calls.includes('triggerProduce'), false);
});

test('触发生产：已经在产的动物不重复触发', async () => {
    const { orchestrator, calls } = setupMocks({
        reply: {
            ranches: [{
                ranch_inst_id: 10001, capacity: 3, grass: { amount: 100 },
                animals: [
                    { ranch_inst_id: 10001, slot_index: 1, animal_inst_id: 7, animal_id: 60001, stage: 3, producing: true },
                ],
                shelves: [], hazards: [],
            }],
        },
        auto: { pasture_produce: true },
    });

    await orchestrator.runPastureOperation('all');
    assert.equal(calls.includes('triggerProduce'), false, '没有待开工的就不该发');
});
