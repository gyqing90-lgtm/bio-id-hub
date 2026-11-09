'use strict';

/**
 * 打包脚本：把源码 + 网页资源 + Node 运行时合成单个 exe。
 *
 *   node build-exe.js
 *
 * 产物：dist/物种鉴定聚合台.exe
 *
 * 原理：
 *   1. 自己写一个极简打包器，把 6 个模块塞进一个 CJS 文件，网页资源内联成字符串
 *   2. 用 Node 官方 SEA（Single Executable Application）把该文件做成 blob
 *   3. 把 blob 注入到 node.exe 的副本里（postject）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { buildBundle } = require('./build/bundle');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(DIST, 'build');
const EXE_NAME = '物种鉴定聚合台.exe';
const EXE_PATH = path.join(DIST, EXE_NAME);
const POSTJECT = path.join(ROOT, '.build-tools', 'node_modules', 'postject', 'dist', 'cli.js');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const VERSION_FILE = path.join(ROOT, '.version');

function runNode(args, opts = {}) {
  return execFileSync(process.execPath, args, { stdio: 'inherit', ...opts });
}

/**
 * 版本号来源，优先级：命令行参数 > .version 自动 +1
 *   node build-exe.js 1.2.0        指定版本
 *   node build-exe.js --bump minor 递增次版本号
 *   node build-exe.js              补丁号 +1（首次为 1.0.0）
 */
function resolveVersion(argv) {
  const explicit = argv.find((a) => /^v?\d+\.\d+\.\d+/.test(a));
  if (explicit) return explicit.replace(/^v/i, '');

  let cur = '';
  try {
    cur = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  } catch {
    /* 首次构建 */
  }
  if (!cur) return '1.0.0';

  const [a = 0, b = 0, c = 0] = cur.replace(/^v/i, '').split('.').map((n) => Number(n) || 0);
  const bump = argv[argv.indexOf('--bump') + 1];
  if (bump === 'major') return `${a + 1}.0.0`;
  if (bump === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

/** 更新源：--update-url 参数 > 环境变量 > update.json */
function resolveUpdateUrl(argv) {
  const idx = argv.indexOf('--update-url');
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1].trim();
  if (process.env.BIOID_UPDATE_URL) return process.env.BIOID_UPDATE_URL.trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'update.json'), 'utf8'));
    return String(cfg.url || '').trim();
  } catch {
    return '';
  }
}

function resolveNotes(argv) {
  const idx = argv.indexOf('--notes');
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  try {
    return fs.readFileSync(path.join(ROOT, 'notes.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const argv = process.argv.slice(2);
  const version = resolveVersion(argv);
  const updateUrl = resolveUpdateUrl(argv);
  const notes = resolveNotes(argv);

  console.log(`→ 版本 v${version}${updateUrl ? `，更新源 ${updateUrl}` : '（未配置更新源）'}`);

  console.log('→ 清理旧产物');
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  // 不直接删除旧 exe：某些环境（杀软/回收站被策略禁用）会拒绝删除操作。
  // 改成先产出临时文件，最后改名覆盖，失败风险更低。
  const TMP_PATH = path.join(DIST, `~${EXE_NAME}`);
  try {
    if (fs.existsSync(TMP_PATH)) fs.rmSync(TMP_PATH, { force: true });
  } catch {
    /* 有残留也不影响，下面会覆盖写 */
  }

  console.log('→ 生成单文件 JS 包');
  const mainJs = buildBundle(ROOT, {
    name: '物种鉴定聚合台',
    version,
    updateUrl,
    builtAt: new Date().toISOString(),
  });
  const mainPath = path.join(BUILD, 'main.js');
  fs.writeFileSync(mainPath, mainJs, 'utf8');
  console.log(`  main.js  ${(Buffer.byteLength(mainJs) / 1024).toFixed(1)} KB`);

  // 先验证打包后的代码能正常加载（不监听端口，只做语法与依赖检查）
  console.log('→ 校验打包结果');
  execFileSync(process.execPath, ['--check', mainPath], { stdio: 'inherit' });

  console.log('→ 生成 SEA blob');
  const seaConfig = {
    main: path.relative(ROOT, mainPath).replace(/\\/g, '/'),
    output: path.relative(ROOT, path.join(BUILD, 'sea-prep.blob')).replace(/\\/g, '/'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  const seaConfigPath = path.join(BUILD, 'sea-config.json');
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');
  runNode(['--experimental-sea-config', seaConfigPath]);

  console.log('→ 复制 Node 运行时');
  fs.copyFileSync(process.execPath, TMP_PATH);

  console.log('→ 注入 blob');
  if (!fs.existsSync(POSTJECT)) {
    throw new Error('缺少 postject，请先执行：npm install --prefix .build-tools postject');
  }
  runNode([POSTJECT, TMP_PATH, 'NODE_SEA_BLOB', seaConfig.output, '--sentinel-fuse', SENTINEL]);

  console.log('→ 替换成品');
  // 先把手上的旧成品改名挪开（直接覆盖在某些环境会 EPERM），再改名到位
  if (fs.existsSync(EXE_PATH)) {
    const old = path.join(DIST, '~old.exe');
    try {
      if (fs.existsSync(old)) fs.rmSync(old, { force: true });
    } catch {
      /* 忽略 */
    }
    try {
      fs.renameSync(EXE_PATH, old);
    } catch {
      /* 挪不动就直接试覆盖 */
    }
  }
  fs.renameSync(TMP_PATH, EXE_PATH);
  try {
    const old = path.join(DIST, '~old.exe');
    if (fs.existsSync(old)) fs.rmSync(old, { force: true });
  } catch {
    console.log('  （旧的 ~old.exe 删不掉，可手动删除）');
  }

  const size = (fs.statSync(EXE_PATH).size / 1024 / 1024).toFixed(1);
  console.log('');
  console.log(`完成：${EXE_PATH}`);
  console.log(`体积：${size} MB`);

  /* ---------- 发布物：带版本号的副本 + 更新清单 ---------- */

  const digest = sha256(EXE_PATH);
  // 发布用的副本刻意用纯 ASCII 名：对象存储里中文 key 虽然能用，
  // 但 URL 会变成一长串 %E7%89%A9…，复制易错、排查时也不好认。
  const versionedName = `bio-id-hub-${version}.exe`;
  const versionedPath = path.join(DIST, versionedName);
  try {
    fs.copyFileSync(EXE_PATH, versionedPath);
  } catch (err) {
    console.log(`  （带版本号的副本没写出来：${err.message}）`);
  }

  // url 写相对文件名即可：客户端会以「清单所在地址」为基准解析，
  // 以后换存储位置或换 CDN 都不用重新打包。
  const manifest = {
    version,
    notes,
    pubDate: new Date().toISOString().slice(0, 10),
    url: versionedName,
    size: fs.statSync(EXE_PATH).size,
    sha256: digest,
  };
  const manifestPath = path.join(DIST, 'latest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(VERSION_FILE, version + '\n', 'utf8');

  console.log('');
  console.log('发布物（dist/）：');
  console.log(`  ${EXE_NAME}              主程序`);
  console.log(`  ${versionedName}   带版本号的副本，上传这个`);
  console.log('  latest.json                         更新清单，上传到同一目录');
  console.log('');
  console.log(`  SHA-256  ${digest}`);
  if (!updateUrl) {
    console.log('');
    console.log('  提示：未配置更新源。要启用自动更新，在项目根建 update.json：');
    console.log('        { "url": "https://你的存储桶域名/bio-id-hub" }');
    console.log('        然后重新执行 build。');
  }
  console.log('');
  console.log('提示：exe 首次运行会在同级目录生成 data 文件夹（含内嵌账号的配置与登录缓存）。');
}

main();
