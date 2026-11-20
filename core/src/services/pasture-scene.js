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
const { CONFIG } = require('../config/config');
const { runExclusiveAutomationTask } = require('./automation-lock');

/**
 * 上一次真正切进牧场场景的时刻。
 * 场景切换是两次 PlayerSceneLogin，成本远高于一次普通 RPC；高频 tick 里
 * 每次都切会把预算打满、也会让风控画像难看。因此支持「最小间隔」：
 * 间隔内的调用直接就地执行（不切场景），走 host_gid 直连那套已证可用的路径。
 */
let lastEnterAtMs = 0;

/**
 * 场景锁定后多久再探测一次。
 * 牧场 RPC 在场景外本来就能用，所以场景只是个增强项：探测失败就退回直连，
 * 半小时后再试一次，既不刷错误日志、也不会因为一次失败永久放弃。
 */
const SCENE_RETRY_MS = 30 * 60_000;

/**
 * 只有 QQ 端才有「切全局场景」这条链路。
 *
 * 微信小游戏（platform=wx）的主包 JS 里根本没有 PlayerSceneLogin /
 * GlobalSceneService 的调用，客户端也从不切场景；牧场相关 RPC 在
 * scene 1 下直连就能读能写（真机验证：收获、投喂、清理、生产、捡蛋、
 * 集市、分享、任务、好友全部正常）。所以微信端不做任何场景尝试，
 * 既不发注定被拒的请求，也不会把「该场景还未解锁」写进日志误导人。
 */
function supportsGlobalScene() {
    return CONFIG.platform === 'qq';
}

/** 服务端明确回「该场景还未解锁」时，把它当成「场景不可用」处理 */
function isSceneLockedError(err) {
    if (!err) return false;
    if (Number(err.code) === 1045002) return true;
    return /1045002|还未解锁/.test(String(err.message || ''));
}

/** 是否处于「已确认未解锁」的冷却期 */
function isRanchSceneBlocked() {
    const at = Number(getUserState().ranchSceneBlockedAt) || 0;
    return at > 0 && Date.now() - at < SCENE_RETRY_MS;
}

function markRanchSceneBlocked(reason) {
    const state = getUserState();
    if (Number(state.ranchSceneBlockedAt) > 0) return;
    state.ranchSceneBlockedAt = Date.now();
    logWarn('牧场', `进牧场场景被拒（${reason}），改为直连执行，${Math.round(SCENE_RETRY_MS / 60_000)} 分钟后重新探测`, {
        module: 'pasture', event: 'pasture_scene_blocked', result: 'warn',
    });
}

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
 * @param {{skipScene?: boolean, minIntervalMs?: number, onLocked?: 'fallback'|'throw'}} [options]
 *   skipScene   完全不切场景（只读路径用）
 *   minIntervalMs 距上次进场景不足这个时长时，本轮直接就地执行、不切场景
 *   onLocked    场景不可用时的策略，默认 'fallback' 就地执行。
 *               牧场接口在场景外本来就可用（实测能读详情、能领任务），
 *               因此只有真正依赖场景快照的调用方才该传 'throw'。
 */
function inRanchScene(run, options = {}) {
    const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 0);
    const onLocked = options.onLocked === 'throw' ? 'throw' : 'fallback';
    return runExclusiveAutomationTask('pasture.scene', async () => {
        // 走直连时把原因带回结果，调用方/面板能看出这次没进场景。
        const runWithoutScene = async (why) => {
            if (onLocked === 'throw') {
                throw errOf('RANCH_LOCKED', `牧场场景不可用（${why}），请先在游戏中完成开启条件`);
            }
            const result = await run(null);
            if (result && typeof result === 'object') result.sceneSkipped = why;
            return result;
        };

        if (!supportsGlobalScene()) return runWithoutScene('platform_unsupported');
        if (!isRanchUnlocked()) return runWithoutScene('not_unlocked');
        if (isRanchSceneBlocked()) return runWithoutScene('scene_locked');

        const previous = Number(getUserState().globalSceneId) || 1;
        const socket = getWs();
        const throttled = minIntervalMs > 0
            && previous !== RANCH_SCENE_ID
            && Date.now() - lastEnterAtMs < minIntervalMs;
        const shouldEnter = options.skipScene !== true && previous !== RANCH_SCENE_ID && !throttled;

        let result;
        let entered = false;
        try {
            let scene = null;
            if (shouldEnter) {
                try {
                    scene = await loginGameScene(RANCH_SCENE_ID);
                    entered = true;
                    lastEnterAtMs = Date.now();
                } catch (err) {
                    // 场景没解锁不是故障：记住它，本轮直连把活干完，别让整轮牧场失败。
                    if (!isSceneLockedError(err)) throw err;
                    markRanchSceneBlocked(err.message);
                    return await runWithoutScene('scene_locked');
                }
            }
            const cells = scene ? decodeRanchCells(scene) : null;
            result = await run(cells);
            return result;
        }
        finally {
            // 只在真的进过场景后才谈恢复：进场景就失败时本来还留在原场景，
            // 再发一次 loginGameScene(previous) 纯属浪费，失败还会误判成场景异常。
            // 断线重连后也不补发，重连后的登录流程会重新确立场景。
            if (entered && getWs() === socket) {
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
    getUserState().ranchSceneBlockedAt = 0;
}

module.exports = {
    RANCH_SCENE_ID,
    supportsGlobalScene,
    resetSceneStateForTests,
    isRanchUnlocked,
    isRanchSceneBlocked,
    isInRanchScene,
    decodeRanchCells,
    inRanchScene,
    requireRanchScene,
};