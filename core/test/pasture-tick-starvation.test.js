/**
 * 牧场 tick 饿死回归。
 *
 * 真机现象：挂一整晚，牧场一次都没跑（栏位 0/3 从未变化）。
 * 根因：统一调度器里偷菜分支跑完 `return`，而偷菜快路径每 1.5-3 秒
 * 到期一次，shouldSteal 几乎恒为真 —— 排在它后面的 runPastureTick
 * 从来没有机会执行。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/** 直接检查调度器源码：偷菜分支之后不得 return，否则后续 tick 被饿死 */
test('统一调度器：偷菜分支跑完不得提前返回', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/worker.js'), 'utf8');
    const start = src.indexOf('const shouldFarm =');
    assert.ok(start > 0, '找不到调度分支');
    const block = src.slice(start, start + 1600);

    const stealCall = block.indexOf('await runStealTick(autoConfig);');
    assert.ok(stealCall > 0, '找不到偷菜调用');

    // 偷菜调用之后、下一个 else-if 之前，不应出现裸 return
    const after = block.slice(stealCall + 'await runStealTick(autoConfig);'.length);
    const nextBranch = after.indexOf('} else if (stealIsImminent');
    assert.ok(nextBranch > 0, '找不到后续分支');
    const between = after.slice(0, nextBranch);
    assert.ok(!/^\s*return\s*;/m.test(between),
        `偷菜分支后紧跟 return，会把牧场 tick 饿死：${JSON.stringify(between)}`);
});

test('统一调度器：三个 tick 都在偷菜分支之后被调用', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/worker.js'), 'utf8');
    const start = src.indexOf('const shouldFarm =');
    const block = src.slice(start, start + 2000);
    const stealAt = block.indexOf('await runStealTick(autoConfig);');
    for (const call of ['await runFarmTick(autoConfig);',
                        'await runHelpTick(autoConfig);',
                        'await runPastureTick(autoConfig);']) {
        const at = block.indexOf(call);
        assert.ok(at > stealAt, `${call} 必须在偷菜之后仍可执行`);
    }
});

/** 卡死自愈：await 挂住时 finally 不执行，pastureTaskRunning 会永久为 true */
test('牧场 tick 有卡死自愈与超时保护', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/worker.js'), 'utf8');
    assert.match(src, /PASTURE_TICK_STALL_MS/, '需要卡死阈值常量');
    assert.match(src, /pasture_tick_stall/, '卡死时要记一条可诊断的日志');
    // 上一轮超时要能强制复位，否则后续每轮都在第一行 return
    const guard = src.slice(src.indexOf('async function runPastureTick'), src.indexOf('async function runPastureTick') + 900);
    assert.match(guard, /pastureTaskRunning = false;[\s\S]*if \(pastureTaskRunning \|\| friendSyncPaused\) return;/,
        '复位必须发生在 running 判断之前');
    // checkPasture 要走超时包装，否则挂死就再也回不来
    assert.match(src, /withTimeout\(checkPasture\(\)/, 'checkPasture 必须带超时');
});
