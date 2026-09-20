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
