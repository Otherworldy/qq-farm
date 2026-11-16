/**
 * 牧场编排
 *
 * 最小闭环：拉详情 → 收获 → 投喂 → 清理 → 补草。
 * 与 farming-orchestrator.js 同样的定位：决定「这一轮做什么」，不关心怎么做
 * （具体 RPC 在 pasture-api.js）。分析判断在 pasture-analyzer.js。
 *
 * 刻意没有做的事（要等补样本或另行决策）：
 * - 买动物补栏：商城/放入栏舍的协议还没抓到样本
 * - 扩建 capacity：同上
 * - 单个灾害定点处理：目前只有一键 CleanAllRanch
 * - 好友牧场偷产物：StealProduce 链路还没打通调度
 */

const { getUserState, isConnected } = require('../utils/network');
const { toNum, log, logWarn } = require('../utils/utils');
const { isAutomationOn, getAutomation } = require('../models/store');
const { recordEvent } = require('./daily-events');
const {
    getRanchDetail,
    harvestRanch,
    feedAnimal,
    cleanAllRanch,
    getFacilityDetail,
    addFeed,
    FEED_MACHINE_FACILITY_ID,
} = require('./pasture-api');
const { analyzeRanches, msUntilNextProduce, GRASS_LOW_THRESHOLD } = require('./pasture-analyzer');

// ─── 模块状态 ───

let isCheckingPasture = false;
let isFirstPastureCheck = true;
/** 下一次产物成熟时刻（本地毫秒），0 表示未知 */
let lastNextReadyAtMs = 0;
/** 上一次补草尝试的时间，避免每轮都打牧草机 */
let lastFeedMachineAtMs = 0;
/** 牧草机设施实例 ID 缓存（第一次 GetFacilityDetail 时确认） */
let feedMachineInstId = FEED_MACHINE_FACILITY_ID === 7001001 ? 10002 : 0;
/** 补草冷却：同一台牧草机 5 分钟内不重复补 */
const FEED_MACHINE_COOLDOWN_MS = 5 * 60_000;

// ─── 辅助 ───

function isTransientNetworkError(err) {
    const msg = String((err && err.message) || '');
    if (!msg) return false;
    return [
        '连接未打开', '请求超时', '请求已中断',
        '连接关闭', '发送失败', '请求队列已满',
    ].some(pattern => msg.includes(pattern));
}

function logPasture(message, extra) {
    log('牧场', message, { module: 'pasture', ...(extra || {}) });
}

/** 记录一条人话事件（面板「今天发生了什么」用） */
function noteEvent(level, message) {
    try {
        const userState = getUserState();
        recordEvent(userState && userState.accountId, level, 'pasture', message);
    } catch {
        // 事件流水失败不影响业务
    }
}

// ─── 单个操作 ───

/** 收获：货架 + 成熟动物产物一次收掉 */
async function performHarvest(analysis) {
    const ranchIds = [...new Set(analysis.harvestable.map(a => a.ranchInstId))];
    if (!ranchIds.length) return 0;
    const reply = await harvestRanch(ranchIds);
    const gainedExp = analysis.expectedHarvestExpTotal;
    logPasture(`收获 ${analysis.harvestable.length} 只（预期 +${gainedExp} 经验）`, {
        event: '牧场收获',
        count: analysis.harvestable.length,
    });
    noteEvent('info', `牧场收获 ${analysis.harvestable.length} 只动物产物，约 +${gainedExp} 经验`);
    // 收获回包带最新 RanchInfo，后续判断用它而不是再拉一次
    return { reply, count: analysis.harvestable.length };
}

/** 收割货架（产物寄存处） */
async function performCollectShelves(analysis) {
    const ranchIds = [...new Set(analysis.collectableShelves.map(s => s.ranchInstId))];
    if (!ranchIds.length) return 0;
    const reply = await harvestRanch(ranchIds);
    const lots = analysis.collectableShelves.reduce((sum, s) => sum + s.lots.length, 0);
    logPasture(`收货架 ${analysis.collectableShelves.length} 个（${lots} 项）`, {
        event: '牧场收货架',
        count: analysis.collectableShelves.length,
    });
    noteEvent('info', `牧场收货架 ${lots} 项`);
    return { reply, count: analysis.collectableShelves.length };
}

/** 投喂：can_feed 的动物 */
async function performFeed(analysis) {
    const targets = analysis.needFeed.map(a => ({
        ranchInstId: a.ranchInstId,
        animalInstId: a.animalInstId,
    }));
    if (!targets.length) return 0;
    const reply = await feedAnimal(targets, 1);
    logPasture(`投喂 ${targets.length} 只动物`, { event: '牧场投喂', count: targets.length });
    noteEvent('info', `牧场投喂 ${targets.length} 只动物`);
    return { reply, count: targets.length };
}

/** 一键清理灾害 */
async function performClean(analysis) {
    if (!analysis.needClean.length) return 0;
    const ranchIds = [...new Set(analysis.needClean.map(h => h.ranchInstId))];
    const reply = await cleanAllRanch(ranchIds);
    logPasture(`清理 ${analysis.needClean.length} 个灾害`, {
        event: '牧场清理',
        count: analysis.needClean.length,
    });
    noteEvent('info', `牧场清理 ${analysis.needClean.length} 个灾害`);
    return { reply, count: analysis.needClean.length };
}

/**
 * 补草：牧草量低于阈值时给牧草机加料。
 *
 * 牧草机是 homestead 设施，加料走 FeedMachineService.AddFeed。
 * 分两步：先确认设施实例（拿当前草量），再按缺口补。
 */
async function performRefillGrass(analysis) {
    if (!analysis.grassLow) return 0;
    const now = Date.now();
    if (now - lastFeedMachineAtMs < FEED_MACHINE_COOLDOWN_MS) return 0;

    // 第一次不知道实例 ID 时，从建筑列表里找
    if (!feedMachineInstId) {
        try {
            const { getBuildingList } = require('./pasture-api');
            const reply = await getBuildingList();
            const list = reply.buildings || [];
            const machine = list.find(b => toNum(b.facility_id) === FEED_MACHINE_FACILITY_ID);
            if (machine) feedMachineInstId = toNum(machine.facility_inst_id);
        } catch {
            // 拿不到就跳过本轮，不阻塞其它操作
        }
        if (!feedMachineInstId) return 0;
    }

    try {
        const detail = await getFacilityDetail(feedMachineInstId);
        const state = detail && detail.detail && detail.detail.feed_machine;
        const current = toNum(state && state.current);
        const capacity = toNum(state && state.capacity) || 100;
        const gap = Math.max(0, capacity - current);
        if (gap <= 0) return 0;
        // 一次只补 1 份（抓包里 count=1 对应一批），避免把库存打空
        await addFeed(feedMachineInstId, 1);
        lastFeedMachineAtMs = now;
        logPasture(`牧草机补草 1 份（当前 ${current}/${capacity}）`, {
            event: '牧场补草',
            current,
            capacity,
        });
        noteEvent('info', `牧场牧草机补草（${current}/${capacity}）`);
        return 1;
    } catch (err) {
        if (!isTransientNetworkError(err)) {
            logWarn('牧场', `补草失败: ${err.message}`);
        }
        return 0;
    }
}

// ─── 主流程 ───

/**
 * 执行一轮牧场操作。
 * @param {string} opType - 'all' | 'harvest' | 'feed' | 'clean' | 'grass'
 */
async function runPastureOperation(opType = 'all') {
    const reply = await getRanchDetail();
    const ranches = (reply && reply.ranches) || [];
    if (!ranches.length) {
        logPasture('没有牧场数据');
        return { hadWork: false, actions: [], analysis: null };
    }

    const analysis = analyzeRanches(ranches);
    lastNextReadyAtMs = analysis.nextProduceReadyAtMs;

    const actions = [];
    const auto = getAutomation();
    // opType 指定单项时只做那项；'all' 时看各自的细分开关。
    // 总开关 pasture 已在 checkPasture 校验过。
    const want = (name, switchKey) => (opType === 'all'
        ? auto[switchKey] !== false
        : opType === name);

    // 顺序：收货架 → 收获 → 投喂 → 清理 → 补草
    // 货架先收，因为它可能因为动物产出而被填满，越早收越不浪费
    if (want('harvest', 'pasture_harvest')) {
        if (analysis.collectableShelves.length) {
            const r = await performCollectShelves(analysis);
            if (r) actions.push('collect_shelves');
        }
        if (analysis.harvestable.length) {
            const r = await performHarvest(analysis);
            if (r) actions.push('harvest');
        }
    }
    if (want('feed', 'pasture_feed') && analysis.needFeed.length) {
        const r = await performFeed(analysis);
        if (r) actions.push('feed');
    }
    if (want('clean', 'pasture_clean') && analysis.needClean.length) {
        const r = await performClean(analysis);
        if (r) actions.push('clean');
    }
    if (want('grass', 'pasture_grass') && analysis.grassLow) {
        const r = await performRefillGrass(analysis);
        if (r) actions.push('refill_grass');
    }

    if (isFirstPastureCheck) {
        isFirstPastureCheck = false;
        logPasture(
            `牧场就绪：${analysis.totalAnimals}/${analysis.totalCapacity} 栏位，` +
            `草 ${analysis.grassAmount}，${analysis.label}`
        );
    } else if (actions.length) {
        logPasture(`本轮操作：${actions.join(' → ')}`, { event: '牧场轮次', actions });
    }

    return {
        hadWork: actions.length > 0,
        actions,
        analysis,
        label: analysis.label,
    };
}

/**
 * 检查并执行牧场操作（调度器入口）
 * @returns {boolean} 是否有操作被执行
 */
async function checkPasture(options = {}) {
    const userState = getUserState();
    if (isCheckingPasture || !userState.gid || !isConnected()) return false;
    if (!isAutomationOn('pasture')) return false;

    isCheckingPasture = true;
    try {
        const result = await runPastureOperation(options.opType || 'all');
        return !!(result && result.hadWork);
    } catch (err) {
        if (!isTransientNetworkError(err)) {
            logWarn('牧场', `检查失败: ${err.message}`);
        }
        return false;
    } finally {
        isCheckingPasture = false;
    }
}

// ─── 调度辅助 ───

/**
 * 距离下一次产物成熟还有多少毫秒。
 * 0 表示「没有已知的成熟时刻」——调用方不能据此长睡，必须按常规间隔复查。
 */
function getNextPastureReadyInMs() {
    if (!lastNextReadyAtMs) return 0;
    return Math.max(0, lastNextReadyAtMs - Date.now());
}

/** 是否有牧场自动化开关处于开启状态（供调度器决定要不要排期） */
function isPastureAutomationEnabled() {
    const auto = getAutomation();
    return !!(auto && auto.pasture);
}

/** 测试用：重置模块级状态 */
function resetPastureStateForTests() {
    isCheckingPasture = false;
    isFirstPastureCheck = true;
    lastNextReadyAtMs = 0;
    lastFeedMachineAtMs = 0;
}

module.exports = {
    checkPasture,
    runPastureOperation,
    getNextPastureReadyInMs,
    isPastureAutomationEnabled,
    GRASS_LOW_THRESHOLD,
    resetPastureStateForTests,
    // 供测试单独验证
    performHarvest,
    performFeed,
    performClean,
    performRefillGrass,
    msUntilNextProduce,
};