/**
 * 好友牧场偷产物测试
 *
 * StealProduce 不需要 Enter/Leave 门票（直接用 host_gid 指名），所以这里
 * 重点验证三件事：开关关闭时零请求、只对"真的可偷"的好友发请求、
 * 单个好友失败不影响后面的好友。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function mockModule(relPath, exports) {
    const id = require.resolve(path.join(SRC, relPath));
    require.cache[id] = { id, filename: id, loaded: true, exports };
    return id;
}

function resetModules() {
    for (const rel of [
        'services/pasture-visit',
        'services/pasture-api',
        'services/pasture-analyzer',
        'services/friend-land-analyzer',
        'services/daily-events',
        'utils/network',
        'models/store',
    ]) {
        delete require.cache[require.resolve(path.join(SRC, rel))];
    }
}

/** 一个只有货架可偷的好友牧场 */
function friendRanchWithStealable() {
    return {
        ranches: [{
            ranch_inst_id: 10001,
            capacity: 3,
            animal_count: 3,
            animals: [],
            grass: { amount: 80 },
            shelves: [{ slot_index: 1, total_remain: 5, can_collect: false, can_steal: true,
                lots: [{ item_id: 1007, remain_num: 5, animal_id: 60001, can_steal: true, stealers: [] }] }],
            hazards: [],
        }],
    };
}

/** 没有可偷内容的牧场 */
function friendRanchClean() {
    return {
        ranches: [{
            ranch_inst_id: 10001, capacity: 3, animal_count: 3,
            animals: [], grass: { amount: 80 }, shelves: [], hazards: [],
        }],
    };
}

function setup(options = {}) {
    resetModules();
    const calls = [];
    const auto = {
        pasture: true,
        pasture_steal: true,
        ...(options.auto || {}),
    };

    mockModule('utils/network', {
        getUserState: () => ({
            gid: 1284046759,
            accountId: 1,
            globalSceneId: 2,
            unlockedSceneIds: [1, 2],
        }),
        isConnected: () => options.connected !== false,
        getWs: () => ({ readyState: 1 }),
        loginGameScene: async sceneId => ({ global_scene_id: sceneId, big_farm_scene_ext_data: Buffer.alloc(0) }),
        invalidateGameScene: () => {},
        networkEvents: { on() {}, emit() {} },
    });
    mockModule('models/store', {
        isAutomationOn: key => !!auto[key],
        getAutomation: () => auto,
        getPastureStealWhitelist: () => options.stealWhitelist || [],
    });
    mockModule('services/daily-events', { recordEvent: () => {} });
    // 好友列表走 friend-land-analyzer 的带缓存入口（数组形状）
    mockModule('services/friend-land-analyzer', {
        getFriendsList: async () => {
            calls.push('getFriendsList');
            return options.friends || [
                { gid: 1288674344, name: '好友A' },
                { gid: 1233369866, name: '好友B' },
            ];
        },
    });
    mockModule('services/pasture-api', {
        getRanchDetail: async (ids, hostGid) => {
            calls.push(`detail:${hostGid}`);
            if (options.detailFails && options.detailFails.includes(hostGid)) {
                throw new Error('boom');
            }
            if (options.detailErrorByGid && options.detailErrorByGid[hostGid]) {
                const err = new Error(options.detailErrorByGid[hostGid]);
                err.code = options.detailErrorCode || 1045216;
                throw err;
            }
            const map = options.ranchByGid || {};
            return map[hostGid] || friendRanchClean();
        },
        stealProduce: async (hostGid) => {
            calls.push(`steal:${hostGid}`);
            return { ranches: [] };
        },
        // 好友家园门票：默认可用；测试里只关心是否成对出现
        enterHomestead: async (hostGid) => {
            calls.push(`enter:${hostGid}`);
            if (options.enterErrorByGid && options.enterErrorByGid[hostGid]) {
                const err = new Error(options.enterErrorByGid[hostGid]);
                err.code = options.enterErrorCode || 1002002;
                throw err;
            }
            return { basic: { gid: hostGid }, homestead_cells: {} };
        },
        leaveHomestead: async (hostGid) => {
            calls.push(`leave:${hostGid}`);
            return {};
        },
    });

    const visit = require(path.join(SRC, 'services/pasture-visit'));
    return { visit, calls, auto };
}

test('checkFriendPastures：开关关闭时零请求', async () => {
    const { visit, calls } = setup({ auto: { pasture_steal: false } });
    const result = await visit.checkFriendPastures();
    assert.deepEqual(result, { stolen: 0, checked: 0, skipped: true });
    assert.deepEqual(calls, [], '连好友列表都不该拉');
});

test('checkFriendPastures：未连接时零请求', async () => {
    const { visit, calls } = setup({ connected: false });
    const result = await visit.checkFriendPastures();
    assert.equal(result.skipped, true);
    assert.deepEqual(calls, []);
});

test('checkFriendPastures：只对可偷的好友下手', async () => {
    const { visit, calls } = setup({
        ranchByGid: {
            1288674344: friendRanchWithStealable(),   // 好友A 有可偷
            // 好友B 走默认 friendRanchClean（没得偷）
        },
    });
    const result = await visit.checkFriendPastures();

    assert.equal(result.skipped, false);
    assert.equal(result.checked, 2, '两个好友都看过');
    assert.equal(result.stolen, 1, '只有好友A 被偷');
    assert.deepEqual(calls, [
        'getFriendsList',
        'enter:1288674344',
        'detail:1288674344',
        'steal:1288674344',
        'leave:1288674344',
        'enter:1233369866',
        'detail:1233369866',
        'leave:1233369866',
    ], '好友B 只读详情、不发偷取，但一样要进出家园且离场');
});

test('checkFriendPastures：跳过自己', async () => {
    const { visit, calls } = setup({
        friends: [{ gid: 1284046759, name: '自己' }, { gid: 1288674344, name: '好友A' }],
        ranchByGid: { 1288674344: friendRanchWithStealable() },
    });
    await visit.checkFriendPastures();
    assert.equal(calls.includes('detail:1284046759'), false, '不该读自己的牧场');
});

test('checkFriendPastures：单个好友失败不影响其他好友', async () => {
    const { visit, calls } = setup({
        detailFails: [1288674344],   // 好友A 读详情抛错
        ranchByGid: { 1233369866: friendRanchWithStealable() },
    });
    const result = await visit.checkFriendPastures();
    assert.equal(result.checked, 2, '两个都尝试过');
    assert.equal(result.stolen, 1, '好友B 仍然被偷到');
    assert.ok(calls.includes('steal:1233369866'));
});

test('checkFriendPastures：5 分钟冷却内不重复跑', async () => {
    const { visit, calls } = setup({
        ranchByGid: { 1288674344: friendRanchWithStealable() },
    });
    const now = 1794810000000;
    const first = await visit.checkFriendPastures({ now });
    assert.equal(first.skipped, false);
    const firstCalls = calls.length;

    const second = await visit.checkFriendPastures({ now: now + 60_000 });
    assert.equal(second.skipped, true, '1 分钟后仍在冷却');
    assert.equal(calls.length, firstCalls, '冷却期内不应再发请求');

    const third = await visit.checkFriendPastures({ now: now + visit.FRIEND_STEAL_COOLDOWN_MS + 1 });
    assert.equal(third.skipped, false, '冷却结束后可以再跑');
});

test('checkFriendPastures：单轮最多检查 MAX_FRIENDS_PER_ROUND 个', async () => {
    const friends = Array.from({ length: 12 }, (_, i) => ({ gid: 2000000000 + i, name: `F${i}` }));
    const { visit, calls } = setup({ friends });
    await visit.checkFriendPastures();
    const detailCalls = calls.filter(c => String(c).startsWith('detail:'));
    assert.equal(detailCalls.length, visit.MAX_FRIENDS_PER_ROUND);
});

test('pickFriends：兼容 gid / target_gid / id 三种字段', () => {
    const { visit } = setup();
    const picked = visit.pickFriends({
        friends: [{ gid: 11 }, { target_gid: 22 }, { id: 33 }, { gid: 0 }],
    });
    assert.deepEqual(picked.map(f => f.gid), [11, 22, 33], 'gid=0 的应被过滤');
});
// ── 运行策略：偷产物白名单（对应农场的偷菜白名单）──

test('checkFriendPastures：白名单为空时不限制', async () => {
    const { visit } = setup({
        stealWhitelist: [],
        ranchByGid: { 1288674344: friendRanchWithStealable() },
    });
    const result = await visit.checkFriendPastures();
    assert.equal(result.stolen, 1, '空名单 = 全偷');
});

test('checkFriendPastures：白名单命中动物时才偷', async () => {
    const { visit } = setup({
        stealWhitelist: [60001],   // 好友货架 lot 的 animal_id 就是 60001
        ranchByGid: { 1288674344: friendRanchWithStealable() },
    });
    const result = await visit.checkFriendPastures();
    assert.equal(result.stolen, 1, '命中则偷');
});

test('checkFriendPastures：白名单不含该动物时不偷', async () => {
    const { visit, calls } = setup({
        stealWhitelist: [60002, 60003],   // 没有 60001
        ranchByGid: { 1288674344: friendRanchWithStealable() },
    });
    const result = await visit.checkFriendPastures();
    assert.equal(result.stolen, 0, '不在名单里就不偷');
    assert.equal(calls.some(c => String(c).startsWith('steal:')), false, '一次偷取请求都不该发');
});

test('不是好友的 gid 只白试一次，之后不再为它发请求', async () => {
    const { visit, calls } = setup({
        friends: [{ gid: 10001, name: '列表里的幽灵' }, { gid: 20002, name: '真好友' }],
        detailErrorByGid: { 10001: 'GetRanchDetail 错误: code=1045216 你们还不是好友，无法进行此操作' },
    });

    await visit.checkFriendPastures();
    assert.ok(calls.some(c => String(c).includes('10001')), '第一轮会试一次');

    calls.length = 0;
    visit.resetFriendPastureStateForTests();   // 只清冷却，黑名单要保留
    await visit.checkFriendPastures();
    assert.equal(calls.filter(c => String(c).includes('10001')).length, 0,
        '记住「不是好友」之后不该再为它发请求');
    assert.ok(calls.some(c => String(c).includes('20002')), '真好友仍要正常巡查');
});

test('门票回「不是好友」时直接划掉，不再走直连兜底', async () => {
    const { visit, calls } = setup({
        friends: [{ gid: 10001, name: '列表里的幽灵' }, { gid: 20002, name: '真好友' }],
        enterErrorByGid: { 10001: 'EnterHomestead 错误: code=1002002 不是好友无法拜访' },
    });

    await visit.checkFriendPastures();
    assert.ok(calls.some(c => c.startsWith('enter:10001')), '第一轮会试一次门票');
    assert.equal(calls.some(c => String(c) === 'detail:10001'), false,
        '已知不是好友就不必再试 host_gid 直连');

    calls.length = 0;
    visit.resetFriendPastureStateForTests();
    await visit.checkFriendPastures();
    assert.equal(calls.filter(c => String(c).includes('10001')).length, 0,
        '第二轮完全跳过这个 gid');
    assert.ok(calls.some(c => String(c).includes('20002')), '真好友照常巡查');
});
