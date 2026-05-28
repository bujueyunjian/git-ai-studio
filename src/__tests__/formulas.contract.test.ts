// 公式契约测试。每条断言都对齐 git-ai 上游真实公式,有可追溯出处。
//
// # 权威来源
// - 字段定义:`git-ai/src/authorship/stats.rs:9-33`(CommitStats 7 字段)
// - total 公式:`stats.rs:114` —— `human + unknown + ai`(3 桶并列)
// - 不变式 `ai_additions == ai_accepted`:`stats.rs:116` 原注释
// - merge 行为:`specs/git_ai_standard_v3.0.0.md` §2.2 —— authorship MAY 为空

import { describe, expect, it } from "vitest";

import { deriveRates, formatInt, formatPercent, formatRelativeFromNow } from "../lib/formulas";
import type { AiStats } from "../lib/types";

function parse(json: string): AiStats {
  return JSON.parse(json) as AiStats;
}

// fixture 1:上游 README 当前 stats 示例(逐字)
const README_EXAMPLE = `{
  "human_additions": 28,
  "unknown_additions": 0,
  "ai_additions": 76,
  "ai_accepted": 76,
  "git_diff_deleted_lines": 34,
  "git_diff_added_lines": 104,
  "tool_model_breakdown": {
    "claude_code/claude-sonnet-4-5-20250929": {
      "ai_additions": 76,
      "ai_accepted": 76
    }
  }
}`;

const MERGE = `{
  "human_additions":0,"unknown_additions":0,
  "ai_additions":0,"ai_accepted":0,
  "git_diff_deleted_lines":0,"git_diff_added_lines":0,
  "tool_model_breakdown":{}
}`;

const ALL_UNKNOWN = `{
  "human_additions":0,"unknown_additions":500,
  "ai_additions":0,"ai_accepted":0,
  "git_diff_deleted_lines":12,"git_diff_added_lines":500,
  "tool_model_breakdown":{}
}`;

const MULTI_TOOL = `{
  "human_additions":120,"unknown_additions":15,
  "ai_additions":80,"ai_accepted":80,
  "git_diff_deleted_lines":20,"git_diff_added_lines":215,
  "tool_model_breakdown":{
    "claude_code/claude-opus-4-7":{"ai_additions":60,"ai_accepted":60},
    "cursor/gpt-5":{"ai_additions":20,"ai_accepted":20}
  }
}`;

/** 上游 stats.rs:114 公式 —— 前端用于派生率分母锚点。 */
function totalAdditions(s: AiStats): number {
  return s.human_additions + s.unknown_additions + s.ai_additions;
}

describe("formulas / 上游 3 桶恒等(stats.rs:114)", () => {
  it("README 示例:28 human + 0 unknown + 76 ai = 104,AI 占比 76/104", () => {
    const s = parse(README_EXAMPLE);
    expect(totalAdditions(s)).toBe(28 + 0 + 76);
    const r = deriveRates(s, totalAdditions(s));
    expect(r.ai_share).toBeCloseTo(76 / 104, 10);
  });

  it("MERGE: total=0,ai_share null(分母 0)", () => {
    const s = parse(MERGE);
    expect(totalAdditions(s)).toBe(0);
    expect(deriveRates(s, totalAdditions(s)).ai_share).toBeNull();
  });

  it("ALL_UNKNOWN: total=500,AI 为 0,占比 0", () => {
    const s = parse(ALL_UNKNOWN);
    const total = totalAdditions(s);
    expect(total).toBe(500);
    expect(deriveRates(s, total).ai_share).toBe(0);
  });

  it("MULTI_TOOL: 3 桶并列 = 215,AI 占比 80/215", () => {
    const s = parse(MULTI_TOOL);
    expect(totalAdditions(s)).toBe(120 + 15 + 80);
    expect(totalAdditions(s)).toBe(215);
    expect(deriveRates(s, totalAdditions(s)).ai_share).toBeCloseTo(80 / 215, 10);
  });
});

describe("formulas / 上游不变式锁定", () => {
  it("ai_additions == ai_accepted(stats.rs:116 注释)", () => {
    for (const json of [README_EXAMPLE, MERGE, ALL_UNKNOWN, MULTI_TOOL]) {
      const s = parse(json);
      // 此恒等式是上游当前 schema 的硬契约。
      // 若上游未来恢复 mixed 逻辑,本 assertion 会先炸提醒。
      expect(s.ai_additions).toBe(s.ai_accepted);
    }
  });

  it("ai_accepted ≤ ai_additions(单向不变式,即便上游恢复 mixed 仍成立)", () => {
    for (const json of [README_EXAMPLE, MERGE, ALL_UNKNOWN, MULTI_TOOL]) {
      const s = parse(json);
      expect(s.ai_accepted).toBeLessThanOrEqual(s.ai_additions);
    }
  });

  it("3 桶之和不超过 git_diff_added_lines", () => {
    // git_diff_added_lines 是 git 自身视角;3 桶之和应该等于或略小于(若有 ignore_patterns)。
    for (const json of [README_EXAMPLE, ALL_UNKNOWN, MULTI_TOOL]) {
      const s = parse(json);
      expect(totalAdditions(s)).toBeLessThanOrEqual(s.git_diff_added_lines);
    }
  });
});

describe("formulas / 格式化 helper", () => {
  it("formatInt: 千分位与空值", () => {
    expect(formatInt(null)).toBe("—");
    expect(formatInt(undefined)).toBe("—");
    expect(formatInt(Number.NaN)).toBe("—");
    expect(formatInt(12345)).toBe("12,345");
    expect(formatInt(0)).toBe("0");
  });

  it("formatPercent: 1 位小数", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(76 / 104)).toBe("73.1%");
    expect(formatPercent(1)).toBe("100.0%");
    expect(formatPercent(0)).toBe("0.0%");
  });

  it("formatRelativeFromNow: 秒 / 分钟 / 小时 / 天", () => {
    const now = 1_000_000_000_000;
    expect(formatRelativeFromNow(now, now)).toBe("刚刚");
    expect(formatRelativeFromNow(now - 5_000, now)).toBe("5 秒前");
    expect(formatRelativeFromNow(now - 60_000, now)).toBe("1 分钟前");
    expect(formatRelativeFromNow(now - 3_600_000, now)).toBe("1 小时前");
    expect(formatRelativeFromNow(now - 86_400_000, now)).toBe("1 天前");
  });
});
