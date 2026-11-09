'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Sites, SITE_META } = require('./lib/adapters');
const { aggregate } = require('./lib/aggregate');
const assets = require('./lib/assets');
const secure = require('./lib/secure');
const updater = require('./lib/updater');
const { APP_VERSION, UPDATE_URL, APP_NAME } = require('./lib/version');
const { isSea, isAppBundle, APP_DIR, DATA_DIR, DATA_NOTE, RESULTS_DIR } = require('./lib/env');

/**
 * 端口写死 8791。
 *
 * 两个软件（聚合台 / 标注工坊）要能同时开着，端口就必须各归各的。早先端口是存在
 * config.json 里的，两个便携版 exe 放在同一个文件夹时会共用一份配置，互相把端口
 * 带跑 —— 结果两边都跑到 8791 上抢同一个端口。现在端口是常量，
 * --port / PORT 只留着调试用，不会被旧的配置文件左右。
 */
const APP_PORT = 8791;

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const SESSION_PATH = path.join(DATA_DIR, 'session.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

// 上次更新留下的旧 exe / 半截下载，这时才有机会删（老进程已退出）
updater.cleanup();

/* ---------------- 密文读写 ---------------- */

/**
 * 读取加密文件。返回 { value, legacy, error }
 *  - 文件不存在 → value 为 null
 *  - 旧版本遗留的明文 JSON → value 有值且 legacy=true（随后会被重新加密覆盖）
 *  - 密文解不开（换了电脑/用户，或文件损坏）→ value 为 null 且带 error
 */
function readSealed(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return { value: null };
  }
  if (!text) return { value: null };
  if (text.startsWith(secure.PREFIX + '.')) {
    const r = secure.open(text);
    if (r.ok) return { value: r.value, kdf: r.kdf };
    return { value: null, error: r.error };
  }
  try {
    return { value: JSON.parse(text), legacy: true };
  } catch {
    return { value: null, error: '文件内容既不是密文也不是合法 JSON' };
  }
}

function writeSealed(file, value, opts) {
  fs.writeFileSync(file, secure.seal(value, opts), 'utf8');
}

/* ---------------- 默认凭据（内嵌密文） ---------------- */

function loadDefaults() {
  const fallback = {
    port: 8791,
    sites: {
      duoshi: {},
      inaturalist: {},
      quarryman: {},
      butterflyai: {},
      xingse: {},
      doubao: {},
      kuaitong: {},
      dongniao: {},
      'dongniao-mammal': {},
      'dongniao-herp': {},
      'baidu-animal': {},
      'baidu-plant': {},
      ebird: {},
    },
  };
  // 开源版本不含任何内置账号：lib/seed.js 是可选的本地种子（已被 .gitignore 排除）。
  // 没有这个文件、或解不开时，按空白配置启动，由使用者在「账号设置」里填自己的账号。
  try {
    const r = secure.open(require('./lib/seed'));
    if (!r.ok) throw new Error(r.error);
    return r.value;
  } catch {
    console.log('  [i] 未发现可用的本地账号种子（仓库本身不带账号），按空白配置启动。');
    console.log('      请在「账号设置」里填写你自己的账号 / API Key，申请方法见 账号与API申请指南.md。');
    return fallback;
  }
}

const DEFAULT_CONFIG = loadDefaults();

const stored = readSealed(CONFIG_PATH);
if (stored.error) {
  console.log(`  [!!] config.json 解密失败：${stored.error}`);
      console.log('       将按空白配置重建（原来的改动会丢失，如有自定义账号请重新填写）。');
}

const config = { port: APP_PORT, ...(stored.value || {}) };
config.port = APP_PORT; // 旧配置里存的端口不再采信（可能就是被别的软件带跑的 8791）
config.sites = { ...DEFAULT_CONFIG.sites, ...(stored.value?.sites || {}) };
// 新增站点（例如豆包）在老用户的 config.json 里没有条目，这里补空对象，
// 免得设置面板/脱敏逻辑把它们当「不存在的站点」跳过
for (const k of Object.keys(SITE_META)) if (!config.sites[k]) config.sites[k] = {};

/* DeepSeek：结果页「GBIF·DS」小标用的 API Key。
 * 它不是识别站点（不参与投票、不进站点条），所以单独挂在 config.deepseek 下；
 * 跟站点密钥一样只以密文存本机，/api/status 只说「填没填」，绝不回传明文。 */
config.deepseek = { apiKey: '', model: 'deepseek-chat', ...(config.deepseek || {}) };

/** 落盘：sites 和 deepseek 一起写，免得某个调用点只写了一半 */
function persistConfig() {
  writeSealed(CONFIG_PATH, { port: config.port, sites: config.sites, deepseek: config.deepseek });
}

// 内置密钥补齐：老用户的 config.json 里可能只有个空条目（或从没填过），
// 这时用内嵌种子里的 key 填上 —— 学员拿到 exe 什么都不填就能用懂鸟 / eBird。
// 自己填过的不动（优先级：本机 config > 内嵌种子）。
for (const [k, def] of Object.entries(DEFAULT_CONFIG.sites || {})) {
  const cur = config.sites[k];
  if (!cur || !def || typeof def !== 'object') continue;
  for (const f of SITE_META[k]?.fields || []) {
    // 密钥类字段必须在种子里；地区这类非密钥字段也照填（如 eBird 的默认地区），
    // 但只在本地为空时填，用户自己选过的不覆盖。
    if (!def[f.key] || cur[f.key]) continue;
    cur[f.key] = def[f.key];
  }
}

/* ---------------- 内嵌凭据换代迁移 ----------------
 * 从没动过设置的用户本地没有 config.json，直接吃新的内嵌账号；
 * 但点过「保存并登录」的用户，本地会把当时继承来的旧账号固化下来，盖住新种子。
 * 这些旧用户名是历史内嵌值，不可能是用户自己填的，遇到就对齐成新种子。
 */
const LEGACY_USERNAMES = {
  inaturalist: ['guo_yan-qing'],
};
for (const [key, olds] of Object.entries(LEGACY_USERNAMES)) {
  const cur = config.sites[key];
  const def = DEFAULT_CONFIG.sites[key];
  if (!cur || !def) continue;
  const oldName = String(cur.username || '').trim();
  if (olds.includes(oldName) && def.username && def.username !== oldName) {
    config.sites[key] = { ...cur, username: def.username, password: def.password };
    console.log(`  [ok] ${key} 的账号 ${oldName} 已换成内置的新账号`);
  }
}

// 首次运行 / 明文旧版 / 解密失败时重写为密文；内容没变则不重复加密（DPAPI 每次密文都不同）
const snapshot = JSON.stringify({ port: config.port, sites: config.sites, deepseek: config.deepseek });
if (
  !stored.value ||
  stored.legacy ||
  stored.error ||
  snapshot !==
    JSON.stringify({ port: stored.value.port, sites: stored.value.sites, deepseek: stored.value.deepseek })
) {
  persistConfig();
  if (stored.legacy) console.log('  [ok] 检测到旧版明文配置，已加密改写');
}

const storedSession = readSealed(SESSION_PATH);
if (storedSession.error) {
  console.log(`  [i] 登录缓存无法解密：${storedSession.error}`);
}
const sessions = storedSession.value || {};
config.sessions = sessions;

const sites = new Sites(config);
// 自然在线登录后要把令牌、中转相册 ID 写回 config.json
sites.persistConfig = () => persistConfig();

/* ---------------- 站点可见性 ----------------
 * 自然在线（原「形色」，站点键仍是 xingse）早先是隐藏站点，要按 Ctrl+Alt+X 输暗号才放出来；
 * 现在它和其它站点一样**默认对所有人开放**，站点清单、友链、设置面板、/api/identify
 * 都能直接用，没有暗号、也没有开关。
 * 这两个函数留着是因为调用点很多（而且以后要再藏某个站点还能用），只是不再有任何过滤。
 */
function allowSite(key) {
  return !!SITE_META[key];
}

/** 回给浏览器的站点清单 */
function visibleSites() {
  return sites.meta();
}

function persistSessions() {
  try {
    // 会话缓存高频写入，用本机指纹方案（1ms 级）；DPAPI 每次要拉 PowerShell，约 0.6 秒
    writeSealed(SESSION_PATH, sites.sessions(), { dpapi: false });
  } catch (err) {
    console.log(`  [!!] 登录缓存写入失败：${err.message}`);
  }
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大（图片需小于 20MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname;
  const hit = assets.get(rel);
  if (!hit) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': hit.mime, 'cache-control': 'no-cache' });
  res.end(hit.body);
}

/**
 * 把本机的一张图片原样发给页面 —— 给「别的程序直接跳到本程序看这张图」用的
 * （物种标注工坊点一下就在这边打开同一张照片）。
 * 只认图片扩展名，别的任何路径都不发。
 */
const LOCAL_IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff']);
const LOCAL_IMG_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

function serveLocalFile(res, raw) {
  const full = path.resolve(String(raw || ''));
  const ext = path.extname(full).toLowerCase();
  if (!raw || !LOCAL_IMG_EXT.has(ext)) return sendJson(res, 400, { error: '只支持图片文件' });
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return sendJson(res, 404, { error: '文件不存在或已被移动' });
  }
  if (!st.isFile()) return sendJson(res, 400, { error: '这不是文件' });
  res.writeHead(200, {
    'content-type': LOCAL_IMG_MIME[ext] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-store',
    // 文件名里可能有中文，header 只能放 ASCII，前端解码回来
    'x-filename': encodeURIComponent(path.basename(full)),
  });
  fs.createReadStream(full).pipe(res);
}

async function handleIdentify(req, res) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: '请求数据格式错误' });
  }

  const { filename = 'image.jpg', mime = 'image/jpeg', data, dataSmall, dataJpeg, sites: wanted } = payload;
  if (!data) return sendJson(res, 400, { error: '未收到图片数据' });

  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0) return sendJson(res, 400, { error: '图片为空' });
  if (buffer.length > 20 * 1024 * 1024) {
    return sendJson(res, 400, { error: '图片超过 20MB（网页上传会自动压缩，直连接口请自行缩小）' });
  }
  // 多识要求 ≤640×640，前端会额外给一张长边 640 的副本
  const small = dataSmall ? Buffer.from(dataSmall, 'base64') : null;
  // 植物智只收 JPG，原图不是 JPEG 时用前端转码的那份
  const jpeg = dataJpeg ? Buffer.from(dataJpeg, 'base64') : null;

  // eBird 这类「核对层」站点没有图片识别接口，要从识别名单里剔掉；
  // 前端单独调 /api/ebird/check，在结果表里加一列。
  // 同一个网站的多个模型互斥（多识三分组、懂鸟三类、晓虫各分区、文浩蝶/蛾、百度动/植物）：
  // 前端已经保证一次只开一个，这里再兜一层，防止旧缓存或直接调接口时把同一站请求两遍。
  const usedVendor = new Set();
  const keys = (Array.isArray(wanted) && wanted.length
    ? wanted.filter((k) => allowSite(k))
    : Object.keys(SITE_META).filter((k) => allowSite(k))
  )
    .filter((k) => !SITE_META[k]?.verify)
    .filter((k) => {
      const v = SITE_META[k]?.vendor;
      if (!v) return true;
      if (usedVendor.has(v)) return false;
      usedVendor.add(v);
      return true;
    });
  // 勾的站点全被过滤掉了（比如只有隐藏站点），别静悄悄返回空结果
  if (!keys.length) {
    const onlyVerify = (Array.isArray(wanted) ? wanted : []).some((k) => SITE_META[k]?.verify);
    return sendJson(res, 400, {
      error: onlyVerify ? 'eBird 只查地区记录、不接收图片，请至少再勾选一个识别站点' : '没有可用的识别站点，请重新勾选',
    });
  }

  const img = { buffer, small, jpeg, mime, filename };
  const started = Date.now();

  // 同一引擎的站点（文浩识蛾/识蝶）只真请求一次，另一个复用结果，避免重复计票
  const engineOwner = new Map();
  const plan = keys.map((k) => {
    const engine = SITE_META[k]?.engine;
    if (!engine) return { key: k };
    if (engineOwner.has(engine)) return { key: k, mirrorOf: engineOwner.get(engine) };
    engineOwner.set(engine, k);
    return { key: k };
  });

  const list = await Promise.all(
    plan.filter((p) => !p.mirrorOf).map((p) => sites.identify(p.key, img)),
  );
  const results = {};
  for (const r of list) results[r.site] = r;
  for (const p of plan) {
    if (!p.mirrorOf) continue;
    const src = results[p.mirrorOf] || null;
    results[p.key] = {
      site: p.key,
      ok: !!src?.ok,
      ms: 0,
      items: src?.items || [],
      error: src?.error,
      status: src?.status,
      mirrorOf: p.mirrorOf,
    };
  }
  // 保持用户勾选的顺序
  const ordered = {};
  for (const k of keys) if (results[k]) ordered[k] = results[k];

  persistSessions();

  const agg = aggregate(ordered);
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    filename,
    size: buffer.length,
    results: ordered,
    verdict: agg.verdict,
    best: agg.best,
  };
  try {
    fs.appendFileSync(
      path.join(RESULTS_DIR, 'history.jsonl'),
      JSON.stringify(record) + '\n',
      'utf8',
    );
  } catch {
    /* 记录失败不影响识别 */
  }

  sendJson(res, 200, {
    id: record.id,
    filename,
    elapsed: Date.now() - started,
    results: ordered,
    aggregate: agg,
    siteStates: visibleSites(),
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        sites: visibleSites(),
        config: sanitizeConfig(),
        deepseek: deepseekPublic(),
        app: {
          name: APP_NAME,
          version: APP_VERSION,
          // 认自己用的唯一标识：端口被占时靠它分清「是另开的一个我」还是「另一个软件」
          id: 'bio-id-hub',
          isExe: isSea,
          mode: isSea ? 'exe' : isAppBundle ? 'bundle' : 'source',
          updateConfigured: Boolean(UPDATE_URL),
          updatedFlag: process.env.BIOID_UPDATED === '1',
          // 能给页面喂本机图片路径（别的程序跳过来时用），老版本没有这个能力
          openLocalImage: true,
          // 认 ?group=insect 这类类群参数（物种标注工坊跳过来时带）
          openLocalImageGroup: true,
          // 认 ?sites=a,b,c 这类「精确模型清单」：标注工坊开着哪几个模型，跳过来就用哪几个
          openLocalSites: true,
          // 认 window.postMessage 送图（标注工坊已经开着这一页时，直接把图塞进来，不再开新标签页）
          acceptImageMessage: true,
        },
      });
    }

    /* ---------------- 自动更新 ---------------- */

    if (pathname === '/api/update/check' && req.method === 'GET') {
      const force = url.searchParams.get('force') === '1';
      updater.resetError();
      const info = await updater.check({ force });
      // 顺带把下载进度带上，前端刷新后能接上正在进行的下载
      return sendJson(res, 200, { ...info, progress: updater.status() });
    }

    if (pathname === '/api/update/progress' && req.method === 'GET') {
      return sendJson(res, 200, updater.status());
    }

    if (pathname === '/api/update/download' && req.method === 'POST') {
      try {
        const r = await updater.download();
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    if (pathname === '/api/update/apply' && req.method === 'POST') {
      try {
        const r = await updater.apply();
        sendJson(res, 200, r);
        // 新进程已经上路。这里先把监听关掉，它才能立刻接管端口；
        // 再给它几秒启动时间，之后本进程才退出（避免新进程一直撞 EADDRINUSE）。
        setTimeout(() => {
          try {
            server.close();
            server.closeAllConnections?.();
          } catch {
            /* ignore */
          }
        }, 80);
        setTimeout(() => process.exit(0), 2500);
        return;
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    /* ---------------- 自然在线（站点键 xingse）：验证码登录 ---------------- */

    if (pathname === '/api/xingse/captcha' && req.method === 'GET') {
      try {
        const c = await sites.getXingseCaptcha();
        return sendJson(res, 200, c);
      } catch (err) {
        return sendJson(res, 502, { error: err.message || '验证码获取失败' });
      }
    }

    if (pathname === '/api/xingse/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');
      try {
        await sites.loginXingse(String(body.captcha || '').trim(), body.key);
        return sendJson(res, 200, { ok: true, sites: visibleSites() });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message || '登录失败' });
      }
    }

    if (pathname === '/api/xingse/check' && req.method === 'POST') {
      const ok = await sites.checkXingse();
      return sendJson(res, 200, { ok, sites: visibleSites() });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');
      const target = body.site || 'all';
      const keys = (target === 'all' ? Object.keys(SITE_META) : [target]).filter(allowSite);
      // 共用同一账号的分组（多识三分组）只登录一次，结果回填给每个分组
      const groups = new Map();
      for (const k of keys) {
        // 需要人工输验证码的站点不在这里代登，走各自的路由
        if (SITE_META[k]?.manualAuth) continue;
        // 没填密钥的「密钥型」站点直接跳过，免得每次都报一条无意义的失败
        if (SITE_META[k]?.auth === 'key' && !config.sites[k]?.apiKey) continue;
        const acct = SITE_META[k]?.account || k;
        if (!groups.has(acct)) groups.set(acct, []);
        groups.get(acct).push(k);
      }
      const out = {};
      for (const [acct, members] of groups) {
        let ok = true;
        let error = '';
        try {
          await sites.login(acct, true); // 用户点了「保存并登录」→ 强制重新登录
        } catch (err) {
          ok = false;
          error = err.message;
        }
        for (const m of members) out[m] = ok ? { ok: true } : { ok: false, error };
      }
      persistSessions();
      return sendJson(res, 200, { login: out, sites: visibleSites() });
    }

    if (pathname === '/api/config' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');
      if (body.sites && typeof body.sites === 'object') {
        for (const [k, v] of Object.entries(body.sites)) {
          if (!allowSite(k) || typeof v !== 'object') continue;
          const next = { ...config.sites[k], ...v };
          // 空值一律表示「不修改」，保留已加密保存的那份
          if (SITE_META[k]?.auth !== 'key') {
            if (!v.password) next.password = config.sites[k]?.password || '';
            if (!v.username) next.username = config.sites[k]?.username || '';
          }
          // 密钥型站点的每一个密钥字段都遵守「留空 = 不改」
          for (const f of SITE_META[k]?.fields || []) {
            if (f.secret && !v[f.key]) next[f.key] = config.sites[k]?.[f.key] || '';
          }
          if (!v.apiKey) next.apiKey = config.sites[k]?.apiKey || '';
          // 换了密钥就把旧令牌作废，下次识别自动用新密钥换一张
          if (v.apiKey && v.apiKey !== config.sites[k]?.apiKey) delete next.token;
          if (v.accessKey && v.accessKey !== config.sites[k]?.accessKey) delete next.token;
          if (v.accessSecret && v.accessSecret !== config.sites[k]?.accessSecret) delete next.token;
          config.sites[k] = next;
        }
        sites.config = config;
      }
      // DeepSeek 的 key / 模型：留空同样表示「不修改」，已存的那份不动
      if (body.deepseek && typeof body.deepseek === 'object') {
        const d = body.deepseek;
        const next = { ...config.deepseek };
        const k = String(d.apiKey || '').trim();
        if (k) next.apiKey = k;
        if (typeof d.model === 'string') next.model = d.model.trim() || 'deepseek-chat';
        // 明确要清空时（换自己的号 / 不想再用）走这里
        if (d.clear === true) next.apiKey = '';
        config.deepseek = next;
      }
      persistConfig();
      return sendJson(res, 200, { ok: true, config: sanitizeConfig(), deepseek: deepseekPublic() });
    }

    /* ---------------- eBird：坐标 → 地区 ----------------
     * 前端点开 eBird 时会先问浏览器要一次定位，把经纬度发过来；
     * 这里借 eBird 的热点接口换算成地区码（CN-35 这种），前端再预填进选择框。
     * 只读、不写配置，用户点「确定」时才走 /api/config 落盘。
     */
    if (pathname === '/api/ebird/region' && req.method === 'GET') {
      const cfg = config.sites.ebird || {};
      if (!cfg.apiKey) return sendJson(res, 200, { ok: false, error: 'eBird 未配置 API key' });
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lng'));
      try {
        const out = await require('./lib/ebird').regionAt(cfg, lat, lng);
        return sendJson(res, 200, { ok: Boolean(out.code), ...out });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message || '定位换算失败' });
      }
    }

    /* ---------------- eBird：地区记录核对 ----------------
     * 识别完成后再调用，传入候选学名，返回每个物种在本地区近 14 天的记录情况。
     * 它不参与打分，只是给结果加一条「本地有没有人见过」的旁证。
     */
    if (pathname === '/api/ebird/check' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');
      const names = Array.isArray(body.sciNames) ? body.sciNames : [];
      const cfg = { ...(config.sites.ebird || {}) };
      if (body.region) cfg.region = String(body.region).trim();
      if (!cfg.apiKey) {
        return sendJson(res, 200, { ok: false, error: 'eBird 未配置 API key', skipped: true });
      }
      try {
        const out = await require('./lib/ebird').check(cfg, names);
        return sendJson(res, 200, { ok: true, ...out });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message || 'eBird 查询失败' });
      }
    }

    /* ---------------- iNaturalist：学名 → 属 → 「该地区该属有多少种」深链 ----------------
     * 识别完成后前端把候选学名发过来，这里把属名解析成 iNat 的 taxon_id（带缓存），
     * 前端再用 place_id + taxon_id + view=species 拼出 Explore 的「物种」视图链接。
     * 解析失败不影响使用：链接会退回 taxon_name=属名，iNat 自己也能解析。
     */
    if (pathname === '/api/inat/taxa' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');
      const names = Array.isArray(body.names) ? body.names.slice(0, 30) : [];
      const hint = String(body.hint || '');
      try {
        const taxa = await require('./lib/inat').resolveTaxa(names, hint);
        return sendJson(res, 200, { ok: true, taxa });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message || 'iNaturalist 查询失败', taxa: {} });
      }
    }

    /* 地区搜索：主页面上「iNat 检索地区」的输入框用它把地名换成 place_id。
     * 列表里只放了常用国家和省级行政区，用户想用自己常去的城市 / 保护区 / 公园，
     * 就在这里搜（iNat 的 places 接口，中文英文都能搜）。只读，不落盘。
     */
    if (pathname === '/api/inat/places' && req.method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim();
      if (q.length < 2) return sendJson(res, 200, { ok: true, results: [] });
      try {
        const results = await require('./lib/inat').searchPlaces(q, 8);
        return sendJson(res, 200, { ok: true, results });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message || '地区搜索失败', results: [] });
      }
    }

    // 手动验证 / 调试用：一条 GET 就能看到拼出来的链接
    if (pathname === '/api/inat/link' && req.method === 'GET') {
      const latin = url.searchParams.get('latin') || '';
      const place = url.searchParams.get('place') || '';
      const inat = require('./lib/inat');
      const genus = inat.genusOf(latin);
      if (!genus) return sendJson(res, 200, { ok: false, error: '学名里认不出属名' });
      const taxa = await inat.resolveTaxa([genus], url.searchParams.get('hint') || '').catch(() => ({}));
      const hit = taxa[genus.toLowerCase()];
      // 自定义地区：?placeId=222739&placeName=… 优先于 place 代码
      const customId = Number(url.searchParams.get('placeId')) || 0;
      const resolved = inat.resolvePlace(
        customId > 0
          ? { placeId: customId, placeName: url.searchParams.get('placeName') || '' }
          : { place },
      );
      return sendJson(res, 200, {
        ok: true,
        genus,
        taxonId: hit ? hit.id : 0,
        place: resolved.name,
        placeId: resolved.placeId,
        custom: resolved.custom,
        url: inat.buildUrl({ genus, taxonId: hit ? hit.id : 0, placeId: resolved.placeId }),
      });
    }

    /* 植物智 PPBC（手动验证 / 调试用）：一条 GET 看拼出来的链接。
     * 结果里学名旁的「PPBC」小标（只在植物类群下出现）就是按这个规则拼的，
     * 省名必须写全称（「福建省」），映射表在 lib/ppbc.js。 */
    /* 植物智（PPBC）：把「检索地区」换算成 pro（省）+ didian（地点）两个参数。
     * 自定义地区要先查一次 iNat 的 place 详情才知道它在哪个省、是不是境外，
     * 前端在「选好地区」那一刻调一次，把结果存进配置，之后渲染就不用再问了。 */
    if (pathname === '/api/ppbc/region' && req.method === 'GET') {
      const ppbc = require('./lib/ppbc');
      const placeId = Number(url.searchParams.get('placeId')) || 0;
      const placeName = url.searchParams.get('placeName') || '';
      const code = url.searchParams.get('place') || '';
      try {
        const r = await ppbc.resolveRegion({ code, placeId, placeName });
        return sendJson(res, 200, { ok: true, ...r, scope: ppbc.scopeLabel(r) });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message || '换算地区失败' });
      }
    }

    if (pathname === '/api/ppbc/link' && req.method === 'GET') {
      const latin = url.searchParams.get('latin') || url.searchParams.get('genus') || '';
      const inat = require('./lib/inat');
      const ppbc = require('./lib/ppbc');
      const genus = inat.genusOf(latin);
      if (!genus) return sendJson(res, 200, { ok: false, error: '学名里认不出属名' });
      const region = await ppbc.resolveRegion({
        code: url.searchParams.get('place') || '',
        placeId: Number(url.searchParams.get('placeId')) || 0,
        placeName: url.searchParams.get('placeName') || '',
      });
      return sendJson(res, 200, {
        ok: true,
        genus,
        place: region.name,
        pro: region.pro,
        didian: region.didian,
        scope: ppbc.scopeLabel(region),
        url: ppbc.buildUrl({ genus, pro: region.pro, didian: region.didian }),
      });
    }

    /* ---------------- 自然在线：按地区查「这个属在本地名录里有哪些种」 ----------------
     * 跟看图识别是同一个后端（同一张令牌），站点默认对所有用户开放。
     * 站点搜索用中文标题模糊匹配，关键词由检索地区名推（「南平市武夷山市」→「武夷山」），
     * 用户也可以在面板里改。名录接口只能整份拉（不能按属过滤、不能分页），
     * 所以 lib/nature.js 里按站点缓存 30 分钟。 */
    if (pathname === '/api/nature/sites' && req.method === 'GET') {
      const nat = require('./lib/nature');
      const genus = require('./lib/inat').genusOf(
        url.searchParams.get('genus') || url.searchParams.get('latin') || '',
      );
      if (!genus) return sendJson(res, 200, { ok: false, error: '学名里认不出属名' });

      // 关键词优先级：面板里手填的 q > 检索地区推出来的
      let keyword = String(url.searchParams.get('q') || '').trim();
      let scope = '';
      if (!keyword) {
        const ppbc = require('./lib/ppbc');
        // 前端一般会把当前检索地区带上来；没带就退回配置里存的那份（面板刷新的场景）
        const inatCfg = config.sites.inaturalist || {};
        const region = await ppbc
          .resolveRegion({
            code: url.searchParams.get('place') || inatCfg.place || '',
            placeId: Number(url.searchParams.get('placeId')) || Number(inatCfg.placeId) || 0,
            placeName: url.searchParams.get('placeName') || inatCfg.placeName || '',
          })
          .catch(() => null);
        const areaName = region?.didian || region?.pro || region?.name || '';
        keyword = nat.keywordOf(areaName);
        scope = ppbc.scopeLabel(region || {});
      }

      const token = String(config.sites.xingse?.token || '');
      try {
        const out = await nat.genusBySites(token, { genus, keyword });
        return sendJson(res, 200, { ok: true, scope, ...out });
      } catch (err) {
        return sendJson(res, 200, {
          ok: false,
          genus,
          keyword,
          scope,
          error: err.message || '自然在线查询失败',
        });
      }
    }

    /* ---------------- GBIF + DeepSeek：这个属在这个地区有哪些种 ----------------
     * 结果页学名旁的「GBIF·DS」点开走这里。
     *
     * 顺序上刻意是「先 GBIF，再 DeepSeek」：
     *   · GBIF 那边拿的是可核查的真实记录（属内种名单 + 该地区各有多少条），
     *     学名以它为准，模型只许照抄；
     *   · DeepSeek 负责配中文名、写归纳、指出明显缺漏。
     * 没配 key 也有结果：GBIF 那张表照常出，只是没有中文名和总结。
     * GBIF 挂掉时也不拖累整个识别流程，单独回一条错误给面板。
     */
    if (pathname === '/api/gbifds/query' && req.method === 'GET') {
      const gb = require('./lib/gbifds');
      const genus = require('./lib/inat').genusOf(
        url.searchParams.get('genus') || url.searchParams.get('latin') || '',
      );
      if (!genus) return sendJson(res, 200, { ok: false, error: '学名里认不出属名' });

      // 类群决定 kingdom：同名属在动植物里都有（Ficus 桑科/䗉螺、Pieris 马醉木/粉蝶），
      // 不带界 GBIF 会直接匹配不到。通用组不知道是哪一类，交给 lib/gbifds.js 依次试。
      const group = String(url.searchParams.get('group') || '').trim();
      const kingdom = group === 'plant' ? 'Plantae' : group === 'fungi' ? 'Fungi' : group === 'general' ? '' : 'Animalia';

      const ppbc = require('./lib/ppbc');
      const inatCfg = config.sites.inaturalist || {};
      // 前端传了地区就以它为准，三项全没传才退回配置里存的那份。
      // 不能逐项兜底：选了「全世界」只传 place=WORLD，placeId 一兜底就变成上一次的
      // 武夷山，结果按福建算了。
      const qPlace = String(url.searchParams.get('place') || '').trim();
      const qPlaceId = Number(url.searchParams.get('placeId')) || 0;
      const qPlaceName = String(url.searchParams.get('placeName') || '').trim();
      const explicit = Boolean(qPlace || qPlaceId || qPlaceName);
      const regionCode = explicit ? qPlace : inatCfg.place || '';
      const region = await ppbc
        .resolveRegion({
          code: regionCode,
          placeId: explicit ? qPlaceId : Number(inatCfg.placeId) || 0,
          placeName: explicit ? qPlaceName : inatCfg.placeName || '',
        })
        .catch(() => ({ pro: '', didian: '', inChina: true, name: '', custom: false }));
      // resolveRegion 只回 pro/didian，国家码得自己补上 —— GBIF 靠它筛境外
      region.code = regionCode;

      let data;
      try {
        data = await gb.query({ genus, kingdom, region });
      } catch (err) {
        return sendJson(res, 200, { ok: false, genus, error: err.message || 'GBIF 查询失败' });
      }
      // 记录没查成 ≠ 该地区没有分布。这两种情况必须分开：
      // 混在一起会让人以为「这个属在本地就是没有」，比报错更误导。
      // 也不把空结果交给模型 —— 它会顺着编出一份像模像样的清单来。
      if (data.facetError) {
        return sendJson(res, 200, {
          ok: false,
          genus: data.genus,
          error: `GBIF 的记录没能取到（${data.facetError}）。这不代表该地区没有分布，过一会儿再试一次。`,
        });
      }

      // 面板顶部原样显示「问的是哪句话」，方便核对和复制
      const area = data.scope || region.name || '全球';
      const question = `请通过 GBIF 查询 ${data.genus} 属在 ${area} 的全部种有哪些？`;

      // 中文名先问 iNaturalist：那边的俗名是志愿者一条条投票出来的，还能追溯，
      // 比模型凭语料回忆可靠。取不到的才交给 DeepSeek 补，两处都没有就留空。
      // iNat 挂了/限流了都不影响主流程，最多是中文名少几个。
      let inat = { map: {}, tried: 0, stopped: false };
      try {
        inat = await gb.inatChineseNames(data.species);
      } catch {
        /* 网络不通就当没拿到，后面照旧走 DeepSeek */
      }

      const pub = deepseekPublic();
      let answer = null;
      let warning = '';
      if (!pub.hasApiKey) {
        warning = inat.map && Object.keys(inat.map).length
          ? '没配 DeepSeek API Key：中文名只取了 iNaturalist 有的那些，也没有归纳总结。到「账号设置」填一个 key 就能补齐剩下的。'
          : '没配 DeepSeek API Key：下面是 GBIF 原始记录，没有中文名和归纳。到「账号设置」填一个 key 就能补上。';
      } else {
        try {
          answer = await gb.ask({
            apiKey: config.deepseek.apiKey,
            model: pub.model,
            question,
            data,
            known: inat.map,
          });
        } catch (err) {
          warning = 'DeepSeek 没答上来：' + (err.message || '未知错误') + '（GBIF 数据和 iNaturalist 的中文名不受影响）';
        }
      }

      // 合并中文名：**iNaturalist 优先**，模型只在空缺处补。
      // 模型偶尔会把已有名字「顺手纠正」成别的写法，这里直接覆盖掉，不让它改。
      const cnMap = { ...((answer && answer.cn) || {}) };
      for (const [lat, cn] of Object.entries(inat.map || {})) {
        if (cn) cnMap[lat] = cn;
      }

      let nInat = 0;
      let nDs = 0;
      let nMiss = 0;
      const species = data.species.map((s) => {
        const fromInat = gb.lookupCn(inat.map, s.latin);
        const cn = fromInat || gb.lookupCn(answer && answer.cn, s.latin);
        if (cn) {
          if (fromInat) nInat += 1;
          else nDs += 1;
        } else nMiss += 1;
        return { ...s, cn: cn || '', cnFrom: cn ? (fromInat ? 'inat' : 'ds') : '' };
      });

      if (answer) {
        answer = { ...answer, cn: cnMap, cnStats: { inat: nInat, ds: nDs, missing: nMiss } };
      } else {
        answer = { summary: '', cn: cnMap, extra: [], cnStats: { inat: nInat, ds: nDs, missing: nMiss } };
      }

      return sendJson(res, 200, {
        ok: true,
        question,
        kingdom,
        regionName: data.scope,
        regionNote: data.note,
        genus: data.genus,
        family: data.family,
        usageKey: data.usageKey,
        globalTotal: data.globalTotal,
        records: data.records,
        species,
        level: data.level,
        answer,
        warning,
        cnLookup: { tried: inat.tried || 0, stopped: Boolean(inat.stopped) },
        deepseek: pub,
      });
    }

    if (pathname === '/api/identify' && req.method === 'POST') {
      return await handleIdentify(req, res);
    }

    // 从别的程序（物种标注工坊）跳过来时，页面用这个接口取回本机原图
    if (pathname === '/api/localfile' && req.method === 'GET') {
      return serveLocalFile(res, url.searchParams.get('path'));
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: '未知接口' });
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message || '服务器内部错误' });
    else res.end();
  }
});

/** 回给浏览器的配置：密码、令牌一律不出现，只告知是否已保存 */
function sanitizeConfig() {
  const out = {};
  for (const [k, v] of Object.entries(config.sites)) {
    const c = { ...v };
    if (c.password) {
      delete c.password;
      c.hasPassword = true;
    }
    if (c.token) {
      delete c.token;
      c.hasToken = true;
    }
    // 密钥型站点：凡是被标成 secret 的字段都不回给浏览器，只告诉前端有没有填
    for (const f of SITE_META[k]?.fields || []) {
      if (!f.secret || !c[f.key]) continue;
      delete c[f.key];
      c['has' + f.key[0].toUpperCase() + f.key.slice(1)] = true;
    }
    // 兼容早期只有 apiKey 的配置
    if (c.apiKey) {
      delete c.apiKey;
      c.hasApiKey = true;
    }
    if (c.tokenAt) {
      c.tokenSavedAt = new Date(c.tokenAt).toLocaleString('zh-CN', { hour12: false });
      delete c.tokenAt;
    }
    delete c.albumId;
    out[k] = c;
  }
  return out;
}

/** DeepSeek 的对外状态：只说填没填，永远不回传 key 本身 */
function deepseekPublic() {
  const d = config.deepseek || {};
  return { hasApiKey: Boolean(String(d.apiKey || '').trim()), model: d.model || 'deepseek-chat' };
}

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  const fromArg = i > -1 ? Number(process.argv[i + 1]) : 0;
  return fromArg || Number(process.env.PORT) || APP_PORT;
})();
function openBrowser(url) {
  if (process.env.BIOID_NO_BROWSER === '1') return;
  try {
    const opts = { detached: true, stdio: 'ignore', windowsHide: true };
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], opts).unref();
    else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
    else spawn('xdg-open', [url], opts).unref();
  } catch {
    /* 打不开就算了，手动访问即可 */
  }
}

const HOME = `http://127.0.0.1:${PORT}`;

// 更新后新进程启动时，老进程可能还没完全退出、端口仍被占着。
// 这时不能像"重复双击"那样直接退出，要等一会儿重试。
let bindRetries = 0;
const IS_UPDATED = process.env.BIOID_UPDATED === '1';

/**
 * 谁占着这个端口？
 *
 * 认两种就够了：同一个程序（重复双击 / 更新后新旧进程交叠）、
 * 以及另一个程序（聚合台 ↔ 标注工坊）。两个软件的探活接口不一样，都试一遍；
 * 老版本没有 app.id，退回靠返回体的结构认。
 */
async function identifyOccupant(port) {
  const probes = [
    { path: '/api/status', fallback: { id: 'bio-id-hub', name: '物种鉴定聚合台' } },
    { path: '/api/state', fallback: { id: 'tagden', name: '物种标注工坊' } },
  ];
  for (const p of probes) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${p.path}`, { signal: AbortSignal.timeout(700) });
      if (!r.ok) continue;
      const j = await r.json();
      const app = (j && j.app) || {};
      if (app.id) return { id: app.id, name: app.name || p.fallback.name, version: app.version || '' };
      if (j && Array.isArray(j.presets) && j.hub) return { id: 'tagden', name: '物种标注工坊', version: j.version || '' };
      if (j && j.deepseek && j.config) return { id: 'bio-id-hub', name: '物种鉴定聚合台', version: app.version || '' };
    } catch {
      /* 换下一个接口 */
    }
  }
  return null;
}

server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    if (IS_UPDATED && bindRetries < 40) {
      bindRetries += 1;
      setTimeout(() => server.listen(PORT, '127.0.0.1'), 250);
      return;
    }

    const who = await identifyOccupant(PORT);
    console.log('');
    if (who && who.id === 'bio-id-hub') {
      // 已经开着一个自己：直接把浏览器叫起来，不再起第二个
      console.log(`  端口 ${PORT} 上已经开着一个聚合台${who.version ? `（v${who.version}）` : ''}，直接打开浏览器。`);
      openBrowser(HOME);
      setTimeout(() => process.exit(0), 600);
      return;
    }
    if (who) {
      console.log(`  ⚠ 端口 ${PORT} 被「${who.name}」占着 —— 两个软件不能用同一个端口。`);
      console.log('    请先关掉那个软件的窗口，再重新双击本程序。');
    } else {
      console.log(`  ⚠ 端口 ${PORT} 被别的程序占用了（不是本程序）。`);
      console.log('    关掉占用的程序再启动，或用  --port 8899  换个端口。');
    }
    console.log('');
    setTimeout(() => process.exit(1), 1500);
    return;
  }
  console.error('[启动失败]', err);
  setTimeout(() => process.exit(1), 200);
  process.exitCode = 1;
});

let started = false;
server.on('listening', () => {
  if (started) return;
  started = true;

  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log('  │  物种鉴定聚合台  已启动                  │');
  console.log('  └──────────────────────────────────────────┘');
  console.log(`  浏览器地址： ${HOME}`);
  console.log(`  配置目录：   ${DATA_DIR}`);
  if (DATA_NOTE) console.log(`               （${DATA_NOTE}）`);
  console.log(`  版本：       v${APP_VERSION}`);
  if (isSea) console.log('  运行模式：   单文件 exe');
  else if (isAppBundle) console.log('  运行模式：   macOS 目录版');
  console.log('  关闭这个窗口即停止服务。');
  console.log('');

  openBrowser(HOME);

  // 启动时静默尝试登录需要账号的两个站点
  (async () => {
    for (const key of ['inaturalist', 'duoshi']) {
      try {
        await sites.login(key);
        console.log(`  [ok] ${SITE_META[key].name} 已登录`);
      } catch (err) {
        console.log(`  [!!] ${SITE_META[key].name} 登录失败：${err.message}`);
      }
    }
    // 自然在线：有令牌就静默探一下（没登录过就跳过）
    try {
      if (config.sites?.xingse?.token) await sites.checkXingse();
    } catch {
      /* 校验失败不影响其它站点 */
    }
    // 豆包：填了密钥才探一次（一个 token 的 ping），没填就跳过
    if (config.sites?.doubao?.apiKey) {
      try {
        await sites.checkDoubao();
        console.log(`  [ok] ${SITE_META.doubao.name} 已连接`);
      } catch (err) {
        console.log(`  [!!] ${SITE_META.doubao.name} ${err.message}`);
      }
    }
    // 快瞳：有密钥就换一次令牌，顺便确认国内/全球哪个接口能用
    if (config.sites?.kuaitong?.accessKey && config.sites?.kuaitong?.accessSecret) {
      try {
        await sites.checkKuaitong();
        console.log(`  [ok] ${SITE_META.kuaitong.name} ${sites.state.kuaitong.message}`);
      } catch (err) {
        console.log(`  [!!] ${SITE_META.kuaitong.name} ${err.message}`);
      }
    }
    // 懂鸟：有 api_key 就查一次剩余次数（不消耗配额），顺便验证 key 是否有效
    if (config.sites?.dongniao?.apiKey) {
      try {
        await sites.checkDongniao();
        console.log(`  [ok] ${SITE_META.dongniao.name} ${sites.state.dongniao.message}`);
      } catch (err) {
        console.log(`  [!!] ${SITE_META.dongniao.name} ${err.message}`);
      }
    }
    // eBird：有 key 就探一次（一次轻请求），顺便把「本地最近记录」印在启动日志里
    if (config.sites?.ebird?.apiKey) {
      try {
        await sites.checkEbird();
        console.log(`  [ok] ${SITE_META.ebird.name} ${sites.state.ebird.message}`);
      } catch (err) {
        console.log(`  [!!] ${SITE_META.ebird.name} ${err.message}`);
      }
    }
    // 百度：两组 AK/SK 各换一次 token（只换 token 不识别，不烧额度）
    for (const k of ['baidu-animal', 'baidu-plant']) {
      const c = config.sites?.[k] || {};
      if (!c.apiKey || !c.secretKey) continue;
      try {
        await sites.checkBaidu(k);
        console.log(`  [ok] ${SITE_META[k].name} ${sites.state[k].message}`);
      } catch (err) {
        console.log(`  [!!] ${SITE_META[k].name} ${err.message}`);
      }
    }
    persistSessions();
  })();
});

server.listen(PORT, '127.0.0.1');
