/**
 * 牧场 RPC 收口
 *
 * 全部方法名与字段来自 2026-11-16 真机抓包，定义见 proto/pasturepb.proto
 * 与 proto/homesteadpb.proto。与 farm-api.js 保持同样的形状：
 * 只做「构造请求 → 发送 → 解码回包」，不含任何业务判断。
 *
 * 注意：请求体由 network.js 负责 TSDK 加密，回包是明文 —— 这里不需要
 * 任何额外加解密，直接 encode/decode。
 */

const { sendMsgAsync, getUserState } = require('../utils/network');
const { types, waitForProtoReady } = require('../utils/proto');
const { toLong, toNum } = require('../utils/utils');
const { getShopInfo, buyGoods } = require('./farm-api');

/** 服务名常量：抓包确认的两个 service */
const ANIMAL_SERVICE = 'gamepb.animalpb.AnimalService';
const RANCH_SERVICE = 'gamepb.animalpb.RanchService';
const HOMESTEAD_SERVICE = 'gamepb.homesteadpb.HomesteadService';
const FEED_MACHINE_SERVICE = 'gamepb.homesteadpb.FeedMachineService';

/** 牧场操作 ID（GetRanchOpTimes 里出现的配额编号，语义待对照确认） */
const RANCH_OP_IDS = [11003, 11008, 11009];

/** 牧草机设施模板 ID（抓包实测） */
const FEED_MACHINE_FACILITY_ID = 7001001;

/**
 * 动物类道具的 item_id 段（抓包实测：60001~60008 全部是动物）。
 * 动物商店里 goods.goods_id 是 10002 起，goods.item_id 才是动物种类号。
 */
const ANIMAL_ITEM_ID_MIN = 60000;
const ANIMAL_ITEM_ID_MAX = 60999;

/** 候选动物商店 shop_id：抓包里出现过 2/4/5，实测动物在其中一个 */
const ANIMAL_SHOP_CANDIDATES = [2, 4, 5];

function isAnimalItemId(itemId) {
    // protobufjs 解 int64 给的是 Long 对象，Number(Long) 不可靠，统一走 toNum
    const id = toNum(itemId);
    return id >= ANIMAL_ITEM_ID_MIN && id <= ANIMAL_ITEM_ID_MAX;
}

// ─── 内部辅助 ───

async function sendPastureRequest(service, method, ReqType, ReplyType, payloadObj) {
    await waitForProtoReady();
    const payload = ReqType.encode(ReqType.create(payloadObj)).finish();
    const { body } = await sendMsgAsync(service, method, payload);
    return ReplyType.decode(body);
}

/** 自身的 host_gid（从登录态取） */
function selfGid() {
    const userState = getUserState();
    return userState && userState.gid ? userState.gid : 0;
}

// ─── 牧场查询 ───

/**
 * 拉取牧场详情。
 * @param {number[]} [ranchIds] 留空表示该主人的全部牧场
 * @param {number} [hostGid] 看好友牧场时传好友 gid；不传=自己
 */
async function getRanchDetail(ranchIds, hostGid) {
    const ids = Array.isArray(ranchIds) ? ranchIds : [];
    const payload = { ranch_inst_ids: ids.map(id => toLong(id)) };
    if (hostGid) payload.host_gid = toLong(hostGid);
    return sendPastureRequest(
        ANIMAL_SERVICE, 'GetRanchDetail',
        types.GetRanchDetailRequest, types.GetRanchDetailReply,
        payload
    );
}

/** 拉取操作次数配额 */
async function getRanchOpTimes(opIds = RANCH_OP_IDS) {
    return sendPastureRequest(
        RANCH_SERVICE, 'GetRanchOpTimes',
        types.GetRanchOpTimesRequest, types.GetRanchOpTimesReply,
        { op_ids: opIds.map(id => toLong(id)) }
    );
}

// ─── 牧场操作 ───

/**
 * 收获（货架产物 + 成熟动物产物）
 * @param {number[]} ranchIds
 * @param {number} [harvestType] 抓包实测为 1
 */
/**
 * 一键收获。harvest_type 的语义由真机的服务端错误码确定：
 *   1 —— 收获（把可收获动物收出栏）
 *   2 —— 只收产物；没有可收产物时返回业务码 1045229「当前没有可收取的产物」
 * 所以有成熟动物时用 1，只有货架产物时用 2 —— 混用会让产物走「收获」路径，
 * 产物不入账、只给经验，表现出来就是牧场一直在跑却在亏牧场币。
 */
async function harvestRanch(ranchIds, harvestType = 1) {
    return sendPastureRequest(
        ANIMAL_SERVICE, 'HarvestRanch',
        types.HarvestRanchRequest, types.HarvestRanchReply,
        {
            ranch_inst_ids: (ranchIds || []).map(id => toLong(id)),
            harvest_type: harvestType,
        }
    );
}

/**
 * 喂罐头。targets 是 {ranch_inst_id, animal_inst_id} 列表。
 *
 * 抓包确认（capture 14_02_01）：这个 RPC 就是游戏里的「喂罐头」本身 ——
 * 用户操作「喂罐头 → 催生产 → 收获鸡蛋」对应 7.83s FeedAnimal、
 * 11.88s TriggerProduce、14.92s HarvestRanch。它不是免费投喂，
 * 自动调用等于替玩家消耗罐头。默认因此关闭（`pasture_feed: false`）。
 *
 * 免费的牧草路径是牧草机：`addFeed()`（homesteadpb.AddFeed）。
 *
 * @param {{ranchInstId:number, animalInstId:number}[]} targets
 * @param {number} [feedType] 1 / 2 的分工仍未确定
 */
async function feedAnimal(targets, feedType = 1) {
    const list = (targets || []).map(t => ({
        ranch_inst_id: toLong(t.ranchInstId),
        animal_inst_id: toLong(t.animalInstId),
    }));
    return sendPastureRequest(
        ANIMAL_SERVICE, 'FeedAnimal',
        types.FeedAnimalRequest, types.FeedAnimalReply,
        { targets: list, feed_type: feedType }
    );
}

/** 触发生产（无参数） */
async function triggerProduce() {
    return sendPastureRequest(
        ANIMAL_SERVICE, 'TriggerProduce',
        types.TriggerProduceRequest, types.TriggerProduceReply,
        {}
    );
}

/**
 * 收取副产品（货架上的蛋/奶）。
 *
 * ❌ 已确认此方法不存在，**不要调用**。
 *
 * 2026-11-17 用两份官方客户端 HAR 全量扫描后定案：160 秒正常游玩抓到 70 种
 * 接口、以及一次明确「催产 + 捡蛋」的操作，都没有 CollectProduce。捡蛋走的是
 * `harvestRanch` —— 服务端回包里 `animal_count` 不变、`produce_count` 变化，
 * 说明它按动物状态自己决定是「只交产物」还是「收出栏」。
 *
 * 之前穷举 AnimalService / RanchService × 空 body × 字段 1/2/3 ×
 * varint/packed/嵌套 message 全部返回 1020002，现在有了原因：网关没有这个方法。
 * 保留函数与 proto 定义仅作记录，货架收取已并入 performHarvest。
 */
async function collectProduce(ranchIds) {
    const ids = Array.isArray(ranchIds) && ranchIds.length ? ranchIds : [10001];
    const payload = { ranch_inst_ids: ids.map(id => toLong(id)) };
    return sendPastureRequest(
        ANIMAL_SERVICE, 'CollectProduce',
        types.CollectProduceRequest, types.CollectProduceReply,
        payload
    );
}

/**
 * 偷取好友牧场产物
 * @param {number} [hostGid] 被偷者 gid（好友）；不传则用自己
 * @param {{ranchInstId:number, animalInstId:number}} [target] 指定偷哪只；不传=全部可偷
 */
async function stealProduce(hostGid, target) {
    const gid = hostGid || selfGid();
    const payload = { host_gid: toLong(gid) };
    if (target && target.animalInstId) {
        payload.target = {
            ranch_inst_id: toLong(target.ranchInstId),
            animal_inst_id: toLong(target.animalInstId),
        };
    }
    return sendPastureRequest(
        ANIMAL_SERVICE, 'StealProduce',
        types.StealProduceRequest, types.StealProduceReply,
        payload
    );
}

/**
 * 把背包里的动物放进栏舍。服务端自行分配 slot。
 * @param {number} ranchInstId
 * @param {number} animalId 动物种类号（60001），不是实例号
 */
async function placeAnimal(ranchInstId, animalId) {
    return sendPastureRequest(
        ANIMAL_SERVICE, 'PlaceAnimal',
        types.PlaceAnimalRequest, types.PlaceAnimalReply,
        { targets: [{ ranch_inst_id: toLong(ranchInstId), animal_id: toLong(animalId) }] }
    );
}

/**
 * 定点清理指定灾害。
 * @param {number[]} hazardIds - RanchInfo.hazards[].hazard_id
 * @param {number} [hostGid]
 */
async function cleanRanch(hazardIds, hostGid) {
    const gid = hostGid || selfGid();
    return sendPastureRequest(
        RANCH_SERVICE, 'CleanRanch',
        types.CleanRanchRequest, types.CleanRanchReply,
        { host_gid: toLong(gid), hazard_ids: (hazardIds || []).map(id => toLong(id)) }
    );
}

/**
 * 抚摸动物（重量/变异交互）。
 * @param {number} animalInstId
 * @param {number} ranchInstId
 * @param {number} [hostGid]
 */
async function strokeAnimal(animalInstId, ranchInstId, hostGid) {
    const gid = hostGid || selfGid();
    return sendPastureRequest(
        RANCH_SERVICE, 'StrokeAnimal',
        types.StrokeAnimalRequest, types.StrokeAnimalReply,
        {
            host_gid: toLong(gid),
            target: {
                ranch_inst_id: toLong(ranchInstId),
                animal_inst_id: toLong(animalInstId),
            },
        }
    );
}

/**
 * 找动物商店并把商品列表拍平。
 *
 * 抓包无法确定动物店的确切 shop_id（请求体加密，读出来是随机字节），
 * 所以按候选逐个试，返回第一个含动物商品的店。结果缓存，只探一次。
 *
 * @returns {Promise<{shopId:number, goods:object[]}>}
 */
let animalShopCache = null;
async function getAnimalShop(force = false) {
    if (animalShopCache && !force) return animalShopCache;
    for (const shopId of ANIMAL_SHOP_CANDIDATES) {
        let reply;
        try {
            reply = await getShopInfo(shopId);
        } catch {
            continue;
        }
        const list = (reply && reply.goods_list) || [];
        const animals = list.filter(g => isAnimalItemId(g.item_id));
        if (animals.length > 0) {
            animalShopCache = {
                shopId,
                goods: animals.map(g => ({
                    goodsId: toNum(g.id),
                    animalId: toNum(g.item_id),
                    price: toNum(g.price),
                    count: toNum(g.item_count) || 1,
                    unlocked: !!g.unlocked,
                })),
            };
            return animalShopCache;
        }
    }
    animalShopCache = { shopId: 0, goods: [] };
    return animalShopCache;
}

/** 供测试重置商店缓存 */
function resetAnimalShopCacheForTests() {
    animalShopCache = null;
}

/**
 * 一键清理牧场灾害（虫/杂草）
 * @param {number[]} [ranchIds]
 * @param {number} [hostGid]
 */
async function cleanAllRanch(ranchIds, hostGid) {
    const gid = hostGid || selfGid();
    return sendPastureRequest(
        RANCH_SERVICE, 'CleanAllRanch',
        types.CleanAllRanchRequest, types.CleanAllRanchReply,
        {
            host_gid: toLong(gid),
            ranch_inst_ids: (ranchIds || []).map(id => toLong(id)),
        }
    );
}

// ─── 设施 / 牧草机 ───

/** 建筑列表 */
async function getBuildingList() {
    return sendPastureRequest(
        HOMESTEAD_SERVICE, 'GetBuildingList',
        types.GetBuildingListRequest, types.GetBuildingListReply,
        {}
    );
}

/**
 * 设施详情
 * @param {number} facilityInstId 例如牧草机 10002
 */
async function getFacilityDetail(facilityInstId) {
    return sendPastureRequest(
        HOMESTEAD_SERVICE, 'GetFacilityDetail',
        types.GetFacilityDetailRequest, types.GetFacilityDetailReply,
        { facility_inst_id: toLong(facilityInstId) }
    );
}

/**
 * 牧草机加料
 * @param {number} facilityInstId
 * @param {number} [count]
 */
async function addFeed(facilityInstId, count = 1) {
    return sendPastureRequest(
        FEED_MACHINE_SERVICE, 'AddFeed',
        types.AddFeedRequest, types.AddFeedReply,
        { facility_inst_id: toLong(facilityInstId), count: toLong(count) }
    );
}


const ITEM_SERVICE = 'gamepb.itempb.ItemService';
const SHOP_SERVICE = 'gamepb.shoppb.ShopService';
const ILLUSTRATED_SERVICE = 'gamepb.illustratedpb.IllustratedService';
const VISIT_SERVICE = 'gamepb.visitpb.VisitService';

/**
 * 清除「新物品」标记。
 *
 * 抓包（查看牧场仓库-出售鸡蛋-批量出售.har）里，批量出售前会对每个产物先调一次
 * （1060001 / 1065002 / 1065003）。参数由长度与差异模式确定：密文 4 字节，
 * 1065002 与 1065003 只差 1，对应 varint 只有最低 7 位不同，与观测到的
 * 「仅第 2 字节不同」吻合；回包 f1 原样回传同一个 item_id。
 */
async function cannelNew(itemId) {
    return sendPastureRequest(
        ITEM_SERVICE, 'CannelNew',
        types.CannelNewRequest, types.CannelNewReply,
        { item_id: toLong(itemId) }
    );
}

/**
 * 升级建筑（牧草机等）。
 *
 * 参数由密文比对确定：UpgradeBuilding 与 CompleteBuildingUpgrade 的请求密文
 * 与 GetFacilityDetail 完全相同（都是 3 字节 e97375），而 GetFacilityDetail
 * 的参数已知是 {1: facility_inst_id}；TSDK 加密是确定性的，所以参数就是
 * {1: facility_inst_id}。
 */
async function upgradeBuilding(facilityInstId) {
    return sendPastureRequest(
        HOMESTEAD_SERVICE, 'UpgradeBuilding',
        types.UpgradeBuildingRequest, types.UpgradeBuildingReply,
        { facility_inst_id: toLong(facilityInstId) }
    );
}

/** 升级完成（耗时结束后调用），参数同 UpgradeBuilding。 */
async function completeBuildingUpgrade(facilityInstId) {
    return sendPastureRequest(
        HOMESTEAD_SERVICE, 'CompleteBuildingUpgrade',
        types.CompleteBuildingUpgradeRequest, types.CompleteBuildingUpgradeReply,
        { facility_inst_id: toLong(facilityInstId) }
    );
}

/**
 * 牧场权重分。抓包确认请求体为空。
 * 回包 {1:<score> 2:<threshold>}，图鉴等级奖励按这个分数解锁。
 */
async function getRanchWeightScore() {
    return sendPastureRequest(
        ILLUSTRATED_SERVICE, 'GetRanchWeightScoreV2',
        types.GetRanchWeightScoreV2Request, types.GetRanchWeightScoreV2Reply,
        {}
    );
}

/**
 * 牧场图鉴等级奖励列表。抓包正文 2 字节，按 {1: illustrated_type} 发送
 * （类型值尚未取得明文证据，调用方需实测）。
 */
async function getIllustratedLevelList(illustratedType = 1) {
    return sendPastureRequest(
        ILLUSTRATED_SERVICE, 'GetIllustratedLevelListV2',
        types.GetIllustratedLevelListV2Request, types.GetIllustratedLevelListV2Reply,
        { illustrated_type: illustratedType }
    );
}

/**
 * 兑换集市（轮换商店）。抓包正文 2 字节，按 {1: shop_type} 发送。
 * 回包含分类 5、商品 6（goods_id / 消耗物品 / 限购）。
 */
async function getRotationShopInfo(shopType = 1) {
    return sendPastureRequest(
        SHOP_SERVICE, 'RotationShopInfo',
        types.RotationShopInfoRequest, types.RotationShopInfoReply,
        { shop_type: shopType }
    );
}

/**
 * 兑换购买。
 *
 * 请求体 12 字节，字段按 BuyGoods 的同类结构发送；这份结构**还没有明文证据**
 * （请求体是 TSDK 加密的），所以只提供能力，不接入自动流程，需要人工实测确认。
 */
async function rotationBuyGoods(goodsId, num = 1, price = 0) {
    return sendPastureRequest(
        SHOP_SERVICE, 'RotationBuyGoods',
        types.RotationBuyGoodsRequest, types.RotationBuyGoodsReply,
        { goods_id: toLong(goodsId), num: toLong(num), price: toLong(price) }
    );
}

/**
 * 进入好友牧场。抓包正文 8 字节，这里只发送已知的 host_gid；
 * 若服务端要求额外字段会明确报错。
 */
async function enterHomestead(hostGid) {
    return sendPastureRequest(
        VISIT_SERVICE, 'EnterHomestead',
        types.EnterHomesteadRequest, types.EnterHomesteadReply,
        { host_gid: toLong(hostGid) }
    );
}

module.exports = {
    collectProduce,
    ANIMAL_SERVICE,
    RANCH_SERVICE,
    HOMESTEAD_SERVICE,
    FEED_MACHINE_SERVICE,
    ITEM_SERVICE,
    SHOP_SERVICE,
    ILLUSTRATED_SERVICE,
    VISIT_SERVICE,
    RANCH_OP_IDS,
    FEED_MACHINE_FACILITY_ID,

    getRanchDetail,
    getRanchOpTimes,
    harvestRanch,
    feedAnimal,
    triggerProduce,
    stealProduce,
    cleanAllRanch,
    getBuildingList,
    getFacilityDetail,
    addFeed,

    cannelNew,
    upgradeBuilding,
    completeBuildingUpgrade,
    getRanchWeightScore,
    getIllustratedLevelList,
    getRotationShopInfo,
    rotationBuyGoods,
    enterHomestead,

    placeAnimal,
    cleanRanch,
    strokeAnimal,
    getAnimalShop,
    resetAnimalShopCacheForTests,
    isAnimalItemId,
    ANIMAL_ITEM_ID_MIN,
    ANIMAL_ITEM_ID_MAX,
    buyGoods,
};