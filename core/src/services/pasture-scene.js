/**
 * 牧场场景进出
 *
 * 牧场是独立游戏场景（game_scene_id = 2）。这与「用 host_gid 直接读好友牧场」
 * 不是一回事：
 *   - 进场景会带回该场景的初始快照（RanchSceneData.homestead_cells），
 *     里面有格子、设施、牧草机、栏舍，省掉一次 AllCells。
 *   - 场景是全局状态：进牧场期间，农场相关的请求都必须等它切回来。
 *     所以整段「进入 → 操作 → 恢复」都在全局串行锁里完成。
 *
 * 两个必须处理的现实：
 * 1. 旧版登录协议拿不到 unlocked_scene_ids，所以「是否解锁」在拿到推送前是未知的。
 *    未知一律放行（不阻断），只有明确拿到列表且不含 2 时才拒绝。
 * 2. 恢复原场景失败时必须作废当前连接：继续在场景未知的连接上发请求，
 *    农场的数据会被当成牧场数据解析。
 */

const { getUserState, getWs, loginGameScene, invalidateGameScene } = require('../utils/network');
const { types } = require('../utils/proto');
const { logWarn } = require('../utils/utils');
const { runExclusiveAutomationTask } = require('./automation-lock');

/**
 * 上一次真正切进牧场场景的时刻。
 * 场景切换是两次 PlayerSceneLogin，成本远高于一次普通 RPC；高频 tick 里
 * 每次都切会把预算打满、也会让风控画像难看。因此支持「最小间隔」：
 * 间隔内的调用直接就地执行（不切场景），走 host_gid 直连那套已证可用的路径。
 */
let lastEnterAtMs = 0;

/** 牧场场景 ID */
const RANCH_SCENE_ID = 2;

function errOf(code, message) {
    return Object.assign(new Error(message), { code });
}

/**
 * 牧场是否已解锁。
 * 解锁列表为空 = 未知（旧版登录协议拿不到），此时按「可能已解锁」处理，
 * 由接口自己报错，不能因为本地没数据就把功能锁死。
 */
function isRanchUnlocked() {
    const state = getUserState();
    const ids = Array.isArray(state.unlockedSceneIds) ? state.unlockedSceneIds : [];
    if (!ids.length) return true;
    return ids.includes(RANCH_SCENE_ID);
}

/** 当前是否已经在牧场场景里 */
function isInRanchScene() {
    return Number(getUserState().globalSceneId) === RANCH_SCENE_ID;
}

/** 从场景登录回包里解出牧场初始快照（栏舍/设施/格子） */
function decodeRanchCells(scene) {
    const raw = scene && scene.big_farm_scene_ext_data;
    if (!raw || !raw.length) return null;
    try {
        const data = types.RanchSceneData.decode(raw);
        return data.homestead_cells || null;
    } catch (err) {
        logWarn('牧场', `场景初始快照解码失败: ${err.message}`, { module: 'pasture', event: 'pasture_scene_decode' });
        return null;
    }
}

/**
 * 在牧场场景里执行。
 *
 * @param {(cells: any|null) => Promise<any>} run
 *   cells 是进场景时顺带拿到的初始快照；本来就在牧场场景时为 null，
 *   调用方需要自己发 AllCells / GetRanchDetail。
 * @param {{skipScene?: boolean, minIntervalMs?: number}} [options]
 *   skipScene   完全不切场景（只读路径用）
 *   minIntervalMs 距上次进场景不足这个时长时，本轮直接就地执行、不切场景
 */
function inRanchScene(run, options = {}) {
    const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 0);
    return runExclusiveAutomationTask('pasture.scene', async () => {
        if (!isRanchUnlocked()) {
            throw errOf('RANCH_LOCKED', '牧场尚未解锁，请先在游戏中完成开启条件');
        }

        const previous = Number(getUserState().globalSceneId) || 1;
        const socket = getWs();
        const throttled = minIntervalMs > 0
            && previous !== RANCH_SCENE_ID
            && Date.now() - lastEnterAtMs < minIntervalMs;
        const shouldEnter = options.skipScene !== true && previous !== RANCH_SCENE_ID && !throttled;

        let result;
        try {
            const scene = shouldEnter ? await loginGameScene(RANCH_SCENE_ID) : null;
            if (shouldEnter) lastEnterAtMs = Date.now();
            const cells = scene ? decodeRanchCells(scene) : null;
            result = await run(cells);
            return result;
        }
        finally {
            // 断线重连后不再补发场景恢复：重连后的登录流程会重新确立场景。
            if (shouldEnter && getWs() === socket) {
                try {
                    await loginGameScene(previous);
                } catch (err) {
                    logWarn('牧场', `恢复场景 ${previous} 失败：${err.message}`, {
                        module: 'pasture', event: 'pasture_scene_restore',
                    });
                    invalidateGameScene('牧场操作结束后场景恢复未确认，需要重新登录');
                    if (result && typeof result === 'object') {
                        result.sceneRestored = false;
                        result.refreshRequired = true;
                        result.notice = '场景恢复未确认，账号需重新登录；请刷新核对操作结果';
                    }
                }
            }
        }
    });
}

/** 好友牧场进出（EnterHomestead / LeaveHomestead）需要先确保在牧场场景内 */
function requireRanchScene() {
    if (!isInRanchScene()) {
        throw errOf('RANCH_SCENE_REQUIRED', '同步好友需要先进入牧场场景');
    }
}

/** 测试用：清掉场景切换节流时间戳 */
function resetSceneStateForTests() {
    lastEnterAtMs = 0;
}

module.exports = {
    RANCH_SCENE_ID,
    resetSceneStateForTests,
    isRanchUnlocked,
    isInRanchScene,
    decodeRanchCells,
    inRanchScene,
    requireRanchScene,
};