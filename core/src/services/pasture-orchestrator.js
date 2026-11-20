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
const { isAutomationOn, getAutomation, getPasturePreferredAnimal, getPastureBuyStrategy, getPastureGrassThreshold } = require('../models/store');
const { isPastureProduceItemId } = require('../config/gameConfig');
const { recordEvent } = require('./daily-events');
const {
    getRanchDetail,
    harvestRanch,
    cleanAllRanch,
    cleanRanch,
    placeAnimal,
    triggerProduce,
    getFacilityDetail,
    addFeed,
    getAnimalShop,
    buyGoods,
    isAnimalItemId,
    FEED_MACHINE_FACILITY_ID,
} = require('./pasture-api');
const { getBag, sellItems } = require('./warehouse');
const { cannelNew } = require('./pasture-api');
const { recordOperation } = require('./stats');
const {
    recordPlacement,
    observeAnimals,
    recordHarvest,
    rankAnimalGoods,
} = require('./pasture-animal-stats');
const { analyzeRanches, msUntilNextProduce, GRASS_LOW_THRESHOLD } = require('./pasture-analyzer');
const routines = require('./pasture-routines');
const { inRanchScene, resetSceneStateForTests } = require('./pasture-scene');

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
// 牧草机存量检查间隔：阈值判断需要读设施详情，不能每轮 tick 都读
const GRASS_CHECK_INTERVAL_MS = 60_000;
let lastGrassCheckAtMs = 0;
/** 牧场货币（卖产物的结算单位，抓包实测 expected_*_sells 的 id） */
const PASTURE_CURRENCY_ID = 1007;
/**
 * 买动物冷却，只用于**失败**（含余额不足）场景，避免反复撞同一条错误。
 *
 * 成功买入不再套这个冷却：之前成功也设它，结果 3 个空栏位要 30 分钟才填满，
 * 表现出来就是「牧场跑一轮就再也不动」。
 */
const BUY_ANIMAL_FAIL_COOLDOWN_MS = 10 * 60_000;
let lastBuyAnimalFailAtMs = 0;
/**
 * 一键生产（TriggerProduce）的冷却。
 *
 * 它的作用是**让动物开始下蛋**：不调用它，动物只成长、不下产物，牧场就没有
 * 副产品可捡、可卖。抓包（使用有机罐头.har / 14_02_01.har）里操作顺序是
 * 「喂罐头 → 一键生产 → 收获鸡蛋」，所以它不等于喂罐头 —— 消耗道具的是
 * FeedAnimal，TriggerProduce 本身不花罐头。
 *
 * 触发条件由 `analysis.needsProduce` 决定（已到生产阶段、未在产出、产量仍为 0），
 * 天然幂等，所以冷却只用来防止同一批动物被连刷，30 秒足够；
 * 之前按「催熟」理解设成 5 分钟，会把下蛋拖慢一个数量级。
 */
const PRODUCE_COOLDOWN_MS = 30_000;
let lastProduceAtMs = 0;
/** 抚摸冷却：同一只动物 10 分钟内不重复摸（抚摸能推进产出，但服务端有配额） */
/** 单轮最多摸几只，避免一次把配额打空 */
/** 好友互动（放蚊/帮清理）冷却：每 5 分钟一轮，避免反复拉好友列表 */
const FRIEND_INTERACT_COOLDOWN_MS = 5 * 60_000;
let lastFriendInteractAtMs = 0;
/**
 * 场景模式下的最小进场景间隔：切换场景是两次 PlayerSceneLogin，
 * 高频 tick 里每次都切会把预算打满。30 秒内只真正进一次，
 * 其余轮次走 host_gid 直连（已验证可用）。
 */
const SCENE_ENTER_MIN_INTERVAL_MS = 30_000;

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

/**
 * 一键收获（HarvestRanch）。
 *
 * 官方客户端抓包确认：捡蛋之后 `animal_count` 始终不变，动物一只都没出栏 ——
 * 常态玩法是「**只收产物，动物留栏**」。所以这里默认只用 `harvest_type = 2`
 * （专收货架产物）。
 *
 * 之前一律用 `harvest_type = 1`（收获出栏），结果每轮把 3 只动物全收走，
 * 栏位立刻变 0/3，下一轮又得重新买 3 只 —— 表现出来就是「一直在买动物」，
 * 而反复买入的成本远高于产物收益。
 *
 * 只有一种情况仍需要出栏：动物已可收获、`producing` 为假，又没有任何产物可收，
 * 说明它占着栏位不再产出。这时用 `harvest_type = 1` 腾出位置。
 *
 * `1045229 当前没有可收取的产物` 属于正常状态（本地 analysis 与服务端快照
 * 短暂不同步时会撞到），按空操作处理，不按失败记录。
 */
/**
 * 把一次收获/捡蛋拿到的产物卖掉，换牧场币（1007）。
 *
 * 抓包（capture/查看牧场仓库-出售鸡蛋-批量出售.har）确认：
 *   ItemService.Sell 回包
 *     { f1: 1060001, f2: 2 }   ← 卖出 鸡蛋 ×2
 *     { f1: 1007,    f2: 2 }   ← 得到 牧场币 ×2
 * 不卖的话产物只是躺在背包里，而买动物一直在花牧场币 —— 牧场会持续净亏。
 *
 * 产物列表直接取自 `HarvestRanchReply.produces`（这次实际拿到的），
 * 不去猜背包状态，避免本地与服务端短暂不同步时卖出不存在的东西。
 */
async function sellHarvestProduce(reply) {
    if (!isAutomationOn('pasture_sell_produce')) return 0;
    // 注意：utils/proto 用 keepCase: true 加载，字段名保持 snake_case
    //（item_id / ranch_inst_id），写成 camelCase 会一直拿到 undefined，
    // 结果是「什么都没卖」却不报错。
    const items = [];
    for (const produce of (reply && reply.produces) || []) {
        for (const it of produce.items || []) {
            const id = toNum(it.item_id);
            const count = toNum(it.count);
            if (id > 0 && count > 0 && isPastureProduceItemId(id)) {
                items.push({ id, count });
            }
        }
    }
    if (!items.length) return 0;

    // 抓包顺序：批量出售前先对每个产物调一次 CannelNew（清「新物品」红点）。
    // 失败不影响出售本身，所以放在独立的 try 里。
    for (const it of items) {
        try {
            await cannelNew(it.id);
        } catch {
            // 清标记失败无所谓，继续卖
        }
    }

    try {
        await sellItems(items);
    } catch (err) {
        if (!isTransientNetworkError(err)) {
            logWarn('牧场', `产物出售失败: ${err.message}`);
        }
        return 0;
    }

    const total = items.reduce((sum, x) => sum + x.count, 0);
    const detail = items.map(x => `${x.id}x${x.count}`).join(', ');
    logPasture(`出售牧场产物 ${detail}`, {
        event: '牧场出售产物',
        count: total,
        items,
    });
    noteEvent('info', `牧场产物出售：${detail}`);
    recordOperation('pastureSellProduce', total);
    return total;
}

async function performHarvest(analysis, _shelvesOnly = false) {
    const harvestable = analysis.harvestable || [];
    const shelves = analysis.collectableShelves || [];
    const shelfLots = shelves.reduce((sum, x) => sum + x.lots.length, 0);

    // 只收蛋，不把动物收出栏。
    //
    // `harvest_type = 1` 会把可收获的动物**收走**，栏位立刻变空，下一轮又得买 ——
    // 而一键生产催过之后动物很快就变成可收获，于是 30 秒一圈：
    // 补 3 只 → 催产 → 捡蛋 → 收走 3 只 → 补 3 只，表现就是「牧场一直没有动物」。
    //
    // 动物应当留在栏里持续「生产中」，这样才会持续产蛋。收出栏是玩家主动卖动物
    // 的行为，不自动做；需要时用 `pasture_harvest_animals` 单独打开。
    const harvestAnimals = isAutomationOn('pasture_harvest_animals');
    const harvestType = (harvestAnimals && harvestable.length > 0 && shelfLots === 0) ? 1 : 2;
    const targets = harvestType === 1 ? harvestable : shelves;
    const ranchIds = [...new Set(targets.map(x => x.ranchInstId))];
    if (!ranchIds.length) return 0;

    let reply;
    try {
        reply = await harvestRanch({ ranchIds, op: harvestType });
    } catch (err) {
        if (/1045229/.test(String(err && err.message))) return 0;
        throw err;
    }

    if (harvestType === 1) {
        const gainedExp = analysis.expectedHarvestExpTotal;
        logPasture(`收获 ${harvestable.length} 只出栏（预期 +${gainedExp} 经验）`, {
            event: '牧场收获',
            count: harvestable.length,
        });
        noteEvent('info', `牧场收获 ${harvestable.length} 只动物产物，约 +${gainedExp} 经验`);
        recordOperation('pastureHarvest', harvestable.length);
        recordHarvest(harvestable.map(a => a.animalInstId));
    } else if (shelfLots > 0) {
        logPasture(`捡蛋 ${shelfLots} 项（动物留栏）`, {
            event: '牧场捡蛋',
            lots: shelfLots,
        });
        recordOperation('pastureCollect', shelfLots);
    }

    // 产物卖掉换牧场币：这是牧场唯一的收入来源
    await sellHarvestProduce(reply);

    return { reply, count: harvestType === 1 ? harvestable.length : 0, shelfLots };
}

/** 投喂：can_feed 的动物 */
/**
 * 触发生产：让到了生产阶段却没开工的动物进入产出周期。
 *
 * 早先这里被误判成「会把动物收出栏」而禁用，原因是那批日志里
 * 紧跟着一条 `收货架`（当时用的是 HarvestRanch），动物其实是被那一步收走的。
 * 后来单独做实验确认：TriggerProduce 之后栏位仍是 3/3，货架才多出产物。
 * 所以它是安全的，真正危险的是拿 HarvestRanch 去收货架。
 *
 * 接口无参数，一次调用覆盖所有待开工的动物。
 */
async function performTriggerProduce(analysis) {
    if (!analysis || !(analysis.needsProduce || []).length) return 0;
    // 催熟有代价：冷却没到就不催，让动物自然待在产出阶段
    if (Date.now() - lastProduceAtMs < PRODUCE_COOLDOWN_MS) return 0;
    lastProduceAtMs = Date.now();
    const count = analysis.needsProduce.length;
    try {
        await triggerProduce();
        logPasture(`触发生产 ${count} 只动物`, { event: '牧场触发生产', count });
        noteEvent('info', `牧场触发 ${count} 只动物开始生产`);
        return count;
    } catch (err) {
        if (!isTransientNetworkError(err)) {
            logWarn('牧场', `触发生产失败: ${err.message}`);
        }
        return 0;
    }
}

async function performFeed(analysis) {
    // AnimalService.FeedAnimal 是「喂罐头」，不是投喂：它会真的从罐头桶里扣罐头
    //（真机回 code=1045234「罐头桶已耗尽」就是这么撞出来的，还白烧了 4 个）。
    // 免费投喂的路径是牧草机 AddFeed，所以这里交给补草逻辑统一处理，
    // 绝不能替玩家烧罐头。
    // 主动喂罐头请用 pasture_feed_normal / pasture_feed_organic：
    // 那条路径会先查桶余量，桶是空的不提交。
    if (!analysis.needFeed.length) return 0;
    return performRefillGrass(analysis);
}

/**
 * 清理灾害。
 *
 * 优先用 CleanRanch 指名清理（抓包确认 field 2 是 hazard_ids 列表）：
 * 一键 CleanAllRanch 会把整片牧场都清掉，配额消耗不可控；
 * 拿不到 hazard_id 时才退回一键清理。
 */
async function performClean(analysis) {
    if (!analysis.needClean.length) return 0;
    const hazardIds = analysis.needClean
        .map(h => h.hazardId)
        .filter(id => Number(id) > 0);
    const ranchIds = [...new Set(analysis.needClean.map(h => h.ranchInstId))];

    let reply;
    let mode;
    if (hazardIds.length) {
        reply = await cleanRanch(hazardIds);
        mode = 'point';
    } else {
        reply = await cleanAllRanch(ranchIds);
        mode = 'all';
    }
    logPasture(`清理 ${analysis.needClean.length} 个灾害（${mode === 'point' ? '定点' : '一键'}）`, {
        event: '牧场清理',
        count: analysis.needClean.length,
        mode,
    });
    noteEvent('info', `牧场清理 ${analysis.needClean.length} 个灾害`);
    recordOperation('pastureClean', analysis.needClean.length);
    return { reply, count: analysis.needClean.length };
}

/**
 * 补栏：把动物放进空栏位。
 *
 * 两步走，顺序不能反：
 *   1. 背包里已有的动物优先（不花钱）；
 *   2. 背包没有、且用户显式开了 pasture_buy_animal，才去动物商店买。
 *
 * 买动物涉及余额，默认关闭。买入失败或余额不足后进入冷却，避免每轮重试。
 */
async function performRefillSlots(analysis) {
    const empty = analysis.emptySlots || [];
    if (!empty.length) return 0;

    let bagItems = [];
    try {
        const bag = await getBag();
        bagItems = (bag && bag.item_bag && bag.item_bag.items) || [];
    } catch {
        return 0;
    }
    const animals = bagItems
        .filter(it => isAnimalItemId(it.id) && toNum(it.count) > 0)
        .map(it => ({ id: toNum(it.id), count: toNum(it.count) }));

    // —— 第一步：先用背包里的 ——
    let placed = 0;
    for (const slot of empty) {
        if (!animals.length) break;
        const animal = animals[0];
        try {
            const res = await placeAnimal(slot.ranchInstId, animal.id);
            try {
                const fresh = ((res && res.ranches) || [])
                    .flatMap(r => r.animals || [])
                    .filter(a => toNum(a.animal_id) === animal.id)
                    .pop();
                if (fresh) recordPlacement(toNum(fresh.animal_inst_id), animal.id, Date.now());
            } catch { /* 同上 */ }
            placed += 1;
            animal.count -= 1;
            if (animal.count <= 0) animals.shift();
        } catch (err) {
            if (!isTransientNetworkError(err)) {
                logWarn('牧场', `放入动物失败: ${err.message}`);
            }
            break;
        }
    }
    if (placed > 0) {
        logPasture(`补栏 ${placed} 只（用背包库存）`, { event: '牧场补栏', count: placed });
        recordOperation('pastureRefill', placed);
        noteEvent('info', `牧场补栏 ${placed} 只动物`);
        return placed;
    }

    // —— 第二步：买动物（默认关闭）——
    const auto = getAutomation();
    if (!auto.pasture_buy_animal) return 0;
    const now = Date.now();
    if (now - lastBuyAnimalFailAtMs < BUY_ANIMAL_FAIL_COOLDOWN_MS) return 0;

    let balance = 0;
    for (const it of bagItems) {
        if (toNum(it.id) === PASTURE_CURRENCY_ID) balance = toNum(it.count);
    }

    try {
        const shop = await getAnimalShop();
        // 购买策略：cheapest / max_exp / max_profit / preferred。
        // max_exp 与 max_profit 依赖牧场动物档案（真实养殖数据），
        // 没养过的动物查不到档案，会自动退回按价格挑 —— 不编造经验值。
        const preferred = Math.max(0, Number(getPasturePreferredAnimal()) || 0);
        const strategy = String(getPastureBuyStrategy() || 'cheapest');
        const pickAffordable = () => rankAnimalGoods(
            shop.goods.filter(g => g.unlocked && g.price > 0 && g.price <= balance),
            strategy,
            preferred
        );
        let affordable = pickAffordable();
        if (!affordable.length) {
            lastBuyAnimalFailAtMs = now;
            logPasture(`余额 ${balance} 买不到可用动物（商店 ${shop.goods.length} 种）`);
            return 0;
        }

        // 一次把空栏位填满：买一只、放一只，余额递减后重新挑。
        // 之前只买一只且成功也套 10 分钟冷却，三个空位要半小时才填满。
        let bought = 0;
        for (let i = 0; i < empty.length; i++) {
            affordable = pickAffordable();
            if (!affordable.length) break;
            const pick = affordable[0];
            try {
                await buyGoods(pick.goodsId, 1, pick.price);
                const placed = await placeAnimal(empty[i].ranchInstId, pick.animalId);
                // 从回包里找出刚放进去的那只，记下放栏时刻
                try {
                    const fresh = ((placed && placed.ranches) || [])
                        .flatMap(r => r.animals || [])
                        .filter(a => toNum(a.animal_id) === pick.animalId)
                        .pop();
                    if (fresh) recordPlacement(toNum(fresh.animal_inst_id), pick.animalId, Date.now());
                } catch { /* 记不到就等下一次 observeAnimals 补 */ }
                balance -= pick.price;
                bought += 1;
                if (bought === 1) {
                    logPasture(`买入并补栏 1 只动物（goods ${pick.goodsId}，花费 ${pick.price}）`, {
                        event: '牧场买动物',
                        goodsId: pick.goodsId,
                        animalId: pick.animalId,
                        price: pick.price,
                    });
                    noteEvent('info', `牧场买入并补栏 1 只动物（花费 ${pick.price}）`);
                }
            } catch (err) {
                lastBuyAnimalFailAtMs = Date.now();
                if (!isTransientNetworkError(err)) {
                    logWarn('牧场', `买动物失败: ${err.message}`);
                }
                break;
            }
        }
        if (!bought) return 0;
        if (bought > 1) {
            logPasture(`本轮共补栏 ${bought} 只（余额剩 ${balance}）`, {
                event: '牧场买动物', count: bought, balance,
            });
        }
        recordOperation('pastureRefill', bought);
        return bought;
    } catch (err) {
        lastBuyAnimalFailAtMs = now;
        if (!isTransientNetworkError(err)) {
            logWarn('牧场', `买动物失败: ${err.message}`);
        }
        return 0;
    }
}

/**
 * 补草：牧草量低于阈值时给牧草机加料。
 *
 * 牧草机是 homestead 设施，加料走 FeedMachineService.AddFeed。
 * 分两步：先确认设施实例（拿当前草量），再按缺口补。
 */
async function performRefillGrass(_analysis) {
    const now = Date.now();
    if (now - lastGrassCheckAtMs < GRASS_CHECK_INTERVAL_MS) return 0;
    if (now - lastFeedMachineAtMs < FEED_MACHINE_COOLDOWN_MS) return 0;
    lastGrassCheckAtMs = now;

    // 第一次不知道实例 ID 时，从建筑列表里找
    if (!feedMachineInstId) {
        try {
            const { getBuildingList } = require('./pasture-api');
            const reply = await getBuildingList();
            const list = reply.items || [];
            const machine = list.find(b => toNum(b.facility_id) === FEED_MACHINE_FACILITY_ID);
            if (machine) feedMachineInstId = toNum(machine.inst_id);
        } catch {
            // 拿不到就跳过本轮，不阻塞其它操作
        }
        if (!feedMachineInstId) return 0;
    }

    try {
        const detail = await getFacilityDetail(feedMachineInstId);
        const facility = detail && detail.info;
        const state = facility && facility.feed_machine;
        // 抓包（牧草机补草.har）确认：FeedMachineDetail.feed_count 是当前草量
        //（AddFeed add_count=1 让它 99 → 100），真实容量在 FacilityDetailInfo.capacity（f14）。
        const current = toNum(state && state.feed_count);
        const capacity = toNum(facility && facility.capacity) || 100;
        const gap = Math.max(0, capacity - current);
        if (gap <= 0) return 0;

        // 阈值：存量百分比高于阈值就不补，避免一有缺口就加料
        const threshold = getPastureGrassThreshold();
        const percent = capacity > 0 ? Math.round((current / capacity) * 100) : 0;
        if (percent > threshold) return 0;

        // 补满：AddFeed 的 count 是份数（抓包 count=1 → +1），一次补齐缺口
        await addFeed(feedMachineInstId, gap);
        lastFeedMachineAtMs = now;
        logPasture(
            `牧草机补草 ${gap} 份（${current}/${capacity} = ${percent}%，阈值 ${threshold}%）`,
            { event: '牧场补草', current, capacity, gap, percent, threshold }
        );
        noteEvent('info', `牧场牧草机补草 ${gap} 份（${percent}% → 满）`);
        recordOperation('pastureGrass', gap);
        return gap;
    } catch (err) {
        if (!isTransientNetworkError(err)) {
            logWarn('牧场', `补草失败: ${err.message}`);
        }
        return 0;
    }
}

/**
 * 抚摸是**好友互动**，不能摸自己的动物。
 *
 * 上游 ranch 实现里抚摸走 `visit(hostGid)`，并且明确 `hostGid === selfGid`
 * 就抛「请选择好友牧场」；对本机实测也一样——用自家 gid 调
 * `RanchService.StrokeAnimal` 会被服务端判 `code=1000020 请求参数错误`。
 * 自己的动物 `mutation.strokable` 只表示「别人可以来摸」，自己摸无效。
 *
 * 所以这里不再直接发 StrokeAnimal，改由好友互动流程（runFriendInteraction）
 * 按配额 11009 去摸好友牧场的动物。保留函数只是为了不打断调用链。
 */
async function performStroke(_analysis) {
    return 0;
}


// ─── 主流程 ───

/**
 * 执行一轮牧场操作。
 * @param {string} opType - 'all' | 'harvest' | 'feed' | 'clean' | 'grass'
 */
async function runPastureOperation(opType = 'all', options = {}) {
    const reply = options.preloaded ? options.preloaded.reply : await getRanchDetail();
    const ranches = (reply && reply.ranches) || [];
    if (!ranches.length) {
        logPasture('没有牧场数据');
        return { hadWork: false, actions: [], analysis: null };
    }

    const analysis = options.preloaded ? options.preloaded.analysis : analyzeRanches(ranches);

    // 场景模式（pasture_use_scene）：把「动作执行」整段放进牧场场景里。
    // 读详情仍在场景外做（GetRanchDetail 不需要场景），这样无事可做的轮次
    // 不会额外花两次 PlayerSceneLogin。
    if (!options.inScene && getAutomation().pasture_use_scene) {
        const needsScene = opType !== 'all' || analysis.hasWork;
        if (needsScene) {
            return inRanchScene(
                () => runPastureOperation(opType, { ...options, inScene: true, preloaded: { reply, analysis } }),
                { minIntervalMs: SCENE_ENTER_MIN_INTERVAL_MS },
            );
        }
    }
    lastNextReadyAtMs = analysis.nextProduceReadyAtMs;
    // 每轮把 expected_* 采进动物档案，供购买策略排序
    observeAnimals(analysis.allAnimals || []);

    const actions = [];
    const auto = getAutomation();
    // opType 指定单项时只做那项；'all' 时看各自的细分开关。
    // 总开关 pasture 已在 checkPasture 校验过。
    const want = (name, switchKey) => (opType === 'all'
        ? auto[switchKey] !== false
        : opType === name);

    // 顺序：收获/捡蛋 → 生产 → 投喂 → 清理 → 补草
    // HarvestRanch 一次同时处理「成熟动物出栏」和「货架产物」，所以只发一次。
    if (want('harvest', 'pasture_harvest')) {
        const hasShelves = analysis.collectableShelves.length > 0;
        const hasAnimals = analysis.harvestable.length > 0;
        if (hasShelves || hasAnimals) {
            const r = await performHarvest(analysis);
            if (r.shelfLots > 0) actions.push('collect_shelves');
            if (r.count > 0) actions.push('harvest');
        }
    }
    if (want('produce', 'pasture_produce') && analysis.needsProduce.length) {
        const n = await performTriggerProduce(analysis);
        if (n) actions.push('trigger_produce');
    }
    if (want('stroke', 'pasture_stroke') && analysis.strokable.length) {
        const n = await performStroke(analysis);
        if (n) actions.push('stroke');
    }
    if (want('feed', 'pasture_feed') && analysis.needFeed.length) {
        // 分桶喂养（普通/有机）是新增细项，各自独立开关；两个都没开时
        // 继续走旧的单一投喂路径，既有行为保持不变。
        const feedAuto = getAutomation();
        if (feedAuto.pasture_feed_normal || feedAuto.pasture_feed_organic) {
            const n = await routines.runFeedBuckets();
            if (n) actions.push('feed');
        } else {
            const r = await performFeed(analysis);
            if (r) actions.push('feed');
        }
    }
    if (want('clean', 'pasture_clean') && analysis.needClean.length) {
        const r = await performClean(analysis);
        if (r) actions.push('clean');
    }

    // ─── 扩展阶段（2026-11-20 对齐上游 ranch 实现）───
    // 只在整体轮次里跑：面板单项操作不应衍生出额外动作。
    if (opType === 'all') {
        // 集市兑换（货币余额决定能换多少，内部会自己判余额）
        const exchanged = await routines.runMarketExchange();
        if (exchanged) actions.push('market_exchange');

        // 设施：棚激活 / 升级 / 完成升级
        const facilityDone = await routines.runFacilityUpgrade();
        if (facilityDone) actions.push('facility_upgrade');

        // 图鉴奖励（收获之后才有新解锁，所以放在收获后面）
        const bookDone = await routines.runClaimIllustrated();
        if (bookDone) actions.push('claim_illustrated');
    }
    if (want('refill', 'pasture_refill') && analysis.emptySlots.length) {
        const r = await performRefillSlots(analysis);
        if (r) actions.push('refill_slots');
    }
    // 触发条件在 performRefillGrass 内部按牧草机存量百分比判断（阈值可配），
    // 不能再用 analysis.grassLow —— 那是牧场草量，不是牧草机库存。
    if (want('grass', 'pasture_grass')) {
        const r = await performRefillGrass(analysis);
        if (r) actions.push('refill_grass');
    }

    if (opType === 'all') {
        // 罐头入桶（不消耗，只搬位置）
        const filled = await routines.runFillCans();
        if (filled) actions.push('fill_cans');

        // 每日分享礼包 / 罐头商城每日福利
        const shareDone = await routines.runDailyShare();
        if (shareDone) actions.push('daily_share');
        const benefitDone = await routines.runDailyBenefit();
        if (benefitDone) actions.push('daily_benefit');

        // 好友互动：放蚊子 / 帮清理（每轮最多 3 个好友，5 分钟冷却）
        const auto = getAutomation();
        if (auto.pasture_stroke || auto.pasture_friend_mosquito || auto.pasture_friend_clean) {
            if (Date.now() - lastFriendInteractAtMs >= FRIEND_INTERACT_COOLDOWN_MS) {
                lastFriendInteractAtMs = Date.now();
                try {
                    const { getAllFriends } = require('./friend-api');
                    const friends = await getAllFriends();
                    const interacted = await routines.runFriendInteraction(friends || []);
                    if (interacted) actions.push('friend_interact');
                } catch (err) {
                    if (!isTransientNetworkError(err)) {
                        logWarn('牧场', `好友互动失败: ${err.message}`);
                    }
                }
            }
        }
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
    lastGrassCheckAtMs = 0;
    lastBuyAnimalFailAtMs = 0;
    lastProduceAtMs = 0;
    lastFriendInteractAtMs = 0;
    resetSceneStateForTests();
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
    performStroke,
    performTriggerProduce,
    performRefillSlots,
    performRefillGrass,
    msUntilNextProduce,
    PASTURE_CURRENCY_ID,
};