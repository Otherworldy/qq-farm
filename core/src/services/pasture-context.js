/**
 * 牧场发送上下文（AsyncLocalStorage）
 *
 * 作用只有一个：让「牧场的第 N 次发送」在真正写 socket 之前还能再做一次校验，
 * 并在写成功后记账。三件事都靠它：
 *
 * 1. 开关二次核对：配置在 await 期间可能被改（面板上关掉某个开关），
 *    发包前一瞬再查一次，能拦住「刚关掉还在跑」的那一轮。
 * 2. 账本判定：只有真正写进 socket 的请求才可能产生副作用。发送次数
 *    决定一次失败是「网关拒绝（没发出去）」还是「结果未知（发出去了才断）」。
 * 3. 嵌套透传：父上下文（外层操作）的 check/onSent 必须继续生效。
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

/**
 * 在给定上下文里执行。ctx = { check?, onSent? }
 * - check(service, method) 返回 Error 即拒发
 * - onSent(service, method) 在 socket 写入成功后回调
 */
function runWithPastureContext(ctx, fn) {
    const parent = storage.getStore() || null;
    const merged = {
        check(service, method) {
            const fromParent = parent && parent.check ? parent.check(service, method) : null;
            if (fromParent) return fromParent;
            return ctx && ctx.check ? ctx.check(service, method) : null;
        },
        onSent(service, method) {
            if (parent && parent.onSent) parent.onSent(service, method);
            if (ctx && ctx.onSent) ctx.onSent(service, method);
        },
    };
    return storage.run(merged, fn);
}

function getPastureContext() {
    return storage.getStore() || null;
}

/** 发送前的统一校验入口；没有上下文时放行。 */
function checkBeforeSend(service, method) {
    const ctx = storage.getStore();
    if (!ctx || typeof ctx.check !== 'function') return null;
    try {
        return ctx.check(service, method) || null;
    } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
    }
}

/** 发送成功后的统一记账入口；没有上下文时忽略。 */
function noteSent(service, method) {
    const ctx = storage.getStore();
    if (!ctx || typeof ctx.onSent !== 'function') return;
    try { ctx.onSent(service, method); } catch { /* 记账失败不能影响发包 */ }
}

module.exports = {
    runWithPastureContext,
    getPastureContext,
    checkBeforeSend,
    noteSent,
};