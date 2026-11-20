/**
 * 牧场 RPC 收口
 *
 * 全部方法名与字段来自真机抓包，定义见 proto/animalpb.proto、
 * proto/homesteadpb.proto、proto/ranchpb.proto。与 farm-api.js 保持同样的形状：
 * 只做「构造请求 → 发送 → 解码回包」，不含任何业务判断。
 *
 * 两个必须知道的约束：
 * 1. keepCase=true，字段一律 snake_case；写成 camelCase 会静默拿到 undefined。
 * 2. 牧场背包/商店/图鉴/分享在 ranchpb 里有「场景 2」专用副本（global_scene_id=2），
 *    名字与 itempb/shoppb/illustratedpb 相同但字段不同，必须走 Ranch 前缀的类型。
 *
 * 请求体由 network.js 负责 TSDK 加密，回包是明文 —— 这里不做额外加解密。
 */

const { Buffer } = require('node:buffer');
const { sendMsgAsync, getUserState } = require('../utils/network');
const { types, waitForProtoReady } = require('../utils/proto');
const { toLong, toNum } = require('../utils/utils');
const { getShopInfo, buyGoods } = require('./farm-api');
const { checkBeforeSend, noteSent } = require('./pasture-context');

/** 服务名常量：抓包确认的 service */
const ANIMAL_SERVICE = 'gamepb.animalpb.AnimalService';
const RANCH_SERVICE = 'gamepb.animalpb.RanchService';
const HOMESTEAD_SERVICE = 'gamepb.homesteadpb.HomesteadService';
const FEED_MACHINE_SERVICE = 'gamepb.homesteadpb.FeedMachineService';
const ITEM_SERVICE = 'gamepb.itempb.ItemService';
const SHOP_SERVICE = 'gamepb.shoppb.ShopService';
const ILLUSTRATED_SERVICE = 'gamepb.illustratedpb.IllustratedService';
const VISIT_SERVICE = 'gamepb.visitpb.VisitService';
const MALL_SERVICE = 'gamepb.mallpb.MallService';
const TASK_SERVICE = 'gamepb.taskpb.TaskService';
const SHARE_SERVICE = 'gamepb.sharepb.ShareService';
const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';

/** 牧场场景 ID（农场 = 1） */
const RANCH_SCENE_ID = 2;

/** 牧场操作配额 ID */
const OP_STROKE = 11009;        // 抚摸
const OP_PUT_MOSQUITO = 11003;  // 放蚊子
const OP_RELEASE = 11008;       // 放生
const RANCH_OP_IDS = [OP_PUT_MOSQUITO, OP_RELEASE, OP_STROKE];

/** 牧草机设施模板 ID（抓包实测） */
const FEED_MACHINE_FACILITY_ID = 7001001;

/** 罐头桶物品 ID */
const BUCKET_NORMAL = 7003;
const BUCKET_ORGANIC = 7004;
/** 牧场经验道具 ID（用来反查牧场等级） */
const RANCH_EXP_ITEM_ID = 1102;

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

async function sendPastureRequest(service, method, ReqType, ReplyType, payloadObj, options = {}) {
    await waitForProtoReady();
    const payload = ReqType.encode(ReqType.create(payloadObj)).finish();
    const reply = await sendMsgAsync(service, method, payload, options.timeout || 20000, {
        ...options,
        // 开关二次核对：上下文（外层操作）优先，调用方自己的钩子叠加在后
        beforeSend: (svc, mtd) => checkBeforeSend(svc, mtd)
            || (typeof options.beforeSend === 'function' ? options.beforeSend(svc, mtd) : null),
        // 「已真的写进 socket」记账：账本靠它区分“没发”和“发了但结果未知”
        onSent: (svc, mtd) => {
            noteSent(svc, mtd);
            if (typeof options.onSent === 'function') options.onSent(svc, mtd);
        },
    });
    return ReplyType.decode(reply.body);
}

/** 自身的 host_gid（从登录态取） */
function selfGid() {
    const userState = getUserState();
    return userState && userState.gid ? userState.gid : 0;
}

/** Long 求和，避免 Number 精度丢失 */
function sumCount(a, b) {
    return String(BigInt(a || 0) + BigInt(b || 0));
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
        types.RanchGetRanchDetailRequest, types.RanchGetRanchDetailReply,
        payload
    );
}

/**
 * 拉取操作次数配额。op_ids 传空数组表示取全部。
 */
async function getRanchOpTimes(opIds = []) {
    return sendPastureRequest(
        RANCH_SERVICE, 'GetRanchOpTimes',
        types.RanchGetRanchOpTimesRequest, types.RanchGetRanchOpTimesReply,
        { op_ids: (opIds || []).map(id => toLong(id)) }
    );
}

/**
 * 全部栏舍快照（牧场场景 2 的格子视图）。
 * 只有进入牧场场景后才有效；未进场景时由 GetRanchDetail 兜底。
 */
async function getAllCells() {
    return sendPastureRequest(
        HOMESTEAD_SERVICE, 'AllCells',
        types.RanchAllCellsRequest, types.RanchAllCellsReply,
        {}
    );
}

// ─── 牧场操作 ───

/**
 * 收获。op 的语义由真机服务端错误码确定：
 *   1 —— 一键收获（把可收获动物收出栏，同时收货架）
 *   2 —— 只收产物；没有可收产物时返回业务码 1045229「当前没有可收取的产物」
 *   4 —— 指定动物（配 animals）或指定货架（配 shelves）
 * 混用会让产物走「收获出栏」路径、产物不入账只给经验，
 * 表现出来就是牧场一直在跑却在亏牧场币。
 *
 * @param {{op?:number, ranchIds?:number[], animals?:{ranchInstId:number,animalInstId:number}[], shelves?:{ranchInstId:number,slotIndex:number}[]}} opts
 */
async function harvestRanch(opts = {}) {
    const op = Number(opts.op) || 1;
    const payload = {
        ranch_inst_ids: (opts.ranchIds || []).map(id => toLong(id)),
        op,
    };
    if (Array.isArray(opts.animals) && opts.animals.length) {
        payload.animals = opts.animals.map(a => ({
            ranch_inst_id: toLong(a.ranchInstId),
            animal_inst_id: toNum(a.animalInstId),
        }));
    }
    if (Array.isArray(opts.shelves) && opts.shelves.length) {
        payload.shelves = opts.shelves.map(s => ({
            ranch_inst_id: toLong(s.ranchInstId),
            slot_index: Number(s.slotIndex) || 0,
        }));
    }
    return sendPastureRequest(
        ANIMAL_SERVICE, 'HarvestRanch',
        types.RanchHarvestRanchRequest, types.RanchHarvestRanchReply,
        payload, opts.options
    );
}

/**
 * 喂罐头。targets 是 {ranchInstId, animalInstId} 列表。
 *
 * 抓包确认（capture 14_02_01）：这个 RPC 就是游戏里的「喂罐头」本身 ——
 * 用户操作「喂罐头 → 催生产 → 收获鸡蛋」对应 7.83s FeedAnimal、
 * 11.88s TriggerProduce、14.92s HarvestRanch。它不是免费投喂，
 * 自动调用等于替玩家消耗罐头。
 *
 * 免费的牧草路径是牧草机：`addFeed()`（homesteadpb.AddFeed）。
 *
 * @param {{ranchInstId:number, animalInstId:number}[]} targets
 * @param {number} [bucketType] 1 = 有机罐头（7004）；2 = 普通罐头（7003）
 */
async function feedAnimal(targets, bucketType = 2, options = {}) {
    const list = (targets || []).map(t => ({
        ranch_inst_id: toLong(t.ranchInstId),
        animal_inst_id: toNum(t.animalInstId),
    }));
    return sendPastureRequest(
        ANIMAL_SERVICE, 'FeedAnimal',
        types.RanchFeedAnimalRequest, types.RanchFeedAnimalReply,
        { targets: list, bucket_type: Number(bucketType) || 2 },
        options
    );
}

/**
 * 触发生产（催产）。targets 留空表示一键覆盖全部可生产动物。
 */
async function triggerProduce(targets, hostGid, options = {}) {
    const payload = {};
    if (hostGid) payload.host_gid = toLong(hostGid);
    if (Array.isArray(targets) && targets.length) {
        payload.targets = targets.map(t => ({
            ranch_inst_id: toLong(t.ranchInstId),
            animal_inst_id: toNum(t.animalInstId),
        }));
    }
    return sendPastureRequest(
        ANIMAL_SERVICE, 'TriggerProduce',
        types.RanchTriggerProduceRequest, types.RanchTriggerProduceReply,
        payload, options
    );
}

/**
 * 收取副产品（货架上的蛋/奶）。
 *
 * ❌ 已确认此方法不存在，**不要调用**。货架收取走 `harvestRanch({op:2|4})`。
 */
async function collectProduce() {
    throw new Error('CollectProduce 在网关侧不存在，货架产物请用 harvestRanch({ op: 2 })');
}

/**
 * 偷取好友牧场产物。targets 留空 = 服务端自选全部可偷货架。
 * @param {number} [hostGid]
 * @param {{ranchInstId:number, slotIndex:number}[]} [targets]
 */
async function stealProduce(hostGid, targets, options = {}) {
    const gid = hostGid || selfGid();
    const payload = { host_gid: toLong(gid) };
    if (Array.isArray(targets) && targets.length) {
        payload.targets = targets.map(t => ({
            ranch_inst_id: toLong(t.ranchInstId),
            slot_index: Number(t.slotIndex) || 0,
        }));
    }
    return sendPastureRequest(
        ANIMAL_SERVICE, 'StealProduce',
        types.RanchStealProduceRequest, types.RanchStealProduceReply,
        payload, options
    );
}

/**
 * 把背包里的动物放进栏舍。服务端自行分配 slot。
 * @param {number} ranchInstId
 * @param {number} animalId 动物种类号（60001），不是实例号
 * @param {number} [giantCubItemId] 巨大幼崽道具 ID（普通幼崽不传）
 */
async function placeAnimal(ranchInstId, animalId, giantCubItemId, options = {}) {
    const item = {
        ranch_inst_id: toLong(ranchInstId),
        animal_id: toLong(animalId),
    };
    if (giantCubItemId) item.giant_cub_item_id = toLong(giantCubItemId);
    return sendPastureRequest(
        ANIMAL_SERVICE, 'PlaceAnimal',
        types.RanchPlaceAnimalRequest, types.RanchPlaceAnimalReply,
        { items: [item] }, options
    );
}

/**
 * 定点清理指定灾害。
 * @param {number[]} hazardIds - RanchDetail.hazards[].hazard_id
 * @param {number} [hostGid]
 */
async function cleanRanch(hazardIds, hostGid, options = {}) {
    const gid = hostGid || selfGid();
    return sendPastureRequest(
        RANCH_SERVICE, 'CleanRanch',
        types.RanchCleanRanchRequest, types.RanchCleanRanchReply,
        { host_gid: toLong(gid), hazard_ids: (hazardIds || []).map(id => toLong(id)) },
        options
    );
}

/**
 * 一键清理整个牧场。
 * @param {number[]} [ranchIds]
 * @param {number} [hostGid]
 */
async function cleanAllRanch(ranchIds, hostGid, options = {}) {
    const gid = hostGid || selfGid();
    return sendPastureRequest(
        RANCH_SERVICE, 'CleanAllRanch',
        types.RanchCleanAllRanchRequest, types.RanchCleanAllRanchReply,
        {
            host_gid: toLong(gid),
            ranch_inst_ids: (ranchIds || []).map(id => toLong(id)),
        },
        options
    );
}

/**
 * 抚摸动物（重量/变异交互）。
 * @param {number} animalInstId
 * @param {number} ranchInstId
 * @param {number} [hostGid]
 */
async function strokeAnimal(animalInstId, ranchInstId, hostGid, options = {}) {
    const gid = hostGid || selfGid();
    return sendPastureRequest(
        RANCH_SERVICE, 'StrokeAnimal',
        types.RanchStrokeAnimalRequest, types.RanchStrokeAnimalReply,
        {
            host_gid: toLong(gid),
            target: {
                ranch_inst_id: toLong(ranchInstId),
                animal_inst_id: toNum(animalInstId),
            },
        },
        options
    );
}

/**
 * 放蚊子（好友牧场互动，消耗每日配额 11003）。
 * @param {number} ranchInstId
 * @param {number} hostGid
 * @param {number} [count]
 */
async function putHazard(ranchInstId, hostGid, count = 1, options = {}) {
    return sendPastureRequest(
        RANCH_SERVICE, 'PutHazard',
        types.RanchPutHazardRequest, types.RanchPutHazardReply,
        {
            ranch_inst_id: toLong(ranchInstId),
            host_gid: toLong(hostGid || selfGid()),
            op_id: toLong(OP_PUT_MOSQUITO),
            count: toLong(count),
        },
        options
    );
}

/**
 * 放生动物（消耗每日配额 11008）。targets 必填，服务端不支持一键放生。
 * @param {{ranchInstId:number, animalInstId:number}[]} targets
 */
async function donateAnimal(targets, options = {}) {
    return sendPastureRequest(
        ANIMAL_SERVICE, 'DonateAnimal',
        types.RanchDonateAnimalRequest, types.RanchDonateAnimalReply,
        {
            targets: (targets || []).map(t => ({
                ranch_inst_id: toLong(t.ranchInstId),
                animal_inst_id: toNum(t.animalInstId),
            })),
        },
        options
    );
}

// ─── 背包 / 出售 / 使用（场景 2 专用副本）───

/** 牧场背包。global_scene_id 固定 2，混用会读到农场物品。 */
async function getBag(tabId = 0) {
    const payload = { global_scene_id: RANCH_SCENE_ID };
    if (tabId) payload.tab_id = toLong(tabId);
    const reply = await sendPastureRequest(
        ITEM_SERVICE, 'GetBag',
        types.RanchGetBagRequest, types.RanchGetBagReply,
        payload
    );
    if (toNum(reply.global_scene_id) !== RANCH_SCENE_ID) {
        throw Object.assign(new Error('牧场背包场景不匹配'), { code: 'RANCH_RESPONSE_MISMATCH' });
    }
    return reply;
}

async function getBagTabs() {
    return sendPastureRequest(
        ITEM_SERVICE, 'GetBagTab',
        types.RanchGetBagTabRequest, types.RanchGetBagTabReply,
        { global_scene_id: RANCH_SCENE_ID }
    );
}

/**
 * 出售物品。items 每项 {id, uid, count}。
 */
async function sellItems(items, options = {}) {
    return sendPastureRequest(
        ITEM_SERVICE, 'Sell',
        types.RanchSellRequest, types.RanchSellReply,
        {
            items: (items || []).map(i => ({
                id: toLong(i.id),
                uid: toLong(i.uid),
                count: toLong(i.count),
            })),
        },
        options
    );
}

/**
 * 使用物品（牧场里只有罐头入桶走这条）。不传 target。
 */
async function useItem(item, options = {}) {
    return sendPastureRequest(
        ITEM_SERVICE, 'Use',
        types.RanchUseRequest, types.RanchUseReply,
        { item: { id: toLong(item.id), uid: toLong(item.uid), count: toLong(item.count) } },
        options
    );
}

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

// ─── 商店 / 集市 / 罐头商城 ───

async function getShopProfiles() {
    return sendPastureRequest(
        SHOP_SERVICE, 'ShopProfiles',
        types.ShopProfilesRequest, types.ShopProfilesReply,
        { global_scene_id: RANCH_SCENE_ID }
    );
}

/**
 * 牧场商店商品。shopId 5 = 幼崽，6 = 饲料。
 */
async function getRanchShop(shopId) {
    return sendPastureRequest(
        SHOP_SERVICE, 'ShopInfo',
        types.ShopInfoRequest, types.ShopInfoReply,
        { shop_id: toLong(shopId) }
    );
}

/**
 * 集市（轮换商店）当前场次与商品。shop_id 固定 7。
 */
async function getRotationShopInfo(shopId = 7) {
    return sendPastureRequest(
        SHOP_SERVICE, 'RotationShopInfo',
        types.RanchRotationShopInfoRequest, types.RanchRotationShopInfoReply,
        { shop_id: toLong(shopId) }
    );
}

/**
 * 集市兑换。periodDay / roundIndex 必须与拉取时一致，否则服务端判场次已变。
 */
async function rotationBuyGoods(goodsId, count, periodDay, roundIndex, options = {}) {
    return sendPastureRequest(
        SHOP_SERVICE, 'RotationBuyGoods',
        types.RanchRotationBuyGoodsRequest, types.RanchRotationBuyGoodsReply,
        {
            goods_id: toLong(goodsId),
            count: Number(count) || 1,
            period_day: toLong(periodDay),
            round_index: Number(roundIndex) || 0,
        },
        options
    );
}

/**
 * 罐头商城列表。slotType 6 = 常驻，7 = 限时。
 * 回包 goods_list 是 repeated bytes（每条是序列化的 MallGoods），需要二次解码。
 */
async function getCanMallList(slotType = 6) {
    const reply = await sendPastureRequest(
        MALL_SERVICE, 'GetMallListBySlotType',
        types.GetMallListBySlotTypeRequest, types.GetMallListBySlotTypeResponse,
        { slot_type: Number(slotType) || 6, is_manual_open: true, global_scene_id: RANCH_SCENE_ID }
    );
    const list = [];
    for (const raw of Array.isArray(reply.goods_list) ? reply.goods_list : []) {
        try {
            list.push(types.MallGoods.decode(raw));
        } catch {
            // 单条解码失败不影响其它商品
        }
    }
    return { ...reply, goods: list };
}

async function purchaseCan(goodsId, count = 1, options = {}) {
    return sendPastureRequest(
        MALL_SERVICE, 'Purchase',
        types.PurchaseRequest, types.PurchaseResponse,
        { goods_id: Number(goodsId) || 0, count: Number(count) || 1 },
        options
    );
}

/**
 * 牧场商店购买（幼崽/牧草）。autoAdd 对应「购买后自动放养」。
 * price 是单价（GoodsInfo.price），服务端会校验价格没变。
 */
async function buyRanchGoods(goodsId, count, price, autoAdd, options = {}) {
    return sendPastureRequest(
        SHOP_SERVICE, 'BuyGoods',
        types.BuyGoodsRequest, types.BuyGoodsReply,
        {
            goods_id: toLong(goodsId),
            num: toLong(count),
            price: toLong(price),
            auto_add: !!autoAdd,
        },
        options
    );
}

// ─── 任务（牧场 scene_id = 2）───

async function getRanchTasks() {
    return sendPastureRequest(
        TASK_SERVICE, 'TaskInfo',
        types.TaskInfoRequest, types.TaskInfoReply,
        { scene_id: RANCH_SCENE_ID }
    );
}

async function claimRanchTask(taskId, doShared = false, options = {}) {
    return sendPastureRequest(
        TASK_SERVICE, 'ClaimTaskReward',
        types.ClaimTaskRewardRequest, types.ClaimTaskRewardReply,
        { id: toLong(taskId), do_shared: !!doShared },
        options
    );
}

async function claimRanchTasks(taskIds, doShared = false, options = {}) {
    return sendPastureRequest(
        TASK_SERVICE, 'BatchClaimTaskReward',
        types.BatchClaimTaskRewardRequest, types.BatchClaimTaskRewardReply,
        { ids: (taskIds || []).map(id => toLong(id)), do_shared: !!doShared },
        options
    );
}

async function reportRanchTaskProgress(taskId, progress, options = {}) {
    return sendPastureRequest(
        TASK_SERVICE, 'ClientReportProgress',
        types.ClientReportProgressRequest, types.ClientReportProgressReply,
        { task_id: toLong(taskId), progress: toLong(progress) },
        options
    );
}

// ─── 图鉴 / 重量分 ───

/** 牧场动物图鉴。type 固定 101。 */
async function getIllustratedList(type = 101) {
    const reply = await sendPastureRequest(
        ILLUSTRATED_SERVICE, 'GetIllustratedListV2',
        types.RanchGetIllustratedListV2Request, types.RanchGetIllustratedListV2Reply,
        { type: Number(type) || 101 }
    );
    if (toNum(reply.type) !== Number(type)) {
        throw Object.assign(new Error('牧场图鉴类型不匹配'), { code: 'RANCH_RESPONSE_MISMATCH' });
    }
    return reply;
}

/** 巨大图鉴（按重量分档）。请求体为空。 */
async function getRanchWeightScore() {
    return sendPastureRequest(
        ILLUSTRATED_SERVICE, 'GetRanchWeightScoreV2',
        types.RanchGetRanchWeightScoreV2Request, types.RanchGetRanchWeightScoreV2Reply,
        {}
    );
}

async function claimIllustratedRewards(type = 101, options = {}) {
    return sendPastureRequest(
        ILLUSTRATED_SERVICE, 'ClaimAllRewardsV2',
        types.RanchClaimAllRewardsV2Request, types.RanchClaimAllRewardsV2Reply,
        { type: Number(type) || 101 },
        options
    );
}

async function claimRanchWeightScoreReward(id, options = {}) {
    return sendPastureRequest(
        ILLUSTRATED_SERVICE, 'ClaimRanchWeightScoreRewardV2',
        types.RanchClaimRanchWeightScoreRewardV2Request, types.RanchClaimRanchWeightScoreRewardV2Reply,
        { id: Number(id) || 0 },
        options
    );
}

// ─── 分享 ───

async function checkCanShare() {
    return sendPastureRequest(
        SHARE_SERVICE, 'CheckCanShare',
        types.CheckCanShareRequest, types.CheckCanShareReply,
        {}
    );
}

/**
 * 上报分享。牧场每日礼包 share_id=102 / doc_id=2101；
 * 任务翻倍 share_id=103 / params=[taskId] / doc_id=2104。
 */
async function reportShare(shareId, params = [], docId = 0, options = {}) {
    return sendPastureRequest(
        SHARE_SERVICE, 'ReportShare',
        types.RanchReportShareRequest, types.RanchReportShareReply,
        {
            share_id: toLong(shareId),
            params: (params || []).map(p => toLong(p)),
            doc_id: toLong(docId),
        },
        options
    );
}

async function claimShareReward(shareId, options = {}) {
    return sendPastureRequest(
        SHARE_SERVICE, 'ClaimShareReward',
        types.RanchClaimShareRewardRequest, types.RanchClaimShareRewardReply,
        { share_id: toLong(shareId) },
        options
    );
}

// ─── 好友牧场 ───

/** 进入好友牧场（reason = 2 表示好友访问）。 */
async function enterHomestead(hostGid, options = {}) {
    return sendPastureRequest(
        VISIT_SERVICE, 'EnterHomestead',
        types.RanchEnterHomesteadRequest, types.RanchEnterHomesteadReply,
        { host_gid: toLong(hostGid), reason: 2 },
        options
    );
}

async function leaveHomestead(hostGid, options = {}) {
    return sendPastureRequest(
        VISIT_SERVICE, 'LeaveHomestead',
        types.RanchLeaveHomesteadRequest, types.RanchLeaveHomesteadReply,
        { host_gid: toLong(hostGid) },
        options
    );
}

// ─── 设施 / 牧草机 ───

/** 建筑列表（栏舍/棚/牧草机）。 */
async function getBuildingList() {
    return sendPastureRequest(
        HOMESTEAD_SERVICE, 'GetBuildingList',
        types.RanchGetBuildingListRequest, types.RanchGetBuildingListReply,
        {}
    );
}

/**
 * 设施详情。注意回包字段是 info（不是 detail），与旧版定义不同。
 * @param {number} facilityInstId 例如牧草机 10002
 */
async function getFacilityDetail(facilityInstId, hostGid) {
    const payload = { instance_id: toLong(facilityInstId) };
    if (hostGid) payload.host_gid = toLong(hostGid);
    return sendPastureRequest(
        HOMESTEAD_SERVICE, 'GetFacilityDetail',
        types.RanchGetFacilityDetailRequest, types.RanchGetFacilityDetailReply,
        payload
    );
}

/** 激活尚未启用的棚（facility_id 6002001、state 3 → 1）。 */
async function activateFacility(facilityInstId, options = {}) {
    return sendPastureRequest(
        HOMESTEAD_SERVICE, 'ActivateFacility',
        types.RanchActivateFacilityRequest, types.RanchActivateFacilityReply,
        { instance_id: toLong(facilityInstId) },
        options
    );
}

/**
 * 牧草机加料。
 * @param {number} facilityInstId
 * @param {number} [count] 份数（抓包 count=1 → 草量 +1）
 */
async function addFeed(facilityInstId, count = 1, options = {}) {
    return sendPastureRequest(
        FEED_MACHINE_SERVICE, 'AddFeed',
        types.RanchAddFeedRequest, types.RanchAddFeedReply,
        { instance_id: toLong(facilityInstId), add_count: Number(count) || 1, use_gold: false },
        options
    );
}

/**
 * 升级建筑（牧草机/栏舍/棚）。
 *
 * 参数由密文比对确定：UpgradeBuilding 与 CompleteBuildingUpgrade 的请求密文
 * 与 GetFacilityDetail 完全相同（都是 3 字节 e97375）；TSDK 加密是确定性的，
 * 所以参数就是 {1: facility_inst_id}。
 */
async function upgradeBuilding(facilityInstId, options = {}) {
    return sendPastureRequest(
        HOMESTEAD_SERVICE, 'UpgradeBuilding',
        types.RanchUpgradeBuildingRequest, types.RanchUpgradeBuildingReply,
        { inst_id: toLong(facilityInstId) },
        options
    );
}

/** 升级完成（耗时结束后调用），参数同 UpgradeBuilding。 */
async function completeBuildingUpgrade(facilityInstId, options = {}) {
    return sendPastureRequest(
        HOMESTEAD_SERVICE, 'CompleteBuildingUpgrade',
        types.RanchCompleteBuildingUpgradeRequest, types.RanchCompleteBuildingUpgradeReply,
        { inst_id: toLong(facilityInstId) },
        options
    );
}

// ─── 商店探测（买动物用）───

/**
 * 找动物商店并把商品列表拍平。
 *
 * 抓包无法确定动物店的确切 shop_id（请求体加密，读出来是随机字节），
 * 所以按候选逐个试，返回第一个含动物商品的店。结果缓存，只探一次。
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

// ─── 活动 ───

async function getRanchActivities() {
    return sendPastureRequest(
        ACTIVITY_SERVICE, 'List',
        types.ActivityListRequest, types.ActivityListReply,
        { scene_id: RANCH_SCENE_ID }
    );
}

module.exports = {
    // 服务名
    ANIMAL_SERVICE,
    RANCH_SERVICE,
    HOMESTEAD_SERVICE,
    FEED_MACHINE_SERVICE,
    ITEM_SERVICE,
    SHOP_SERVICE,
    ILLUSTRATED_SERVICE,
    VISIT_SERVICE,
    MALL_SERVICE,
    TASK_SERVICE,
    SHARE_SERVICE,
    ACTIVITY_SERVICE,

    // 常量
    RANCH_SCENE_ID,
    RANCH_OP_IDS,
    OP_STROKE,
    OP_PUT_MOSQUITO,
    OP_RELEASE,
    FEED_MACHINE_FACILITY_ID,
    BUCKET_NORMAL,
    BUCKET_ORGANIC,
    RANCH_EXP_ITEM_ID,
    ANIMAL_ITEM_ID_MIN,
    ANIMAL_ITEM_ID_MAX,

    // 查询
    getRanchDetail,
    getRanchOpTimes,
    getAllCells,
    getBuildingList,
    getFacilityDetail,
    getBag,
    getBagTabs,
    getShopProfiles,
    getRanchShop,
    getRotationShopInfo,
    getCanMallList,
    getRanchTasks,
    getIllustratedList,
    getRanchWeightScore,
    getAnimalShop,
    getRanchActivities,
    checkCanShare,

    // 动作
    harvestRanch,
    feedAnimal,
    triggerProduce,
    stealProduce,
    placeAnimal,
    cleanRanch,
    cleanAllRanch,
    strokeAnimal,
    putHazard,
    donateAnimal,
    sellItems,
    useItem,
    cannelNew,
    rotationBuyGoods,
    buyRanchGoods,
    purchaseCan,
    claimRanchTask,
    claimRanchTasks,
    reportRanchTaskProgress,
    claimIllustratedRewards,
    claimRanchWeightScoreReward,
    reportShare,
    claimShareReward,
    enterHomestead,
    leaveHomestead,
    activateFacility,
    addFeed,
    upgradeBuilding,
    completeBuildingUpgrade,
    collectProduce,

    // 工具 / 测试
    resetAnimalShopCacheForTests,
    isAnimalItemId,
    selfGid,
    sumCount,
    buyGoods,
    getShopInfo,
    Buffer,
};