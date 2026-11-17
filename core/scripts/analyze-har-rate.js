#!/usr/bin/env node
/**
 * 从官方客户端 HAR 里统计真实请求频率，给治理器预算提供基准。
 *
 * 为什么不看日志而要抓包：治理器的 60s 窗口上限此前一直是「撞到就调高」
 * 拍出来的数字，和官方客户端实际发多少请求没有任何关系。而 HAR 里
 * 游戏 WebSocket 的每一帧都带 flow（0=客户端发出）和时间戳，protobuf
 * 头部还是明文服务名，所以官方频率和单接口峰值都能直接数出来。
 *
 * 用法：
 *   node scripts/analyze-har-rate.js <har-path> [--json]
 *
 * 注意：HAR 含登录 code 和 gid，不要提交。只提交本脚本和它算出的结论。
 */

const fs = require('node:fs');

const RPC_RE = /gamepb\.[a-z]+\.(\w+Service)/;
const METHOD_RE = /\x12[\x00-\x7f]([A-Z][A-Za-z0-9_]{2,40})/;
const WINDOW_MS = 60_000;

/** 从一帧里取 RPC 名。请求 payload 是加密的，但服务名和方法名在明文头部。 */
function rpcNameOf(frame) {
    const raw = frame && frame.payload && frame.payload.buffer;
    if (!raw) return '';
    let buf;
    try {
        buf = Buffer.from(raw, 'base64');
    } catch {
        return '';
    }
    // 在整个 buffer 上按 binary 模式匹配（JS 的 \x00-\x7f 在字符串里会破坏字节）
    const text = buf.toString('latin1');
    const svc = RPC_RE.exec(text);
    if (!svc) return '';
    const tail = text.slice(svc.index + svc[0].length, svc.index + svc[0].length + 40);
    const meth = METHOD_RE.exec(tail);
    return meth ? `${svc[1]}.${meth[1]}` : svc[1];
}

function maxInWindow(timestamps, windowMs = WINDOW_MS) {
    const ts = timestamps.slice().sort((a, b) => a - b);
    let best = 0;
    let left = 0;
    for (let right = 0; right < ts.length; right++) {
        while (ts[right] - ts[left] >= windowMs) left++;
        best = Math.max(best, right - left + 1);
    }
    return best;
}

/** 找到游戏 WebSocket 的那条 HAR 记录（取帧数最多的一条）。 */
function pickGameSocket(har) {
    const entries = (har.log && har.log.entries) || [];
    let best = null;
    for (const entry of entries) {
        const frames = entry._webSocketMessages;
        if (!Array.isArray(frames) || !frames.length) continue;
        if (!best || frames.length > best._webSocketMessages.length) best = entry;
    }
    return best;
}

function analyze(harPath) {
    const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    const socket = pickGameSocket(har);
    if (!socket) throw new Error('HAR 里没有带帧数据的 WebSocket；导出时要勾选保留 WS 消息');

    const frames = socket._webSocketMessages;
    const sends = frames
        .filter(f => f.flow === 0 && f.timestamp)
        .map(f => ({ at: f.timestamp, rpc: rpcNameOf(f) }))
        .sort((a, b) => a.at - b.at);
    if (!sends.length) throw new Error('没有解析到客户端发出的帧');

    const t0 = sends[0].at;
    const spanSec = (sends[sends.length - 1].at - t0) / 1000;

    // 启动阶段单独看：加载期会集中拉一大堆数据，不能当成稳态
    const BOOT_MS = 30_000;
    const boot = sends.filter(s => s.at - t0 < BOOT_MS);
    const steady = sends.filter(s => s.at - t0 >= BOOT_MS);
    const steadySec = Math.max(1, spanSec - BOOT_MS / 1000);

    const byRpc = new Map();
    for (const s of sends) {
        if (!s.rpc) continue;
        byRpc.set(s.rpc, (byRpc.get(s.rpc) || 0) + 1);
    }
    const perMethod = [...byRpc.entries()]
        .map(([rpc, total]) => ({
            rpc,
            total,
            peak: maxInWindow(sends.filter(s => s.rpc === rpc).map(s => s.at)),
        }))
        .sort((a, b) => b.peak - a.peak);

    return {
        url: socket.request.url,
        frames: frames.length,
        sends: sends.length,
        spanSec: Math.round(spanSec),
        bootRequests: boot.length,
        bootPerMin: Math.round(boot.length / (BOOT_MS / 60_000)),
        steadyRequests: steady.length,
        steadyPerMin: Number((steady.length / steadySec * 60).toFixed(1)),
        peakPerMin: maxInWindow(sends.map(s => s.at)),
        unidentified: sends.filter(s => !s.rpc).length,
        perMethod,
    };
}

function printReport(r) {
    console.log(`WebSocket: ${r.url.split('?')[0]}`);
    console.log(`抓包时长 ${r.spanSec}s，客户端发出 ${r.sends} 帧（未识别 RPC 名 ${r.unidentified}）`);
    console.log('');
    console.log(`启动 30s 内: ${r.bootRequests} 次 = ${r.bootPerMin} 次/分钟`);
    console.log(`30s 后稳态: ${r.steadyRequests} 次 = ${r.steadyPerMin} 次/分钟`);
    console.log(`滑动 60s 窗口峰值: ${r.peakPerMin} 次`);
    console.log('');
    console.log('单接口 60s 峰值:');
    for (const m of r.perMethod.slice(0, 12)) {
        console.log(`  ${m.rpc.padEnd(52)} 峰值 ${String(m.peak).padStart(2)}/60s   总 ${m.total}`);
    }
}

if (require.main === module) {
    const target = process.argv[2];
    if (!target) {
        console.error('用法: node scripts/analyze-har-rate.js <har-path> [--json]');
        process.exit(1);
    }
    const result = analyze(target);
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else printReport(result);
}

module.exports = { analyze, rpcNameOf, maxInWindow, pickGameSocket };