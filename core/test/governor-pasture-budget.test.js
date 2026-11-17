/**
 * 治理器预算：牧场接入后不该被好友巡查饿死。
 *
 * 真机现象：60s 窗口 80/80 被 FriendService.GetAll×22 + Visit Enter/Leave 各 22
 * 吃满，牧场 GetRanchDetail 与 TaskInfo 被 budget_total 连带拦掉，
 * 日志刷「检查失败: 请求被治理器拦截」。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const governor = require(path.join(ROOT, 'src/services/request-governor.js'));

const FRIEND_SVC = 'gamepb.friendpb.FriendService';
const VISIT_SVC = 'gamepb.visitpb.VisitService';
const ANIMAL_SVC = 'gamepb.animalpb.AnimalService';

test('预算对齐官方客户端实测：总量 200 / 单接口 55', () => {
    // 官方实测：稳态 113 次/分钟，60s 峰值 278 次，最高单接口峰值 55（PutWeeds）
    assert.equal(governor.TOTAL_LIMIT, 200);
    assert.equal(governor.PER_METHOD_LIMIT, 55);
});

test('好友巡查吃满 66 次后，牧场仍拿得到 GetRanchDetail 预算', () => {
    governor.resetForTest();
    const now = Date.now();

    // 一轮好友巡查：22 好友 × (GetAll + Enter + Leave)
    for (let i = 0; i < 22; i++) {
        governor.recordSent(FRIEND_SVC, 'GetAll', true, now);
        governor.recordSent(VISIT_SVC, 'Enter', true, now);
        governor.recordSent(VISIT_SVC, 'Leave', true, now);
    }
    const check = governor.checkRequest(ANIMAL_SVC, 'GetRanchDetail', now);
    assert.equal(check.allowed, true, `牧场应仍可放行，实际 reason=${check.reason}`);
});

test('越过上限后牧场照样被拦：护栏本身不能失效', () => {
    governor.resetForTest();
    const now = Date.now();
    // 越过总量上限
    for (let i = 0; i < 69; i++) {
        governor.recordSent(FRIEND_SVC, 'GetAll', true, now);
        governor.recordSent(VISIT_SVC, 'Enter', true, now);
        governor.recordSent(VISIT_SVC, 'Leave', true, now);
    }
    const check = governor.checkRequest(ANIMAL_SVC, 'GetRanchDetail', now);
    assert.equal(check.reason, 'budget_total', '越过上限时仍然要拦，护栏不能失效');
});

test('hasBudget 对牧场给出与 checkRequest 一致的判断', () => {
    governor.resetForTest();
    const now = Date.now();
    assert.equal(governor.hasBudget(now, 0, ANIMAL_SVC, 'GetRanchDetail'), true);

    for (let i = 0; i < 210; i++) governor.recordSent(FRIEND_SVC, 'GetAll', true, now);
    assert.equal(governor.hasBudget(now, 0, ANIMAL_SVC, 'GetRanchDetail'), false);
    assert.equal(governor.checkRequest(ANIMAL_SVC, 'GetRanchDetail', now).allowed, false);
});

test('预算快照默认给到 8 项，够看出窗口被谁占满', () => {
    governor.resetForTest();
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
        governor.recordSent(`gamepb.svc${i}.Svc`, 'Call', true, now);
    }
    const snap = governor.buildBudgetSnapshot('budget_total', now);
    assert.ok(snap.top.length >= 8, `应至少 8 项，实际 ${snap.top.length}`);
});
