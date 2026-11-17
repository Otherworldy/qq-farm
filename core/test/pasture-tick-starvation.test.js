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
