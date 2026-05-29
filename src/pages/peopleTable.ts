// People 页表格的纯逻辑:搜索 / 排序 / CSV 导出。
// 与 PeoplePage 组件分离,既便于单测(people.contract.test),也满足 react-refresh
// 「组件文件只导出组件」的约束。

import i18n from "../i18n";
import type { PersonRow } from "../lib/types";

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

/** 大小写不敏感的子串匹配,对 name + email 都试。空 query 全保留。 */
export function filterRows(rows: PersonRow[], rawQuery: string): PersonRow[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) => r.author_name.toLowerCase().includes(q) || r.author_email.toLowerCase().includes(q),
  );
}

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

/** CSV 表头与数据列一一对齐。字段含逗号 / 双引号 / 换行时按 RFC 4180 转义。 */
export function buildCsv(rows: PersonRow[]): string {
  const headers = [
    i18n.t("people.tableHeaders.authorName"),
    i18n.t("people.tableHeaders.authorEmail"),
    i18n.t("people.tableHeaders.commits"),
    i18n.t("people.tableHeaders.humanAdditions"),
    i18n.t("people.tableHeaders.unknownAdditions"),
    i18n.t("people.tableHeaders.aiAdditions"),
    i18n.t("people.tableHeaders.totalAdditions"),
    i18n.t("people.tableHeaders.aiShare"),
  ];
  const lines: string[] = [headers.map(csvCell).join(",")];
  for (const r of rows) {
    const aiShare = r.total_additions > 0 ? r.ai_additions / r.total_additions : null;
    lines.push(
      [
        r.author_name,
        r.author_email,
        String(r.commits),
        String(r.human_additions),
        String(r.unknown_additions),
        String(r.ai_additions),
        String(r.total_additions),
        aiShare === null ? "" : (aiShare * 100).toFixed(1) + "%",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // Excel 兼容:带 UTF-8 BOM,中文姓名不乱码
  return "﻿" + lines.join("\r\n");
}

function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
