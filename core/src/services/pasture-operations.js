/**
 * 牧场「结果未知」账本
 *
 * 牧场有一批动作是不可逆的花钱操作（买东西、兑换、升级、放养、喂罐头）。
 * 如果请求已经写进 socket、却在收到回包前断线或超时，本地其实不知道服务端
 * 有没有执行 —— 这时候重发就是一次真实的重复扣费。
 *
 * 所以：写操作先落盘一条记录，成功就删掉；失败时按「有没有真的发出去」决定
 * 是撤销记录（网关层拒绝，肯定没执行）还是保留并标记（结果未知，等人工核对）。
 * 记录里的 costs 同时充当「预留额度」，避免同一笔钱被两个未核对操作重复花掉。
 *
 * 文件：<dataDir>/pasture-operations/<sha256(accountId)>.json
 * 结构：[{ id, target, label, costs:[{resourceKey, amount}], createdAt, message }]
 */

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { log } = require('../utils/utils');

const FILE_DIR = 'pasture-operations';

function dataDir() {
    return process.env.FARM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
}

function fileFor(accountId) {
    const key = String(accountId == null ? '' : accountId);
    if (!key) {
        throw Object.assign(new Error('牧场操作缺少账号标识'), { code: 'RANCH_ACCOUNT_REQUIRED' });
    }
    const hash = createHash('sha256').update(key).digest('hex');
    return path.join(dataDir(), FILE_DIR, `${hash}.json`);
}

function invalid(message) {
    return Object.assign(new Error(message || '牧场待核对记录格式错误，请检查数据文件'), {
        code: 'RANCH_STATE_INVALID',
    });
}

/** 严格校验：任何一条不合规整体拒绝，避免拿坏数据做余额判断。 */
function validate(list) {
    if (!Array.isArray(list)) throw invalid();
    for (const row of list) {
        if (!row || typeof row !== 'object') throw invalid();
        if (typeof row.id !== 'string' || !row.id) throw invalid();
        if (typeof row.target !== 'string' || !row.target) throw invalid();
        if (!Array.isArray(row.costs)) throw invalid();
        for (const cost of row.costs) {
            if (!cost || !/^item:\d+$/.test(String(cost.resourceKey))) throw invalid();
            if (!/^\d+$/.test(String(cost.amount))) throw invalid();
        }
    }
    return list;
}

function load(accountId) {
    const file = fileFor(accountId);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    try {
        return validate(JSON.parse(raw));
    } catch (err) {
        // 文件坏了就 fail closed：报错而不是当成「没有待核对操作」继续花钱。
        throw err.code === 'RANCH_STATE_INVALID' ? err : invalid();
    }
}

function save(accountId, list) {
    const file = fileFor(accountId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

/** 未决记录（原样返回，供面板展示与余额预留） */
function pending(accountId) {
    return load(accountId);
}

/** 所有未决记录里同一资源的预留总额（十进制字符串） */
function reserved(accountId, resourceKey) {
    let total = 0n;
    for (const row of load(accountId)) {
        for (const cost of row.costs) {
            if (cost.resourceKey === resourceKey) total += BigInt(cost.amount);
        }
    }
    return total.toString();
}

function addPending(accountId, entry) {
    const record = {
        id: randomUUID(),
        target: String(entry.target || ''),
        label: String(entry.label || ''),
        costs: (entry.costs || []).map(c => ({
            resourceKey: String(c.resourceKey),
            amount: String(c.amount),
        })),
        createdAt: Date.now(),
        message: String(entry.message || '操作结果待核对').slice(0, 300),
    };
    if (!record.target) throw invalid('牧场待核对记录缺少目标');
    const list = load(accountId);
    list.push(record);
    save(accountId, list);
    return record;
}

function updateMessage(accountId, id, message) {
    const list = load(accountId);
    const next = list.map(row => (row.id === id
        ? { ...row, message: String(message || row.message).slice(0, 300) }
        : row));
    save(accountId, next);
}

/**
 * 人工核对后解除保护。找不到该记录说明已被处理过（可能是另一个页面点了两次）。
 */
function acknowledge(accountId, id) {
    const list = load(accountId);
    if (!list.some(row => row.id === id)) {
        throw Object.assign(new Error('这条记录已处理，请刷新'), { code: 'RANCH_STATE_CHANGED' });
    }
    save(accountId, list.filter(row => row.id !== id));
}

/** 同 target 已有未决记录 → 拒绝重发 */
function hasPendingTarget(accountId, target) {
    return load(accountId).some(row => row.target === target);
}

/** 供测试/运维：清空该账号的账本 */
function clear(accountId) {
    try {
        const file = fileFor(accountId);
        if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
        log('牧场', `清理待核对账本失败: ${err.message}`, { module: 'pasture' });
    }
}

module.exports = {
    fileFor,
    pending,
    reserved,
    addPending,
    updateMessage,
    acknowledge,
    hasPendingTarget,
    clear,
    validate,
};