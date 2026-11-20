/**
 * 牧场 API 契约测试
 *
 * 不连服务器，只验证一件事：pasture-api 发出去的 payload 能被对应的
 * Request 类型原样解码回来（protobuf round-trip）。
 *
 * 这条断言能抓到字段名写错、Long/number 混用、repeated 结构错误 —— 这些都是
 * 只有真机才会暴雷的问题，而真机报错通常只有一个 error_code。
 *
 * 2026-11-20 协议层重建：改用官方 animalpb / ranchpb / homesteadpb 定义，
 * 消息统一以 Ranch 前缀注册（ranchpb 里有场景 2 的背包/商店/图鉴副本）。
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

function fieldsOf(Type) {
    return Object.keys(Type.fields || {}).sort();
}

test.before(async () => {
    await loadProto();
});

test.afterEach(() => {
    captured.length = 0;
    sendHandler = null;
});

test('getRanchDetail：service/method/字段都对，且不传 id 时是空 repeated', async () => {
    await api.getRanchDetail();
    const { sent, decoded } = lastAs(types.RanchGetRanchDetailRequest);
    assert.equal(sent.service, 'gamepb.animalpb.AnimalService');
    assert.equal(sent.method, 'GetRanchDetail');
    assert.deepEqual(toPlain(decoded).ranch_inst_ids || [], [], '未设置 repeated 时按空处理');

    await api.getRanchDetail([10001, 10002]);
    const second = lastAs(types.RanchGetRanchDetailRequest);
    assert.deepEqual(toPlain(second.decoded).ranch_inst_ids, [10001, 10002],
        'int64 必须能被解回同样的数值');
});

test('harvestRanch：op 走 field 3，默认 1（一键收获）', async () => {
    await api.harvestRanch({ ranchIds: [10001] });
    const { sent, decoded } = lastAs(types.RanchHarvestRanchRequest);
    assert.equal(sent.service, 'gamepb.animalpb.AnimalService');
    assert.equal(sent.method, 'HarvestRanch');
    const plain = toPlain(decoded);
    assert.deepEqual(plain.ranch_inst_ids, [10001]);
    assert.equal(plain.op, 1, '默认 op 必须是抓包实测的 1');
});

test('harvestRanch：op=4 指定动物/货架时带上 animals 与 shelves', async () => {
    await api.harvestRanch({
        op: 4,
        ranchIds: [10001],
        animals: [{ ranchInstId: 10001, animalInstId: 8 }],
        shelves: [{ ranchInstId: 10001, slotIndex: 2 }],
    });
    const plain = toPlain(lastAs(types.RanchHarvestRanchRequest).decoded);
    assert.equal(plain.op, 4);
    assert.equal(plain.animals[0].animal_inst_id, 8);
    assert.equal(plain.shelves[0].slot_index, 2);
});

test('harvestRanch：op=2 时只带 ranch_inst_ids（只收产物）', async () => {
    await api.harvestRanch({ op: 2, ranchIds: [10001] });
    const plain = toPlain(lastAs(types.RanchHarvestRanchRequest).decoded);
    assert.equal(plain.op, 2);
    assert.equal(plain.animals, undefined);
    assert.equal(plain.shelves, undefined);
});

test('feedAnimal：targets 是 {ranch_inst_id, animal_inst_id} 且 bucket_type 落位', async () => {
    await api.feedAnimal([
        { ranchInstId: 10001, animalInstId: 7 },
        { ranchInstId: 10001, animalInstId: 11 },
    ], 2);
    const { sent, decoded } = lastAs(types.RanchFeedAnimalRequest);
    assert.equal(sent.method, 'FeedAnimal');
    const plain = toPlain(decoded);
    assert.equal(plain.targets.length, 2);
    assert.equal(plain.targets[0].ranch_inst_id, 10001);
    assert.equal(plain.targets[0].animal_inst_id, 7);
    assert.equal(plain.targets[1].animal_inst_id, 11);
    assert.equal(plain.bucket_type, 2, '2 = 普通罐头桶（7003）');
});

test('cleanAllRanch：host_gid 落到 field 1，ranch_inst_ids 落到 field 2', async () => {
    await api.cleanAllRanch([10001], 1284168173);
    const { sent, decoded } = lastAs(types.RanchCleanAllRanchRequest);
    assert.equal(sent.service, 'gamepb.animalpb.RanchService');
    assert.equal(sent.method, 'CleanAllRanch');
    const plain = toPlain(decoded);
    assert.equal(plain.host_gid, 1284168173, 'host_gid 超过 2^31，必须走 int64');
    assert.deepEqual(plain.ranch_inst_ids, [10001]);
});

test('stealProduce：不传 gid 时用自己登录态里的 gid', async () => {
    await api.stealProduce();
    const { sent, decoded } = lastAs(types.RanchStealProduceRequest);
    assert.equal(sent.method, 'StealProduce');
    assert.equal(toPlain(decoded).host_gid, 1284168173);

    await api.stealProduce(1288674344);
    assert.equal(toPlain(lastAs(types.RanchStealProduceRequest).decoded).host_gid, 1288674344);
});

test('stealProduce：targets 是货架引用（ranch_inst_id + slot_index）', async () => {
    await api.stealProduce(1288674344);
    let plain = toPlain(lastAs(types.RanchStealProduceRequest).decoded);
    assert.equal(plain.targets, undefined, '不指定目标时不写 targets');

    await api.stealProduce(1288674344, [{ ranchInstId: 10001, slotIndex: 3 }]);
    plain = toPlain(lastAs(types.RanchStealProduceRequest).decoded);
    assert.equal(plain.targets[0].ranch_inst_id, 10001);
    assert.equal(plain.targets[0].slot_index, 3);
});

test('getRanchOpTimes：默认请求空 op_ids（服务端返回全部配额）', async () => {
    await api.getRanchOpTimes();
    const { sent, decoded } = lastAs(types.RanchGetRanchOpTimesRequest);
    assert.equal(sent.service, 'gamepb.animalpb.RanchService');
    assert.deepEqual(toPlain(decoded).op_ids || [], []);

    await api.getRanchOpTimes([11009]);
    assert.deepEqual(toPlain(lastAs(types.RanchGetRanchOpTimesRequest).decoded).op_ids, [11009]);
});

test('triggerProduce：空请求', async () => {
    await api.triggerProduce();
    const { sent, decoded } = lastAs(types.RanchTriggerProduceRequest);
    assert.equal(sent.method, 'TriggerProduce');
    assert.equal(sent.payload.length, 0, '无参数方法应发空 payload');
    assert.doesNotThrow(() => types.RanchTriggerProduceRequest.decode(Buffer.alloc(0)));
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
    assert.equal(toPlain(types.RanchGetFacilityDetailRequest.decode(item.payload)).instance_id, 10002);

    await api.addFeed(10002, 1);
    item = captured[captured.length - 1];
    assert.equal(item.service, 'gamepb.homesteadpb.FeedMachineService');
    assert.equal(item.method, 'AddFeed');
    const plain = toPlain(types.RanchAddFeedRequest.decode(item.payload));
    assert.equal(plain.instance_id, 10002);
    assert.equal(plain.add_count, 1);
    assert.equal(plain.use_gold, false);
});

test('activateFacility：只带 instance_id', async () => {
    await api.activateFacility(10003);
    const { sent, decoded } = lastAs(types.RanchActivateFacilityRequest);
    assert.equal(sent.method, 'ActivateFacility');
    assert.equal(toPlain(decoded).instance_id, 10003);
});

test('回包能按 Reply 类型解码（空消息也是合法回包）', async () => {
    const detail = await api.getRanchDetail();
    assert.ok(detail !== undefined, 'decode 空 buffer 不应抛错');
    const quotas = await api.getRanchOpTimes();
    assert.ok(quotas !== undefined);
});

test('所有基础方法都用到了抓包确认过的 service 名', async () => {
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

test('placeAnimal：items 里是 ranch_inst_id + animal_id（种类号）', async () => {
    await api.placeAnimal(10001, 60001);
    const { sent, decoded } = lastAs(types.RanchPlaceAnimalRequest);
    assert.equal(sent.service, 'gamepb.animalpb.AnimalService');
    assert.equal(sent.method, 'PlaceAnimal');
    const plain = toPlain(decoded);
    assert.equal(plain.items.length, 1);
    assert.equal(plain.items[0].ranch_inst_id, 10001);
    assert.equal(plain.items[0].animal_id, 60001, '必须落 animal_id 而不是 animal_inst_id');
});

test('placeAnimal：巨大幼崽带 giant_cub_item_id', async () => {
    await api.placeAnimal(10001, 60001, 61001);
    const plain = toPlain(lastAs(types.RanchPlaceAnimalRequest).decoded);
    assert.equal(plain.items[0].giant_cub_item_id, 61001);
});

test('cleanRanch：hazard_ids 是 packed repeated，host_gid 走 field 1', async () => {
    await api.cleanRanch([11, 12], 1233369866);
    const { sent, decoded } = lastAs(types.RanchCleanRanchRequest);
    assert.equal(sent.service, 'gamepb.animalpb.RanchService');
    assert.equal(sent.method, 'CleanRanch');
    const plain = toPlain(decoded);
    assert.equal(plain.host_gid, 1233369866);
    assert.deepEqual(plain.hazard_ids, [11, 12]);
});

test('strokeAnimal：target 是 {ranch_inst_id, animal_inst_id}', async () => {
    await api.strokeAnimal(13, 10001, 1285654584);
    const { sent, decoded } = lastAs(types.RanchStrokeAnimalRequest);
    assert.equal(sent.method, 'StrokeAnimal');
    const plain = toPlain(decoded);
    assert.equal(plain.host_gid, 1285654584);
    assert.equal(plain.target.ranch_inst_id, 10001);
    assert.equal(plain.target.animal_inst_id, 13);
});

test('putHazard：op_id 固定 11003，count 走 field 4', async () => {
    await api.putHazard(10001, 1288674344, 1);
    const { sent, decoded } = lastAs(types.RanchPutHazardRequest);
    assert.equal(sent.service, 'gamepb.animalpb.RanchService');
    assert.equal(sent.method, 'PutHazard');
    const plain = toPlain(decoded);
    assert.equal(plain.ranch_inst_id, 10001);
    assert.equal(plain.host_gid, 1288674344);
    assert.equal(plain.op_id, 11003);
    assert.equal(plain.count, 1);
});

test('donateAnimal：targets 必填，不支持一键', async () => {
    await api.donateAnimal([{ ranchInstId: 10001, animalInstId: 22 }]);
    const { sent, decoded } = lastAs(types.RanchDonateAnimalRequest);
    assert.equal(sent.method, 'DonateAnimal');
    const plain = toPlain(decoded);
    assert.equal(plain.targets.length, 1);
    assert.equal(plain.targets[0].animal_inst_id, 22);
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

// ─── 真机回包回归 ───

/**
 * 2026-11-16 真机踩到的解码错位回归样本。
 *
 * 当时把 HarvestRanchReply 的 field 5 误解成自定义结构，protobufjs 按错误
 * message 解就错位（invalid wire type 6 at offset 357）。官方定义里 field 5
 * 就是 repeated FacilityOpResult{1:facility_inst_id 2:kind 3:target_id 10:rewards}，
 * 正好对上当年观测到的 {1:..., 2:2, 3:4, 10:{...}}。
 * 这段字节同时验证 animals 不被明细字段带偏。
 */
const HARVEST_FAIL_HEX = '0a8b0208914e10041803224e08914e1002180820e2d4032803300150ca94ec999e3458fedea39d9e3470d9cde1989e347801900101980101a00101a801e802b2010608ef0710f010b801b401c2010608ef0710d40cf201024001225c08914e1003180c20e3d4032803300150ca94ec999e3458fe98dba09e3470fdf6eb999e347801900101980101a00101a801c806b2010608f00710eb01b801a403c2010508f007105af201110801100118f50420cf7e38ca94ec999e34224e08914e1004180b20e3d4032803300150ca94ec999e3458fe98dba09e347096efe0989e347801900101980101a00101a801c806b2010608ef0710b02ab801a403c2010608ef0710d21ff2010240012a02086230012a2508914e10011807521108e2dd7d1001a20608220608ef0710f010520908ce0810e802a206002a2408914e10021801521008a2d940101ea20607220508ef071036520908ce0810b401a206002a2408914e10021802521008a2d940101ea20607220508ef071036520908ce0810b401a206002a2408914e10021803521008ab8041101ea20607220508f0071003520908ce0810a403a206002a2508914e10021804521108a3d940101ea20608220608ef07108701520908ce0810a403a20600';

test('HarvestRanch 真机响应：ranches 与 op_results 都能解，animal 不丢', () => {
    const bytes = Buffer.from(HARVEST_FAIL_HEX, 'hex');
    let decoded;
    assert.doesNotThrow(() => { decoded = types.RanchHarvestRanchReply.decode(bytes); },
        '带 field 5 明细的响应必须能解，不能报 invalid wire type');

    const obj = toPlain(decoded);
    assert.equal(obj.ranches.length, 1, 'ranches 必须解出来');
    assert.equal(obj.ranches[0].ranch_inst_id, 10001);
    assert.equal(obj.ranches[0].capacity, 4);
    assert.equal(obj.ranches[0].animals.length, 3, '3 只动物必须都在，不能因为明细字段错位而丢');
    assert.equal(obj.ranches[0].animals[0].animal_inst_id, 8);
    assert.equal(obj.ranches[0].animals[0].animal_id, 60002);
    assert.equal(obj.ranches[0].grass.amount, 98);
    assert.ok(Array.isArray(obj.op_results) && obj.op_results.length > 0,
        'field 5 应解成 op_results');
});

test('HarvestRanchReply / FeedAnimalReply 的关键回包字段都在', () => {
    assert.deepEqual(fieldsOf(types.RanchHarvestRanchReply),
        ['giant_shares', 'op_results', 'ranches']);
    assert.deepEqual(fieldsOf(types.RanchFeedAnimalReply),
        ['bucket_remain_secs', 'deduct_secs', 'op_results', 'ranches']);
    assert.deepEqual(fieldsOf(types.RanchCleanRanchReply), ['op_results', 'ranches']);
    assert.deepEqual(fieldsOf(types.RanchDonateAnimalReply), ['op_results', 'ranches']);
    assert.deepEqual(fieldsOf(types.RanchPutHazardReply),
        ['actual_count', 'hazards', 'remaining_times', 'rewards']);
});

test('FacilityOpResult 的 kind/target_id 是判定操作结果的唯一依据', () => {
    assert.deepEqual(fieldsOf(types.RanchFacilityOpResult),
        ['costs', 'facility_inst_id', 'kind', 'rewards', 'target_id']);
});

// ─── 场景 2 副本：背包 / 商店 / 任务 / 图鉴 / 分享 / 好友 ───

test('牧场背包用 ranchpb 副本并强制 global_scene_id=2', async () => {
    sendHandler = () => {
        const Reply = types.RanchGetBagReply;
        return { body: Reply.encode(Reply.create({ global_scene_id: 2 })).finish() };
    };
    await api.getBag();
    const { sent, decoded } = lastAs(types.RanchGetBagRequest);
    assert.equal(sent.service, 'gamepb.itempb.ItemService');
    assert.equal(sent.method, 'GetBag');
    assert.equal(toPlain(decoded).global_scene_id, 2);
    sendHandler = null;
});

test('牧场背包回包场景不对时报 RANCH_RESPONSE_MISMATCH', async () => {
    sendHandler = () => {
        const Reply = types.RanchGetBagReply;
        return { body: Reply.encode(Reply.create({ global_scene_id: 1 })).finish() };
    };
    await assert.rejects(() => api.getBag(), /场景不匹配/);
    sendHandler = null;
});

test('sellItems / useItem 走牧场副本结构', async () => {
    await api.sellItems([{ id: 1060001, uid: 9001, count: 4 }]);
    let plain = toPlain(lastAs(types.RanchSellRequest).decoded);
    assert.equal(plain.items[0].uid, 9001);
    assert.equal(plain.items[0].count, 4);

    await api.useItem({ id: 7003, uid: 9002, count: 1 });
    plain = toPlain(lastAs(types.RanchUseRequest).decoded);
    assert.equal(plain.item.id, 7003);
    assert.equal(plain.item.uid, 9002);
});

test('集市：RotationShopInfo 带 shop_id=7，兑换带 period_day / round_index', async () => {
    await api.getRotationShopInfo();
    let plain = toPlain(lastAs(types.RanchRotationShopInfoRequest).decoded);
    assert.equal(plain.shop_id, 7);

    await api.rotationBuyGoods(80011, 2, 20261120, 3);
    plain = toPlain(lastAs(types.RanchRotationBuyGoodsRequest).decoded);
    assert.equal(plain.goods_id, 80011);
    assert.equal(plain.count, 2);
    assert.equal(plain.period_day, 20261120);
    assert.equal(plain.round_index, 3);
});

test('罐头商城：带 global_scene_id=2 且 goods_list 能二次解码', async () => {
    sendHandler = () => {
        const goods = types.MallGoods.encode(types.MallGoods.create({
            goods_id: 2001, name: '每日福利', is_free: true,
        })).finish();
        const Reply = types.GetMallListBySlotTypeResponse;
        return { body: Reply.encode(Reply.create({ goods_list: [goods] })).finish() };
    };
    const reply = await api.getCanMallList(6);
    const plain = toPlain(lastAs(types.GetMallListBySlotTypeRequest).decoded);
    assert.equal(plain.slot_type, 6);
    assert.equal(plain.global_scene_id, 2);
    assert.equal(plain.is_manual_open, true);
    assert.equal(reply.goods.length, 1);
    assert.equal(reply.goods[0].goods_id, 2001);
    assert.equal(reply.goods[0].is_free, true);
    sendHandler = null;
});

test('任务：scene_id=2，领取与上报字段都对', async () => {
    await api.getRanchTasks();
    assert.equal(toPlain(lastAs(types.TaskInfoRequest).decoded).scene_id, 2);

    await api.claimRanchTask(300008, true);
    const single = toPlain(lastAs(types.ClaimTaskRewardRequest).decoded);
    assert.equal(single.id, 300008);
    assert.equal(single.do_shared, true);

    await api.claimRanchTasks([300008, 300009]);
    assert.deepEqual(toPlain(lastAs(types.BatchClaimTaskRewardRequest).decoded).ids, [300008, 300009]);

    await api.reportRanchTaskProgress(300008, 5);
    const report = toPlain(lastAs(types.ClientReportProgressRequest).decoded);
    assert.equal(report.task_id, 300008);
    assert.equal(report.progress, 5);
});

test('图鉴：type 101，重量分档与领奖字段都对', async () => {
    sendHandler = () => {
        const Reply = types.RanchGetIllustratedListV2Reply;
        return { body: Reply.encode(Reply.create({ type: 101, has_claimable_reward: true })).finish() };
    };
    await api.getIllustratedList();
    assert.equal(toPlain(lastAs(types.RanchGetIllustratedListV2Request).decoded).type, 101);
    sendHandler = null;

    await api.getRanchWeightScore();
    assert.deepEqual(fieldsOf(types.RanchGetRanchWeightScoreV2Request), []);

    await api.claimIllustratedRewards();
    assert.equal(toPlain(lastAs(types.RanchClaimAllRewardsV2Request).decoded).type, 101);

    await api.claimRanchWeightScoreReward(7);
    assert.equal(toPlain(lastAs(types.RanchClaimRanchWeightScoreRewardV2Request).decoded).id, 7);
});

test('分享：每日礼包 102/2101，任务翻倍 103/2104', async () => {
    await api.reportShare(102, [], 2101);
    let plain = toPlain(lastAs(types.RanchReportShareRequest).decoded);
    assert.equal(plain.share_id, 102);
    assert.equal(plain.doc_id, 2101);

    await api.reportShare(103, [300008], 2104);
    plain = toPlain(lastAs(types.RanchReportShareRequest).decoded);
    assert.equal(plain.share_id, 103);
    assert.deepEqual(plain.params, [300008]);
    assert.equal(plain.doc_id, 2104);

    await api.claimShareReward(102);
    assert.equal(toPlain(lastAs(types.RanchClaimShareRewardRequest).decoded).share_id, 102);
});

test('好友牧场：EnterHomestead 带 reason=2，Leave 带 host_gid', async () => {
    await api.enterHomestead(1288674344);
    const enter = toPlain(lastAs(types.RanchEnterHomesteadRequest).decoded);
    assert.equal(enter.host_gid, 1288674344);
    assert.equal(enter.reason, 2);

    await api.leaveHomestead(1288674344);
    assert.equal(toPlain(lastAs(types.RanchLeaveHomesteadRequest).decoded).host_gid, 1288674344);
});

test('新增接口的调用函数都已导出', () => {
    for (const fn of ['cannelNew', 'upgradeBuilding', 'completeBuildingUpgrade',
        'activateFacility', 'getRanchWeightScore', 'getIllustratedList',
        'claimIllustratedRewards', 'getRotationShopInfo', 'rotationBuyGoods',
        'enterHomestead', 'leaveHomestead', 'putHazard', 'donateAnimal',
        'getBag', 'getBagTabs', 'sellItems', 'useItem', 'getCanMallList', 'purchaseCan',
        'getRanchTasks', 'claimRanchTasks', 'reportRanchTaskProgress',
        'checkCanShare', 'reportShare', 'claimShareReward', 'getAllCells']) {
        assert.equal(typeof api[fn], 'function', `${fn} 应已导出`);
    }
});

test('设施三件套的请求字段：instance_id / inst_id', () => {
    assert.deepEqual(fieldsOf(types.RanchGetFacilityDetailRequest), ['host_gid', 'instance_id']);
    assert.deepEqual(fieldsOf(types.RanchUpgradeBuildingRequest), ['inst_id']);
    assert.deepEqual(fieldsOf(types.RanchCompleteBuildingUpgradeRequest), ['inst_id']);
    assert.deepEqual(fieldsOf(types.RanchActivateFacilityRequest), ['instance_id']);
});

test('CannelNew 只带 item_id', () => {
    assert.deepEqual(fieldsOf(types.CannelNewRequest), ['item_id']);
});

test('牧场背包的 Item 带 show / item_detail（与农场 corepb.Item 不同）', () => {
    const fields = fieldsOf(types.RanchItem);
    assert.ok(fields.includes('show'));
    assert.ok(fields.includes('item_detail'));
    assert.ok(fields.includes('is_locked'));
    // 农场侧 corepb.Item 未注册进 types（防止误用两份定义混写）；
    // 这里只确认牧场这份是 ranchpb 的富结构。
    assert.ok(fields.includes('gift_detail'));
});