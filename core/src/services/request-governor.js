/**
 * 请求治理：画像 + 硬预算 + 异常降速（防封号通信层护栏）
 *
 * sendMsgAsync 是所有游戏 RPC 的唯一出口，这里统一过闸：
 * - 画像：按 service.method 计数（成功/失败），喂每日安全巡检
 * - 硬预算：滑动 60s 窗口总请求/单接口上限，超限丢弃非白名单请求
 * - 异常降速：短窗内错误过多 → 通知调度器放慢普通巡查，不冻结成熟抢收
 * 纯保守护栏，不做任何协议层伪装。
 */

const WINDOW_MS = 60 * 1000;
// 预算基准来自官方客户端实测，不再是「撞到就调高」拍出来的数字。
//
// 用 core/scripts/analyze-har-rate.js 分析一份官方客户端 HAR（Windows 微信
// 小游戏 1.17.0.3_20261117，正常游玩 160 秒），游戏 WebSocket 的实数是：
//
//   启动 30s 内   123 次 = 246 次/分钟
//   30s 后稳态    246 次 = 113 次/分钟
//   60s 窗口峰值  278 次
//   单接口峰值    PutWeeds 55、PutInsects 45、GetGameFriends 20、
//                 Enter/Leave 各 16、GetRanchDetail 9
//
// 也就是说官方自己就能在一分钟内发出 278 个请求，且账号没有任何异常。
// 所以护栏的上限只要不显著超过这个量级就是安全的；反过来，把上限压到
// 官方稳态（113）以下会拦掉我们自己的正常业务。
//
// 取值：总量 200 = 官方稳态的 1.8 倍、官方峰值的 72%；
//       单接口 55 = 官方实测最高单接口峰值。
//
// 历史沿革（都是没有基准时拍的，保留只为说明为什么现在不这么干）：
//   40/15 → 80/30 → 110/30 → 120/36 → 140/36 → 160/48 → 200/55
const TOTAL_LIMIT = Number(process.env.FARM_REQUEST_LIMIT_60S) || 200;
const PER_METHOD_LIMIT = Number(process.env.FARM_REQUEST_METHOD_LIMIT_60S) || 55;

/**
 * 单接口限额（按官方实测基准，见 core/docs/request-governor-baseline.md）。
 *
 * 用一个统一的 55 会让好友巡查三件套同时吃满 55 + 55 + 55 = 165，把总预算 200
 * 的八成占掉 —— 农场的 AllLands / TaskInfo 和牧场的 GetRanchDetail 就全被
 * `budget_total` / `budget_method` 拒掉，表现出来是施肥跳过、任务检查失败、
 * 牧场详情读不到。
 *
 * 官方客户端自己不是这么发的：GetGameFriends 只有 20/60s、Enter/Leave 各
 * 16/60s，真正高频的是除草除虫（PutWeeds 55 是全场最高峰值）。所以只把
 * 好友巡查压回官方量级，其余接口仍按 55 的通用上限。
 */
const METHOD_LIMITS = new Map([
    ['gamepb.friendpb.FriendService.GetAll', 20],
    ['gamepb.visitpb.VisitService.Enter', 16],
    ['gamepb.visitpb.VisitService.Leave', 16],
]);

/** 该接口的基础限额：优先按方法表，否则用通用单接口上限。 */
function methodLimitBase(key) {
    return METHOD_LIMITS.get(key) || PER_METHOD_LIMIT;
}
// 白名单：防封兜底与核心链路的关键请求不受预算限制（仍计入画像）
// AntiData 是官方客户端固定节奏的 ACE 风控上报；心跳是 userpb.UserService.Heartbeat
const WHITELIST = new Set([
    'gamepb.userpb.UserService.Heartbeat',
    'gamepb.gatepb.GateService.Login',
    'gamepb.acepb.AceService.AntiData',
]);
// 施肥 HOT / 成熟竞速涉及的接口。它们仍计入请求画像，并沿用既有频率门控
// （Harvest/Steal 的核心链白名单不变）；但短窗口内“别人先偷了/重复离场/
// 状态刚变化”等预期失败不能累计成整号异常降速。
const WATCHMODE_METHODS = new Set([
    'gamepb.visitpb.VisitService.Enter',
    'gamepb.plantpb.PlantService.AllLands',
]);
const WATCH_FAILURE_EXEMPT_METHODS = new Set([
    ...WATCHMODE_METHODS,
    'gamepb.visitpb.VisitService.Leave',
    'gamepb.plantpb.PlantService.CheckCanOperate',
    'gamepb.plantpb.PlantService.Harvest',
]);
// 成熟抢收紧急窗口内放行的完整偷菜链路请求。
const URGENT_METHODS = new Set([...WATCH_FAILURE_EXEMPT_METHODS]);
// 施肥 HOT 窗口内放宽倍数：目标接口单项 ×3、总量 ×1.5，仍兜底异常风暴。
const WATCHMODE_BOOST = Number(process.env.FARM_WATCHMODE_BOOST) || 3;
// 施肥 HOT 到期时刻；0 = 无窗口。只有 fertilizer-watch 确认施肥趋势后设置。
let watchModeUntil = 0;
// 成熟/偷菜竞争只豁免预期业务失败，不放宽 Enter/AllLands 门限。
let contentionModeUntil = 0;
// 成熟抢收紧急窗口（哨兵/预进门到点链路）：窗口内偷菜快路径的目标请求
// （Enter/Leave/CheckCanOperate/Harvest）不受 60s 硬预算拦截——参考同类项目
// 的 bypassRateLimit 紧急通道。仍计入请求画像（recordSent 正常登记），只是
// 不被预算丢弃；窗口极短（秒级），不会演变成请求风暴。
let urgentModeUntil = 0;

/** 进入/退出成熟抢收紧急窗口（哨兵到点前后、PREARM 预进门链路调用） */
function setUrgentMode(active, untilMs = 0) {
    urgentModeUntil = active ? Math.max(urgentModeUntil, Number(untilMs) || 0) : 0;
}

function urgentModeActive(now = Date.now()) {
    return now < urgentModeUntil;
}

/** 进入/退出施肥 HOT 窗口（确认出现施肥趋势后调用） */
function setWatchMode(active, untilMs = 0) {
    watchModeUntil = active ? Math.max(watchModeUntil, Number(untilMs) || 0) : 0;
}

function watchModeActive(now = Date.now()) {
    return now < watchModeUntil;
}

/** 成熟竞速宽限：仅隔离预期业务失败，不提高请求频率。 */
function setContentionMode(active, untilMs = 0) {
    contentionModeUntil = active
        ? Math.max(contentionModeUntil, Number(untilMs) || 0)
        : 0;
}

function contentionModeActive(now = Date.now()) {
    return now < contentionModeUntil;
}
// 偷菜相关（放行：错过成熟窗口的代价是核心收益，且总量天然有限）
const STEAL_WHITELIST_RE = /Harvest|Steal/;
// 异常降速：15 分钟窗口内 ≥12 次失败 → 普通巡查降速 5-10 分钟。
// 不再整号熔断；自己收获、好友到点抢收、施肥 HOT 和心跳继续按各自护栏运行。
const BREAKER_ERR_LIMIT = Number(process.env.FARM_BREAKER_ERR_LIMIT) || 12;
const BREAKER_WINDOW_MS = 15 * 60 * 1000;
const SLOWDOWN_MIN_MS = 5 * 60 * 1000;
const SLOWDOWN_MAX_MS = 10 * 60 * 1000;
const SLOWDOWN_RECOMMENDED_DELAY_MS = 90 * 1000;

const windowEvents = [];   // { at, key, ok }
const errEvents = [];      // { at, key }
let slowdownUntil = 0;
let slowdownCount = 0;
let droppedTotal = 0;

// 预算拦截诊断：拦截本身只带被拒的方法名，看不出窗口里真正是谁占满了额度。
// 每 60s 最多输出一条窗口占用快照，才能定位是巡田/任务/施肥/面板哪条链路在挤压预算。
const DROP_SNAPSHOT_INTERVAL_MS = 60 * 1000;
let lastDropSnapshotAt = 0;
let dropsSinceSnapshot = 0;

function pruneWindow(now) {
    while (windowEvents.length && now - windowEvents[0].at > WINDOW_MS) windowEvents.shift();
    while (errEvents.length && now - errEvents[0].at > BREAKER_WINDOW_MS) errEvents.shift();
}

function methodKey(serviceName, methodName) {
    return `${String(serviceName || '')}.${String(methodName || '')}`;
}

/**
 * 发送前过闸。返回 { allowed, reason }。
 * allowed=false 时调用方应静默跳过（返回错误让既有 catch 路径处理）。
 */
function checkRequest(serviceName, methodName, now = Date.now()) {
    pruneWindow(now);
    const key = methodKey(serviceName, methodName);
    const whitelisted = WHITELIST.has(key) || STEAL_WHITELIST_RE.test(key);
    // 异常阈值只通知上层降低普通巡查节奏，不在这里整号拒绝业务请求。
    // 成熟抢收仍受下面的 60s 总量/单方法硬预算保护。
    if (whitelisted) return { allowed: true, reason: 'whitelist' };

    // 成熟抢收紧急窗口：偷菜快路径链路请求不被硬预算丢弃（仍计入画像）。
    // 只豁免这五个目标方法，其他请求照常过闸，防止窗口被滥用成全局限流旁路。
    if (urgentModeActive(now) && URGENT_METHODS.has(key)) {
        return { allowed: true, reason: 'urgent' };
    }

    // 施肥 HOT 内总预算同步放宽（目标好友需要高频往返，80/min 的常规预算
    // 会被盯梢+常规巡查挤满，导致 Enter 被拦、盯哨失明）
    const totalLimit = watchModeActive(now) ? Math.floor(TOTAL_LIMIT * 1.5) : TOTAL_LIMIT;
    if (windowEvents.length >= totalLimit) {
        droppedTotal++;
        noteBudgetDrop('budget_total', key, now);
        return { allowed: false, reason: 'budget_total' };
    }
    // 施肥 HOT 内的进门/读地块放宽单接口限值。
    const methodLimit = WATCHMODE_METHODS.has(key) && watchModeActive(now)
        ? methodLimitBase(key) * WATCHMODE_BOOST
        : methodLimitBase(key);
    const methodCount = windowEvents.filter(e => e.key === key).length;
    if (methodCount >= methodLimit) {
        droppedTotal++;
        noteBudgetDrop('budget_method', key, now);
        return { allowed: false, reason: 'budget_method' };
    }
    return { allowed: true, reason: 'ok' };
}

/**
 * 当前 60s 窗口是否还有预算。
 * 供批量派发循环在预算耗尽时提前退出：被拦的请求不会成功，继续按
 * 毫秒级间隔重试只会把整轮的 Enter 刷成拦截日志（实测单轮 325 次），
 * 并把 CheckCanOperate 预检查等关键请求一起挤掉。
 *
 * 传了 serviceName/methodName 时同时检查单接口限值：总窗口还没满、但
 * 该接口已达 PER_METHOD_LIMIT 时，循环继续派发同样是被 budget_method 逐条拦下，
 * 必须一并提前退出。
 *
 * 判定顺序必须与 checkRequest 完全一致：豁免（白名单/紧急窗口）先于总量。
 * 否则成熟抢收紧急窗口里总量已满时，这里会误报“没预算”而提前 break，
 * 把 checkRequest 本来会放行的到点抢收链静默丢掉。
 */
function hasBudget(now = Date.now(), headroom = 0, serviceName = '', methodName = '') {
    pruneWindow(now);
    // 两个参数必须同时给出：只给一个会构造出永不命中的 key，
    // 使单接口限值和白名单/紧急豁免全部静默失效，比不传更危险。
    const key = (serviceName && methodName) ? methodKey(serviceName, methodName) : '';
    if (key) {
        if (WHITELIST.has(key) || STEAL_WHITELIST_RE.test(key)) return true;
        if (urgentModeActive(now) && URGENT_METHODS.has(key)) return true;
    }
    const totalLimit = watchModeActive(now) ? Math.floor(TOTAL_LIMIT * 1.5) : TOTAL_LIMIT;
    const reserve = Math.max(0, Number(headroom) || 0);
    if (windowEvents.length >= Math.max(1, totalLimit - reserve)) return false;
    if (!key) return true;
    const methodLimit = WATCHMODE_METHODS.has(key) && watchModeActive(now)
        ? methodLimitBase(key) * WATCHMODE_BOOST
        : methodLimitBase(key);
    return windowEvents.filter(e => e.key === key).length < methodLimit;
}

/** 短名：去掉 gamepb.<domain> 前缀，保留 Service.Method。 */
function shortMethodName(key) {
    return String(key || '').replace(/^gamepb\.[a-z]+\./i, '');
}

/**
 * 窗口占用快照：谁占满了 60s 预算。
 * 不承诺无副作用（会 prune 过期事件、读取近段计数），但不会改变任何治理决策。
 */
function buildBudgetSnapshot(reason, now = Date.now(), limit = 8) {
    pruneWindow(now);
    const byMethod = new Map();
    for (const e of windowEvents) byMethod.set(e.key, (byMethod.get(e.key) || 0) + 1);
    const top = [...byMethod.entries()]
        .map(([method, count]) => ({ method: shortMethodName(method), count }))
        .sort((left, right) => right.count - left.count)
        .slice(0, Math.max(1, Number(limit) || 8));
    return {
        reason,
        windowCount: windowEvents.length,
        totalLimit: watchModeActive(now) ? Math.floor(TOTAL_LIMIT * 1.5) : TOTAL_LIMIT,
        perMethodLimit: PER_METHOD_LIMIT,
        drops: dropsSinceSnapshot,
        top,
    };
}

/**
 * 预算拦截落一条诊断（60s 节流）。节流窗口与聚合告警独立：
 * 聚合告警回答“哪个入口被拦了多少”，这里回答“窗口额度被谁用掉了”。
 */
function noteBudgetDrop(reason, key, now = Date.now()) {
    dropsSinceSnapshot++;
    if (now - lastDropSnapshotAt < DROP_SNAPSHOT_INTERVAL_MS) return null;
    const snapshot = buildBudgetSnapshot(reason, now);
    // 输出失败时不消耗节流也不清计数：下一条拦截会带完整计数重试，
    // 不能让首条诊断被静默吞掉后整整 60s 没有任何窗口占用线索。
    if (!process.env.NODE_TEST_CONTEXT) {
        try {
            const { logWarn } = require('../utils/utils');
            const top = snapshot.top.map(item => `${item.method}×${item.count}`).join(', ');
            logWarn('系统',
                `预算拦截(${reason})：60s 窗口 ${snapshot.windowCount}/${snapshot.totalLimit}，近段拦截 ${snapshot.drops} 次，占用 Top ${top}`,
                {
                    module: 'system',
                    event: 'governor_budget_drop',
                    result: 'warn',
                    reason,
                    deniedMethod: shortMethodName(key),
                    windowCount: snapshot.windowCount,
                    totalLimit: snapshot.totalLimit,
                    perMethodLimit: snapshot.perMethodLimit,
                    drops: snapshot.drops,
                    top: snapshot.top,
                    at: now,
                });
        } catch {
            return snapshot;
        }
    }
    lastDropSnapshotAt = now;
    dropsSinceSnapshot = 0;
    return snapshot;
}

/** 发送已放行/白名单请求后登记（ok=是否成功） */
function recordSent(serviceName, methodName, ok, now = Date.now(), options = {}) {
    pruneWindow(now);
    const key = methodKey(serviceName, methodName);
    windowEvents.push({ at: now, key, ok: ok !== false });
    if (ok === false) {
        // 施肥 HOT / 成熟竞速中的目标链路失败不计入异常阈值：它们通常只是状态竞争。
        // 此外，调用方可把明确的只读探测“业务错误”标为 breakerExempt；网络超时、
        // 断线与发送失败不会带这个标记，仍按真实协议异常计数。
        const inContention = WATCH_FAILURE_EXEMPT_METHODS.has(key)
            && (watchModeActive(now) || contentionModeActive(now));
        if (!inContention && options.breakerExempt !== true) {
            errEvents.push({ at: now, key });
            if (errEvents.length >= BREAKER_ERR_LIMIT && now >= slowdownUntil) {
                const slowdown = SLOWDOWN_MIN_MS
                    + Math.floor(Math.random() * (SLOWDOWN_MAX_MS - SLOWDOWN_MIN_MS));
                const failures = [...errEvents.reduce((counts, item) => {
                    counts.set(item.key, (counts.get(item.key) || 0) + 1);
                    return counts;
                }, new Map()).entries()]
                    .map(([method, count]) => ({ method, count }))
                    .sort((left, right) => right.count - left.count);
                slowdownUntil = now + slowdown;
                slowdownCount++;
                errEvents.length = 0;
                if (!process.env.NODE_TEST_CONTEXT) {
                    try {
                        const top = failures.slice(0, 3)
                            .map(item => `${item.method}×${item.count}`)
                            .join(', ');
                        require('./daily-events').recordEvent(
                            process.env.FARM_ACCOUNT_ID || '', 'warn', 'slowdown',
                            `连续失败过多，普通巡查降速 ${Math.round(slowdown / 60000)} 分钟${top ? `（${top}）` : ''}`);
                    } catch { /* 事件记录失败不影响降速 */ }
                }
                return { tripped: false, slowed: true, slowdownMs: slowdown, failures };
            }
        }
    }
    return { tripped: false };
}

/** 手动取消异常降速（保留旧函数名兼容既有面板/API）。 */
function clearBreaker() {
    const wasActive = Date.now() < slowdownUntil;
    slowdownUntil = 0;
    errEvents.length = 0;
    return wasActive;
}

/** 画像：给每日安全巡检的事实输入 */
function getRequestProfile(now = Date.now()) {
    pruneWindow(now);
    const byMethod = new Map();
    for (const e of windowEvents) {
        const item = byMethod.get(e.key) || { count: 0, errCount: 0 };
        item.count++;
        if (!e.ok) item.errCount++;
        byMethod.set(e.key, item);
    }
    const top = [...byMethod.entries()]
        .map(([key, v]) => ({ method: key, ...v }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);
    return {
        windowMs: WINDOW_MS,
        totalLimit: TOTAL_LIMIT,
        perMethodLimit: PER_METHOD_LIMIT,
        watchModeActive: watchModeActive(now),
        contentionModeActive: contentionModeActive(now),
        watchModeBoost: WATCHMODE_BOOST,
        windowCount: windowEvents.length,
        droppedTotal,
        slowdownActive: now < slowdownUntil,
        slowdownUntil,
        slowdownCount,
        // 兼容旧画像字段，但明确不存在硬熔断。
        breakerActive: false,
        breakerUntil: 0,
        breakerCount: slowdownCount,
        top,
    };
}

function getBreakerState(now = Date.now()) {
    return {
        active: now < slowdownUntil,
        until: slowdownUntil,
        count: slowdownCount,
        mode: 'slowdown',
        hardBlocked: false,
        recommendedDelayMs: SLOWDOWN_RECOMMENDED_DELAY_MS,
    };
}

/** 测试用：清空全部状态 */
function resetForTest() {
    windowEvents.length = 0;
    errEvents.length = 0;
    slowdownUntil = 0;
    slowdownCount = 0;
    droppedTotal = 0;
    lastDropSnapshotAt = 0;
    dropsSinceSnapshot = 0;
    watchModeUntil = 0;
    contentionModeUntil = 0;
    urgentModeUntil = 0;
}

module.exports = {
    checkRequest,
    recordSent,
    hasBudget,
    buildBudgetSnapshot,
    getRequestProfile,
    getBreakerState,
    clearBreaker,
    setWatchMode,
    setContentionMode,
    setUrgentMode,
    urgentModeActive,
    resetForTest,
    WINDOW_MS,
    TOTAL_LIMIT,
    PER_METHOD_LIMIT,
    METHOD_LIMITS,
    methodLimitBase,
};
