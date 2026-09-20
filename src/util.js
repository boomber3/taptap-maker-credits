/**
 * 后台与仪表盘共用的纯函数。
 * dayKey 尤其重要：两边一旦算法不一致，「今天」的按小时视图会静默查不到数据。
 */

/**
 * 一轮同步多久没动静，就当它是残骸。
 *
 * 判据是 `sync.runningSince` —— 那是**心跳**时间戳（每翻一页推一次），
 * 不是这轮什么时候开始的。服务进程被系统回收时来不及跑 finally，`running`
 * 会永远停在 true，界面和后台都靠这个阈值把它认出来。
 *
 * 三处必须共用同一个值：background.js 决定放不放行新一轮，dashboard.js 和
 * panel.js 决定还要不要显示「正在同步」。**口径曾经不一致**：界面按 3 分钟
 * 判死、后台按 5 分钟拦着，中间那两分钟界面写着「点 ↻ 重新开始」，点了却
 * 因为 busy 什么都不发生 —— 看起来就是卡死在「正在同步」。
 *
 * 3 分钟已经很宽松：正常一轮心跳间隔不到半分钟（每页一次，单次请求 20 秒超时）。
 */
export const SYNC_STALE_MS = 3 * 60_000;

/** 本地时区的 YYYY-MM-DD。积分页的「今天」按本地时间算，不是 UTC */
export function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 最近 n 天的日期键，含今天，从旧到新 */
export function recentDayKeys(n) {
  const keys = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i -= 1) {
    const day = new Date(base);
    day.setDate(base.getDate() - i);
    keys.push(dayKey(day));
  }
  return keys;
}

/** remark 形如「项目 (示例游戏) 对话消耗」；项目被删时 apps 接口查不到，靠这里兜底 */
export function parseProjectName(remark) {
  if (typeof remark !== 'string') return null;
  const m = remark.match(/^项目\s*[（(](.+?)[）)]/);
  return m ? m[1].trim() : null;
}

/**
 * 消耗的分类，顺序即展示顺序。
 * 放这里而不是 aggregate.js，是因为仪表盘也要用它（名称和顺序）——
 * 两处各写一份迟早会对不上。
 */
export const KINDS = [
  { id: 'chat', name: '对话' },
  { id: 'image', name: '图片' },
  { id: 'video', name: '视频' },
  // id 保持 'other' 不跟着改：它已经写进存储的键名了，改名要重建一次数据，
  // 而这里改的只是给人看的标签。目前落进这个桶的**全部**是音效和音乐
  // （全量核对过，量极小），以后接口若新增类型也会落到这里 ——
  // 那时得给它加一条明确的识别规则，不能再叫音效/音乐。
  { id: 'other', name: '音效/音乐' },
];

/**
 * 消耗的类型：对话 / 图片 / 视频 / 其他。
 *
 * 接口实际会写 6 种（对话、生成图片、编辑图片、生成视频、生成音效、生成音乐），
 * 音效和音乐归入「其他」—— 它们量极小，但**必须有地方去**，
 * 否则这部分消耗会凭空消失，类型合计和总数就对不上了。
 *
 * 注意顺序：先切掉「项目 (名字)」再匹配。项目名里带「图片」「视频」这类词
 * 完全可能，不切掉就会把「图片大亨」这个项目说成生图消耗。
 */
export function parseKind(remark) {
  if (typeof remark !== 'string') return 'other';
  const rest = remark.replace(/^项目\s*[（(][^）)]*[）)]/, '');
  if (/对话/.test(rest)) return 'chat';
  if (/视频/.test(rest)) return 'video';
  if (/图片/.test(rest)) return 'image';
  return 'other'; // 音效、音乐，以及以后新增的类型
}

function tidy(v) {
  return (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

/** 1,284 / 1.3万 / 1.2亿 */
export function formatCompact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${tidy(n / 1e8)}亿`;
  if (abs >= 1e4) return `${tidy(n / 1e4)}万`;
  return Math.round(n).toLocaleString('zh-CN');
}

export function formatExact(n) {
  return Math.round(n).toLocaleString('zh-CN');
}

/**
 * 同一根 Y 轴必须用同一个单位。
 * 否则 5000 显示成「5,000」而 10000 显示成「1万」，一根轴上混着两种进位读起来很别扭。
 */
export function makeAxisFormatter(top) {
  if (top >= 1e8) return (v) => (v === 0 ? '0' : `${tidy(v / 1e8)}亿`);
  if (top >= 1e4) return (v) => (v === 0 ? '0' : `${tidy(v / 1e4)}万`);
  return (v) => Math.round(v).toLocaleString('zh-CN');
}

/** 「9月20日」 */
export function formatDayLabel(key) {
  const [, m, d] = key.split('-');
  return `${Number(m)}月${Number(d)}日`;
}
