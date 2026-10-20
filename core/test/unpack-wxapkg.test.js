const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { decryptWxapkg, parseWxapkg, pickLatestPackageDir, safeJoin } = require('../scripts/unpack-wxapkg');

const APPID = 'wx5306c5978fdb76e4';
const IV = Buffer.from('the iv: 16 bytes');
const SALT = 'saltiest';

function buildWxapkg(files) {
  const entries = files.map((file) => ({
    name: Buffer.from(file.name, 'utf8'),
    data: Buffer.from(file.data),
  }));
  const indexLength = 4 + entries.reduce((sum, entry) => sum + 4 + entry.name.length + 4 + 4, 0);
  const bodyStart = 14 + indexLength;
  let bodyLength = 0;
  const offsets = entries.map((entry) => {
    const offset = bodyStart + bodyLength;
    bodyLength += entry.data.length;
    return offset;
  });

  const header = Buffer.alloc(14);
  header[0] = 0xbe;
  header.writeUInt32BE(indexLength, 5);
  header.writeUInt32BE(bodyLength, 9);
  header[13] = 0xed;

  const index = Buffer.alloc(indexLength);
  index.writeUInt32BE(entries.length, 0);
  let cursor = 4;
  entries.forEach((entry, position) => {
    index.writeUInt32BE(entry.name.length, cursor); cursor += 4;
    entry.name.copy(index, cursor); cursor += entry.name.length;
    index.writeUInt32BE(offsets[position], cursor); cursor += 4;
    index.writeUInt32BE(entry.data.length, cursor); cursor += 4;
  });

  return Buffer.concat([header, index, ...entries.map(entry => entry.data)]);
}

/** 复刻 Windows PC 微信的加密方式，用于验证解密往返。 */
function encryptWxapkg(plain, appid) {
  const key = crypto.pbkdf2Sync(appid, SALT, 1000, 32, 'sha1');
  const padded = Buffer.alloc(1024);
  plain.copy(padded, 0, 0, 1023);
  padded[1023] = 0x01;
  const cipher = crypto.createCipheriv('aes-256-cbc', key, IV);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  const xorKey = appid.charCodeAt(appid.length - 2);
  const rest = Buffer.from(plain.slice(1023));
  for (let index = 0; index < rest.length; index += 1) rest[index] ^= xorKey;
  return Buffer.concat([Buffer.from('V1MMWX'), encrypted, rest]);
}

test('parses wxapkg index and extracts file contents', () => {
  const files = [
    { name: '/game.js', data: Buffer.alloc(2000, 0x41) },
    { name: '/tsdk/tsdk.wasm', data: Buffer.alloc(300, 0x42) },
  ];
  const parsed = parseWxapkg(buildWxapkg(files));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(item => item.name), ['game.js', 'tsdk/tsdk.wasm']);
  assert.equal(parsed[0].size, 2000);
  assert.equal(parsed[1].size, 300);
});

test('rejects data that is not a wxapkg', () => {
  assert.throws(() => parseWxapkg(Buffer.alloc(64)), /不是 wxapkg/);
});

test('leaves unencrypted packages untouched', () => {
  const plain = buildWxapkg([{ name: '/game.js', data: Buffer.alloc(32, 0x43) }]);
  assert.deepEqual(decryptWxapkg(plain, APPID), plain);
});

test('decrypts V1MMWX packages round-trip', () => {
  const plain = buildWxapkg([
    { name: '/game.js', data: Buffer.alloc(1500, 0x44) },
    { name: '/tsdk/tsdk.wasm', data: Buffer.alloc(500, 0x45) },
  ]);
  const encrypted = encryptWxapkg(plain, APPID);
  assert.equal(encrypted.slice(0, 6).toString('latin1'), 'V1MMWX');
  assert.deepEqual(decryptWxapkg(encrypted, APPID), plain);
});

test('picks the highest numeric version directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxapkg-versions-'));
  try {
    for (const name of ['9', '75', '74']) fs.mkdirSync(path.join(root, name));
    assert.equal(path.basename(pickLatestPackageDir([
      path.join(root, '74'),
      path.join(root, '9'),
      path.join(root, '75'),
    ])), '75');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects path traversal outside the output directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxapkg-safe-'));
  try {
    assert.throws(() => safeJoin(root, '../escape.txt'), /非法路径/);
    assert.equal(safeJoin(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects truncated V1MMWX packages', () => {
  const truncated = Buffer.concat([Buffer.from('V1MMWX'), Buffer.alloc(16)]);
  assert.throws(() => decryptWxapkg(truncated, APPID), /过短|截断/);
});
