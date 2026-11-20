/**
 * 牧场动作层：报价（quote）→ 确认执行（operate）
 *
 * 为什么要两段式：牧场里花钱的动作不可逆（买动物、集市兑换、升级设施、
 * 放养幼崽、喂罐头）。面板点一下就发请求的做法有两个真实问题：
 *   1. 余额/限购/状态在「读状态」和「发请求」之间会变，用户看到的费用可能已过期；
 *   2. 请求发出后如果断线，本地不知道该不该重发。
 *
 * 所以：先 planAction 出一份可展示的报价（含费用、预期奖励、签名），
 * 用户确认后再带 expected.signature 调 operate；operate 会重新报价并比对签名，
 * 不一致就拒绝执行（RANCH_OFFER_CHANGED），让用户重新确认。
 *
 * 所有写操作都走账本（pasture-operations）：先落盘、成功再删、失败按「是否
 * 真的发出去」决定撤销还是标为结果未知。
 */

const { types } = require('../utils/proto');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const api = require('./pasture-api');
const operations = require('./pasture-operations');
const { runWithPastureContext } = require('./pasture-context');
const { inRanchScene } = require('./pasture-scene');
const { getUserState } = require('../utils/network');

// ─── 常量 ───

/** 牧场货币 / 道具 */
const CURRENCY_GOLD = 1007;     // 金券
const ITEM_GRASS = 7001;        // 牧草
const ITEM_BUCKET_NORMAL = 7003;
const ITEM_BUCKET_ORGANIC = 7004;

/** 可出售的产物道具类型（ranchpb.Item.show.sells 齐全才可卖） */
const SELLABLE_TYPES = [106, 107];

/** 23 个可报价动作 */
const ACTIONS = [
    'buy', 'place', 'addGrass', 'useCan', 'feed', 'produce', 'harvest', 'sell',
    'clean', 'activateShed', 'upgrade', 'completeUpgrade', 'claimTasks',
    'reportEntry', 'exchange', 'claimIllustrated', 'claimDailyShare', 'buyCan',
    'steal', 'stroke', 'putMosquito', 'cleanFriend', 'release',
];

const LABELS = {
    buy: '购买牧场商品',
    place: '放养幼崽',
    addGrass: '补充牧草',
    useCan: '添加罐头',
    feed: '喂养动物',
    produce: '牧场生产',
    harvest: '牧场收获',
    sell: '出售牧场产物',
    clean: '清理牧场',
    activateShed: '解锁牧场棚',
    upgrade: '升级牧场设施',
    completeUpgrade: '完成牧场升级',
    claimTasks: '领取牧场任务',
    reportEntry: '完成牧场引导',
    exchange: '集市兑换',
    claimIllustrated: '领取牧场图鉴奖励',
    claimDailyShare: '领取每日首次分享礼包',
    buyCan: '购买牧场罐头',
    steal: '偷取好友产物',
    stroke: '抚摸动物',
    putMosquito: '放蚊子',
    cleanFriend: '清理好友栏舍',
    release: '放生动物',
    acknowledge: '解除待核对保护',
};

/** 预期失败：跳过本步即可，不当作故障 */
const EXPECTED_CODES = new Set([
    'INSUFFICIENT_BALANCE', 'RESERVE_PROTECTED', 'PENDING_CONFIRMATION',
    'RANCH_OFFER_CHANGED', 'RANCH_EXCHANGE_UNAVAILABLE', 'GOODS_UNAVAILABLE',
    'RANCH_STATE_CHANGED', 'RANCH_FULL', 'RANCH_GRASS_CAPACITY', 'RANCH_BUCKET_EMPTY',
    'RANCH_INTERACTION_LIMIT', 'RANCH_TASK_UNAVAILABLE', 'RANCH_ITEM_UNAVAILABLE',
    'RANCH_UPGRADE_UNAVAILABLE', 'RANCH_UPGRADE_PENDING', 'RANCH_CAN_UNAVAILABLE',
    'RANCH_SHARE_UNAVAILABLE', 'RANCH_HAZARD_FULL', 'RANCH_ANIMAL_MISMATCH',
    'PURCHASE_LIMIT_EXCEEDED',
]);

// ─── 小工具 ───

function errOf(code, message) {
    return Object.assign(new Error(message), { code });
}

/** protobufjs 的 int64 是 Long，比较/拼接一律先转字符串 */
function qty(value) {
    if (value == null) return '0';
    return typeof value === 'string' ? value : value.toString();
}

function idOf(value) {
    return Number(qty(value));
}

function countOf(value) {
    return BigInt(qty(value));
}

function itemDto(id, count) {
    const numId = idOf(id);
    const cfg = getItemById(numId) || {};
    return {
        id: numId,
        count: qty(count),
        name: cfg.name || `物品${numId}`,
        image: getItemImageById(numId) || '',
    };
}

/** 按 id 合并并过滤零值，保持首次出现顺序（签名依赖这个顺序） */
function sumItems(list) {
    const merged = new Map();
    for (const item of list || []) {
        const id = idOf(item.id);
        if (!id) continue;
        const count = countOf(item.count);
        if (count <= 0n) continue;
        const prev = merged.get(id);
        merged.set(id, prev ? { ...prev, count: (countOf(prev.count) + count).toString() } : itemDto(id, count));
    }
    return [...merged.values()];
}

function itemEntries(list) {
    return (list || []).map(item => ({ id: idOf(item.id), count: qty(item.count) }));
}

/** 业务余额：总量 - 锁定 */
function balanceOf(bag, id) {
    const target = idOf(id);
    let total = 0n;
    let locked = 0n;
    for (const item of [...(bag && bag.physical_items) || [], ...(bag && bag.virtual_items) || []]) {
        if (idOf(item.id) !== target) continue;
        total += countOf(item.count);
        if (item.is_locked) locked += countOf(item.count);
    }
    return { total, locked };
}

/** 可用余额还要扣掉「待核对操作」的预留 */
function availableOf(raw, id, accountId) {
    const { total, locked } = balanceOf(raw && raw.bag, id);
    const reserved = accountId ? BigInt(operations.reserved(accountId, `item:${idOf(id)}`)) : 0n;
    const left = total - locked - reserved;
    return left > 0n ? left : 0n;
}

/** 签名：键顺序固定，只覆盖这五项 */
function signPlan(plan) {
    return JSON.stringify({
        action: plan.action,
        payload: plan.payload,
        costs: plan.costs,
        rewards: plan.expectedRewards,
        marker: plan.marker,
    });
}

function accountIdOf() {
    const userState = getUserState();
    return userState && userState.accountId;
}

/**
 * 解析 MallGoods.price（序列化的 corepb.Item：1 = 货币 id，2 = 数量）。
 * 免费商品/未下发时返回 {id:0,count:0n}。
 */
function parseMallPrice(raw) {
    const empty = { id: 0, count: 0n };
    if (!raw) return empty;
    let buf = null;
    if (Buffer.isBuffer(raw)) buf = raw;
    else if (raw instanceof Uint8Array) buf = Buffer.from(raw);
    if (!buf || !buf.length) return empty;
    let pos = 0;
    let id = 0;
    let count = 0n;
    while (pos < buf.length) {
        const key = buf[pos++];
        const field = key >> 3;
        const wire = key & 0x7;
        if (wire !== 0) break;
        let shift = 0n;
        let value = 0n;
        while (pos < buf.length) {
            const byte = buf[pos++];
            value |= BigInt(byte & 0x7F) << shift;
            if ((byte & 0x80) === 0) break;
            shift += 7n;
        }
        if (field === 1) id = Number(value);
        else if (field === 2) count = value;
    }
    return { id, count };
}

// ─── 状态读取 ───

/** 拉一份决策用的原始快照：栏舍 + 牧场背包 */
async function loadRaw() {
    const detail = await api.getRanchDetail();
    const bag = await api.getBag();
    return { detail, ranches: detail.ranches || [], bag };
}

function allAnimals(ranches) {
    const out = [];
    for (const ranch of ranches || []) {
        for (const animal of ranch.animals || []) {
            out.push({ ranch, animal });
        }
    }
    return out;
}

function allShelves(ranches) {
    const out = [];
    for (const ranch of ranches || []) {
        for (const shelf of ranch.shelves || []) {
            out.push({ ranch, shelf });
        }
    }
    return out;
}

function allHazards(ranches) {
    const out = [];
    for (const ranch of ranches || []) {
        for (const hazard of ranch.hazards || []) {
            out.push({ ranch, hazard });
        }
    }
    return out;
}

/** 牧场背包里可卖的产物批次 */
function sellableLots(bag) {
    const out = [];
    for (const item of (bag && bag.physical_items) || []) {
        const cfg = getItemById(idOf(item.id)) || {};
        if (!SELLABLE_TYPES.includes(Number(cfg.type))) continue;
        if (item.is_locked) continue;
        if (!item.show) continue;
        if ((item.show.sell_cond || []).length) continue;
        const sells = item.show.sells || [];
        if (!sells.length) continue;
        if (!sells.every(s => countOf(s.id) > 0n && countOf(s.count) > 0n)) continue;
        if (countOf(item.count) <= 0n) continue;
        out.push({ item, rewards: sells });
    }
    return out;
}

/** 牧场背包里可入桶的罐头 */
function canItems(bag) {
    return ((bag && bag.physical_items) || []).filter(item => {
        const id = idOf(item.id);
        return (id === ITEM_BUCKET_NORMAL || id === ITEM_BUCKET_ORGANIC) && !item.is_locked;
    });
}

/** 背包里的幼崽（道具 id 落在动物段 60xxx） */


// ─── 报价 ───

/**
 * 生成报价。返回 { action,label,costs,costItems,rewards,count,expected,skipped,message }
 * count === 0 表示当前无事可做（skipped），operate 会直接返回 skipped 而不发包。
 */
async function planAction(action, input = {}, raw = null) {
    if (!ACTIONS.includes(action)) throw errOf('INVALID_ARGUMENT', '不支持的牧场操作');
    const state = raw || await loadRaw();
    const label = LABELS[action];
    const plan = {
        action, label, route: action, payload: {}, costItems: [], expectedRewards: [],
        marker: null, count: 1, next: null, tasks: [], autoPlaceAnimalId: 0,
        resultKeys: null, bucketId: 0, expectedSeconds: 0,
    };

    switch (action) {
        case 'harvest': buildHarvest(plan, input, state); break;
        case 'produce': buildProduce(plan, input, state); break;
        case 'clean': buildClean(plan, state); break;
        case 'sell': buildSell(plan, input, state); break;
        case 'feed': buildFeed(plan, input, state); break;
        case 'place': buildPlace(plan, input, state); break;
        case 'addGrass': buildAddGrass(plan, input, state); break;
        case 'useCan': buildUseCan(plan, input, state); break;
        case 'buy': await buildBuy(plan, input); break;
        case 'exchange': await buildExchange(plan, input); break;
        case 'buyCan': await buildBuyCan(plan, input, state); break;
        case 'upgrade': await buildUpgrade(plan, input, state); break;
        case 'completeUpgrade': buildCompleteUpgrade(plan, input, state); break;
        case 'activateShed': buildActivateShed(plan, input, state); break;
        case 'claimTasks': await buildClaimTasks(plan, input, state); break;
        case 'reportEntry': await buildReportEntry(plan, input, state); break;
        case 'claimIllustrated': await buildClaimIllustrated(plan, input); break;
        case 'claimDailyShare': await buildClaimDailyShare(plan); break;
        case 'release': buildRelease(plan, input, state); break;
        case 'steal': await buildSteal(plan, input); break;
        case 'stroke': await buildStroke(plan, input); break;
        case 'putMosquito': await buildPutMosquito(plan, input, state); break;
        case 'cleanFriend': await buildCleanFriend(plan, input, state); break;
        default: throw errOf('INVALID_ARGUMENT', '不支持的牧场操作');
    }

    plan.costItems = sumItems(plan.costItems);
    plan.expectedRewards = sumItems(plan.expectedRewards);
    plan.costs = plan.costItems.map(item => ({ resourceKey: `item:${item.id}`, amount: item.count }));

    const accountId = accountIdOf();
    for (let i = 0; i < plan.costItems.length; i += 1) {
        const need = countOf(plan.costItems[i].count);
        const left = availableOf(state, plan.costItems[i].id, accountId);
        if (left < need) {
            throw errOf('INSUFFICIENT_BALANCE', `${plan.costItems[i].name}不足`);
        }
    }

    plan.signature = signPlan(plan);
    return {
        action,
        label,
        costs: plan.costs,
        costItems: plan.costItems,
        rewards: plan.expectedRewards,
        count: plan.count,
        message: plan.message,
        skipped: plan.count === 0,
        expected: { signature: plan.signature },
        _plan: plan,
    };
}

// ── 各动作的报价实现 ──

function buildHarvest(plan, input, state) {
    const animals = allAnimals(state.ranches).filter(e => e.animal.can_harvest);
    const shelves = allShelves(state.ranches).filter(e => e.shelf.can_collect);
    const ranchIds = [...new Set(state.ranches.map(r => qty(r.ranch_inst_id)))].map(Number);

    if (input.all === true) {
        plan.payload = { ranch_inst_ids: ranchIds.map(id => String(id)), op: 1 };
        plan.count = animals.length + shelves.length;
        plan.resultKeys = [
            ...animals.map(e => `${qty(e.ranch.ranch_inst_id)}:1:${qty(e.animal.animal_inst_id)}`),
            ...shelves.map(e => `${qty(e.ranch.ranch_inst_id)}:2:${Number(e.shelf.slot_index)}`),
        ];
        return;
    }

    const wanted = pickAnimalRefs(plan, input, state);
    if (!wanted.length) { plan.count = 0; return; }
    plan.payload = { ranch_inst_ids: ranchIds.map(id => String(id)), op: 4, animals: wanted };
    plan.count = wanted.length;
    plan.resultKeys = wanted.map(a => `${a.ranch_inst_id}:1:${a.animal_inst_id}`);
}

function buildProduce(plan, input, state) {
    const animals = allAnimals(state.ranches).filter(e => e.animal.can_deliver);
    if (animals.length === 0) { plan.count = 0; return; }
    if (input.all === true) {
        plan.payload = { targets: [] };
        plan.count = animals.length;
        plan.resultKeys = animals.map(e => `${qty(e.ranch.ranch_inst_id)}:1:${qty(e.animal.animal_inst_id)}`);
        return;
    }
    const wanted = pickAnimalRefs(plan, input, state, 'can_deliver');
    if (!wanted.length) { plan.count = 0; return; }
    plan.payload = { targets: wanted };
    plan.count = wanted.length;
    plan.resultKeys = wanted.map(a => `${a.ranch_inst_id}:1:${a.animal_inst_id}`);
}

function pickAnimalRefs(plan, input, state, requireFlag) {
    const ranchId = input.ranchId != null ? idOf(input.ranchId) : 0;
    const animalId = input.animalId != null ? idOf(input.animalId) : 0;
    const picks = [];
    for (const { ranch, animal } of allAnimals(state.ranches)) {
        if (ranchId && idOf(ranch.ranch_inst_id) !== ranchId) continue;
        if (animalId && idOf(animal.animal_inst_id) !== animalId) continue;
        if (requireFlag && !animal[requireFlag]) continue;
        picks.push({
            ranch_inst_id: qty(ranch.ranch_inst_id),
            animal_inst_id: qty(animal.animal_inst_id),
        });
    }
    if (!picks.length && (ranchId || animalId)) {
        throw errOf('RANCH_STATE_CHANGED', '动物状态已变化，请刷新后重新操作');
    }
    return picks;
}

function buildClean(plan, state) {
    const hazards = allHazards(state.ranches);
    if (!hazards.length) { plan.count = 0; return; }
    const ranchIds = [...new Set(hazards.map(h => qty(h.ranch.ranch_inst_id)))];
    plan.payload = { ranch_inst_ids: ranchIds };
    plan.count = hazards.length;
    plan.resultKeys = hazards.map(h => `${qty(h.ranch.ranch_inst_id)}:3:${qty(h.hazard.hazard_id)}`);
}

function buildSell(plan, input, state) {
    const lots = sellableLots(state.bag);
    if (input.all === true) {
        if (!lots.length) { plan.count = 0; return; }
        plan.payload = {
            items: lots.map(l => ({ id: qty(l.item.id), uid: qty(l.item.uid), count: qty(l.item.count) })),
        };
        plan.expectedRewards = lots.flatMap(l => l.rewards);
        plan.count = lots.length;
        return;
    }
    const uid = input.uid != null ? String(input.uid) : '';
    const lot = lots.find(l => qty(l.item.uid) === uid);
    if (!lot) throw errOf('RANCH_ITEM_UNAVAILABLE', '物品库存、锁定或出售条件已变化');
    const want = Math.min(Number(input.count) || 0, Number(qty(lot.item.count)));
    if (want <= 0) throw errOf('INVALID_ARGUMENT', '数量超出范围');
    plan.payload = { items: [{ id: qty(lot.item.id), uid: qty(lot.item.uid), count: String(want) }] };
    plan.expectedRewards = lot.rewards.map(r => itemDto(r.id, countOf(r.count) * countOf(want)));
    plan.count = 1;
}

function buildFeed(plan, input, state) {
    const bucketType = Number(input.bucketType) === 1 ? 1 : (Number(input.bucketType) === 2 ? 2 : 0);
    if (!bucketType) throw errOf('INVALID_ARGUMENT', '请选择有机或普通罐头');
    const bucketId = bucketType === 1 ? ITEM_BUCKET_ORGANIC : ITEM_BUCKET_NORMAL;
    const targets = allAnimals(state.ranches)
        .filter(e => e.animal.can_feed)
        .filter(e => bucketType === 1 || !e.animal.limited_can_used)
        .map(e => ({
            ranch_inst_id: qty(e.ranch.ranch_inst_id),
            animal_inst_id: qty(e.animal.animal_inst_id),
        }));
    if (!targets.length) { plan.count = 0; return; }
    const total = balanceOf(state.bag, bucketId).total;
    if (total <= 0n) throw errOf('RANCH_BUCKET_EMPTY', '罐头桶为空，请先添加罐头');
    plan.payload = { targets, bucket_type: bucketType };
    plan.bucketId = bucketId;
    plan.costItems = [{ id: bucketId, count: total.toString(), name: bucketType === 1 ? '有机罐头桶' : '普通罐头桶' }];
    plan.count = targets.length;
    plan.resultKeys = targets.map(t => `${t.ranch_inst_id}:1:${t.animal_inst_id}`);
}

function buildPlace(plan, input, state) {
    const ranchId = idOf(input.ranchId);
    const itemId = idOf(input.itemId);
    const want = Number(input.count) || 0;
    if (!ranchId || !itemId || want <= 0) throw errOf('INVALID_ARGUMENT', '数量超出范围');
    const ranch = state.ranches.find(r => idOf(r.ranch_inst_id) === ranchId);
    if (!ranch) throw errOf('RANCH_STATE_CHANGED', '动物状态已变化，请刷新后重新操作');
    const room = Math.max(0, idOf(ranch.capacity) - idOf(ranch.animal_count));
    if (room <= 0) throw errOf('RANCH_FULL', '窝或棚的空位不足');
    const owned = availableOf(state, itemId, accountIdOf());
    const count = Math.min(want, room, Number(owned));
    if (count <= 0) throw errOf('RANCH_FULL', '窝或棚的空位不足，请减少数量或先放入背包');
    plan.payload = {
        items: [{ ranch_inst_id: String(ranchId), animal_id: String(itemId), count: String(count) }],
    };
    plan.costItems = [{ id: itemId, count: String(count) }];
    plan.count = count;
}

function buildAddGrass(plan, input, state) {
    const facilityId = idOf(input.facilityId);
    const want = Number(input.count) || 0;
    const facility = findFacility(state, facilityId);
    if (!facility) throw errOf('RANCH_FACILITY_NOT_FOUND', '牧场设施尚未建造或未就绪');
    const capacity = idOf(facility.capacity);
    const current = idOf(facility.feed_machine && facility.feed_machine.feed_count);
    const room = Math.max(0, capacity - current);
    if (room <= 0) throw errOf('RANCH_GRASS_CAPACITY', '牧草机剩余容量不足');
    const count = Math.min(want || room, room, Number(availableOf(state, ITEM_GRASS, accountIdOf())));
    if (count <= 0) throw errOf('INSUFFICIENT_BALANCE', '牧草不足');
    plan.payload = { instance_id: String(facilityId), add_count: String(count), use_gold: false };
    plan.costItems = [{ id: ITEM_GRASS, count: String(count) }];
    plan.count = 1;
}

function buildUseCan(plan, input, state) {
    const uid = String(input.uid == null ? '' : input.uid);
    const want = Number(input.count) || 0;
    const item = canItems(state.bag).find(i => qty(i.uid) === uid);
    if (!item) throw errOf('RANCH_CAN_UNAVAILABLE', '罐头库存不足或已锁定');
    const count = Math.min(want, Number(qty(item.count)));
    if (count <= 0) throw errOf('INVALID_ARGUMENT', '数量超出范围');
    plan.payload = { item: { id: qty(item.id), uid: qty(item.uid), count: String(count) } };
    plan.costItems = [{ id: idOf(item.id), count: String(count) }];
    plan.bucketId = idOf(item.id);
    plan.count = 1;
}

async function buildBuy(plan, input) {
    const shopId = Number(input.shopId);
    if (![5, 6].includes(shopId)) throw errOf('INVALID_ARGUMENT', '不支持的牧场商店');
    const goodsId = idOf(input.goodsId);
    const want = Number(input.count) || 0;
    const shop = await api.getRanchShop(shopId);
    const good = (shop.goods_list || []).find(g => idOf(g.id) === goodsId);
    if (!good || !good.unlocked) throw errOf('GOODS_UNAVAILABLE', '商品尚未解锁、已售罄或配置未确认');
    const limitLeft = idOf(good.limit_count) > 0 ? idOf(good.limit_count) - idOf(good.bought_num) : Infinity;
    const count = Math.min(want, limitLeft);
    if (count <= 0) throw errOf('PURCHASE_LIMIT_EXCEEDED', '数量超过本次购买或限购上限');

    // 牧场商店（5 幼崽 / 6 牧草）一律金券计价；服务端会用 price 校验价格没变。
    const unitPrice = countOf(good.price);
    plan.payload = {
        goods_id: String(goodsId),
        num: String(count),
        price: unitPrice.toString(),
        auto_add: input.autoPlace === true,
    };
    plan.costItems = [{ id: CURRENCY_GOLD, count: (unitPrice * countOf(count)).toString() }];
    plan.expectedRewards = good.item_id
        ? [itemDto(good.item_id, countOf(good.item_count) * countOf(count))]
        : [];
    plan.marker = shopId;
    plan.autoPlaceAnimalId = input.autoPlace === true ? idOf(good.item_id) : 0;
    plan.count = 1;
}

async function buildExchange(plan, input) {
    const goodsId = idOf(input.goodsId);
    const want = Number(input.count) || 0;
    const rotation = await api.getRotationShopInfo();
    if (!rotation.opened || !rotation.present) {
        throw errOf('RANCH_EXCHANGE_UNAVAILABLE', '集市已离场、商品受限或限购已用完');
    }
    const good = (rotation.goods || []).find(g => idOf(g.goods_id) === goodsId);
    if (!good) throw errOf('RANCH_EXCHANGE_UNAVAILABLE', '集市已离场、商品受限或限购已用完');
    const limitLeft = idOf(good.limit_count) > 0 ? idOf(good.limit_count) - idOf(good.limit_used) : Infinity;
    const count = Math.min(want, limitLeft);
    if (count <= 0) throw errOf('RANCH_EXCHANGE_UNAVAILABLE', '集市已离场、商品受限或限购已用完');
    plan.payload = {
        goods_id: String(goodsId),
        count: String(count),
        period_day: qty(rotation.period_day),
        round_index: String(idOf(rotation.round_index)),
    };
    plan.costItems = [{ id: idOf(good.cost_item_id), count: (countOf(good.cost_count) * countOf(count)).toString() }];
    plan.expectedRewards = [itemDto(good.item_id, countOf(good.item_count) * countOf(count))];
    plan.count = 1;
}

async function buildBuyCan(plan, input) {
    const slotType = Number(input.slotType) === 7 ? 7 : 6;
    const goodsId = idOf(input.goodsId);
    const want = Math.max(1, Number(input.count) || 1);
    const list = await api.getCanMallList(slotType);
    const good = (list.goods || []).find(g => idOf(g.goods_id) === goodsId);
    if (!good) throw errOf('GOODS_UNAVAILABLE', '罐头商品不可购买或超过限购数量');
    plan.payload = { goods_id: String(goodsId), count: String(want) };
    // MallGoods.price 是序列化的 Item（1=货币 id，2=数量），免费商品为空
    const price = parseMallPrice(good.price);
    if (!good.is_free && price.id && price.count > 0n) {
        plan.costItems = [{ id: price.id, count: (price.count * countOf(want)).toString() }];
    }
    plan.expectedRewards = (good.item_ids || []).map(raw => {
        try {
            const item = types.RanchItem.decode(raw);
            return itemDto(item.id, item.count);
        } catch {
            return null;
        }
    }).filter(Boolean);
    plan.marker = { slotType, free: !!good.is_free };
    plan.count = 1;
}

async function buildUpgrade(plan, input, state) {
    const facilityId = idOf(input.facilityId);
    const facility = findFacility(state, facilityId);
    if (!facility) throw errOf('RANCH_FACILITY_NOT_FOUND', '牧场设施尚未建造或未就绪');
    if (idOf(facility.state) !== 1 || idOf(facility.upgrade_state) !== 0) {
        throw errOf('RANCH_UPGRADE_UNAVAILABLE', '尚未满足等级要求、已满级或正在升级');
    }
    const detail = await api.getFacilityDetail(facilityId);
    const info = detail && detail.info;
    const cost = (info && info.upgrade_cost) || [];
    if (!cost.length) throw errOf('RANCH_PRICE_UNKNOWN', '升级费用尚未确认');
    plan.payload = { inst_id: String(facilityId) };
    plan.costItems = cost.map(item => itemDto(item.id, item.count));
    plan.marker = { facilityId, level: idOf(facility.level) };
    plan.next = { level: idOf(facility.level) + 1 };
    plan.count = 1;
}

function buildCompleteUpgrade(plan, input, state) {
    const facilityId = idOf(input.facilityId);
    const facility = findFacility(state, facilityId);
    if (!facility) throw errOf('RANCH_FACILITY_NOT_FOUND', '牧场设施尚未建造或未就绪');
    if (idOf(facility.upgrade_state) === 0) { plan.count = 0; return; }
    plan.payload = { inst_id: String(facilityId) };
    plan.marker = { facilityId, level: idOf(facility.level) };
    plan.count = 1;
}

function buildActivateShed(plan, input, state) {
    const facilityId = idOf(input.facilityId);
    const facility = findFacility(state, facilityId);
    if (!facility) throw errOf('RANCH_FACILITY_NOT_FOUND', '牧场设施尚未建造或未就绪');
    if (idOf(facility.module_type) !== 7) throw errOf('RANCH_STATE_CHANGED', '建筑等级已变化');
    plan.payload = { instance_id: String(facilityId) };
    plan.marker = idOf(facility.facility_id);
    plan.count = idOf(facility.state) === 3 ? 1 : 0;
}

async function buildClaimTasks(plan, input) {
    const reply = await api.getRanchTasks();
    const tasks = taskList(reply).filter(t => !t.claimed && t.canClaim);
    const picked = input.all === true ? tasks : tasks.filter(t => qty(t.id) === String(input.taskId));
    if (!picked.length) { plan.count = 0; return; }
    plan.marker = picked.map(t => ({
        id: qty(t.id),
        multiple: Number(t.share_multiple) > 1 && input.double !== false ? Number(t.share_multiple) : 1,
        rewards: t.rewards,
    }));
    plan.expectedRewards = plan.marker.flatMap(t =>
        (t.rewards || []).map(r => itemDto(r.id, countOf(r.count) * countOf(t.multiple))));
    plan.count = picked.length;
    plan.route = 'claimTasks';
}

async function buildReportEntry(plan, input) {
    if (input.entry !== 'friends') throw errOf('INVALID_ARGUMENT', '该任务入口尚未验证');
    const reply = await api.getRanchTasks();
    const list = taskList(reply).filter(t => t.unlocked && !t.claimed
        && countOf(t.progress) < countOf(t.total)
        && isClientReportedTask(t));
    if (!list.length) { plan.count = 0; return; }
    plan.payload = list.map(t => ({ task_id: qty(t.id), progress: qty(t.total) }));
    plan.route = 'reportTask';
    plan.count = list.length;
}

async function buildClaimIllustrated(plan, input) {
    const kind = input.kind === 'giant' ? 'giant' : 'normal';
    if (kind === 'normal') {
        const book = await api.getIllustratedList(101);
        if (!book.has_claimable_reward) { plan.count = 0; return; }
        plan.payload = { type: 101 };
        plan.expectedRewards = (book.total_rewards || []).map(r => itemDto(r.id, r.count));
        plan.marker = { kind, ids: [], rewards: plan.expectedRewards };
        plan.count = 1;
        return;
    }
    const weight = await api.getRanchWeightScore();
    const levels = (weight.levels || []).filter(l => l.can_claim && !l.claimed);
    if (!levels.length) { plan.count = 0; return; }
    plan.marker = {
        kind,
        ids: levels.map(l => idOf(l.id)),
        rewards: sumItems(levels.flatMap(l => l.rewards || [])),
    };
    plan.expectedRewards = plan.marker.rewards;
    plan.levels = levels;
    plan.count = levels.length;
}

async function buildClaimDailyShare(plan) {
    const can = await api.checkCanShare();
    if (!can.can_share) throw errOf('RANCH_SHARE_UNAVAILABLE', '当前分享入口不可用');
    plan.payload = {};
    plan.marker = { shareId: 102 };
    plan.count = 1;
}

function buildRelease(plan, input, state) {
    if (input.all === true) throw errOf('INVALID_ARGUMENT', '放生需要逐只确认');
    const wanted = pickAnimalRefs(plan, input, state, 'can_donate');
    if (!wanted.length) throw errOf('RANCH_STATE_CHANGED', '动物状态已变化，请刷新后重新操作');
    plan.payload = { targets: wanted };
    plan.count = wanted.length;
    plan.resultKeys = wanted.map(a => `${a.ranch_inst_id}:1:${a.animal_inst_id}`);
}

async function buildSteal(plan, input) {
    const hostGid = idOf(input.hostGid);
    if (!hostGid) throw errOf('INVALID_ARGUMENT', '请选择好友牧场');
    const detail = await api.getRanchDetail([], hostGid);
    const self = qty(api.selfGid());
    const targets = [];
    for (const ranch of detail.ranches || []) {
        for (const shelf of ranch.shelves || []) {
            if (!shelf.can_steal) continue;
            const lots = (shelf.lots || []).filter(lot => lot.can_steal
                && countOf(lot.remain_num) > 0n
                && !(lot.stealers || []).some(s => qty(s) === self));
            if (!lots.length) continue;
            targets.push({
                ranchId: qty(ranch.ranch_inst_id),
                slot: idOf(shelf.slot_index),
                itemIds: lots.map(l => qty(l.item_id)),
            });
        }
    }
    if (!targets.length) { plan.count = 0; return; }
    plan.payload = { host_gid: String(hostGid), targets: [] };
    plan.marker = { host: String(hostGid), targets };
    plan.count = targets.length;
}

async function buildStroke(plan, input) {
    const hostGid = idOf(input.hostGid);
    const ranchId = idOf(input.ranchId);
    const animalId = idOf(input.animalId);
    if (!hostGid || !ranchId || !animalId) throw errOf('INVALID_ARGUMENT', '请选择好友牧场');
    const detail = await api.getRanchDetail([ranchId], hostGid);
    const ranch = (detail.ranches || []).find(r => idOf(r.ranch_inst_id) === ranchId);
    const animal = ranch && (ranch.animals || []).find(a => idOf(a.animal_inst_id) === animalId);
    const self = qty(api.selfGid());
    const stroked = animal && animal.mutation
        && (animal.mutation.stroked_gids || []).some(g => qty(g) === self);
    if (!animal || !animal.mutation || !animal.mutation.strokable || stroked) {
        throw errOf('RANCH_STATE_CHANGED', '这只动物已抚摸或当前不能抚摸');
    }
    const times = await interactionTimes();
    if (times.stroke <= 0) throw errOf('RANCH_INTERACTION_LIMIT', '今日互动次数已用完');
    plan.payload = {
        host_gid: String(hostGid),
        target: { ranch_inst_id: String(ranchId), animal_inst_id: String(animalId) },
    };
    plan.marker = idOf(animal.animal_id);
    plan.remaining = times.stroke;
    plan.count = 1;
}

async function buildPutMosquito(plan, input) {
    const hostGid = idOf(input.hostGid);
    const ranchId = idOf(input.ranchId);
    if (!hostGid || !ranchId) throw errOf('INVALID_ARGUMENT', '请选择好友牧场');
    const detail = await api.getRanchDetail([ranchId], hostGid);
    const ranch = (detail.ranches || []).find(r => idOf(r.ranch_inst_id) === ranchId);
    if (!ranch) throw errOf('RANCH_STATE_CHANGED', '好友栏舍已变化，请刷新');
    const limit = idOf(ranch.husbandry_type) === 1 ? 3 : 3;
    const mosquitoes = (ranch.hazards || []).filter(h => idOf(h.hazard_type) === 1);
    if (mosquitoes.length >= limit) throw errOf('RANCH_HAZARD_FULL', `该栏舍已有 ${mosquitoes.length} 只蚊子`);
    const times = await interactionTimes();
    if (times.putMosquito <= 0) throw errOf('RANCH_INTERACTION_LIMIT', '今日互动次数已用完');
    plan.payload = {
        host_gid: String(hostGid),
        ranch_inst_id: String(ranchId),
        op_id: String(api.OP_PUT_MOSQUITO),
        count: '1',
    };
    plan.marker = { limit, hazards: mosquitoes.map(h => qty(h.hazard_id)) };
    plan.remaining = times.putMosquito;
    plan.count = 1;
}

async function buildCleanFriend(plan, input) {
    const hostGid = idOf(input.hostGid);
    if (!hostGid) throw errOf('INVALID_ARGUMENT', '请选择好友牧场');
    const detail = await api.getRanchDetail([], hostGid);
    const self = qty(api.selfGid());
    const pits = (detail.ranches || []).filter(r => (r.hazards || []).some(h =>
        idOf(h.hazard_type) !== 1 || qty(h.owner) !== self));
    if (!pits.length) { plan.count = 0; return; }
    const hazards = [];
    for (const ranch of pits) {
        for (const hazard of ranch.hazards || []) {
            if (idOf(hazard.hazard_type) === 1 && qty(hazard.owner) === self) continue;
            hazards.push(`${qty(ranch.ranch_inst_id)}:${qty(hazard.hazard_id)}`);
        }
    }
    plan.payload = { host_gid: String(hostGid), ranch_inst_ids: pits.map(r => qty(r.ranch_inst_id)) };
    plan.marker = { action: 'cleanFriend', payload: plan.payload, hazards };
    plan.count = hazards.length;
}

// ─── 查询辅助 ───

function findFacility(state, facilityId) {
    const list = (state.detail && state.detail.facilities) || [];
    return list.find(f => idOf(f.instance_id) === facilityId) || null;
}

function taskList(reply) {
    const info = (reply && reply.task_info) || {};
    const all = [...(info.growth_tasks || []), ...(info.daily_tasks || []), ...(info.tasks || [])];
    return all.map(t => ({
        id: t.id,
        progress: t.progress,
        total: t.total_progress,
        claimed: t.is_claimed,
        unlocked: t.is_unlocked,
        rewards: t.rewards || [],
        share_multiple: t.share_multiple,
        task_type: idOf(t.task_type),
        desc: t.desc,
        canClaim: !!t.is_unlocked && !t.is_claimed
            && countOf(t.total_progress) > 0n && countOf(t.progress) >= countOf(t.total_progress),
    }));
}

function isClientReportedTask(task) {
    // 目前只确认「好友」入口对应 id 300008 这类客户端上报任务
    return String(task.id) === '300008';
}

async function interactionTimes() {
    const reply = await api.getRanchOpTimes([]);
    const find = (opId) => {
        const row = (reply.ops || []).find(o => idOf(o.op_id) === opId);
        if (!row) throw errOf('RANCH_RESPONSE_MISMATCH', '牧场互动剩余次数未返回');
        const left = idOf(row.remaining_times);
        if (!Number.isSafeInteger(left) || left < 0) {
            throw errOf('RANCH_RESPONSE_MISMATCH', '牧场互动剩余次数无效');
        }
        return left;
    };
    return {
        stroke: find(api.OP_STROKE),
        putMosquito: find(api.OP_PUT_MOSQUITO),
        release: find(api.OP_RELEASE),
    };
}

module.exports = {
    ACTIONS,
    LABELS,
    EXPECTED_CODES,
    planAction,
    operate,
    loadRaw,
    allAnimals,
    allShelves,
    allHazards,
    balanceOf,
    availableOf,
    itemDto,
    sumItems,
    qty,
    signPlan,
    taskList,
};

// ─── 执行 ───

/**
 * 执行一个动作。
 * input.expected.signature 必须与重新报价的签名一致，否则拒绝（RANCH_OFFER_CHANGED）。
 */
async function operate(action, input = {}, options = {}) {
    const accountId = options.accountId || accountIdOf();

    // acknowledge 不需要进场景、不重新报价：它只清本地账本
    if (action === 'acknowledge') {
        operations.acknowledge(accountId, String(input.id || ''));
        return { status: 'confirmed', refreshRequired: true, costs: [], rewards: [] };
    }

    const raw = await loadRaw();
    const quote = await planAction(action, input, raw);
    if (quote.skipped) {
        return { status: 'skipped', snapshot: null, costs: [], rewards: [], message: quote.message };
    }
    if (input.expected && input.expected.signature !== quote.expected.signature) {
        throw errOf('RANCH_OFFER_CHANGED', '牧场状态、商品或费用已变化，请重新确认');
    }

    const plan = quote._plan;
    const target = `pasture:${action}:${input.goodsId || input.facilityId || input.uid || input.taskId || input.ranchId || input.hostGid || 'all'}`;

    if (operations.hasPendingTarget(accountId, target)) {
        throw errOf('PENDING_CONFIRMATION', '该操作的上次结果未知，请在牧场页面核对后解除保护');
    }

    const record = operations.addPending(accountId, {
        target,
        label: `${plan.label}${plan.count > 1 ? ` ×${plan.count}` : ''}`,
        costs: plan.costs,
    });

    let sent = 0;
    let first = null;
    try {
        // 写操作一律在牧场场景内执行：场景是全局状态，未进入时的栏舍/设施
        // 视图可能是农场场景的旧数据；离开时再切回原场景。
        // 已经在牧场场景里时 inRanchScene 是零成本的（直接就地执行）。
        const result = await inRanchScene(() => runWithPastureContext({
            onSent(service, method) {
                sent += 1;
                if (!first) first = { service, method };
            },
        }, () => dispatch(action, plan, input, options)));

        operations.acknowledge(accountId, record.id);
        return result;
    } catch (cause) {
        const rejected = sent === 0
            || (sent === 1 && cause && cause.name === 'GatewayError'
                && first && cause.methodName === first.method && cause.serviceName === first.service);
        if (rejected) {
            operations.acknowledge(accountId, record.id);
        } else {
            operations.updateMessage(accountId, record.id, String(cause && cause.message || cause).slice(0, 300));
            cause.outcomeUnknown = true;
        }
        throw cause;
    }
}

/** 真正发包 + 回包核对 */
async function dispatch(action, plan, input, options) {
    const unknown = (reason) => errOf('RANCH_RESULT_UNKNOWN',
        `${plan.label}结果未能确认：${reason}，请刷新核对，勿重复提交`);

    switch (action) {
        case 'harvest': {
            const reply = await api.harvestRanch({
                op: plan.payload.op,
                ranchIds: (plan.payload.ranch_inst_ids || []).map(Number),
                animals: (plan.payload.animals || []).map(a => ({
                    ranchInstId: idOf(a.ranch_inst_id), animalInstId: idOf(a.animal_inst_id),
                })),
            }, options);
            return finish(plan, reply, { unknown, action, input });
        }
        case 'produce': {
            const reply = await api.triggerProduce((plan.payload.targets || []).map(t => ({
                ranchInstId: idOf(t.ranch_inst_id), animalInstId: idOf(t.animal_inst_id),
            })), 0, options);
            return finish(plan, reply, { unknown, action, input });
        }
        case 'clean': {
            const hazards = allHazards(await loadRaw()).map(h => idOf(h.hazard.hazard_id));
            const reply = hazards.length
                ? await api.cleanRanch(hazards, 0, options)
                : await api.cleanAllRanch((plan.payload.ranch_inst_ids || []).map(Number), 0, options);
            return finish(plan, reply, { unknown, action, input });
        }
        case 'sell': {
            const reply = await api.sellItems(plan.payload.items, options);
            const sold = (reply.sell_items || []).map(i => `${qty(i.id)}:${qty(i.uid)}:${qty(i.count)}`).sort().join('|');
            const wanted = plan.payload.items.map(i => `${i.id}:${i.uid}:${i.count}`).sort().join('|');
            if (sold !== wanted) throw unknown('出售物品与请求不一致');
            return { status: 'confirmed', costs: [], rewards: itemEntries(reply.get_items), completed: plan.count };
        }
        case 'feed': {
            const reply = await api.feedAnimal((plan.payload.targets || []).map(t => ({
                ranchInstId: idOf(t.ranch_inst_id), animalInstId: idOf(t.animal_inst_id),
            })), plan.payload.bucket_type, options);
            const used = countOf(reply.deduct_secs);
            const cap = countOf((plan.costItems[0] || {}).count);
            if (used <= 0n || used > cap) throw unknown('罐头扣减时长与预期不符');
            return {
                status: 'confirmed',
                costs: [itemDto(plan.bucketId, used)],
                rewards: itemEntries(reply.op_results ? reply.op_results.flatMap(r => r.rewards || []) : []),
                completed: plan.count,
            };
        }
        case 'place': {
            const item = plan.payload.items[0];
            const reply = await api.placeAnimal(idOf(item.ranch_inst_id), idOf(item.animal_id), 0, options);
            if ((reply.op_results || []).length !== plan.count) throw unknown('放养数量不匹配');
            return finish(plan, reply, { unknown, action, input });
        }
        case 'addGrass': {
            const reply = await api.addFeed(idOf(plan.payload.instance_id), idOf(plan.payload.add_count), options);
            if (!reply.detail) throw unknown('牧草机状态未返回');
            return { status: 'confirmed', costs: plan.costItems, rewards: [], completed: 1 };
        }
        case 'useCan': {
            const item = plan.payload.item;
            const reply = await api.useItem({ id: idOf(item.id), uid: idOf(item.uid), count: idOf(item.count) }, options);
            if (!reply.item) throw unknown('罐头使用回执缺少物品');
            return { status: 'confirmed', costs: plan.costItems, rewards: itemEntries(reply.get_items), completed: 1 };
        }
        case 'buy': {
            const reply = await api.buyRanchGoods(
                idOf(plan.payload.goods_id),
                idOf(plan.payload.num),
                idOf(plan.payload.price),
                plan.payload.auto_add,
                options,
            );
            if (reply.goods && idOf(reply.goods.id) !== idOf(plan.payload.goods_id)) throw unknown('回包商品不符');
            return { status: 'confirmed', costs: plan.costItems, rewards: itemEntries(reply.get_items), completed: 1 };
        }
        case 'exchange': {
            const reply = await api.rotationBuyGoods(
                idOf(plan.payload.goods_id), idOf(plan.payload.count),
                idOf(plan.payload.period_day), idOf(plan.payload.round_index), options,
            );
            if (reply.card && idOf(reply.card.goods_id) !== idOf(plan.payload.goods_id)) {
                throw errOf('RANCH_OFFER_CHANGED', '集市场次已变化或已结束');
            }
            return { status: 'confirmed', costs: plan.costItems, rewards: itemEntries(reply.awards), completed: 1 };
        }
        case 'buyCan': {
            const reply = await api.purchaseCan(idOf(plan.payload.goods_id), idOf(plan.payload.count), options);
            if (!reply.success) throw unknown('罐头购买未成功');
            return { status: 'confirmed', costs: plan.costItems, rewards: [], completed: 1 };
        }
        case 'upgrade': {
            const reply = await api.upgradeBuilding(idOf(plan.payload.inst_id), options);
            if (!reply.upgrade || qty(reply.upgrade.inst_id) !== plan.payload.inst_id) throw unknown('升级回执不符');
            return { status: 'confirmed', costs: plan.costItems, rewards: [], completed: 1 };
        }
        case 'completeUpgrade': {
            const reply = await api.completeBuildingUpgrade(idOf(plan.payload.inst_id), options);
            if (!reply.facility || qty(reply.facility.instance_id) !== plan.payload.inst_id) {
                throw unknown('完成升级回执不符');
            }
            return { status: 'confirmed', costs: plan.costItems, rewards: [], completed: 1 };
        }
        case 'activateShed': {
            const reply = await api.activateFacility(idOf(plan.payload.instance_id), options);
            const shed = reply.facility;
            if (!shed || qty(shed.instance_id) !== plan.payload.instance_id
                || idOf(shed.module_type) !== 7 || idOf(shed.state) !== 1) {
                throw unknown('棚激活回执不符');
            }
            return { status: 'confirmed', costs: [], rewards: [], completed: 1 };
        }
        case 'claimTasks': {
            const rewards = [];
            const allOrdinary = plan.marker.every(t => t.multiple === 1);
            if (plan.marker.length > 1 && allOrdinary) {
                const reply = await api.claimRanchTasks(plan.marker.map(t => idOf(t.id)), false, options);
                rewards.push(...(reply.items || []));
            } else {
                for (const task of plan.marker) {
                    if (task.multiple > 1) {
                        await api.reportShare(103, [idOf(task.id)], 2104, options);
                    }
                    const reply = await api.claimRanchTask(idOf(task.id), task.multiple > 1, options);
                    rewards.push(...(reply.items || []));
                }
            }
            return { status: 'confirmed', costs: [], rewards: itemEntries(rewards), completed: plan.count };
        }
        case 'reportEntry': {
            for (const row of plan.payload) {
                await api.reportRanchTaskProgress(idOf(row.task_id), idOf(row.progress), options);
            }
            return { status: 'confirmed', costs: [], rewards: [], completed: plan.count };
        }
        case 'claimIllustrated': {
            if (plan.marker.kind === 'normal') {
                const reply = await api.claimIllustratedRewards(101, options);
                if (!(reply.claimed_level_ids || []).length) throw unknown('图鉴奖励回包未能确认');
                return { status: 'confirmed', costs: [], rewards: itemEntries(reply.total_rewards), completed: 1 };
            }
            const rewards = [];
            for (const level of plan.levels || []) {
                const reply = await api.claimRanchWeightScoreReward(idOf(level.id), options);
                if (!(reply.claimed_ids || []).some(id => idOf(id) === idOf(level.id))) {
                    throw unknown('巨大图鉴奖励回包未能确认');
                }
                rewards.push(...(reply.rewards || []));
            }
            return { status: 'confirmed', costs: [], rewards: itemEntries(rewards), completed: plan.count };
        }
        case 'claimDailyShare': {
            await api.reportShare(102, [], 2101, options);
            const reply = await api.claimShareReward(102, options);
            if (!(reply.rewards || []).length) throw unknown('每日分享奖励回包未能确认');
            return { status: 'confirmed', costs: [], rewards: itemEntries(reply.rewards), completed: 1 };
        }
        case 'release': {
            const reply = await api.donateAnimal((plan.payload.targets || []).map(t => ({
                ranchInstId: idOf(t.ranch_inst_id), animalInstId: idOf(t.animal_inst_id),
            })), options);
            if ((reply.op_results || []).length !== plan.count) throw unknown('放生数量不匹配');
            return { status: 'confirmed', costs: [], rewards: itemEntries((reply.op_results || []).flatMap(r => r.rewards || [])), completed: plan.count };
        }
        case 'steal': {
            const reply = await api.stealProduce(idOf(plan.payload.host_gid), [], options);
            return { status: 'confirmed', costs: [], rewards: itemEntries((reply.op_results || []).flatMap(r => r.rewards || [])), completed: (reply.op_results || []).length };
        }
        case 'stroke': {
            const reply = await api.strokeAnimal(
                idOf(plan.payload.target.animal_inst_id), idOf(plan.payload.target.ranch_inst_id),
                idOf(plan.payload.host_gid), options,
            );
            const result = reply.op_result;
            if (!result || idOf(result.kind) !== 1) throw unknown('抚摸回包未能确认');
            return { status: 'confirmed', costs: [], rewards: itemEntries(result.rewards), completed: 1 };
        }
        case 'putMosquito': {
            const reply = await api.putHazard(
                idOf(plan.payload.ranch_inst_id), idOf(plan.payload.host_gid), 1, options,
            );
            if (qty(reply.actual_count) !== '1') throw unknown('放蚊子回包未能确认');
            return { status: 'confirmed', costs: [], rewards: itemEntries(reply.rewards), completed: 1 };
        }
        case 'cleanFriend': {
            const reply = await api.cleanAllRanch((plan.payload.ranch_inst_ids || []).map(Number), idOf(plan.payload.host_gid), options);
            return { status: 'confirmed', costs: [], rewards: itemEntries((reply.op_results || []).flatMap(r => r.rewards || [])), completed: (reply.op_results || []).length };
        }
        default:
            throw errOf('INVALID_ARGUMENT', '不支持的牧场操作');
    }
}

/** harvest / produce / clean / place 共用：校验 op_results 目标集合 */
function finish(plan, reply, { unknown, action, input }) {
    const rows = reply.op_results || [];
    const rewards = rows.flatMap(r => r.rewards || []);
    if (plan.resultKeys) {
        const keys = rows.map(r => `${qty(r.facility_inst_id)}:${idOf(r.kind)}:${qty(r.target_id)}`);
        if (new Set(keys).size !== keys.length) throw unknown('回包包含重复目标');
        for (const key of keys) {
            if (plan.resultKeys.includes(key)) continue;
            const [, kind, targetId] = key.split(':');
            // 一键操作放宽：读取之后才成熟/新冒出来的目标仍算合理
            if (action === 'clean' && kind === '3' && Number(targetId) > 0) continue;
            if (input.all === true && (action === 'harvest' || action === 'produce') && kind === '1') continue;
            throw unknown('回包目标超出本次操作范围');
        }
    }
    return {
        status: 'confirmed',
        costs: plan.costItems,
        rewards: itemEntries(rewards),
        completed: rows.length || plan.count,
    };
}