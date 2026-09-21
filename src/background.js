/**
 * TapTap 制造 · 积分消耗统计 — 后台服务
 *
 * 数据全部来自 maker.taptap.cn 的官方接口，不解析页面 DOM：
 *   GET  /api/v1/credits/transactions?from=&limit=   积分流水（limit 服务端封顶 100）
 *   GET  /api/v1/credits/info                        余额与累计值
 *   GET  /api/v1/apps?userId=                        项目 id -> 项目名
 *   POST /api/auth/refresh                           用 refresh_token 续期
 *
 * 统计口径（已用全量数据核对：type===1 求和 === /credits/info 的 totalConsumed）
 *   type === 1 是消耗；type 2/7/10/11/14/15/16/20 是每小时恢复、活动赠送、
 *   套餐变更等「获得或调整」，一律不计入消耗。
 */

import { dayKey, SYNC_STALE_MS } from './util.js';
import { freshRecords, ingestOne, pruneHourly } from './aggregate.js';

const ORIGIN = 'https://maker.taptap.cn';
const API = `${ORIGIN}/api/v1`;
const AUTH_BASE = `${ORIGIN}/api/auth`;

const PAGE_LIMIT = 100; // 服务端上限就是 100，传更大也只返回 100
const FETCH_TIMEOUT_MS = 20_000; // 卡住的请求不能让整轮同步永远挂着
const HOURLY_KEEP_DAYS = 14; // 小时级明细只保留最近这些天，日级永久保留
const MAX_RUN_MS = 4 * 60_000; // 单轮同步的硬上限，超了主动中止，下次从断点续
const TOKEN_SKEW_MS = 60_000; // 提前 1 分钟就当作要过期
const MAX_INCREMENTAL_PAGES = 40;

// 第二个数据源：开发者后台的商店数据。它和上面的积分**刻意不同构**，详见下面的分节。
const DEV_API = 'https://developer.taptap.cn/api';
const DEV_APPS_TTL_MS = 30 * 60_000; // 应用列表多久算新鲜
const DEV_STATS_TTL_MS = 5 * 60_000; // 同一份区间数据多久内直接用缓存

/**
 * 渠道趋势画哪几条。
 *
 * 接口是一条渠道一次请求，而全画（安卓有 8 条）必然读不清 —— 折线超过 8 条
 * 就没有经过校验的可辨色相了。这四条既是后台自己突出的那几个，相加也应当
 * 等于「全部」，正好能拿来做一致性校验。
 */
const DEV_CHANNELS = [
  { id: 'index_feed', name: '首页推荐' },
  { id: 'search', name: '搜索' },
  { id: 'top', name: '排行榜' },
  { id: 'other', name: '其他' },
];

/**
 * 聚合数据的版本号。改动入库逻辑、导致已有聚合值不再可信时把它加一，
 * 下次同步会把 daily/hourly 清空重建（代价是一次全量翻页，约半分钟）。
 *
 *   1 → 2：修了增量同步只入库一条的 bug。旧安装漏掉了安装之后的绝大部分流水，
 *          聚合值已经错了，只能重建 —— 保留反而更糟。
 *   2 → 3：新增「按消耗类型」的桶。老数据里没记类型，只能重建。
 */
const DATA_VERSION = 3;

const DEFAULT_SYNC = {
  dataVersion: DATA_VERSION,
  backfillDone: false,
  nextFrom: 0,
  cursorId: null, // 回填游标：已入库的最小 id
  maxId: 0, // 已入库的最大 id
  total: 0,
  scanned: 0,
  lastSyncAt: 0,
  lastError: null,
  running: false,
  runningSince: 0,
  progress: null,
};

class AuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AuthError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- 存储读写

async function readAll() {
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
  return {
    auth: raw.auth || null,
    sync: { ...DEFAULT_SYNC, ...(raw.sync || {}) },
    projects: raw.projects || {},
    daily: raw.daily || {},
    hourly: raw.hourly || {},
    kindDaily: raw.kindDaily || {},
    kindHourly: raw.kindHourly || {},
    // 当前还在账号里的项目 id。删除项目不会删掉它的历史流水，
    // 所以只能靠这份「现存清单」反过来判定哪些项目已经被删了。
    activeProjectIds: Array.isArray(raw.activeProjectIds) ? raw.activeProjectIds : null,
  };
}

const saveSync = (sync) => chrome.storage.local.set({ sync });

/**
 * 心跳：把 runningSince 推到现在，然后落盘。
 *
 * runningSince 是「服务进程还活着」的证据，**不是**「这轮什么时候开始的」。
 * 早先没推它，于是一轮超过 SYNC_STALE_MS 的同步会被下一轮当成残骸放行 ——
 * 两轮同时跑、互相覆盖对方的 ctx，数据和状态都会乱。
 * 顺带也把服务进程的空闲计时器顶回去（纯 fetch 不会重置它）。
 */
async function heartbeat(sync) {
  sync.runningSince = Date.now();
  await saveSync(sync);
}

function saveAggregates(ctx) {
  const payload = {
    daily: ctx.daily,
    hourly: ctx.hourly,
    kindDaily: ctx.kindDaily || {},
    kindHourly: ctx.kindHourly || {},
    projects: ctx.projects,
    today: buildToday(ctx.daily),
  };
  // 只有真拿到了清单才写，否则会把「接口挂了」误存成「一个项目都没有」
  if (ctx.activeProjectIds) payload.activeProjectIds = ctx.activeProjectIds;
  return chrome.storage.local.set(payload);
}

// ------------------------------------------------------------------ 登录态

function decodeJwtExp(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function ensureToken({ force = false } = {}) {
  const { auth } = await chrome.storage.local.get('auth');
  if (!auth || !auth.accessToken) throw new AuthError('NO_TOKEN');

  const exp = auth.exp ?? decodeJwtExp(auth.accessToken);
  const stillFresh = exp != null && exp - Date.now() > TOKEN_SKEW_MS;

  if (!force && stillFresh) return auth.accessToken;
  if (!auth.refreshToken) {
    if (stillFresh) return auth.accessToken;
    throw new AuthError('NO_TOKEN');
  }

  const res = await request(`${AUTH_BASE}/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: auth.refreshToken }),
  });
  if (!res.ok) throw new AuthError('REFRESH_FAILED');

  const data = await res.json();
  if (!data || !data.access_token) throw new AuthError('REFRESH_FAILED');

  const next = {
    ...auth,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || auth.refreshToken,
    exp: decodeJwtExp(data.access_token),
    refreshedAt: Date.now(),
  };
  await chrome.storage.local.set({ auth: next });
  return next.accessToken;
}

/** 所有出网请求都带上超时：卡死的连接必须能被放弃，否则 running 会永远清不掉 */
function request(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

async function apiGet(path) {
  let token = await ensureToken();
  let res = await request(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 401 || res.status === 403) {
    token = await ensureToken({ force: true });
    res = await request(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = await res.json();
  if (body && typeof body.code === 'string' && body.code) {
    throw new Error(body.message || body.code);
  }
  return body;
}

// ------------------------------------------------------------------ 同步

/**
 * 回填历史：从最新往最旧翻页，用 cursorId 保证不重复计数。
 * 翻页期间若有新流水插入，会让后续页整体后移，cursorId 正是为了挡住这种重复。
 */
async function backfill(sync, ctx, startedAt) {
  let from = sync.nextFrom || 0;
  let cursorId = sync.cursorId;
  let pages = 0;

  for (;;) {
    const page = await apiGet(`/credits/transactions?from=${from}&limit=${PAGE_LIMIT}`);
    const list = Array.isArray(page.list) ? page.list : [];

    if (list.length === 0) {
      // 一页都没读到。真到底了是正常的，但若这是本轮第一次请求、回填又还没完成过，
      // 更像是接口给了个空壳 —— 宁可报错，也不能把空的聚合写回去覆盖掉已有数据。
      if (pages === 0 && !sync.backfillDone) {
        throw new Error('接口返回空列表，本轮中止（已有数据保持原样）');
      }
      break;
    }

    for (const tx of list) {
      if (cursorId !== null && tx.id >= cursorId) continue;
      cursorId = tx.id;
      ingestOne(ctx, tx);
      if (tx.id > sync.maxId) sync.maxId = tx.id;
    }

    from += list.length;
    sync.nextFrom = from;
    sync.cursorId = cursorId;
    sync.total = page.total || sync.total;
    sync.scanned += list.length;
    sync.progress = { phase: 'backfill', done: from, total: sync.total };
    pages += 1;

    await heartbeat(sync);
    if (pages % 20 === 0) await saveAggregates(ctx);
    if (from >= (page.total || 0)) break;
    if (list.length < PAGE_LIMIT) break;
    if (Date.now() - startedAt > MAX_RUN_MS) throw new Error('本轮超时，下次从断点继续');
  }

  // 一页都没读到就别写盘，避免用空聚合覆盖已有数据
  if (pages > 0) await saveAggregates(ctx);
  await heartbeat(sync);
}

/** 增量：只取 id 大于基线的流水，遇到已入库的就停 */
async function incremental(sync, ctx, startedAt) {
  let from = 0;
  let pages = 0;
  // 基线只在整轮开始时固定一次，遍历中不可改动 —— 详见 freshRecords 的注释
  const baselineId = sync.maxId;

  for (let i = 0; i < MAX_INCREMENTAL_PAGES; i += 1) {
    const page = await apiGet(`/credits/transactions?from=${from}&limit=${PAGE_LIMIT}`);
    const list = Array.isArray(page.list) ? page.list : [];
    if (list.length === 0) break;

    const { fresh, reachedKnown } = freshRecords(list, baselineId);
    for (const tx of fresh) {
      ingestOne(ctx, tx);
      if (tx.id > sync.maxId) sync.maxId = tx.id;
    }

    sync.total = page.total || sync.total;
    sync.progress = { phase: 'incremental', done: from, total: sync.total };
    pages += 1;

    if (reachedKnown || list.length < PAGE_LIMIT) break;
    from += list.length;
    if (from >= (page.total || 0)) break;
    if (Date.now() - startedAt > MAX_RUN_MS) throw new Error('本轮超时，下次从断点继续');
  }

  if (pages > 0) await saveAggregates(ctx);
  await heartbeat(sync);
}

/**
 * 拉一次项目清单：既补项目名，也拿回「当前还存在哪些项目」。
 * 失败时返回 null —— 调用方据此跳过写入，避免把接口故障当成「项目全被删了」。
 */
async function refreshProjects(ctx) {
  const { auth } = await chrome.storage.local.get('auth');
  const uid = auth && auth.user && auth.user.id;
  if (!uid) return null;
  try {
    const data = await apiGet(`/apps?userId=${encodeURIComponent(uid)}`);
    const apps = Array.isArray(data.apps) ? data.apps : [];
    for (const app of apps) {
      if (app && app.id && app.name) ctx.projects[app.id] = app.name;
    }
    return apps.map((app) => app && app.id).filter(Boolean);
  } catch {
    // 项目名不是关键路径，失败就沿用 remark 里解析出来的
    return null;
  }
}

export async function runSync(reason = 'manual') {
  // 先等顶层那段收尾跑完。onStartup / onInstalled 会紧跟着模块体触发 runSync，
  // 它可能赶在清理落盘之前就读到 running:true —— 那样启动这次同步会被自己
  // 刚才留下的残骸挡掉，白等一个闹钟周期。
  await startupCleanup;

  const state = await readAll();
  const sync = state.sync;

  if (sync.running && Date.now() - sync.runningSince < SYNC_STALE_MS) {
    return { ok: false, reason: 'busy' };
  }

  const startedAt = Date.now();
  sync.running = true;
  sync.runningSince = startedAt;
  sync.lastError = null;
  sync.progress = { phase: 'starting', done: 0, total: sync.total || 0 };
  await saveSync(sync);

  const ctx = {
    daily: state.daily,
    hourly: state.hourly,
    kindDaily: state.kindDaily,
    kindHourly: state.kindHourly,
    projects: state.projects,
    activeProjectIds: state.activeProjectIds,
  };

  // 入库逻辑改过、旧聚合值不可信时（见 DATA_VERSION），整份重建而不是修补 ——
  // 漏掉的那些记录没有留下任何痕迹，没法只补差额。
  if (sync.dataVersion !== DATA_VERSION) {
    ctx.daily = {};
    ctx.hourly = {};
    ctx.kindDaily = {};
    ctx.kindHourly = {};
    sync.dataVersion = DATA_VERSION;
    sync.maxId = 0;
    sync.nextFrom = 0;
    sync.cursorId = null;
    sync.backfillDone = false;
    sync.scanned = 0;
  }

  try {
    if (!sync.backfillDone) await backfill(sync, ctx, startedAt);
    await incremental(sync, ctx, startedAt);

    const activeIds = await refreshProjects(ctx);
    if (activeIds) ctx.activeProjectIds = activeIds;

    pruneHourly(ctx.hourly, HOURLY_KEEP_DAYS);
    pruneHourly(ctx.kindHourly, HOURLY_KEEP_DAYS);
    // 兜底：ctx 是空的就绝不写盘 —— 用空数据覆盖已有数据是不可逆的
    if (Object.keys(ctx.daily).length > 0) await saveAggregates(ctx);

    sync.backfillDone = true;
    sync.lastSyncAt = Date.now();
    sync.lastError = null;
    sync.progress = null;
    return { ok: true, reason };
  } catch (err) {
    const isAuth = err instanceof AuthError;
    sync.lastError = {
      code: isAuth ? err.code : 'SYNC_FAILED',
      message: isAuth
        ? err.code === 'NO_TOKEN'
          ? '还没登录 —— 请在浏览器里打开 maker.taptap.cn 登录一次'
          : '登录态已失效，请打开 maker.taptap.cn 刷新一下页面'
        : String((err && err.message) || err),
      at: Date.now(),
    };
    sync.progress = null;
    return { ok: false, reason: sync.lastError.code, message: sync.lastError.message };
  } finally {
    // 无论成功、失败还是抛异常，都必须把锁放掉、把进度清掉，
    // 否则界面会一直停在「正在同步」
    sync.running = false;
    sync.progress = null;
    await saveSync(sync);
  }
}

// -------------------------------------------------- 开发者后台「数据表现」

/**
 * 第二个数据源：TapTap 开发者后台的商店数据。
 *
 * **刻意不照搬上面那套积分同步**，因为数据形态根本不同：
 *   积分要翻一万多条流水、自己聚合、存历史 —— 所以必须有回填、增量、锁、心跳。
 *   数据表现是「你要哪一段，服务端就给你哪一段」，历史在服务端 ——
 *   按需拉一次就够了。所以这里没有 alarm、没有 running 锁、没有 lastError 状态机。
 *
 * 鉴权是**纯 Cookie**（实测：credentials:'include' → 200，'omit' → 401「未认证」），
 * 所以不需要内容脚本过户凭证、更不需要续期 —— 只要 host_permissions 里有这个域。
 */

/** 开发者后台的请求。Cookie 由 host_permissions 带过去，不用自己拼鉴权头。 */
async function devGet(path) {
  const res = await request(`${DEV_API}${path}`, { credentials: 'include' });
  if (res.status === 401 || res.status === 403) {
    throw new Error('开发者后台未登录 —— 先在浏览器里打开一次 developer.taptap.cn');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = await res.json();
  if (!body || body.success !== true) {
    const inner = body && body.data;
    throw new Error((inner && (inner.msg || inner.error)) || '接口返回失败');
  }
  return body.data;
}

const sumBy = (list, key) => (list || []).reduce((a, x) => a + (Number(x[key]) || 0), 0);

/**
 * 区间的比率 = **逐日比率求平均**。
 *
 * 这条是拿后台页面上的数字反推出来的，三种算法只对上这一种
 * （2026-08-23~09-21，安卓口径）：
 *
 *     逐日求平均        点击率 6.89%   转化率 20.84%   ← 与后台显示**逐位相同**
 *     求和再相除        点击率 6.95%   转化率 —
 *     接口的 overview   点击率 6.95%   转化率 20.99%   ← 也对不上
 *
 * 所以：**不要**用接口自带的 overview，也**不要**自己拿两个计数相除 ——
 * 两条路都会和用户在后台看到的数字差一点点，而这种「差一点点」最难解释。
 * 拿不到某天的比率（接口给的是 '-'）就跳过那天，别当成 0 拉低平均。
 */
function avgRate(rows, key) {
  const vals = (rows || [])
    .map((r) => parseFloat(String(r[key]).replace('%', '')))
    .filter((n) => Number.isFinite(n));
  if (!vals.length) return null;
  return `${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)}%`;
}

/** 先拿工作室，再逐个拉应用，合并成一份列表。 */
async function fetchDevApps() {
  const devs = await devGet('/developer/v1/list');
  const out = [];
  for (const d of (devs && devs.list) || []) {
    const page = await devGet(
      `/app/v2/list?developer_id=${d.id}&page=1&pagesize=50&sort_by_updated_at=true`,
    );
    for (const app of (page && page.list) || []) {
      out.push({
        id: app.id,
        devId: d.id,
        title: app.title || `应用 ${app.id}`,
        // 草稿应用的名字会是占位符，界面上要能看出来不是一个真名字
        icon: (app.icon && (app.icon.medium_url || app.icon.url)) || '',
      });
    }
  }
  return out;
}

/**
 * 拉一个应用的区间数据：四项指标 + 各渠道逐日曝光。
 *
 * 注意不带 platform 时接口**只返回安卓**（实测）。这里是安卓口径，
 * 界面上要写清楚，免得和后台页面（可能在看 iOS）对不上。
 */
async function fetchExposure(appId, devId, start, end) {
  const q = `developer_id=${devId}&app_id=${appId}&start_date=${start}&end_date=${end}`;

  // 曝光/点击来自 position，浏览来自 pv —— 后台页面上那行 KPI 就是这么拼的，
  // 四个数分别和后台对得上（见 avgRate 的注释）。两个请求并发，省一半等待。
  const [pos, pv] = await Promise.all([
    devGet(`/dashboard/v2/stats-by-day/position/cn?${q}`),
    devGet(`/dashboard/v3/stats-by-day/pv/cn?${q}`),
  ]);

  const rows = pos.list || [];
  const totals = {
    impression: sumBy(rows, 'impression_cnt'),
    detail: sumBy(pv.list || [], 'pv_from_total'),
    clickRate: avgRate(rows, 'click_rate'),
    convertRate: avgRate(rows, 'convert_detail_rate'),
  };

  // 以「全部」那份的日期为准，各渠道按日期对齐、缺的补 0 ——
  // 不对齐的话几条线的 x 轴会错位，看上去就是错的。
  const dates = rows.map((r) => r.date).sort();

  // 四条渠道**并发**拉。串行的话要等四轮往返，切应用时那种「卡一下」
  // 主要就是它 —— 每次多等几百毫秒，一次切换就多出一两秒。
  const ones = await Promise.all(
    DEV_CHANNELS.map((ch) => devGet(`/dashboard/v2/stats-by-day/position/cn?${q}&position=${ch.id}`)),
  );
  const channels = DEV_CHANNELS.map((ch, i) => {
    const byDate = new Map(
      ((ones[i] && ones[i].list) || []).map((r) => [r.date, Number(r.impression_cnt) || 0]),
    );
    return { id: ch.id, name: ch.name, values: dates.map((d) => byDate.get(d) || 0) };
  });

  return { totals, dates, channels };
}

/**
 * 广告收益：逐日预估收益（元）。
 *
 * 参数名和上面那套**不一样** —— 这里是 start_time / end_time，不是 start_date /
 * end_date。抄错了接口直接报错，别想当然。
 */
async function fetchAd(appId, devId, start, end) {
  const q = `developer_id=${devId}&app_id=${appId}&start_time=${start}&end_time=${end}`;
  const d = await devGet(`/mini-app/v1/ad/payout-report-data?${q}`);

  const rows = (d && d.list) || [];
  const byDate = new Map(rows.map((r) => [r.date, r.revenue]));

  // 接口对**还没结算的那天**（今天）返回的是 `revenue: ""` —— 空字符串，不是 "0"。
  // 这两者必须分开：0 是「那天真的没赚到」，空是「还没出」。
  // 写成 `Number(r.revenue) || 0` 的话空字符串会变成 0，今天点开就永远是 ¥0.00，
  // 看着像没收入 —— 而这个区别在别处（拉取失败 vs 显示 0）也是同一条原则。
  //
  // 图表**只画已经出了的天**：把没出的那天补成 0，图尾会出现一段假的暴跌，
  // 和积分那边「只画到当前小时」是同一个理由。
  const dated = rows
    .filter((r) => r.revenue !== '' && r.revenue != null && Number.isFinite(Number(r.revenue)))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const dates = dated.map((r) => r.date);
  const values = dated.map((r) => Number(r.revenue));
  const total = round2(values.reduce((a, b) => a + b, 0));

  return {
    dates,
    values,
    total,
    pendingDays: rows.length - dated.length, // 尾部有几天还没出
    // 日均按**有数据的天数**算 —— 已经结算的那些天里，收益为 0 的那天照样算进去
    // （那是真实的 0），但「还没出」的那天不能算（拿它当 0 会把日均拉低）。
    perDay: dates.length ? round2(total / dates.length) : null,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 曝光那一套：四项指标 + 各渠道逐日曝光。
 *
 * 广告收益**不在这里**。它已经独立成一个面板，有自己的区间（昨天/近7天/…），
 * 和这里的区间不再是同一段 —— 捆在一起的话，用户在广告页切区间会把曝光
 * 也一起重取，反之亦然。各走各的消息和存储键。
 */
async function fetchDevStats(appId, devId, start, end) {
  return fetchExposure(appId, devId, start, end);
}

/** 应用列表。拉不到时保留上一次的好数据，只记错误 —— 别把能用的清单冲掉。 */
async function refreshDevApps({ force = false } = {}) {
  const { devApps: cached } = await chrome.storage.local.get('devApps');
  const fresh =
    cached && (cached.list || []).length && Date.now() - (cached.at || 0) < DEV_APPS_TTL_MS;
  if (!force && fresh) return { ok: true, cached: true };

  try {
    const list = await fetchDevApps();
    await chrome.storage.local.set({ devApps: { at: Date.now(), list, error: null } });
    return { ok: true, count: list.length };
  } catch (err) {
    const message = String((err && err.message) || err);
    await chrome.storage.local.set({
      devApps: { at: Date.now(), list: (cached && cached.list) || [], error: message },
    });
    return { ok: false, message };
  }
}

/** 区间数据。失败时清掉数据只留错误 —— 宁可显示「拉取失败」，也不能显示成 0。 */
export async function refreshDevStats({ appId, devId, start, end, force = false }) {
  if (!appId || !devId || !start || !end) return { ok: false, message: '参数不完整' };

  try {
    // force=true 必须真的绕过缓存。界面一直有传这个参数，但这里早先没接 ——
    // 于是「强制刷新」是个空承诺：5 分钟内怎么点都还是那份旧数据。
    const { devStats: cached } = await chrome.storage.local.get('devStats');
    const same = cached && cached.appId === appId && cached.start === start && cached.end === end;
    if (!force && same && !cached.error && Date.now() - (cached.at || 0) < DEV_STATS_TTL_MS) {
      return { ok: true, cached: true };
    }
    const data = await fetchDevStats(appId, devId, start, end);
    await chrome.storage.local.set({
      devStats: { at: Date.now(), appId, devId, start, end, error: null, ...data },
    });
    return { ok: true };
  } catch (err) {
    const message = String((err && err.message) || err);
    await chrome.storage.local.set({
      devStats: { at: Date.now(), appId, devId, start, end, error: message },
    });
    return { ok: false, message };
  }
}

/**
 * 广告收益。和上面结构一样，但**独立的一份**：自己的存储键、自己的区间。
 *
 * 它是 T+1 的（今天必然为空），所以界面上给的区间是昨天/近7天/近30天/近90天，
 * 和曝光那套的区间不是同一段 —— 这也是它必须单独一条的原因。
 */
export async function refreshAdStats({ appId, devId, start, end, force = false }) {
  if (!appId || !devId || !start || !end) return { ok: false, message: '参数不完整' };

  try {
    const { adStats: cached } = await chrome.storage.local.get('adStats');
    const same = cached && cached.appId === appId && cached.start === start && cached.end === end;
    if (!force && same && !cached.error && Date.now() - (cached.at || 0) < DEV_STATS_TTL_MS) {
      return { ok: true, cached: true };
    }
    const data = await fetchAd(appId, devId, start, end);
    await chrome.storage.local.set({
      adStats: { at: Date.now(), appId, devId, start, end, error: null, ...data },
    });
    return { ok: true };
  } catch (err) {
    const message = String((err && err.message) || err);
    await chrome.storage.local.set({
      adStats: { at: Date.now(), appId, devId, start, end, error: message },
    });
    return { ok: false, message };
  }
}

// ------------------------------------------------------------------ 摘要

/**
 * 页面里那个胶囊只要一个数：今天消耗了多少。
 *
 * 这里预先算好存进存储，内容脚本直接读 —— 不走消息。
 * 走消息就得先叫醒后台服务进程，服务休眠或正忙时可能拿不到回应，
 * 胶囊就只剩一根横线，而且还不知道是为什么。
 * 日期分桶和数字格式也一并在这儿定，内容脚本不用再抄一份（抄了迟早会两边不一致）。
 */
function buildToday(daily) {
  const day = dayKey(new Date());
  const total = Object.values(daily[day] || {}).reduce((a, b) => a + b, 0);
  return { day, total, text: Math.round(total).toLocaleString('zh-CN'), at: Date.now() };
}

// ------------------------------------------------------------------ 消息

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'auth') {
    const incoming = msg.payload;
    if (incoming && incoming.accessToken) {
      const incomingExp = decodeJwtExp(incoming.accessToken);
      chrome.storage.local.get(['auth', 'sync']).then(async ({ auth, sync }) => {
        // 页面里那份可能比后台手里这份旧（后台已经刷新过），过期更早的不要覆盖
        const storedExp = auth ? auth.exp : null;
        if (storedExp && incomingExp && incomingExp < storedExp) return;

        await chrome.storage.local.set({
          auth: {
            accessToken: incoming.accessToken,
            refreshToken: incoming.refreshToken || (auth && auth.refreshToken) || null,
            exp: incomingExp,
            user: incoming.user || (auth && auth.user) || null,
          },
        });

        // 用户每次打开积分页都会走到这里。顺手补一次同步 ——
        // 否则装完扩展、登录完，还得干等到下一个闹钟（最多 10 分钟）才看到数据。
        const s = { ...DEFAULT_SYNC, ...(sync || {}) };
        if (!s.running && Date.now() - (s.lastSyncAt || 0) > 60_000) {
          runSync('auth');
        }
      });
    }
    return false;
  }

  if (msg.type === 'sync-now') {
    runSync('manual').then(sendResponse);
    return true; // 异步回复
  }

  // 开发者后台那两个。都返回 { ok, message? }，界面照 message 显示，
  // 不自己编「拉取失败」之外的措辞。
  // 这两个都必须**保证**回包。只写 .then(sendResponse) 的话，一旦函数抛异常
  // （比如开头那句 storage.get 失败），sendResponse 永远不被调用 ——
  // 消息端口就一直开着，前台的 await 永不返回，那边界面会永远停在「加载中」。
  if (msg.type === 'dev-apps') {
    refreshDevApps({ force: Boolean(msg.force) })
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === 'dev-stats') {
    refreshDevStats(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === 'ad-stats') {
    refreshAdStats(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: String((err && err.message) || err) }));
    return true;
  }

  return false;
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('src/dashboard.html');
  const { dashboardTabId } = await chrome.storage.session.get('dashboardTabId');
  if (dashboardTabId != null) {
    try {
      await chrome.tabs.update(dashboardTabId, { active: true });
      return;
    } catch {
      // 标签页已经被关掉了，往下走新建
    }
  }
  const tab = await chrome.tabs.create({ url });
  await chrome.storage.session.set({ dashboardTabId: tab.id });
});

function installAlarm() {
  chrome.alarms.create('sync', { periodInMinutes: 10, delayInMinutes: 1 });
}

// 服务进程每次加载时做两件收尾：
//   1. 清掉可能残留的 running。**这里不看时间，无条件清。**
//      MV3 同一时刻只有一个服务进程，而进程活着就不会回收挂起中的 Promise ——
//      所以「模块顶层代码正在执行」本身就证明了此刻没有任何同步在跑，
//      storage 里那个 running 一定是上一个进程留下的尸体。
//
//      早先是按「心跳超过 SYNC_STALE_MS」判断的，但心跳是每翻一页推一次的
//      （就是为了顶住进程的空闲计时器），进程死的那一刻它刚被推新 ——
//      于是残骸要拖满整整 3 分钟才清。那 3 分钟里界面一直显示「正在同步」，
//      手动点刷新也只会拿到 busy、什么都不发生。这就是「卡在正在同步」。
//   2. `today` 是后加的键，老安装升级上来还没有，用现有的 daily 补一个，
//      免得胶囊在下次同步之前一直显示 0。
const startupCleanup = (async () => {
  try {
    const { sync, daily } = await chrome.storage.local.get(['sync', 'daily']);
    const patch = {};
    if (sync && sync.running) {
      patch.sync = { ...sync, running: false, progress: null };
    }
    // 每次都按 daily 重算一遍 —— 它只是缓存，重算一遍保证不会停在旧值上
    if (daily && Object.keys(daily).length) patch.today = buildToday(daily);
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  } catch {
    // 读不到就算了，runSync 自己也会按超时放行
  }
})();

chrome.runtime.onInstalled.addListener(() => {
  installAlarm();
  runSync('install');
});

chrome.runtime.onStartup.addListener(() => {
  installAlarm();
  runSync('startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') runSync('alarm');
});
