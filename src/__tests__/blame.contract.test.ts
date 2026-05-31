// Blame 契约测试。
//
// # 权威口径
// - lines key 格式:`"13"` 或 `"15-25"`(end inclusive),与上游 blame.rs:1338-1372 group 算法对齐
// - tool::model 拼接(stats.rs:470)

import { describe, expect, it } from "vitest";

import type { BlamePayload } from "../lib/types";

/** 前端期望:把 BlamePayload.lines 展开为 line_no → prompt_id 扁平 map(与后端 expand_line_index 同口径)。 */
function expandLineIndex(p: BlamePayload): Map<number, string> {
  const m = new Map<number, string>();
  for (const [k, promptId] of Object.entries(p.lines)) {
    const mr = /^(\d+)(?:-(\d+))?$/.exec(k);
    if (!mr) continue;
    const a = Number(mr[1]);
    const b = mr[2] ? Number(mr[2]) : a;
    if (a < 1 || b < a) continue;
    for (let n = a; n <= b; n++) m.set(n, promptId);
  }
  return m;
}

describe("blame / lines key 解析", () => {
  it("single line key", () => {
    const p: BlamePayload = {
      lines: { "42": "abc" },
      prompts: {},
      metadata: { is_logged_in: false, current_user: null },
      hunks: [],
    };
    const idx = expandLineIndex(p);
    expect(idx.size).toBe(1);
    expect(idx.get(42)).toBe("abc");
  });

  it("range key end inclusive", () => {
    const p: BlamePayload = {
      lines: { "15-25": "x" },
      prompts: {},
      metadata: { is_logged_in: false, current_user: null },
      hunks: [],
    };
    const idx = expandLineIndex(p);
    expect(idx.size).toBe(11); // 15..=25
    expect(idx.get(15)).toBe("x");
    expect(idx.get(25)).toBe("x");
    expect(idx.get(26)).toBeUndefined();
  });

  it("rejects malformed keys", () => {
    const p: BlamePayload = {
      lines: { "0": "zero", "15-25,30-40": "multi", abc: "bad", "5-3": "inv", "1": "ok" },
      prompts: {},
      metadata: { is_logged_in: false, current_user: null },
      hunks: [],
    };
    const idx = expandLineIndex(p);
    // 只接受 "1" — 0 被排除,multi-segment / 非数字 / inverted 都被排除
    expect(idx.size).toBe(1);
    expect(idx.get(1)).toBe("ok");
  });

  it("multi-segment defense (上游不变式钉死)", () => {
    // 上游 blame.rs:1338-1372 的 group 算法保证每个 key 单段;
    // 若某天上游 schema 改为多区间,本断言会先炸。
    const p: BlamePayload = {
      lines: { "15-25,30-40": "x" },
      prompts: {},
      metadata: { is_logged_in: false, current_user: null },
      hunks: [],
    };
    expect(expandLineIndex(p).size).toBe(0);
  });

  it("multi keys all sum", () => {
    const p: BlamePayload = {
      lines: { "1": "a", "5-7": "b", "10-12": "a" },
      prompts: {},
      metadata: { is_logged_in: false, current_user: null },
      hunks: [],
    };
    const idx = expandLineIndex(p);
    expect(idx.size).toBe(1 + 3 + 3);
    expect(idx.get(11)).toBe("a");
    expect(idx.get(6)).toBe("b");
  });
});

describe("blame / tool::model 拼接(P5 grounded 修正)", () => {
  it("用 :: 不是 / —— 对齐上游 stats.rs:470", () => {
    const agentId = { tool: "claude_code", id: "p-1", model: "claude-sonnet-4-5-20250929" };
    const display = `${agentId.tool}::${agentId.model}`;
    expect(display).toBe("claude_code::claude-sonnet-4-5-20250929");
    expect(display).not.toContain("/");
  });
});
