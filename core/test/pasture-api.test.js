/**
 * 牧场 API 契约测试
 *
 * 不连服务器，只验证一件事：pasture-api 发出去的 payload 能被对应的
 * Request 类型原样解码回来（protobuf round-trip）。
 *
 * 这条断言能抓到字段名写错、Long/number 混用、repeated 结构错误 —— 这些都是
 * 只有真机才会暴雷的问题，而真机报错通常只有一个 error_code。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

const captured = [];
/**
 * 可替换的发送处理器。默认返回空 body；需要真实回包的用例可以临时接管。
 * 注意不能用「替换 exports.sendMsgAsync」的方式——farm-api 在 require 时就解构了
 * 这个函数，替换 exports 影响不到它。
 */
let sendHandler = null;

// 拦截 network：记录每次发送的 service / method / payload
const networkId = require.resolve(path.join(SRC, 'utils', 'network'));
require.cache[networkId] = {
    id: networkId,
    filename: networkId,
    loaded: true,
    exports: {
        getUserState: () => ({ gid: 1284168173, accountId: 1 }),
        isConnected: () => true,
        networkEvents: { on() {}, emit() {} },
        sendMsgAsync: async (service, method, payload) => {
            captured.push({ service, method, payload: Buffer.from(payload) });
            if (sendHandler) return sendHandler(service, method, Buffer.from(payload));
            // 回一个空 reply：所有 Reply 类型都允许全空
            return { body: Buffer.alloc(0) };
        },
    },
};

const { loadProto, types } = require(path.join(SRC, 'utils', 'proto'));
const { toNum } = require(path.join(SRC, 'utils', 'utils'));
const api = require(path.join(SRC, 'services', 'pasture-api'));

/** 取出最近一次发送，并按给定类型解码 */
function lastAs(RequestType) {
    const last = captured[captured.length - 1];
    assert.ok(last, '应至少发送过一次');
    return { sent: last, decoded: RequestType.decode(last.payload) };
}

function toPlain(msg) {
    return JSON.parse(JSON.stringify(msg, (k, v) =>
        (v && typeof v === 'object' && typeof v.toNumber === 'function') ? v.toNumber() : v));
}

test.before(async () => {
    await loadProto();
});

test.afterEach(() => {
    captured.length = 0;
});

test('getRanchDetail：service/method/字段都对，且不传 id 时是空 repeated', async () => {
    await api.getRanchDetail();
    const { sent, decoded } = lastAs(types.GetRanchDetailRequest);
    assert.equal(sent.service, 'gamepb.animalpb.AnimalService');
    assert.equal(sent.method, 'GetRanchDetail');
    assert.deepEqual(toPlain(decoded).ranch_inst_ids || [], [], '未设置 repeated 时按空处理');

    await api.getRanchDetail([10001, 10002]);
    const second = lastAs(types.GetRanchDetailRequest);
    assert.deepEqual(toPlain(second.decoded).ranch_inst_ids, [10001, 10002],
        'int64 必须能被解回同样的数值');
});

test('harvestRanch：ranch_inst_ids + harvest_type（默认 1）', async () => {
    await api.harvestRanch([10001]);
    const { sent, decoded } = lastAs(types.HarvestRanchRequest);
    assert.equal(sent.service, 'gamepb.animalpb.AnimalService');
    assert.equal(sent.method, 'HarvestRanch');
    const plain = toPlain(decoded);
    assert.deepEqual(plain.ranch_inst_ids, [10001]);
    assert.equal(plain.harvest_type, 1, '默认 harvest_type 必须是抓包实测的 1');
});

test('feedAnimal：targets 是 {ranch_inst_id, animal_inst_id} 且 feed_type 落位', async () => {
    await api.feedAnimal([
        { ranchInstId: 10001, animalInstId: 7 },
        { ranchInstId: 10001, animalInstId: 11 },
    ], 2);
    const { sent, decoded } = lastAs(types.FeedAnimalRequest);
    assert.equal(sent.method, 'FeedAnimal');
    const plain = toPlain(decoded);
    assert.equal(plain.targets.length, 2);
    assert.equal(plain.targets[0].ranch_inst_id, 10001);
    assert.equal(plain.targets[0].animal_inst_id, 7);
    assert.equal(plain.targets[1].animal_inst_id, 11);
    assert.equal(plain.feed_type, 2);
});

test('cleanAllRanch：host_gid 落到 field 1，ranch_inst_ids 落到 field 2', async () => {
    await api.cleanAllRanch([10001], 1284168173);
    const { sent, decoded } = lastAs(types.CleanAllRanchRequest);
    assert.equal(sent.service, 'gamepb.animalpb.RanchService');
    assert.equal(sent.method, 'CleanAllRanch');
    const plain = toPlain(decoded);
    assert.equal(plain.host_gid, 1284168173, 'host_gid 超过 2^31，必须走 int64');
    assert.deepEqual(plain.ranch_inst_ids, [10001]);
});

test('stealProduce：不传 gid 时用自己登录态里的 gid', async () => {
    await api.stealProduce();
    const { sent, decoded } = lastAs(types.StealProduceRequest);
    assert.equal(sent.method, 'StealProduce');
    assert.equal(toPlain(decoded).host_gid, 1284168173);

    await api.stealProduce(1288674344);
    assert.equal(toPlain(lastAs(types.StealProduceRequest).decoded).host_gid, 1288674344);
});

test('getRanchOpTimes：默认请求三个已知 op_id', async () => {
    await api.getRanchOpTimes();
    const { sent, decoded } = lastAs(types.GetRanchOpTimesRequest);
    assert.equal(sent.service, 'gamepb.animalpb.RanchService');
    assert.deepEqual(toPlain(decoded).op_ids, [11003, 11008, 11009]);
});

test('triggerProduce：空请求', async () => {
    await api.triggerProduce();
    const { sent, decoded } = lastAs(types.TriggerProduceRequest);
    assert.equal(sent.method, 'TriggerProduce');
    assert.equal(sent.payload.length, 0, '无参数方法应发空 payload');
    assert.doesNotThrow(() => types.TriggerProduceRequest.decode(Buffer.alloc(0)));
    assert.ok(decoded);
});

test('facility 三个方法：service 名与字段', async () => {
    await api.getBuildingList();
    let item = captured[captured.length - 1];
    assert.equal(item.service, 'gamepb.homesteadpb.HomesteadService');
    assert.equal(item.method, 'GetBuildingList');

    await api.getFacilityDetail(10002);
    item = captured[captured.length - 1];
    assert.equal(item.method, 'GetFacilityDetail');
    assert.equal(toPlain(types.GetFacilityDetailRequest.decode(item.payload)).facility_inst_id, 10002);

    await api.addFeed(10002, 1);
    item = captured[captured.length - 1];
    assert.equal(item.service, 'gamepb.homesteadpb.FeedMachineService');
    assert.equal(item.method, 'AddFeed');
    const plain = toPlain(types.AddFeedRequest.decode(item.payload));
    assert.equal(plain.facility_inst_id, 10002);
    assert.equal(plain.count, 1);
});

test('回包能按 Reply 类型解码（空消息也是合法回包）', async () => {
    const detail = await api.getRanchDetail();
    assert.ok(detail !== undefined, 'decode 空 buffer 不应抛错');
    const quotas = await api.getRanchOpTimes();
    assert.ok(quotas !== undefined);
});

test('所有 10 个方法都用到了抓包确认过的 service 名', async () => {
    // afterEach 会清空 captured，这里自己发一轮覆盖四个 service
    await api.getRanchDetail();
    await api.cleanAllRanch([10001], 1284168173);
    await api.getBuildingList();
    await api.addFeed(10002, 1);
    const services = new Set(captured.map(c => c.service));
    assert.ok(services.has('gamepb.animalpb.AnimalService'));
    assert.ok(services.has('gamepb.animalpb.RanchService'));
    assert.ok(services.has('gamepb.homesteadpb.HomesteadService'));
    assert.ok(services.has('gamepb.homesteadpb.FeedMachineService'));
    assert.equal(services.size, 4, '只应出现这四个 service');
});
// ─── 第二轮抓包新增的方法 ───

test('placeAnimal：targets 里是 ranch_inst_id + animal_id（种类号）', async () => {
    await api.placeAnimal(10001, 60001);
    const { sent, decoded } = lastAs(types.PlaceAnimalRequest);
    assert.equal(sent.service, 'gamepb.animalpb.AnimalService');
    assert.equal(sent.method, 'PlaceAnimal');
    const plain = toPlain(decoded);
    assert.equal(plain.targets.length, 1);
    assert.equal(plain.targets[0].ranch_inst_id, 10001);
    assert.equal(plain.targets[0].animal_id, 60001, '必须落 animal_id 而不是 animal_inst_id');
});

test('cleanRanch：hazard_ids 是 packed repeated，host_gid 走 field 1', async () => {
    await api.cleanRanch([11, 12], 1233369866);
    const { sent, decoded } = lastAs(types.CleanRanchRequest);
    assert.equal(sent.service, 'gamepb.animalpb.RanchService');
    assert.equal(sent.method, 'CleanRanch');
    const plain = toPlain(decoded);
    assert.equal(plain.host_gid, 1233369866);
    assert.deepEqual(plain.hazard_ids, [11, 12]);
});

test('strokeAnimal：target 是 {ranch_inst_id, animal_inst_id}', async () => {
    await api.strokeAnimal(13, 10001, 1285654584);
    const { sent, decoded } = lastAs(types.StrokeAnimalRequest);
    assert.equal(sent.method, 'StrokeAnimal');
    const plain = toPlain(decoded);
    assert.equal(plain.host_gid, 1285654584);
    assert.equal(plain.target.ranch_inst_id, 10001);
    assert.equal(plain.target.animal_inst_id, 13);
});

test('stealProduce：带 target 时才写 field 2', async () => {
    await api.stealProduce(1288674344);
    let plain = toPlain(lastAs(types.StealProduceRequest).decoded);
    assert.equal(plain.target, undefined, '不指定目标时不写 target');

    await api.stealProduce(1288674344, { ranchInstId: 10001, animalInstId: 3 });
    plain = toPlain(lastAs(types.StealProduceRequest).decoded);
    assert.equal(plain.target.ranch_inst_id, 10001);
    assert.equal(plain.target.animal_inst_id, 3);
});

test('isAnimalItemId：只认 60xxx 段', () => {
    assert.equal(api.isAnimalItemId(60001), true);
    assert.equal(api.isAnimalItemId(60008), true);
    assert.equal(api.isAnimalItemId(1007), false, '牧场货币不是动物');
    assert.equal(api.isAnimalItemId(41435), false, '果实不是动物');
    assert.equal(api.isAnimalItemId(0), false);
    assert.equal(api.isAnimalItemId(undefined), false);
});

test('getAnimalShop：从候选 shop 里挑出含动物商品的店并缓存', async () => {
    api.resetAnimalShopCacheForTests();
    let shopInfoCalls = 0;
    sendHandler = (service, method, payload) => {
        if (method !== 'ShopInfo') return { body: Buffer.alloc(0) };
        shopInfoCalls += 1;
        const shopId = toNum(types.ShopInfoRequest.decode(payload).shop_id);
        // 只有 shop 4 有动物商品
        const goods = shopId === 4
            ? [{ id: 10002, item_id: 60001, price: 2, item_count: 1, unlocked: true },
               { id: 10003, item_id: 60002, price: 1080, item_count: 1, unlocked: true }]
            : [{ id: 9001, item_id: 20002, price: 10, item_count: 1, unlocked: true }];
        const Reply = types.ShopInfoReply;
        return { body: Reply.encode(Reply.create({ goods_list: goods })).finish() };
    };

    const shop = await api.getAnimalShop();
    assert.equal(shop.shopId, 4, '应挑出含动物商品的 shop');
    assert.equal(shop.goods.length, 2);
    assert.equal(shop.goods[0].animalId, 60001);
    assert.equal(shop.goods[1].price, 1080);

    // 第二次应该走缓存
    const before = shopInfoCalls;
    await api.getAnimalShop();
    assert.equal(shopInfoCalls, before, '缓存命中后不应再请求');

    sendHandler = null;
    api.resetAnimalShopCacheForTests();
});

test('getAnimalShop：没有动物商品时返回空结果', async () => {
    api.resetAnimalShopCacheForTests();
    sendHandler = () => {
        const Reply = types.ShopInfoReply;
        return { body: Reply.encode(Reply.create({
            goods_list: [{ id: 9001, item_id: 20002, price: 10 }],
        })).finish() };
    };
    const shop = await api.getAnimalShop();
    assert.equal(shop.shopId, 0);
    assert.deepEqual(shop.goods, []);
    sendHandler = null;
    api.resetAnimalShopCacheForTests();
});
