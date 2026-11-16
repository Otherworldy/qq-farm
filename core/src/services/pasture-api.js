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
const { toLong } = require('../utils/utils');

/** 服务名常量：抓包确认的两个 service */
const ANIMAL_SERVICE = 'gamepb.animalpb.AnimalService';
const RANCH_SERVICE = 'gamepb.animalpb.RanchService';
const HOMESTEAD_SERVICE = 'gamepb.homesteadpb.HomesteadService';
const FEED_MACHINE_SERVICE = 'gamepb.homesteadpb.FeedMachineService';

/** 牧场操作 ID（GetRanchOpTimes 里出现的配额编号，语义待对照确认） */
const RANCH_OP_IDS = [11003, 11008, 11009];

/** 牧草机设施模板 ID（抓包实测） */
const FEED_MACHINE_FACILITY_ID = 7001001;

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
 * 拉取牧场详情。不传 ranchIds 表示拉自己的。
 * @param {number[]} [ranchIds]
 */
async function getRanchDetail(ranchIds) {
    const ids = Array.isArray(ranchIds) ? ranchIds : [];
    return sendPastureRequest(
        ANIMAL_SERVICE, 'GetRanchDetail',
        types.GetRanchDetailRequest, types.GetRanchDetailReply,
        { ranch_inst_ids: ids.map(id => toLong(id)) }
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
 * 投喂。targets 是 {ranch_inst_id, animal_inst_id} 列表。
 * @param {{ranchInstId:number, animalInstId:number}[]} targets
 * @param {number} [feedType] 抓包实测出现过 1 和 2
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
 * 偷取好友牧场产物
 * @param {number} [hostGid] 不传则用自己（一般应传好友 gid）
 */
async function stealProduce(hostGid) {
    const gid = hostGid || selfGid();
    return sendPastureRequest(
        ANIMAL_SERVICE, 'StealProduce',
        types.StealProduceRequest, types.StealProduceReply,
        { host_gid: toLong(gid) }
    );
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

module.exports = {
    ANIMAL_SERVICE,
    RANCH_SERVICE,
    HOMESTEAD_SERVICE,
    FEED_MACHINE_SERVICE,
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
};