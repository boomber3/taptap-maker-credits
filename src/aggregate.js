/**
 * 流水 → 聚合桶。纯函数，不碰 chrome.*，因此可以在 Node 里直接跑测试。
 *
 * 存储结构：
 *   daily  { "2026-09-20": { "<productId>": 消耗积分 } }
 *   hourly { "2026-09-20": { "13": { "<productId>": 消耗积分 } } }
 * 只存聚合值，不存原始流水 —— 一万多条流水全留会越滚越大，而图表只需要桶。
 */

import { dayKey, parseKind, parseProjectName } from './util.js';

/**
 * 消耗记录的 type 取值。
 * 已拿全量流水逐条核对：type===1 的 amount 求和 === /credits/info 的 totalConsumed。
 * type 2/7/10/11/14/15/16/20 是每小时恢复、活动赠送、套餐变更等，不能计入消耗。
 */
export const CONSUME_TYPE = 1;

export function bump(bucket, key, pid, amount) {
  const row = bucket[key] || (bucket[key] = {});
  row[pid] = (row[pid] || 0) + amount;
}

/** 和 bump 同构，只是第二层键换成消耗分类 */
function bumpKind(bucket, key, kind, amount) {
  const row = bucket[key] || (bucket[key] = {});
  row[kind] = (row[kind] || 0) + amount;
}

/**
 * 写入一条流水；返回它是否被计为消耗。
 *
 * 同时记两套桶：按项目的，和按类型的。两套都从同一笔流水算出来，
 * 所以它们的合计必然相等 —— 类型构成那张卡片才敢和总数对照。
 */
export function ingestOne(ctx, tx) {
  if (!tx || tx.type !== CONSUME_TYPE) return false;
  const amount = Number(tx.amount) || 0;
  if (amount <= 0) return false;

  const when = new Date(tx.createdTime * 1000);
  const day = dayKey(when);
  const hour = String(when.getHours());
  const pid = tx.productId || '__unknown__';

  bump(ctx.daily, day, pid, amount);
  bump(ctx.hourly[day] || (ctx.hourly[day] = {}), hour, pid, amount);

  const kindDaily = ctx.kindDaily || (ctx.kindDaily = {});
  const kindHourly = ctx.kindHourly || (ctx.kindHourly = {});
  const kind = parseKind(tx.remark);
  bumpKind(kindDaily, day, kind, amount);
  bumpKind(kindHourly[day] || (kindHourly[day] = {}), hour, kind, amount);

  const name = parseProjectName(tx.remark);
  if (name && !ctx.projects[pid]) ctx.projects[pid] = name;
  return true;
}

/**
 * 从一页流水里挑出比基线更新的那些。
 *
 * 基线必须在**整轮同步开始时固定一次**，绝不能在遍历里抬高它 ——
 * 流水是按 id 递减排列的，边遍历边把基准提到刚入库那条的 id，
 * 同页后面所有新记录都会被判成「已入库」跳过，一次同步只入库一条。
 * （这个 bug 真实发生过：安装之后的新流水几乎全漏。）
 */
export function freshRecords(list, baselineId) {
  const fresh = [];
  let reachedKnown = false;
  for (const tx of list) {
    if (tx.id <= baselineId) {
      reachedKnown = true;
      continue;
    }
    fresh.push(tx);
  }
  return { fresh, reachedKnown };
}

/** 小时级明细只留最近若干天，日级永久保留 */
export function pruneHourly(hourly, keepDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffKey = dayKey(cutoff);
  for (const day of Object.keys(hourly)) {
    if (day < cutoffKey) delete hourly[day];
  }
}
