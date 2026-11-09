#!/usr/bin/env node
/**
 * 清理 OSS 上的旧版本与无用文件
 *
 *   node tools/oss-clean.js            只报告：哪些会删、哪些不动、哪些拿不准
 *   node tools/oss-clean.js --apply    真的删
 *   node tools/oss-clean.js --apply --rm "物种鉴定聚合台-mac-arm64.zip"   顺手删掉拿不准的某个键
 *
 * 判定规则（宁可不删，不能删错）：
 *   1. **保留**：两个桶位置的更新清单 latest.json / latest-mac.json；
 *      清单里 url 点名的那个文件（这才是自动更新真正要下的东西）；
 *      固定别名 bio-id-hub-win.exe / tagden/tagden-win.exe（发给人下载用的短链接）；
 *      mac 安装包 *-mac-arm64.zip / *-mac-x64.zip（新用户第一次装要用）。
 *   2. **删除**：名字里带版本号、且版本号比清单里当前版本**低**的 exe / js。
 *      只认 `xxx-1.2.3.exe`、`main-1.2.3.js` 这种形态，别的形态一律不碰。
 *   3. **不动**：认不出来的对象 = UNKNOWN，只列出来，要删得用 --rm 点名。
 *
 * 为什么不能只看后缀就删：`latest.json` 的 url 指向的是**带版本号**的 exe
 *（`bio-id-hub-1.0.49.exe`），不是别名。把带版本号的全删了，自动更新立刻 404。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'oss.config.json');

/** 永远保留（不在桶里的会被忽略） */
const KEEP_ALWAYS = [
  'latest.json',
  'latest-mac.json',
  'bio-id-hub-win.exe',
  'bio-id-hub-mac-arm64.zip',
  'bio-id-hub-mac-x64.zip',
  'tagden/latest.json',
  'tagden/latest-mac.json',
  'tagden/tagden-win.exe',
  'tagden/tagden-mac-arm64.zip',
  'tagden/tagden-mac-x64.zip',
];

function loadCfg() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  if (!cfg.bucket || !cfg.region || !cfg.akId || !cfg.akSecret) {
    throw new Error('oss.config.json 缺少 bucket / region / akId / akSecret');
  }
  return cfg;
}

function ossRequest(cfg, opts) {
  const { method = 'GET', key = '', query = '', body = null, contentType = '' } = opts;
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  headers.Date = new Date().toUTCString();

  const resource = `/${cfg.bucket}/${key}`;
  const stringToSign = [method, '', contentType || '', headers.Date, resource].join('\n');
  const signature = crypto.createHmac('sha1', cfg.akSecret).update(stringToSign, 'utf8').digest('base64');
  headers.Authorization = `OSS ${cfg.akId}:${signature}`;

  const host = `${cfg.bucket}.${cfg.region}.aliyuncs.com`;
  const p = `/${encodeURI(key).replace(/%2F/g, '/')}${query ? `?${query}` : ''}`;
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

/** 列全部对象（带大小与时间）。桶根与 tagden/ 一起列，用 prefix 分两次 */
async function listAll(cfg) {
  const out = [];
  let marker = '';
  for (;;) {
    const q = `max-keys=1000${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`;
    const r = await ossRequest(cfg, { method: 'GET', query: q });
    if (r.status !== 200) throw new Error(`列桶失败 ${r.status} ${r.text.slice(0, 200)}`);
    const blocks = [...r.text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => m[1]);
    for (const b of blocks) {
      out.push({
        key: (b.match(/<Key>([^<]*)<\/Key>/) || [])[1] || '',
        size: Number((b.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0),
        mtime: (b.match(/<LastModified>([^<]*)<\/LastModified>/) || [])[1] || '',
      });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(r.text);
    if (!truncated || !blocks.length) break;
    marker = out[out.length - 1].key;
  }
  return out;
}

async function getJson(cfg, key) {
  const r = await ossRequest(cfg, { key });
  if (r.status !== 200) throw new Error(`读 ${key} 失败 ${r.status}`);
  return JSON.parse(r.text);
}

function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

(async () => {
  const cfg = loadCfg();
  const apply = process.argv.includes('--apply');
  const rmIdx = process.argv.indexOf('--rm');
  const extraRm = rmIdx > 0 ? process.argv.slice(rmIdx + 1).filter((x) => !x.startsWith('--')) : [];

  // 当前版本：从远端清单读，不信本地 dist（本地可能已经打到下一个版本）
  const hubWin = await getJson(cfg, 'latest.json');
  const hubMac = await getJson(cfg, 'latest-mac.json');
  const tagWin = await getJson(cfg, 'tagden/latest.json');
  const tagMac = await getJson(cfg, 'tagden/latest-mac.json');

  const apps = {
    hub: { ver: hubWin.version, keys: [hubWin.url, hubMac.url] },
    tagden: { ver: tagWin.version, keys: [`tagden/${tagWin.url}`, `tagden/${tagMac.url}`] },
  };
  const keep = new Set([...KEEP_ALWAYS, ...apps.hub.keys, ...apps.tagden.keys]);

  console.log(`当前版本：聚合台 ${apps.hub.ver}（${hubWin.url} + ${hubMac.url}）`);
  console.log(`          标注工坊 ${apps.tagden.ver}（tagden/${tagWin.url} + tagden/${tagMac.url}）\n`);

  const objs = await listAll(cfg);
  // 清单里声明的 size 与实际对象大小对一下，防止清单和文件已经对不上
  const sizeCheck = [
    ['latest.json', hubWin.url, hubWin.size],
    ['latest-mac.json', hubMac.url, hubMac.size],
    ['tagden/latest.json', `tagden/${tagWin.url}`, tagWin.size],
    ['tagden/latest-mac.json', `tagden/${tagMac.url}`, tagMac.size],
  ];
  let sizeBad = 0;
  for (const [mkey, okey, want] of sizeCheck) {
    const o = objs.find((x) => x.key === okey);
    if (!o) {
      console.log(`[!] ${mkey} 指向的 ${okey} 在桶里不存在`);
      sizeBad++;
    } else if (o.size !== want) {
      console.log(`[!] ${okey} 实际 ${o.size} 字节，清单写 ${want} 字节`);
      sizeBad++;
    }
  }
  if (!sizeBad) console.log('清单与文件大小一致（4 项）\n');

  const old = [];
  const unknown = [];
  for (const o of objs) {
    if (keep.has(o.key) || extraRm.includes(o.key)) continue;
    const app = o.key.startsWith('tagden/') ? 'tagden' : 'hub';
    const base = o.key.replace(/^tagden\//, '');
    // 名字末尾带版本号才算旧版本候选。注意前缀里可能有连字符（bio-id-hub-1.0.48.exe），
    // 所以这里用惰性 .*? 而不是 [\w.]* —— 后者不含 "-"，会把 bio-id-hub-* 全判成认不出来。
    const m = base.match(/^.*?-(\d+\.\d+\.\d+)\.(exe|js|zip)$/);
    if (m && cmpVer(m[1], apps[app].ver) < 0) old.push({ ...o, app, ver: m[1] });
    else unknown.push({ ...o, app });
  }

  const oldBytes = old.reduce((s, x) => s + x.size, 0);
  console.log(`将删除 ${old.length} 个旧版本文件，回收 ${mb(oldBytes)}：`);
  for (const o of old.sort((a, b) => a.key.localeCompare(b.key))) {
    console.log(`  - ${o.key.padEnd(34)} ${mb(o.size).padStart(9)}  (${o.ver} < ${apps[o.app].ver})`);
  }

  if (unknown.length) {
    console.log(`\n拿不准、不会动（要删请用 --rm 点名）${unknown.length} 个：`);
    for (const o of unknown.sort((a, b) => a.key.localeCompare(b.key))) {
      console.log(`  ? ${o.key.padEnd(34)} ${mb(o.size).padStart(9)}  ${o.mtime.slice(0, 10)}`);
    }
  }

  const keepObjs = objs.filter((o) => keep.has(o.key));
  console.log(`\n保留 ${keepObjs.length} 个（${mb(keepObjs.reduce((s, x) => s + x.size, 0))}）：`);
  for (const o of keepObjs.sort((a, b) => a.key.localeCompare(b.key))) {
    console.log(`  + ${o.key.padEnd(34)} ${mb(o.size).padStart(9)}  ${o.mtime.slice(0, 10)}`);
  }

  const targets = [...old.map((o) => o.key), ...extraRm];
  if (!targets.length) return console.log('\n没有要删的。');
  if (!apply) return console.log(`\n（这只是报告。确认无误后执行：node tools/oss-clean.js --apply${extraRm.length ? ' --rm ' + extraRm.map((x) => `"${x}"`).join(' ') : ''}）`);

  console.log('\n开始删除…');
  let ok = 0;
  for (const key of targets) {
    const r = await ossRequest(cfg, { method: 'DELETE', key });
    // OSS 对不存在的对象也回 204，所以删完要再列一次确认真的没了
    if (r.status === 204 || r.status === 200) {
      ok++;
      console.log(`  ✔ ${key}`);
    } else {
      console.log(`  ✘ ${key}  HTTP ${r.status} ${r.text.slice(0, 120)}`);
    }
  }

  const after = await listAll(cfg);
  const gone = targets.filter((k) => !after.some((o) => o.key === k));
  const left = targets.filter((k) => after.some((o) => o.key === k));
  console.log(`\n删除 ${ok} 个请求全部返回成功；复查：确实消失 ${gone.length} 个${left.length ? `，仍在 ${left.length} 个：${left.join(', ')}` : ''}`);
  console.log(`桶内现在 ${after.length} 个对象，${mb(after.reduce((s, x) => s + x.size, 0))}`);

  // 最后确认保留下来的东西都还能下载
  const check = ['latest.json', 'latest-mac.json', hubWin.url, hubMac.url, 'bio-id-hub-win.exe',
    'tagden/latest.json', 'tagden/latest-mac.json', `tagden/${tagWin.url}`, `tagden/${tagMac.url}`];
  let alive = 0;
  for (const k of check) {
    const r = await ossRequest(cfg, { method: 'HEAD', key: k });
    if (r.status === 200) alive++;
    else console.log(`  [!] ${k} → HTTP ${r.status}`);
  }
  console.log(`可访问性复查：${alive}/${check.length} 个关键文件仍是 200`);
})().catch((e) => {
  console.error('出错：' + e.message);
  process.exit(1);
});
