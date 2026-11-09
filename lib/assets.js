'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_DIR } = require('./env');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/** 打包时由 build.js 注入，源码运行时为空 */
function embedded() {
  return global.__EMBEDDED__ || null;
}

/** 二进制资源（base64 内联的那几个），同样由打包时注入 */
function embeddedBin() {
  return global.__EMBEDDED_BIN__ || null;
}

/**
 * 读取前端静态文件。
 * 打包成 exe 后从内存里取（构建时已内联），源码运行时从 public/ 读。
 */
function get(relPath) {
  const clean = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (clean.includes('..')) return null;

  const mime = MIME[path.extname(clean).toLowerCase()] || 'application/octet-stream';

  const mem = embedded();
  if (mem) {
    if (typeof mem[clean] === 'string') return { body: Buffer.from(mem[clean], 'utf8'), mime };
    // 图片这类二进制资源是单独一张表，取出来要还原成字节，不能当 utf8 处理（会坏图）
    const bin = embeddedBin();
    if (bin && typeof bin[clean] === 'string') return { body: Buffer.from(bin[clean], 'base64'), mime };
    return null; // 打包模式下不再回落到磁盘，保证行为一致
  }

  const file = path.join(PUBLIC_DIR, clean);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
  return { body: fs.readFileSync(file), mime };
}

module.exports = { get };
