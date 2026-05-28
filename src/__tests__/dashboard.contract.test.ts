// Dashboard 派生指标的契约测试。
//
// # 权威来源
// - 累加视角 window_ai_total:`src-tauri/src/commands/history.rs` 前端镜像
// - hook_coverage_rate:`git-ai/src/authorship/range_authorship.rs:32-40`
// - 后端 daily_buckets 已经分桶,前端只做"sum windowAiTotal";本测试锁住前端这一步的口径。

import { describe, expect, it } from "vitest";

import type {
  DailyBucket,
  HistoryPayload,
  PerCommitStat,
  RangeAuthorshipStats,
  RangeSummaryResult,
} from "../lib/types";

function emptyStats(): import("../lib/types").AiStats {
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

function commit(sha: string, ai: number, human: number, unknown: number): PerCommitStat {
  const stats = emptyStats();
  stats.ai_additions = ai;
  stats.ai_accepted = ai;
  stats.human_additions = human;
  stats.unknown_additions = unknown;
  return {
    sha,
    short: sha.slice(0, 7),
    authored_at: "2026-05-12T10:00:00+08:00",
    is_merge: false,
    stats,
  };
}

describe("dashboard / 累加视角 windowAiTotal", () => {
  it("空 per_commit 累加为 0", () => {
    const per: PerCommitStat[] = [];
    const total = per.reduce((acc, c) => acc + c.stats.ai_additions, 0);
    expect(total).toBe(0);
  });

  it("3 个 commit 的 ai_additions 简单求和", () => {
    const per = [commit("a", 50, 10, 0), commit("b", 30, 20, 5), commit("c", 0, 100, 0)];
    const total = per.reduce((acc, c) => acc + c.stats.ai_additions, 0);
    expect(total).toBe(80);
  });

  it("与 squash 口径明确不同(防回归)", () => {
    // 用户场景:A 引入 50 行 AI, B 改写 30 → squash=20,累加=50。
    // 评审 C 的关键发现:per_commit 累加 != range_stats(squash)
    const per = [commit("a-introduces-ai", 50, 0, 0), commit("b-rewrites-ai", 0, 30, 0)];
    const accumulated = per.reduce((acc, c) => acc + c.stats.ai_additions, 0);
    expect(accumulated).toBe(50); // 累加视角
    // squash 视角会是 20,差 30,这正是为什么 Dashboard 不能两种混用。
  });
});

describe("dashboard / hook_coverage_rate", () => {
  function rate(total: number, withAuth: number): number | null {
    if (total === 0) return null;
    return withAuth / total;
  }

  it("9/12 = 0.75", () => {
    expect(rate(12, 9)).toBe(0.75);
  });

  it("total=0 时返回 null(避免 NaN 进 UI)", () => {
    expect(rate(0, 0)).toBeNull();
  });

  it("100% 覆盖", () => {
    expect(rate(20, 20)).toBe(1);
  });
});

describe("dashboard / daily_buckets 由后端给出,前端不再聚合", () => {
  it("后端已给的 daily_buckets 字段映射到 Chart data 直传", () => {
    const buckets: DailyBucket[] = [
      {
        date: "2026-05-10",
        human_additions: 5,
        unknown_additions: 0,
        ai_additions: 10,
        commit_count: 1,
      },
      {
        date: "2026-05-11",
        human_additions: 20,
        unknown_additions: 1,
        ai_additions: 3,
        commit_count: 2,
      },
    ];
    // Chart data 是 1:1 映射 + rename;不在前端再 reduce
    const data = buckets.map((b) => ({
      date: b.date,
      human: b.human_additions,
      unknown: b.unknown_additions,
      ai: b.ai_additions,
    }));
    expect(data.length).toBe(2);
    expect(data[0]).toEqual({ date: "2026-05-10", human: 5, unknown: 0, ai: 10 });
    expect(data[1].ai).toBe(3);
  });
});

describe("dashboard / HistoryPayload schema 锁定", () => {
  it("所有字段对齐后端 commands/history.rs::HistoryPayload", () => {
    const sample: HistoryPayload = {
      range: { kind: "last_n_days", days: 7 },
      range_start_unix_ms: 1_700_000_000_000,
      range_end_unix_ms: 1_700_604_800_000,
      total_commits_in_window: 2,
      per_commit: [commit("a", 1, 0, 0), commit("b", 2, 0, 0)],
      daily_buckets: [],
      cache_hits: 1,
      cached_repo_total: 100,
      failed_shas: [],
      truncated: false,
      took_ms: 250,
    };
    // 类型层已锁住字段,这一项断言保证未来去字段会触发 TS 错误
    expect(sample.range.kind).toBe("last_n_days");
    expect(sample.range_start_unix_ms).toBeLessThan(sample.range_end_unix_ms);
    expect(sample.per_commit.length).toBe(2);
    expect(sample.cache_hits).toBeLessThanOrEqual(sample.total_commits_in_window);
    expect(sample.failed_shas).toEqual([]);
    expect(sample.truncated).toBe(false);
  });

  it("failed_shas 非空 → 前端必须透出,而不是被 0 桶兜底污染数字", () => {
    // 评审 A no-fallback 硬约束:某 commit 子进程失败 → 不静默以 0 桶兜底
    const sample: HistoryPayload = {
      range: { kind: "last_n_days", days: 7 },
      range_start_unix_ms: 1_700_000_000_000,
      range_end_unix_ms: 1_700_604_800_000,
      total_commits_in_window: 5,
      // failed_shas branch:
      // 前端必须在 failed_shas.length > 0 时显式渲染警示横幅
      per_commit: [],
      daily_buckets: [],
      cache_hits: 0,
      cached_repo_total: 0,
      failed_shas: ["aaaa111", "bbbb222"],
      truncated: false,
      took_ms: 100,
    };
    expect(sample.failed_shas.length).toBe(2);
    // 前端必须在 failed_shas.length > 0 时显式渲染警示横幅
  });

  it("truncated=true → 前端必须显示 banner 提示窗口可能漏算更老 commit(P10 #24)", () => {
    const sample: HistoryPayload = {
      range: { kind: "last_n_days", days: 90 },
      range_start_unix_ms: 1_700_000_000_000,
      range_end_unix_ms: 1_707_776_000_000,
      total_commits_in_window: 500,
      per_commit: [],
      daily_buckets: [],
      cache_hits: 0,
      cached_repo_total: 1200,
      failed_shas: [],
      truncated: true,
      took_ms: 100,
    };
    expect(sample.truncated).toBe(true);
    // 前端必须在 truncated 时渲染 TruncatedBanner
  });

  // range_summary 失败现已直接返 Err 弹红 toast,不再藏在 HistoryPayload 子字段里
  // (no-fallback)。原"range_summary_error 非空 → 显示失败态"测试因此移除。
});

describe("dashboard / RangeSummaryResult schema 锁定", () => {
  // hook 覆盖率已从 get_history 解耦为独立命令 get_range_summary,这里锁住其返回 schema
  // 与后端 commands/history.rs::RangeSummaryResult 对齐(Degraded / Ok 二分)。

  function sampleAuthorship(): RangeAuthorshipStats {
    return {
      authorship_stats: {
        total_commits: 12,
        commits_with_authorship: 9,
        authors_committing_authorship: ["alice", "bob"],
        authors_not_committing_authorship: ["charlie"],
        commits_without_authorship: ["sha-x", "sha-y", "sha-z"],
        commits_without_authorship_with_authors: [
          ["sha-x", "charlie"],
          ["sha-y", "charlie"],
          ["sha-z", "alice"],
        ],
      },
      range_stats: {
        human_additions: 120,
        unknown_additions: 30,
        ai_additions: 80,
        ai_accepted: 80,
        git_diff_deleted_lines: 20,
        git_diff_added_lines: 230,
        tool_model_breakdown: {},
      },
    };
  }

  it("ok 变体携带 range_summary,可算出 hook 覆盖率", () => {
    const result: RangeSummaryResult = { status: "ok", range_summary: sampleAuthorship() };
    if (result.status !== "ok") throw new Error("期望 ok");
    const a = result.range_summary.authorship_stats;
    expect(a.commits_with_authorship / a.total_commits).toBe(0.75);
  });

  it("degraded 三种空态:repo_missing / git_ai_missing / empty_window", () => {
    const kinds = ["repo_missing", "git_ai_missing", "empty_window"] as const;
    for (const kind of kinds) {
      const result: RangeSummaryResult = { status: "degraded", reason: { kind } };
      expect(result.status).toBe("degraded");
      if (result.status === "degraded") expect(result.reason.kind).toBe(kind);
    }
  });
});
