#!/usr/bin/env node

/**
 * 从本机微信客户端缓存解出小游戏源码包。
 *
 * 只读取本机已下载的 .wxapkg，解密后解包到输出目录，不修改微信缓存。
 * 支持 Windows / macOS 微信，自动识别 Windows PC 端的 V1MMWX 加密。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_APPID = 'wx5306c5978fdb76e4';
const MAGIC = 'V1MMWX';
const AES_IV = Buffer.from('the iv: 16 bytes');
const PBKDF2_SALT = 'saltiest';
const MAX_DEPTH = 7;

function parseArgs(argv) {
  const requireValue = (value, flag) => {
    if (value === undefined) throw new Error(`${flag} 缺少参数值`);
    return value;
  };
  const args = { appid: DEFAULT_APPID, list: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--appid') args.appid = requireValue(argv[++index], value);
    else if (value === '--package') args.package = path.resolve(requireValue(argv[++index], value));
    else if (value === '--out') args.out = path.resolve(requireValue(argv[++index], value));
    else if (value === '--list') args.list = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`未知参数：${value}`);
  }
  args.out = args.out || path.join(os.tmpdir(), `qqfarm-${args.appid}`);
  return args;
}

function usage() {
  return [
    '从本机微信缓存解密并解包小游戏 .wxapkg。',
    '',
    '用法：',
    '  npm run unpack:wx',
    '  npm run unpack:wx -- --appid wx5306c5978fdb76e4 --out ./tmp-unpack',
    '  npm run unpack:wx -- --package "C:\\\\...\\\\packages\\\\wx5306c5978fdb76e4\\\\75" --list',
    '',
    '选项：',
    '  --appid <id>     小游戏 AppID，默认 wx5306c5978fdb76e4',
    '  --package <目录> 直接指定包含 .wxapkg 的目录，跳过自动探测',
    '  --out <目录>     输出目录，默认系统临时目录',
    '  --list           只列出包和文件，不写出',
  ].join('\n');
}

/** 微信各版本/平台可能落地的包根目录，按优先级排列。 */
function packageSearchRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Tencent', 'xwechat', 'radium', 'users'));
    roots.push(path.join(home, 'Documents', 'xwechat_files'));
    roots.push(path.join(home, 'Documents', 'WeChat Files', 'Applet'));
  }
  if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users'));
    roots.push(path.join(home, 'Library/Containers/com.tencent.xinWeChat/Data/.wxapplet'));
    roots.push(path.join(home, 'Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat'));
  }
  return roots.filter(root => fs.existsSync(root));
}

/** 在有限深度内查找名为 appid 的目录，且目录直接包含 .wxapkg。 */
function findPackageDirs(root, appid, depth = 0, found = []) {
  if (depth > MAX_DEPTH) return found;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  const holdsPackages = (dir) => {
    try {
      return fs.readdirSync(dir).some(name => name.endsWith('.wxapkg'));
    } catch {
      return false;
    }
  };
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === appid) {
      if (holdsPackages(full)) found.push(full);
      let versions = [];
      try {
        versions = fs.readdirSync(full, { withFileTypes: true })
          .filter(item => item.isDirectory())
          .map(item => path.join(full, item.name))
          .filter(holdsPackages);
      } catch {
        versions = [];
      }
      found.push(...versions);
      continue;
    }
    findPackageDirs(full, appid, depth + 1, found);
  }
  return found;
}

/** 版本目录名可能是数字（74/75），也可能是别的；优先数字最大，其次 mtime 最新。 */
function pickLatestPackageDir(dirs) {
  if (!dirs.length) return null;
  const scored = dirs.map((dir) => {
    const name = path.basename(dir);
    const numeric = /^\d+$/.test(name) ? Number(name) : null;
    const mtime = fs.statSync(dir).mtimeMs;
    return { dir, numeric, mtime };
  });
  scored.sort((left, right) => {
    if (left.numeric !== null && right.numeric !== null) return right.numeric - left.numeric;
    if (left.numeric !== null) return -1;
    if (right.numeric !== null) return 1;
    return right.mtime - left.mtime;
  });
  return scored[0].dir;
}

/** Windows PC 微信的 V1MMWX 加密：AES-256-CBC 前 1024 字节 + 剩余整段 XOR。 */
function decryptWxapkg(buffer, appid) {
  if (buffer.slice(0, MAGIC.length).toString('latin1') !== MAGIC) return buffer;
  if (buffer.length < 1030) throw new Error('wxapkg 过短或已截断');
  const key = crypto.pbkdf2Sync(appid, PBKDF2_SALT, 1000, 32, 'sha1');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, AES_IV);
  decipher.setAutoPadding(false);
  const head = Buffer.concat([decipher.update(buffer.slice(6, 1030)), decipher.final()]);
  const xorKey = appid.length >= 2 ? appid.charCodeAt(appid.length - 2) : 0x66;
  const rest = Buffer.from(buffer.slice(1030));
  for (let index = 0; index < rest.length; index += 1) rest[index] ^= xorKey;
  const plain = Buffer.concat([head.slice(0, 1023), rest]);
  if (plain[0] !== 0xbe) throw new Error('解密结果不是 wxapkg，请确认 --appid 与包目录一致');
  return plain;
}

function readU32(buffer, offset) {
  if (offset + 4 > buffer.length) throw new Error('wxapkg 索引越界');
  return buffer.readUInt32BE(offset);
}

/** wxapkg 结构：0xBE + 长度字段 + 0xED + 文件数 + 索引项。 */
function parseWxapkg(buffer) {
  if (buffer[0] !== 0xbe || buffer[13] !== 0xed) {
    throw new Error(`不是 wxapkg（头部 ${buffer.slice(0, 16).toString('hex')}）`);
  }
  const indexLength = readU32(buffer, 5);
  if (18 + indexLength > buffer.length) throw new Error('wxapkg 索引长度越界');
  const count = readU32(buffer, 14);
  const files = [];
  let offset = 18;
  for (let index = 0; index < count; index += 1) {
    const nameLength = readU32(buffer, offset);
    offset += 4;
    if (offset + nameLength > buffer.length) throw new Error('wxapkg 文件名越界');
    const name = buffer.slice(offset, offset + nameLength).toString('utf8');
    offset += nameLength;
    const start = readU32(buffer, offset);
    offset += 4;
    const size = readU32(buffer, offset);
    offset += 4;
    if (start + size > buffer.length) throw new Error(`wxapkg 数据越界：${name}`);
    files.push({ name: name.replace(/^\/+/, ''), start, size });
  }
  return files;
}

function safeJoin(base, relative) {
  const target = path.resolve(base, relative);
  const prefix = path.resolve(base) + path.sep;
  if (!target.startsWith(prefix)) throw new Error(`非法路径：${relative}`);
  return target;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

function unpackFile(packageFile, appid, outputDir, listOnly) {
  const raw = fs.readFileSync(packageFile);
  const decrypted = decryptWxapkg(raw, appid);
  const files = parseWxapkg(decrypted);
  const name = path.basename(packageFile, '.wxapkg');
  const targetRoot = path.join(outputDir, name);
  let written = 0;
  const highlights = [];
  for (const file of files) {
    const data = decrypted.slice(file.start, file.start + file.size);
    if (!listOnly) {
      const target = safeJoin(targetRoot, file.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      written += 1;
    }
    if (/(^|\/)(game\.js|tsdk\.wasm|game\.json)$/.test(`/${file.name}`)) {
      const hash = file.name.endsWith('.wasm')
        ? ` sha256=${crypto.createHash('sha256').update(data).digest('hex')}`
        : '';
      highlights.push(`  ${file.name} ${formatSize(file.size)}${hash}`);
    }
  }
  return { name, encrypted: raw.slice(0, MAGIC.length).toString('latin1') === MAGIC, files: files.length, written, highlights };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  let packageDir = args.package;
  if (!packageDir) {
    const candidates = packageSearchRoots().flatMap(root => findPackageDirs(root, args.appid));
    packageDir = pickLatestPackageDir(candidates);
    if (!packageDir) {
      throw new Error([
        `未找到 AppID ${args.appid} 的微信小游戏包。`,
        '请先在本机微信里打开一次该游戏，再用 --package 指定包含 .wxapkg 的目录。',
        `已检查：${packageSearchRoots().join('、') || '（无微信缓存目录）'}`,
      ].join('\n'));
    }
  }

  const packageFiles = fs.readdirSync(packageDir)
    .filter(name => name.endsWith('.wxapkg'))
    .map(name => path.join(packageDir, name))
    .sort();

  console.log(`包目录: ${packageDir}`);
  console.log(`版本  : ${path.basename(packageDir)}`);
  console.log(`包数量: ${packageFiles.length}${args.list ? '（仅列出）' : ''}\n`);

  let total = 0;
  for (const packageFile of packageFiles) {
    const result = unpackFile(packageFile, args.appid, args.out, args.list);
    total += result.files;
    console.log(`${result.name}.wxapkg  ${formatSize(fs.statSync(packageFile).size)}  ${result.files} 个文件${result.encrypted ? '（V1MMWX 已解密）' : ''}`);
    for (const line of result.highlights) console.log(line);
  }

  console.log(`\n合计 ${total} 个文件${args.list ? '' : `，输出到 ${args.out}`}`);
  if (!args.list) console.log('提示：tsdk.wasm 的 sha256 可直接与 src/utils/tsdk-runtime.js 的 OFFICIAL_SHA256 对比。');
}

module.exports = { decryptWxapkg, parseWxapkg, findPackageDirs, pickLatestPackageDir, safeJoin };

if (require.main === module) main();
