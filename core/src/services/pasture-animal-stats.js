/**
 * 牧场动物档案：用真实养殖数据反推「经验/时」和「收入/时」。
 *
 * 为什么不能静态算：动物商店只给 goods_id / animal_id / price，
 * 而成长周期、产出周期、经验、收益全在加密的 MCAnimalConfig（FSpk）里，
 * 已经确认静态解不开。但 AnimalInst 会带 expected_harvest_exp /
 * expected_produce_exp / expected_harvest_sells / expected_produce_sells，
 * 配上「放栏时刻 → 收获时刻」的真实周期，就能算出每小时产出。
 *
 * 数据是养出来的：没养过的动物查不到档案，购买策略会退回按价格挑。
 * 宁可退回，也不编造经验值。
 */

const fs = require('node:fs');
const path = require('node:path');
const { toNum, log } = require('../utils/utils');

const FILE_NAME = 'pasture-animal-stats.json';
/** 单只动物最多保留多少个周期样本（取中位数，抗异常值） */
const MAX_CYCLES = 9;

let cache = null;
let dirty = false;
let saveTimer = null;

function dataDir() {
    return process.env.FARM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
}

function filePath() {
    return path.join(dataDir(), FILE_NAME);
}

/** 内存里正在养殖的动物：animalInstId -> { animalId, placedAtMs } */
const alive = new Map();

function median(list) {
    const arr = list.filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!arr.length) return 0;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : Math.round((arr[mid - 1] + arr[mid]) / 2);
}

function load() {
    if (cache) return cache;
    cache = {};
    try {
        const raw = fs.readFileSync(filePath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            cache = parsed;
        }
    } catch { /* 没有档案就是空表，第一次养殖之后自然会有 */ }
    return cache;
}

function saveNow() {
    if (!dirty || !cache) return;
    dirty = false;
    try {
        fs.mkdirSync(dataDir(), { recursive: true });
        fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2));
    } catch (err) {
        log('牧场', `动物档案落盘失败: ${err.message}`, { module: 'pasture' });
    }
}

function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveNow();
    }, 2000);
    if (saveTimer.unref) saveTimer.unref();
}

function ensureEntry(animalId) {
    const table = load();
    const key = String(toNum(animalId));
    if (!table[key]) {
        table[key] = {
            animalId: toNum(animalId),
            harvestExp: 0,
            produceExp: 0,
            harvestGold: 0,
            produceGold: 0,
            cycles: [],
        };
    }
    return { table, key, entry: table[key] };
}

/**
 * 记下放栏时刻。用 animalInstId 做 key，因为收获时只能拿到它。
 */
function recordPlacement(animalInstId, animalId, atMs = Date.now()) {
    const inst = toNum(animalInstId);
    if (!inst) return;
    alive.set(inst, { animalId: toNum(animalId), placedAtMs: atMs });
}

/**
 * 每次拉到牧场详情时把预期值记下来。
 *
 * AnimalInst 的 expected_* 是「这一轮养完能拿到什么」，
 * 同一只动物在不同阶段数值一致，所以重复采集不会放大，只是覆盖。
 */
function observeAnimals(animals) {
    if (!Array.isArray(animals) || !animals.length) return;
    let changed = false;

    for (const a of animals) {
        const animalId = toNum(a.animalId);
        if (!animalId) continue;
        const inst = toNum(a.animalInstId);

        const { entry } = ensureEntry(animalId);
        const harvestExp = toNum(a.expectedHarvestExp);
        const produceExp = toNum(a.expectedProduceExp);
        const harvestGold = (a.expectedHarvestSells || []).reduce((s, x) => s + toNum(x && x.count), 0);
        const produceGold = (a.expectedProduceSells || []).reduce((s, x) => s + toNum(x && x.count), 0);

        // 只在新值更大时更新：服务端在不同阶段给的值可能不完整
        if (harvestExp > entry.harvestExp) { entry.harvestExp = harvestExp; changed = true; }
        if (produceExp > entry.produceExp) { entry.produceExp = produceExp; changed = true; }
        if (harvestGold > entry.harvestGold) { entry.harvestGold = harvestGold; changed = true; }
        if (produceGold > entry.produceGold) { entry.produceGold = produceGold; changed = true; }

        // 见过但没记录放栏时刻（比如进程重启）时，补一个近似起点
        if (inst && !alive.has(inst)) {
            alive.set(inst, { animalId, placedAtMs: Date.now() });
        }
    }

    if (changed) scheduleSave();
}

/**
 * 收获时结算一个完整周期。
 *
 * @param {number[]} animalInstIds 本次收获掉的动物实例
 * @param {number} [atMs]
 */
function recordHarvest(animalInstIds, atMs = Date.now()) {
    if (!Array.isArray(animalInstIds) || !animalInstIds.length) return;
    let changed = false;

    for (const raw of animalInstIds) {
        const inst = toNum(raw);
        const info = alive.get(inst);
        if (!info) continue;
        alive.delete(inst);
        const cycleMs = atMs - info.placedAtMs;
        // 明显不合理的周期（小于 1 分钟或大于 30 天）不采信，避免时钟跳变污染
        if (!(cycleMs > 60_000 && cycleMs < 30 * 24 * 3600_000)) continue;

        const { entry } = ensureEntry(info.animalId);
        entry.cycles.push(cycleMs);
        if (entry.cycles.length > MAX_CYCLES) entry.cycles.shift();
        changed = true;
    }

    if (changed) scheduleSave();
}

/**
 * 读某种动物的档案，附带按周期算出来的每小时指标。
 * 没有周期样本时，hourly 字段为 0，调用方应退回按价格挑。
 */
function getAnimalStats(animalId) {
    const table = load();
    const entry = table[String(toNum(animalId))];
    if (!entry) return null;

    const cycleMs = median(entry.cycles);
    const hours = cycleMs > 0 ? cycleMs / 3600_000 : 0;
    const totalExp = toNum(entry.harvestExp) + toNum(entry.produceExp);
    const totalGold = toNum(entry.harvestGold) + toNum(entry.produceGold);

    return {
        animalId: toNum(animalId),
        harvestExp: toNum(entry.harvestExp),
        produceExp: toNum(entry.produceExp),
        harvestGold: toNum(entry.harvestGold),
        produceGold: toNum(entry.produceGold),
        totalExp,
        totalGold,
        cycleMs,
        cycleSamples: entry.cycles.length,
        expPerHour: hours > 0 ? totalExp / hours : 0,
        goldPerHour: hours > 0 ? totalGold / hours : 0,
    };
}

/** 全部档案（面板展示用） */
function listAnimalStats() {
    const table = load();
    return Object.keys(table).map(id => getAnimalStats(id)).filter(Boolean);
}

/**
 * 按策略给候选动物排序。
 *
 * @param {object[]} goods 商店商品 [{goodsId, animalId, price, unlocked}]
 * @param {string} strategy cheapest | max_exp | max_profit | preferred
 * @param {number} preferredAnimal preferred 策略下优先的 animalId
 * @returns {object[]} 排好序的副本
 */
function rankAnimalGoods(goods, strategy = 'cheapest', preferredAnimal = 0) {
    const list = (goods || []).slice();
    const preferred = toNum(preferredAnimal);
    const stat = (g) => getAnimalStats(g.animalId);

    const preferredFirst = (a, b) => {
        if (!preferred) return 0;
        const ap = a.animalId === preferred ? 0 : 1;
        const bp = b.animalId === preferred ? 0 : 1;
        return ap - bp;
    };

    if (strategy === 'max_exp') {
        return list.sort((a, b) => {
            const pa = preferredFirst(a, b);
            if (pa) return pa;
            const sa = stat(a), sb = stat(b);
            // 有档案的排前面；档案之间比每小时经验；都没档案就按价格降序
            if (sa && sb) return (sb.expPerHour - sa.expPerHour) || (a.price - b.price);
            if (sa) return -1;
            if (sb) return 1;
            return b.price - a.price;
        });
    }

    if (strategy === 'max_profit') {
        return list.sort((a, b) => {
            const pa = preferredFirst(a, b);
            if (pa) return pa;
            const sa = stat(a), sb = stat(b);
            const na = sa && sa.cycleSamples ? sa.goldPerHour - a.price : null;
            const nb = sb && sb.cycleSamples ? sb.goldPerHour - b.price : null;
            if (na !== null && nb !== null) return (nb - na) || (a.price - b.price);
            if (na !== null) return -1;
            if (nb !== null) return 1;
            return b.price - a.price;
        });
    }

    if (strategy === 'preferred') {
        return list.sort((a, b) => {
            const pa = preferredFirst(a, b);
            if (pa) return pa;
            return a.price - b.price;
        });
    }

    // cheapest（默认）
    return list.sort((a, b) => a.price - b.price);
}

/** 测试用：清空内存与缓存 */
function resetAnimalStatsForTests() {
    alive.clear();
    cache = {};
    dirty = false;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

module.exports = {
    recordPlacement,
    observeAnimals,
    recordHarvest,
    getAnimalStats,
    listAnimalStats,
    rankAnimalGoods,
    resetAnimalStatsForTests,
    MAX_CYCLES,
};