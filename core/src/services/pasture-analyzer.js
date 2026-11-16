/**
 * 牧场分析器（纯函数，无副作用，不发请求）
 *
 * 输入 pasture-api.getRanchDetail() 解出的 RanchInfo[]，输出可直接驱动编排的
 * 列表。与 farm-land-analyzer.js 同样的定位：只做判断，不做操作。
 *
 * 判断优先级：**服务端给的布尔标志优先**（can_harvest / can_feed / can_collect），
 * 本地阶段推断只作为兜底。原因是服务端标志已经综合了草料、成熟度、每日次数等
 * 条件，自己再推一遍容易和服务端不一致。
 */

const { toNum } = require('../utils/utils');
const { getPastureAnimalName } = require('../config/gameConfig');

// ─── 常量 ───

/** 动物阶段（抓包观察值，仅用于日志与兜底判断） */
const STAGE_INFANT = 1;
const STAGE_GROWING = 2;
const STAGE_PRODUCING_ACTUAL = 3;   // 抓包：producing 41/45
const STAGE_UNKNOWN_4 = 4;          // 语义未确认
const STAGE_HARVESTABLE = 5;        // 抓包：can_harvest 4/4

/** 牧草低于该值视为需要补草（牧草机容量 100，实测 72 仍可运转） */
const GRASS_LOW_THRESHOLD = 20;

// ─── 内部辅助 ───

/** 把 protobufjs 解出的 repeated / message 字段安全取成数组 */
function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [];
}

/** 把 ItemAmount[] 转成 {itemId, count} 纯数字数组 */
function normalizeSells(list) {
    return asArray(list).map(item => ({
        itemId: toNum(item.id),
        count: toNum(item.count),
    }));
}

/** 把一条 AnimalInst 拍平成扁平结构 */
function normalizeAnimal(animal, ranchInstId) {
    const mutation = animal.mutation || null;
    return {
        ranchInstId: toNum(animal.ranch_inst_id) || ranchInstId,
        slotIndex: toNum(animal.slot_index),
        animalInstId: toNum(animal.animal_inst_id),
        animalId: toNum(animal.animal_id),
        stage: toNum(animal.stage),
        produceCount: toNum(animal.produce_count),
        canHarvest: !!animal.can_harvest,
        canFeed: !!animal.can_feed,
        canDonate: !!animal.can_donate,
        grassBlocked: !!animal.grass_blocked,
        producing: !!animal.producing,
        growReadyAtMs: toNum(animal.grow_ready_at_ms),
        produceReadyAtMs: toNum(animal.produce_ready_at_ms),
        matureReadyAtMs: toNum(animal.mature_ready_at_ms),
        expectedHarvestExp: toNum(animal.expected_harvest_exp),
        expectedHarvestSells: normalizeSells(animal.expected_harvest_sells),
        expectedProduceExp: toNum(animal.expected_produce_exp),
        expectedProduceSells: normalizeSells(animal.expected_produce_sells),
        mutation: mutation ? {
            type: toNum(mutation.mutation_type),
            tier: toNum(mutation.tier),
            weightFinalX10: toNum(mutation.weight_final_x10),
            strokable: !!mutation.strokable,
        } : null,
    };
}

/** 把一条 Shelf 拍平 */
function normalizeShelf(shelf, ranchInstId) {
    return {
        ranchInstId,
        slotIndex: toNum(shelf.slot_index),
        totalRemain: toNum(shelf.total_remain),
        canCollect: !!shelf.can_collect,
        canSteal: !!shelf.can_steal,
        lots: asArray(shelf.lots).map(lot => ({
            itemId: toNum(lot.item_id),
            remainNum: toNum(lot.remain_num),
            stolenNum: toNum(lot.stolen_num),
            animalId: toNum(lot.animal_id),
            canSteal: !!lot.can_steal,
            stealerCount: asArray(lot.stealers).length,
        })),
    };
}

// ─── 主分析入口 ───

/**
 * 分析牧场状态。
 *
 * @param {object[]} ranches - getRanchDetail().ranches
 * @param {object} [options]
 * @param {number} [options.now] - 本地当前时间（便于测试注入）
 * @returns {object} 分析结果
 */
function analyzeRanches(ranches, options = {}) {
    const nowMs = Number(options.now) || Date.now();
    const list = asArray(ranches);

    const harvestable = [];       // 可直接收获的动物
    const needFeed = [];          // 需投喂
    const needClean = [];         // 灾害（虫/杂草）
    const collectableShelves = [];// 可收的货架
    const stealableShelves = [];  // 可偷的货架（好友牧场）
    const producing = [];         // 生产中（拿不到产物，等时间）
    const strokable = [];         // 可抚摸（mutation.strokable，抚摸可推进产出）
    const emptySlots = [];        // 空栏（补栏用；本闭环暂不自动买动物）

    let totalAnimals = 0;
    let totalCapacity = 0;
    let grassAmount = 0;
    let grassEmptyAtMs = 0;
    let nextProduceReadyAtMs = 0;
    let expectedHarvestExpTotal = 0;
    let expectedHarvestGoldTotal = 0;

    for (const ranch of list) {
        const ranchInstId = toNum(ranch.ranch_inst_id);
        const capacity = toNum(ranch.capacity);
        const animals = asArray(ranch.animals);
        totalAnimals += animals.length;
        totalCapacity += capacity;

        const grass = ranch.grass || null;
        if (grass) {
            const amount = toNum(grass.amount);
            // 多个牧场时取最大值（自己只有一块地，好友会有多块）
            if (amount > grassAmount) grassAmount = amount;
            grassEmptyAtMs = Math.max(grassEmptyAtMs, toNum(grass.empty_at_ms));
        }

        // 动物
        for (const rawAnimal of animals) {
            const animal = normalizeAnimal(rawAnimal, ranchInstId);
            if (animal.canHarvest) {
                harvestable.push(animal);
                expectedHarvestExpTotal += animal.expectedHarvestExp;
                for (const sell of animal.expectedHarvestSells) {
                    expectedHarvestGoldTotal += sell.count;
                }
            } else if (animal.canFeed) {
                needFeed.push(animal);
            } else if (animal.producing) {
                producing.push(animal);
            }
            // 抚摸与阶段无关：只要有 strokable 就记下来（抓包确认抚摸能推进产出）
            if (animal.mutation && animal.mutation.strokable) {
                strokable.push(animal);
            }
            // 最近一次产物成熟时刻：只统计未来且已知的，用来算下一次唤醒
            const ready = animal.produceReadyAtMs || animal.matureReadyAtMs;
            if (ready > nowMs && (nextProduceReadyAtMs === 0 || ready < nextProduceReadyAtMs)) {
                nextProduceReadyAtMs = ready;
            }
        }

        // 空栏
        const usedSlots = new Set(animals.map(a => toNum(a.slot_index)));
        for (let slot = 1; slot <= capacity; slot += 1) {
            if (!usedSlots.has(slot)) {
                emptySlots.push({ ranchInstId, slotIndex: slot });
            }
        }

        // 货架
        for (const rawShelf of asArray(ranch.shelves)) {
            const shelf = normalizeShelf(rawShelf, ranchInstId);
            if (shelf.canCollect) collectableShelves.push(shelf);
            if (shelf.canSteal) stealableShelves.push(shelf);
        }

        // 灾害
        for (const hazard of asArray(ranch.hazards)) {
            needClean.push({
                ranchInstId,
                hazardId: toNum(hazard.hazard_id),
                owner: toNum(hazard.owner),
                hazardType: toNum(hazard.hazard_type),
            });
        }
    }

    const labels = [];
    if (harvestable.length) labels.push(`收:${harvestable.length}`);
    if (collectableShelves.length) labels.push(`架:${collectableShelves.length}`);
    if (needFeed.length) labels.push(`喂:${needFeed.length}`);
    if (needClean.length) labels.push(`灾:${needClean.length}`);
    if (strokable.length) labels.push(`摸:${strokable.length}`);
    if (grassAmount < GRASS_LOW_THRESHOLD) labels.push(`草:${grassAmount}`);

    return {
        ranches: list,
        harvestable,
        collectableShelves,
        stealableShelves,
        needFeed,
        needClean,
        producing,
        strokable,
        emptySlots,
        grassAmount,
        grassEmptyAtMs,
        grassLow: grassAmount < GRASS_LOW_THRESHOLD,
        nextProduceReadyAtMs,
        expectedHarvestExpTotal,
        expectedHarvestGoldTotal,
        totalAnimals,
        totalCapacity,
        hasWork: harvestable.length > 0
            || collectableShelves.length > 0
            || needFeed.length > 0
            || needClean.length > 0
            || strokable.length > 0,
        label: labels.length ? `[${labels.join(' ')}]` : '[]',
    };
}

/** 距离下一次产物成熟还有多少毫秒（0 表示无已知时刻） */
function msUntilNextProduce(analysis, nowMs = Date.now()) {
    const readyAt = Number(analysis && analysis.nextProduceReadyAtMs) || 0;
    if (!readyAt) return 0;
    return Math.max(0, readyAt - nowMs);
}

/**
 * 阶段中文名。取值根据抓包统计反推（stage → 出现次数 / can_harvest / can_feed / producing）：
 *   1: 66/0/66/0   → 幼崽（全部需要投喂）
 *   2:  1/0/1/0    → 成长
 *   3: 45/0/41/41  → 生产（producing 占多数）
 *   4:  4/0/4/0    → 语义未确认，保留数字显示
 *   5:  4/4/0/0    → 可收（can_harvest 全部为真）
 * 4 没有足够证据命名，不编造。
 */
const STAGE_NAMES = {
    [STAGE_INFANT]: '幼崽',
    [STAGE_GROWING]: '成长',
    [STAGE_PRODUCING_ACTUAL]: '生产',
    [STAGE_HARVESTABLE]: '可收',
};

/**
 * 把分析结果转成面板直接可渲染的结构。
 *
 * 面板只需要「现在是什么状态、还能做什么」，不需要原始 RanchInfo。
 * 动物名字拿不到（在加密的 MCItemInfo 表里），所以按 ID 显示，等以后解表再补。
 *
 * @param {object} analysis - analyzeRanches() 的返回值
 * @param {number} [now]
 */
function buildPanelView(analysis, now = Date.now()) {
    const a = analysis || {};
    const remainSec = (atMs) => {
        const at = Number(atMs) || 0;
        if (!at) return 0;
        return Math.max(0, Math.ceil((at - now) / 1000));
    };

    const animals = [];
    for (const list of [a.harvestable || [], a.needFeed || [], a.producing || []]) {
        for (const animal of list) {
            const readyAt = animal.produceReadyAtMs || animal.matureReadyAtMs || 0;
            animals.push({
                ranchInstId: animal.ranchInstId,
                slotIndex: animal.slotIndex,
                animalInstId: animal.animalInstId,
                animalId: animal.animalId,
                name: getPastureAnimalName(animal.animalId),
                stage: animal.stage,
                stageName: STAGE_NAMES[animal.stage] || `阶段${animal.stage}`,
                canHarvest: animal.canHarvest,
                canFeed: animal.canFeed,
                producing: animal.producing,
                grassBlocked: animal.grassBlocked,
                produceCount: animal.produceCount,
                readyAtMs: readyAt,
                readyInSec: remainSec(readyAt),
                expectedHarvestExp: animal.expectedHarvestExp,
                expectedProduceExp: animal.expectedProduceExp,
                mutation: animal.mutation,
                strokable: !!(animal.mutation && animal.mutation.strokable),
            });
        }
    }
    animals.sort((x, y) => x.slotIndex - y.slotIndex);

    const shelves = [];
    for (const shelf of [...(a.collectableShelves || []), ...(a.stealableShelves || [])]) {
        shelves.push({
            ranchInstId: shelf.ranchInstId,
            slotIndex: shelf.slotIndex,
            totalRemain: shelf.totalRemain,
            canCollect: shelf.canCollect,
            canSteal: shelf.canSteal,
            lots: shelf.lots.length,
        });
    }

    const hazards = (a.needClean || []).map(h => ({
        ranchInstId: h.ranchInstId,
        hazardId: h.hazardId,
        hazardType: h.hazardType,
    }));

    const nextReadyInSec = remainSec(a.nextProduceReadyAtMs);

    return {
        // 汇总
        summary: {
            animals: a.totalAnimals || 0,
            capacity: a.totalCapacity || 0,
            emptySlots: (a.emptySlots || []).length,
            harvestable: (a.harvestable || []).length,
            collectableShelves: (a.collectableShelves || []).length,
            needFeed: (a.needFeed || []).length,
            needClean: (a.needClean || []).length,
            strokable: (a.strokable || []).length,
            grassAmount: a.grassAmount || 0,
            grassLow: !!a.grassLow,
            nextReadyInSec,
            expectedHarvestExp: a.expectedHarvestExpTotal || 0,
            label: a.label || '[]',
            hasWork: !!a.hasWork,
        },
        animals,
        shelves,
        hazards,
        emptySlots: a.emptySlots || [],
        updatedAt: now,
    };
}

module.exports = {
    STAGE_INFANT,
    STAGE_GROWING,
    STAGE_PRODUCING_ACTUAL,
    STAGE_UNKNOWN_4,
    STAGE_HARVESTABLE,
    GRASS_LOW_THRESHOLD,
    analyzeRanches,
    msUntilNextProduce,
    buildPanelView,
    // 供测试单独验证
    normalizeAnimal,
    normalizeShelf,
};