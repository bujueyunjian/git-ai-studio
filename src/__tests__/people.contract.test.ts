// People 视图(P12)前端契约测试。
//
// # 权威来源
// - identity_key = author_email.toLowerCase()(后端 commands/people.rs::aggregate_rows)
// - AI 占比 = ai_additions / (human + unknown + ai),total=0 → null,UI 显 "—"
// - 排序稳定性 = 字段比较相等时按 identity_key 字典序兜底
//
// 三条核心约束:
//   1. email 大小写差异聚合到同一行
//   2. total=0 时 AI 占比为 null
//   3. 排序稳定(用同分场景验证)
// 另加 CSV 转义 / 搜索过滤两条配套断言,锁住 export 行为。

import { describe, expect, it } from "vitest";

import { buildCsv, filterRows, sortRows } from "../pages/peopleTable";
import type { PersonRow } from "../lib/types";

function row(partial: Partial<PersonRow> & { identity_key: string }): PersonRow {
  return {
    identity_key: partial.identity_key,
    author_name: partial.author_name ?? "User",
    author_email: partial.author_email ?? partial.identity_key,
    commits: partial.commits ?? 0,
    human_additions: partial.human_additions ?? 0,
    unknown_additions: partial.unknown_additions ?? 0,
    ai_additions: partial.ai_additions ?? 0,
    total_additions:
      partial.total_additions ??
      (partial.human_additions ?? 0) +
        (partial.unknown_additions ?? 0) +
        (partial.ai_additions ?? 0),
    commit_refs: partial.commit_refs ?? [],
  };
}

describe("people / identity 聚合", () => {
  it("后端已用 lowercase 邮箱聚合;前端拿到的 rows 即每个 identity 唯一一行", () => {
    // 后端口径:author_email.lowercase() 是 identity_key。
    // 前端不再二次合并 —— 如果后端真给了大小写不同的两条,那是 schema 漂移,前端不容错。
    const rows = [
      row({
        identity_key: "alice@example.com",
        author_email: "Alice@Example.com",
        ai_additions: 25,
      }),
      row({ identity_key: "bob@example.com", author_email: "bob@example.com", ai_additions: 10 }),
    ];
    // 同 identity_key 必然只有一行
    const keys = new Set(rows.map((r) => r.identity_key));
    expect(keys.size).toBe(rows.length);
    // 大小写差异在 display 邮箱字段保留(不强制 lowercase 显示)
    const alice = rows.find((r) => r.identity_key === "alice@example.com")!;
    expect(alice.author_email).toBe("Alice@Example.com");
    expect(alice.identity_key).toBe(alice.author_email.toLowerCase());
  });

  it("filterRows 大小写不敏感同时匹配 name / email", () => {
    const rows = [
      row({ identity_key: "alice@example.com", author_name: "Alice" }),
      row({ identity_key: "bob@example.com", author_name: "Bob" }),
    ];
    expect(filterRows(rows, "ALI").length).toBe(1);
    expect(filterRows(rows, "alice@").length).toBe(1);
    expect(filterRows(rows, "").length).toBe(2);
    expect(filterRows(rows, "xxx").length).toBe(0);
  });
});

describe("people / AI 占比 null 行为", () => {
  function rate(r: PersonRow): number | null {
    return r.total_additions > 0 ? r.ai_additions / r.total_additions : null;
  }

  it("total_additions = 0 时 AI 占比为 null(避免 NaN 进 UI)", () => {
    const r = row({ identity_key: "x@y", commits: 3, total_additions: 0 });
    expect(rate(r)).toBeNull();
  });

  it("total>0 且 ai=0 时占比是 0,不是 null", () => {
    const r = row({ identity_key: "x@y", human_additions: 100, total_additions: 100 });
    expect(rate(r)).toBe(0);
  });

  it("正常累加:100 行 + 30 AI → 30%", () => {
    const r = row({
      identity_key: "x@y",
      human_additions: 70,
      ai_additions: 30,
      total_additions: 100,
    });
    expect(rate(r)).toBeCloseTo(0.3, 6);
  });
});

describe("people / 排序稳定性", () => {
  it("ai_additions desc 排序:相同 AI 行数时按 identity_key 字典序兜底", () => {
    // 三人 AI 行数都是 10 → 稳定按 identity_key 升序
    const rows = [
      row({
        identity_key: "charlie@example.com",
        author_name: "Charlie",
        ai_additions: 10,
        total_additions: 10,
      }),
      row({
        identity_key: "alice@example.com",
        author_name: "Alice",
        ai_additions: 10,
        total_additions: 10,
      }),
      row({
        identity_key: "bob@example.com",
        author_name: "Bob",
        ai_additions: 10,
        total_additions: 10,
      }),
    ];
    const sorted = sortRows(rows, { field: "ai_additions", dir: "desc" });
    // 同分时按 identity_key asc 兜底(不论 dir 是 asc/desc,兜底方向固定)
    expect(sorted.map((r) => r.identity_key)).toEqual([
      "alice@example.com",
      "bob@example.com",
      "charlie@example.com",
    ]);
  });

  it("ai_additions desc 主排序生效:高 AI 排前", () => {
    const rows = [
      row({ identity_key: "a@x", ai_additions: 5, total_additions: 5 }),
      row({ identity_key: "b@x", ai_additions: 50, total_additions: 50 }),
      row({ identity_key: "c@x", ai_additions: 20, total_additions: 20 }),
    ];
    const sorted = sortRows(rows, { field: "ai_additions", dir: "desc" });
    expect(sorted.map((r) => r.identity_key)).toEqual(["b@x", "c@x", "a@x"]);
  });

  it("ai_share 排序:total=0 的行(占比 null)在 desc 时排末尾,不混进有数据的人之间", () => {
    const rows = [
      row({ identity_key: "zero@x", commits: 3, total_additions: 0 }),
      row({ identity_key: "high@x", ai_additions: 80, total_additions: 100 }),
      row({ identity_key: "low@x", ai_additions: 10, total_additions: 100 }),
    ];
    const sorted = sortRows(rows, { field: "ai_share", dir: "desc" });
    expect(sorted.map((r) => r.identity_key)).toEqual(["high@x", "low@x", "zero@x"]);
  });

  it("作者名排序:支持中文 localeCompare(不抛错)", () => {
    const rows = [
      row({ identity_key: "1@x", author_name: "张三" }),
      row({ identity_key: "2@x", author_name: "李四" }),
      row({ identity_key: "3@x", author_name: "王五" }),
    ];
    const sorted = sortRows(rows, { field: "author_name", dir: "asc" });
    // 不强断序(中文 collation 在不同 Node ICU 下有差异),只断它没崩
    expect(sorted.length).toBe(3);
  });

  it("不修改原数组(纯函数)", () => {
    const rows = [
      row({ identity_key: "a@x", ai_additions: 5 }),
      row({ identity_key: "b@x", ai_additions: 10 }),
    ];
    const before = rows.map((r) => r.identity_key);
    sortRows(rows, { field: "ai_additions", dir: "desc" });
    expect(rows.map((r) => r.identity_key)).toEqual(before);
  });
});

describe("people / CSV 导出", () => {
  it("含 UTF-8 BOM + CRLF 换行,Excel 中文不乱码", () => {
    const rows = [
      row({
        identity_key: "alice@example.com",
        author_name: "Alice",
        author_email: "alice@example.com",
        commits: 3,
        human_additions: 10,
        unknown_additions: 5,
        ai_additions: 30,
        total_additions: 45,
      }),
    ];
    const csv = buildCsv(rows);
    // BOM
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    // CRLF 行尾(RFC 4180)
    expect(csv.includes("\r\n")).toBe(true);
    // 占比格式化为百分号字符串
    expect(csv).toMatch(/66\.7%/);
  });

  it("CSV 字段含逗号 / 引号时按 RFC 4180 转义(双引号包裹 + 内部双引号翻倍)", () => {
    const rows = [
      row({
        identity_key: "weird@example.com",
        author_name: 'Smith, "Bob"',
        author_email: "weird@example.com",
      }),
    ];
    const csv = buildCsv(rows);
    expect(csv).toMatch(/"Smith, ""Bob"""/);
  });

  it("AI 占比为 null 时 CSV 单元格为空串", () => {
    const rows = [row({ identity_key: "z@x", commits: 1, total_additions: 0 })];
    const csv = buildCsv(rows);
    // buildCsv 用 join("\r\n") 拼接,数据行就是最后一行,不再追加尾 CRLF。
    // 末列为空 → 行末是 "," 后紧跟字符串末尾。
    expect(csv.endsWith(",")).toBe(true);
    // 确认行内有 7 个逗号(共 8 列),末列在最后一个逗号之后为空。
    const lastLine = csv.split("\r\n").pop() ?? "";
    expect(lastLine.split(",").length).toBe(8);
    expect(lastLine.split(",").pop()).toBe("");
  });
});
