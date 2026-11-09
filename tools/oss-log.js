#!/usr/bin/env node
/**
 * OSS 访问日志：开通与统计
 *
 *   node tools/oss-log.js setup            建日志桶 + 打开访问日志（可重复执行）
 *   node tools/oss-log.js status           看当前日志配置
 *   node tools/oss-log.js stats [--days 7] 拉日志，统计每天多少台设备启动过
 *   node tools/oss-log.js stats --detail   附带「每个对象被请求了几次、什么状态码」，用来核对
 *   node tools/oss-log.js selftest         传一个假日志验证解析（跑完自动删）
 *
 * 统计口径：程序每次启动 1.5 秒后会去要一次更新清单
 *   hub    Windows GET latest.json    / mac GET latest-mac.json
 *   tagden Windows GET tagden/latest.json / mac GET tagden/latest-mac.json
 * 所以「当天取过清单的独立 IP 数」≈ 当天启动过这个软件的设备数。
 * 局限：同一出口 IP 的多台机器会合并成一台；换网络会重复计数；只能算设备不能算人。
 * 另：*.exe / *.zip 是下载量，main-*.js 是自动更新取包（不算设备）。
 *
 * 日志文件由 OSS 每小时生成一个（不压缩，Apache 组合格式），落在独立桶的 hub/ 前缀下。
 * 独立桶是必须的：日志写回源桶会把「写日志」这个请求也记成日志，无限套娃。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'oss.config.json');
const LOG_BUCKET = 'bioidhub-logs';
const LOG_PREFIX = 'hub/';

function loadCfg() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  if (!cfg.bucket || !cfg.region || !cfg.akId || !cfg.akSecret) {
    throw new Error('oss.config.json 缺少 bucket / region / akId / akSecret');
  }
  return cfg;
}

/** OSS V1 签名：VER\nContent-MD5\nContent-Type\nDate\nCanonicalizedOSSHeaders + /bucket/key[?sub] */
function sign(cfg, { method, bucket, key, subresource, contentType, date, headers }) {
  const canonHeaders = Object.keys(headers)
    .filter((k) => k.toLowerCase().startsWith('x-oss-'))
    .sort()
    .map((k) => `${k.toLowerCase()}:${String(headers[k]).trim()}\n`)
    .join('');
  const resource = `/${bucket}/${key}${subresource ? `?${subresource}` : ''}`;
  const stringToSign = [method, '', contentType || '', date, `${canonHeaders}${resource}`].join('\n');
  const signature = crypto.createHmac('sha1', cfg.akSecret).update(stringToSign, 'utf8').digest('base64');
  return { signature, stringToSign };
}

function ossRequest(cfg, opts) {
  const { method = 'GET', bucket = cfg.bucket, key = '', query = '', subresource = '', contentType = '', body = null } = opts;
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  headers.Date = new Date().toUTCString();
  const { signature } = sign(cfg, { method, bucket, key, subresource, contentType, date: headers.Date, headers });
  headers.Authorization = `OSS ${cfg.akId}:${signature}`;

  const host = `${bucket}.${cfg.region}.aliyuncs.com`;
  const suffix = query ? `?${query}` : subresource ? `?${subresource}` : '';
  const p = `/${encodeURI(key).replace(/%2F/g, '/')}${suffix}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ---------------- setup / status ---------------- */

async function ensureBucket(cfg) {
  const r = await ossRequest(cfg, { method: 'PUT', bucket: LOG_BUCKET });
  if (r.status === 200) return '创建成功';
  const code = (r.text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || '';
  if (r.status === 409 || code === 'BucketAlreadyExists' || code === 'BucketAlreadyOwnedByYou') return '已存在';
  throw new Error(`建桶失败 ${r.status} ${code} ${r.text.slice(0, 200)}`);
}

async function getLogging(cfg) {
  const r = await ossRequest(cfg, { method: 'GET', subresource: 'logging' });
  if (r.status !== 200) throw new Error(`读日志配置失败 ${r.status} ${r.text.slice(0, 200)}`);
  const target = (r.text.match(/<TargetBucket>([^<]*)<\/TargetBucket>/) || [])[1] || '';
  const prefix = (r.text.match(/<TargetPrefix>([^<]*)<\/TargetPrefix>/) || [])[1] || '';
  return { target, prefix, raw: r.text };
}

async function setup(cfg) {
  const created = await ensureBucket(cfg);
  console.log(`日志桶 ${LOG_BUCKET}：${created}`);
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<BucketLoggingStatus><LoggingEnabled>' +
    `<TargetBucket>${LOG_BUCKET}</TargetBucket>` +
    `<TargetPrefix>${LOG_PREFIX}</TargetPrefix>` +
    '</LoggingEnabled></BucketLoggingStatus>';
  const r = await ossRequest(cfg, {
    method: 'PUT',
    subresource: 'logging',
    contentType: 'application/xml',
    body: xml,
  });
  if (r.status !== 200) throw new Error(`设置日志失败 ${r.status} ${r.text.slice(0, 300)}`);
  const cur = await getLogging(cfg);
  console.log(`已开启访问日志：${cfg.bucket} → ${cur.target}/${cur.prefix}`);
  console.log('OSS 每小时生成一个日志文件，最早一小时内看不到数据。');
}

async function status(cfg) {
  const cur = await getLogging(cfg);
  if (!cur.target) return console.log('尚未开启访问日志');
  console.log(`源桶        ${cfg.bucket}`);
  console.log(`日志桶      ${cur.target}`);
  console.log(`日志前缀    ${cur.prefix}`);
  const list = await listObjects(cfg, cur.target, cur.prefix, 5);
  console.log(`日志文件    已有 ${list.keys.length ? '若干' : '0'} 个（最新 5 个：${list.keys.join(', ') || '无'}）`);
}

/* ---------------- 拉日志 ---------------- */

async function listObjects(cfg, bucket, prefix, max = 1000) {
  const keys = [];
  let marker = '';
  for (;;) {
    const q = `prefix=${encodeURIComponent(prefix)}&max-keys=${max}${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`;
    const r = await ossRequest(cfg, { method: 'GET', bucket, query: q });
    if (r.status !== 200) throw new Error(`列日志失败 ${r.status} ${r.text.slice(0, 200)}`);
    const found = [...r.text.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]);
    keys.push(...found);
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(r.text);
    if (!truncated || !found.length) break;
    marker = found[found.length - 1];
  }
  return { keys: keys.slice(-max) };
}

/** 日志 Time 形如 31/Oct/2026:22:00:12 +0800（可能带一层方括号） */
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
function dayOf(time) {
  const m = String(time).match(/^\[?(\d{2})\/(\w{3})\/(\d{4})/);
  if (!m) return '';
  return `${m[3]}-${MONTHS[m[2]] || '01'}-${m[1]}`;
}

/** 把一行日志切成 token：引号里的一整段算一个，其余按空白切 */
function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/**
 * 阿里云 OSS 的访问日志是 **Apache 组合格式**（空格分隔、字段带引号），不是 TSV。
 * 一行长这样（截断）：
 *   8.139.99.234 - - [31/Oct/2026:22:09:29 +0800] "GET /latest.json HTTP/1.1" 200 247 2
 *     "-" "UA..." "bioidhub-fsw.oss-cn-hangzhou.aliyuncs.com" "REQID" "true" "UID"
 *     "GetObject" "bioidhub-fsw" ...
 *
 * 坑：时间那一格 `[31/Oct/2026:22:09:29 +0800]` **内部有空格**，直接按空白切会把它劈成
 * `[31/Oct/2026:22:09:29` 和 `+0800]` 两个 token，后面所有下标整体错位一格，
 * 请求行会跑到 [5] 而不是 [4] —— 之前统计恒为 0 就是这个原因。
 * 所以先把方括号时间整段摘掉，剩下的再切：摘完之后
 *   [0] 客户端 IP、[1][2] 两个 "-"、[3] 请求行、[4] 状态码。
 * 对象名从请求行里取（去掉 query 与开头的斜杠），比按列猜更可靠 —— 桶级操作（?referer 之类）
 * 取出来是空串，正好跳过。
 */
function parseLog(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const tm = line.match(/\[([^\]]+)\]/);
    if (!tm || !/^\d{2}\/\w{3}\/\d{4}/.test(tm[1])) continue;
    const rest = `${line.slice(0, tm.index)} ${line.slice(tm.index + tm[0].length)}`;
    const t = tokenize(rest);
    if (t.length < 5) continue;
    const rm = (t[3] || '').match(/^(\w+)\s+(\S+)/);
    if (!rm) continue;
    let p = rm[2];
    const qi = p.indexOf('?');
    const query = qi >= 0 ? p.slice(qi + 1) : '';
    if (qi >= 0) p = p.slice(0, qi);
    let key = p.replace(/^\/+/, '');
    try {
      key = decodeURIComponent(key);
    } catch {
      /* 编码异常就按原样比对 */
    }
    rows.push({
      ip: t[0],
      day: dayOf(tm[1]),
      method: rm[1],
      key,
      query,
      status: Number(t[4]),
    });
  }
  return rows;
}

/**
 * 统计。
 * onlyKey：只统计这一个日志文件（自检用），否则按 days 取日期范围内的全部文件
 *          —— 否则自检的数字会被真实流量污染，看不出解析对不对。
 */
async function stats(cfg, days, onlyKey) {
  let target = cfg.bucket;
  let prefix = LOG_PREFIX;
  const cur = await getLogging(cfg);
  if (cur.target) {
    target = cur.target;
    prefix = cur.prefix;
  } else {
    console.log('（未开启访问日志，按同桶读默认前缀）');
  }

  const { keys } = await listObjects(cfg, target, prefix);
  // 只取最近 days 天（日志文件名里带日期 YYYY-mm-DD-HH-MM-SS）
  const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  const wanted = onlyKey
    ? keys.filter((k) => k === onlyKey)
    : keys.filter((k) => {
        const m = k.match(/(\d{4}-\d{2}-\d{2})-\d{2}-\d{2}-\d{2}/);
        return !m || m[1] >= since;
      });
  if (!wanted.length) {
    console.log(`日志桶 ${target}/${prefix} 里还没有文件（OSS 每小时出一个，稍后再看）`);
    return;
  }

  const all = [];
  for (const k of wanted) {
    const r = await ossRequest(cfg, { method: 'GET', bucket: target, key: k });
    if (r.status !== 200) continue;
    all.push(...parseLog(r.text));
  }

  // Windows 版（SEA）取 latest.json，mac 版取 latest-mac.json（见 lib/updater.js 的 MANIFEST_NAME）
  const isManifest = (key) => /^(latest|latest-mac|update)\.json$/.test(key);
  const isTagdenManifest = (key) => /^tagden\/(latest|latest-mac|update)\.json$/.test(key);
  const isExe = (key) => /\.exe$/i.test(key);
  const isZip = (key) => /\.zip$/i.test(key);

  const byDay = new Map();
  const bump = (day) => {
    if (!byDay.has(day)) byDay.set(day, { hub: new Set(), tag: new Set(), exe: 0, exeIp: new Set(), zip: 0 });
    return byDay.get(day);
  };
  for (const r of all) {
    if (r.status !== 200) continue;
    if (r.method !== 'GET' && r.method !== 'HEAD') continue;
    if (!r.key) continue; // 桶级操作（?referer / ?cors 之类）不算
    const d = bump(r.day);
    if (isTagdenManifest(r.key)) d.tag.add(r.ip);
    else if (isManifest(r.key)) d.hub.add(r.ip);
    if (isExe(r.key)) {
      d.exe += 1;
      d.exeIp.add(r.ip);
    }
    if (isZip(r.key)) d.zip += 1;
  }

  const dayList = [...byDay.keys()].sort();
  const scope = onlyKey ? `仅 ${onlyKey}` : `统计区间 ${since} 起`;
  console.log(`${scope}，共 ${wanted.length} 个日志文件、${all.length} 条请求\n`);
  console.log('日期        聚合台设备  标注工坊设备  exe下载(次/独立IP)  mac zip');
  for (const day of dayList) {
    const d = byDay.get(day);
    console.log(
      `${day}  ${String(d.hub.size).padStart(9)}  ${String(d.tag.size).padStart(11)}  ` +
        `${String(d.exe).padStart(8)} / ${String(d.exeIp.size).padStart(3)}      ${String(d.zip).padStart(4)}`,
    );
  }
  const allHub = new Set();
  const allTag = new Set();
  let exe = 0;
  for (const d of byDay.values()) {
    d.hub.forEach((x) => allHub.add(x));
    d.tag.forEach((x) => allTag.add(x));
    exe += d.exe;
  }
  console.log(`\n合计：聚合台 ${allHub.size} 台不同 IP、标注工坊 ${allTag.size} 台不同 IP、exe 下载 ${exe} 次`);
  console.log('说明：设备数按出口 IP 去重，同一网络多台会合并、换网络会重复；不是「人数」。');

  // --detail：把每个对象的请求数与状态码摊开，用来核对「没算进来的是不是真不该算」
  if (process.argv.includes('--detail')) {
    const cnt = new Map();
    for (const r of all) {
      const k = `${r.key || '(桶级操作)'}  ${r.method} ${r.status}`;
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
    console.log('\n对象 / 方法 / 状态码            次数');
    [...cnt.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`${k.padEnd(34)}${String(v).padStart(5)}`));
  }
}

/* ---------------- 自检 ---------------- */

/**
 * 造一个假日志文件验证解析与统计（跑完自动删掉）。
 *
 * 为什么值得留这段：OSS 的日志列顺序一旦调整，统计就会静默算错。
 * 自检跑一次，数字对不上就是格式变了。
 * 用文档保留网段（203.0.113.x / 198.51.100.x），不会跟真实数据混。
 */
async function selftest(cfg) {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(11, 13);
  const key = `${LOG_PREFIX}${stamp}-${hour}-00-00-0000-selftest-000001`;
  // 按真实格式（Apache 组合格式）造行：多一条桶级操作、一条 404，验证都会被过滤掉
  const line = (t, ip, path, status = 200) =>
    `${ip} - - [${t} +0800] "GET ${path} HTTP/1.1" ${status} 3848 2 "-" "Mozilla/5.0 (test)" ` +
    `"bioidhub-fsw.oss-cn-hangzhou.aliyuncs.com" "REQ-TEST" "true" "1234" "GetObject" ` +
    `"bioidhub-fsw" "-" - - "-" 12 "0" - "-" "standard" "-" "-" "STS.TEST" "-" "-" "-"`;
  const rows = [
    line('31/Oct/2026:21:10:01', '203.0.113.10', '/latest.json'),
    line('31/Oct/2026:21:10:05', '203.0.113.11', '/latest.json'),
    line('31/Oct/2026:21:11:00', '203.0.113.10', '/latest.json'),
    line('31/Oct/2026:21:12:00', '198.51.100.7', '/tagden/latest.json'),
    line('31/Oct/2026:21:13:00', '203.0.113.10', '/bio-id-hub-1.0.48.exe'),
    line('31/Oct/2026:21:14:00', '203.0.113.11', '/bio-id-hub-1.0.48.exe'),
    line('31/Oct/2026:21:15:00', '203.0.113.12', '/?referer'), // 桶级操作：应被忽略
    line('31/Oct/2026:21:16:00', '203.0.113.13', '/latest.json', 404), // 404：应被忽略
    line('31/Oct/2026:21:17:00', '203.0.113.10', '/latest-mac.json'), // mac 版：同一台设备，不该重复计
  ].join('\n');

  console.log(`上传测试日志 ${LOG_BUCKET}/${key} …`);
  const up = await ossRequest(cfg, { method: 'PUT', bucket: LOG_BUCKET, key, contentType: 'text/plain; charset=utf-8', body: rows + '\n' });
  if (up.status !== 200) throw new Error(`上传失败 ${up.status} ${up.text.slice(0, 200)}`);

  await stats(cfg, 1, key);

  const del = await ossRequest(cfg, { method: 'DELETE', bucket: LOG_BUCKET, key });
  console.log(del.status === 204 || del.status === 200 ? '\n测试日志已删除' : `\n测试日志删除失败 ${del.status}`);
  console.log('期望：聚合台 2 台（203.0.113.10 / .11 去重，含 1 次 mac 清单）、标注工坊 1 台、exe 下载 2 次 / 2 个 IP。');
}

(async () => {
  const cfg = loadCfg();
  const cmd = process.argv[2] || 'status';
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) || 7 : 7;
  if (cmd === 'setup') await setup(cfg);
  else if (cmd === 'stats') await stats(cfg, days);
  else if (cmd === 'selftest') await selftest(cfg);
  else await status(cfg);
})().catch((e) => {
  console.error('出错：' + e.message);
  process.exit(1);
});
