/**
 * 官方客户端请求频率基准的解析器（core/scripts/analyze-har-rate.js）。
 *
 * 治理器的预算上限必须有依据：官方客户端自己一分钟发多少请求。
 * 这里用一份最小构造的 HAR 验证解析器本身正确，真实基准数据在
 * request-governor.js 的注释里。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { analyze, rpcNameOf, maxInWindow, pickGameSocket } =
    require(path.join(ROOT, 'scripts/analyze-har-rate.js'));

/** 造一帧：protobuf 头部带上服务名和方法名，payload 部分是假的密文 */
function frame(flow, timestamp, service, method) {
    const head = `\n\x19gamepb.${'plantpb'}.${service}\x12${String.fromCharCode(method.length)}${method}`;
    return { flow, timestamp, payload: { buffer: Buffer.from(head, 'latin1').toString('base64') } };
}

test('从帧里解析 RPC 名（服务名和方法名在明文头部）', () => {
    assert.equal(rpcNameOf(frame(0, 1, 'PlantService', 'PutWeeds')), 'PlantService.PutWeeds');
    assert.equal(rpcNameOf({ payload: {} }), '');
    assert.equal(rpcNameOf({ payload: { buffer: 'not-base64!!' } }), '');
});

test('60s 滑动窗口峰值只数窗口内的帧', () => {
    const base = 1_700_000_000_000;
    // 10 帧挤在 30 秒内，另外 5 帧在 2 分钟后
    const burst = Array.from({ length: 10 }, (_, i) => base + i * 3000);
    const later = Array.from({ length: 5 }, (_, i) => base + 120_000 + i * 1000);
    assert.equal(maxInWindow([...burst, ...later]), 10);
});

test('选中帧数最多的那条 WebSocket，忽略无帧的 HTTP 条目', () => {
    const har = {
        log: {
            entries: [
                { request: { url: 'https://example.com/a' } },
                { request: { url: 'wss://x/ws' }, _webSocketMessages: [frame(0, 1, 'A', 'B')] },
                { request: { url: 'wss://y/ws' }, _webSocketMessages: [frame(0, 1, 'A', 'B'), frame(1, 2, 'A', 'C')] },
            ],
        },
    };
    assert.equal(pickGameSocket(har).request.url, 'wss://y/ws');
});

test('完整统计：区分启动与稳态，只数客户端发出的帧', () => {
    const base = 1_700_000_000_000;
    const frames = [];
    // 启动 30s 内：60 帧
    for (let i = 0; i < 60; i++) frames.push(frame(0, base + i * 400, 'PlantService', 'Farming'));
    // 稳态 130s：65 帧（约 30/min）
    for (let i = 0; i < 65; i++) frames.push(frame(0, base + 30_000 + i * 2000, 'PlantService', 'Farming'));
    // 服务端推送不计入
    for (let i = 0; i < 100; i++) frames.push(frame(1, base + i * 100, 'PlantService', 'Farming'));

    const har = { log: { entries: [{ request: { url: 'wss://gate/ws' }, _webSocketMessages: frames }] } };
    const fs = require('node:fs');
    const os = require('node:os');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'har-')), 'x.har');
    fs.writeFileSync(file, JSON.stringify(har));

    const r = analyze(file);
    assert.equal(r.sends, 125, '只数 flow=0 的帧');
    assert.equal(r.bootRequests, 60);
    assert.ok(r.steadyPerMin > 25 && r.steadyPerMin < 35, `稳态应约 30/min，实际 ${r.steadyPerMin}`);
    assert.ok(r.perMethod[0].peak >= 60, '单接口峰值应至少覆盖启动期的 60 帧');
});

// ── 单接口限额必须对齐官方实测，不能所有方法一视同仁 ──

test('per-method limits follow the official capture, not one blanket number', () => {
    const governor = require('../src/services/request-governor');

    // 好友巡查三件套按官方基准（GetGameFriends 20、Enter/Leave 各 16）。
    // 之前统一用 55，三件套能同时吃满 55+55+55=165，占掉总预算 200 的八成，
    // 农场 AllLands/TaskInfo 和牧场 GetRanchDetail 就全被拒掉了。
    assert.equal(governor.methodLimitBase('gamepb.friendpb.FriendService.GetAll'), 20,
        'GetAll 对齐官方 GetGameFriends 20/60s');
    assert.equal(governor.methodLimitBase('gamepb.visitpb.VisitService.Enter'), 16,
        'Enter 对齐官方 16/60s');
    assert.equal(governor.methodLimitBase('gamepb.visitpb.VisitService.Leave'), 16,
        'Leave 对齐官方 16/60s');

    // 其余接口仍用通用上限（官方实测最高单接口 PutWeeds 55）
    assert.equal(governor.methodLimitBase('gamepb.plantpb.PlantService.PutWeeds'), governor.PER_METHOD_LIMIT,
        '除草仍按通用上限');
    assert.equal(governor.methodLimitBase('gamepb.plantpb.PlantService.AllLands'), governor.PER_METHOD_LIMIT,
        '读地块仍是通用上限，确保农场够用');

    // 好友巡查合计 52，给农场/牧场留足 148
    const patrolTotal = 20 + 16 + 16;
    assert.ok(governor.TOTAL_LIMIT - patrolTotal >= 140,
        `好友巡查之外应至少留 140，实际 ${governor.TOTAL_LIMIT - patrolTotal}`);
});
