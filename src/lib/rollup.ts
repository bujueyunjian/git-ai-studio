import type { DailyBucket } from "./types";

/** 时间粒度。Dashboard(M4)的日/周/月切换 = 对同一份 daily_buckets 做纯前端 rollup,不重取数。 */
export type Granularity = "day" | "week" | "month";

/**
 * 把后端的日级 `daily_buckets` rollup 到 日/周/月(M3 提供,M4 消费)。
 *
 * - **周首 = 周一**:与后端 `history.rs::start_of_week`(num_days_from_monday)一致;按"周一日期串"
 *   分组,**不用 ISO 周号**,避免"跨年第几周"的歧义。
 * - 三桶(human/unknown/ai)+ commit_count **直接相加**;AI 占比由 UI 层按 sum 重算,
 *   **绝不在此预存率**(防"各桶先算率再平均")。
 * - 纯函数、无副作用,便于单测。
 */
export function rollupBuckets(daily: DailyBucket[], granularity: Granularity): DailyBucket[] {
  if (granularity === "day") return daily;
  const grouped = new Map<string, DailyBucket>();
  for (const b of daily) {
    const key = granularity === "week" ? mondayOf(b.date) : monthOf(b.date);
    const cur = grouped.get(key);
    if (cur) {
      cur.human_additions += b.human_additions;
      cur.unknown_additions += b.unknown_additions;
      cur.ai_additions += b.ai_additions;
      cur.commit_count += b.commit_count;
    } else {
      grouped.set(key, {
        date: key,
        human_additions: b.human_additions,
        unknown_additions: b.unknown_additions,
        ai_additions: b.ai_additions,
        commit_count: b.commit_count,
      });
    }
  }
  // date 是 YYYY-MM-DD,字典序即时间序。
  return Array.from(grouped.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/** `YYYY-MM-DD` 所在周的周一日期串。周日(getDay()=0)回退 6 天,其余回退 (weekday-1) 天。 */
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00`); // 无时区后缀 ⇒ 按本地时间解析,与后端本地分桶一致
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return toISODate(d);
}

/** `YYYY-MM-DD` → 当月首日 `YYYY-MM-01`。 */
function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
