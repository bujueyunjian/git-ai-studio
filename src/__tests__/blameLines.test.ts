// deriveBlameLines 单测:BlamePayload → 逐行渲染数据的纯派生。
// 覆盖主路径(AI 行标模型 / 人写行标作者)+ 边界(空 payload / 异常 key / 区间)。

import { describe, expect, it } from "vitest";

import { deriveBlameLines, parseLRange } from "../lib/blameLines";
import type { BlameHunk, BlamePayload, BlamePromptRecord } from "../lib/types";

function hunk(partial: Partial<BlameHunk> & Pick<BlameHunk, "range">): BlameHunk {
  return {
    commit_sha: "0123456789abcdef",
    abbrev_sha: "0123456",
    original_author: "Alice",
    author_time: 1_700_000_000,
    author_tz: "+0000",
    ai_human_author: null,
    ...partial,
  };
}

function prompt(tool: string, model: string): BlamePromptRecord {
  return {
    agent_id: { tool, id: "p-1", model },
    human_author: null,
    total_additions: 0,
    total_deletions: 0,
    accepted_lines: 0,
    overriden_lines: 0,
    other_files: [],
    commits: [],
  };
}

describe("deriveBlameLines", () => {
  it("空 payload → 两个空 Map", () => {
    const { aiLines, lineAuthors } = deriveBlameLines(null);
    expect(aiLines.size).toBe(0);
    expect(lineAuthors.size).toBe(0);
  });

  it("AI 行标模型(tool::model)+ ai tone,人写行标 git 作者 + human tone", () => {
    const payload: BlamePayload = {
      lines: { "2-3": "p1" },
      prompts: { p1: prompt("claude_code", "claude-sonnet-4-5") },
      metadata: { is_logged_in: false, current_user: null },
      hunks: [hunk({ range: [1, 4], original_author: "Bob" })],
    };
    const { aiLines, lineAuthors } = deriveBlameLines(payload);

    // 2-3 行命中 AI prompt
    expect(aiLines.get(2)).toBe("p1");
    expect(aiLines.get(3)).toBe("p1");
    expect(aiLines.has(1)).toBe(false);

    // AI 行:label=model、tone=ai、title 含 tool::model
    expect(lineAuthors.get(2)).toEqual({
      label: "claude-sonnet-4-5",
      tone: "ai",
      title: "AI: claude_code::claude-sonnet-4-5",
    });
    // 人写行:label=作者、tone=human
    expect(lineAuthors.get(1)?.tone).toBe("human");
    expect(lineAuthors.get(1)?.label).toBe("Bob");
    expect(lineAuthors.get(4)?.tone).toBe("human");
  });

  it("AI 行但 prompt 记录缺失 → 退回 tool=ai、title=AI", () => {
    const payload: BlamePayload = {
      lines: { "1": "missing" },
      prompts: {},
      metadata: { is_logged_in: false, current_user: null },
      hunks: [hunk({ range: [1, 1] })],
    };
    const { lineAuthors } = deriveBlameLines(payload);
    expect(lineAuthors.get(1)).toEqual({ label: "ai", tone: "ai", title: "AI" });
  });

  it("异常 lines key(0 / 多段 / 非数字 / 逆序)全部忽略", () => {
    const payload: BlamePayload = {
      lines: { "0": "z", "5-3": "inv", abc: "bad", "10-12,20": "multi", "7": "ok" },
      prompts: {},
      metadata: { is_logged_in: false, current_user: null },
      hunks: [],
    };
    const { aiLines } = deriveBlameLines(payload);
    expect(aiLines.size).toBe(1);
    expect(aiLines.get(7)).toBe("ok");
  });
});

describe("parseLRange(Stats 深链 ?L=<a>-<b>)", () => {
  it("合法区间", () => {
    expect(parseLRange("12-34")).toEqual([12, 34]);
    expect(parseLRange(" 5-5 ")).toEqual([5, 5]);
  });
  it("空 / 缺省 → null", () => {
    expect(parseLRange(null)).toBeNull();
    expect(parseLRange(undefined)).toBeNull();
    expect(parseLRange("")).toBeNull();
  });
  it("非法格式 / 越界 / 逆序 → null(不静默纠正)", () => {
    expect(parseLRange("abc")).toBeNull();
    expect(parseLRange("12")).toBeNull();
    expect(parseLRange("0-5")).toBeNull();
    expect(parseLRange("9-3")).toBeNull();
    expect(parseLRange("1-2-3")).toBeNull();
  });
});
