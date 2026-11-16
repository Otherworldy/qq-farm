/**
 * 牧场服务聚合模块（Barrel）
 *
 * 与 services/farm.js 同样的定位：worker.js 只从这里取牧场 API，
 * 不直接依赖子模块，方便后续替换实现。
 */
const pastureApi = require('./pasture-api');
const {
    analyzeRanches,
    buildPanelView,
    msUntilNextProduce,
    GRASS_LOW_THRESHOLD,
} = require('./pasture-analyzer');
const {
    checkPasture,
    runPastureOperation,
    getNextPastureReadyInMs,
    isPastureAutomationEnabled,
} = require('./pasture-orchestrator');
const { checkFriendPastures } = require('./pasture-visit');

module.exports = {
    // 编排
    checkPasture,
    runPastureOperation,
    getNextPastureReadyInMs,
    isPastureAutomationEnabled,
    checkFriendPastures,

    // 分析
    analyzeRanches,
    buildPanelView,
    msUntilNextProduce,
    GRASS_LOW_THRESHOLD,

    // RPC
    getRanchDetail: pastureApi.getRanchDetail,
    getRanchOpTimes: pastureApi.getRanchOpTimes,
    harvestRanch: pastureApi.harvestRanch,
    feedAnimal: pastureApi.feedAnimal,
    triggerProduce: pastureApi.triggerProduce,
    stealProduce: pastureApi.stealProduce,
    cleanAllRanch: pastureApi.cleanAllRanch,
    cleanRanch: pastureApi.cleanRanch,
    placeAnimal: pastureApi.placeAnimal,
    strokeAnimal: pastureApi.strokeAnimal,
    getBuildingList: pastureApi.getBuildingList,
    getFacilityDetail: pastureApi.getFacilityDetail,
    addFeed: pastureApi.addFeed,
    getAnimalShop: pastureApi.getAnimalShop,
    buyGoods: pastureApi.buyGoods,
    isAnimalItemId: pastureApi.isAnimalItemId,

    // 常量
    RANCH_OP_IDS: pastureApi.RANCH_OP_IDS,
    FEED_MACHINE_FACILITY_ID: pastureApi.FEED_MACHINE_FACILITY_ID,
};