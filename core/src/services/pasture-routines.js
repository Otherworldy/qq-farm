/**
 * 牧场例程：把「除日常养殖之外」的能力接进自动化。
 *
 * 每一类都走 pasture-actions 的 planAction/operate，因此统一获得：
 *   - 报价与费用校验（余额不足不会发请求）
 *   - 结果未知写盘（断线后不重发）
 *   - 回包逐项核对（op_results 目标集合、奖励结构）
 *
 * 这里只负责「什么时候做、一次做多少、多久重试」，不做协议细节。
 */

const { toNum, log } = require('../utils/utils');
const { getAutomation, isAutomationOn } = require('../models/store');
const actions = require('./pasture-actions');
const api = require('./pasture-api');
const { recordEvent } = require('./daily-events');
const { getUserState } = require('../utils/network');

// ─── 集市兑换配置 ───

/** 货币 → 目标奖励优先级 */
const MARKET_EXCHANGES = [
    { key: 'pasture_market_poop', currencyId: 7002, rewards: [80012, 80011], minBalance: 3n },
    { key: 'pasture_market_pinecone', currencyId: 1008, rewards: [80013, 80012, 80011], minBalance: 1n },
];

/** 设施模块类型：6 可升级建筑 / 7 牧场棚 / 8 牧草机 */
const MODULE_UPGRADABLE = 6;
const MODULE_SHED = 7;

/** 重试间隔 */
const RETRY_MS = 10 * 60_000;

/** 2026-11-20 起按北京时间的日切 */
function gameDateKey(now = Date.now()) {
    const d = new Date(now + 8 * 3600_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function logPasture(message, extra) {
    log('牧场', message, { module: 'pasture', ...(extra || {}) });
}

function noteEvent(level, message) {
    try {
        recordEvent(getUserState().accountId, level, 'pasture', message);
    } catch { /* 事件流水失败不影响业务 */ }
}

/** 预期失败不当作故障，直接跳过本步 */
function isExpectedError(err) {
    return !!(err && actions.EXPECTED_CODES.has(err.code));
}

function isUnknownOutcome(err) {
    return !!(err && (err.outcomeUnknown === true
        || err.code === 'RANCH_RESULT_UNKNOWN' || err.code === 'PENDING_CONFIRMATION'));
}

// ─── 每日例程状态（内存，跨日作废） ───

const daily = {
    dateKey: '',
    share: { done: false, nextAt: 0, result: '' },
    benefit: { done: false, nextAt: 0, result: '' },
};

/**
 * 「今天已经领过了」这类业务码。
 *
 * 服务端会明确拒绝重复领取（分享：1009001，商城限购：1031003），
 * 把它们当普通失败重试，等于每轮都白发一次注定失败的请求，
 * 还会把「已经领过」写成红色失败日志。识别出来后按完成处理。
 */
const ALREADY_DONE_CODES = new Set([1009001, 1009002, 1031003]);

function isAlreadyDoneError(err) {
    const code = Number(err && (err.code || err.serverErrorCode));
    return ALREADY_DONE_CODES.has(code);
}

function today() {
    const key = gameDateKey();
    if (daily.dateKey !== key) {
        daily.dateKey = key;
        daily.share = { done: false, nextAt: 0, result: '' };
        daily.benefit = { done: false, nextAt: 0, result: '' };
    }
    return daily;
}

/** 供调度器判断「还有没有到点的每日例程」 */
function hasPendingDailyWork() {
    const state = today();
    const now = Date.now();
    const auto = getAutomation();
    if (auto.pasture_share && !state.share.done && now >= state.share.nextAt) return true;
    if (auto.pasture_daily_benefit && !state.benefit.done && now >= state.benefit.nextAt) return true;
    return false;
}

// ─── 集市兑换 ───

/**
 * 集市兑换。按「货币余额有增量」判断是否到账，避免每轮都空跑一次市场接口。
 */
async function runMarketExchange() {
    const auto = getAutomation();
    const enabled = MARKET_EXCHANGES.filter(e => auto[e.key]);
    if (!enabled.length) return 0;

    let rotation;
    try {
        rotation = await api.getRotationShopInfo();
    } catch {
        return 0;
    }
    if (!rotation.opened || !rotation.present) return 0;

    const raw = await actions.loadRaw();
    let done = 0;
    for (const exchange of enabled) {
        const left = actions.availableOf(raw, exchange.currencyId);
        if (left < exchange.minBalance) continue;
        const goods = (rotation.goods || [])
            .filter(g => toNum(g.cost_item_id) === exchange.currencyId
                && toNum(g.cost_count) > 0
                && exchange.rewards.includes(toNum(g.item_id)))
            .sort((a, b) => exchange.rewards.indexOf(toNum(a.item_id)) - exchange.rewards.indexOf(toNum(b.item_id)));
        for (const good of goods) {
            const limitLeft = toNum(good.limit_count) > 0
                ? toNum(good.limit_count) - toNum(good.limit_used) : 1;
            if (limitLeft <= 0) continue;
            const unit = BigInt(toNum(good.cost_count));
            const affordable = left / unit;
            const count = Number(affordable < BigInt(limitLeft) ? affordable : BigInt(limitLeft));
            if (count <= 0) break;
            try {
                const quote = await actions.planAction('exchange', {
                    goodsId: toNum(good.goods_id), count,
                }, raw);
                if (quote.skipped) break;
                await actions.operate('exchange', { goodsId: toNum(good.goods_id), count, expected: quote.expected });
                done += count;
                logPasture(`集市兑换 ${count} 份`, { event: '牧场集市', goodsId: toNum(good.goods_id), count });
            } catch (err) {
                if (isExpectedError(err) || isUnknownOutcome(err)) {
                    logPasture(`集市兑换跳过：${err.message}`, { event: '牧场集市跳过' });
                    break;
                }
                throw err;
            }
        }
    }
    if (done) noteEvent('info', `牧场集市兑换 ${done} 份`);
    return done;
}

// ─── 设施：棚激活 / 升级 / 完成升级 ───

/**
 * 设施维护。三件事共用 `pasture_upgrade` 开关：
 *   1. state=3 的棚 → ActivateFacility
 *   2. 有升级目标且条件满足 → UpgradeBuilding（费用来自 GetFacilityDetail 实时报价）
 *   3. upgrade_state != 0 且已到期 → CompleteBuildingUpgrade
 */
async function runFacilityUpgrade() {
    if (!isAutomationOn('pasture_upgrade')) return 0;
    const raw = await actions.loadRaw();
    const facilities = (raw.detail && raw.detail.facilities) || [];
    const nowMs = Date.now();
    let done = 0;

    for (const facility of facilities) {
        const instanceId = toNum(facility.instance_id);
        const moduleType = toNum(facility.module_type);
        const upgradeState = toNum(facility.upgrade_state);
        const endRaw = toNum(facility.upgrade_end_time);
        const endMs = endRaw > 0 && endRaw < 100_000_000_000 ? endRaw * 1000 : endRaw;

        try {
            // 1) 棚待激活
            if (moduleType === MODULE_SHED && toNum(facility.state) === 3) {
                const quote = await actions.planAction('activateShed', { facilityId: instanceId }, raw);
                if (!quote.skipped) {
                    await actions.operate('activateShed', { facilityId: instanceId, expected: quote.expected });
                    done += 1;
                    logPasture(`激活牧场棚 ${instanceId}`, { event: '牧场设施', action: 'activateShed' });
                }
                continue;
            }

            // 2) 升级中且已到期 → 完成
            if (upgradeState === 2 || (upgradeState !== 0 && endMs > 0 && endMs <= nowMs)) {
                const quote = await actions.planAction('completeUpgrade', { facilityId: instanceId }, raw);
                if (!quote.skipped) {
                    await actions.operate('completeUpgrade', { facilityId: instanceId, expected: quote.expected });
                    done += 1;
                    logPasture(`完成设施升级 ${instanceId}`, { event: '牧场设施', action: 'completeUpgrade' });
                }
                continue;
            }

            // 3) 可升级 → 升级
            if (moduleType !== MODULE_UPGRADABLE && moduleType !== MODULE_SHED) continue;
            if (toNum(facility.state) !== 1 || upgradeState !== 0) continue;
            const quote = await actions.planAction('upgrade', { facilityId: instanceId }, raw);
            if (quote.skipped) continue;
            await actions.operate('upgrade', { facilityId: instanceId, expected: quote.expected });
            done += 1;
            logPasture(`升级设施 ${instanceId}`, { event: '牧场设施', action: 'upgrade' });
        } catch (err) {
            if (isExpectedError(err) || isUnknownOutcome(err)) {
                logPasture(`设施维护跳过：${err.message}`, { event: '牧场设施跳过', instanceId });
                continue;
            }
            throw err;
        }
    }
    return done;
}

// ─── 罐头：填桶 + 分桶喂养 ───

/**
 * 把背包里的罐头搬进桶里。Use 不消耗物品，只是转移，所以默认也安全。
 */
async function runFillCans() {
    if (!isAutomationOn('pasture_fill_cans')) return 0;
    const raw = await actions.loadRaw();
    const cans = ((raw.bag && raw.bag.physical_items) || []).filter(item => {
        const id = toNum(item.id);
        return (id === api.BUCKET_NORMAL || id === api.BUCKET_ORGANIC) && !item.is_locked;
    });
    let done = 0;
    for (const item of cans) {
        try {
            const quote = await actions.planAction('useCan', { uid: toNum(item.uid), count: toNum(item.count) }, raw);
            if (quote.skipped) continue;
            await actions.operate('useCan', { uid: toNum(item.uid), count: toNum(item.count), expected: quote.expected });
            done += 1;
        } catch (err) {
            if (isExpectedError(err) || isUnknownOutcome(err)) continue;
            throw err;
        }
    }
    if (done) logPasture(`罐头入桶 ${done} 次`, { event: '牧场罐头' });
    return done;
}

/**
 * 分桶喂养。普通桶优先（更便宜），有机桶只在显式开启时用。
 */
async function runFeedBuckets() {
    const auto = getAutomation();
    let done = 0;
    const buckets = [];
    if (auto.pasture_feed_normal) buckets.push(2);
    if (auto.pasture_feed_organic) buckets.push(1);
    if (!buckets.length) return 0;

    for (const bucketType of buckets) {
        const raw = await actions.loadRaw();
        const bucketId = bucketType === 1 ? api.BUCKET_ORGANIC : api.BUCKET_NORMAL;
        if (actions.balanceOf(raw.bag, bucketId).total <= 0n) continue;
        try {
            const quote = await actions.planAction('feed', { all: true, bucketType }, raw);
            if (quote.skipped) continue;
            await actions.operate('feed', { all: true, bucketType, expected: quote.expected });
            done += quote.count;
            logPasture(`罐头喂养 ${quote.count} 只（${bucketType === 1 ? '有机' : '普通'}桶）`, {
                event: '牧场喂养', bucketType,
            });
        } catch (err) {
            if (isExpectedError(err) || isUnknownOutcome(err)) continue;
            throw err;
        }
    }
    if (done) noteEvent('info', `牧场罐头喂养 ${done} 只动物`);
    return done;
}

// ─── 图鉴 ───

async function runClaimIllustrated() {
    if (!isAutomationOn('pasture_illustrated')) return 0;
    let done = 0;
    for (const kind of ['normal', 'giant']) {
        try {
            const quote = await actions.planAction('claimIllustrated', { kind });
            if (quote.skipped) continue;
            await actions.operate('claimIllustrated', { kind, expected: quote.expected });
            done += 1;
            logPasture(`领取图鉴奖励（${kind === 'giant' ? '巨大' : '普通'}）`, { event: '牧场图鉴', kind });
        } catch (err) {
            if (isExpectedError(err) || isUnknownOutcome(err)) continue;
            throw err;
        }
    }
    return done;
}

// ─── 每日分享 / 每日福利 ───

async function runDailyShare() {
    if (!isAutomationOn('pasture_share')) return 0;
    const state = today();
    if (state.share.done || Date.now() < state.share.nextAt) return 0;
    try {
        const quote = await actions.planAction('claimDailyShare', {});
        if (quote.skipped) {
            state.share.done = true;
            state.share.result = 'already_claimed';
            return 0;
        }
        await actions.operate('claimDailyShare', { expected: quote.expected });
        state.share.done = true;
        state.share.result = 'ok';
        logPasture('每日首次分享礼包已领取', { event: '牧场每日分享' });
        return 1;
    } catch (err) {
        if (isAlreadyDoneError(err)) {
            state.share.done = true;
            state.share.result = 'already_claimed';
            return 0;
        }
        if (isUnknownOutcome(err)) {
            state.share.done = true;
            state.share.result = 'error';
            return 0;
        }
        state.share.nextAt = Date.now() + RETRY_MS;
        state.share.result = 'error';
        logPasture(`每日分享失败：${err.message}`, { event: '牧场每日分享' });
        return 0;
    }
}

/**
 * 罐头商城的每日免费商品（goods_id 2001，限购 1 次/日）。
 */
async function runDailyBenefit() {
    if (!isAutomationOn('pasture_daily_benefit')) return 0;
    const state = today();
    if (state.benefit.done || Date.now() < state.benefit.nextAt) return 0;
    const GOODS_ID = 2001;
    try {
        const list = await api.getCanMallList(6);
        const good = (list.goods || []).find(g => toNum(g.goods_id) === GOODS_ID);
        if (!good) {
            state.benefit.done = true;
            state.benefit.result = 'unavailable';
            return 0;
        }
        const limitType = good.limit ? toNum(good.limit.limit_type) : 0;
        const bought = good.limit ? toNum(good.limit.bought_count) : 0;
        const limit = good.limit ? toNum(good.limit.limit_count) : 0;
        if (limitType === 1 && limit === 1 && bought >= 1) {
            state.benefit.done = true;
            state.benefit.result = 'already_claimed';
            return 0;
        }
        if (!good.is_free) {
            state.benefit.done = true;
            state.benefit.result = 'unavailable';
            return 0;
        }
        const quote = await actions.planAction('buyCan', { goodsId: GOODS_ID, count: 1, slotType: 6 });
        if (quote.skipped) return 0;
        await actions.operate('buyCan', { goodsId: GOODS_ID, count: 1, slotType: 6, expected: quote.expected });
        state.benefit.done = true;
        state.benefit.result = 'ok';
        logPasture('每日商城福利已领取', { event: '牧场每日福利' });
        return 1;
    } catch (err) {
        if (isAlreadyDoneError(err)) {
            state.benefit.done = true;
            state.benefit.result = 'already_claimed';
            return 0;
        }
        if (isUnknownOutcome(err)) {
            state.benefit.done = true;
            state.benefit.result = 'error';
            return 0;
        }
        state.benefit.nextAt = Date.now() + RETRY_MS;
        state.benefit.result = 'error';
        logPasture(`每日福利失败：${err.message}`, { event: '牧场每日福利' });
        return 0;
    }
}

// ─── 好友互动（放蚊 / 帮清理） ───

/** 单个好友牧场互动配额上限（与农场共用每日 11003 配额） */
const MAX_FRIENDS_PER_ROUND = 3;

/**
 * 好友牧场互动：放蚊子 + 帮忙清理。
 * 只做「对好友有好处 / 自己拿配额奖励」的动作，不在这里偷产物（偷在 pasture-visit）。
 */
async function runFriendInteraction(friends) {
    const auto = getAutomation();
    const wantMosquito = !!auto.pasture_friend_mosquito;
    const wantClean = !!auto.pasture_friend_clean;
    if (!wantMosquito && !wantClean) return 0;
    if (!Array.isArray(friends) || !friends.length) return 0;

    let done = 0;
    let visited = 0;
    for (const friend of friends) {
        if (visited >= MAX_FRIENDS_PER_ROUND) break;
        if (done >= MAX_FRIENDS_PER_ROUND * 2) break;
        visited += 1;
        let detail;
        try {
            detail = await api.getRanchDetail([], friend.gid);
        } catch {
            continue;
        }
        for (const ranch of detail.ranches || []) {
            const ranchId = toNum(ranch.ranch_inst_id);
            if (wantClean) {
                try {
                    const quote = await actions.planAction('cleanFriend', { hostGid: friend.gid });
                    if (!quote.skipped) {
                        await actions.operate('cleanFriend', { hostGid: friend.gid, expected: quote.expected });
                        done += 1;
                        break;
                    }
                } catch (err) {
                    if (!isExpectedError(err) && !isUnknownOutcome(err)) throw err;
                }
            }
            if (wantMosquito) {
                try {
                    const quote = await actions.planAction('putMosquito', { hostGid: friend.gid, ranchId });
                    if (!quote.skipped) {
                        await actions.operate('putMosquito', {
                            hostGid: friend.gid, ranchId, expected: quote.expected,
                        });
                        done += 1;
                    }
                } catch (err) {
                    if (!isExpectedError(err) && !isUnknownOutcome(err)) throw err;
                }
            }
        }
    }
    if (done) noteEvent('info', `牧场好友互动 ${done} 次`);
    return done;
}

/** 测试用：清掉每日例程状态 */
function resetRoutineForTests() {
    daily.dateKey = '';
    daily.share = { done: false, nextAt: 0, result: '' };
    daily.benefit = { done: false, nextAt: 0, result: '' };
}

module.exports = {
    MARKET_EXCHANGES,
    MAX_FRIENDS_PER_ROUND,
    gameDateKey,
    hasPendingDailyWork,
    runMarketExchange,
    runFacilityUpgrade,
    runFillCans,
    runFeedBuckets,
    runClaimIllustrated,
    runDailyShare,
    runDailyBenefit,
    runFriendInteraction,
    resetRoutineForTests,
};