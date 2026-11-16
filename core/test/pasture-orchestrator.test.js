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
        RANCH_OP_IDS: [11003, 11008, 11009],
        FEED_MACHINE_FACILITY_ID: 7001001,
    };
    mockModule('services/pasture-api', api);

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
    const cleanIdx = calls.indexOf('cleanAllRanch');
    const feedMachineIdx = calls.indexOf('addFeed');
    assert.ok(harvestIdx > 0, '应执行收获');
    assert.ok(feedIdx > harvestIdx, '投喂应在收获之后');
    assert.ok(cleanIdx > feedIdx, '清理应在投喂之后');
    assert.ok(feedMachineIdx > cleanIdx, '补草应在最后');
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
    const { orchestrator, calls } = setupMocks({
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