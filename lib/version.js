'use strict';

/**
 * 版本号与更新源。
 *
 * 源码运行：读环境变量 BIOID_VERSION / BIOID_UPDATE_URL，缺省为开发版。
 * 打包运行：build-exe.js 会把 global.__APP_META__ 注入到产物最顶部。
 */

const meta = (typeof global.__APP_META__ === 'object' && global.__APP_META__) || {};

const APP_VERSION = (process.env.BIOID_VERSION || meta.version || '0.0.0-dev').trim();

// 更新源：指向一个目录（自动拼 latest.json）或直接指向 latest.json
const UPDATE_URL = (process.env.BIOID_UPDATE_URL || meta.updateUrl || '').trim();

const APP_NAME = (meta.name || '物种鉴定聚合台').trim();

module.exports = { APP_VERSION, UPDATE_URL, APP_NAME };
