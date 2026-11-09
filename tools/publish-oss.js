'use strict';
/**
 * 把发布产物推到阿里云 OSS（零依赖，用官方 V1 签名）。
 *
 *   node tools/publish-oss.js            上传 latest.json + 清单里那个 exe
 *   node tools/publish-oss.js --with-mac  连 mac 的安装包 / 更新包 / latest-mac.json 一起传
 *   node tools/publish-oss.js --dry-run  只校验配置与文件，不发请求
 *   node tools/publish-oss.js --verify   上传后再 HEAD 核对一遍大小
 *   node tools/publish-oss.js --manifest-only
 *                                        只补传清单（改了 notes.txt 但 exe 没变时用，
 *                                        省掉 80MB 的重复上传；sha256 仍会核对）
 *
 * 每次都会顺手维护一个固定别名 bio-id-hub-win.exe，永远指向最新 Windows 版
 * （mac 的两个 zip 本来就是固定名）。这样发在微信群里的下载文案写一次就够，
 * 不用每发一版就回去改群消息。
 *
 * 配置来源：环境变量优先，其次项目根的 oss.config.json
 *   bucket     存储桶名，例如 bio-id-hub
 *   region     地域，例如 oss-cn-hangzhou（写 cn-hangzhou 也会自动补 oss-）
 *   akId       AccessKey ID
 *   akSecret   AccessKey Secret
 *
 * 只想手动传的话完全可以不用这个脚本：OSS 控制台拖两个文件上去效果一样。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CFG_FILE = path.join(ROOT, 'oss.config.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const VERIFY = argv.includes('--verify');
const WITH_MAC = argv.includes('--with-mac');
const MANIFEST_ONLY = argv.includes('--manifest-only');

/** Windows 包的固定别名：群发文案里只贴这一个，永远是最新版 */
const STABLE_WIN = 'bio-id-hub-win.exe';

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
  '.js': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function loadConfig() {
  let file = {};
  if (fs.existsSync(CFG_FILE)) {
    try {
      file = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    } catch (err) {
      throw new Error(`oss.config.json 不是合法 JSON：${err.message}`);
    }
  }
  const pick = (envKey, fileKey) =>
    String(process.env[envKey] || file[fileKey] || '').trim();

  let region = pick('OSS_REGION', 'region');
  if (region && !/^oss-/.test(region)) region = `oss-${region}`;

  const cfg = {
    bucket: pick('OSS_BUCKET', 'bucket'),
    region,
    akId: pick('OSS_AK_ID', 'akId'),
    akSecret: pick('OSS_AK_SECRET', 'akSecret'),
    endpoint: pick('OSS_ENDPOINT', 'endpoint'), // 仅调试用
  };

  const missing = [];
  if (!cfg.bucket) missing.push('bucket');
  if (!cfg.region) missing.push('region');
  if (!cfg.akId) missing.push('akId');
  if (!cfg.akSecret) missing.push('akSecret');
  if (missing.length) {
    throw new Error(
      `缺少配置：${missing.join('、')}\n` +
        `  办法一：在项目根建 oss.config.json：\n` +
        `    { "bucket": "bio-id-hub", "region": "oss-cn-hangzhou",\n` +
        `      "akId": "LTAI...", "akSecret": "..." }\n` +
        `  办法二：设环境变量 OSS_BUCKET / OSS_REGION / OSS_AK_ID / OSS_AK_SECRET`,
    );
  }
  return cfg;
}

/** OSS V1 签名：VER\nContent-MD5\nContent-Type\nDate\nCanonicalizedOSSHeaders + Resource */
function sign({ akSecret, method, bucket, key, contentType, date, headers }) {
  const canonHeaders = Object.keys(headers)
    .filter((k) => k.toLowerCase().startsWith('x-oss-'))
    .sort()
    .map((k) => `${k.toLowerCase()}:${String(headers[k]).trim()}\n`)
    .join('');
  const stringToSign = [
    method,
    '', // Content-MD5 不设就留空
    contentType,
    date,
    `${canonHeaders}/${bucket}/${key}`,
  ].join('\n');

  return {
    signature: crypto.createHmac('sha1', akSecret).update(stringToSign, 'utf8').digest('base64'),
    stringToSign,
  };
}

/** 目标地址：正式环境是 bucket.region.aliyuncs.com；endpoint 只在本地联调时用 */
function target(cfg) {
  const raw = cfg.endpoint || `${cfg.bucket}.${cfg.region}.aliyuncs.com`;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = new URL(withScheme);
  const insecure = u.protocol === 'http:';
  return {
    secure: !insecure,
    hostname: u.hostname,
    port: u.port || (insecure ? 80 : 443),
    origin: `${u.protocol}//${u.host}`,
  };
}

function base(cfg) {
  return target(cfg).origin;
}

/** key 里的中文要转义，但斜杠不能动（那是目录分隔） */
function encodeKey(key) {
  return key
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

function request(cfg, { method, key, body, contentType, date, extra }) {
  const headers = {
    Date: date,
    'Content-Type': contentType,
    'Content-Length': body ? body.length : 0,
    'x-oss-object-acl': 'public-read',
    ...(extra || {}),
  };
  const { signature } = sign({
    akSecret: cfg.akSecret,
    method,
    bucket: cfg.bucket,
    key,
    contentType,
    date,
    headers,
  });
  headers.Authorization = `OSS ${cfg.akId}:${signature}`;

  const encoded = encodeKey(key);

  const t = target(cfg);
  const mod = t.secure ? https : require('node:http');

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: t.hostname,
        port: t.port,
        method,
        path: `/${encoded}`,
        headers,
        timeout: 300000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            // 注意：这里不能截断，回读 latest.json 要整份解析（notes 一长就会被切坏）
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function human(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

/**
 * 服务端复制（同桶内秒完，不用再传一遍 80MB）。
 * 复制不了的话调用方会退回「老实上传」。
 */
async function copyObject(cfg, { fromKey, toKey, contentType }) {
  const encoded = encodeKey(fromKey);
  return request(cfg, {
    method: 'PUT',
    key: toKey,
    body: null,
    contentType,
    date: new Date().toUTCString(),
    extra: {
      'x-oss-copy-source': `/${cfg.bucket}/${encoded}`,
      'x-oss-metadata-directive': 'REPLACE',
    },
  });
}

async function main() {
  const cfg = loadConfig();
  const manifestPath = path.join(DIST, 'latest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('dist/latest.json 不存在，先跑一次 node build-exe.js');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.url) throw new Error('latest.json 里没有 url 字段，请重新打包');

  const assetName = String(manifest.url).split('/').pop();
  const assetPath = path.join(DIST, assetName);
  if (!fs.existsSync(assetPath)) {
    throw new Error(`清单指向的 ${assetName} 不在 dist/ 里，请重新打包`);
  }

  const buf = fs.readFileSync(assetPath);
  const realSha = crypto.createHash('sha256').update(buf).digest('hex');
  if (realSha !== manifest.sha256) {
    throw new Error(
      `文件与清单对不上：\n  清单 ${manifest.sha256}\n  实际 ${realSha}\n` +
        '（多半是改了 exe 却没重新生成清单，重新打包即可）',
    );
  }

  const jobs = [
    { key: assetName, body: buf, type: TYPES['.exe'] },
    { key: 'latest.json', body: fs.readFileSync(manifestPath), type: TYPES['.json'] },
  ];
  if (MANIFEST_ONLY) {
    // 只补清单：exe 上面已经校验过 sha256，确认线上下来的还是同一份就不用重传
    jobs.shift();
    console.log('  [i] --manifest-only：跳过 exe，只传 latest.json');
  }

  /* ---------- macOS 三个文件（--with-mac） ----------
   * 注意：mac 的清单必须叫 latest-mac.json，绝不能叫 latest.json ——
   * 两个平台的清单结构不同，混在一起会让对方的更新器读到错的版本。
   * zip 用纯 ASCII 名上传，中文名在 URL 里要转义，容易出错。
   */
  if (WITH_MAC) {
    const macDir = path.join(ROOT, 'dist-mac');
    const macManifestPath = path.join(macDir, 'latest-mac.json');
    if (!fs.existsSync(macManifestPath)) throw new Error('dist-mac/latest-mac.json 不存在，先跑 node build-mac.js');
    const mac = JSON.parse(fs.readFileSync(macManifestPath, 'utf8'));
    if (String(mac.version) !== String(manifest.version)) {
      throw new Error(`mac 清单是 v${mac.version}，exe 是 v${manifest.version}，版本号不一致`);
    }
    const macAsset = path.join(macDir, String(mac.url || '').split('/').pop());
    if (!fs.existsSync(macAsset)) throw new Error(`mac 更新包 ${path.basename(macAsset)} 不存在`);
    const macBuf = fs.readFileSync(macAsset);
    const macSha = crypto.createHash('sha256').update(macBuf).digest('hex');
    if (macSha !== mac.sha256) throw new Error(`mac 更新包与清单不符：\n  清单 ${mac.sha256}\n  实际 ${macSha}`);

    // 两个架构的首次安装包都传（Apple Silicon 用 arm64，Intel 机型用 x64）
    for (const arch of ['arm64', 'x64']) {
      const zipSrc = path.join(macDir, `物种鉴定聚合台-mac-${arch}.zip`);
      if (!fs.existsSync(zipSrc)) {
        console.log(`  [i] 没有 mac ${arch} zip，跳过这个架构的首次安装包`);
        continue;
      }
      jobs.push({
        key: `bio-id-hub-mac-${arch}.zip`,
        body: fs.readFileSync(zipSrc),
        type: TYPES['.zip'],
      });
    }
    jobs.push({ key: path.basename(macAsset), body: macBuf, type: TYPES['.js'] });
    jobs.push({ key: 'latest-mac.json', body: fs.readFileSync(macManifestPath), type: TYPES['.json'] });
  }

  // 顺序很重要：先传大文件，最后传清单。
  // 万一中途断了，线上清单还指向旧版本，不会出现「清单已更新但包还没到位」的坏状态。
  jobs.sort((a, b) => (a.key.endsWith('.json') ? 1 : 0) - (b.key.endsWith('.json') ? 1 : 0));

  console.log('');
  console.log(`  存储桶   ${cfg.bucket}`);
  console.log(`  地域     ${cfg.region}`);
  console.log(`  地址     ${base(cfg)}/`);
  console.log(`  版本     v${manifest.version}`);
  console.log(`  上传     ${jobs.map((j) => `${j.key}（${human(j.body.length)}）`).join('\n              ')}`);
  console.log('');

  if (DRY) {
    console.log('  --dry-run：配置和文件都正常，没有真的上传。');
    console.log('');
    console.log(`  打完包就是这个根地址： ${base(cfg)}`);
    return;
  }

  for (const job of jobs) {
    const date = new Date().toUTCString();
    process.stdout.write(`  → ${job.key} (${human(job.body.length)}) … `);
    const res = await request(cfg, {
      method: 'PUT',
      key: job.key,
      body: job.body,
      contentType: job.type,
      date,
    });
    if (res.status !== 200) {
      console.log('失败');
      throw new Error(
        `HTTP ${res.status}\n${res.text.slice(0, 600)}\n\n` +
          '  常见原因：AccessKey 不对（403 SignatureDoesNotMatch）、\n' +
          '  桶名或地域写错（404 NoSuchBucket）、没给这个桶的写权限。',
      );
    }
    console.log('ok');
  }

  /* ---------- 固定别名 bio-id-hub-win.exe ---------- */
  if (!MANIFEST_ONLY) {
    process.stdout.write(`  → 别名 ${STABLE_WIN} … `);
    const cp = await copyObject(cfg, { fromKey: assetName, toKey: STABLE_WIN, contentType: TYPES['.exe'] });
    if (cp.status === 200) {
      console.log('ok（服务端复制）');
    } else {
      console.log(`复制失败（HTTP ${cp.status}），改为老实上传一次`);
      const res = await request(cfg, {
        method: 'PUT',
        key: STABLE_WIN,
        body: buf,
        contentType: TYPES['.exe'],
        date: new Date().toUTCString(),
      });
      if (res.status !== 200) throw new Error(`别名上传失败 HTTP ${res.status}\n${res.text.slice(0, 300)}`);
      console.log('  → 别名 ok');
    }
  }

  if (VERIFY) {
    console.log('');
    console.log('  → 回读核对');
    const m = await request(cfg, {
      method: 'GET',
      key: 'latest.json',
      contentType: TYPES['.json'],
      date: new Date().toUTCString(),
    });
    if (m.status !== 200) throw new Error(`读 latest.json 失败：HTTP ${m.status}`);
    const remote = JSON.parse(m.text);
    if (remote.version !== manifest.version) {
      throw new Error(`线上清单是 v${remote.version}，本地是 v${manifest.version}`);
    }
    const h = await request(cfg, {
      method: 'HEAD',
      key: assetName,
      contentType: TYPES['.exe'],
      date: new Date().toUTCString(),
    });
    if (h.status !== 200) throw new Error(`HEAD ${assetName} 失败：HTTP ${h.status}`);
    const size = Number(h.headers['content-length'] || 0);
    if (size !== buf.length) throw new Error(`线上大小 ${size} 与本地 ${buf.length} 不符`);
    console.log(`     latest.json v${remote.version} / ${assetName} ${human(size)} 一致`);

    if (!MANIFEST_ONLY) {
      const a = await request(cfg, {
        method: 'HEAD',
        key: STABLE_WIN,
        contentType: TYPES['.exe'],
        date: new Date().toUTCString(),
      });
      const aliasSize = Number(a.headers['content-length'] || 0);
      if (a.status !== 200) throw new Error(`HEAD ${STABLE_WIN} 失败：HTTP ${a.status}`);
      if (aliasSize !== buf.length) throw new Error(`别名 ${STABLE_WIN} 线上 ${aliasSize} 与本地 ${buf.length} 不符`);
      console.log(`     别名 ${STABLE_WIN} 与 ${assetName} 同大小`);
    }

    if (WITH_MAC) {
      const macDir = path.join(ROOT, 'dist-mac');
      const macM = JSON.parse(fs.readFileSync(path.join(macDir, 'latest-mac.json'), 'utf8'));
      const rm = await request(cfg, {
        method: 'GET',
        key: 'latest-mac.json',
        contentType: TYPES['.json'],
        date: new Date().toUTCString(),
      });
      if (rm.status !== 200) throw new Error(`读 latest-mac.json 失败：HTTP ${rm.status}`);
      const remoteMac = JSON.parse(rm.text);
      if (remoteMac.version !== macM.version) {
        throw new Error(`线上 mac 清单是 v${remoteMac.version}，本地是 v${macM.version}`);
      }
      console.log(`     latest-mac.json v${remoteMac.version} 一致`);
      for (const arch of ['arm64', 'x64']) {
        const local = path.join(macDir, `物种鉴定聚合台-mac-${arch}.zip`);
        if (!fs.existsSync(local)) continue;
        const expect = fs.statSync(local).size;
        const hh = await request(cfg, {
          method: 'HEAD',
          key: `bio-id-hub-mac-${arch}.zip`,
          contentType: TYPES['.zip'],
          date: new Date().toUTCString(),
        });
        if (hh.status !== 200) throw new Error(`HEAD bio-id-hub-mac-${arch}.zip 失败：HTTP ${hh.status}`);
        const sz = Number(hh.headers['content-length'] || 0);
        if (sz !== expect) throw new Error(`bio-id-hub-mac-${arch}.zip 线上 ${sz} 与本地 ${expect} 不符`);
        console.log(`     bio-id-hub-mac-${arch}.zip ${human(sz)} 一致`);
      }
    }
  }

  console.log('');
  console.log('  发布完成。程序里的更新源应为：');
  console.log(`    ${base(cfg)}`);
  console.log('');
  console.log('  群发文案里用固定别名（永远指向最新版）：');
  console.log(`    Windows  ${base(cfg)}/${STABLE_WIN}`);
  console.log(`    macOS    ${base(cfg)}/bio-id-hub-mac-arm64.zip（M 芯片）`);
  console.log(`             ${base(cfg)}/bio-id-hub-mac-x64.zip（Intel）`);
  console.log('');
  console.log('  旧版本的 exe / main-*.js 会留在桶里（一版约 84 MB），想清理时跑：');
  console.log('    node tools/oss-clean.js            # 先看要删什么');
  console.log('    node tools/oss-clean.js --apply    # 再真的删');
  console.log('');
}

main().catch((err) => {
  console.error('');
  console.error(`  ${err.message}`);
  console.error('');
  process.exitCode = 1;
});
