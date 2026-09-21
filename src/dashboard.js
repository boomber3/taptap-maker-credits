/**
 * 积分消耗仪表盘。
 *
 * 数据直接从 chrome.storage.local 读（仪表盘是扩展自己的页面，没有跨域问题），
 * 只有「刷新」这一个动作需要走后台上报。
 *
 * 配色规则：颜色跟着项目走，不跟着排名走。项目在「全部历史消耗」里的名次决定
 * 它拿哪个槽位，切换时间范围只会改变哪些线出现在图上，不会给留下的线换颜色。
 */

import { renderLineChart } from './chart.js';
import { KINDS, dayKey, recentDayKeys, formatCompact, formatExact, formatDayLabel, SYNC_STALE_MS } from './util.js';

const SERIES_VARS = [
  '--series-1', '--series-2', '--series-3', '--series-4',
  '--series-5', '--series-6', '--series-7', '--series-8',
];
/**
 * 同时最多画几条项目曲线。
 *
 * 调色板只有 8 个经过校验的色相，而且规范要求折线取色「连续分配、不得跳号」——
 * 相邻两色可辨这个保证只对连续取用成立。跳着取（第 2 个和第 4 个）会得到一对
 * 没被验证过的颜色，色盲视角下可能糊在一起。所以上限是 8，不是配色不够用，
 * 是再多就没法保证读得清。
 */
const MAX_SERIES = 8;

/** 分类配色：按顺序取色槽。实际用色在筛选之后再连续分配（见 render） */
const KIND_COLORS = new Map(KINDS.map((k, i) => [k.id, `var(--series-${i + 1})`]));

/**
 * 同一份页面有三种宿主，行为略有差别：
 *   独立标签页           —— 什么都没带
 *   面板里的仪表盘        embed=1
 *   面板的放大浮层        embed=1&overlay=1（面板里点「放大」时另起的那一层）
 */
const PAGE_PARAMS = new URLSearchParams(location.search);
const IS_EMBEDDED = PAGE_PARAMS.has('embed');
const IS_OVERLAY = PAGE_PARAMS.has('overlay');

const RANGE_LABEL = {
  today: '今日消耗',
  yesterday: '昨日收益', // 只在广告收益那页出现
  7: '近 7 天消耗',
  30: '近 30 天消耗',
  90: '近 90 天消耗',
  all: '全部消耗',
};

const state = {
  data: null,
  tab: 'credits', // 'credits' | 'data'
  // 开发者后台那一路。和上面那份完全独立，各存各的键。
  devApps: null,
  devAppsError: null,
  devPick: null,
  devStats: null,
  adStats: null, // 广告收益 —— 独立的一份，区间和上面那页不是同一套
  range: 'today',
  selected: null, // 项目对比里勾选了哪些项目（跟随时间范围重算）
  selectionRange: null, // 当前这套勾选是按哪个时间范围算出来的
  selectionDirty: false, // 用户在这一屏手动改过勾选
  pickerExpanded: false, // 项目选择器里未勾选的那些是否展开
  charts: null, // 两张图当前的配置，放大浮层直接复用
};

/** 默认画当前时段消耗最高的几条（上限仍是调色板能分辨的 8 条） */
const DEFAULT_SELECTED = 7;

const $ = (id) => document.getElementById(id);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// ------------------------------------------------------------------ 主题

/**
 * 不再单独切换深浅色。
 *
 *   - 嵌在站点页面的面板里时跟随站点：站点用 <html class="dark"> 自己管主题，
 *     由 panel.js 读到之后用 ?theme= 或 postMessage 传进来 —— iframe 跨源，
 *     这里读不到父页面的 class
 *   - 独立打开仪表盘页时跟随系统（媒体查询）
 */
function applyTheme() {
  const forced = PAGE_PARAMS.get('theme');
  if (forced === 'dark' || forced === 'light') {
    document.documentElement.setAttribute('data-theme', forced);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

/** 和外层（面板）之间的消息 */
function listenHostMessages() {
  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data) return;

    if (data.type === 'ttm-collapse') {
      if (modalState.config) closeModal();
      return;
    }

    // 浮层被重新打开时会让我们把弹窗再开一遍 —— 上次关闭已经把它拆掉了，
    // 不重开的话第二次进来只有一份没有弹窗的仪表盘。
    if (data.type === 'ttm-open' && IS_OVERLAY && !modalState.config) {
      openFromState(data.chart || 'trend');
    }

    // 嵌在面板里时，视图切换在面板顶栏上（那边是 Shadow DOM，改不了这里），
    // 它按下的档位从这里切。独立标签页没有顶栏，用的是页面自己那排标签。
    if (data.type === 'ttm-tab') {
      switchTab(data.tab);
      if (data.tab !== 'credits') loadDevApps().then(() => refreshActiveView());
    }
  });
}

/** 站点主题变了会推过来，切换后必须重画图表（描边和圆点用的是表面色，绘制时取的） */
function listenThemePush() {
  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data || data.type !== 'ttm-theme') return;
    if (data.theme !== 'dark' && data.theme !== 'light') return;
    document.documentElement.setAttribute('data-theme', data.theme);
    render();
  });
}

// ------------------------------------------------------------------ 数据

async function load() {
  const raw = await chrome.storage.local.get([
    'auth',
    'sync',
    'projects',
    'daily',
    'hourly',
    'kindDaily',
    'kindHourly',
    'activeProjectIds',
    // 开发者后台那一路
    'devApps',
    'devPick',
    'devStats',
    'adStats',
  ]);
  state.devApps = (raw.devApps && raw.devApps.list) || null;
  state.devAppsError = (raw.devApps && raw.devApps.error) || null;
  state.devPick = raw.devPick || null;

  // 存储里那份数据必须是**当前选中的应用**的。换了应用还没拉回来时，
  // 存储里躺着的仍是上一个应用的数字 —— 直接拿来显示就等于张冠李戴。
  // 这里当场判掉，界面会退回空态去等新数据。
  const wantApp = (raw.devApps && raw.devApps.list || []).find(
    (a) => String(a.id) === String(raw.devPick),
  ) || (raw.devApps && raw.devApps.list || [])[0];
  const st = raw.devStats || null;
  state.devStats = st && wantApp && String(st.appId) === String(wantApp.id) ? st : null;
  // 等的那份到货了就撤掉加载态（成功和失败都算到货）。
  // 第三个参数是「真的进 state 了没」—— 存储里有一份但被上面那个守卫挡掉的话，
  // 收工就只剩一根横线。
  settleDev('dev', st, state.devStats !== null);

  const ad = raw.adStats || null;
  state.adStats = ad && wantApp && String(ad.appId) === String(wantApp.id) ? ad : null;
  settleDev('ad', ad, state.adStats !== null);
  state.data = {
    auth: raw.auth || null,
    sync: raw.sync || {},
    projects: raw.projects || {},
    daily: raw.daily || {},
    hourly: raw.hourly || {},
    kindDaily: raw.kindDaily || {},
    kindHourly: raw.kindHourly || {},
    activeProjectIds: Array.isArray(raw.activeProjectIds) ? raw.activeProjectIds : null,
  };
  render();
}

/**
 * 和后台用**同一个**超时口径，从 util.js 取 —— 各写各的迟早对不上，
 * 之前就是界面按 3 分钟判死、后台按 5 分钟拦着。
 */
function isSyncing(sync) {
  return Boolean(sync.running) && Date.now() - (sync.runningSince || 0) < SYNC_STALE_MS;
}

function renderStatus() {
  const { sync, auth } = state.data;
  const el = $('status-line');
  el.classList.toggle('is-error', false);

  if (!auth || !auth.accessToken) {
    el.textContent = '还没拿到登录态 —— 请先打开 maker.taptap.cn 登录一次';
    el.classList.add('is-error');
    return;
  }
  if (sync.running && !isSyncing(sync)) {
    el.textContent = '上次同步被中断了，点旁边的 ↻ 重新开始';
    el.classList.add('is-error');
    return;
  }
  if (isSyncing(sync)) {
    const p = sync.progress;
    if (p && p.phase === 'backfill' && p.total) {
      el.textContent = `首次同步中：已读取 ${formatExact(p.done)} / ${formatExact(p.total)} 条流水，请稍候…`;
    } else if (p && p.phase === 'incremental') {
      el.textContent = '正在同步新记录…';
    } else {
      el.textContent = '正在同步…';
    }
    return;
  }
  if (sync.lastError) {
    el.textContent = `同步失败：${sync.lastError.message}`;
    el.classList.add('is-error');
    return;
  }
  const when = sync.lastSyncAt
    ? new Date(sync.lastSyncAt).toLocaleString('zh-CN', { hour12: false })
    : '尚未同步';
  const who = auth.user && auth.user.name ? ` · ${auth.user.name}` : '';
  el.textContent = `上次同步 ${when}${who}`;
}

/** 首次使用最容易卡在「没登录」，这里给一条能直接点的路，而不是只留一句话 */
function renderNotice() {
  const el = $('notice');
  el.textContent = '';
  el.hidden = true;

  if (state.data.auth && state.data.auth.accessToken) return;

  el.hidden = false;

  const title = document.createElement('p');
  title.className = 'notice-title';
  title.textContent = '还差一步：让扩展拿到登录状态';

  const body = document.createElement('p');
  body.textContent =
    '扩展通过你在 TapTap 制造的登录状态读取积分流水。它不代替你做任何操作，也不把数据发往任何地方。';

  const steps = document.createElement('ol');
  for (const text of [
    '点下面的按钮打开 maker.taptap.cn（会新开一个标签页）',
    '如果显示未登录，登录一次',
    '登录成功后回到本页 —— 扩展会自动开始同步',
  ]) {
    const li = document.createElement('li');
    li.textContent = text;
    steps.append(li);
  }

  const link = document.createElement('a');
  link.className = 'primary-btn';
  link.href = 'https://maker.taptap.cn/credits';
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = '打开 maker.taptap.cn';

  el.append(title, body, steps, link);
}

// -------------------------------------------------------------- 视图切片

function buildView(range) {
  const { daily, hourly } = state.data;

  if (range === 'today') {
    const today = dayKey(new Date());
    const hours = hourly[today] || {};
    // 只画到当前小时。若把还没走到的小时也补成 0，图尾会出现一段假的暴跌，
    // 看上去像「今天后面几乎不烧了」，其实只是还没到。
    const slots = new Date().getHours() + 1;
    const byProject = new Map();

    for (let h = 0; h < slots; h += 1) {
      const bucket = hours[String(h)] || {};
      for (const pid in bucket) {
        if (!byProject.has(pid)) byProject.set(pid, new Array(slots).fill(0));
        byProject.get(pid)[h] += bucket[pid];
      }
    }

    return {
      unit: 'hour',
      keys: [today],
      byProject,
      slotCount: slots,
      xLabels: Array.from({ length: slots }, (_, h) => String(h)),
      xFull: Array.from(
        { length: slots },
        (_, h) => `${formatDayLabel(today)} ${String(h).padStart(2, '0')}:00`,
      ),
    };
  }

  const keys = range === 'all' ? Object.keys(daily).sort() : recentDayKeys(Number(range));
  const byProject = new Map();

  keys.forEach((key, i) => {
    const bucket = daily[key] || {};
    for (const pid in bucket) {
      if (!byProject.has(pid)) byProject.set(pid, new Array(keys.length).fill(0));
      byProject.get(pid)[i] += bucket[pid];
    }
  });

  return {
    unit: 'day',
    keys,
    byProject,
    slotCount: keys.length,
    xLabels: keys.map((k) => {
      const [, m, d] = k.split('-');
      return `${Number(m)}/${Number(d)}`;
    }),
    xFull: keys.map(formatDayLabel),
  };
}

function viewTotal(view) {
  let total = 0;
  for (const values of view.byProject.values()) total += sum(values);
  return total;
}

/**
 * 项目是否已被删除。
 *
 * 删掉项目不会删掉它的历史流水，账本里那些记录还在，所以光看流水永远分不出
 * 哪些项目还活着 —— 必须拿 /api/v1/apps 返回的「现存清单」反过来判定。
 * 清单还没拉到（或接口失败）时一律当作未删除：宁可多显示，不可误藏。
 */
function isDeleted(pid) {
  if (pid === '__unknown__') return false; // 流水没关联到项目，不是「项目被删了」
  return hasProjectList() && !state.data.activeProjectIds.includes(pid);
}

function hasProjectList() {
  const active = state.data.activeProjectIds;
  return Array.isArray(active) && active.length > 0;
}

/**
 * 当前时段内各项目的消耗排名。
 *
 * 项目对比的默认勾选、选择器排序、取色顺序全都跟着它走 ——
 * 要看的是「这段时间烧得最多的是谁」，而不是「历史上累计最多的是谁」。
 * 一个刚开工猛烧的新项目，历史排名可能很靠后，用历史排名根本进不了默认视图。
 */
function rangeRanked(view) {
  return [...view.byProject.entries()]
    .map(([pid, values]) => [pid, sum(values)])
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([pid]) => pid);
}

/**
 * 选择器只列本时段真正有消耗的、且还在的项目。
 *
 * 两类都要排除：
 *   - 本时段 0 消耗的：列出来只会撑长选择器，还得让人自己一个个排除
 *   - 已经删除的：删掉项目不会删掉它的历史流水，不主动过滤就会一直冒出来
 */
function pickerOrder(view) {
  const ids = rangeRanked(view).filter((pid) => !isDeleted(pid));
  return { pickerIds: ids, inRangeIds: ids };
}

/**
 * 勾选 = 当前时段前 N 高，切换时间范围时重算（这是刻意的：换一段就该看那一段的头部）。
 * 手动调过就保留到切走为止 —— 不然每次同步刷新都会把你的调整冲掉。
 */
function ensureSelection(pickerIds, inRangeIds) {
  const sameRange = state.selectionRange === state.range;
  const keepManual = sameRange && state.selected && (state.selected.size > 0 || state.selectionDirty);

  if (keepManual) {
    // 清掉已经不在候选里的（项目被删、或清单变了）
    for (const pid of [...state.selected]) {
      if (!pickerIds.includes(pid)) state.selected.delete(pid);
    }
    return;
  }

  state.selected = new Set(inRangeIds.slice(0, DEFAULT_SELECTED));
  state.selectionRange = state.range;
  state.selectionDirty = false;
}

/** 只给「当前要画的」按历史排名连续分配槽位，不跳号 */
function colorSlots(shownIds) {
  return new Map(shownIds.map((pid, i) => [pid, `var(${SERIES_VARS[i]})`]));
}

function projectName(pid) {
  if (pid === '__unknown__') return '未关联项目';
  return state.data.projects[pid] || '未知项目';
}

function projectSeries(view, shownIds, colors) {
  return shownIds.map((pid) => ({
    id: pid,
    name: projectName(pid),
    color: colors.get(pid),
    // 勾了但这段区间确实没消耗，就保留一条贴着 0 的线 —— 那本身也是信息
    values: view.byProject.get(pid) || new Array(view.slotCount).fill(0),
  }));
}

function totalSeries(view) {
  const values = new Array(view.slotCount).fill(0);
  for (const v of view.byProject.values()) v.forEach((x, i) => { values[i] += x; });
  return [{ id: '__total__', name: '总消耗', color: 'var(--series-1)', values }];
}

/** 上一个等长周期的消耗，用来算涨跌；「全部」没有可比区间 */
function previousTotal(range) {
  const { daily } = state.data;
  if (range === 'all') return null;

  const dayTotal = (key) => sum(Object.values(daily[key] || {}));

  if (range === 'today') {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    return dayTotal(dayKey(y));
  }

  const n = Number(range);
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  let total = 0;
  for (let i = 2 * n - 1; i >= n; i -= 1) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    total += dayTotal(dayKey(d));
  }
  return total;
}

// ------------------------------------------------------------------ 渲染

/**
 * 各消耗类型在这段时间里的逐格数值。
 * 类型桶和项目桶是同一批流水算出来的，所以各类型加起来恰好等于总消耗。
 */
function kindSeries(view) {
  const byKind = new Map();
  const push = (kind, i, amount) => {
    if (!byKind.has(kind)) byKind.set(kind, new Array(view.slotCount).fill(0));
    byKind.get(kind)[i] += amount;
  };

  if (view.unit === 'hour') {
    const hours = (state.data.kindHourly || {})[view.keys[0]] || {};
    for (let h = 0; h < view.slotCount; h += 1) {
      const bucket = hours[String(h)] || {};
      for (const kind in bucket) push(kind, h, bucket[kind]);
    }
  } else {
    view.keys.forEach((day, i) => {
      const bucket = (state.data.kindDaily || {})[day] || {};
      for (const kind in bucket) push(kind, i, bucket[kind]);
    });
  }
  return byKind;
}

/** 分类合计 + 一条占比条 */
function renderKindCard(view) {
  const byKind = kindSeries(view);
  const totals = KINDS.map((k) => ({ ...k, total: sum(byKind.get(k.id) || []) }));
  const grand = totals.reduce((acc, k) => acc + k.total, 0);

  const row = $('kind-row');
  row.textContent = '';
  const bar = $('kind-bar');
  bar.textContent = '';

  $('kind-sub').textContent = grand > 0 ? `合计 ${formatExact(grand)} 积分` : '这段时间还没有消耗';

  for (const kind of totals) {
    // 这段时间没消耗的分类不占位置
    if (kind.total === 0) continue;

    const box = document.createElement('div');
    box.className = 'kind-item';

    const label = document.createElement('p');
    label.className = 'sub-label';
    const key = document.createElement('span');
    key.className = 'kind-key';
    key.style.setProperty('--c', KIND_COLORS.get(kind.id));
    const name = document.createElement('span');
    name.textContent = kind.name;
    label.append(key, name);

    const value = document.createElement('p');
    value.className = 'sub-value';
    value.textContent = statText(kind.total);
    value.title = `${formatExact(kind.total)} 积分`;

    const share = document.createElement('p');
    share.className = 'sub-note';
    share.textContent = `占 ${((kind.total / grand) * 100).toFixed(1)}%`;

    box.append(label, value, share);
    row.append(box);
  }

  // 占比条：段间留 2px 表面色缝隙，靠留白分隔而不是描边
  if (grand > 0) {
    for (const kind of totals) {
      if (kind.total === 0) continue;
      const seg = document.createElement('div');
      seg.className = 'kind-seg';
      seg.style.setProperty('--c', KIND_COLORS.get(kind.id));
      seg.style.flexGrow = String(kind.total);
      seg.title = `${kind.name} ${formatExact(kind.total)}`;
      bar.append(seg);
    }
  }
}

/** 每个 X 位置上的消耗合计（小时视图就是每小时，天视图就是每天） */
function slotTotals(view) {
  const totals = new Array(view.slotCount).fill(0);
  for (const values of view.byProject.values()) {
    values.forEach((v, i) => { totals[i] += v; });
  }
  return totals;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 一行要塞三个指标，六位数往上改用「万」，免得在窄面板里撑破格子 */
const statText = (n) => (n >= 100000 ? formatCompact(n) : formatExact(n));

/**
 * 顶部卡片：区间消耗、当前小时、活跃项目 —— 三个指标并排一行。
 * 区间是「今天」时第一格就是今日消耗；换成别的区间，第一格跟着变成该区间的合计。
 */
function renderHero(view) {
  const host = $('hero-sub');
  host.textContent = '';

  const total = viewTotal(view);
  const totals = slotTotals(view);
  const hour = new Date().getHours();

  const metrics = [
    {
      label: RANGE_LABEL[state.range],
      value: statText(total),
      title: `${formatExact(total)} 积分`,
      lead: true,
      note: deltaNote(total, previousTotal(state.range)),
    },
    {
      label: '当前小时',
      value: statText(totals[hour] || 0),
      title: `${formatExact(totals[hour] || 0)} 积分`,
      note: `${pad2(hour)}:00 – ${pad2((hour + 1) % 24)}:00`,
    },
    {
      label: '活跃项目',
      value: String(view.byProject.size),
      title: `${view.byProject.size} 个项目在本时段有消耗`,
      note: `共记录 ${Object.keys(state.data.projects).length} 个项目`,
    },
  ];

  for (const metric of metrics) {
    const box = document.createElement('div');
    box.className = 'sub-item';

    const label = document.createElement('p');
    label.className = 'sub-label';
    label.textContent = metric.label;

    const value = document.createElement('p');
    value.className = metric.lead ? 'sub-value is-lead' : 'sub-value';
    value.title = metric.title || metric.value;
    value.textContent = metric.value;

    const note = document.createElement('p');
    note.className = 'sub-note';
    if (typeof metric.note === 'string') note.textContent = metric.note;
    else if (metric.note) note.append(metric.note);

    box.append(label, value, note);
    host.append(box);
  }
}

/** 「较昨日 ▼12.4%（94,511）」这一行；没有可比区间时说明原因 */
function deltaNote(total, prev) {
  if (prev == null) {
    const days = Object.keys(state.data.daily).length;
    return days ? `本地已记录 ${days} 天数据` : '';
  }
  if (prev === 0) return total > 0 ? '上一周期没有消耗，无从比较' : '这段时间没有消耗';

  const pct = ((total - prev) / prev) * 100;
  const frag = document.createDocumentFragment();
  frag.append(document.createTextNode(state.range === 'today' ? '较昨日 ' : '较上一周期 '));
  const arrow = document.createElement('span');
  arrow.className = pct >= 0 ? 'up' : 'down';
  arrow.textContent = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%`;
  frag.append(arrow, document.createTextNode(` （${formatExact(prev)}）`));
  return frag;
}

/** 图表下面剩下的两个指标：平均速度，以及区间里最费的那一格 */
function renderTiles(view) {
  const host = $('tiles');
  host.textContent = '';

  const total = viewTotal(view);
  const slots = view.unit === 'hour'
    ? view.slotCount
    : Math.max(1, view.keys.filter((k) => sum(Object.values(state.data.daily[k] || {})) > 0).length || 1);

  let peakIndex = -1;
  let peakValue = 0;
  slotTotals(view).forEach((v, i) => {
    if (v > peakValue) { peakValue = v; peakIndex = i; }
  });

  const tiles = [
    {
      label: view.unit === 'hour' ? '平均每小时' : '平均每天',
      value: formatExact(total / slots),
      sub: view.unit === 'hour' ? `按已过去的 ${slots} 小时计` : `按有消耗的 ${slots} 天计`,
    },
    {
      label: view.unit === 'hour' ? '最费的小时' : '最费的一天',
      value: peakIndex >= 0 ? formatExact(peakValue) : '—',
      sub: peakIndex >= 0 ? view.xFull[peakIndex] : '区间内没有消耗',
    },
  ];

  for (const tile of tiles) {
    const card = document.createElement('div');
    card.className = 'tile';

    const label = document.createElement('p');
    label.className = 'tile-label';
    label.textContent = tile.label;

    const value = document.createElement('p');
    value.className = 'tile-value';
    value.textContent = tile.value;

    const sub = document.createElement('p');
    sub.className = 'tile-sub';
    sub.textContent = tile.sub;

    card.append(label, value, sub);
    host.append(card);
  }
}

function renderTable(view, series) {
  const wrap = $('table-wrap');
  wrap.textContent = '';

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const text of ['时间', ...series.map((s) => s.name), '合计']) {
    const th = document.createElement('th');
    th.textContent = text;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  const columnTotals = new Array(series.length).fill(0);

  view.xFull.forEach((full, i) => {
    const tr = document.createElement('tr');
    const first = document.createElement('td');
    first.textContent = full;
    tr.append(first);

    let rowTotal = 0;
    series.forEach((s, k) => {
      const v = s.values[i];
      columnTotals[k] += v;
      rowTotal += v;
      const td = document.createElement('td');
      td.textContent = formatExact(v);
      tr.append(td);
    });

    const totalCell = document.createElement('td');
    totalCell.textContent = formatExact(rowTotal);
    tr.append(totalCell);
    tbody.append(tr);
  });

  const footRow = document.createElement('tr');
  const footLabel = document.createElement('td');
  footLabel.textContent = '合计';
  footRow.append(footLabel);

  let grand = 0;
  columnTotals.forEach((v) => {
    grand += v;
    const td = document.createElement('td');
    td.textContent = formatExact(v);
    footRow.append(td);
  });
  const grandCell = document.createElement('td');
  grandCell.textContent = formatExact(grand);
  footRow.append(grandCell);
  tbody.append(footRow);

  table.append(tbody);
  wrap.append(table);
}

/** 曲线选择器。它只作用于「项目对比」这一张图，所以放在这张图的卡片里 */
function renderProjectPicker(pickerIds, colors, rangeTotals) {
  const host = $('project-picker');
  host.textContent = '';

  const full = state.selected.size >= MAX_SERIES;

  // 未勾选的默认折叠起来 —— 项目一多，光选择器就能占掉半屏高。
  // 顺序仍是本时段消耗降序，展开只是把藏起来的那些就地露出来，不重排。
  const offIds = pickerIds.filter((pid) => !state.selected.has(pid));
  const shown = state.pickerExpanded ? pickerIds : pickerIds.filter((pid) => state.selected.has(pid));

  for (const pid of shown) {
    const on = state.selected.has(pid);
    const locked = !on && full;
    const total = rangeTotals.get(pid) || 0;

    const label = document.createElement('label');
    label.className = `pick${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}`;
    label.title = total > 0
      ? `本时段消耗 ${formatExact(total)} 积分`
      : '本时段没有消耗';
    if (locked) label.title += `（最多同时显示 ${MAX_SERIES} 条，先取消一条）`;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on;
    box.disabled = locked;
    box.addEventListener('change', () => {
      if (box.checked) state.selected.add(pid);
      else state.selected.delete(pid);
      state.selectionDirty = true; // 别让下一次同步刷新把这次调整冲掉
      render();
    });

    const key = document.createElement('span');
    key.className = 'pick-key';
    key.style.setProperty('--c', on ? colors.get(pid) : 'var(--baseline)');

    const name = document.createElement('span');
    name.textContent = projectName(pid); // 项目名来自接口，走 textContent

    label.append(box, key, name);
    host.append(label);
  }

  if (offIds.length) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'pick-toggle';
    toggle.setAttribute('aria-expanded', String(state.pickerExpanded));
    toggle.textContent = state.pickerExpanded ? '收起' : `展开其余 ${offIds.length} 个`;
    toggle.addEventListener('click', () => {
      state.pickerExpanded = !state.pickerExpanded;
      render();
    });
    host.append(toggle);
  }

}

function render() {
  if (!state.data) return;

  renderStatus();
  renderNotice();

  // 隐藏的那些面板整个跳过。
  // 这不只是省事：另外两页每拉一次都会写存储，存储一变就走到这里 ——
  // 要是不管可见性照画不误，用户在数据页每点一次应用，都会在背后
  // 把积分页的三张图和表格重画一遍。那正是「切什么都不跟手」的来源。
  // （各自还会再判一次自己的 hidden，这里是省掉最贵的那段。）
  if ($('pane-credits').hidden) {
    renderDev();
    renderAd();
    return;
  }

  const syncing = isSyncing(state.data.sync);
  $('sync-btn').disabled = syncing;
  $('sync-btn').classList.toggle('is-spinning', syncing);
  $('sync-btn').title = syncing ? '正在同步…' : '刷新';

  const view = buildView(state.range);

  // 已删除的项目默认不出现。它们的历史消耗仍然计入总量，
  // 所以留一个开关，需要跟总量对账时能翻出来。
  const { pickerIds, inRangeIds } = pickerOrder(view);
  ensureSelection(pickerIds, inRangeIds);

  // 顺序即取色顺序：本时段烧得最多的那条拿第一个颜色
  const shownIds = pickerIds.filter((pid) => state.selected.has(pid));
  const colors = colorSlots(shownIds);
  const projects = projectSeries(view, shownIds, colors);
  const rangeTotals = new Map([...view.byProject].map(([pid, values]) => [pid, sum(values)]));

  renderHero(view);
  renderTiles(view);
  renderKindCard(view);
  renderProjectPicker(pickerIds, colors, rangeTotals);

  $('trend-title').textContent = view.unit === 'hour' ? '今日逐小时消耗' : '每日消耗趋势';
  $('trend-sub').textContent = view.unit === 'hour'
    ? '按本地时间分桶，每小时计入该小时内的全部消耗'
    : `共 ${view.slotCount} 天，每天一格`;

  if (!pickerIds.length) {
    $('project-sub').textContent = '还没有项目消耗记录';
  } else {
    const parts = [`已选 ${shownIds.length} 个`, `共计 ${pickerIds.length} 个项目`];
    // 到上限时补一句 —— 不然被禁用的那些看着像坏了
    if (shownIds.length >= MAX_SERIES && pickerIds.length > MAX_SERIES) parts.push('已达上限');
    $('project-sub').textContent = parts.join(' · ');
  }

  // 放大浮层要用同一份配置，所以先攒成对象再交给渲染函数
  const trendConfig = {
    title: $('trend-title').textContent,
    sub: $('trend-sub').textContent,
    series: totalSeries(view),
    xLabels: view.xLabels,
    xFull: view.xFull,
  };
  const projectConfig = {
    title: '项目对比',
    sub: $('project-sub').textContent,
    series: projects,
    xLabels: view.xLabels,
    xFull: view.xFull,
  };

  // 只画这段时间真有消耗的分类；颜色在筛选之后再连续分配 ——
  // 跳着色槽会得到一对没被校验过的相邻色（橙和黄的组合就过不了可辨性下限）
  const kindTotals = kindSeries(view);
  const kindList = KINDS.filter((k) => sum(kindTotals.get(k.id) || []) > 0).map((k, i) => ({
    id: k.id,
    name: k.name,
    color: `var(--series-${i + 1})`,
    values: kindTotals.get(k.id),
  }));
  const kindConfig = {
    title: '各类型消耗趋势',
    sub: view.unit === 'hour' ? '按本地时间分桶，每小时一格' : `共 ${view.slotCount} 天，每天一格`,
    series: kindList,
    xLabels: view.xLabels,
    xFull: view.xFull,
  };

  state.charts = { trend: trendConfig, project: projectConfig, kind: kindConfig };
  $('kind-trend-sub').textContent = kindConfig.sub;

  renderLineChart($('kind-chart'), {
    ...kindConfig,
    height: 250,
    ariaLabel: '各类型消耗趋势折线图',
    emptyText: state.data.auth ? '这段时间还没有消耗记录' : '请先登录 maker.taptap.cn',
  });

  renderLineChart($('trend-chart'), {
    ...trendConfig,
    height: 250,
    ariaLabel: '积分消耗趋势折线图',
    emptyText: state.data.auth ? '这段时间还没有消耗记录' : '请先登录 maker.taptap.cn',
  });

  renderLineChart($('project-chart'), {
    ...projectConfig,
    height: 250,
    ariaLabel: '各项目消耗对比折线图',
    emptyText: state.data.auth ? '这段时间还没有项目消耗' : '请先登录 maker.taptap.cn',
  });

  if (!$('table-wrap').hidden) renderTable(view, projects);
  $('table-wrap').__last = { view, projects };

  // 另外两页跟着一起重画：存储变化（比如刚拉回来一份）也得反映过去，
  // 而它们自己在面板隐藏时是空转的。
  renderDev();
  renderAd();
}

// -------------------------------------------------------------- 放大查看

/**
 * 放大查看。
 *
 * 时间跨度大时曲线会挤成一团：给它更大的画布是一方面，**滚轮缩放时间轴**
 * 才是真正的解药 —— 点太密的时候，把时间范围收窄比把图放大有效得多。
 * 缩放以光标下的那个点为锚，缩到底就是全段。
 */
const modalState = { config: null, from: 0, to: 0, root: null };

const ZOOM_STEP = 1.25; // 滚轮一格缩放的比例
const MIN_ZOOM_POINTS = 3; // 最少留 3 个点，再少就看不出曲线形状了

function svgIcon(pathData) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
}

const ICON_EXPAND = 'M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM4 15h2v3h3v2H4v-5zm14 0h2v5h-5v-2h3v-3z';
const ICON_CLOSE = 'M18.3 5.71 12 12.01l-6.3-6.3-1.41 1.41 6.3 6.3-6.3 6.3 1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z';

function buildModal() {
  const root = document.createElement('div');
  root.className = 'chart-modal';
  root.id = 'chart-modal';

  const card = document.createElement('div');
  card.className = 'modal-card';

  // 单行标题栏：标题 · 提示 · 关闭。
  // 不放「还原」按钮 —— 滚轮一路缩回去就是全段，按钮纯占地方。
  const bar = document.createElement('div');
  bar.className = 'modal-bar';

  const title = document.createElement('p');
  title.className = 'modal-title';
  title.id = 'modal-title';

  const hint = document.createElement('p');
  hint.className = 'modal-hint';
  hint.id = 'modal-hint';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn modal-close';
  close.title = '关闭';
  close.setAttribute('aria-label', '关闭');
  close.append(svgIcon(ICON_CLOSE));
  close.addEventListener('click', closeModal);

  bar.append(title, hint, close);

  const chart = document.createElement('div');
  chart.className = 'modal-chart';
  chart.id = 'modal-chart';

  card.append(bar, chart);
  root.append(card);

  // 点浮层空白处也能关掉，但别误伤卡片内部
  root.addEventListener('click', (ev) => {
    if (ev.target === root) closeModal();
  });

  return root;
}

const MODAL_EXIT_MS = 150; // 与 CSS 里 .is-closing 的动画时长对齐
let closeTimer = 0;

function openModal(config) {
  modalState.config = config;
  modalState.from = 0;
  modalState.to = config.xLabels.length - 1;

  if (!modalState.root) modalState.root = buildModal();
  clearTimeout(closeTimer); // 上一轮退场动画还没播完就又打开了
  modalState.root.classList.remove('is-closing');

  document.body.append(modalState.root);
  document.body.classList.add('is-modal-open');
  // 浮层里这份自己就是弹窗，别再通知外层 —— 那会让外层重开一次，转成死循环
  if (!IS_OVERLAY) tellPanel(true);
  drawModal();
}

function closeModal() {
  const root = modalState.root;
  if (!root || root.classList.contains('is-closing')) return;

  modalState.config = null;
  tellPanel(false);

  // 等退场动画播完再拆节点。直接 remove 的话就是「啪」一下不见，很突兀。
  root.classList.add('is-closing');
  closeTimer = setTimeout(() => {
    document.body.classList.remove('is-modal-open');
    root.classList.remove('is-closing');
    root.remove();
  }, MODAL_EXIT_MS);
}

/**
 * 通知面板这一侧开关放大浮层。
 *
 * 面板里点「放大」时是让**外层另起一层**，面板本身一动不动 ——
 * 早先是把面板自己放大成弹窗，结果原来那张卡片被挪走又放回来，
 * 观感上就是「卡片消失又出现」。
 *
 * 顺带把正在看的图和区间带过去，浮层就能落在同一处，而不是回到默认视图。
 */
function tellPanel(on, chart) {
  if (window.parent === window) return;
  try {
    window.parent.postMessage({ type: 'ttm-expand', on, chart, range: state.range }, '*');
  } catch {
    // 不在面板里，或父页面不理我们，都不影响本地浮层
  }
}

function drawModal() {
  const { config, from, to } = modalState;
  if (!config) return;

  const total = config.xLabels.length;
  const slice = (arr) => arr.slice(from, to + 1);
  const zoomed = from > 0 || to < total - 1;

  $('modal-title').textContent = config.title;
  $('modal-hint').textContent = zoomed
    ? `已放大到 ${config.xFull[from]} ~ ${config.xFull[to]} · 滚轮继续缩放`
    : `${config.sub} · 滚轮缩放`;

  renderLineChart($('modal-chart'), {
    series: config.series.map((s) => ({ ...s, values: slice(s.values) })),
    xLabels: slice(config.xLabels),
    xFull: slice(config.xFull),
    ariaLabel: config.title,
    onZoom: (direction, index) => {
      const len = to - from + 1;
      const next = Math.max(
        MIN_ZOOM_POINTS,
        Math.min(total, Math.round(len * (direction > 0 ? 1 / ZOOM_STEP : ZOOM_STEP))),
      );
      if (next === len) return; // 已经到头了

      // 以光标下的那个点为锚：缩放前后它尽量停在原来的横向位置，
      // 否则放大时画面会往一头跑。
      const anchor = from + index;
      const ratio = len > 1 ? index / (len - 1) : 0;
      const start = Math.max(0, Math.min(total - next, Math.round(anchor - ratio * (next - 1))));

      modalState.from = start;
      modalState.to = start + next - 1;
      drawModal();
    },
  });
}

// -------------------------------------------------------------- 数据表现

/**
 * 第二个数据源：TapTap 开发者后台的商店数据。
 *
 * 界面上只有两条原则，都是因为它和积分是**两回事**：
 *   1. 它是另一个站点的另一套数据，和积分没有换算关系 —— 所以单独一页、不混排，
 *      页脚写明来源，免得被当成同一份账。
 *   2. 接口按「从哪天到哪天」取，没有「全部」的概念 —— 区间要换算成日期，
 *      「全部」得给个上限。
 */
/**
 * 区间 → 天数。
 *
 * **没有「全部」，而且 90 是上限**：曝光里那个「商店页浏览数」来自 pv 接口，
 * 它硬限制「查询日期跨度不能超过 90 天」—— 实测 365 天直接返回 400。
 * 而曝光和浏览是 `Promise.all` 一起取的，pv 一挂整个曝光就全空了，
 * 界面上表现为四项全变「—」。position 那个接口本身没有这个限制，
 * 但两个指标是一张卡里的，只能一起守 90 天。
 */
const DEV_RANGES = { today: 1, 7: 7, 30: 30, 90: 90 };

/**
 * 广告收益的区间：**没有「今天」，改成「昨天」**。
 *
 * 它是 T+1 的 —— 接口会返回今天这一行，但金额是空字符串（还没结算）。
 * 与其让「今天」永远是一档空态，不如直接给一档「昨天」，
 * 每一档都是已结算的完整日。
 */
const AD_RANGES = { yesterday: 1, 7: 7, 30: 30, 90: 90 };

/** 每个面板各自的区间选项。页首那个控件跟着当前面板换。 */
const RANGE_SETS = {
  credits: ['today', '7', '30', '90', 'all'],
  data: ['today', '7', '30', '90'],
  ad: ['yesterday', '7', '30', '90'],
};

/** 区间 → [起, 止]，都是 YYYY-MM-DD。广告那页的终点是**昨天**。 */
function devDateRange(range, { ad = false } = {}) {
  const days = (ad ? AD_RANGES : DEV_RANGES)[range] || 7;
  const end = new Date();
  if (ad) end.setDate(end.getDate() - 1); // T+1：最近一个已结算的完整日是昨天
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return [dayKey(start), dayKey(end)];
}

/** 选中的是哪个应用。没选过就默认第一个，别让界面空着。 */
function currentDevApp() {
  const apps = state.devApps || [];
  if (!apps.length) return null;
  return apps.find((a) => String(a.id) === String(state.devPick)) || apps[0];
}

/**
 * 应用选择器。
 *
 * 做成构造器是因为现在有**两个**面板（数据表现、广告收益）各需要一个。
 * 复制一百多行不如参数化一次 —— 而且这里面的键盘、焦点、收起时机都是
 * 踩过坑才写对的（比如 mousedown 必须 preventDefault，见下面），
 * 复制一份等于把那些坑也复制一份。
 *
 * 两个实例**共享选中的那个应用**（state.devPick），只是各自的展开状态
 * 互不相干 —— 在广告页开着下拉，切到数据页不该看到它也是开的。
 */
function makeAppPicker(ids) {
  let key = null; // 上一次画的是哪份清单
  let open = false;
  let active = -1; // 键盘高亮到第几项，和「已选中」是两回事

  const trigger = $(ids.trigger);
  const menu = $(ids.menu);
  const nameEl = $(ids.name);
  const iconEl = ids.icon ? $(ids.icon) : null;

  function buildOption(app, i) {
    const opt = document.createElement('div');
    opt.className = 'dev-option';
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-selected', 'false');
    opt.id = `${ids.menu}-opt-${i}`; // aria-activedescendant 要指向它

    if (app.icon) {
      const img = document.createElement('img');
      img.className = 'dev-icon';
      img.src = app.icon;
      img.alt = '';
      opt.append(img);
    }

    const name = document.createElement('span');
    name.className = 'dev-option-name';
    name.textContent = app.title;
    opt.append(name);

    // 按下的瞬间别让焦点跑掉。选项是 <div>，真实点击时浏览器会把焦点移到
    // body（不可聚焦的地方），于是收到 focusout —— 而它发生在 click **之前**，
    // 弹层会先被收起来，click 就落在空气上：表现就是「点了一下什么也没发生」。
    // 阻止 mousedown 的默认行为即可保住焦点，click 照常触发。
    opt.addEventListener('mousedown', (ev) => ev.preventDefault());
    opt.addEventListener('click', () => {
      pickDevApp(app);
      closeMenu();
      trigger.focus();
    });
    return opt;
  }

  /** 只挪高亮，不改变选中 —— 方向键浏览时不能顺手把应用切了。 */
  function paintActive() {
    const items = [...menu.children];
    for (const [i, el] of items.entries()) el.classList.toggle('is-active', i === active);
    const el = items[active];
    if (el) {
      // 面板里只有七百来高，列表比它长，高亮跑出视野就得跟过去
      el.scrollIntoView({ block: 'nearest' });
      trigger.setAttribute('aria-activedescendant', el.id);
    }
  }

  function openMenu() {
    if (!(state.devApps || []).length || open) return;
    open = true;
    active = Math.max(0, (state.devApps || []).findIndex((a) => String(a.id) === String(state.devPick)));
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    paintActive();
  }

  function closeMenu() {
    if (!open) return;
    open = false;
    active = -1;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  function move(delta) {
    const n = menu.children.length;
    if (!n) return;
    active = (active + delta + n) % n;
    paintActive();
  }

  function render() {
    const apps = state.devApps || [];
    const listKey = apps.map((a) => a.id).join(',');

    // 初值必须是「不可能等于任何真实清单」的东西（null）。写 '' 的话，
    // 应用列表为空时 key 也是 ''，两者相等 → 空态那一支永远不执行，弹层一片空白。
    //
    // 只在清单真变了时才重建：每次重画都重建会把键盘高亮和滚动位置弄丢，
    // 而这个渲染会因为存储变化被反复触发。
    if (listKey !== key) {
      key = listKey;
      menu.textContent = '';
      if (!apps.length) {
        const empty = document.createElement('div');
        empty.className = 'dev-option';
        empty.textContent = state.devAppsError ? '应用列表没拉到' : '还没拿到应用列表';
        menu.append(empty);
      } else {
        apps.forEach((a, i) => menu.append(buildOption(a, i)));
      }
    }

    const pick = currentDevApp();
    nameEl.textContent = pick ? pick.title : '还没拿到应用列表';
    trigger.disabled = !apps.length;

    if (iconEl) {
      if (pick && pick.icon) {
        iconEl.src = pick.icon;
        iconEl.hidden = false;
      } else {
        iconEl.hidden = true;
        iconEl.removeAttribute('src');
      }
    }

    // 已选中的那一项打个点（样式挂在 aria-selected 上）
    for (const [i, a] of apps.entries()) {
      const el = menu.children[i];
      if (el) el.setAttribute('aria-selected', String(String(a.id) === String(pick && pick.id)));
    }
  }

  trigger.addEventListener('click', () => {
    if (open) closeMenu();
    else openMenu();
  });

  // 方向键 / Enter / Esc。原生 <select> 这些是白送的，自绘就得自己实现 ——
  // 少一个，键盘用户就被挡在门外了。
  trigger.addEventListener('keydown', (ev) => {
    const n = menu.children.length;
    if (!n) return;

    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      move(ev.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (ev.key === 'Home' || ev.key === 'End') {
      if (!open) return;
      ev.preventDefault();
      active = ev.key === 'Home' ? 0 : n - 1;
      paintActive();
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      if (!open) return; // 没开时交给 click，别抢
      ev.preventDefault();
      const app = (state.devApps || [])[active];
      if (app) {
        pickDevApp(app);
        closeMenu();
      }
      return;
    }
    if (ev.key === 'Escape' && open) {
      ev.preventDefault();
      closeMenu();
    }
  });

  // 点别处收起。用捕获阶段：别处的控件也会 stopPropagation，
  // 挂在冒泡上会漏掉那些点击，弹层就一直开着。
  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (!open) return;
      if (!$(ids.picker).contains(ev.target)) closeMenu();
    },
    true,
  );

  // Tab 走了也得收起来，否则弹层会孤零零挂在屏幕上。
  //
  // 但焦点落到「不可聚焦的地方」时**不能收**：relatedTarget 为 null 正是
  // 点空白、点选项这类情况，此时收弹层会赶在 click 之前把选项弄没。
  // 点到选择器外面那种情况由上面那个 pointerdown 兜着，不会漏。
  $(ids.picker).addEventListener('focusout', (ev) => {
    if (!open) return;
    const next = ev.relatedTarget;
    if (!next || next === document.body) return;
    if (!$(ids.picker).contains(next)) closeMenu();
  });

  return { render, close: closeMenu };
}

const dataPicker = makeAppPicker({
  picker: 'dev-picker',
  trigger: 'dev-trigger',
  name: 'dev-trigger-name',
  icon: 'dev-icon',
  menu: 'dev-menu',
});

const adPicker = makeAppPicker({
  picker: 'ad-picker',
  trigger: 'ad-trigger',
  name: 'ad-trigger-name',
  icon: null,
  menu: 'ad-menu',
});

/** 换了应用：两块数据的缓存键都不再匹配，所以**当前这一页**立刻重取，
 *  另一页等切过去时自然会发现缓存对不上而重取。 */
function pickDevApp(app) {
  if (String(state.devPick) === String(app.id)) return;
  state.devPick = app.id;
  chrome.storage.local.set({ devPick: app.id }).catch(() => {});
  refreshActiveView();
}

function renderDevNotice() {
  const el = $('dev-notice');
  // 当前这屏的数据拉失败优先于列表失败 —— 前者是用户此刻正要看的东西
  const msg = (state.devStats && state.devStats.error) || state.devAppsError || '';
  el.hidden = !msg;
  el.classList.toggle('is-error', Boolean(msg));
  el.textContent = msg ? `数据没能拉下来：${msg}` : '';
}

function renderDevTiles() {
  const host = $('dev-tiles');
  host.textContent = '';

  const busy = devIsBusy('dev');

  // 拉失败时 totals 是缺的 —— 这里必须显示成「—」，绝不能显示成 0。
  // 0 和「没拉到」是两件完全不同的事，混在一起就再也分不清了。
  const t = (state.devStats && !state.devStats.error && state.devStats.totals) || null;
  const num = (v) => (v == null ? '—' : formatExact(v));

  const tiles = [
    { label: '游戏曝光数', value: num(t && t.impression), sub: '安卓 · 商店各位置曝光合计' },
    { label: '商店页浏览数', value: num(t && t.detail), sub: '进到商店页的次数' },
    { label: '商店页点击率', value: (t && t.clickRate) || '—', sub: '逐日点击率的区间平均' },
    { label: '商店页转化率', value: (t && t.convertRate) || '—', sub: '逐日转化率的区间平均' },
  ];

  for (const tile of tiles) {
    const card = document.createElement('div');
    card.className = 'tile';

    const label = document.createElement('p');
    label.className = 'tile-label';
    label.textContent = tile.label;

    const value = document.createElement('p');
    value.className = 'tile-value';

    // 取数中就地把数字换成转圈图标，位置就在它本来该出现的地方 ——
    // 这样视线不用挪，也不会出现「数字先空着、过一会儿才冒出来」的突兀感。
    if (busy) {
      const spin = document.createElement('span');
      spin.className = 'tile-spin';
      spin.setAttribute('role', 'status');
      spin.setAttribute('aria-label', '加载中');
      value.append(spin);
    } else {
      value.textContent = tile.value;
    }

    const sub = document.createElement('p');
    sub.className = 'tile-sub';
    sub.textContent = tile.sub;

    card.append(label, value, sub);
    host.append(card);
  }
}

function renderDevChart() {
  const s = state.devStats;
  const channels = (s && !s.error && s.channels) || [];
  const dates = (s && s.dates) || [];

  $('dev-chart-sub').textContent = dates.length
    ? `${formatDayLabel(dates[0])} ~ ${formatDayLabel(dates[dates.length - 1])} · 安卓`
    : '';

  const xLabels = dates.map((d) => {
    const [, m, dd] = d.split('-');
    return `${Number(m)}/${Number(dd)}`;
  });

  // 颜色按渠道顺序连续取槽 —— 规范要求折线不得跳号，跳着取会得到
  // 一对没有被验证过的颜色。四条线，正好用前四个槽。
  const series = channels.map((c, i) => ({
    id: c.id,
    name: c.name,
    color: `var(${SERIES_VARS[i]})`,
    values: c.values,
  }));

  renderLineChart($('dev-chart'), {
    series,
    xLabels,
    xFull: dates.map((d) => `${formatDayLabel(d)}（安卓）`),
    height: 250,
    ariaLabel: '各渠道曝光趋势',
    // 取数中优先说「在取」—— 这时候空态不是「没数据」，只是还没到
    emptyText: devIsBusy('dev')
      ? '正在取数据…'
      : dates.length === 1
        // 曝光是慢变量，只看一天基本看不出东西（而且只有一个点，连不成线）。
        // 与其画一个孤零零的点，不如直接告诉用户该切到哪一档。
        ? '「今天」只有一天，看不出趋势 —— 切到「近 30 天」试试'
        : '选好应用后，这里会画各渠道的曝光趋势',
  });
}

/**
 * 还在等数据吗。
 *
 * 刻意由「等的这份数据到没到」来判，而不是由一个「发出去了 / 回来了」的标志位。
 * 标志位要靠消息通道回包来清；后台一旦被杀、或者处理器抛异常没回包，
 * 它就再也清不掉了 —— 界面上就是「数据早就出来了，加载中还挂着」。
 * 这里只问一句「我要的那份数据到了没」，消息回不回来都不影响。
 *
 * 兜底：等超过这个时长就当作不会来了，别无限转圈。
 */
const DEV_WANT_TIMEOUT_MS = 20_000;

/**
 * 两块数据各有各的「在等什么」—— 曝光和广告已经是两个面板、两套区间了，
 * 共用一份的话，在广告页切区间会把曝光那页的加载态也点着。
 */
const wants = {
  dev: { appId: null, since: 0 },
  ad: { appId: null, since: 0 },
};

function devIsBusy(kind) {
  const w = wants[kind];
  if (!w.appId) return false;
  return Date.now() - w.since < DEV_WANT_TIMEOUT_MS;
}

/** 记下「我要的是哪一份」。数据和它一对上就不再是加载中。 */
function wantDev(kind, appId) {
  wants[kind] = { appId: String(appId), since: Date.now() };
}

/**
 * 数据到了（成功或失败都算到货）就收工。
 *
 * 判据是「**为这个应用**拉的」且「**在我发问之后**落盘的」，不去比对日期区间 ——
 * 早先比的是 (appId, start, end) 三元组，只要后台把区间规范化成别的写法
 * （或者压根没打算按我给的日期回），就永远对不上，加载态一直挂着。
 * 把「撤销加载态」押在一次精确匹配上本身就是错的。
 *
 * @param landed 这份数据是不是**真的进了 state**（能被画出来）。存储里有一份
 *   但被别的守卫挡在门外（比如应用列表还没加载、认不出它是谁的）不算到货 ——
 *   那时候收工，屏幕上就只剩一根横线。
 */
function settleDev(kind, stats, landed) {
  const w = wants[kind];
  if (!w.appId || !stats || !landed) return;
  if (String(stats.appId) === w.appId && (stats.at || 0) >= w.since) {
    wants[kind] = { appId: null, since: 0 };
  }
}

/** 金额一律两位小数加 ¥ —— 「元」这个单位在界面上出现一次就够了，数字本身带符号更好扫读。 */
function money(v) {
  return `¥${(Math.round(v * 100) / 100).toFixed(2)}`;
}

/** 广告收益面板。它读的是独立的一份 state.adStats，不是曝光那份。 */
function renderAd() {
  if ($('pane-ad').hidden) return; // 没显示就别算
  const s = state.adStats;
  const busy = devIsBusy('ad');
  const err = (s && s.error) || null;
  // 有数据 = 有已结算的天。收益为 0 的已结算日照样算数，只是「还没出」的不算
  const has = Boolean(s && s.dates && s.dates.length);

  $('pane-ad').classList.toggle('is-busy', busy);
  adPicker.render();

  const notice = $('ad-notice');
  notice.hidden = !err;
  notice.classList.toggle('is-error', Boolean(err));
  notice.textContent = err ? `数据没能拉下来：${err}` : '';

  const sub = $('ad-sub');
  sub.textContent = has
    ? `${formatDayLabel(s.dates[0])} ~ ${formatDayLabel(s.dates[s.dates.length - 1])} · 单位：元`
    : '';

  const host = $('ad-tiles');
  host.textContent = '';

  const tiles = [
    {
      label: '预估收益',
      value: has ? money(s.total) : '—',
      // 「预估」这两个字必须留着：那个数不是到账，拿它去对银行卡会对不上
      sub: '后台标注为预估，每月 28 日更新上月',
    },
    {
      label: '日均收益',
      value: has && s.perDay != null ? money(s.perDay) : '—',
      // 分母是**已结算的天数**：收益为 0 的已结算日照样算进去（那是真实的 0），
      // 「还没出」的那天不算（拿它当 0 会把日均拉低）
      sub: has ? `按已结算的 ${s.dates.length} 天平均` : '区间内还没有已结算的数据',
    },
  ];

  for (const t of tiles) {
    const card = document.createElement('div');
    card.className = 'tile';

    const label = document.createElement('p');
    label.className = 'tile-label';
    label.textContent = t.label;

    const value = document.createElement('p');
    value.className = 'tile-value';
    if (busy) {
      const spin = document.createElement('span');
      spin.className = 'tile-spin';
      spin.setAttribute('role', 'status');
      spin.setAttribute('aria-label', '加载中');
      value.append(spin);
    } else {
      value.textContent = t.value;
    }

    const subEl = document.createElement('p');
    subEl.className = 'tile-sub';
    subEl.textContent = t.sub;

    card.append(label, value, subEl);
    host.append(card);
  }

  const dates = (s && s.dates) || [];
  renderLineChart($('ad-chart'), {
    series: has
      ? [{ id: 'revenue', name: '预估收益', color: `var(${SERIES_VARS[0]})`, values: s.values }]
      : [],
    xLabels: dates.map((d) => {
      const [, m, dd] = d.split('-');
      return `${Number(m)}/${Number(dd)}`;
    }),
    xFull: dates.map((d) => formatDayLabel(d)),
    height: 220,
    ariaLabel: '每日预估收益',
    emptyText: err
      ? '广告收益暂时取不到'
      : busy
        ? '正在取数据…'
        : dates.length === 0
          // 这一档已经排除了「今天」（区间终点就是昨天），所以走到这里通常是
          // 这个应用还没开通广告、或者这段时间真的没有收益
          ? '这段时间还没有已结算的收益'
          : '这个应用还没有广告收益数据',
  });
}

function renderDev() {
  if ($('pane-data').hidden) return; // 没显示就别算
  $('pane-data').classList.toggle('is-busy', devIsBusy('dev'));
  dataPicker.render();
  renderDevNotice();
  renderDevTiles();
  renderDevChart();
}

/**
 * 去后台拉一次当前「应用 + 区间」的数据。
 *
 * 取数期间必须让界面**明说自己正在取**：这里的请求要几百毫秒，那段时间
 * 屏幕上还是上一次的结果 —— 切了应用却看到旧应用的数字，还以为是新的。
 * 所以进入时压暗内容 + 转圈，拿到结果再还原。
 */
async function refreshDev({ force = false } = {}) {
  const app = currentDevApp();
  if (!app) return;
  const [start, end] = devDateRange(state.range);

  // 手上这份如果不是「当前应用 + 当前区间」的，当场丢掉。
  // 它属于另一次查询（比如上一个应用、或上一段时间），留着的话，在等新数据
  // 这段时间里它会冒充新数据画出来 —— 用户看到的就是「切过去先闪一下旧数字」。
  // 同参数的手动刷新则保留，那种情况下压暗着看旧数字反而更好。
  const cur = state.devStats;
  if (!cur || String(cur.appId) !== String(app.id) || cur.start !== start || cur.end !== end) {
    state.devStats = null;
  }

  // 先声明「我要的是哪一份」，再重画 —— 顺序反了这一帧就还是旧的
  wantDev('dev', app.id);
  renderDev();

  let res = null;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'dev-stats',
      appId: app.id,
      devId: app.devId,
      start,
      end,
      force,
    });
  } catch {
    // 后台可能在重启。拉不到会体现在 devStats.error 上，不用在这儿再报一次。
  }

  if (res && res.ok) {
    // 后台说「这份数据在我这儿了」。但**此刻还不能收工** ——
    // 它可能刚写进存储（界面这边读存储还压在 onChanged 的 250ms 防抖里），
    // 也可能命中的是缓存（压根不写存储，onChanged 永远不来）。
    // 无论哪种，直接去读一次：数据进到 state 里，settleDev 才会清掉等待标记，
    // 于是「转圈停」和「数字出现」落在同一帧。
    //
    // 早先是收到 ok 就清标记的，结果中间空出小半秒，显示成一根横线
    // —— 转圈停了、数字还没来。
    await load();
  }

  renderDev();
}

/**
 * 广告收益那一页的取数。结构照抄上面那个 —— 但它是**独立的一份**：
 * 自己的区间（终点是昨天）、自己的存储键、自己的加载态。
 *
 * 不合并成一次请求，是因为两页的区间不再是同一段：用户在广告页切区间，
 * 不该把曝光那页也重取一遍（反过来也一样）。
 */
async function refreshAd({ force = false } = {}) {
  const app = currentDevApp();
  if (!app) return;
  const [start, end] = devDateRange(state.range, { ad: true });

  // 同上的道理：手上这份不属于当前「应用 + 区间」就当场丢掉，别让它冒充新数据
  const cur = state.adStats;
  if (!cur || String(cur.appId) !== String(app.id) || cur.start !== start || cur.end !== end) {
    state.adStats = null;
  }

  wantDev('ad', app.id);
  renderAd();

  let res = null;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'ad-stats',
      appId: app.id,
      devId: app.devId,
      start,
      end,
      force,
    });
  } catch {
    // 后台可能在重启。拉不到会体现在 adStats.error 上。
  }

  // 后台回了 ok 还得**自己去读一次存储**才收工 —— 存储变化到界面之间压着
  // 250ms 防抖，也可能命中的是缓存（压根不写存储）。详见 refreshDev 的注释。
  if (res && res.ok) await load();

  renderAd();
}

// ------------------------------------------------------------------ 标签页

const TABS = ['credits', 'data', 'ad'];

/**
 * 区间按钮跟着标签页变：数据表现那页没有「全部」。
 *
 * 区间是**两个标签页共用**的一个控件，所以从积分页带着「全部」切过来时，
 * 必须就地落到「近 90 天」—— 否则会拿着一个数据源根本不接受的区间去请求。
 * 这里会真的把那个按钮的选中态也挪过去，用户看得见发生了什么。
 */
function syncRangeChips() {
  const allowed = RANGE_SETS[state.tab];

  for (const chip of $('filters').querySelectorAll('.chip')) {
    chip.hidden = !allowed.includes(chip.dataset.range);
  }

  if (!allowed.includes(state.range)) {
    // 就近落一档：**今天 ↔ 昨天**（广告是 T+1，没有今天），
    // 其余的（比如积分页的「全部」）落到该面板的最后一档。
    // 这里会真的把选中态挪过去，用户看得见发生了什么，而不是被偷偷改掉。
    const 对门 = { today: 'yesterday', yesterday: 'today' }[state.range];
    state.range = allowed.includes(对门) ? 对门 : allowed[allowed.length - 1];
  }

  for (const chip of $('filters').querySelectorAll('.chip')) {
    chip.classList.toggle('is-active', chip.dataset.range === state.range);
  }
}

/** 当前面板该去哪取数。切区间、换应用、切面板都走它。 */
function refreshActiveView({ force = false } = {}) {
  if (state.tab === 'data') return refreshDev({ force });
  if (state.tab === 'ad') return refreshAd({ force });
  return Promise.resolve(); // 积分那页是本地算的，不用取
}

function switchTab(tab) {
  if (!TABS.includes(tab)) return;

  // 新面板从滑块移动的方向滑进来 —— 和上面那个滑块的位移同一个方向，
  // 读起来才是「一件事」，而不是两个各自播的动画。
  const from = TABS.indexOf(state.tab);
  const to = TABS.indexOf(tab);
  const slide = from === to ? 0 : (to > from ? 1 : -1) * 18;
  for (const pane of [$('pane-credits'), $('pane-data'), $('pane-ad')]) {
    pane.style.setProperty('--pane-from', `${slide}px`);
  }

  state.tab = tab;
  for (const btn of $('tabs').querySelectorAll('.chip')) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
  }
  $('pane-credits').hidden = tab !== 'credits';
  $('pane-data').hidden = tab !== 'data';
  $('pane-ad').hidden = tab !== 'ad';
  syncRangeChips();

  // 隐藏期间 render() 会跳过对应的那一页（见那里的注释），所以切过来时必须
  // 主动补画一次 —— 否则会看到上一次离开时的旧内容。
  // 图表在 display:none 下宽高为 0 本来也画不出来，这一步是必须的，不只是保险。
  if (tab === 'credits') render();
  else if (tab === 'data') renderDev();
  else renderAd();
}

/** 拉应用列表。拉不到也不至于让整页空白 —— 缓存在存储里，load() 已经先把旧的填上了。 */
async function loadDevApps(force = false) {
  await chrome.runtime.sendMessage({ type: 'dev-apps', force }).catch(() => {});
}

// ------------------------------------------------------------------ 交互

$('tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.chip');
  if (!btn || btn.dataset.tab === state.tab) return;
  switchTab(btn.dataset.tab);
  // 缓存已经画在屏幕上了，这里只是去取一份更新的。
  // 积分那页是本地算的，不用取。
  if (state.tab !== 'credits') loadDevApps().then(() => refreshActiveView());
});

$('filters').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip');
  if (!chip) return;
  state.range = chip.dataset.range;
  for (const other of $('filters').querySelectorAll('.chip')) {
    other.classList.toggle('is-active', other === chip);
  }
  // 区间统辖两个标签页。数据那页的数据是按日期区间去后台取的（本地算不出来），
  // 所以必须**先**告诉它「我要新的这一份」再重画。
  // 反过来写的话，重画那一帧用的还是上一个区间的数字，看着就是闪一下旧数据。
  refreshActiveView();
  render();
});

function openFromState(which) {
  const config = state.charts && state.charts[which];
  if (!config || !config.series.length) return;

  // 面板里不在本地开浮层 —— 让外层另起一层大的，面板本身原地不动。
  // 浮层里那份（IS_OVERLAY）除外，它自己就是那一层。
  if (IS_EMBEDDED && !IS_OVERLAY) {
    tellPanel(true, which);
    return;
  }
  openModal(config);
}

$('trend-expand').addEventListener('click', () => openFromState('trend'));
$('kind-expand').addEventListener('click', () => openFromState('kind'));
$('project-expand').addEventListener('click', () => openFromState('project'));

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && modalState.config) {
    ev.preventDefault(); // 别让 Esc 顺势把面板也关了
    closeModal();
  }
});

$('project-reset').addEventListener('click', () => {
  // 抹掉「这套勾选是按哪个范围算的」标记，render 时就会按当前范围重算前 N 高
  state.selected = null;
  state.selectionRange = null;
  state.selectionDirty = false;
  render();
});

$('table-btn').addEventListener('click', () => {
  const wrap = $('table-wrap');
  const btn = $('table-btn');
  const willShow = wrap.hidden;
  wrap.hidden = !willShow;
  btn.textContent = willShow ? '收起' : '展开';
  btn.setAttribute('aria-expanded', String(willShow));
  if (willShow && wrap.__last) renderTable(wrap.__last.view, wrap.__last.projects);
});

$('sync-btn').addEventListener('click', async () => {
  const btn = $('sync-btn');
  btn.disabled = true;
  btn.classList.add('is-spinning');
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: 'sync-now' });
  } catch {
    // 后台可能正在重启，下一次 alarm 会补上
  }
  await load();

  // 后台说 busy 时必须说话。以前这里完全不看返回值，于是状态行写着
  // 「点 ↻ 重新开始」、点下去却毫无反应 —— 看起来就是卡死了。
  if (res && res.ok === false && res.reason === 'busy') {
    const el = $('status-line');
    el.textContent = '上一轮同步还在收尾，稍等几秒再点 ↻';
    el.classList.add('is-error');
  }
});

// 同步进行中每翻一页都会写一次存储，逐条响应会让两张图一秒重画好几次。
// 合并成最多每 250ms 重载一次，进度照样跟得上，界面也不会抖。
let reloadTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // 开发者后台那几个键也算 —— 漏了它们，数据那页拉回来新数据界面不会动
  if (
    !(
      changes.auth || changes.sync || changes.daily || changes.hourly || changes.projects
      || changes.devApps || changes.devPick || changes.devStats || changes.adStats
    )
  ) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 250);
});

// 被站点主题接管时（data-theme 已设）就不跟系统走了，否则两边会打架
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!document.documentElement.hasAttribute('data-theme')) render();
});

// ------------------------------------------------------------------ 启动

// 嵌进站点页面里的面板时（?embed=1），去掉页面留白和背景色，
// 交给外层容器撑尺寸 —— 同一份页面，两种宿主
if (IS_EMBEDDED) document.documentElement.classList.add('is-embedded');
// 浮层那份只负责放大显示图表：仪表盘本体不露面，
// 否则会先闪一整页仪表盘、再盖上弹窗
if (IS_OVERLAY) document.documentElement.classList.add('is-overlay');

applyTheme();
listenThemePush();
listenHostMessages();

// 浮层那份带着「看的是哪张图、哪个区间」进来，好落回同一处
const urlRange = PAGE_PARAMS.get('range');
if (Object.prototype.hasOwnProperty.call(RANGE_LABEL, urlRange)) state.range = urlRange;

for (const chip of $('filters').querySelectorAll('.chip')) {
  chip.classList.toggle('is-active', chip.dataset.range === state.range);
}

// 浮层那份只画图，没有标签页可切；而且它带着 chart= 进来，必须停在原地
const 初始面板 = PAGE_PARAMS.get('tab');
if (!IS_OVERLAY) switchTab(TABS.includes(初始面板) ? 初始面板 : 'credits');

load().then(() => {
  const chart = PAGE_PARAMS.get('chart');
  if (chart) openFromState(chart);
  // 缓存在存储里的应用/数据先顶上，再去后台取一次新的。
  // 顺序不能反：先发请求的话，这一屏会从空态闪一下再出内容。
  if (state.tab !== 'credits') {
    loadDevApps().then(() => refreshActiveView());
  }
});
