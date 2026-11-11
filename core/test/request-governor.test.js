const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const governor = require('../src/services/request-governor');

const T0 = 1_700_000_000_000;
const networkSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'network.js'), 'utf8');
const activitySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'activity.js'), 'utf8');
const activityRouteSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'controllers', 'admin-activity-update-routes.js'),
    'utf8'
);

test('total budget drops non-whitelisted requests beyond the 60s limit', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.TOTAL_LIMIT; i++) {
        assert.equal(governor.checkRequest('svc.Farm', `Do${i % 3}`, T0).allowed, true);
        governor.recordSent('svc.Farm', `Do${i % 3}`, true, T0);
    }
    const over = governor.checkRequest('svc.Farm', 'Extra', T0 + 1000);
    assert.equal(over.allowed, false);
    assert.equal(over.reason, 'budget_total');
});

test('whitelist and steal methods bypass the budget', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.TOTAL_LIMIT + 5; i++) {
        governor.recordSent('gamepb.userpb.UserService', 'Heartbeat', true, T0);
    }
    const hb = governor.checkRequest('gamepb.userpb.UserService', 'Heartbeat', T0 + 2000);
    assert.equal(hb.allowed, true);
    assert.equal(hb.reason, 'whitelist');
    const ace = governor.checkRequest('gamepb.acepb.AceService', 'AntiData', T0 + 2000);
    assert.equal(ace.allowed, true);
    assert.equal(ace.reason, 'whitelist');
    const steal = governor.checkRequest('gamepb.plantpb.PlantService', 'Harvest', T0 + 2000);
    assert.equal(steal.allowed, true);
});

test('error slowdown never blocks heartbeat or login', () => {
    governor.resetForTest();
    for (let i = 0; i < 15; i++) {
        const r = governor.recordSent('svc.Farm', 'Broken', false, T0 + i * 1000);
        if (r.tripped) break;
    }
    assert.equal(governor.getBreakerState(T0 + 16_000).active, true);
    assert.equal(governor.checkRequest('gamepb.userpb.UserService', 'Heartbeat', T0 + 16_000).allowed, true);
    assert.equal(governor.checkRequest('gamepb.gatepb.GateService', 'Login', T0 + 16_000).allowed, true);
});

test('maturity contention failures do not accumulate toward slowdown', () => {
    governor.resetForTest();
    governor.setContentionMode(true, T0 + 20 * 60 * 1000);
    const methods = [
        ['gamepb.visitpb.VisitService', 'Enter'],
        ['gamepb.visitpb.VisitService', 'Leave'],
        ['gamepb.plantpb.PlantService', 'AllLands'],
        ['gamepb.plantpb.PlantService', 'CheckCanOperate'],
        ['gamepb.plantpb.PlantService', 'Harvest'],
    ];
    for (let i = 0; i < 20; i++) {
        const [service, method] = methods[i % methods.length];
        const r = governor.recordSent(service, method, false, T0 + i * 500);
        assert.equal(r.slowed, undefined, `watch-mode ${method} failures must not trigger slowdown`);
    }
    assert.equal(governor.getBreakerState(T0 + 11_000).active, false);
    assert.equal(governor.getRequestProfile(T0 + 11_000).contentionModeActive, true);
});

test('maturity failure exemption expires and ordinary failures still trigger slowdown', () => {
    governor.resetForTest();
    governor.setContentionMode(true, T0 + 5_000);
    for (let i = 0; i < 10; i++) {
        governor.recordSent('gamepb.plantpb.PlantService', 'Harvest', false, T0 + i * 200);
    }
    assert.equal(governor.getBreakerState(T0 + 4_000).active, false);

    let slowed = false;
    for (let i = 0; i < 20; i++) {
        const result = governor.recordSent(
            'gamepb.visitpb.VisitService',
            'Leave',
            false,
            T0 + 6_000 + i * 200
        );
        if (result.slowed) {
            slowed = true;
            assert.equal(result.failures[0].method, 'gamepb.visitpb.VisitService.Leave');
            break;
        }
    }
    assert.equal(slowed, true);
});

test('slowdown does not block ordinary or watch-essential methods', () => {
    governor.resetForTest();
    governor.setWatchMode(false);
    for (let i = 0; i < 14; i++) {
        const r = governor.recordSent('svc.Farm', 'Flaky', false, T0 + i * 1000);
        if (r.tripped) break;
    }
    assert.equal(governor.getBreakerState(T0 + 16_000).active, true);
    // 降速由调度层执行，请求层不再返回 cooldown。
    assert.equal(governor.checkRequest('svc.Farm', 'Other', T0 + 16_000).allowed, true);
    // 盯梢窗口激活后，Enter/AllLands 同样可继续运行。
    governor.setWatchMode(true, T0 + 30 * 60 * 1000);
    assert.equal(governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 16_000).allowed, true);
    assert.equal(governor.checkRequest('gamepb.plantpb.PlantService', 'AllLands', T0 + 16_000).allowed, true);
});

test('ordinary maturity contention does not boost Enter and slowdown does not block it', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.PER_METHOD_LIMIT; i++) {
        governor.recordSent('gamepb.visitpb.VisitService', 'Enter', true, T0);
    }
    governor.setContentionMode(true, T0 + 30 * 60 * 1000);
    const limited = governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 500);
    assert.equal(limited.allowed, false);
    assert.equal(limited.reason, 'budget_method');

    governor.resetForTest();
    for (let i = 0; i < 14; i++) {
        const result = governor.recordSent('svc.Farm', 'Flaky', false, T0 + i * 1000);
        if (result.tripped) break;
    }
    governor.setContentionMode(true, T0 + 30 * 60 * 1000);
    const allowed = governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 16_000);
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.reason, 'ok');
});

test('explicit read-only probe business failures stay in profile but not slowdown', () => {
    governor.resetForTest();
    for (let i = 0; i < 20; i++) {
        const result = governor.recordSent(
            'gamepb.activitypb.ActivityService',
            'GetGroup',
            false,
            T0 + i * 500,
            { breakerExempt: true }
        );
        assert.equal(result.tripped, false);
    }
    assert.equal(governor.getBreakerState(T0 + 11_000).active, false);
    const method = governor.getRequestProfile(T0 + 11_000).top
        .find(item => item.method === 'gamepb.activitypb.ActivityService.GetGroup');
    assert.equal(method.count, 20);
    assert.equal(method.errCount, 20);
});

test('activity discovery only reads List roots and exempts business errors, not transport failures', () => {
    const snapshotStart = activitySrc.indexOf('async function getActivityGroupSnapshot');
    const snapshotEnd = activitySrc.indexOf('/**', snapshotStart + 10);
    assert.match(activitySrc.slice(snapshotStart, snapshotEnd), /discoveryProbe: true/);
    assert.match(networkSrc, /options\.breakerExemptBusinessError === true/);
    assert.match(networkSrc, /err\.isServerBusinessError === true/);
    assert.match(networkSrc, /error\.isServerBusinessError = true/);
    assert.match(activityRouteSrc, /selectActivitySnapshotRoots\(activities, unknown\)/);
    assert.match(activityRouteSrc, /禁止枚举未由 ActivityService\.List 下发的活动 ID/);
    assert.doesNotMatch(activityRouteSrc, /MAX_DATE_PROBES_PER_SCAN|selectedProbeIds|GetGroup probe/);
});

test('per-method budget trips before the total budget', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.PER_METHOD_LIMIT; i++) {
        governor.recordSent('svc.Farm', 'Spam', true, T0);
    }
    const over = governor.checkRequest('svc.Farm', 'Spam', T0 + 500);
    assert.equal(over.allowed, false);
    assert.equal(over.reason, 'budget_method');
    // 别的接口仍可用
    assert.equal(governor.checkRequest('svc.Farm', 'Other', T0 + 500).allowed, true);
});

test('repeated failures activate advisory slowdown without rejecting requests', () => {
    governor.resetForTest();
    let slowed = false;
    for (let i = 0; i < 14; i++) {
        const r = governor.recordSent('svc.Farm', 'Flaky', false, T0 + i * 1000);
        if (r.slowed) slowed = true;
    }
    assert.equal(slowed, true, 'ordinary polling should be advised to slow down');
    const state = governor.getBreakerState(T0 + 15_000);
    assert.equal(state.active, true);
    assert.equal(state.mode, 'slowdown');
    assert.equal(state.hardBlocked, false);
    assert.ok(state.recommendedDelayMs >= 30_000);
    const normal = governor.checkRequest('svc.Farm', 'Normal', T0 + 16_000);
    assert.equal(normal.allowed, true);
    assert.notEqual(normal.reason, 'cooldown');
    assert.equal(governor.checkRequest('gamepb.userpb.UserService', 'Heartbeat', T0 + 16_000).allowed, true);
    assert.equal(governor.clearBreaker(), false, 'wall clock differs from synthetic test time');
    assert.equal(governor.getBreakerState(T0 + 16_000).active, false);
});

test('watch mode boosts Enter/AllLands per-method limit inside the window only', () => {
    governor.resetForTest();
    // 填满普通单接口限值
    for (let i = 0; i < governor.PER_METHOD_LIMIT; i++) {
        governor.recordSent('gamepb.visitpb.VisitService', 'Enter', true, T0);
    }
    assert.equal(governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 500).allowed, false);

    // 进入盯梢窗口：同一时刻同样的量应当放行（限值 ×3）
    governor.setWatchMode(true, T0 + 10 * 60 * 1000);
    const boosted = governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 600);
    assert.equal(boosted.allowed, true);
    // 非放宽接口不享受
    assert.equal(governor.checkRequest('svc.Farm', 'Other', T0 + 600).allowed, true);

    // 窗口过期后恢复普通限值
    governor.setWatchMode(false);
    assert.equal(governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 500).allowed, false);
});

test('profile exposes top methods and drop counters', () => {
    governor.resetForTest();
    governor.recordSent('svc.A', 'Hot', true, T0);
    governor.recordSent('svc.A', 'Hot', false, T0 + 10);
    governor.recordSent('svc.B', 'Cold', true, T0 + 20);
    const p = governor.getRequestProfile(T0 + 100);
    assert.equal(p.windowCount, 3);
    const hot = p.top.find(m => m.method === 'svc.A.Hot');
    assert.equal(hot.count, 2);
    assert.equal(hot.errCount, 1);
});

// 2026-09-22 成熟抢收紧急通道：哨兵预进门链路（Enter/Leave/CheckCanOperate/
// Harvest）在预算满时仍放行；非链路请求照常被预算拦截；窗口过期后恢复拦截。
test('urgent mode bypasses hard budget only for strike-chain methods', () => {
    governor.resetForTest();
    // 预算打满：单方法超 PER_METHOD_LIMIT，总量也打满（80/min）。
    for (let i = 0; i < governor.PER_METHOD_LIMIT + 5; i++) {
        governor.recordSent('gamepb.visitpb.VisitService', 'Enter', true, T0 + i * 10);
    }
    for (let i = 0; i < governor.TOTAL_LIMIT; i++) {
        governor.recordSent('gamepb.otherpb.Svc', 'Filler', true, T0 + i * 10);
    }
    const blocked = governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 1_000);
    assert.equal(blocked.allowed, false);

    governor.setUrgentMode(true, T0 + 15_000);
    const chain = [
        ['gamepb.visitpb.VisitService', 'Enter'],
        ['gamepb.visitpb.VisitService', 'Leave'],
        ['gamepb.plantpb.PlantService', 'CheckCanOperate'],
        ['gamepb.plantpb.PlantService', 'Harvest'],
    ];
    for (const [svc, method] of chain) {
        const r = governor.checkRequest(svc, method, T0 + 1_500);
        assert.equal(r.allowed, true, `${method} should pass in urgent mode`);
        // Harvest/Steal 本就是白名单；其余链路方法走 urgent 放行。
        assert.ok(r.reason === 'urgent' || r.reason === 'whitelist', `unexpected reason ${r.reason}`);
    }
    // 非链路请求在紧急窗口内仍被预算拦截（窗口不是全局限流旁路）。
    const other = governor.checkRequest('gamepb.friendpb.FriendService', 'GetAll', T0 + 1_500);
    assert.equal(other.allowed, false);
    // 窗口过期恢复拦截。
    const expired = governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 20_000);
    assert.equal(expired.allowed, false);
});

// 预算拦截诊断：拦截只报被拒方法，必须能看出 60s 窗口被谁占满。
test('budget drop snapshot names the methods that filled the window', () => {
    governor.resetForTest();
    for (let i = 0; i < 30; i++) {
        governor.recordSent('gamepb.plantpb.PlantService', 'AllLands', true, T0);
    }
    for (let i = 0; i < 20; i++) {
        governor.recordSent('gamepb.taskpb.TaskService', 'TaskInfo', true, T0);
    }
    const gate = governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 1000);
    assert.equal(gate.allowed, true);

    const snapshot = governor.buildBudgetSnapshot('budget_method', T0 + 1000);
    assert.equal(snapshot.windowCount, 50);
    assert.equal(snapshot.totalLimit, governor.TOTAL_LIMIT);
    assert.equal(snapshot.perMethodLimit, governor.PER_METHOD_LIMIT);
    assert.deepEqual(snapshot.top[0], { method: 'PlantService.AllLands', count: 30 });
    assert.deepEqual(snapshot.top[1], { method: 'TaskService.TaskInfo', count: 20 });
});

test('budget snapshot reads only the live 60s window', () => {
    governor.resetForTest();
    governor.recordSent('svc.Old', 'Stale', true, T0);
    governor.recordSent('svc.New', 'Fresh', true, T0 + 61_000);
    const snapshot = governor.buildBudgetSnapshot('budget_total', T0 + 61_500);
    assert.equal(snapshot.windowCount, 1);
    assert.deepEqual(snapshot.top, [{ method: 'svc.New.Fresh', count: 1 }]);
});

test('budget drop diagnostics never change the governance decision', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.TOTAL_LIMIT; i++) {
        governor.recordSent('svc.Farm', 'Fill', true, T0);
    }
    const over = governor.checkRequest('svc.Farm', 'Extra', T0 + 1000);
    assert.equal(over.allowed, false);
    assert.equal(over.reason, 'budget_total');
    assert.equal(governor.getRequestProfile(T0 + 1000).droppedTotal, 1);
});

// 2026-11-11 实测：Enter 单接口打满 30/min、总量只有 30/80 时，hasBudget()
// 仍返回 true，偷菜循环继续按毫秒间隔派发，整轮全部得到 budget_method。
test('hasBudget with a target method reports per-method exhaustion', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.PER_METHOD_LIMIT; i++) {
        governor.recordSent('gamepb.visitpb.VisitService', 'Enter', true, T0);
    }
    assert.equal(governor.getRequestProfile(T0).windowCount, governor.PER_METHOD_LIMIT);
    assert.equal(governor.hasBudget(T0), true, '总预算仍有余额，旧行为无法发现单接口已满');
    assert.equal(governor.hasBudget(T0, 0, 'gamepb.visitpb.VisitService', 'Enter'), false);
    // 未打满的接口照常可以继续派发
    assert.equal(governor.hasBudget(T0, 0, 'gamepb.taskpb.TaskService', 'TaskInfo'), true);
});

test('hasBudget keeps whitelist, urgent and watch-mode semantics', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.PER_METHOD_LIMIT + 5; i++) {
        governor.recordSent('gamepb.plantpb.PlantService', 'Harvest', true, T0);
    }
    assert.equal(governor.hasBudget(T0, 0, 'gamepb.plantpb.PlantService', 'Harvest'), true, '偷菜白名单不受单接口限值');

    governor.resetForTest();
    for (let i = 0; i < governor.PER_METHOD_LIMIT; i++) {
        governor.recordSent('gamepb.visitpb.VisitService', 'Enter', true, T0);
    }
    governor.setUrgentMode(true, T0 + 15_000);
    assert.equal(governor.hasBudget(T0 + 1000, 0, 'gamepb.visitpb.VisitService', 'Enter'), true, '紧急窗口内放行');
    governor.setUrgentMode(false);

    governor.resetForTest();
    for (let i = 0; i < governor.PER_METHOD_LIMIT; i++) {
        governor.recordSent('gamepb.visitpb.VisitService', 'Enter', true, T0);
    }
    governor.setWatchMode(true, T0 + 600_000);
    assert.equal(governor.hasBudget(T0 + 1000, 0, 'gamepb.visitpb.VisitService', 'Enter'), true, '施肥 HOT 放宽 ×3');
});

test('hasBudget headroom reserves total budget without touching method check', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.TOTAL_LIMIT - 2; i++) {
        governor.recordSent('svc.Farm', 'Fill', true, T0);
    }
    assert.equal(governor.hasBudget(T0), true);
    assert.equal(governor.hasBudget(T0, 5), false, 'headroom 预留后总量不足');
    assert.equal(governor.hasBudget(T0, 5, 'svc.Farm', 'Other'), false);
});

// 回归：hasBudget 的判定顺序必须与 checkRequest 一致，否则成熟抢收紧急窗口
// 里总量已满时守卫会误报"没预算"，把治理器本来放行的到点抢收链静默丢掉。
test('hasBudget never vetoes what the urgent window would allow', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.TOTAL_LIMIT; i++) {
        governor.recordSent('svc.Other', 'Fill', true, T0);
    }
    governor.setUrgentMode(true, T0 + 15_000);
    const gate = governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 1000);
    assert.equal(gate.allowed, true);
    assert.equal(gate.reason, 'urgent');
    assert.equal(
        governor.hasBudget(T0 + 1000, 0, 'gamepb.visitpb.VisitService', 'Enter'),
        true,
        '守卫必须与 checkRequest 同样放行抢收链'
    );
    // 紧急窗口不覆盖的方法仍然被总量拦住，循环该提前退出。
    assert.equal(governor.hasBudget(T0 + 1000, 0, 'gamepb.taskpb.TaskService', 'TaskInfo'), false);
});

// 回归：全量偷菜循环的守卫不能因 preEnter 复用分支而过度退出。
test('hasBudget checks the request the target actually sends first', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.PER_METHOD_LIMIT; i++) {
        governor.recordSent('gamepb.visitpb.VisitService', 'Enter', true, T0);
    }
    // 预进门复用分支不发 Enter，真实瓶颈是 CheckCanOperate，仍有额度。
    assert.equal(
        governor.hasBudget(T0, 0, 'gamepb.plantpb.PlantService', 'CheckCanOperate'),
        true,
        '复用预进门时不应按 Enter 的额度判断'
    );
    // 新发 Enter 的分支则必须拦住（Enter 的计数键是 VisitService.Enter）。
    assert.equal(governor.hasBudget(T0, 0, 'gamepb.visitpb.VisitService', 'Enter'), false);
});

test('budget drop diagnostics are throttled and reset for tests', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.TOTAL_LIMIT; i++) {
        governor.recordSent('svc.Farm', 'Fill', true, T0);
    }
    // 测试进程不输出日志，但节流戳与计数必须照常推进。
    const first = governor.checkRequest('svc.Farm', 'Extra', T0 + 1000);
    assert.equal(first.reason, 'budget_total');
    const snapshot = governor.buildBudgetSnapshot('budget_total', T0 + 1000);
    assert.ok(snapshot.top.length >= 1);
    assert.equal(snapshot.drops, 0, '快照本身不消耗诊断计数');
    governor.resetForTest();
    assert.equal(governor.buildBudgetSnapshot('budget_total', T0 + 1000).windowCount, 0);
});

test('budget drop diagnostics emit once per window and accumulate between emits', () => {
    const previous = process.env.NODE_TEST_CONTEXT;
    process.env.NODE_TEST_CONTEXT = '1';
    try {
        governor.resetForTest();
        const fill = base => {
            for (let i = 0; i < governor.TOTAL_LIMIT; i++) governor.recordSent('svc.Other', 'Fill', true, base + i * 10);
        };
        fill(T0);
        governor.checkRequest('svc.Farm', 'Extra', T0 + 1000);
        assert.equal(governor.buildBudgetSnapshot('budget_total', T0 + 1000).drops, 0, '首条立即输出后清零');

        fill(T0 + 20_000);
        governor.checkRequest('svc.Farm', 'Extra', T0 + 31_000);
        assert.equal(governor.buildBudgetSnapshot('budget_total', T0 + 31_000).drops, 1, '节流窗口内只累积不输出');

        fill(T0 + 50_000);
        governor.checkRequest('svc.Farm', 'Extra', T0 + 61_000);
        assert.equal(governor.buildBudgetSnapshot('budget_total', T0 + 61_000).drops, 0, '满 60s 后再次输出并清零');
    } finally {
        if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
        else process.env.NODE_TEST_CONTEXT = previous;
    }
});

// 回归：三处派发守卫必须按目标实际首发的请求配对检查。
// Enter 属 visitpb.VisitService，CheckCanOperate 属 plantpb.PlantService——
// 写反会静默退化成"检查一个永不发送的方法"（上一版曾写错）。
test('dispatch guards pair each method with its real service', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'services', 'friend-orchestrator.js'), 'utf8');
    const guards = [...src.matchAll(/hasBudget\(Date\.now\(\), 0,\s*\n?\s*(guardReusesPreEnter \? '([^']+)' : '([^']+)'),\s*\n?\s*(guardReusesPreEnter \? '([^']+)' : '([^']+)')\)/g)];
    assert.equal(guards.length, 3, '两处偷菜派发 + 抢收快路径 + 摘要后主循环，共 3 处');
    for (const guard of guards) {
        assert.equal(guard[2], 'gamepb.plantpb.PlantService', 'CheckCanOperate 的服务名');
        assert.equal(guard[3], 'gamepb.visitpb.VisitService', 'Enter 的服务名');
        assert.equal(guard[5], 'CheckCanOperate', '复用预进门分支的首发请求');
        assert.equal(guard[6], 'Enter', '真实进门分支的首发请求');
    }
});
