/**
 * 牧场场景进出测试
 *
 * 场景是全局状态，错一步就会让后续请求打到错的地方，所以这里逐条锁住：
 * 未解锁不登录、已在场不重复登录、离开时必须切回原场景、恢复失败要作废连接、
 * 断线重连后不补发恢复、节流窗口内不切场景。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

const events = [];
let state = null;
let socket = null;
let failRestore = false;

const networkId = require.resolve(path.join(SRC, 'utils', 'network'));
require.cache[networkId] = {
    id: networkId,
    filename: networkId,
    loaded: true,
    exports: {
        getUserState: () => state,
        getWs: () => socket,
        loginGameScene: async (sceneId) => {
            events.push(`login:${sceneId}`);
            if (failRestore && sceneId === 1)
                throw new Error('restore failed');
            state.globalSceneId = sceneId;
            return { global_scene_id: sceneId, big_farm_scene_ext_data: Buffer.alloc(0) };
        },
        invalidateGameScene: (reason) => {
            events.push(`invalidate:${reason}`);
        },
    },
};

const scene = require(path.join(SRC, 'services', 'pasture-scene'));

function reset(overrides = {}) {
    events.length = 0;
    state = { gid: 1, globalSceneId: 1, unlockedSceneIds: [1, 2], ...overrides };
    socket = { id: 'sock-1' };
    failRestore = false;
    scene.resetSceneStateForTests();
}

test('未解锁（列表明确不含 2）时拒绝进场景，也不发任何登录', async () => {
    reset({ unlockedSceneIds: [1] });
    await assert.rejects(() => scene.inRanchScene(async () => 'x'), (err) => err.code === 'RANCH_LOCKED');
    assert.deepEqual(events, [], '未解锁不该有任何网络动作');
});

test('解锁列表未知（空数组）时放行，不把功能锁死', async () => {
    reset({ unlockedSceneIds: [] });
    assert.equal(scene.isRanchUnlocked(), true);
    const result = await scene.inRanchScene(async () => 'ok');
    assert.equal(result, 'ok');
    assert.deepEqual(events, ['login:2', 'login:1'], '进场景后必须切回原场景');
});

test('从农场进牧场：先登录 2，执行后切回 1', async () => {
    reset();
    const result = await scene.inRanchScene(async (cells) => {
        assert.equal(cells, null, '空场景数据时给 null，由调用方自己发 AllCells');
        return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(events, ['login:2', 'login:1']);
    assert.equal(state.globalSceneId, 1, '离开后场景必须回到原值');
});

test('已经在牧场场景时：不重复登录，也不做恢复', async () => {
    reset({ globalSceneId: 2 });
    const result = await scene.inRanchScene(async (cells) => {
        assert.equal(cells, null);
        return 'inside';
    });
    assert.equal(result, 'inside');
    assert.deepEqual(events, [], '已在场景内不该有任何登录动作');
});

test('恢复原场景失败：作废连接，并把结果标成未确认', async () => {
    reset();
    failRestore = true;
    const result = await scene.inRanchScene(async () => ({ status: 'confirmed' }));
    assert.deepEqual(events.slice(0, 2), ['login:2', 'login:1']);
    assert.ok(events.some(e => e.startsWith('invalidate:')), '必须作废当前连接');
    assert.equal(result.sceneRestored, false);
    assert.equal(result.refreshRequired, true);
    assert.match(result.notice, /重新登录/);
});

test('执行期间断线重连后，不再补发场景恢复', async () => {
    reset();
    await scene.inRanchScene(async () => {
        socket = { id: 'sock-2' };   // 模拟重连：socket 引用变了
        return 'x';
    });
    assert.deepEqual(events, ['login:2'], '重连后由登录流程统一确立场景，不能再补发 login:1');
});

test('节流窗口内不切场景，直接就地执行', async () => {
    reset();
    await scene.inRanchScene(async () => 'first', { minIntervalMs: 60_000 });
    assert.deepEqual(events, ['login:2', 'login:1']);

    events.length = 0;
    state.globalSceneId = 1;
    const second = await scene.inRanchScene(async () => 'second', { minIntervalMs: 60_000 });
    assert.equal(second, 'second');
    assert.deepEqual(events, [], '窗口内不该再切场景');
});

test('skipScene 完全不碰场景', async () => {
    reset();
    await scene.inRanchScene(async () => 'x', { skipScene: true });
    assert.deepEqual(events, []);
});

test('串行：两个并发 inRanchScene 不会交错进场景', async () => {
    reset();
    let peak = 0;
    let active = 0;
    const task = () => scene.inRanchScene(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
    });

    await Promise.all([task(), task()]);
    assert.equal(peak, 1, '同一时刻只能有一个流程占用场景');
    // 串行的两个任务各自完整进出一次：进 2 → 回 1 → 进 2 → 回 1
    assert.deepEqual(events, ['login:2', 'login:1', 'login:2', 'login:1'],
        '第二个任务必须等第一个恢复完场景后才进，且自己也要恢复');
});