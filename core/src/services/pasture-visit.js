/**
 * 好友牧场：偷产物
 *
 * 与 friend-visit.js 的区别：牧场偷产物**不需要 Enter/Leave 门票**——
 * StealProduce 直接用 host_gid 指名，比农场偷菜轻得多，一次请求就完事。
 * 因此这里不做「进入好友农场」那一套，只做：
 *   拉好友列表 → 逐个 GetRanchDetail(host_gid) → 有可偷货架就 StealProduce。
 *
 * 默认关闭（pasture_steal=false）：这是新功能，而且会给好友列表里的
 * 每个人多发一次请求，预算要先让农场和自家牧场。
 */

const { getUserState, isConnected } = require('../utils/network');
const { toNum, log, logWarn } = require('../utils/utils');
const { isAutomationOn } = require('../models/store');
const { recordEvent } = require('./daily-events');
const { getRanchDetail, stealProduce } = require('./pasture-api');
const { analyzeRanches } = require('./pasture-analyzer');
const { getAllFriends } = require('./friend-api');

/** 单轮最多检查多少个好友（预算护栏，避免一次拉满） */
const MAX_FRIENDS_PER_ROUND = 5;
/** 两轮之间的最小间隔 */
const FRIEND_STEAL_COOLDOWN_MS = 5 * 60_000;

let lastRunAtMs = 0;
let running = false;

function isTransientNetworkError(err) {
    const msg = String((err && err.message) || '');
    if (!msg) return false;
    return ['连接未打开', '请求超时', '请求已中断', '连接关闭', '发送失败', '请求队列已满']
        .some(text => msg.includes(text));
}

/** 从好友列表回包里取出 [{gid, name}]，兼容几种常见字段形态 */
function pickFriends(reply) {
    const raw = (reply && (reply.friends || reply.game_friends || reply.items)) || [];
    const out = [];
    for (const item of raw) {
        const gid = toNum(item && (item.gid || item.target_gid || item.id));
        if (!gid) continue;
        out.push({ gid, name: String((item && (item.name || item.remark)) || '') });
    }
    return out;
}

/**
 * 跑一轮好友牧场偷产物。
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.maxFriends]
 * @returns {Promise<{stolen:number, checked:number, skipped:boolean}>} stolen=偷到的好友数，
 *   checked=检查过的好友数，skipped=是否因开关/冷却/断线而整轮跳过
 */
async function checkFriendPastures(options = {}) {
    const now = Number(options.now) || Date.now();
    const empty = { stolen: 0, checked: 0, skipped: true };

    const userState = getUserState();
    if (running || !userState.gid || !isConnected()) return empty;
    if (!isAutomationOn('pasture') || !isAutomationOn('pasture_steal')) return empty;
    if (now - lastRunAtMs < FRIEND_STEAL_COOLDOWN_MS) return empty;

    running = true;
    lastRunAtMs = now;
    let stolen = 0;
    let checked = 0;

    try {
        const reply = await getAllFriends();
        const friends = pickFriends(reply)
            .filter(f => f.gid !== toNum(userState.gid))
            .slice(0, Number(options.maxFriends) || MAX_FRIENDS_PER_ROUND);

        for (const friend of friends) {
            checked += 1;
            let detail;
            try {
                detail = await getRanchDetail([], friend.gid);
            } catch (err) {
                if (!isTransientNetworkError(err)) {
                    logWarn('牧场', `读取好友 ${friend.gid} 牧场失败: ${err.message}`);
                }
                continue;
            }
            const analysis = analyzeRanches((detail && detail.ranches) || [], { now });
            if (!analysis.stealableShelves.length) continue;

            try {
                await stealProduce(friend.gid);
                stolen += 1;
                log('牧场', `偷取好友 ${friend.name || friend.gid} 的产物`, {
                    module: 'pasture',
                    event: '牧场偷取',
                    gid: friend.gid,
                });
            } catch (err) {
                if (!isTransientNetworkError(err)) {
                    logWarn('牧场', `偷取好友 ${friend.gid} 失败: ${err.message}`);
                }
            }
        }

        if (stolen > 0) {
            recordEvent(userState.accountId, 'info', 'pasture', `牧场偷取 ${stolen} 位好友的产物`);
        }
    } catch (err) {
        if (!isTransientNetworkError(err)) {
            logWarn('牧场', `好友牧场巡查失败: ${err.message}`);
        }
    } finally {
        running = false;
    }

    return { stolen, checked, skipped: false };
}

function resetFriendPastureStateForTests() {
    lastRunAtMs = 0;
    running = false;
}

module.exports = {
    checkFriendPastures,
    resetFriendPastureStateForTests,
    MAX_FRIENDS_PER_ROUND,
    FRIEND_STEAL_COOLDOWN_MS,
    pickFriends,
};