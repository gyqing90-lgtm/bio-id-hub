'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const secure = require('./secure.js');
const { resolveDataDir } = require('./datadir.js');

/** 是否运行在打包后的单文件 exe 里 */
function detectSea() {
  try {
    const sea = require('node:sea');
    return typeof sea.isSea === 'function' ? sea.isSea() : false;
  } catch {
    return false;
  }
}

const isSea = detectSea();

/**
 * macOS 目录版：node 运行时原样不动（官方签名有效），程序是 <根目录>/app/main.js，
 * 由同目录的 start.command 调起来。判定看启动脚本的路径就够了，
 * 源码运行（node server.js）不会命中。
 */
const MAIN_SCRIPT = process.argv[1] || '';
const isAppBundle = !isSea && /[\\/]app[\\/]main\.js$/.test(MAIN_SCRIPT);

// 源码运行时是项目根目录；exe / 目录版运行时是程序所在目录
const APP_DIR = isSea
  ? path.dirname(process.execPath)
  : isAppBundle
    ? path.dirname(path.dirname(MAIN_SCRIPT)) // app/ 的上一层
    : path.join(__dirname, '..');

// 程序本体（可执行文件或 main.js）所在的目录 —— 自动更新要往这里写新版本
const PROGRAM_DIR = isSea ? APP_DIR : isAppBundle ? path.dirname(MAIN_SCRIPT) : APP_DIR;

/**
 * 配置与登录缓存放在 exe 同级的 data 目录（便携）；
 * 同目录的 data 若已被另一个软件占用，改用 data-bio-id-hub（见 lib/datadir.js）；
 * 如果所在位置本身不可写（Program Files、只读 U 盘），退回到用户目录。
 */
const resolved = resolveDataDir({
  appId: 'bio-id-hub',
  appDir: APP_DIR,
  override: process.env.BIOID_DATA,
  secure,
});

const DATA_DIR = resolved.dir;
const DATA_NOTE = resolved.note;
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const PUBLIC_DIR = path.join(APP_DIR, 'public');

module.exports = {
  isSea,
  isAppBundle,
  APP_MAIN: isAppBundle ? MAIN_SCRIPT : '',
  APP_DIR,
  PROGRAM_DIR,
  DATA_DIR,
  DATA_NOTE,
  RESULTS_DIR,
  PUBLIC_DIR,
};
