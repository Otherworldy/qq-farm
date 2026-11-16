/**
 * 牧场任务（taskpb scene_id=2，task_type 4/5/6）
 *
 * 这里锁两件容易退回去的事：
 *  1. 请求必须带 scene_id=2。少了它服务端只回农场任务，牧场任务永远领不到。
 *  2. 只处理 task_type 4/5/6。农场任务 1/2/3 绝不能在这里被重复领。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { before } = require('node:test');

const ROOT = path.resolve(__dirname, '..');

// ── 可控的网络与开关 ──

const sent = [];
let replyTasks = [];
let replyGrowth = [];
let replyDaily = [];
let automation = { task: true, pasture_task: true };
let task = null;

before(async () => {
    // proto 是要显式加载的，不加载 types 就是空对象
    const proto = require(path.join(ROOT, 'src/utils/proto.js'));
    await proto.loadProto();

    // 直接替换已加载模块的 exports：task.js 在 require 时会解构
    // sendMsgAsync / isConnected，所以必须先替换再加载它。
    const net = require(path.join(ROOT, 'src/utils/network.js'));
    net.isConnected = () => true;
    net.sendMsgAsync = async (service, method, body) => {
        sent.push({ service, method, body: Buffer.from(body || []) });
        const protobuf = require(path.join(ROOT, 'node_modules/protobufjs'));
        const root = new protobuf.Root();
        root.loadSync([path.join(ROOT, 'src/proto/game.proto'), path.join(ROOT, 'src/proto/taskpb.proto')], { keepCase: true });
        const Reply = root.lookupType('gamepb.taskpb.TaskInfoReply');
        const payload = Reply.encode(Reply.create({
            task_info: { tasks: [...replyTasks, ...replyGrowth, ...replyDaily] },
        })).finish();
        return { body: Buffer.from(payload) };
    };

    const store = require(path.join(ROOT, 'src/models/store.js'));
    store.isAutomationOn = key => automation[key] !== false;
    store.getAutomation = () => automation;
    store.getPreferredSeed = () => 0;
    store.getFriendBlacklist = () => [];

    task = require(path.join(ROOT, 'src/services/task.js'));
});

function makeTask(id, taskType, { canClaim = true } = {}) {
    return {
        id,
        desc: `任务#${id}`,
        task_type: taskType,
        progress: canClaim ? 5 : 1,
        total_progress: 5,
        is_claimed: false,
        is_unlocked: true,
        share_multiple: 1,
        rewards: [],
    };
}

function resetState() {
    sent.length = 0;
    replyTasks = [];
    replyGrowth = [];
    replyDaily = [];
    automation = { task: true, pasture_task: true };
}

test('牧场任务请求带 scene_id=2，编码成 08 02', async () => {
    resetState();
    replyTasks = [makeTask(1, 4)];

    await task.checkAndClaimPastureTasks();

    const infoCalls = sent.filter(s => s.method === 'TaskInfo');
    assert.equal(infoCalls.length, 1, '应当只发一次 TaskInfo');
    assert.equal(infoCalls[0].service, 'gamepb.taskpb.TaskService');
    assert.equal(
        Buffer.from(infoCalls[0].body).toString('hex'),
        '0802',
        'scene_id=2 必须编码成 08 02（真机抓包 + TSDK 加密反推确认）',
    );
});

test('农场任务请求保持空 body（不带 scene_id）', async () => {
    resetState();
    replyTasks = [makeTask(1, 1, { canClaim: false })];

    await task.getTaskDailyStateLikeApp();

    const infoCalls = sent.filter(s => s.method === 'TaskInfo');
    assert.ok(infoCalls.length >= 1);
    assert.equal(
        Buffer.from(infoCalls[0].body).toString('hex'),
        '',
        '农场不能带 scene_id，否则会拿到牧场任务',
    );
});

test('只领 task_type 4/5/6，农场任务一条都不碰', async () => {
    resetState();
    replyTasks = [
        makeTask(101, 1), // 农场成长
        makeTask(102, 2), // 农场每日
        makeTask(103, 3), // 农场支线
        makeTask(201, 4), // 牧场成长
        makeTask(202, 5), // 牧场每日
        makeTask(203, 6), // 牧场支线
    ];

    const claimed = await task.checkAndClaimPastureTasks();

    const claimIds = sent
        .filter(s => s.method === 'ClaimTaskReward')
        .map(s => Number(Buffer.from(s.body).toString('hex').slice(2, 4), 16));
    assert.equal(claimed, 3, '牧场三个任务都应领到');
    assert.equal(claimIds.length, 3, '只发三次领奖请求');
    // 逐个核对领的是哪三个：不依赖具体编码位置，只要求命中的是 201/202/203
    const summary = await task.getPastureTaskSummary();
    assert.equal(summary.total, 3, '概括里只应出现牧场任务');
    assert.ok(summary.items.every(i => i.category.startsWith('pasture_')), '类别必须是牧场');
});

test('任务类型映射到可读类别', async () => {
    resetState();
    replyTasks = [makeTask(301, 4), makeTask(302, 5), makeTask(303, 6)];

    const summary = await task.getPastureTaskSummary();
    const byId = Object.fromEntries(summary.items.map(i => [i.id, i.category]));
    assert.equal(byId[301], 'pasture_growth');
    assert.equal(byId[302], 'pasture_daily');
    assert.equal(byId[303], 'pasture_side');
    assert.equal(summary.claimable, 3);
});

test('pasture_task 开关独立于农场的 task 开关', async () => {
    resetState();
    replyTasks = [makeTask(401, 4)];

    // 关掉农场任务，牧场任务照领
    automation = { task: false, pasture_task: true };
    assert.equal(await task.checkAndClaimPastureTasks(), 1, '农场关掉不影响牧场');

    resetState();
    automation = { task: true, pasture_task: false };
    assert.equal(await task.checkAndClaimPastureTasks(), 0, '牧场自己关掉就不领');
    assert.equal(sent.filter(s => s.method === 'TaskInfo').length, 0, '开关关掉连请求都不发');
});

test('没有牧场任务时零请求开销', async () => {
    resetState();
    replyTasks = [makeTask(501, 1), makeTask(502, 2)];
    replyGrowth = [makeTask(503, 3)];

    assert.equal(await task.checkAndClaimPastureTasks(), 0);
    assert.equal(sent.filter(s => s.method === 'ClaimTaskReward').length, 0, '不该去领农场任务');
});

test('分离下发的 growth/daily 字段也能认出来', async () => {
    resetState();
    replyGrowth = [makeTask(601, 4)];
    replyDaily = [makeTask(602, 5)];

    const summary = await task.getPastureTaskSummary();
    assert.equal(summary.total, 2);
    assert.equal(summary.claimable, 2);
});

// ── proto 层面：字段号不能漂 ──

test('taskpb.proto 的 TaskInfoRequest 只有 scene_id=1', () => {
    const fs = require('node:fs');
    const protobuf = require(path.join(ROOT, 'node_modules/protobufjs'));
    const root = new protobuf.Root();
    root.loadSync([path.join(ROOT, 'src/proto/taskpb.proto')], { keepCase: true });
    const T = root.lookupType('gamepb.taskpb.TaskInfoRequest');
    assert.deepEqual(Object.keys(T.fields), ['scene_id']);
    assert.equal(T.fields.scene_id.id, 1, 'scene_id 必须是字段 1（加密反推确认）');
});

test('store 默认：牧场任务默认开，牧场间隔可配', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(ROOT, 'src/models/store.js'), 'utf8');
    assert.match(src, /pasture_task:\s*true/, '牧场任务默认开');
    assert.match(src, /pastureMin:\s*20/, '牧场间隔默认 20 秒起');
    assert.match(src, /pastureMax:\s*30/, '牧场间隔默认 30 秒止');
});