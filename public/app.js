'use strict';

/**
 * 默认勾选：类群互斥，所以只能有一个「专类群」——这里选「多类群」（多识·动物，
 * 昆虫和脊椎动物都能认）。
 * 「多类群」里的 iNaturalist、「不常用类群」里的豆包/百度默认都不勾，需要时自己点；
 * 想认植物/鸟/两爬就选对应类群，会自动切过去并关掉多类群。
 */
const DEFAULT_SELECTED = ['duoshi'];

/**
 * 「按次计费」的模型：默认灰着，**用户点一下才亮**；类群一换就自动收回，要再用得再点一次。
 *   目前只有豆包 —— 走火山方舟 API Key，识别一张约 1 分钱，而且比别的站慢，
 *   混在常开模型里容易在切类群时被悄悄带走，白花钱。
 * 例外：物种标注工坊带 ?sites= 过来时，清单里有它就算「刚在那边点过」，照开。
 */
const ONE_SHOT_SITES = ['doubao'];

/** 收回所有「点一次只算一轮」的模型，返回被收回去的 key（没开就返回空数组） */
function dropOneShotSites() {
  const had = ONE_SHOT_SITES.filter((k) => state.selected.has(k));
  had.forEach((k) => state.selected.delete(k));
  return had;
}

/**
 * 「常备模型」：打开某个类群时顺手带上的兜底站点。
 *   duoshi      —— 多识·动物，站方把昆虫也并在这组里，所以**点「昆虫」时默认点亮**；
 *                  别的类群不带（植物跟它互斥，鸟类/两爬自己有多识的专用模型，菌物/贝类它认不准）
 * 用户手动关掉之后记进 localStorage（bioAutoOff），以后点类群不再自动加回来；
 * 手动重新打开就清掉这个标记。这样「默认开着」和「用户可以自己关」不打架。
 * 注：iNaturalist 现在归「不常用类群」，不再自动带（需要时自己点），所以不在 AUTO_KEEP 里。
 */
const AUTO_KEEP = [
  { key: 'duoshi', when: (g) => g === 'insect' },
];
const AUTO_OFF_KEY = 'bioAutoOff';

/**
 * 点击物种名时的复制方式：
 *   off   — 不可点，方便自由选字
 *   split — 点拉丁名复制拉丁，点中文名复制中文
 *   both  — 点哪个都复制「中文 拉丁」
 */
const COPY_MODES = [
  { key: 'off', label: '不复制', tip: '物种名不可点击，方便自由选字复制' },
  { key: 'split', label: '分别复制', tip: '点拉丁名复制学名，点中文名复制中文名' },
  { key: 'both', label: '中文+拉丁', tip: '点哪一处都复制「中文名 学名」整段' },
];
const COPY_KEY = 'bioCopyMode';
let copyMode = localStorage.getItem(COPY_KEY) || 'split';
if (!COPY_MODES.some((m) => m.key === copyMode)) copyMode = 'split';

/**
 * 账号设置里「用户名」一栏一律显示成这个。
 * 只是显示：真正拿去登录的还是配置里保存的那个账号（见 saveConfig 的映射），
 * 这样界面上不会露出后台的登录 ID，也不影响各站点登录。
 */
// 用户名框默认留空：不显示、也不写死任何人的名字；没改动就沿用已保存的值
const DISPLAY_USERNAME = '';

const state = {
  items: [],
  currentId: null,
  running: false,
  sitesMeta: [],
  selected: new Set(DEFAULT_SELECTED),
  autoOff: new Set(), // 用户手动关掉的「常备模型」，以后不再自动带上
  config: {}, // /api/status 里的站点配置（eBird 地区从这里读）
  app: null,
  trash: [], // 刚删掉的图片，留着给「撤销」用（最多 5 张）
  ebird: {}, // 图片 id → eBird 核对结果（{ loading } / { ok, regionLabel, items }）
  inatTaxa: {}, // 属名（小写）→ iNat taxon_id，学名旁的「iNat」链接用它
  deepseek: { hasApiKey: false, model: 'deepseek-chat' }, // 只有「填没填」，不含 key
};

function siteMeta(key) {
  return state.sitesMeta.find((s) => s.key === key) || null;
}
function siteLabel(key) {
  const m = siteMeta(key);
  return (m && (m.short || m.name)) || key;
}
function siteHome(key) {
  const m = siteMeta(key);
  return (m && m.home) || '#';
}
function allKeys() {
  return state.sitesMeta.map((s) => s.key);
}
function selectedOrder() {
  return allKeys().filter((k) => state.selected.has(k));
}
function persistSelection() {
  localStorage.setItem('bioSelectedSites', JSON.stringify(selectedOrder()));
}

/** 读「哪些常备模型被用户关掉了」 */
function loadAutoOff() {
  try {
    const a = JSON.parse(localStorage.getItem(AUTO_OFF_KEY) || '[]');
    return new Set(Array.isArray(a) ? a.filter((k) => AUTO_KEEP.some((x) => x.key === k)) : []);
  } catch {
    return new Set();
  }
}

function isAutoKey(k) {
  return AUTO_KEEP.some((x) => x.key === k);
}

/** 记下用户对常备模型的取舍：关掉 → 以后不再自动带；重新打开 → 恢复自动带 */
function setAutoOff(k, off) {
  if (!isAutoKey(k)) return;
  if (off) state.autoOff.add(k);
  else state.autoOff.delete(k);
  localStorage.setItem(AUTO_OFF_KEY, JSON.stringify([...state.autoOff]));
}

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = null;
/**
 * 顶部提示。opts.action = { label, onClick } 时右侧多一个按钮（用于「撤销」）。
 */
function toast(msg, opts = {}) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('has-act', !!opts.action);
  if (opts.action) {
    const b = document.createElement('button');
    b.className = 'toast-act';
    b.textContent = opts.action.label;
    b.addEventListener('click', () => {
      el.classList.remove('show');
      clearTimeout(toastTimer);
      opts.action.onClick();
    });
    el.appendChild(b);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), opts.ms || 2200);
}

/* ---------------- 点击复制 ---------------- */

function renderCopyMode() {
  const cur = COPY_MODES.find((m) => m.key === copyMode) || COPY_MODES[1];
  $('copy-mode').innerHTML = COPY_MODES.map(
    (m) => `<button class="seg-btn ${m.key === copyMode ? 'on' : ''}" data-mode="${m.key}"
      title="${esc(m.tip)}" aria-pressed="${m.key === copyMode}">${esc(m.label)}</button>`,
  ).join('');
  $('copy-mode')
    .querySelectorAll('[data-mode]')
    .forEach((el) => el.addEventListener('click', () => setCopyMode(el.dataset.mode)));
  $('copy-tip').textContent = cur.tip;
}

function setCopyMode(key) {
  if (!COPY_MODES.some((m) => m.key === key)) return;
  copyMode = key;
  localStorage.setItem(COPY_KEY, key);
  renderCopyMode();
  renderStage(); // 已有结果立刻按新的方式重绘
}

/**
 * 物种名的两段 HTML：拉丁名 + 中文名（部分站点只给学名，此时中文为空）。
 * 返回 { lat, cn } 两段字符串，直接插进模板。
 */
/** 分数显示：小于 0.1 的别显示成 0（百度这类 softmax 尾巴本来就是极小的值） */
function fmtScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n > 0 && n < 0.1 ? '<0.1' : n.toFixed(1);
}

function nameCell(latin, cn) {
  const text = String(latin || '').trim();
  const ctext = String(cn || '').trim();
  const combined = ctext ? `${ctext} ${text}` : text;

  const mk = (cls, shown, value, kind) => {
    if (copyMode === 'off' || !shown) return `<span class="${cls}">${esc(shown)}</span>`;
    return (
      `<span class="${cls} copyable" data-copy="${esc(value)}"` +
      ` title="点击复制${kind}：${esc(value)}">${esc(shown)}</span>`
    );
  };

  if (copyMode === 'both') {
    // 点哪一段都复制「中文 拉丁」，省得拼两次
    return {
      lat: mk('lat', text, combined, '「中文 学名」'),
      cn: mk('cn', ctext, combined, '「中文 学名」'),
    };
  }
  return { lat: mk('lat', text, text, '学名'), cn: mk('cn', ctext, ctext, '中文名') };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制：${text}`);
  } catch {
    toast('复制失败，可手动选中复制');
  }
}

/* ---------------- 站点状态 ---------------- */

function applySiteStates(list) {
  if (Array.isArray(list) && list.length) state.sitesMeta = list;
  renderPicker();
  renderFriends();
}

async function loadStatus() {
  const r = await fetch('/api/status');
  const j = await r.json();
  state.sitesMeta = j.sites || [];
  state.app = j.app || {};
  state.config = j.config || {};
  // DeepSeek 只回「填没填」，key 本身永远不出服务端
  state.deepseek = j.deepseek || { hasApiKey: false, model: 'deepseek-chat' };
  renderVersion();

  // 站点选择：优先用上次记住的，失效的 key 剔除；一个没剩就回到默认
  const valid = new Set(state.sitesMeta.map((s) => s.key));
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem('bioSelectedSites') || 'null') || [];
  } catch {
    saved = [];
  }
  const picked = saved.filter((k) => valid.has(k));
  // 旧版本可能把同一网站的多个模型都存进来了，这里按「一站一个」重新归一
  const base = picked.length ? picked : DEFAULT_SELECTED.filter((k) => valid.has(k));
  state.autoOff = loadAutoOff();
  state.selected = new Set(pickPerVendor(base, new Set()));
  // 豆包不跟着上次的记忆复活：每次打开都是灰的，要用户自己点（?sites= 里明确带了它除外，
  // 那条路在 ingestLocalImage 里 applySitesParam 会整份覆盖）
  if (dropOneShotSites().length) {
    // 万一上次只开着豆包，收回后别让「一个站点都没开」这种状态落到界面上
    if (!state.selected.size) {
      const fallback = DEFAULT_SELECTED.find((k) => valid.has(k)) || [...valid][0];
      if (fallback) selectSite(fallback);
    }
    persistSelection();
  }

  // 类群互斥：老缓存里可能同时开着植物 + 昆虫 + 鸟类，互相冲突的只保留选中最多的那个
  // 类群；多类群和不常用类群不参与（跟多数类群都能共存），不会被清掉
  const beforeNorm = state.selected.size;
  normalizeTaxonGroup();
  if (state.selected.size !== beforeNorm) persistSelection();

  renderPicker();
  renderFriends();

  // /api/status 的 config 就是「站点 → 配置」的映射
  renderConfig(j.config || {});
  renderInatBar();
  healPpbcRegion().catch(() => {});
  // 站点清单变了（登录状态、类群切换）就重画学名旁的「自然在线」小标
  refreshNatureChips();
}

/* ---------------- 站点选择 ---------------- */

/**
 * 站点选择排成一行一类群：左边是类群名，右边跟着这一类群的识别模型，整体横向自动换行。
 * 点类群名 = 整组开关；group / vendor 都由后端 SITE_META 给（app.js 只负责排序与文案），
 * 不归到任何专类群的归到「不常用类群」（iNaturalist、豆包、百度动/植物），默认灰、需要时自己点。
 */
const TAXON_GROUPS = [
  { key: 'plant', label: '植物' },
  { key: 'insect', label: '昆虫' },
  { key: 'bird', label: '鸟类' },
  { key: 'mammal', label: '兽类' },
  { key: 'herp', label: '两爬' },
  { key: 'fungi', label: '菌物' },
  { key: 'mollusk', label: '贝类' },
  { key: 'animal', label: '多类群' },
  { key: 'general', label: '不常用类群' },
];
const GROUP_ORDER = TAXON_GROUPS.map((g) => g.key);
/**
 * 「识别对象」下拉里的排列（跟下面按类群名的排列不必一致）：
 * 第一项是「自动（混合）」，其余按常用程度从高到低。只列真有模型可用的。
 * 「多类群」不放进来：它是半自由兜底组，只在下面那排点它；不点名类群、
 * 只带着它的时候下拉落到「自动（混合）」，跟标注工坊那个下拉的第一项一致。
 */
const GROUP_AUTO = 'auto';
const GROUP_SELECT_ORDER = ['insect', 'plant', 'bird', 'mammal', 'herp', 'fungi', 'mollusk'];

function groupOf(key) {
  const g = (siteMeta(key) || {}).group;
  return GROUP_ORDER.includes(g) ? g : 'general';
}
function groupLabel(key) {
  return (TAXON_GROUPS.find((g) => g.key === key) || {}).label || key;
}
function inGroup(group) {
  return allKeys().filter((k) => groupOf(k) === group);
}

/* ---------------- 同一个网站内模型互斥 ---------------- */

/** 网站名（只用于提示文案）；没标的站点自成一家，永不互斥 */
const VENDOR_LABEL = { duoshi: '多识', dongniao: '懂鸟', quarryman: '晓虫', butterflyai: '文浩', baidu: '百度' };

function vendorOf(k) {
  return (siteMeta(k) || {}).vendor || '';
}
function vendorName(k) {
  return VENDOR_LABEL[vendorOf(k)] || '这个网站';
}
/** 同一网站里已经开着的另一个模型（没有就返回空串） */
function otherVendorPick(k) {
  const v = vendorOf(k);
  if (!v) return '';
  return allKeys().find((x) => x !== k && vendorOf(x) === v && state.selected.has(x)) || '';
}
/** 选中 k，并把同站其它模型取消掉；返回被顶掉的那些 key */
function selectSite(k) {
  const v = vendorOf(k);
  const dropped = v ? allKeys().filter((x) => x !== k && vendorOf(x) === v && state.selected.has(x)) : [];
  dropped.forEach((x) => state.selected.delete(x));
  state.selected.add(k);
  return dropped;
}
/** 一组里同一网站只留一个，优先留已经选中的那个 */
function pickPerVendor(keys, prefer = state.selected) {
  const kept = new Map(); // vendor → 代表这个网站的 key
  const out = [];
  for (const k of keys) {
    const v = vendorOf(k);
    if (!v) {
      out.push(k);
      continue;
    }
    if (!kept.has(v)) {
      kept.set(v, k);
      out.push(k);
    } else if (prefer.has(k) && !prefer.has(kept.get(v))) {
      out[out.indexOf(kept.get(v))] = k;
      kept.set(v, k);
    }
  }
  return out;
}
function groupPicks(group) {
  return pickPerVendor(inGroup(group));
}

/* ---------------- 类群互斥（「不常用类群」除外） ---------------- */

/**
 * 一次只识别一个类群：选了「植物」就不能同时开着「鸟类」的模型。
 * 两个例外：
 *   · 「不常用类群」（豆包、百度动/植物）—— 不认类群，永远可以开、可以独立勾选；
 *   · 「多类群」（多识·动物、iNaturalist、百度·动物）—— 什么都能认，跟昆虫 / 鸟类 / 兽类 /
 *     两爬 / 菌物 / 贝类共存都合理，所以不参与互斥；**只有跟「植物」互斥**
 *     （拿植物图去问动物模型基本只会给出错答案，反过来也一样）。
 */
const FREE_GROUP = 'general';
const SEMI_FREE_GROUP = 'animal'; // 半自由：只跟植物互斥

/** a、b 两个类群能不能同时开着 */
function groupConflict(a, b) {
  if (!a || !b || a === b) return false;
  if (a === FREE_GROUP || b === FREE_GROUP) return false;
  // 多类群：跟谁都能共存，唯独跟植物互斥
  if (a === SEMI_FREE_GROUP || b === SEMI_FREE_GROUP) return a === 'plant' || b === 'plant';
  return true;
}

/**
 * 「多类群」里能跟植物一起用的模型（iNaturalist 动植物都认）。
 * 类群级互斥会把整个「多类群」挡在植物外面，这两个是例外——按站点逐个放行。
 */
const PLANT_SAFE = new Set(['inaturalist']);
function plantSafe(k) {
  return PLANT_SAFE.has(k) && groupOf(k) === SEMI_FREE_GROUP;
}

/**
 * a、b 两个**站点**能不能同时开着 —— 比 groupConflict 细一层：
 * 类群冲突时还要看是不是 iNaturalist 这种两边都认的模型。
 */
function sitesConflict(a, b) {
  if (a === b) return false;
  if (!groupConflict(groupOf(a), groupOf(b))) return false;
  return !(plantSafe(a) || plantSafe(b));
}


/** 当前有选中模型的「专类群」（不常用类群不算；可能同时有多类群 + 一个专类群） */
function activeTaxonGroups() {
  return GROUP_ORDER.filter((g) => g !== FREE_GROUP && inGroup(g).some((k) => state.selected.has(k)));
}
/** 当前主类群：优先报跟别人冲突的那个（植物压过多类群），否则报第一个 */
function activeGroup() {
  const act = activeTaxonGroups();
  return act.find((g) => act.some((h) => groupConflict(g, h))) || act[0] || '';
}
/**
 * 这个站点现在被哪个类群挡着（能点/已选就返回空串）。
 * 跟 groupConflict 不同：按站点算，iNaturalist 在植物模式下照旧能点。
 */
function blockedSiteOf(k) {
  if (state.selected.has(k)) return '';
  for (const s of state.selected) {
    if (groupOf(s) === groupOf(k)) continue;
    if (sitesConflict(k, s)) return groupOf(s);
  }
  return '';
}

/** 这个类群被哪个类群挡着：整组一个能点的都没有才算（没被挡就返回空串） */
function blockedGroupOf(g) {
  if (!g || g === FREE_GROUP) return '';
  const keys = inGroup(g);
  if (!keys.length) return '';
  if (keys.some((k) => !blockedSiteOf(k))) return '';
  return activeTaxonGroups().find((h) => groupConflict(g, h)) || '';
}

/**
 * 切到类群 g：把跟 g 冲突的类群里已选的模型关掉，返回被关掉的 key。
 * incoming 是这次要开的站点（点单个 = [k]，整组 = 这一组的代表集）。
 * 有 incoming 时按站点判断：只要新开的里头有一个能跟它共存（植物 + iNaturalist），就留着。
 */
function switchTaxonGroup(g, incoming = []) {
  if (!g || g === FREE_GROUP) return [];
  const before = activeTaxonGroups();
  const dropped = [];
  for (const other of before) {
    if (!groupConflict(g, other)) continue;
    for (const k of inGroup(other)) {
      if (!state.selected.has(k)) continue;
      if (incoming.length && incoming.some((x) => !sitesConflict(k, x))) continue;
      state.selected.delete(k);
      dropped.push(k);
    }
  }
  // **真的换类群**（g 原来不在选中里）等于开始新的一轮：豆包这类按次计费的一律收回，
  // 要再用得重新点。同类群内再点别的模型不算换类群，不收。
  if (!before.includes(g)) dropped.push(...dropOneShotSites());
  return dropped;
}
/**
 * 启动时归一：旧缓存里可能同时选了好几个互斥类群（v1.0.26 之前就是这样）。
 * 从选中数最多的类群开始保留，跟已保留的类群**按站点**冲突的才清掉 ——
 * 所以「昆虫 + 多类群」「植物 + iNaturalist」这种合规组合会完整保留。返回保留下来的第一个类群。
 */
function normalizeTaxonGroup() {
  const act = activeTaxonGroups();
  if (act.length <= 1) return act[0] || '';
  const ranking = act
    .map((g) => ({ g, n: inGroup(g).filter((k) => state.selected.has(k)).length }))
    .sort((a, b) => b.n - a.n || GROUP_ORDER.indexOf(a.g) - GROUP_ORDER.indexOf(b.g));
  const keptGroups = [];
  for (const { g } of ranking) {
    for (const k of inGroup(g)) {
      if (!state.selected.has(k)) continue;
      const hit = keptGroups.some((h) => inGroup(h).some((s) => state.selected.has(s) && sitesConflict(k, s)));
      if (hit) state.selected.delete(k);
    }
    if (inGroup(g).some((k) => state.selected.has(k))) keptGroups.push(g);
  }
  return keptGroups[0] || '';
}

/**
 * 打开某个类群时，把「常备模型」补上（目前只有多识·动物，属于「多类群」组）。
 * 返回 { added, dropped }：added 是这次补上的，dropped 是被同站互斥顶掉的。
 * 这一类群自己有同网站的专用模型（点鸟类 → 多识·鸟类）时，就用专用的，不塞兜底模型。
 */
function ensureAutoKeep(group) {
  const picks = groupPicks(group);
  const added = [];
  const dropped = [];
  for (const a of AUTO_KEEP) {
    if (state.autoOff.has(a.key)) continue;
    if (!a.when(group)) continue;
    if (!allKeys().includes(a.key)) continue;
    if (state.selected.has(a.key)) continue;
    const v = vendorOf(a.key);
    if (v && picks.some((k) => vendorOf(k) === v && state.selected.has(k))) continue;
    dropped.push(...selectSite(a.key));
    added.push(a.key);
  }
  return { added, dropped };
}

function pickButton(k) {
  const on = state.selected.has(k);
  const m = siteMeta(k) || {};
  const st = m.state || {};
  const dot = st.ok ? 'ok' : st.message && st.message !== '未连接' ? 'bad' : '';
  const stateText = st.ok ? '已就绪' : st.message === '未连接' ? '未登录' : st.message || '';
  const gBlock = on ? '' : blockedSiteOf(k); // 被别的类群挡着（按站点算，iNaturalist 植物下不挡）
  const other = on || gBlock ? '' : otherVendorPick(k);
  const cls = on ? 'on' : gBlock || other ? 'blocked' : '';
  let tip;
  if (on) {
    tip = `${m.name || k}｜已选｜${stateText}${m.note ? '｜' + m.note : ''}`;
  } else if (gBlock) {
    tip = `${m.name || k}｜「${groupLabel(groupOf(k))}」跟「${groupLabel(gBlock)}」不能同时用｜点它会切到「${groupLabel(groupOf(k))}」，并关掉「${groupLabel(gBlock)}」的模型（iNaturalist、「不常用类群」不受影响）`;
  } else if (other) {
    tip = `${m.name || k}｜${vendorName(k)}同一时间只能用其中一个模型｜点它会换成这个，并关掉 ${siteLabel(other)}`;
  } else {
    tip = `${m.name || k}｜未选｜${stateText}${m.note ? '｜' + m.note : ''}`;
  }
  // eBird 的地区是「点它才设置」的，提示里带上当前值，省得去账号设置里翻
  if (k === 'ebird') tip = `${m.name || k}｜地区：${regionLabelOf(ebirdRegion())}｜点一下改地区`;
  return `<button class="pick ${cls}" data-key="${k}" title="${esc(tip)}">
    <i class="pdot ${dot}"></i>${esc(m.short || m.name || k)}</button>`;
}

/** 一类群一行的 HTML：左边类群名（点它整组开关），右边跟这一类群的模型 */
function groupRowHtml(g, keys) {
  // 全开/部分按「每个网站取一个」来算：同站互斥的模型永远不可能同时开，
  // 用原始 keys 算会一直显示成「部分」
  const reps = groupPicks(g);
  const onCount = reps.filter((k) => state.selected.has(k)).length;
  const gBlock = blockedGroupOf(g);
  const cls = [onCount === reps.length && onCount ? 'all-on' : onCount ? 'part' : '', gBlock ? 'blocked' : '']
    .filter(Boolean)
    .join(' ');
  const gtip = gBlock
    ? `${groupLabel(g)}：跟「${groupLabel(gBlock)}」不能同时用，点一下切到这一类群（会关掉「${groupLabel(gBlock)}」的模型）`
    : `${groupLabel(g)}：共 ${reps.length} 个可用模型，已开 ${onCount} 个。点一下整组开关`;
  return `<div class="pick-row${g === FREE_GROUP ? ' rare' : ''}">
    <button class="pick-glabel ${cls}" data-group="${g}" title="${esc(gtip)}">${esc(groupLabel(g))}</button>
    ${keys.map(pickButton).join('')}
  </div>`;
}

/**
 * 下拉当前落在哪个类群上：
 *   ''        = 「自动（混合）」，下面把所有类群的模型全展开
 *   某个类群键 = 只摆「这一类群 + 能跟它同时开着的类群」的整行模型
 * 跟下拉的取值逻辑保持同一套（见 renderGroupSelect），两边不会说岔。
 */
function pickerFocusGroup() {
  const g = activeGroup();
  return GROUP_SELECT_ORDER.includes(g) && inGroup(g).length ? g : '';
}

function renderPicker() {
  const groups = new Map();
  for (const k of allKeys()) {
    const g = groupOf(k);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(k);
  }
  const ordered = [...groups.keys()].sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));

  // 选了某个类群：只留下「它自己 + 能跟它共存的那几组」——
  // 也就是「多类群」和「不常用类群」（植物跟多类群互斥，但 iNaturalist 例外，所以选植物时
  // 多类群这一行还会在、只是别的成员变灰）。
  // 每一组都是**整行、全部模型**摆出来（不只是已选的），用户自己点开点关。
  const focus = pickerFocusGroup();
  const shown = focus
    ? ordered.filter((g) => !groupConflict(g, focus) || inGroup(g).some((k) => !blockedSiteOf(k)))
    : ordered;

  $('site-picker').innerHTML = shown.map((g) => groupRowHtml(g, groups.get(g))).join('');

  bindPicker();
  // 类群变了，结果表里学名旁的「PPBC」小标要跟着显隐（只有植物类群才出现）
  refreshPpbcChips();
  refreshNatureChips();
  // 下拉要跟当前的类群保持一致：不管选择是靠下拉改的还是点下面类群名改的
  renderGroupSelect();
}


/**
 * 顶部「识别对象」下拉：列各个类群 + 第一项「自动（混合）」。
 * 值取「当前主类群」，没有专类群（只开着不常用类群那几个）就落到「自动（混合）」。
 */
function renderGroupSelect() {
  const sel = $('pick-group');
  if (!sel) return;
  const usable = GROUP_SELECT_ORDER.filter((g) => inGroup(g).length);
  const html =
    `<option value="${GROUP_AUTO}">自动（混合）</option>` +
    usable.map((g) => `<option value="${g}">${esc(groupLabel(g))}</option>`).join('');
  if (sel.dataset.opts !== html) {
    sel.innerHTML = html;
    sel.dataset.opts = html;
  }
  const cur = activeGroup();
  sel.value = usable.includes(cur) ? cur : GROUP_AUTO;
  const on = usable.includes(cur) ? groupPicks(cur).filter((k) => state.selected.has(k)).length : 0;
  sel.title = usable.includes(cur)
    ? `现在认的是「${groupLabel(cur)}」（${on} 个模型）。换个类群就等于切过去并打开它的模型`
    : '没指定类群，用的是默认那套模型。选一个类群会自动切过去并打开它的模型';
}

function bindPicker() {
  const box = $('site-picker');
  box.querySelectorAll('.pick').forEach((el) => el.addEventListener('click', () => toggleSite(el.dataset.key)));
  box.querySelectorAll('[data-group]').forEach((el) => el.addEventListener('click', () => toggleGroup(el.dataset.group)));
}

function toggleSite(k) {
  // eBird 带「地区」参数：点它一律先弹地区选择（已选着的时候也一样，方便改）
  if (k === 'ebird') return openRegionDialog();

  const turningOn = !state.selected.has(k);
  if (!turningOn) {
    if (state.selected.size === 1) return toast('至少保留一个站点');
    state.selected.delete(k);
    // 手动关掉常备模型 → 以后点类群不再自动带上（再手动打开就恢复）
    if (isAutoKey(k)) {
      setAutoOff(k, true);
      persistSelection();
      renderPicker();
      return toast(`已关掉 ${siteLabel(k)}，以后点类群不再自动带上`);
    }
    persistSelection();
    renderPicker();
    return;
  }

  // 开之前先切类群：别的专类群正在跑就关掉它（「不常用类群」不参与，点它不动别的类群；
  // iNaturalist 归「多类群」，但植物也认，所以它不会把植物关掉）
  const g = groupOf(k);
  const switched = switchTaxonGroup(g, [k]);
  const dropped = selectSite(k);
  if (isAutoKey(k)) setAutoOff(k, false);
  const auto = ensureAutoKeep(g);
  persistSelection();
  renderPicker();

  const off = [...new Set(switched)].map(siteLabel).join('、');
  const parts = [];
  if (off) parts.push(`已切到「${groupLabel(g)}」，关掉 ${off}`);
  if (dropped.length) parts.push(`${vendorName(k)}同一时间只能开一个模型，已关掉 ${dropped.map(siteLabel).join('、')}`);
  if (auto.added.length) parts.push(`带上 ${auto.added.map(siteLabel).join('、')}`);
  toast(parts.length ? parts.join('，') : `已开 ${siteLabel(k)}`);
}

/**
 * 点类群名 = 整组开关：
 *   本组已经全开 → 全关（至少留一个站点，全关就没图可发了）
 *   否则 → 全开（同一网站只开一个），并切到这个类群（别的专类群会被关掉）。
 */
function toggleGroup(g) {
  const keys = inGroup(g);
  if (!keys.length) return;
  const on = keys.filter((k) => state.selected.has(k));
  // 「整组已经开着」按每个网站取一个的代表集判断：同站互斥，原始 keys 永远凑不齐
  const reps = groupPicks(g);
  // 被别的类群挡着的成员这次不开：植物模式下点「多类群」只会开 iNaturalist
  const blocked = reps.filter((k) => blockedSiteOf(k));
  const openable = reps.filter((k) => !blockedSiteOf(k));

  if (!blocked.length && on.length && reps.every((k) => state.selected.has(k))) {
    if (on.length === state.selected.size) return toast('至少保留一个站点');
    on.forEach((k) => {
      state.selected.delete(k);
      // 整组关掉常备模型（比如「多类群」里的 iNaturalist）也算用户主动关，别再自动加回来
      if (isAutoKey(k)) setAutoOff(k, true);
    });
    persistSelection();
    renderPicker();
    return toast(`已关掉「${groupLabel(g)}」的 ${on.length} 个模型`);
  }

  const switched = switchTaxonGroup(g, openable);
  let dropped = [];
  for (const k of openable) dropped = dropped.concat(selectSite(k));
  const auto = ensureAutoKeep(g);
  persistSelection();
  renderPicker();

  const off = [...new Set([...switched, ...dropped, ...auto.dropped])].map(siteLabel).join('、');
  const parts = [];
  if (switched.length) parts.push(`已切到「${groupLabel(g)}」`);
  parts.push(`已开「${groupLabel(g)}」的 ${openable.filter((k) => state.selected.has(k)).length} 个模型`);
  if (blocked.length) {
    parts.push(`${blocked.map(siteLabel).join('、')}跟「${groupLabel(blockedSiteOf(blocked[0]))}」不能同时用，这次没开`);
  }
  if (auto.added.length) parts.push(`带上 ${auto.added.map(siteLabel).join('、')}（可自行关掉）`);
  if (off) parts.push(`关掉 ${off}`);
  toast(parts.join('，'));

  // 刚把 eBird 带进来但还没设过地区 → 顺手弹一次
  if (state.selected.has('ebird') && !ebirdRegion()) openRegionDialog();
}

/**
 * 外部带来的类群（物种标注工坊跳过来时带 ?group=insect）：
 * 把模型整体切到这一类群，再开始识别。
 * 不这么做的话，这里会沿用上一次留下的模型 —— 上次在看植物、这次是昆虫，
 * 结果就是一整轮全跑错模型。
 * 返回真正切过去的类群键（不认识/没切就返回空串）。
 */
function applyGroupParam(g) {
  if (!g || !GROUP_ORDER.includes(g) || g === FREE_GROUP) return '';
  const reps = groupPicks(g);
  if (!reps.length) return '';
  const act = activeTaxonGroups();
  const already = act.length === 1 && act[0] === g && reps.every((k) => state.selected.has(k));
  if (already) return g;
  switchTaxonGroup(g, reps);
  for (const k of reps) selectSite(k);
  ensureAutoKeep(g);
  persistSelection();
  renderPicker();
  return g;
}

/**
 * 外部带来的明确模型清单（物种标注工坊跳过来时带 ?sites=quarryman,duoshi,inaturalist）：
 * 那边开着哪几个模型，这边就开哪几个，不多不少 —— 两个软件的结论才对得上。
 * 类群参数只用来定「以哪个类群为主」（影响结果表里的类群提示），站点一律以清单为准，
 * 也不自动补 iNaturalist 之类的常备模型，否则「相同模型」就成了一句空话。
 *
 * 清单要先按这里的规则压一遍：同一个网站只能开一个模型、类群之间也有互斥。
 * 返回 { base, on, dropped }：base 是主轴类群，on 是真正开着的，dropped 是被压掉的。
 */
function applySitesParam(raw, groupHint) {
  const want = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((k) => k && allKeys().includes(k));
  if (!want.length) return null;

  // 同网站只留清单里靠前的那个（同站两个模型本来也只真请求一次，留谁结果都一样）
  const perVendor = pickPerVendor(want, new Set());

  // 主轴类群：显式指定且清单里真有这个类群的站就用它，否则拿站最多的专类群
  let base = GROUP_ORDER.includes(groupHint) && groupHint !== FREE_GROUP ? groupHint : '';
  if (!base || !perVendor.some((k) => groupOf(k) === base)) {
    const count = new Map();
    for (const k of perVendor) {
      const g = groupOf(k);
      if (g === FREE_GROUP || g === SEMI_FREE_GROUP) continue;
      count.set(g, (count.get(g) || 0) + 1);
    }
    const ranked = [...count.entries()].sort(
      (a, b) => b[1] - a[1] || GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]),
    );
    base = ranked.length ? ranked[0][0] : base;
  }

  // 跟主轴类群不能共存的（比如清单里同时有昆虫和植物）就丢掉。
  // 按站点算：清单里带 iNaturalist + 植物模型是合法的，不能被类群互斥一刀切。
  const core = perVendor.filter((k) => groupOf(k) === base);
  const kept = perVendor.filter((k) => !core.some((x) => sitesConflict(k, x)));
  if (!kept.length) return null;

  // 直接覆盖，不走 selectSite：那条路会按「一个网站一个模型」再顶掉一遍
  state.selected = new Set(kept);
  persistSelection();
  renderPicker();
  return { base, on: kept, dropped: want.filter((k) => !kept.includes(k)) };
}

/** 全选 / 默认 两个按钮只绑一次（它们不在 renderPicker 重绘的容器里） */
function bindPickerOps() {
  // 这两个按钮都相当于「重新来一遍」，顺手清掉常备模型的手动关闭标记
  const clearAutoOff = () => {
    state.autoOff = new Set();
    localStorage.setItem(AUTO_OFF_KEY, '[]');
  };
  /** 回到内置的默认组合（「默认」按钮和下拉里的「自动（混合）」共用这一套） */
  const applyDefaultSites = () => {
    state.selected = new Set();
    clearAutoOff();
    for (const k of DEFAULT_SELECTED.filter((x) => allKeys().includes(x))) selectSite(k);
    persistSelection();
    renderPicker();
  };

  /**
   * 「识别对象」下拉：主选法。
   *   选某类群 → 切过去 + 整组打开（豆包照旧收回，得自己再点），
   *              选某类群后，下面只摆这一类群（+ 能共存的组）的整行模型
   *   选「自动（混合）」→ 不指定类群，回到默认那套，并把所有类群的所有模型展开
   */
  $('pick-group').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === GROUP_AUTO) {
      applyDefaultSites();
      return toast('已回到「自动（混合）」：不指定类群，用默认那套模型');
    }
    const moved = applyGroupParam(v);
    if (!moved) {
      renderGroupSelect();
      return toast('这一类群暂时没有可用模型');
    }
    const n = groupPicks(v).filter((k) => state.selected.has(k)).length;
    toast(`已切到「${groupLabel(v)}」，开 ${n} 个模型；要微调就点下面那几个`);
  });

  $('pick-all').addEventListener('click', () => {
    // 「全选」= 当前类群全开 + 能共存的类群（多类群、不常用类群）。
    // 同一网站也只留一个，否则自相矛盾（多识的三组不可能同时用）
    const keep = activeGroup() || SEMI_FREE_GROUP;
    const groups = [keep];
    for (const g of [SEMI_FREE_GROUP, FREE_GROUP]) {
      if (!groups.includes(g) && !groupConflict(keep, g)) groups.push(g);
    }
    // 植物模式下「多类群」整组进不来，但 iNaturalist 能跟植物一起用，得算进来 ——
    // 否则「全选」反而会把已经开着的 iNaturalist 关掉。
    const extra = groups.includes(SEMI_FREE_GROUP) ? [] : inGroup(SEMI_FREE_GROUP).filter(plantSafe);
    state.selected = new Set();
    clearAutoOff();
    for (const k of pickPerVendor([...groups.flatMap(inGroup), ...extra]).filter((k) => !ONE_SHOT_SITES.includes(k))) {
      selectSite(k);
    }
    persistSelection();
    renderPicker();
    toast(
      `已开 ${groups.map((g) => `「${groupLabel(g)}」`).join(' + ')} 的全部模型` +
        (extra.length ? ` + ${extra.map(siteLabel).join('、')}` : '') +
        `；${ONE_SHOT_SITES.map(siteLabel).join('、')}需单独点开；换类群用上面的「参与识别」下拉（选「自动（混合）」展开全部模型）`,
    );
  });
  $('pick-default').addEventListener('click', applyDefaultSites);
}

/* ---------------- eBird 地区（点 eBird 时弹） ---------------- */

/** 当前配置里的 eBird 地区码 */
function ebirdRegion() {
  return String((state.config.ebird || {}).region || '').trim();
}

function regionField() {
  return (siteMeta('ebird')?.fields || []).find((f) => f.key === 'region') || {};
}

/** 「福建（CN-35）」；不在常用列表里就原样显示代码 */
function regionLabelOf(code) {
  const c = String(code || '').trim();
  if (!c) return '上海 CN-31（默认）';
  const hit = (regionField().options || []).find((o) => o.code === c);
  return hit ? `${hit.name}（${c}）` : c;
}

function openRegionDialog() {
  const cur = ebirdRegion();
  const list = regionField().options || [];
  const cn = list.filter((o) => /^CN-/.test(o.code) || ['TW', 'HK', 'MO'].includes(o.code));
  const rest = list.filter((o) => !cn.includes(o));
  const opt = (o) =>
    `<option value="${esc(o.code)}"${o.code === cur ? ' selected' : ''}>${esc(o.name)}（${esc(o.code)}）</option>`;
  // 配置里存了一个列表外的代码（比如自己手填的 US-CA）→ 补一条，别让它显示成空白
  const extra = cur && !list.some((o) => o.code === cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : '';
  $('region-pick').innerHTML =
    `<option value="">— 选择地区 —</option>${extra}` +
    `<optgroup label="中国（含港澳台）">${cn.map(opt).join('')}</optgroup>` +
    `<optgroup label="其他国家 / 地区">${rest.map(opt).join('')}</optgroup>`;
  $('region-pick').value = cur;
  $('region-code').value = cur;
  $('region-note').textContent = cur
    ? `当前：${regionLabelOf(cur)}。改错也不要紧，随时点 eBird 再改。`
    : '还没设过，默认按上海（CN-31）查。选一个会更准。';
  $('region-guess').className = 'region-guess';
  $('region-modal').classList.add('show');
  autoLocateIfAllowed(); // 只有已经授权过定位才自动读，见下面的注释
}

/**
 * 打开弹窗时要不要自动读定位。
 *
 * 这里必须小心：浏览器弹「允许使用你的位置？」的权限气泡会**挡住整个页面**，
 * 用户点「允许 / 拒绝」之前，连弹窗里的「确定」都点不动（表现就是“点了没反应”）。
 * 所以只有**已经授权过**（permissions 是 granted）才自动读；还在问 / 已被拒的，
 * 一律不主动请求，让用户自己点「用我的定位」——权限气泡就由那一下点击引起，
 * 不会卡住别的按钮。
 */
async function autoLocateIfAllowed() {
  const tip = $('region-guess');
  if (!tip) return;
  let state = '';
  try {
    state = (await navigator.permissions.query({ name: 'geolocation' })).state;
  } catch {
    state = '';
  }
  if (state === 'granted') return locateRegion();
  tip.className = 'region-guess';
  tip.textContent =
    state === 'denied'
      ? '浏览器没给定位权限，直接在上面选一个地区就行。'
      : '不确定选哪个？点下面的「用我的定位」按当前位置选，或者在上面直接挑一个。';
}

/** 浏览器定位 → 后端换算成 eBird 地区码 → 预填（用户仍然可以改） */
async function locateRegion() {
  const tip = $('region-guess');
  if (!navigator.geolocation) {
    tip.className = 'region-guess warn';
    tip.textContent = '这个环境不给定位，手动选一个吧。';
    return;
  }
  tip.className = 'region-guess';
  tip.textContent = '正在读取定位…';
  const btn = $('region-locate');
  btn.disabled = true;
  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        timeout: 8000,
        maximumAge: 3600 * 1000,
        enableHighAccuracy: false,
      }),
    );
    const { latitude: lat, longitude: lng } = pos.coords;
    const r = await fetch(`/api/ebird/region?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}`).then((x) => x.json());
    if (r.ok && r.code) {
      const sel = $('region-pick');
      if (![...sel.options].some((o) => o.value === r.code)) {
        const o = document.createElement('option');
        o.value = r.code;
        o.textContent = `${r.name || r.code}（${r.code}）`;
        sel.appendChild(o);
      }
      sel.value = r.code;
      $('region-code').value = r.code;
      tip.className = 'region-guess ok';
      tip.textContent = `定位在 ${r.name || r.code} 附近，已按这个填好。不对就改下面。`;
    } else {
      tip.className = 'region-guess warn';
      tip.textContent = r.error ? `没算出地区（${r.error}），手动选一个吧。` : '附近找不到参考点，手动选一个吧。';
    }
  } catch (err) {
    tip.className = 'region-guess warn';
    tip.textContent =
      err && err.code === 1 ? '你拒绝了定位权限，手动选一个吧。' : '没拿到定位，手动选一个吧。';
  } finally {
    btn.disabled = false;
  }
}

/** 保存地区：落盘 → 让服务端用新地区重探一次 → 已有结果按新地区重查 */
async function saveRegion(code) {
  const c = String(code || '').trim();
  if (!c) return toast('先选一个地区');
  const r = await fetch('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sites: { ebird: { region: c } } }),
  }).then((x) => x.json());
  if (r.config) state.config = r.config;
  // 选中 + 记住；状态栏这时才会变成「已连接（福建 · …）」
  // eBird 属于「鸟类」类群，确定地区等于选了鸟类 → 先把别的专类群关掉
  const switched = switchTaxonGroup(groupOf('ebird'), ['ebird']);
  selectSite('ebird');
  persistSelection();
  $('region-modal').classList.remove('show');
  renderPicker();
  toast(
    switched.length
      ? `已切到「鸟类」（含 eBird 核对），关掉 ${[...new Set(switched)].map(siteLabel).join('、')}`
      : `eBird 地区：${regionLabelOf(c)}`,
  );
  try {
    const login = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site: 'ebird' }),
    }).then((x) => x.json());
    if (login.sites) applySiteStates(login.sites);
  } catch {
    /* 状态没刷新不影响使用 */
  }
  // 表格里已有的 eBird 旁证是按旧地区查的，换地区后重查一次
  const item = currentItem();
  if (item?.resp) {
    delete state.ebird[item.id];
    renderStage();
    runEbird(item);
  }
}

/** 弹窗里主动关掉 eBird（点站点条上那个按钮时走的是「打开设置」，不直接关） */
function turnOffEbird() {
  if (!state.selected.has('ebird')) return $('region-modal').classList.remove('show');
  if (state.selected.size === 1) return toast('至少保留一个站点');
  state.selected.delete('ebird');
  persistSelection();
  renderPicker();
  $('region-modal').classList.remove('show');
  toast('已关掉 eBird 核对（再点一下可以打开）');
}

function bindRegionModal() {
  $('region-pick').addEventListener('change', (e) => {
    if (e.target.value) {
      $('region-code').value = e.target.value;
        }
  });
  $('region-locate').addEventListener('click', locateRegion);
  $('region-ok').addEventListener('click', () => saveRegion($('region-code').value || $('region-pick').value));
  $('region-cancel').addEventListener('click', () => $('region-modal').classList.remove('show'));
  $('region-off').addEventListener('click', turnOffEbird);
  $('region-modal').addEventListener('click', (e) => {
    if (e.target.id === 'region-modal') $('region-modal').classList.remove('show');
  });
  $('region-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRegion($('region-code').value);
    }
  });
}



/* ---------------- 友情链接 ---------------- */

/** 把参与识别的站点按域名归并成友链：同一站的多个分区只占一个位子 */
function renderFriends() {
  const meta = state.sitesMeta;
  const box = $('friends');
  if (!box) return;
  if (!meta.length) {
    box.innerHTML = '';
    return;
  }

  const groups = new Map();
  for (const m of meta) {
    let host = '';
    try {
      host = new URL(m.home).host;
    } catch {
      host = m.home || m.key;
    }
    if (!groups.has(host)) groups.set(host, { host, href: m.home, shorts: [], names: [] });
    const g = groups.get(host);
    g.shorts.push(m.short || m.name || m.key);
    g.names.push(m.name || m.short || m.key);
  }

  const links = [...groups.values()]
    .map((g) => {
      const n = g.shorts.length;
      const label = g.shorts[0];
      const tip = `${g.names.join('；')} · ${g.host}${n > 1 ? `（本站共 ${n} 个分区）` : ''}`;
      return `<a class="flink" href="${esc(g.href)}" target="_blank" rel="noreferrer" title="${esc(
        tip,
      )}">${esc(label)}</a>`;
    })
    .join('');

  const verifyCount = meta.filter((m) => m.verify).length;
  box.innerHTML = `
    <h4>友情链接</h4>
    <div class="flinks">${links}</div>
    <p class="fnote">共 ${meta.length - verifyCount} 个站点可参与识别${
      verifyCount ? `，另有 ${verifyCount} 个记录核对站点` : ''
    }。图片只会发送给上方勾选的站点；同一站点的多个分区已合并成一个链接，点开即是原站。eBird 不收图片，只在识别后核对候选物种在本地区的近期记录。</p>`;
}

/**
 * 标题旁的版本号。
 * 有更新时会被 markVersionOld() 标成橙色，提示「该更新了」。
 */
function renderVersion() {
  const el = $('app-ver');
  if (!el) return;
  const app = state.app || {};
  const v = String(app.version || '').trim();
  if (!v || /dev$/i.test(v)) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = `v${v}`;
  el.classList.toggle('dev', !app.mode || app.mode === 'source');
  const mode = app.mode === 'exe' ? '单文件 exe' : app.mode === 'bundle' ? 'macOS 目录版' : '源码模式';
  el.title = app.updateConfigured
    ? `当前版本 v${v}（${mode}）· 点击检查更新`
    : `当前版本 v${v}（${mode}）· 未配置更新源`;
  el.dataset.version = v;
}

/** 检查到新版时把版本号标橙，点一下就能升 */
function markVersionOld(latest) {
  const el = $('app-ver');
  if (!el) return;
  el.classList.add('old');
  el.title = `当前 v${el.dataset.version || '?'}，已有 v${latest} 可更新 · 点击更新`;
}

/* ---------------- 队列 ---------------- */

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------------- 超大图：先压一份「识别用副本」 ----------------
 * 服务端只收 20MB 以内的原图（base64 还要再涨 37%），所以超过这个数的照片以前直接被拒。
 * 现在改成：在浏览器里缩到长边 3200 起、逐级降到 10MB 以下再上传。
 * 为什么可以放心缩：各家的视觉模型自己也会把图缩到几百像素做推理（多识甚至硬要 640），
 * 2600 长边对物种识别远远够用，还能把上传时间压下来一大截。
 * 原图不动、也不落盘，只看大图时用的是这份副本（20MB 以上的照片本来也存不住整份 base64）。
 */
const SHRINK_OVER = 16 * 1024 * 1024; // 超过 16MB 就压（留出 base64 膨胀的余量）
const SHRINK_TARGET = 10 * 1024 * 1024; // 压到这个以下就收手
const SHRINK_STEPS = [
  [3200, 0.92],
  [2800, 0.9],
  [2400, 0.88],
  [2000, 0.85],
  [1600, 0.82],
  [1200, 0.8],
];

/** dataURL 的真实字节数（base64 是 4 字符 3 字节，末尾可能有 = 补齐） */
function dataUrlBytes(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf(',');
  if (i < 0) return 0;
  const len = s.length - i - 1;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.round((len * 3) / 4) - pad);
}

/**
 * 任意来源（File / Blob / dataURL）→ 长边不超过 maxSide 的 JPEG。
 * 返回 { dataUrl, w, h, scaled, failed }；浏览器解不开（HEIC、TIFF、文件损坏）时 failed=true。
 */
function scaleToJpeg(src, maxSide, quality = 0.9) {
  return new Promise((resolve) => {
    const isUrl = typeof src === 'string';
    const url = isUrl ? src : URL.createObjectURL(src);
    const img = new Image();
    const finish = (v) => {
      if (!isUrl) URL.revokeObjectURL(url);
      resolve(v);
    };
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        finish({ dataUrl: canvas.toDataURL('image/jpeg', quality), w, h, scaled: scale < 1 });
      } catch {
        finish({ dataUrl: '', w: 0, h: 0, failed: true });
      }
    };
    img.onerror = () => finish({ dataUrl: '', w: 0, h: 0, failed: true });
    img.src = url;
  });
}

/**
 * 准备送识别的那一份图：小图原样用，大图压到 10MB 以下。
 * 返回 { dataUrl, shrunk, w, h } 或 { failed: true }。
 */
async function prepareIdentifyImage(file) {
  if (file.size <= SHRINK_OVER) {
    return { dataUrl: await readDataUrl(file), shrunk: false };
  }
  let last = null;
  for (const [side, q] of SHRINK_STEPS) {
    const r = await scaleToJpeg(file, side, q);
    if (r.failed) break;
    last = r;
    if (dataUrlBytes(r.dataUrl) <= SHRINK_TARGET) {
      return { dataUrl: r.dataUrl, shrunk: true, w: r.w, h: r.h };
    }
  }
  // 全都试过了还压不下去（很少见：极端大的 PNG），那就用最后那一档，别把图丢掉
  if (last?.dataUrl && dataUrlBytes(last.dataUrl) <= 19 * 1024 * 1024) {
    return { dataUrl: last.dataUrl, shrunk: true, w: last.w, h: last.h };
  }
  return { failed: true };
}

/**
 * 生成「长边压到 640」的副本。
 * 多识接口硬性要求不超过 640x640，它自己的前端也是这么缩的，这里照做。
 */
function shrinkForDuoshi(file, maxSide = 640, quality = 0.92) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        if (scale === 1) {
          resolve({ dataUrl: '', note: `${img.width}×${img.height}` });
          return;
        }
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', quality), note: `${w}×${h}` });
      } catch {
        resolve({ dataUrl: '', note: '' });
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ dataUrl: '', note: '' });
    };
    img.src = url;
  });
}

/**
 * 把任意图片转成 JPEG（长边不超过 maxSide）。
 * 植物智的接口只认 .jpg，PNG/WebP 原图会被它直接拒收。
 */
function encodeJpeg(file, maxSide = 1600, quality = 0.9) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch {
        resolve('');
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve('');
    };
    img.src = url;
  });
}

const IMG_EXT_RE = /\.(jpe?g|png|webp|bmp|gif|tiff?|heic|heif|avif)$/i;

async function addFiles(files) {
  // 有些系统拖进来的 HEIC 没有 mime，按扩展名也算图片，否则会被静悄悄扔掉
  const list = [...files].filter((f) => (f.type || '').startsWith('image/') || IMG_EXT_RE.test(f.name || ''));
  if (!list.length) return;
  let shrunk = 0;
  let failed = 0;
  for (const file of list) {
    const prep = await prepareIdentifyImage(file);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const name = file.name || `pasted-${Date.now()}.png`;

    if (prep.failed) {
      failed += 1;
      state.items.push({
        id,
        file,
        name,
        dataUrl: '',
        smallDataUrl: '',
        smallNote: '',
        jpegDataUrl: '',
        status: 'error',
        resp: null,
        error: '这张图浏览器解不开（常见于 HEIC / TIFF 或文件损坏），先转成 JPG 再拖进来',
      });
      continue;
    }

    if (prep.shrunk) shrunk += 1;
    // 压缩过的已经是 JPEG，多识 / 植物智的副本直接从它生成，少解码一次原图
    const small = prep.shrunk ? await scaleToJpeg(prep.dataUrl, 640, 0.88) : await shrinkForDuoshi(file);
    const smallDataUrl = small.dataUrl || '';
    // 两边的返回值形状不同：压过的来自 scaleToJpeg（有 w/h），原图走 shrinkForDuoshi（只有 note）
    const smallNote = prep.shrunk
      ? smallDataUrl
        ? `${small.w}×${small.h}`
        : `${prep.w}×${prep.h}`
      : small.note || '';

    // 植物智只认 .jpg：非 JPEG 原图转一份；JPEG 太大（>3MB）也压一下，免得被它拒收
    let jpegDataUrl = '';
    if (!prep.shrunk) {
      if (/jpe?g/i.test(file.type || '')) {
        if (file.size > 3 * 1024 * 1024) jpegDataUrl = await encodeJpeg(file, 2000, 0.9);
      } else {
        jpegDataUrl = await encodeJpeg(file, 1600, 0.9);
      }
    }

    state.items.push({
      id,
      file,
      name,
      dataUrl: prep.dataUrl,
      // 压过的图要按 JPEG 报给站点，扩展名也改掉，否则有的站按后缀挑解析器
      sendName: prep.shrunk ? name.replace(/\.[^.]+$/, '') + '.jpg' : '',
      sendMime: prep.shrunk ? 'image/jpeg' : '',
      smallDataUrl,
      smallNote,
      jpegDataUrl,
      status: 'pending',
      resp: null,
      error: '',
    });
  }
  if (!state.currentId && state.items.length) {
    const first = state.items.find((i) => i.status === 'pending') || state.items[0];
    state.currentId = first.id;
  }
  renderQueue();
  if (shrunk || failed) {
    const bits = [];
    bits.push(shrunk ? `${shrunk} 张超过 16MB 的照片已自动压到识别用尺寸（原图不动）` : '');
    bits.push(failed ? `${failed} 张解不开，已标红` : '');
    toast(bits.filter(Boolean).join('，'), { ms: 4200 });
  }
  pump();
}

/**
 * 把一个本机绝对路径读进来直接开始识别。
 *
 * 两个入口共用：地址栏的 `?img=`（标注工坊第一次跳过来），以及下面 postMessage 那条
 * （那一页已经开着，标注工坊把第二张图直接塞进来）。识别结果按队列往后排，不会顶掉手上的。
 */
async function ingestLocalImage({ path: p, group = '', sites = '' }) {
  // 先把模型定好：识别一启动就用当时选中的模型，晚一步就得白跑一遍。
  // 带 sites 就以清单为准（标注工坊里开着哪几个就开哪几个）；老版本只带 group 时退回按类群切。
  const exact = applySitesParam(sites, group);
  if (exact) {
    const g = exact.base ? `「${groupLabel(exact.base)}」的模型` : '模型';
    const lost = exact.dropped.length ? `，另有 ${exact.dropped.length} 个这边开不了（同站互斥或不支持）` : '';
    toast(`已按标注工坊带过来的 ${exact.on.length} 个${g}识别${lost}`, { ms: 3200 });
  } else {
    const applied = applyGroupParam(group);
    if (applied) toast(`已切到「${groupLabel(applied)}」的模型`, { ms: 2600 });
  }
  const r = await fetch(`/api/localfile?path=${encodeURIComponent(p)}`, { cache: 'no-store' });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${r.status}`);
  }
  const blob = await r.blob();
  const name = decodeURIComponent(r.headers.get('x-filename') || '') || p.split(/[\\/]/).pop() || 'image.jpg';
  await addFiles([new File([blob], name, { type: blob.type || 'image/jpeg' })]);
  return name;
}

/**
 * 地址栏带 ?img=<本机绝对路径> 时，把这个文件读进来直接开始识别。
 * 物种标注工坊那边点了「在聚合台查看这张」，就是走这条路，省得再手动选一次图。
 * 读进来后立刻把参数从地址栏抹掉：刷新页面不该重复入队。
 */
async function openFromUrl() {
  const sp = new URLSearchParams(location.search);
  const p = sp.get('img');
  const wanted = sp.get('group') || '';
  const siteList = sp.get('sites') || '';
  if (!p) return;
  history.replaceState(null, '', location.pathname);
  try {
    await ingestLocalImage({ path: p, group: wanted, sites: siteList });
  } catch (err) {
    toast(`打开这张图失败：${err.message}`, { ms: 4200 });
  }
}

/* ---------------- 别的程序往这一页塞图 ----------------
 * 物种标注工坊第二次点「在聚合台查看这张」时**不再开新标签页**：它拿着已经开着的这一页
 * （window.open 的句柄）postMessage 过来，这边直接入队识别，回一个 ack 让它知道送到了。
 *
 * 只认本机来源：127.0.0.1 / localhost 的任意端口（两个程序的端口都可能被改）。
 * 这不是松：这条路能做的事，和直接访问 `?img=<绝对路径>` 一模一样 —— 都只能读本机图片。
 */
const BRIDGE_IN = 'bioidhub:open-image';
const BRIDGE_ACK = 'bioidhub:ack';
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

function bindImageBridge() {
  window.addEventListener('message', (e) => {
    if (!LOCAL_ORIGIN.test(e.origin || '')) return;
    const d = e.data;
    if (!d || d.type !== BRIDGE_IN || typeof d.path !== 'string') return;
    const reply = (payload) => {
      try {
        if (e.source) e.source.postMessage(payload, e.origin);
      } catch {
        /* 对面已经关了，不用管 */
      }
    };
    ingestLocalImage({ path: d.path, group: String(d.group || ''), sites: String(d.sites || '') })
      .then((name) => reply({ type: BRIDGE_ACK, ok: true, name }))
      .catch((err) => {
        toast(`标注工坊送来这张图没打开：${err.message}`, { ms: 4200 });
        reply({ type: BRIDGE_ACK, ok: false, error: err.message });
      });
  });
}

function renderQueue() {
  $('queue').innerHTML = state.items
    .map((it) => {
      const active = it.id === state.currentId ? 'active' : '';
      const label =
        it.status === 'running'
          ? '识别中…'
          : it.status === 'done'
            ? (it.resp?.aggregate?.best?.cn || it.resp?.aggregate?.best?.latin || '已完成')
            : it.status === 'error'
              ? '失败：' + it.error
              : '待识别';
      const cls = it.status === 'running' ? 'run' : it.status === 'done' ? 'done' : it.status === 'error' ? 'err' : '';
      return `<div class="queue-item ${active}" data-id="${it.id}">
        <img src="${it.dataUrl || ''}" alt="" title="点击看大图（滚轮缩放）">
        <div class="meta">
          <div class="name">${esc(it.name)}</div>
          <div class="state ${cls}">${esc(label)}</div>
        </div>
        <button class="q-del" data-del="${it.id}" title="从列表移除这张图" aria-label="移除">×</button>
      </div>`;
    })
    .join('');
  $('queue')
    .querySelectorAll('.q-del')
    .forEach((el) =>
      el.addEventListener('click', (e) => {
        e.stopPropagation(); // 别顺带把这张切成当前图
        deleteItem(el.dataset.del);
      }),
    );
  $('queue')
    .querySelectorAll('.queue-item')
    .forEach((el) =>
      el.addEventListener('click', () => {
        state.currentId = el.dataset.id;
        renderQueue();
        renderStage();
      }),
    );
  // 点缩略图 = 把这张图放到屏幕中央看大图（这一下同时也会把该图切成当前图）
  $('queue')
    .querySelectorAll('.queue-item img')
    .forEach((el) =>
      el.addEventListener('click', () => {
        const id = el.closest('.queue-item')?.dataset.id;
        const item = state.items.find((i) => i.id === id);
        if (item) openViewer(item);
      }),
    );
}

/* ---------------- 删除图片 ----------------
 * 只从本程序的列表里移除，并把 base64 释放掉；用户电脑上的原文件不动。
 */

function deleteItem(id) {
  const idx = state.items.findIndex((i) => i.id === id);
  if (idx < 0) return;
  if (view.id === id) closeViewer(); // 正在看的就是这张，先把大图收掉
  const [item] = state.items.splice(idx, 1);
  delete state.ebird[id];
  state.trash.push({ item, idx });
  while (state.trash.length > 5) state.trash.shift();

  // 当前这张被删了，就把视野挪到相邻的一张
  if (state.currentId === id) {
    const next = state.items[idx] || state.items[idx - 1] || null;
    state.currentId = next ? next.id : null;
  }
  renderQueue();
  renderStage();
  toast(`已删除「${item.name}」`, {
    ms: 5000,
    action: { label: '撤销', onClick: () => undoDelete(id) },
  });
}

function undoDelete(id) {
  const at = state.trash.findIndex((t) => t.item.id === id);
  if (at < 0) return toast('已经撤销不了了');
  const [{ item, idx }] = state.trash.splice(at, 1);
  state.items.splice(Math.min(idx, state.items.length), 0, item);
  state.currentId = item.id;
  renderQueue();
  renderStage();
  toast(`已恢复「${item.name}」`);
}

/* ---------------- 大图查看 ----------------
 * 点左侧缩略图（或结果区的「看大图」）把这张图摆到屏幕中央；
 * 滚轮以鼠标所在位置为中心缩放，按住拖动平移，双击在「适应窗口 / 原始像素」之间切换。
 */

const VIEW_MIN = 0.02; // 缩放下限（相对原图像素）
const VIEW_MAX = 8; // 放大上限：原图 8 倍，看翅脉够了
const view = { id: null, scale: 1, fit: 1, tx: 0, ty: 0, drag: null, moved: 0 };

function viewOpen() {
  const box = $('viewer');
  return !!box && !box.hidden;
}

/** 让整张图刚好铺进窗口所需的比例（不放大超过原图像素） */
function viewFit() {
  const img = $('v-img');
  const stage = $('v-stage');
  if (!img || !stage) return 1;
  const iw = img.naturalWidth || 0;
  const ih = img.naturalHeight || 0;
  if (!iw || !ih) return 1;
  const sw = Math.max(80, stage.clientWidth - 48); // 四周留点空隙，别贴着边
  const sh = Math.max(80, stage.clientHeight - 48);
  return Math.min(1, sw / iw, sh / ih);
}

function viewApply() {
  const img = $('v-img');
  if (!img) return;
  img.style.transform = `translate(calc(-50% + ${view.tx}px), calc(-50% + ${view.ty}px)) scale(${view.scale})`;
  const z = $('v-zoom');
  if (z) z.textContent = `${Math.round(view.scale * 100)}%`;
}

/** 以 (clientX, clientY) 为不动点缩放；不传坐标则按窗口中心缩 */
function viewZoom(factor, clientX, clientY) {
  const stage = $('v-stage');
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const ax = rect.width / 2;
  const ay = rect.height / 2;
  const ox = (clientX == null ? ax : clientX - rect.left) - ax;
  const oy = (clientY == null ? ay : clientY - rect.top) - ay;
  const min = Math.max(VIEW_MIN, view.fit * 0.4);
  const next = Math.min(VIEW_MAX, Math.max(min, view.scale * factor));
  if (Math.abs(next - view.scale) < 1e-4) return;
  // 让鼠标下的那一点在缩放前后不动
  const k = next / view.scale;
  view.tx = ox - k * (ox - view.tx);
  view.ty = oy - k * (oy - view.ty);
  view.scale = next;
  viewApply();
}

/** fit=true 铺满窗口；fit=false 按原始像素 1:1 */
function viewReset(fit = true) {
  view.fit = viewFit();
  view.scale = fit ? view.fit : 1;
  view.tx = 0;
  view.ty = 0;
  viewApply();
}

function openViewer(item) {
  if (!item) return;
  const box = $('viewer');
  const img = $('v-img');
  if (!box || !img) return;
  view.id = item.id;
  view.tx = 0;
  view.ty = 0;
  view.scale = 1;
  view.fit = 1;
  view.drag = null;
  view.moved = 0;
  $('v-name').textContent = item.name || '';
  const agg = item.resp && item.resp.aggregate;
  $('v-res').textContent = agg && agg.verdict ? agg.verdict : item.status === 'running' ? '还在识别中…' : '';
  img.onload = null;
  img.src = item.dataUrl || '';
  box.hidden = false;
  document.body.classList.add('viewer-on');

  const settle = () => {
    view.fit = viewFit();
    view.scale = view.fit;
    view.tx = 0;
    view.ty = 0;
    viewApply();
  };
  if (img.complete && img.naturalWidth) settle();
  else img.onload = settle;
}

function closeViewer() {
  const box = $('viewer');
  if (!box || box.hidden) return;
  box.hidden = true;
  document.body.classList.remove('viewer-on');
  const img = $('v-img');
  if (img) {
    img.onload = null;
    img.removeAttribute('src'); // 图片是 base64，撤掉引用让浏览器尽早回收
    img.style.transform = '';
  }
  view.id = null;
  view.drag = null;
  view.moved = 0;
  view.scale = 1;
  view.fit = 1;
  view.tx = 0;
  view.ty = 0;
}

(function bindViewer() {
  const stage = $('v-stage');
  if (!stage) return;

  // 滚轮缩放：鼠标滚轮的大 delta 和触控板的小 delta 都用指数换算，手感一致
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      viewZoom(Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY);
    },
    { passive: false },
  );

  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 别拖出半透明选区和图片虚影
    view.drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    view.moved = 0;
    stage.classList.add('grabbing');
  });

  window.addEventListener('mousemove', (e) => {
    if (!view.drag) return;
    const dx = e.clientX - view.drag.x;
    const dy = e.clientY - view.drag.y;
    view.moved = Math.max(view.moved, Math.abs(dx) + Math.abs(dy));
    view.tx = view.drag.tx + dx;
    view.ty = view.drag.ty + dy;
    viewApply();
  });

  window.addEventListener('mouseup', () => {
    if (!view.drag) return;
    view.drag = null;
    stage.classList.remove('grabbing');
  });

  // 点图外的黑底关闭；刚拖过一下的不算，免得拖完图就没了
  stage.addEventListener('click', (e) => {
    if (e.target !== stage) return;
    if (view.moved > 6) {
      view.moved = 0;
      return;
    }
    closeViewer();
  });

  stage.addEventListener('dblclick', (e) => {
    if (e.target !== $('v-img')) return;
    viewReset(view.scale > view.fit * 1.05); // 已经放大了就回到适应，否则按 1:1
  });

  $('v-in').addEventListener('click', () => viewZoom(1.25));
  $('v-out').addEventListener('click', () => viewZoom(1 / 1.25));
  $('v-fit').addEventListener('click', () => viewReset(true));
  $('v-one').addEventListener('click', () => viewReset(false));
  $('v-close').addEventListener('click', closeViewer);

  // 窗口尺寸变了：原本是「适应窗口」的，跟着重新适应
  window.addEventListener('resize', () => {
    if (!viewOpen()) return;
    const atFit = Math.abs(view.scale - view.fit) < 0.02;
    view.fit = viewFit();
    if (atFit) {
      view.scale = view.fit;
      view.tx = 0;
      view.ty = 0;
    }
    viewApply();
  });
})();

async function pump() {
  if (state.running) return;
  const next = state.items.find((i) => i.status === 'pending');
  if (!next) return;
  const chosen = selectedOrder();
  if (!chosen.length) {
    next.status = 'error';
    next.error = '没有勾选任何站点，请先在上方的「参与识别」里选择';
    renderQueue();
    renderStage();
    pump();
    return;
  }
  state.running = true;
  // 多张排队时不要把视野一张张拽过去——停在用户当前看的那张，谁想看谁自己点。
  // 只有「还没有当前图」或「当前图已经被删掉」时才落到这一张。
  if (!state.currentId || !state.items.some((i) => i.id === state.currentId)) state.currentId = next.id;
  next.status = 'running';
  renderQueue();
  renderStage();

  try {
    const base64 = (next.dataUrl || '').split(',')[1] || '';
    const res = await fetch('/api/identify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: next.sendName || next.name,
        mime: next.sendMime || next.file?.type || 'image/jpeg',
        data: base64,
        dataSmall: (next.smallDataUrl || '').split(',')[1] || '',
        dataJpeg: (next.jpegDataUrl || '').split(',')[1] || '',
        sites: chosen,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    next.resp = json;
    next.status = 'done';
    if (json.siteStates) applySiteStates(json.siteStates);
    // 识别完再拿候选学名去问 eBird（不挡住下一张，后台跑）
    delete state.ebird[next.id];
    if (ebirdOn()) runEbird(next);
  } catch (err) {
    next.status = 'error';
    next.error = err.message;
  } finally {
    state.running = false;
    renderQueue();
    renderStage();
    pump();
  }
}

/* ---------------- eBird 地区记录核对 ----------------
 * eBird 没有图片识别接口，它做的是另一件事：识别完之后，拿候选学名去查
 * 「这个物种在本地区最近 14 天有没有人记录过」。对观鸟来说这条旁证很有用 ——
 * 一个本地零记录、又不在分布区/迁徙季的候选，多半是识别错了。
 */

/** 学名归一：只留属名 + 种加词，忽略大小写、命名人和杂交符号 */
function sciKey(latin) {
  const parts = String(latin || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .trim()
    .split(/\s+/);
  return parts.slice(0, 2).join(' ');
}

function ebirdOn() {
  return selectedOrder().includes('ebird');
}

async function runEbird(item) {
  if (!item?.resp?.aggregate || !ebirdOn()) return;
  const names = item.resp.aggregate.rows
    .slice(0, 6)
    .map((r) => r.latin)
    .filter(Boolean);
  if (!names.length) return;
  state.ebird[item.id] = { loading: true };
  if (state.currentId === item.id) renderStage();
  try {
    const res = await fetch('/api/ebird/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sciNames: names }),
    });
    const json = await res.json();
    state.ebird[item.id] = json.ok ? { ok: true, ...json } : { ok: false, error: json.error || '查询失败' };
  } catch (err) {
    state.ebird[item.id] = { ok: false, error: err.message || '查询失败' };
  }
  if (state.currentId === item.id) renderStage();
}

/** 合并表里的「本地记录」那一格 */
function ebirdCell(latin, eb) {
  if (!eb) return '<td class="eb-cell"><span class="eb-na">—</span></td>';
  if (eb.loading) return '<td class="eb-cell"><span class="eb-load">查询中…</span></td>';
  if (!eb.ok) return `<td class="eb-cell"><span class="eb-na" title="${esc(eb.error || '')}">未查</span></td>`;
  const hit = (eb.items || []).find((it) => sciKey(it.latin) === sciKey(latin));
  if (!hit) return '<td class="eb-cell"><span class="eb-na">—</span></td>';
  if (!hit.isBird) return '<td class="eb-cell"><span class="eb-na" title="eBird 只收录鸟类，这条不在鸟类名录里">非鸟类</span></td>';
  if (hit.error) return `<td class="eb-cell"><span class="eb-na" title="${esc(hit.error)}">失败</span></td>`;
  if (!hit.count) {
    return `<td class="eb-cell"><span class="eb-zero" title="${esc(eb.regionLabel)}近 ${eb.back} 天没有 eBird 记录">0 条</span></td>`;
  }
  const when = String(hit.last || '').slice(5, 10);
  const tip = [hit.last, hit.lastLoc].filter(Boolean).join(' · ');
  return `<td class="eb-cell"><span class="eb-hit" title="${esc(tip)}">${hit.capped ? '100+' : hit.count} 条</span>${
    when ? `<span class="eb-last">最近 ${esc(when)}</span>` : ''
  }</td>`;
}

/* ---------------- iNaturalist：学名旁的「该地区该属有多少种」 ---------------- */

/**
 * 为什么跳到 Explore 的「物种」视图，而不是直接跳这个种的页面：
 * 认虫认花时真正想知道的是「本地这个属到底有几种」，只有 Explore 能回答。
 * 链接里带三样东西 —— place_id（圈定地区）、taxon_id（属）、view=species（物种标签页，
 * 顶栏直接写「N 种」），正好等于手工操作那三步：
 * 过滤器 → 更多过滤器 → 地点；搜索框输属名；点「物种」标签。
 */

/** 学名 → 属名；认不出来返回空串（这种候选不加按钮，免得跳到错的类群） */
function genusOfLatin(latin) {
  const first =
    String(latin || '')
      .replace(/×/g, ' ')
      .trim()
      .split(/[\s.,;()]+/)[0] || '';
  if (!/^[A-Za-z]{3,}$/.test(first)) return '';
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * 当前检索地区。两种存法（跟服务端 lib/inat.js 的 resolvePlace 一致）：
 *   { place: 'CN-35' }                    常用列表里的地区
 *   { placeId: 222739, placeName: '…' }   用户自己搜出来的地方（城市 / 保护区 / 公园…）
 * 自定义优先，因为那是用户最近一次主动选的。
 */
function inatPlace() {
  const c = state.config.inaturalist || {};
  const customId = Number(c.placeId) || 0;
  const customName = String(c.placeName || '').trim();
  if (customId > 0) {
    return { code: '#custom', name: customName || `地区 #${customId}`, placeId: customId, custom: true };
  }
  const opts = (siteMeta('inaturalist')?.fields || []).find((f) => f.key === 'place')?.options || [];
  const code = String(c.place || '').trim();
  return (
    opts.find((o) => o.code === code) ||
    opts.find((o) => o.code === 'CN') || { code: 'CN', name: '中国', placeId: 6903 }
  );
}

/** 拼链接：有 taxon_id 用 id，没有就退回 taxon_name=属名（iNat 自己会解析）
 *
 *  locale 必须是 zh-CN：iNat 网页端的语言代码里没有裸的 zh（只有 zh-CN / zh-TW / zh-HK），
 *  传了不可用的代码会整页回退英文（官方文档：代码不可用时默认 locale=en）。
 *  跟服务端 lib/inat.js 的 LOCALE 保持一致。 */
function inatHref(genus) {
  const p = inatPlace();
  const hit = state.inatTaxa[genus.toLowerCase()];
  const id = hit && typeof hit === 'object' ? hit.id : hit; // 缓存里存的是 { id, name, rank }
  const q = new URLSearchParams();
  q.set('locale', 'zh-CN');
  if (p.placeId) q.set('place_id', String(p.placeId));
  if (id) q.set('taxon_id', String(id));
  else q.set('taxon_name', genus);
  q.set('view', 'species');
  return `https://www.inaturalist.org/observations?${q.toString()}`;
}

function inatTitle(genus) {
  const p = inatPlace();
  return `在 iNaturalist 打开「${genus} 属 · ${p.name}」的物种视图（新窗口），看这个属在当地记录到多少种`;
}

function inatChip(latin) {
  const g = genusOfLatin(latin);
  if (!g) return '';
  return `<a class="inat-link" href="${esc(inatHref(g))}" data-genus="${esc(g)}" target="_blank" rel="noreferrer" title="${esc(
    inatTitle(g),
  )}">iNat</a>`;
}

/** 属名 → taxon_id：缺的才问服务端，拿到以后就地把 href 换掉（不重绘，免得滚动位置乱跳） */
async function hydrateInatLinks() {
  const links = [...document.querySelectorAll('.inat-link[data-genus]')];
  if (!links.length) return;
  const missing = [...new Set(links.map((a) => a.dataset.genus.toLowerCase()))].filter((g) => !(g in state.inatTaxa));
  if (!missing.length) return;
  try {
    const r = await fetch('/api/inat/taxa', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names: missing, hint: activeGroup() }),
    });
    const j = await r.json();
    if (!j.ok) return;
    Object.assign(state.inatTaxa, j.taxa || {});
    refreshInatLinks();
  } catch {
    /* 网络不通就算了：taxon_name 版链接照样能用 */
  }
}

/** 把已经渲染出来的「iNat」链接就地改掉（地区变了、taxon_id 拿到了，都走这里，不重绘） */
function refreshInatLinks() {
  document.querySelectorAll('.inat-link[data-genus]').forEach((a) => {
    a.href = inatHref(a.dataset.genus);
    a.title = inatTitle(a.dataset.genus);
  });
}

/* ---------------- 植物智 PPBC：按地区查属 ---------------- */

/**
 * 只在「植物」类群下出现。
 *
 * 植物智是植物图像库，但同名属两边都有：Pieris 既是粉蝶属（昆虫）又是马醉木属（植物），
 * 而且 PPBC 里确实能搜到别人上传的「凤蝶属 Papilio」照片。要是不分类群就挂这个按钮，
 * 认蝴蝶会一路点到马醉木属的图片墙上。所以类群不是植物时，这个入口整个不显示。
 */
function ppbcOn() {
  return activeGroup() === 'plant';
}

/**
 * iNat 的中文地名常把英文粘在后面（「南平市武夷山市Wuyishan City」），
 * 而 PPBC 的「地点」只认一级地名（「南平市武夷山市」传进去是零结果）。
 * 这里跟服务端 lib/ppbc.js 的 cleanLocality 保持同一套规则，
 * 只用于接口还没回来的那一瞬间垫一下：
 *   去英文尾巴 → 取最细一级行政区 → 去掉保护区 / 公园后缀。
 */
function localCleanLocality(name) {
  let s = String(name || '').trim();
  if (!s) return '';
  s = s.replace(/^([\u4e00-\u9fa5][\u4e00-\u9fa5（）()·\s]*?)([A-Za-z].*)$/, '$1').trim();
  if (!/[\u4e00-\u9fa5]/.test(s)) return '';
  const parts = s.match(/[^市县区旗盟州]*[市县区旗盟州]/g);
  if (parts && parts.length > 1) s = parts[parts.length - 1];
  return s
    .replace(
      /(国家级|省级|市级)?(自然保护区|保护区|国家公园|森林公园|湿地公园|地质公园|沙漠公园|风景区|景区|公园|植物园|水库|林场)$/,
      '',
    )
    .trim();
}

/**
 * 当前「检索地区」→ PPBC 的两个参数 { pro, didian }。
 *
 * - 下拉里选省：选项自带 pro（服务端 lib/ppbc.js 的省名表随地区选项下发）
 * - 下拉里选国家 / 全世界：空 —— 植物智只收中国照片，按全国打开
 * - 自定义地区（城市 / 县 / 保护区）：选的那一刻已经问过服务端（见 saveInatPlace），
 *   结果存在配置里，这里只做一次 placeId 校验，避免换地区后用到上一次的旧值。
 */
function ppbcRegion() {
  const p = inatPlace();
  const c = state.config.inaturalist || {};
  if (!p.custom) return { pro: String(p.ppbc || ''), didian: '' };
  if (Number(c.ppbcFor) === Number(p.placeId)) {
    return { pro: String(c.ppbcPro || ''), didian: String(c.ppbcDidian || '') };
  }
  // 老配置 / 服务端没算出省份：地点名照样能过滤，先垫上
  return { pro: '', didian: localCleanLocality(p.name) };
}

/** 老代码里只关心省名的地方还留着这个入口 */
function ppbcProv() {
  return ppbcRegion().pro;
}

/** 一句话说清 PPBC 会按哪个范围打开：「福建省 · 武夷山市」 */
function ppbcScope() {
  const r = ppbcRegion();
  if (r.pro && r.didian) return `${r.pro} · ${r.didian}`;
  return r.pro || r.didian || '';
}

/**
 * 落点 /list21?latin=<属>&pro=<省全称>&didian=<一级地名>&sel=like：
 * 列表页顶部直接写「检索 Rhododendron 福建省 武夷山市 共 … 条」，下面是这一范围的照片。
 * 省名必须写全（「福建」会零结果），映射表在服务端 lib/ppbc.js；
 * `didian` 是拍摄地的文本模糊匹配，只能填一级地名（多级拼起来零结果、英文也零结果）。
 * `sel=like`（模糊匹配）不能省：不带它只回「鉴定到属」的记录，卡片上全是「杜鹃花属」，
 * 看不到种；带上它才是「刺毛杜鹃 Rhododendron championiae」这种种名。
 * 带不上地区时（境外 / 全国）服务端会 302 到属页，列出该属在全国的所有种。
 */
function ppbcHref(genus) {
  const r = ppbcRegion();
  const q = new URLSearchParams();
  q.set('latin', genus);
  if (r.pro) q.set('pro', r.pro);
  if (r.didian) q.set('didian', r.didian);
  q.set('sel', 'like');
  return `https://ppbc.iplant.cn/list21?${q.toString()}`;
}

function ppbcTitle(genus) {
  const s = ppbcScope();
  return s
    ? `在植物智（PPBC）看「${genus} 属 · ${s}」属下各种的照片（新窗口），列表顶部写着这一范围这个属共多少条`
    : `在植物智（PPBC）看「${genus} 属」属下各种的照片（新窗口）。植物智只收中国植物照片，这里按全国范围打开`;
}

/**
 * 学名旁的 PPBC 占位（带属名，先空着）。
 * 先占位、再按类群填充，是为了切换类群时不用重绘整张结果表 ——
 * 选了昆虫，现有的 PPBC 小标立刻消失；切回植物，又原地长回来。
 */
function ppbcSlot(latin) {
  const g = genusOfLatin(latin);
  if (!g) return '';
  return `<span class="ppbc-slot" data-genus="${esc(g)}"></span>`;
}

/** 按当前类群 + 地区填充 / 清空所有 PPBC 小标 */
function refreshPpbcChips() {
  const on = ppbcOn();
  document.querySelectorAll('.ppbc-slot[data-genus]').forEach((el) => {
    const g = el.dataset.genus;
    if (!on) {
      if (el.firstChild) el.textContent = '';
      return;
    }
    let a = el.querySelector('a');
    if (!a) {
      el.innerHTML = '<a class="ppbc-link" target="_blank" rel="noreferrer">PPBC</a>';
      a = el.firstChild;
    }
    a.href = ppbcHref(g);
    a.title = ppbcTitle(g);
  });
}

/* ---------------- GBIF · DeepSeek：这个属在这个地区有哪些种 ---------------- */

/**
 * 学名旁的「GBIF·DS」小标。
 *
 * 跟 PPBC / 自然在线不一样，它不挑类群：昆虫问 Papilio、植物问 Rhododendron
 * 都是正经问题，GBIF 本来就动植物真菌全收。所以只要结果里有学名就出。
 *
 * 真正干活的是服务端（见 server.js 的 /api/gbifds/query）：先拿 GBIF 的
 * 真实记录，再让 DeepSeek 配中文名和写归纳。这里只管占位和开面板。
 */
function gbifdsSlot(latin) {
  const g = genusOfLatin(latin);
  if (!g) return '';
  return `<span class="gds-slot" data-genus="${esc(g)}"></span>`;
}

function refreshGbifdsChips() {
  document.querySelectorAll('.gds-slot[data-genus]').forEach((el) => {
    const g = el.dataset.genus;
    let a = el.querySelector('a');
    if (!a) {
      el.innerHTML = '<a class="gds-link" href="#" role="button">GBIF·DS</a>';
      a = el.firstChild;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openGbifdsPanel(g);
      });
    }
    a.title = `问 GBIF：${g} 属在当前检索地区有哪些种，再由 DeepSeek 配中文名、写归纳`;
  });
}

let gdsGen = '';
let gdsSeq = 0;

function openGbifdsPanel(genus) {
  gdsGen = genus;
  $('gds-genus').innerHTML = `<i>${esc(genus)}</i>`;
  $('gds-question').textContent = '…';
  $('gds-body').innerHTML =
    '<div class="gds-loading"><span class="gds-dot"></span>正在向 GBIF 取这个属的记录，再从 iNaturalist 补中文名…（首次查一个属要十几秒，查过就会缓存）</div>';
  $('gds-modal').classList.add('show');
  runGbifds();
}

async function runGbifds() {
  const seq = ++gdsSeq;
  const body = $('gds-body');
  const cur = inatPlace();
  const qs = new URLSearchParams({ genus: gdsGen, group: activeGroup() });
  if (cur.custom) {
    if (cur.placeId) qs.set('placeId', cur.placeId);
    if (cur.name) qs.set('placeName', cur.name);
  } else if (cur.code && cur.code !== '#custom') {
    qs.set('place', cur.code);
  }

  try {
    const j = await fetch('/api/gbifds/query?' + qs.toString()).then((r) => r.json());
    if (seq !== gdsSeq) return; // 用户已经点了别的属，这份结果丢掉
    if (!j.ok) {
      body.innerHTML = `<div class="gds-empty bad">${esc(j.error || '查询失败')}</div>`;
      return;
    }
    $('gds-question').textContent = j.question;
    body.innerHTML = renderGbifds(j);
  } catch (err) {
    if (seq !== gdsSeq) return;
    body.innerHTML = `<div class="gds-empty bad">${esc(err.message || '网络不通')}</div>`;
  }
}

/**
 * 模型给的中文名可能是「R. simsii」这种缩写，也可能夹带空格大小写差异。
 * 匹配时把属名压成首字母再比，比不到就返回空（宁可空着也不张冠李戴）。
 */
function gdsCn(map, latin) {
  if (!map || !latin) return '';
  if (map[latin]) return map[latin];
  const abbr = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/^([a-z])[a-z-]+\.?\s+/, '$1 ');
  const want = abbr(latin);
  for (const [k, v] of Object.entries(map)) {
    if (abbr(k) === want) return String(v || '');
  }
  return '';
}

function renderGbifds(j) {
  const rows = j.species || [];
  const ans = j.answer || {};
  const cnMap = ans.cn || {};
  const family = j.family ? `<span class="gds-fam">${esc(j.family)}</span>` : '';

  const head = `<div class="gds-head">
    <div class="gds-nums">
      <span class="gds-big">${rows.length}</span><span class="gds-unit">种有记录</span>
      ${family}
    </div>
    <div class="gds-meta">GBIF 全球 <b>${j.globalTotal}</b> 个接受名种 · 范围内合计 <b>${j.records}</b> 条记录${
      j.regionName ? ' · 范围：<b>' + esc(j.regionName) + '</b>' : ''
    }</div>
  </div>`;

  const warn = j.warning ? `<div class="gds-warn">${esc(j.warning)}</div>` : '';
  const sum = ans.summary ? `<div class="gds-sum">${esc(ans.summary)}</div>` : '';

  if (!rows.length) {
    return (
      head +
      warn +
      `<div class="gds-empty">GBIF 在<b>${esc(j.regionName || '这个范围')}</b>没有「${esc(
        j.genus,
      )}」属的任何记录。<br>常见原因：这个属在那一带本来就没有分布；或者 GBIF 在当地的数据来自少数几个数据集，覆盖面有限。</div>` +
      (j.regionNote ? `<div class="gds-note">${esc(j.regionNote)}</div>` : '')
    );
  }

  // 主表：GBIF 记录，按记录数从多到少
  const tr = rows
    .map((s, i) => {
      // 服务端已经把定稿的中文名和来源挂在每一行上；老响应没有 cn 字段时退回按表查
      const cn = s.cn || gdsCn(cnMap, s.latin);
      const src = s.cnFrom || (cn && cnMap[s.latin] ? '' : '');
      const tip =
        src === 'inat'
          ? '中文名来自 iNaturalist（与学名精确匹配的俗名）'
          : src === 'ds'
            ? '中文名由 DeepSeek 补写（iNaturalist 上没有这个种的中文名）'
            : '';
      return `<tr>
        <td class="gds-idx">${i + 1}</td>
        <td class="gds-cn"${tip ? ` title="${esc(tip)}"` : ''}>${cn ? esc(cn) : '<span class="gds-nocn">—</span>'}</td>
        <td class="gds-lat"><i>${esc(s.latin)}</i></td>
        <td class="gds-n">${s.count}</td>
      </tr>`;
    })
    .join('');

  // 模型补充：GBIF 没记录、但模型认为该地区确实有的种。单独一块，明确标明来源。
  const known = new Set(rows.map((s) => String(s.latin).toLowerCase()));
  const extra = (ans.extra || []).filter(
    (e) => e && e.latin && !known.has(String(e.latin).toLowerCase().trim()),
  );
  const extraHtml = extra.length
    ? `<div class="gds-sub">模型补充 <span class="gds-tag">GBIF 无记录 · 未经核实</span></div>
      <div class="gds-extras">${extra
        .slice(0, 20)
        .map(
          (e) => `<div class="gds-extra">
            <span class="gds-extra-cn">${esc(e.cn || '—')}</span>
            <i class="gds-extra-lat">${esc(e.latin)}</i>
            ${e.note ? `<span class="gds-extra-note">${esc(e.note)}</span>` : ''}
          </div>`,
        )
        .join('')}</div>`
    : '';

  const usage = ans.usage
    ? `<span class="gds-usage">${esc(ans.model || 'deepseek')} · ${ans.usage.total_tokens || 0} tokens</span>`
    : '';

  // 中文名从哪来，明明白白列出来：iNat 拿到的 / 模型补的 / 都没有的
  const st = ans.cnStats || {};
  const statBits = [];
  if (st.inat) statBits.push(`iNaturalist ${st.inat}`);
  if (st.ds) statBits.push(`DeepSeek 补 ${st.ds}`);
  if (st.missing) statBits.push(`缺 ${st.missing}`);
  const stat = statBits.length ? `<span class="gds-cnstat">中文名 ${statBits.join(' · ')}</span>` : '';

  return `${head}
    ${sum}
    ${warn}
    <div class="gds-sub">GBIF 记录到的种 <span class="gds-tag ok">学名以 GBIF 为准</span>${stat}</div>
    <div class="gds-tablewrap">
      <table class="gds-table">
        <thead><tr><th>#</th><th>中文名</th><th>学名</th><th>记录</th></tr></thead>
        <tbody>${tr}</tbody>
      </table>
    </div>
    ${extraHtml}
    <div class="gds-note">${j.regionNote ? esc(j.regionNote) + '<br>' : ''}
      中文名优先取自 <b>iNaturalist</b>（与学名精确匹配），取不到的才由 DeepSeek 补写，两处都没有就留空。学名照抄 GBIF；「记录」是该种在范围内的标本/观察条数，不是种群数量。${usage}</div>`;
}

/* ---------------- 自然在线：按站点查属下的种 ---------------- */

/**
 * 什么时候出现 —— 两条：**植物类群** + **站点清单里有 xingse**（自然在线）。
 *
 * 看图识别和「各保护区名录」是同一套后端（ecp.ibiodiversity.cn、同一张令牌），
 * 名录走的是没公开的私有接口（/api/online/site/…）。这个站点早先是隐藏的、
 * 要输暗号才出来，现在默认开放，所以只要用户在植物类群下就能用；
 * 站点被关掉（或将来再改成隐藏）小标自然就不出现。
 *
 * 另外限「植物」类群：名录里虽然有动物真菌，但主体是植物，而且同名属两边都有
 * （Pieris 既是粉蝶属又是马醉木属），跟 PPBC 一个道理。
 */
function natureOn() {
  return activeGroup() === 'plant' && !!siteMeta('xingse');
}

/**
 * 检索地区名 → 站点搜索关键词（跟服务端 lib/nature.js 的 keywordOf 同一套规则）：
 *   南平市武夷山市Wuyishan City → 武夷山
 *   武夷山国家级自然保护区      → 武夷山
 *   福建省                     → 福建
 * 只用于面板里预填一下，用户随时能改；真正查的时候以输入框为准。
 */
function natKeyword(name) {
  let s = localCleanLocality(name);
  if (!s) return '';
  // 「全世界（不限地区）」这类不是地名，拿去搜站点只会白跑
  if (/^(全世界|全球|世界|不限)/.test(s) || /不限地区/.test(s)) return '';
  s = s.replace(/([\u4e00-\u9fa5]{1,5}族)+(自治州|自治县|自治旗)/, '$2');
  return s
    .replace(/(特别行政区|自治区|自治州|自治县|自治旗|省|市|县|区|旗|盟|州)$/, '')
    .trim();
}

/** 跟 PPBC 一样先占位、解锁后再填，这样切类群 / 收放隐藏站点都不用重绘整张结果表 */
function natureSlot(latin) {
  const g = genusOfLatin(latin);
  if (!g) return '';
  return `<span class="nat-slot" data-genus="${esc(g)}"></span>`;
}

function refreshNatureChips() {
  const on = natureOn();
  document.querySelectorAll('.nat-slot[data-genus]').forEach((el) => {
    const g = el.dataset.genus;
    if (!on) {
      if (el.firstChild) el.textContent = '';
      return;
    }
    let a = el.querySelector('a');
    if (!a) {
      el.innerHTML = '<a class="nat-link" href="#" role="button">自然在线</a>';
      a = el.firstChild;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openNaturePanel(g);
      });
    }
    a.title = `在「自然在线」的站点名录里看 ${g} 属有哪些种（只列该站名录里收的种，和植物智的照片数不是一回事）`;
  });
}

/* ---------------- 自然在线面板 ---------------- */

let natGenus = '';
let natSeq = 0;

function openNaturePanel(genus) {
  natGenus = genus;
  const cur = inatPlace();
  // 属名按生物命名规范用斜体
  $('nat-genus').innerHTML = `<i>${esc(genus)}</i>`;
  $('nat-q').value = natKeyword(cur.name);
  $('nat-scope').textContent = cur.placeId ? `检索地区：${cur.name}` : '检索地区：全世界';
  $('nat-body').innerHTML = '';
  $('nat-modal').classList.add('show');
  queryNature();
}

async function queryNature() {
  const body = $('nat-body');
  const q = ($('nat-q').value || '').trim();
  if (!q) {
    body.innerHTML =
      '<div class="nat-empty">先在上面填一个站点关键词，比如 <b>武夷山</b>、<b>闽江源</b>、<b>车八岭</b>。<br>自然在线的站点是各保护区自己建的，站名里通常带地名。</div>';
    return;
  }

  const cur = inatPlace();
  const qs = new URLSearchParams({ genus: natGenus, q });
  // 把当前检索地区一起带上，服务端才知道该按哪个地名推关键词
  if (cur.custom) {
    if (cur.placeId) qs.set('placeId', cur.placeId);
    if (cur.name) qs.set('placeName', cur.name);
  } else if (cur.code && cur.code !== '#custom') {
    qs.set('place', cur.code);
  }

  const seq = ++natSeq;
  const btn = $('nat-go');
  if (btn) btn.disabled = true;
  body.innerHTML =
    '<div class="nat-loading"><span class="spinner"></span>正在搜站点、拉名录（第一次要几秒，之后走缓存）…</div>';
  try {
    const r = await fetch(`/api/nature/sites?${qs.toString()}`).then((x) => x.json());
    if (seq !== natSeq) return; // 又点了一次，这次结果作废
    renderNature(r);
  } catch (err) {
    if (seq !== natSeq) return;
    body.innerHTML = `<div class="nat-empty bad">查询失败：${esc(err.message || '接口不通')}</div>`;
  } finally {
    if (seq === natSeq && btn) btn.disabled = false;
  }
}

function natureSp(sp) {
  const cn = sp.cn ? `<span class="nat-cn">${esc(sp.cn)}</span>` : '';
  const lat = sp.latin ? `<i class="nat-lat">${esc(sp.latin)}</i>` : '';
  // 不显示科名：同一个属的种必然同科，写出来只是一行行的重复
  return `<span class="nat-sp">${cn}${lat}</span>`;
}

function natureRow(s) {
  const n = s.n;
  const meta = s.error
    ? `<span class="nat-err">${esc(s.error)}</span>`
    : `名录 ${s.total} 条 · ${s.genera} 属`;
  const sps = n
    ? `<div class="nat-sps">${s.species.map(natureSp).join('')}</div>` +
      (s.more ? `<div class="nat-more">还有 ${s.more} 个种没列，进站里看全部</div>` : '')
    : `<div class="nat-sps"><span class="nat-none">${s.error ? '没拉到名录' : '这个站的名录里没有这个属'}</span></div>`;
  return `<details class="nat-row${n ? '' : ' zero'}">
    <summary>
      <span class="nat-name">${esc(s.title)}</span>
      <span class="nat-meta">${meta}</span>
      <span class="nat-n${n ? '' : ' none'}">${n ? n + ' 种' : '无记录'}</span>
    </summary>
    ${sps}
    <div class="nat-foot">
      ${s.master ? `<span class="nat-master">建站人 ${esc(s.master)}</span>` : ''}
      ${s.updated ? `<span class="nat-master">更新于 ${esc(s.updated)}</span>` : ''}
      <a class="nat-open" href="${esc(s.url)}" target="_blank" rel="noreferrer">在自然在线打开这个站 →</a>
    </div>
  </details>`;
}

function renderNature(r) {
  const body = $('nat-body');
  if (!r || !r.ok) {
    const msg = (r && r.error) || '查询失败';
    const needLogin = /登录|令牌|过期/.test(msg);
    body.innerHTML =
      `<div class="nat-empty bad">${esc(msg)}</div>` +
      (needLogin
        ? '<div class="nat-hint">名录和看图识别共用一张令牌：先到「账号设置」里给自然在线取一次验证码登录，之后这里的站点名录才查得动。</div>'
        : '');
    return;
  }

  const sites = r.sites || [];
  if (!sites.length) {
    body.innerHTML = `<div class="nat-empty">关键词「<b>${esc(r.keyword)}</b>」没有搜到任何站点。<br>换个地名试试：自然在线的站名一般是「某某保护区 / 某某国家公园」，用<b>地名本身</b>搜最灵（「武夷山」而不是「南平市武夷山市」）。</div>`;
    return;
  }

  const hit = sites.filter((s) => s.n > 0);
  const zero = sites.filter((s) => !s.n);
  const maxN = hit.length ? hit[0].n : 0;
  const sum = `<div class="nat-sum">关键词「<b>${esc(r.keyword)}</b>」命中 <b>${r.matched}</b> 个站点，已查 ${
    r.scanned
  } 个${r.skipped ? `（还有 ${r.skipped} 个没查）` : ''}；其中 <b>${hit.length}</b> 个站点名录里有「<b>${esc(
    r.genus,
  )}</b>」属${maxN ? `，最多的是「${esc(hit[0].title)}」${maxN} 种` : ''}。</div>`;

  const warn =
    '<div class="nat-hint">站点是按中文标题模糊匹配的：搜「南平」可能混进「湖南平江芦头林场」这类的同名站，点开前看一眼站名。</div>';

  body.innerHTML =
    sum +
    `<div class="nat-list">${hit.map(natureRow).join('')}</div>` +
    (zero.length
      ? `<div class="nat-sub">没记录的 ${zero.length} 个站</div><div class="nat-list">${zero.map(natureRow).join('')}</div>`
      : '') +
    warn;
}

/* 自然在线面板：查 / 关闭 / Esc。各弹层各管各的，互不干扰 */
document.addEventListener('click', (e) => {
  if (e.target.closest('#nat-go')) {
    e.preventDefault();
    queryNature();
    return;
  }
  if (e.target.id === 'nat-close' || e.target.id === 'nat-modal') {
    $('nat-modal').classList.remove('show');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'nat-q') {
    e.preventDefault();
    queryNature();
  } else if (e.key === 'Escape' && $('nat-modal')?.classList.contains('show')) {
    $('nat-modal').classList.remove('show');
  }
});

/* ---------------- 主页面的「iNat 检索地区」 ---------------- */

/**
 * 这一行原来在「账号设置」里，改地区得开弹层、保存、再登录一遍，太重；
 * 而它其实只影响结果里那个「iNat」按钮，跟识别账号毫无关系，所以挪到主页面。
 * 左边下拉给常用地区（中国各省 + 其他国家，够平时用），
 * 右边输入框留给自己搜 —— 城市、保护区、公园都能搜到，存 place_id。
 */
function renderInatBar() {
  const sel = $('inat-place-sel');
  if (!sel) return;
  const opts = (siteMeta('inaturalist')?.fields || []).find((f) => f.key === 'place')?.options || [];
  if (!opts.length) return;
  const cur = inatPlace();

  const opt = (o) =>
    `<option value="${esc(o.code)}"${!cur.custom && o.code === cur.code ? ' selected' : ''}>${esc(o.name)}</option>`;
  const group = (label, list) => (list.length ? `<optgroup label="${esc(label)}">${list.map(opt).join('')}</optgroup>` : '');

  const cn = opts.filter((o) => o.kind === 'china');
  const prov = opts.filter((o) => o.kind === 'province');
  const countries = opts.filter((o) => o.kind === 'country');
  const world = opts.filter((o) => o.kind === 'world');
  const continents = [...new Set(countries.map((o) => o.continent).filter(Boolean))];

  const custom = cur.custom ? `<option value="#custom" selected>自定义：${esc(cur.name)}</option>` : '';
  sel.innerHTML = [
    custom,
    group('中国', cn),
    group('省级行政区', prov),
    ...continents.map((c) => group(c, countries.filter((o) => o.continent === c))),
    group('不限', world),
  ]
    .filter(Boolean)
    .join('');

  const hint = $('inat-hint') || document.querySelector('.inat-hint');
  if (hint) {
    const scope = ppbcScope();
    const ppbcTip = scope
      ? `「PPBC」按${scope}打开`
      : cur.custom
        ? '「PPBC」按全国打开（这个地区对不上植物智的省 / 地点）'
        : '「PPBC」按全国打开（植物智只收中国照片）';
    // 自然在线的站点名录只在植物类群、且站点在清单里时才给出这半句
    const natQ = natureOn() ? natKeyword(cur.name) : '';
    const natTip = natQ ? `，「自然在线」按「${esc(natQ)}」搜站点` : '';
    hint.innerHTML = cur.placeId
      ? `当前：<b>${esc(cur.name)}</b> · 「iNat」按这个范围打开，${ppbcTip}${natTip}，识别本身不受影响`
      : `当前：<b>全世界</b> · 「iNat」不带地区，${ppbcTip}${natTip}，识别本身不受影响`;
  }
}

/**
 * 问服务端：这个自定义地区，植物智该按哪个省 + 哪个地点打开。
 * 换地区时问一次就够了（结果存进配置），平时渲染不联网。
 * 接口不通就垫个「只用地名」，至少还能过滤，不至于退回全国。
 */
async function askPpbcRegion(placeId, placeName) {
  const id = Number(placeId) || 0;
  try {
    const r = await fetch(
      `/api/ppbc/region?placeId=${id}&placeName=${encodeURIComponent(placeName || '')}`,
    ).then((x) => x.json());
    if (r.ok) return { pro: String(r.pro || ''), didian: String(r.didian || '') };
  } catch {
    /* 没网 / 服务没起：走下面的兜底 */
  }
  return { pro: '', didian: localCleanLocality(placeName) };
}

/** 保存检索地区：只写 inaturalist 这一小块，不碰账号密码 */
async function saveInatPlace(patch, quiet) {
  const body = { sites: { inaturalist: patch } };
  // 自定义地区要顺手把 PPBC 的 pro / didian 算好存下来 —— 这里是一次联网，
  // 之后渲染、切类群、改配置都只读本地，不重复请求。
  const customId = Number(patch.placeId) || 0;
  if (customId > 0) {
    const r = await askPpbcRegion(customId, patch.placeName);
    body.sites.inaturalist = {
      ...patch,
      ppbcFor: customId,
      ppbcPro: r.pro,
      ppbcDidian: r.didian,
    };
  } else if ('placeId' in patch) {
    body.sites.inaturalist = { ...patch, ppbcFor: 0, ppbcPro: '', ppbcDidian: '' };
  }
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.ok && r.config) state.config = r.config;
    else state.config.inaturalist = { ...(state.config.inaturalist || {}), ...body.sites.inaturalist };
  } catch {
    state.config.inaturalist = { ...(state.config.inaturalist || {}), ...body.sites.inaturalist };
  }
  renderInatBar();
  refreshInatLinks();
  refreshPpbcChips();
  refreshNatureChips();
  if (quiet) return;
  const p = inatPlace();
  toast(p.placeId ? `检索地区已设为「${p.name}」` : '检索地区已设为「全世界」');
}

/**
 * 老配置补一课：1.0.35 之前存的自定义地区只有 placeId，没有 ppbcPro / ppbcDidian，
 * 那时候 PPBC 只能按全国打开。开到页面时静默补算一次（只写配置，不弹提示、不动地区）。
 */
async function healPpbcRegion() {
  const c = state.config.inaturalist || {};
  const id = Number(c.placeId) || 0;
  if (!id || Number(c.ppbcFor) === id) return;
  await saveInatPlace({ place: '', placeId: id, placeName: c.placeName || '' }, true);
}

let placeTimer = 0;
let placeSeq = 0;

function hidePlaceSugs() {
  const box = $('place-sugs');
  if (!box) return;
  box.hidden = true;
  box.innerHTML = '';
  placeSeq++; // 让还在路上的请求作废
}

function showPlaceSugs(rows, note = '') {
  const box = $('place-sugs');
  const inp = $('inat-place-q');
  if (!box || !inp) return;
  // 挂在输入框正下方（bar 可能换行，所以按实际位置算）
  box.style.left = `${Math.max(12, inp.offsetLeft)}px`;
  if (note) {
    box.innerHTML = `<div class="ps-note${/失败|出错/.test(note) ? ' bad' : ''}">${esc(note)}</div>`;
    box.hidden = false;
    return;
  }
  box.innerHTML = rows
    .map(
      (r) => `<button class="place-sug" data-place-id="${r.id}" data-place-name="${esc(r.name)}">
        <span class="ps-name">${esc(r.name)}</span><span class="ps-kind">${esc(r.kind || '地区')}</span>
        <span class="ps-dn">${esc(r.display || '')}</span>
      </button>`,
    )
    .join('');
  box.hidden = false;
}

async function searchPlaceSugs(q) {
  const seq = ++placeSeq;
  showPlaceSugs([], '正在搜索…');
  try {
    const j = await fetch(`/api/inat/places?q=${encodeURIComponent(q)}`).then((r) => r.json());
    if (seq !== placeSeq) return;
    if (!j.ok) return showPlaceSugs([], j.error || '搜索失败，稍后再试');
    if (!j.results || !j.results.length) return showPlaceSugs([], `没找到「${q}」，换个说法试试（也可以填英文名）`);
    showPlaceSugs(j.results);
  } catch {
    if (seq === placeSeq) showPlaceSugs([], '搜索失败：连不上本地服务');
  }
}

function bindInatBar() {
  const sel = $('inat-place-sel');
  const inp = $('inat-place-q');
  const box = $('place-sugs');
  if (!sel || !inp || !box) return;

  sel.addEventListener('change', async () => {
    if (sel.value === '#custom') return; // 自定义项只是个展示，别把 '#custom' 存进去
    await saveInatPlace({ place: sel.value, placeId: 0, placeName: '' });
  });

  inp.addEventListener('input', () => {
    clearTimeout(placeTimer);
    const q = inp.value.trim();
    if (q.length < 2) return hidePlaceSugs();
    placeTimer = setTimeout(() => searchPlaceSugs(q), 420);
  });

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = box.querySelector('.place-sug');
      if (first) first.click();
      else if (inp.value.trim().length >= 2) searchPlaceSugs(inp.value.trim());
    } else if (e.key === 'Escape') {
      hidePlaceSugs();
    }
  });

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-place-id]');
    if (!b) return;
    const id = Number(b.dataset.placeId) || 0;
    const name = b.dataset.placeName || '';
    if (!id) return;
    hidePlaceSugs();
    inp.value = '';
    await saveInatPlace({ place: '', placeId: id, placeName: name });
  });

  // 点到别处就收起候选
  document.addEventListener('click', (e) => {
    if (e.target.closest('.inat-bar')) return;
    hidePlaceSugs();
  });
}

/* ---------------- 结果渲染 ---------------- */

function currentItem() {
  return state.items.find((i) => i.id === state.currentId) || null;
}

function renderStage() {
  const item = currentItem();
  $('empty').hidden = !!item;
  $('content').hidden = !item;
  if (!item) return;

  if (item.status === 'running' || item.status === 'pending') {
    const chosen = selectedOrder();
    // eBird 这类核对层不接收图片，等待列表里不出现它
    const pushing = chosen.filter((k) => !(siteMeta(k) || {}).verify);
    $('v-text').textContent = `正在向 ${pushing.length} 个站点推送图片…`;
    $('v-sub').textContent = item.name;
    const thRun = $('ebird-th');
    if (thRun) thRun.hidden = !ebirdOn();
    $('sites').innerHTML = pushing.map(
      (k) => `<div class="site-card loading">
        <header class="site">
          <span class="title">${esc(siteLabel(k))}</span>
          <span class="tmeta"><span class="spinner"></span>识别中</span>
        </header>
        <div class="body">等待返回…</div>
      </div>`,
    ).join('');
    $('agg-body').innerHTML = '';
    return;
  }

  if (item.status === 'error') {
    $('v-text').textContent = '识别失败';
    $('v-sub').textContent = item.error;
    $('sites').innerHTML = '';
    $('agg-body').innerHTML = '';
    return;
  }

  const r = item.resp;
  const agg = r.aggregate;
  $('v-text').textContent = agg.verdict;
  $('v-sub').textContent = `${item.name} · 用时 ${(r.elapsed / 1000).toFixed(1)}s · ${Object.keys(
    r.results,
  ).length} 个站点查询，${agg.siteCount} 个返回结果`;

  $('sites').innerHTML = Object.keys(r.results).map((k) => siteCard(k, r.results[k])).join('');

  // eBird 那一列：随识别结果一起刷新（查询是异步的，先占位再填）
  const eb = state.ebird[item.id] || null;
  const ebOn = ebirdOn();
  const th = $('ebird-th');
  if (th) {
    th.hidden = !ebOn;
    th.textContent = eb && eb.ok && eb.regionLabel ? `eBird·${eb.regionLabel} 近14天` : 'eBird 近14天';
    th.title = eb && eb.ok ? `${eb.regionLabel} 近 ${eb.back} 天的 eBird 记录条数，供判断候选项是否可信` : '本地区近期记录数';
  }

  const bestKey = agg.best ? agg.best.key : '';
  $('agg-body').innerHTML = agg.rows
    .slice(0, 15)
    .map((row, i) => {
      const support = Object.keys(row.bySite);
      const pills = support
        .map((s) => `<span class="pill">${esc(siteLabel(s))} ${fmtScore(row.bySite[s].score)}</span>`)
        .join('');
      const missing = agg.sites
        .filter((s) => !row.bySite[s])
        .map((s) => `<span class="pill dim">${esc(siteLabel(s))} —</span>`)
        .join('');
      const badge =
        row.support >= agg.siteCount
          ? '<span class="badge">全站提到</span>'
          : row.support >= 3
            ? `<span class="badge gray">${row.support} 站提到</span>`
            : row.support === 2
              ? '<span class="badge gray">2 站提到</span>'
              : '';
      const nm = nameCell(row.latin, row.cn);
      return `<tr>
        <td style="color:#9aa8b6">${i + 1}</td>
        <td>
          <div>${nm.cn || '—'} ${badge}</div>
          <div class="lat" style="font-size:12.5px;color:#4a5b6d">${nm.lat}${inatChip(row.latin)}${ppbcSlot(row.latin)}${natureSlot(row.latin)}${gbifdsSlot(row.latin)}</div>
        </td>
        <td>${row.support}/${agg.siteCount}</td>
        <td><span class="scorebar"><i style="width:${Math.min(100, row.pct)}%"></i></span> <span style="font-size:12px;color:#0f766e">${row.pct}</span></td>
        <td>${pills}${missing}</td>
        ${ebOn ? ebirdCell(row.latin, eb) : ''}
      </tr>`;
    })
    .join('');
  // 学名旁的「iNat」按钮：属名 → taxon_id 是异步查的，先在后台补齐链接
  hydrateInatLinks();
  // 学名旁的「PPBC」按钮：只跟当前类群 + 检索地区有关，同步填就行
  refreshPpbcChips();
  refreshNatureChips();
  // 「GBIF·DS」小标：不挑类群也不随地区变，结果表重画后补一次就行
  refreshGbifdsChips();
}

function siteCard(key, res) {
  const name = siteLabel(key);
  const home = siteHome(key);
  if (!res) {
    return `<div class="site-card"><header class="site"><span class="title">${name}</span>
      <span class="tmeta">未查询</span></header><div class="body" style="color:#8b9aaa">本张未包含该站点</div></div>`;
  }
  if (!res.ok) {
    // 「这张图不归它管」（懂鸟只认鸟、快瞳只认鸟、晓虫分区只认对应类群）算正常跳过，
    // 不是故障 —— 用灰色而不是红色，免得一眼看过去像程序坏了。
    const err = res.error || '失败';
    // 「这张图不是我这类」不算故障：灰色显示，别让人以为站点挂了
    const skipped =
      /没识别出动物|没识别出植物|没检测到目标框|不在指定地区的分布范围|没认出来|没认出鸟|未解析到物种|没有任何结果/.test(
        err,
      );
    return `<div class="site-card ${skipped ? 'skipped' : 'failed'}">
      <header class="site"><span class="title">${name}</span><span class="tmeta">${(res.ms / 1000).toFixed(1)}s</span></header>
      <div class="body">${esc(err)}</div></div>`;
  }
  const mirror = res.mirrorOf
    ? `<div class="mirror-note">与「${esc(siteLabel(res.mirrorOf))}」共用同一接口，结果相同，已去重不重复计票</div>`
    : '';
  const top = res.items.slice(0, 5);
  const max = Math.max(...top.map((t) => t.score), 1);
  return `<div class="site-card${res.mirrorOf ? ' mirrored' : ''}">
    <header class="site">
      <span class="title">${name}</span>
      <span class="tmeta">${res.mirrorOf ? '同引擎' : `${(res.ms / 1000).toFixed(1)}s`} · <a class="src" href="${home}" target="_blank" rel="noreferrer">原站</a></span>
    </header>
    ${mirror}
    <div class="body">
      ${top
        .map((t) => {
          const nm = nameCell(t.latin, t.cn);
          return `<div class="cand">
            <span class="rk">${t.rank}</span>
            <span class="nm">${nm.lat}${nm.cn}</span>
            <span class="sc">${fmtScore(t.score)}</span>
          </div>
          <div class="bar"><i style="width:${Math.max(3, (t.score / max) * 100)}%"></i></div>`;
        })
        .join('')}
    </div>
  </div>`;
}

/* ---------------- CSV ---------------- */

function toCsv(rows) {
  const lines = rows.map((r) =>
    r
      .map((cell) => {
        const s = String(cell ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(','),
  );
  return '\ufeff' + lines.join('\r\n');
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function rowsFor(item) {
  const rows = [['图片', '类型', '站点/序号', '中文名', '学名', '置信度', '支持站点数', '综合得分']];
  if (!item.resp) return rows;
  const r = item.resp;
  for (const key of Object.keys(r.results)) {
    const res = r.results[key];
    if (!res || !res.ok) continue;
    for (const it of res.items.slice(0, 5)) {
      rows.push([item.name, '单站结果', `${siteLabel(key)}#${it.rank}`, it.cn || '', it.latin, it.score, '', '']);
    }
  }
  for (const row of r.aggregate.rows.slice(0, 15)) {
    rows.push([
      item.name,
      '合并结果',
      row.support + '/' + r.aggregate.siteCount,
      row.cn || '',
      row.latin,
      Object.entries(row.bySite).map(([s, v]) => `${siteLabel(s)}:${v.score}`).join(' | '),
      row.support,
      row.pct,
    ]);
  }
  return rows;
}

function exportOne() {
  const item = currentItem();
  if (!item?.resp) return toast('这张还没有结果');
  const name = item.name.replace(/\.[^.]+$/, '');
  download(`${name}-鉴定结果.csv`, toCsv(rowsFor(item)));
}

function exportAll() {
  const done = state.items.filter((i) => i.status === 'done');
  if (!done.length) return toast('还没有可导出的结果');
  const rows = [['图片', '类型', '站点/序号', '中文名', '学名', '置信度', '支持站点数', '综合得分']];
  for (const item of done) rows.push(...rowsFor(item).slice(1));
  download(`物种鉴定汇总-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
}

/* ---------------- 设置 ---------------- */

function renderConfig(sites) {
  const cfg = sites || {};
  $('config-body').innerHTML = allKeys()
    .map((k) => {
      const c = cfg[k] || {};
      const m = siteMeta(k) || {};
      // 多识的三个分组共用一份账号：只有主条目（duoshi）显示输入框
      const sharedFrom = m.account && m.account !== k ? m.account : '';
      const needAuth = (k === 'duoshi' || k === 'inaturalist' || k === 'xingse') && !sharedFrom;
      if (sharedFrom) {
        const sharedWord = m.auth === 'key' ? '密钥' : '登录态';
        return `<div class="site-block"><h4>${esc(siteLabel(k))} <span class="badge gray">共用「${esc(siteLabel(sharedFrom))}」${sharedWord}</span></h4>
        <div style="font-size:12px;color:#6b7a8c">识别分组：${esc(m.note || '')}；${sharedWord}与「${esc(siteLabel(sharedFrom))}」共用，无需单独填写。</div></div>`;
      }
      // 「填密钥」的站点（豆包 / 快瞳）：没有账号密码，只有一组密钥，字段由 SITE_META.fields 描述
      if (m.auth === 'key') {
        const fields = (m.fields || [
          { key: 'apiKey', label: '方舟 API Key', secret: true, placeholder: '粘贴 API Key' },
          { key: 'model', label: '模型 ID', placeholder: 'doubao-seed-2-1-pro-260915' },
        ]).filter((f) => !f.hideInSettings);
        const hasOf = (fk) => !!c['has' + fk[0].toUpperCase() + fk.slice(1)];
        const hasSaved = fields.some((f) => f.secret && hasOf(f.key));
        const inner = hasSaved
          ? `<div style="font-size:12px;color:#6b7a8c">密钥已保存，可以直接用；下面留空即可，想换成自己的账号时再填。</div>`
          : `<div style="font-size:12px;color:#6b7a8c">需要自己准备密钥，填在下面就能用。</div>`;
        // 有字段被挪到别处的站点（eBird 的地区）：在这里指个路，免得用户到处找
        const moved = (m.fields || []).filter((f) => f.hideInSettings).map((f) => f.label);
        const movedTip = moved.length
          ? `<div class="moved-tip">「${esc(moved.join('、'))}」不在这里改：点顶部站点条上的「${esc(
              siteLabel(k),
            )}」会弹出来，可用浏览器定位自动填。当前：<b>${
              k === 'ebird' ? esc(regionLabelOf(ebirdRegion())) : '—'
            }</b></div>`
          : '';
        const inputs = fields
          .map((f) => {
            const ph = f.secret
              ? hasOf(f.key)
                ? '已加密保存，不回显 · 留空则保持不变'
                : f.placeholder || ''
              : f.placeholder || '';
            const id = `f-${k}-${f.key}`.replace(/[^\w-]/g, '_');
            const baseAttrs = [
              `id="${id}"`,
              `data-site="${k}"`,
              `data-key="${esc(f.key)}"`,
              `value="${f.secret ? '' : esc(c[f.key] || '')}"`,
              'autocomplete="off"',
              'spellcheck="false"',
              `placeholder="${esc(ph)}"`,
            ];
            if (f.secret) baseAttrs.unshift('type="password"', 'data-secret="1"');

            // 纯下拉（Pl@ntNet 的「区系」）：选项固定，存的就是 option 的 value
            if (f.type === 'select' && Array.isArray(f.options)) {
              const cur = String(c[f.key] ?? '').trim() || f.placeholder || (f.options[0] ? f.options[0].value : '');
              const opts = f.options
                .map(
                  (o) =>
                    `<option value="${esc(o.value)}"${o.value === cur ? ' selected' : ''}>${esc(o.label)}</option>`,
                )
                .join('');
              return `<div class="field"><label>${esc(f.label)}</label>
                <select id="${id}" data-site="${k}" data-key="${esc(f.key)}">${opts}</select></div>`;
            }

            // 地区这类「枚举 + 允许自填」的字段：左边下拉选，右边输入框兜底
            if (f.type === 'region' && Array.isArray(f.options)) {
              const cur = String(c[f.key] || '').trim();
              const inCn = f.options.filter((o) => /^CN-/.test(o.code) || ['TW', 'HK', 'MO'].includes(o.code));
              const rest = f.options.filter((o) => !inCn.includes(o));
              const opt = (o) =>
                `<option value="${esc(o.code)}"${o.code === cur ? ' selected' : ''}>${esc(o.name)}（${esc(o.code)}）</option>`;
              const sel = `<select class="region-sel" data-fill="${id}" title="选一个常用地区，会填到右边">
                <option value="">选择常用地区…</option>
                <optgroup label="中国">${inCn.map(opt).join('')}</optgroup>
                <optgroup label="其他国家 / 地区">${rest.map(opt).join('')}</optgroup>
              </select>`;
              return `<div class="field"><label>${esc(f.label)}</label>
                <div class="region-row">${sel}<input ${baseAttrs.join(' ')}></div></div>`;
            }

            return `<div class="field"><label>${esc(f.label)}</label><input ${baseAttrs.join(' ')}></div>`;
          })
          .join('');
        return `<div class="site-block"><h4>${esc(siteLabel(k))} <span class="badge gray">🔒 密文保存</span></h4>
        ${inner}
        ${inputs}
        ${movedTip}
        ${m.hint ? `<div style="font-size:12px;color:#6b7a8c;margin-top:2px">${esc(m.hint)}</div>` : ''}
      </div>`;
      }
      if (!needAuth) {
        return `<div class="site-block"><h4>${esc(siteLabel(k))} <span class="badge gray">无需登录</span></h4>
        <div style="font-size:12px;color:#6b7a8c">${esc(m.note || '直接上传识别，无需账号。')}</div></div>`;
      }
      const extra = k === 'duoshi'
        ? `<div style="font-size:12px;color:#6b7a8c;margin-top:2px">这一份账号同时供「多识·鸟类」「多识·植物」使用，识别分组已拆成三个独立站点。</div>`
        : k === 'xingse'
          ? xingseBlock(c)
          : k === 'inaturalist'
            ? inatMovedTip()
            : '';
      return `<div class="site-block"><h4>${esc(siteLabel(k))} <span class="badge gray">🔒 密文保存</span></h4>
      <div class="field"><label>用户名</label><input data-site="${k}" data-key="username" data-real="${esc(c.username || '')}" value="${esc(DISPLAY_USERNAME)}"></div>
      <div class="field"><label>密码</label><input type="password" data-site="${k}" data-key="password" value="" autocomplete="new-password"
        placeholder="${c.hasPassword ? '已加密保存，不回显 · 留空则保持不变' : '尚未设置'}"></div>
      ${extra}
    </div>`;
    })
    .join('') + deepseekBlock() + aboutBlock();

  // 地区下拉只是「帮填」：选中后写进右边的输入框，保存时以输入框为准
  $('config-body')
    .querySelectorAll('select[data-fill]')
    .forEach((sel) =>
      sel.addEventListener('change', () => {
        const inp = document.getElementById(sel.dataset.fill);
        if (inp && sel.value) inp.value = sel.value;
        if (inp) inp.dispatchEvent(new Event('input', { bubbles: true }));
      }),
    );
  // 检索地区刚变过：把已经渲染出来的「iNat」链接就地改掉，不用重新识别
  refreshInatLinks();
}

/**
 * iNaturalist 那一段：检索地区已经挪到主页面上了，这里只留一句指路 + 当前值，
 * 免得用户又跑到设置里翻。
 */
function inatMovedTip() {
  const p = inatPlace();
  return `<div class="moved-tip">「检索地区」不在这里改：主页面上方「iNat 检索地区」那一栏就能改，
  下拉里有中国各省和六十多个国家，也可以直接搜城市 / 保护区。当前：<b>${esc(p.name)}</b></div>`;
}

/** 自然在线那一段：账号密码之外还要人工看一次验证码 */
function xingseBlock(c) {
  const m = siteMeta('xingse');
  const st = (m && m.state) || {};
  const ok = !!st.ok;
  const tip = c.hasToken
    ? `令牌已加密保存${c.tokenSavedAt ? '（' + esc(c.tokenSavedAt) + '）' : ''}，一般可长期复用；失效时在下面重新登录一次`
    : '还没登录过：先保存账号密码，再点「获取验证码」，填进图里的 4 个字符';
  return `<div class="xs-login">
    <div class="xs-state">
      <span class="dot ${ok ? 'ok' : 'bad'}"></span>
      <span>自然在线登录：<b>${ok ? '已连接' : esc(st.message || '未登录')}</b></span>
    </div>
    <button class="tiny" id="xs-cap-get">获取验证码</button>
    <div class="xs-cap" id="xs-cap-box" hidden>
      <img id="xs-cap-img" alt="验证码">
      <input id="xs-cap-code" maxlength="8" autocomplete="off" spellcheck="false" placeholder="图中字符">
      <button class="tiny primary" id="xs-cap-do">登录</button>
    </div>
    <div class="xs-tip">${esc(tip)}</div>
  </div>`;
}

/**
 * DeepSeek 那一段。
 *
 * 它不是一个识别站点（不投票、不进站点条），所以不跟 sites 走：
 * 单独一块，单独 POST，key 只以密文落本机，界面永远回显「已保存」而不是明文。
 */
function deepseekBlock() {
  const d = state.deepseek || {};
  const has = !!d.hasApiKey;
  return `<div class="site-block"><h4>DeepSeek（GBIF 查询）<span class="badge gray">🔒 密文保存</span></h4>
    <div style="font-size:12px;color:#6b7a8c;line-height:1.65">结果页学名旁的「<b>GBIF·DS</b>」小标用它：先向 GBIF 取真实记录，再让 DeepSeek 配中文名、写归纳。${
      has ? '密钥已保存，可以直接用；下面留空表示不修改。' : '还没有填：去 platform.deepseek.com 申请一个 API Key 填进来。'
    }</div>
    <div class="field"><label>API Key</label>
      <input type="password" data-gds-key="apiKey" value="" autocomplete="off" spellcheck="false"
        placeholder="${has ? '已加密保存，不回显 · 留空则保持不变' : 'sk-…'}"></div>
    <div class="field"><label>模型</label>
      <input data-gds-key="model" value="${esc(d.model || '')}" autocomplete="off" spellcheck="false"
        placeholder="deepseek-chat（留空即默认）"></div>
    ${
      has
        ? '<div style="font-size:11.5px;color:#8a97a0">不想用了可以清掉：<a href="#" id="gds-clear" style="color:#a33">清除已保存的 Key</a></div>'
        : ''
    }
  </div>`;
}

/** 设置弹层底部的版本信息 */
function aboutBlock() {  const v = state.app?.version || '—';
  const mode =
    state.app?.mode === 'exe' ? '单文件 exe' : state.app?.mode === 'bundle' ? 'macOS 目录版' : '源码模式';
  const link = state.app?.updateConfigured
    ? '<a href="#" id="link-check" style="color:#0f766e">检查更新</a>'
    : '<span style="color:#9aa7b4">未配置更新源</span>';
  return `<div class="site-block"><h4>关于 <span class="badge gray">${esc(mode)}</span></h4>
    <div style="font-size:12px;color:#6b7a8c">当前版本 v${esc(v)} · ${link}</div></div>`;
}

async function saveConfig() {
  const sites = {};
  $('config-body')
    .querySelectorAll('input,select')
    .forEach((el) => {
      const k = el.dataset.site;
      if (!k) return;
      // 密码 / 密钥留空 = 不修改，避免把已加密保存的那份覆盖掉
      if ((el.dataset.secret === '1' || el.dataset.key === 'password') && !el.value) return;
      sites[k] = sites[k] || {};
      // 用户名：界面统一显示 DISPLAY_USERNAME，没改动就沿用真实登录名，改过才用新输入
      if (el.dataset.key === 'username' && el.dataset.real !== undefined) {
        sites[k].username = el.value === DISPLAY_USERNAME ? el.dataset.real : el.value;
      } else {
        sites[k][el.dataset.key] = el.value;
      }
    });

  // DeepSeek 的 key 不在 sites 里（它不是识别站点），单独收
  const deepseek = {};
  $('config-body')
    .querySelectorAll('input[data-gds-key]')
    .forEach((el) => {
      const v = el.value.trim();
      if (el.dataset.gdsKey === 'apiKey' && !v) return; // 留空 = 不改
      deepseek[el.dataset.gdsKey] = v;
    });

  const saved = await fetch('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sites, deepseek }),
  }).then((r) => r.json());
  if (saved.deepseek) state.deepseek = saved.deepseek;
  // 重新渲染：密码框回到「已加密保存」状态，不再保留刚输入的明文
  renderConfig(saved.config || {});
  toast('已保存，正在登录…');
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ site: 'all' }),
  });
  const j = await r.json();
  applySiteStates(j.sites);
  const failed = Object.entries(j.login || {}).filter(([, v]) => !v.ok);
  if (failed.length) toast('登录失败：' + failed.map(([k, v]) => `${siteLabel(k)} ${v.error}`).join('；'));
  else toast('全部站点就绪');
}

/* ---------------- 自然在线验证码登录 ---------------- */

let xsCaptchaKey = '';

/** 只保存自然在线的账号密码（还没点「保存并登录」时也能先登录） */
async function saveXingseFields() {
  const sites = { xingse: {} };
  $('config-body')
    .querySelectorAll('input[data-site="xingse"]')
    .forEach((el) => {
      if (el.dataset.key === 'password' && !el.value) return;
      // 用户名同 saveConfig：显示名不动就沿用真实登录名
      if (el.dataset.key === 'username' && el.dataset.real !== undefined) {
        sites.xingse.username = el.value === DISPLAY_USERNAME ? el.dataset.real : el.value;
        return;
      }
      sites.xingse[el.dataset.key] = el.value;
    });
  if (!Object.keys(sites.xingse).length) return true;
  const r = await fetch('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sites }),
  }).then((r) => r.json());
  return !!r.ok;
}

async function fetchXingseCaptcha() {
  const box = $('xs-cap-box');
  const img = $('xs-cap-img');
  if (!box || !img) return;
  img.removeAttribute('src');
  try {
    // 先把账号密码落盘，否则服务端拿不到
    await saveXingseFields();
    const j = await fetch('/api/xingse/captcha').then((r) => r.json());
    if (!j.image) {
      toast('验证码获取失败：' + (j.error || '未知原因'));
      return;
    }
    xsCaptchaKey = j.key;
    img.src = j.image;
    box.hidden = false;
    $('xs-cap-code')?.focus();
  } catch (err) {
    toast('验证码获取失败：' + err.message);
  }
}

async function submitXingseLogin() {
  const code = ($('xs-cap-code')?.value || '').trim();
  if (!code) return toast('请先填写验证码');
  if (!xsCaptchaKey) return toast('请先点「获取验证码」');
  const btn = $('xs-cap-do');
  if (btn) btn.disabled = true;
  try {
    const j = await fetch('/api/xingse/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ captcha: code, key: xsCaptchaKey }),
    }).then((r) => r.json());
    if (!j.ok) {
      toast('自然在线登录失败：' + (j.error || '验证码可能不对'));
      fetchXingseCaptcha(); // 换一张
      return;
    }
    applySiteStates(j.sites);
    const st = await fetch('/api/status').then((r) => r.json());
    renderConfig(st.config || {});
    toast('自然在线登录成功，令牌已加密保存');
  } finally {
    const b = $('xs-cap-do');
    if (b) b.disabled = false;
  }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#xs-cap-get')) {
    e.preventDefault();
    fetchXingseCaptcha();
  } else if (e.target.closest('#xs-cap-do')) {
    e.preventDefault();
    submitXingseLogin();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'xs-cap-code') {
    e.preventDefault();
    submitXingseLogin();
  }
});

/* ---------------- 自然在线（站点键 xingse） ---------------- */

/**
 * 自然在线（站点键仍是 xingse，改的只是显示名）对所有人生效：站点清单里一直有它，
 * 归在「植物」组，跟动物类群互斥；点它会自动切到植物、关掉动物那组。
 * 识别前要先在「账号设置」里过一次图片验证码登录，令牌加密存在本地。
 */

document.addEventListener('keydown', (e) => {
  // Esc 先关大图
  if (e.key === 'Escape' && viewOpen()) {
    e.preventDefault();
    closeViewer();
    return;
  }
  if (e.key === 'Escape' && $('region-modal')?.classList.contains('show')) {
    $('region-modal').classList.remove('show');
  }
});

/** 清掉已保存的 DeepSeek key（换成自己的号、或者不想再用） */
async function clearDeepseekKey() {
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deepseek: { clear: true } }),
    }).then((x) => x.json());
    if (r.deepseek) state.deepseek = r.deepseek;
    renderConfig(r.config || {});
    toast('已清除 DeepSeek API Key');
  } catch (err) {
    toast('清除失败：' + err.message);
  }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#gds-clear')) {
    e.preventDefault();
    clearDeepseekKey();
  }
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'gds-close' || e.target.id === 'gds-modal') {
    $('gds-modal').classList.remove('show');
    // 关掉就把序号推进一格，还在路上的那份结果回来时会被丢掉
    gdsSeq++;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('gds-modal')?.classList.contains('show')) {
    $('gds-modal').classList.remove('show');
    gdsSeq++;
  }
});

 /* ---------------- 问题反馈 ---------------- */

 /** 顶栏那个小按钮：打开「问题反馈」，指向项目仓库的 Issues 页 */
function openAuthor() {
  $('author-modal').classList.add('show');
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#btn-author')) {
    e.preventDefault();
    openAuthor();
    return;
  }
  if (e.target.id === 'author-close' || e.target.id === 'author-modal') {
    $('author-modal').classList.remove('show');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('author-modal')?.classList.contains('show')) {
    $('author-modal').classList.remove('show');
  }
});

/* ---------------- 事件绑定 ---------------- */

$('dropzone').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});

['dragenter', 'dragover'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    $('dropzone').classList.add('hover');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget) return;
    $('dropzone').classList.remove('hover');
  }),
);
window.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});
window.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const files = items.filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) addFiles(files);
});

$('btn-retry').addEventListener('click', () => {
  const item = currentItem();
  if (!item) return;
  item.status = 'pending';
  item.resp = null;
  item.error = '';
  delete state.ebird[item.id];
  renderQueue();
  pump();
});
$('btn-del').addEventListener('click', () => {
  const item = currentItem();
  if (!item) return;
  deleteItem(item.id);
});
$('btn-view').addEventListener('click', () => openViewer(currentItem()));
$('btn-copy').addEventListener('click', async () => {
  const item = currentItem();
  if (!item?.resp) return toast('还没有结果');
  const b = item.resp.aggregate.best;
  const text = `${item.resp.aggregate.verdict}${b ? `\n学名：${b.latin}` : ''}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('复制失败，请手动选择');
  }
});
$('btn-csv').addEventListener('click', exportOne);
$('btn-csv-all').addEventListener('click', exportAll);
$('btn-settings').addEventListener('click', () => {
  // 每次打开都按最新配置重绘（eBird 地区可能刚在选择器里改过）
  renderConfig(state.config || {});
  $('modal').classList.add('show');
});
// 点标题旁的版本号 = 手动查一次更新
$('app-ver').addEventListener('click', async () => {
  if (!state.app?.updateConfigured) {
    toast(`当前 v${state.app?.version || '?'} · 未配置更新源`);
    return;
  }
  toast('正在检查更新…');
  const found = await checkUpdate(true);
  if (!found) toast(`已是最新版本 v${state.app?.version || ''}`);
});
$('btn-close').addEventListener('click', () => $('modal').classList.remove('show'));
$('btn-save').addEventListener('click', saveConfig);
$('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') $('modal').classList.remove('show');
});
$('modal').addEventListener('click', async (e) => {
  if (e.target.id !== 'link-check') return;
  e.preventDefault();
  toast('正在检查更新…');
  const found = await checkUpdate(true);
  if (!found) toast(`已是最新版本 v${state.app?.version || ''}`);
  // 有新版就直接把弹层收掉，把注意力交给顶部提示条
  if (found) $('modal').classList.remove('show');
});

/* ---------------- 启动 ---------------- */

(async () => {
  bindPickerOps();
  bindRegionModal();
  bindInatBar();
  bindImageBridge();
  await loadStatus().catch(() => toast('无法连接本地服务'));
  renderCopyMode();
  // 地址栏带了 ?img= 就自动把那张图拉进来（物种标注工坊跳过来时用）
  await openFromUrl();
})();

// 点击物种名复制：一次委托挂在 document 上，重绘不用重新绑定
document.addEventListener('click', (e) => {
  // 学名旁边的「iNat」是个链接：别被复制逻辑 preventDefault 掉
  if (e.target.closest('a')) return;
  const el = e.target.closest('[data-copy]');
  if (!el) return;
  // 用户正在拖选文字时不抢这一下，否则没法选中
  const sel = window.getSelection();
  if (sel && String(sel).trim()) return;
  e.preventDefault();
  copyText(el.dataset.copy);
});

/* ---------------- 自动更新 ---------------- */

const SKIP_KEY = 'bioSkipVersion';
let upd = { info: null, busy: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1048576).toFixed(1);

function barShow(cls, text, note = '', goLabel = '') {
  const bar = $('update-bar');
  bar.hidden = false;
  bar.className = `update-bar ${cls}`.trim();
  $('ub-text').textContent = text;
  $('ub-notes').textContent = note || '';
  const go = $('ub-go');
  go.hidden = !goLabel;
  if (goLabel) go.textContent = goLabel;
}

function barHide() {
  $('update-bar').hidden = true;
}

async function checkUpdate(force = false) {
  if (!state.app?.updateConfigured) return false;
  let r = null;
  try {
    r = await fetch(`/api/update/check${force ? '?force=1' : ''}`).then((x) => x.json());
  } catch {
    return false;
  }
  if (!r || !r.ok || !r.hasUpdate) return false;
  upd.info = r;
  // 标题旁的版本号跟着变成橙色，一眼能看出「该更新了」，即使点了「稍后再说」也保留
  markVersionOld(r.latest);
  // 用户点过「稍后再说」的版本，启动时不再弹，但手动检查仍然要给出来
  if (!force && localStorage.getItem(SKIP_KEY) === r.latest) return true;

  renderUpdatePrompt(r);
  return true;
}

function renderUpdatePrompt(r) {
  const size = r.size ? ` · ${mb(r.size)} MB` : '';
  const notes = (r.notes || '').replace(/\s+/g, ' ').trim();
  if (upd.busy) return;
  // 不可写目录的提示分平台说：Windows 是 Program Files，mac 是「应用程序」文件夹
  const moveTip =
    state.app?.mode === 'bundle'
      ? '程序可能在「应用程序」文件夹里，把整个文件夹移到桌面或用户目录后重开'
      : '程序可能在 Program Files 等不可写目录，请移到 D 盘或用户目录后重开';

  if (!r.ready) {
    if (r.supported && r.canApply === false) {
      barShow('failed', `发现新版本 v${r.latest}，但这台机器上无法自动更新`, moveTip, '');
    } else {
      barShow('', `发现新版本 v${r.latest}（当前 v${r.current}）${size}`, notes, '立即更新');
    }
  } else if (!r.canApply) {
    barShow('failed', `新版 v${r.latest} 已下载，但程序目录不可写`, moveTip, '重试');
  } else {
    barShow('', `新版 v${r.latest} 已就绪`, '重启后即生效，正在识别时请稍后', '重启并更新');
  }
  $('ub-close').hidden = false;
}

async function pollProgress() {
  try {
    const p = await fetch('/api/update/progress').then((r) => r.json());
    if (p.phase === 'downloading') {
      const text = p.total
        ? `正在下载新版 ${mb(p.received)} / ${mb(p.total)} MB`
        : `正在下载新版 ${mb(p.received)} MB`;
      $('ub-text').textContent = text;
    }
  } catch {
    /* 服务可能正忙，下一次再问 */
  }
}

async function runUpdate() {
  if (upd.busy || !upd.info) return;
  upd.busy = true;
  $('ub-close').hidden = true;

  try {
    if (!upd.info.ready) {
      barShow('working', '正在下载新版…', '下载期间可以继续识别，不影响使用');
      const timer = setInterval(pollProgress, 500);
      let res;
      try {
        res = await fetch('/api/update/download', { method: 'POST' }).then((r) => r.json());
      } finally {
        clearInterval(timer);
      }
      if (!res?.ok) throw new Error(res?.error || '下载失败');
    }

    barShow('working', '正在替换程序并重启…', '大约需要几秒，请不要关闭窗口');
    let res2 = null;
    try {
      res2 = await fetch('/api/update/apply', { method: 'POST' }).then((r) => r.json());
    } catch {
      /* 服务可能已经先退出了，交给下面的探测判断 */
    }
    if (res2 && res2.ok === false) throw new Error(res2.error || '替换失败');

    barShow('done', '更新完成，正在重新加载…', '');
    await waitForRestart();
  } catch (err) {
    upd.busy = false;
    barShow('failed', '更新没成功', err.message || '未知错误', '重试');
    $('ub-close').hidden = false;
  }
}

/** 等新进程把端口接回来，并且版本号确实变了，再刷新页面 */
async function waitForRestart() {
  const before = upd.info?.current || state.app?.version || '';
  await sleep(1200); // 先让老进程退干净
  for (let i = 0; i < 90; i += 1) {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        const v = d?.app?.version || '';
        if (v && v !== before) {
          location.reload();
          return;
        }
      }
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(400);
  }
  barShow('failed', '新版本已装好，但服务没有自动恢复', '请手动重新打开程序', '');
}

$('ub-go').addEventListener('click', runUpdate);
$('ub-close').addEventListener('click', () => {
  if (upd.info?.latest) localStorage.setItem(SKIP_KEY, upd.info.latest);
  barHide();
});

// 页面起来后安静地查一次，不打扰
setTimeout(() => checkUpdate(false), 1500);
