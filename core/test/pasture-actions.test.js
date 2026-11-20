/**
 * 牧场动作层测试：报价/确认两段式 + 结果未知账本
 *
 * 这里锁的是「花钱的动作不许重复扣费」这条底线：
 * 签名不一致要拒发、同 target 有未决记录要拒发、网关层拒绝要撤销预留、
 * 发出去了但结果不明要把记录留下等人工核对。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SRC = path.join(__dirname, '..', 'src');

// 独立数据目录，避免污染真实 data/
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pasture-actions-'));
process.env.FARM_DATA_DIR = TMP_DIR;

const captured = [];
let handler = null;

const networkId = require.resolve(path.join(SRC, 'utils', 'network'));
require.cache[networkId] = {
    id: networkId,
    filename: networkId,
    loaded: true,
    exports: {
        getUserState: () => ({
            gid: 1284168173,
            accountId: 'acct-1',
            globalSceneId: 1,
            unlockedSceneIds: [],
        }),
        isConnected: () => true,
        // 场景进出：这里只需要「能进能出」，快照解码走真实的 decode 分支（空 bytes → null）
        getWs: () => ({ readyState: 1 }),
        loginGameScene: async sceneId => ({ global_scene_id: sceneId, big_farm_scene_ext_data: Buffer.alloc(0) }),
        invalidateGameScene: () => {},
        networkEvents: { on() {}, emit() {} },
        // 模拟真实 sendMsgAsync：发送前跑 beforeSend，发出后跑 onSent
        sendMsgAsync: async (service, method, payload, timeout, options = {}) => {
            const blocked = typeof options.beforeSend === 'function'
                ? options.beforeSend(service, method) : null;
            if (blocked) throw blocked;
            captured.push({ service, method, payload: Buffer.from(payload) });
            // 真实时序：socket 写入成功（onSent）之后才可能收到回包或超时/网关错误
            if (typeof options.onSent === 'function') options.onSent(service, method);
            if (handler) return handler(service, method, Buffer.from(payload));
            return { body: Buffer.alloc(0) };
        },
    },
};

const { loadProto, types } = require(path.join(SRC, 'utils', 'proto'));
const actions = require(path.join(SRC, 'services', 'pasture-actions'));
const operations = require(path.join(SRC, 'services', 'pasture-operations'));

const ACCOUNT = 'acct-1';

function toPlain(msg) {
    return JSON.parse(JSON.stringify(msg, (k, v) =>
        (v && typeof v === 'object' && typeof v.toNumber === 'function') ? v.toNumber() : v));
}

/** 一只可收获的动物 + 一个可收的货架 */
function ranchReply(overrides = {}) {
    return {
        ranches: [{
            ranch_inst_id: 10001,
            capacity: 4,
            animal_count: 1,
            husbandry_type: 1,
            animals: [{
                ranch_inst_id: 10001,
                slot_index: 1,
                animal_inst_id: 8,
                animal_id: 60002,
                stage: 5,
                can_harvest: true,
                can_deliver: false,
                can_feed: false,
                can_donate: true,
            }],
            shelves: [{
                slot_index: 2,
                can_collect: true,
                can_steal: false,
                lots: [{ item_id: 1060001, base_num: 4, remain_num: 4, animal_id: 60002, can_steal: false, stealers: [] }],
            }],
            hazards: [],
            grass: { amount: 40, empty_at_ms: 0 },
        }],
        ...overrides,
    };
}

function bagReply(items = []) {
    return {
        global_scene_id: 2,
        physical_items: items,
        virtual_items: [],
        max_grid_num: 100,
        curr_grid_num: items.length,
    };
}

test.before(async () => {
    await loadProto();
});

test.afterEach(() => {
    captured.length = 0;
    handler = null;
    operations.clear(ACCOUNT);
});

test.after(() => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { }
});

test('报价：harvest all 生成 op=1 与固定签名', async () => {
    handler = (service, method) => {
        if (method === 'GetRanchDetail') {
            const Reply = types.RanchGetRanchDetailReply;
            return { body: Reply.encode(Reply.create(ranchReply())).finish() };
        }
        if (method === 'GetBag') {
            const Reply = types.RanchGetBagReply;
            return { body: Reply.encode(Reply.create(bagReply())).finish() };
        }
        return { body: Buffer.alloc(0) };
    };

    const quote = await actions.planAction('harvest', { all: true });
    assert.equal(quote.skipped, false);
    assert.equal(quote.count, 2, '1 只可收动物 + 1 个可收货架');
    assert.equal(quote.label, '牧场收获');
    assert.match(quote.expected.signature, /"action":"harvest"/);

    const again = await actions.planAction('harvest', { all: true });
    assert.equal(again.expected.signature, quote.expected.signature, '同状态两次报价签名必须一致');
});

test('报价：无事可做时 skipped=true 且 count=0', async () => {
    handler = (service, method) => {
        if (method === 'GetRanchDetail') {
            const Reply = types.RanchGetRanchDetailReply;
            return {
                body: Reply.encode(Reply.create({
                    ranches: [{ ranch_inst_id: 10001, capacity: 4, animal_count: 0, animals: [], shelves: [], hazards: [] }],
                })).finish(),
            };
        }
        if (method === 'GetBag') {
            const Reply = types.RanchGetBagReply;
            return { body: Reply.encode(Reply.create(bagReply())).finish() };
        }
        return { body: Buffer.alloc(0) };
    };

    const quote = await actions.planAction('harvest', { all: true });
    assert.equal(quote.skipped, true);
    assert.equal(quote.count, 0);
});

test('执行：签名一致才发包，成功后账本清空', async () => {
    handler = (service, method, payload) => {
        if (method === 'GetRanchDetail') {
            const Reply = types.RanchGetRanchDetailReply;
            return { body: Reply.encode(Reply.create(ranchReply())).finish() };
        }
        if (method === 'GetBag') {
            const Reply = types.RanchGetBagReply;
            return { body: Reply.encode(Reply.create(bagReply())).finish() };
        }
        if (method === 'HarvestRanch') {
            const op = toPlain(types.RanchHarvestRanchRequest.decode(payload)).op;
            assert.equal(op, 1, 'all 模式必须发 op=1');
            const Reply = types.RanchHarvestRanchReply;
            return {
                body: Reply.encode(Reply.create({
                    op_results: [
                        { facility_inst_id: 10001, kind: 1, target_id: 8, rewards: [{ id: 1060001, count: 4 }] },
                        { facility_inst_id: 10001, kind: 2, target_id: 2, rewards: [] },
                    ],
                })).finish(),
            };
        }
        return { body: Buffer.alloc(0) };
    };

    const quote = await actions.planAction('harvest', { all: true });
    const result = await actions.operate('harvest', { all: true, expected: quote.expected });
    assert.equal(result.status, 'confirmed');
    assert.equal(operations.pending(ACCOUNT).length, 0, '成功后不应留下待核对记录');

    const harvestCall = captured.find(c => c.method === 'HarvestRanch');
    assert.ok(harvestCall, '应发出 HarvestRanch');
});

test('执行：签名被篡改时拒发 RANCH_OFFER_CHANGED', async () => {
    handler = (service, method) => {
        if (method === 'GetRanchDetail') {
            const Reply = types.RanchGetRanchDetailReply;
            return { body: Reply.encode(Reply.create(ranchReply())).finish() };
        }
        if (method === 'GetBag') {
            const Reply = types.RanchGetBagReply;
            return { body: Reply.encode(Reply.create(bagReply())).finish() };
        }
        return { body: Buffer.alloc(0) };
    };

    await assert.rejects(
        () => actions.operate('harvest', { all: true, expected: { signature: 'stale' } }),
        (err) => err.code === 'RANCH_OFFER_CHANGED',
    );
    assert.ok(!captured.some(c => c.method === 'HarvestRanch'), '签名不符时不得发包');
    assert.equal(operations.pending(ACCOUNT).length, 0);
});

test('执行：结果未知时保留账本，同 target 第二次直接拒发', async () => {
    let failNext = true;
    handler = (service, method) => {
        if (method === 'GetRanchDetail') {
            const Reply = types.RanchGetRanchDetailReply;
            return { body: Reply.encode(Reply.create(ranchReply())).finish() };
        }
        if (method === 'GetBag') {
            const Reply = types.RanchGetBagReply;
            return { body: Reply.encode(Reply.create(bagReply())).finish() };
        }
        if (method === 'HarvestRanch' && failNext) {
            // 请求已经发出去了（onSent 已执行），但回包永远不来
            throw new Error('请求超时: HarvestRanch (seq=1)');
        }
        return { body: Buffer.alloc(0) };
    };

    const quote = await actions.planAction('harvest', { all: true });
    await assert.rejects(() => actions.operate('harvest', { all: true, expected: quote.expected }));

    const pending = operations.pending(ACCOUNT);
    assert.equal(pending.length, 1, '发出去但无回包必须落盘等人工核对');
    assert.equal(pending[0].target, 'pasture:harvest:all');

    failNext = false;
    await assert.rejects(
        () => actions.operate('harvest', { all: true, expected: quote.expected }),
        (err) => err.code === 'PENDING_CONFIRMATION',
    );
});

test('执行：网关层拒绝（未发出）时撤销预留', async () => {
    handler = (service, method) => {
        if (method === 'GetRanchDetail') {
            const Reply = types.RanchGetRanchDetailReply;
            return { body: Reply.encode(Reply.create(ranchReply())).finish() };
        }
        if (method === 'GetBag') {
            const Reply = types.RanchGetBagReply;
            return { body: Reply.encode(Reply.create(bagReply())).finish() };
        }
        if (method === 'HarvestRanch') {
            const err = new Error('业务错误');
            err.name = 'GatewayError';
            err.serviceName = 'gamepb.animalpb.AnimalService';
            err.methodName = 'HarvestRanch';
            throw err;
        }
        return { body: Buffer.alloc(0) };
    };

    const quote = await actions.planAction('harvest', { all: true });
    await assert.rejects(() => actions.operate('harvest', { all: true, expected: quote.expected }));
    assert.equal(operations.pending(ACCOUNT).length, 0, '网关拒绝说明没有副作用，应撤销记录');
});

test('账本：reserved 会把待核对支出从可用余额里扣除', () => {
    operations.addPending(ACCOUNT, {
        target: 'pasture:buy:9001',
        label: '购买牧场商品',
        costs: [{ resourceKey: 'item:1007', amount: '45000' }],
    });
    assert.equal(operations.reserved(ACCOUNT, 'item:1007'), '45000');
    assert.equal(operations.reserved(ACCOUNT, 'item:1002'), '0');
});

test('账本：acknowledge 清掉记录，重复确认报 STATE_CHANGED', () => {
    const record = operations.addPending(ACCOUNT, {
        target: 'pasture:buy:9001',
        label: '购买牧场商品',
        costs: [{ resourceKey: 'item:1007', amount: '1' }],
    });
    assert.equal(operations.pending(ACCOUNT).length, 1);
    operations.acknowledge(ACCOUNT, record.id);
    assert.equal(operations.pending(ACCOUNT).length, 0);
    assert.throws(() => operations.acknowledge(ACCOUNT, record.id),
        (err) => err.code === 'RANCH_STATE_CHANGED');
});

test('账本：文件损坏时 fail closed（报错而不是当成空账本）', () => {
    const file = operations.fileFor(ACCOUNT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ 坏数据');
    assert.throws(() => operations.pending(ACCOUNT), (err) => err.code === 'RANCH_STATE_INVALID');
    fs.rmSync(file, { force: true });
});

test('报价：余额不足时报 INSUFFICIENT_BALANCE', async () => {
    handler = (service, method) => {
        if (method === 'GetRanchDetail') {
            const Reply = types.RanchGetRanchDetailReply;
            return { body: Reply.encode(Reply.create(ranchReply())).finish() };
        }
        if (method === 'GetBag') {
            const Reply = types.RanchGetBagReply;
            return { body: Reply.encode(Reply.create(bagReply([{ id: 1007, count: 1 }]))).finish() };
        }
        if (method === 'ShopInfo') {
            const Reply = types.ShopInfoReply;
            return {
                body: Reply.encode(Reply.create({
                    goods_list: [{ id: 10002, item_id: 60001, item_count: 1, price: 1080, limit_count: 0, unlocked: true }],
                })).finish(),
            };
        }
        return { body: Buffer.alloc(0) };
    };

    await assert.rejects(
        () => actions.planAction('buy', { shopId: 5, goodsId: 10002, count: 1 }),
        (err) => err.code === 'INSUFFICIENT_BALANCE',
    );
});

test('报价：签名只覆盖 action/payload/costs/rewards/marker 五项', async () => {
    handler = (service, method) => {
        if (method === 'GetRanchDetail') {
            const Reply = types.RanchGetRanchDetailReply;
            return { body: Reply.encode(Reply.create(ranchReply())).finish() };
        }
        if (method === 'GetBag') {
            const Reply = types.RanchGetBagReply;
            return { body: Reply.encode(Reply.create(bagReply())).finish() };
        }
        return { body: Buffer.alloc(0) };
    };
    const quote = await actions.planAction('clean', {});
    // clean 有一个 hazard 才有报价；这里没有 hazard，走 skipped，签名仍应稳定
    const parsed = JSON.parse(quote.expected.signature);
    assert.deepEqual(Object.keys(parsed), ['action', 'payload', 'costs', 'rewards', 'marker']);
});