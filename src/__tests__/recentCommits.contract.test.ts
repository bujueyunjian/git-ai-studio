// 提交归因 commit 浏览器:CommitWithStats / RecentCommitsResult 与后端 wire 字段契约。
//
// 后端 src-tauri/src/commands/history.rs 的 list_recent_commits_with_stats 返回 serde
// tag = "status" 的 enum;字段改名极易让前端 narrowing 全炸,用这组测试锁死前后端 JSON shape,
// 并固定"commit 级 AI% 由三桶真实求和派生"的口径(对齐上游,不编造)。

import { describe, expect, it } from "vitest";

import type { AiStats, CommitWithStats, RecentCommitsResult } from "../lib/types";

function emptyStats(): AiStats {
  return {
    human_additions: 0,
    unknown_additions: 0,
    ai_additions: 0,
    ai_accepted: 0,
    git_diff_deleted_lines: 0,
    git_diff_added_lines: 0,
    tool_model_breakdown: {},
  };
}

function commit(sha: string, human: number, unknown: number, ai: number): CommitWithStats {
  return {
    sha,
    short: sha.slice(0, 7),
    authored_at: "2026-05-30T10:00:00+08:00",
    author_name: "mcc",
    author_email: "mcc@example.com",
    subject: `feat: ${sha}`,
    is_merge: false,
    stats: {
      ...emptyStats(),
      human_additions: human,
      unknown_additions: unknown,
      ai_additions: ai,
    },
    note_kind: null,
  };
}

describe("RecentCommitsResult 字段契约", () => {
  it("CommitWithStats 必带 sha/short/authored_at/author_*/subject/is_merge/stats", () => {
    const c = commit("abc1234def", 10, 5, 30);
    expect(c.short).toBe("abc1234");
    expect(c.author_email).toBe("mcc@example.com");
    expect(c.stats.ai_additions).toBe(30);
  });

  it("RecentCommitsResult ok 携带 commits + failed_shas + truncated", () => {
    const r: RecentCommitsResult = {
      status: "ok",
      payload: {
        commits: [commit("a", 50, 10, 0), commit("b", 0, 0, 40)],
        failed_shas: [],
        truncated: false,
        cache_hits: 2,
        took_ms: 12,
      },
    };
    if (r.status !== "ok") throw new Error("narrowing 失败");
    expect(r.payload.commits).toHaveLength(2);
    expect(r.payload.truncated).toBe(false);
  });

  it("commit 级 AI% = ai / (human+unknown+ai) 三桶真实求和(不编造分母)", () => {
    const c = commit("x", 30, 10, 60);
    const total = c.stats.human_additions + c.stats.unknown_additions + c.stats.ai_additions;
    expect(total).toBe(100);
    expect(Math.round((c.stats.ai_additions / total) * 100)).toBe(60);
  });

  it("failed_shas 非空 → 该 commit 在 commits 里以 0 桶占位,UI 必须显式提示(不当真实数据)", () => {
    const r: RecentCommitsResult = {
      status: "ok",
      payload: {
        commits: [commit("good", 10, 0, 20), commit("deadbeef", 0, 0, 0)],
        failed_shas: ["deadbeef"],
        truncated: false,
        cache_hits: 1,
        took_ms: 8,
      },
    };
    if (r.status !== "ok") throw new Error("narrowing 失败");
    expect(r.payload.failed_shas).toContain("deadbeef");
    const placeholder = r.payload.commits.find((c) => c.sha === "deadbeef");
    // 0 桶占位:total=0,前端据 failed_shas 显式标注采集失败,而非把 0% 当真
    const total =
      (placeholder?.stats.human_additions ?? 0) +
      (placeholder?.stats.unknown_additions ?? 0) +
      (placeholder?.stats.ai_additions ?? 0);
    expect(total).toBe(0);
  });

  it("RecentCommitsResult degraded 复用 repo_missing / git_ai_missing 二态", () => {
    const r: RecentCommitsResult = { status: "degraded", reason: { kind: "git_ai_missing" } };
    if (r.status === "degraded") {
      expect(r.reason.kind).toBe("git_ai_missing");
    } else {
      throw new Error("narrowing 失败");
    }
  });
});
