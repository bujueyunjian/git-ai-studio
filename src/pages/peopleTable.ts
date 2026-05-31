// People 页表格的纯逻辑:排序 + 总计求和。
// 与 PeoplePage 组件分离,既便于单测(people.contract.test),也满足 react-refresh
// 「组件文件只导出组件」的约束。

import type { PeopleTotals, PersonRow } from "../lib/types";

/**
 * 把若干 PersonRow 累加成总计(与后端 grand_total 同形)。
 * 「只看我」口径下,总览卡的总计必须由**实际展示的行**重算,否则会与表格不自洽
 * (后端 grand_total 是全作者口径)。纯函数,便于单测。
 */
export function sumRowsToTotals(rows: PersonRow[]): PeopleTotals {
  return rows.reduce<PeopleTotals>(
    (acc, r) => ({
      commits: acc.commits + r.commits,
      human_additions: acc.human_additions + r.human_additions,
      unknown_additions: acc.unknown_additions + r.unknown_additions,
      ai_additions: acc.ai_additions + r.ai_additions,
      total_additions: acc.total_additions + r.total_additions,
    }),
    {
      commits: 0,
      human_additions: 0,
      unknown_additions: 0,
      ai_additions: 0,
      total_additions: 0,
    },
  );
}

/** 可排序字段。total 与 ai_share 是派生列,但和原列一起放进同一 union 便于排序句法统一。 */
export type SortField =
  | "author_name"
  | "author_email"
  | "commits"
  | "human_additions"
  | "unknown_additions"
  | "ai_additions"
  | "total_additions"
  | "ai_share";
export type SortDir = "asc" | "desc";

/**
 * 稳定排序:本字段相等时,按 identity_key 升序兜底,保证同次输入同次输出。
 *
 * ai_share 派生列:total_additions=0 时 ratio 视作 -Infinity(desc 时排末尾)。
 * 字符串列用 localeCompare("zh-Hans") 以兼容中文姓名。
 */
export function sortRows(rows: PersonRow[], sort: { field: SortField; dir: SortDir }): PersonRow[] {
  const factor = sort.dir === "asc" ? 1 : -1;
  // slice 一份避免改原数组
  const out = rows.slice();
  out.sort((a, b) => {
    const cmp = compareByField(a, b, sort.field) * factor;
    if (cmp !== 0) return cmp;
    // 兜底:identity_key 升序(稳定性锚点)
    return a.identity_key.localeCompare(b.identity_key);
  });
  return out;
}

function compareByField(a: PersonRow, b: PersonRow, field: SortField): number {
  switch (field) {
    case "author_name":
      return a.author_name.localeCompare(b.author_name, "zh-Hans");
    case "author_email":
      return a.author_email.localeCompare(b.author_email);
    case "commits":
      return a.commits - b.commits;
    case "human_additions":
      return a.human_additions - b.human_additions;
    case "unknown_additions":
      return a.unknown_additions - b.unknown_additions;
    case "ai_additions":
      return a.ai_additions - b.ai_additions;
    case "total_additions":
      return a.total_additions - b.total_additions;
    case "ai_share": {
      const ra = a.total_additions > 0 ? a.ai_additions / a.total_additions : -Infinity;
      const rb = b.total_additions > 0 ? b.ai_additions / b.total_additions : -Infinity;
      return ra - rb;
    }
  }
}
