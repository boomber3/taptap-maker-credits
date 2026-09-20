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
  7: '近 7 天消耗',
  30: '近 30 天消耗',
  90: '近 90 天消耗',
  all: '全部消耗',
};

const state = {
  data: null,
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
  ]);
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

// ------------------------------------------------------------------ 交互

$('filters').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip');
  if (!chip) return;
  state.range = chip.dataset.range;
  for (const other of $('filters').querySelectorAll('.chip')) {
    other.classList.toggle('is-active', other === chip);
  }
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
  if (!(changes.auth || changes.sync || changes.daily || changes.hourly || changes.projects)) return;
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

load().then(() => {
  const chart = PAGE_PARAMS.get('chart');
  if (chart) openFromState(chart);
});
