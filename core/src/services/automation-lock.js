/**
 * 自动化全局串行锁
 *
 * 农场 / 牧场 / 好友访问共用同一条 WebSocket，而牧场还要「进场景 → 操作 →
 * 切回原场景」，所以这些流程必须串行：两个流程同时切场景，后一个会把前一个
 * 的场景状态踩掉。
 *
 * 两条规则：
 * 1. 持锁期间再调用直接就地执行（可重入），否则内部子任务会排到自己后面、互等死锁。
 * 2. `detached` 只用于「定时器继承了已结束任务的异步上下文」那种场景：此时必须
 *    重新排队。若持有者正 await 这个 detached 子任务，重新排队同样会死锁，
 *    所以持锁时一律就地执行 —— 最差只是少让一次锁。
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { logWarn } = require('../utils/utils');

const storage = new AsyncLocalStorage();
const queue = [];
let running = false;
let lastTimeoutLogAt = 0;

const TIMEOUT_LOG_THROTTLE_MS = 30 * 1000;

function pump() {
    if (running) return;
    const item = queue.shift();
    if (!item) return;
    running = true;
    if (item.timer) {
        clearTimeout(item.timer);
        item.timer = null;
    }
    const store = { exclusive: true, active: true };
    // 用 .then 包一层：同步抛错也要变成 rejected Promise，
    // 否则调用方的 .catch(() => null) 接不住，异常会冒泡打断本轮调度。
    Promise.resolve()
        .then(() => storage.run(store, item.fn))
        .then(
            value => item.resolve(value),
            error => item.reject(error),
        )
        .finally(() => {
            store.active = false;
            running = false;
            pump();
        });
}

/**
 * 在全局锁内执行。
 * @param {string} taskName 日志用的任务名
 * @param {() => any} taskFn
 * @param {{detached?: boolean, priority?: boolean, timeoutMs?: number}} [options]
 */
function runExclusiveAutomationTask(taskName, taskFn, options = {}) {
    const store = storage.getStore();
    if (store && store.exclusive && (store.active || !options.detached)) {
        return Promise.resolve().then(taskFn);
    }

    return new Promise((resolve, reject) => {
        const item = {
            name: String(taskName || 'automation'),
            fn: taskFn,
            priority: !!options.priority,
            resolve,
            reject,
            timer: null,
        };
        const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
        if (timeoutMs > 0) {
            item.timer = setTimeout(() => {
                const index = queue.indexOf(item);
                // 已经开始执行的任务不撤销：超时只管「排队等锁」这一段。
                if (index < 0) return;
                queue.splice(index, 1);
                const now = Date.now();
                if (now - lastTimeoutLogAt > TIMEOUT_LOG_THROTTLE_MS) {
                    lastTimeoutLogAt = now;
                    logWarn(`自动化任务 ${item.name} 排队超过 ${Math.round(timeoutMs / 1000)} 秒未拿到锁，本轮跳过`, {
                        module: 'system', event: '自动化锁等待', result: 'timeout', task: item.name,
                    });
                }
                resolve(undefined);
            }, timeoutMs);
        }
        if (item.priority) {
            // 插到所有低优先任务之前，但不打断正在执行的那个（它已不在队列里）。
            let insertAt = 0;
            while (insertAt < queue.length && queue[insertAt].priority) insertAt++;
            queue.splice(insertAt, 0, item);
        } else {
            queue.push(item);
        }
        pump();
    });
}

function isAutomationTaskRunning() {
    return running;
}

module.exports = {
    runExclusiveAutomationTask,
    isAutomationTaskRunning,
};