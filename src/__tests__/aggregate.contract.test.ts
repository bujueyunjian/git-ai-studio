// 跨仓聚合(M1–M4)的契约测试:锁住前端 TS 类型 ↔ Rust 后端类型对齐。
//
// # 权威来源
// - AggregateHistoryPayload / AggregatePerCommit / FailedRepo / FailedCommit / AggregateDegradedReason
//   真源:`src-tauri/src/commands/history.rs`(均 `#[serde(rename_all = "snake_case")]`)
// - AggregateRepoEntry 真源:`src-tauri/src/commands/repo.rs:158`
// - 失败诚实性(failed_repos / truncated_repos / failed_shas 绝不当 0 并入)真源:
//   `history.rs` "失败三分" 注释(空集 Degraded / 全失败 Err / 部分失败列出)
//
// 与单仓 HistoryPayload(dashboard.contract.test.ts)正交:本文件只锁跨仓那一套。

import { describe, expect, it } from "vitest";

import { reposKey } from "../lib/queryKeys";
import type {
  AggregateHistoryPayload,
  AggregateHistoryResult,
  AggregatePerCommit,
  AggregateRepoEntry,
  AggregateWorkingStatusPayload,
  AggregateWorkingStatusResult,
  AiStats,
  FailedRepo,
  WorkingRepoSlice,
} from "../lib/types";

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

function perCommit(
  repoPath: string,
  sha: string,
  authoredAt: string,
  ai: number,
): AggregatePerCommit {
  const stats = emptyStats();
  stats.ai_additions = ai;
  stats.ai_accepted = ai;
  return {
    repo_path: repoPath,
    sha,
    short: sha.slice(0, 7),
    authored_at: authoredAt,
    is_merge: false,
    stats,
  };
}

describe("aggregate / AggregatePerCommit 携带 repo_path", () => {
  it("跨仓 per_commit 必须带 repo_path —— 跨仓 sha 不全局唯一,下钻/分解都依赖它", () => {
    const c = perCommit("/repos/alpha", "abc1234def", "2026-05-12T10:00:00+08:00", 5);
    expect(c.repo_path).toBe("/repos/alpha");
    // 同一 sha 可能出现在两个仓(cherry-pick / fork),唯一键必须是 (repo_path, sha)
    const key = `${c.repo_path}:${c.sha}`;
    expect(key).toBe("/repos/alpha:abc1234def");
  });
});

describe("aggregate / AggregateHistoryPayload schema 锁定", () => {
  it("所有字段对齐后端 commands/history.rs::AggregateHistoryPayload", () => {
    const sample: AggregateHistoryPayload = {
      range: { kind: "this_week" },
      range_start_unix_ms: 1_700_000_000_000,
      range_end_unix_ms: 1_700_604_800_000,
      total_commits_in_window: 3,
      per_commit: [
        perCommit("/repos/alpha", "a1111111", "2026-05-12T10:00:00+08:00", 10),
        perCommit("/repos/beta", "b2222222", "2026-05-11T09:00:00+08:00", 20),
      ],
      daily_buckets: [],
      cache_hits: 2,
      failed_repos: [],
      failed_shas: [],
      truncated_repos: [],
      took_ms: 320,
    };
    // 类型层已锁字段;去字段会触发 TS 错误,这里再做运行时不变量断言
    expect(sample.range.kind).toBe("this_week");
    expect(sample.range_start_unix_ms).toBeLessThan(sample.range_end_unix_ms);
    expect(sample.per_commit).toHaveLength(2);
    expect(sample.cache_hits).toBeLessThanOrEqual(sample.total_commits_in_window);
    expect(sample.failed_repos).toEqual([]);
    expect(sample.truncated_repos).toEqual([]);
    expect(sample.failed_shas).toEqual([]);
  });

  it("per_commit 跨仓后按 authored_at 倒序(M4 全局排序)—— RecentCommitsTable 直接 slice 头部", () => {
    // 后端跨仓 merge 后做了 all_per_commit.sort_by(authored_at desc);前端不再重排。
    const payload: AggregateHistoryPayload = {
      range: { kind: "last_n_days", days: 7 },
      range_start_unix_ms: 1_700_000_000_000,
      range_end_unix_ms: 1_700_604_800_000,
      total_commits_in_window: 3,
      per_commit: [
        perCommit("/repos/beta", "newest", "2026-05-12T18:00:00+08:00", 1),
        perCommit("/repos/alpha", "middle", "2026-05-12T09:00:00+08:00", 2),
        perCommit("/repos/beta", "oldest", "2026-05-10T08:00:00+08:00", 3),
      ],
      daily_buckets: [],
      cache_hits: 0,
      failed_repos: [],
      failed_shas: [],
      truncated_repos: [],
      took_ms: 50,
    };
    const times = payload.per_commit.map((c) => Date.parse(c.authored_at));
    const sortedDesc = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sortedDesc);
  });
});

describe("aggregate / 失败诚实性(no-fallback 硬约束)", () => {
  it("failed_repos 非空 → 数据未并入,UI 必须显式列出'未纳入统计',绝不当 0", () => {
    const failed: FailedRepo = { repo_path: "/repos/broken", reason: "git-ai stats 子进程超时" };
    const payload: AggregateHistoryPayload = {
      range: { kind: "this_week" },
      range_start_unix_ms: 1_700_000_000_000,
      range_end_unix_ms: 1_700_604_800_000,
      total_commits_in_window: 1,
      per_commit: [perCommit("/repos/ok", "ok11111", "2026-05-12T10:00:00+08:00", 5)],
      daily_buckets: [],
      cache_hits: 0,
      failed_repos: [failed],
      failed_shas: [],
      truncated_repos: [],
      took_ms: 80,
    };
    // 失败仓带 reason(可读原因),前端据 failed_repos.length>0 渲染警示横幅
    expect(payload.failed_repos[0].reason).toContain("超时");
    // 成功仓与失败仓是分区的:成功仓的数字真实,失败仓不被 0 桶污染聚合
    expect(payload.per_commit.every((c) => c.repo_path !== failed.repo_path)).toBe(true);
  });

  it("truncated_repos 非空 → 命中 500 cap,UI 必须提示'可能漏算更老 commit'", () => {
    const payload: AggregateHistoryPayload = {
      range: { kind: "last_n_days", days: 90 },
      range_start_unix_ms: 1_700_000_000_000,
      range_end_unix_ms: 1_707_776_000_000,
      total_commits_in_window: 500,
      per_commit: [],
      daily_buckets: [],
      cache_hits: 0,
      failed_repos: [],
      failed_shas: [],
      truncated_repos: ["/repos/huge"],
      took_ms: 100,
    };
    expect(payload.truncated_repos).toContain("/repos/huge");
  });

  it("failed_shas 用 (repo_path, sha) 限定 —— 跨仓 sha 不全局唯一", () => {
    const payload: AggregateHistoryPayload = {
      range: { kind: "today" },
      range_start_unix_ms: 1_700_000_000_000,
      range_end_unix_ms: 1_700_086_400_000,
      total_commits_in_window: 2,
      per_commit: [],
      daily_buckets: [],
      cache_hits: 0,
      failed_repos: [],
      failed_shas: [
        { repo_path: "/repos/alpha", sha: "deadbeef" },
        { repo_path: "/repos/beta", sha: "deadbeef" },
      ],
      truncated_repos: [],
      took_ms: 40,
    };
    // 同 sha 出现在两个仓也能各自定位,不会相互覆盖
    expect(payload.failed_shas).toHaveLength(2);
    expect(new Set(payload.failed_shas.map((f) => `${f.repo_path}:${f.sha}`)).size).toBe(2);
  });
});

describe("aggregate / AggregateHistoryResult ok|degraded 二分", () => {
  it("ok 变体携带 payload", () => {
    const result: AggregateHistoryResult = {
      status: "ok",
      payload: {
        range: { kind: "this_week" },
        range_start_unix_ms: 1,
        range_end_unix_ms: 2,
        total_commits_in_window: 0,
        per_commit: [],
        daily_buckets: [],
        cache_hits: 0,
        failed_repos: [],
        failed_shas: [],
        truncated_repos: [],
        took_ms: 0,
      },
    };
    if (result.status !== "ok") throw new Error("期望 ok");
    expect(result.payload.total_commits_in_window).toBe(0);
  });

  it("degraded 两种:no_repos_selected(未勾选) / git_ai_missing(全局前置缺失)", () => {
    const kinds = ["no_repos_selected", "git_ai_missing"] as const;
    for (const kind of kinds) {
      const result: AggregateHistoryResult = { status: "degraded", reason: { kind } };
      expect(result.status).toBe("degraded");
      if (result.status === "degraded") expect(result.reason.kind).toBe(kind);
    }
  });
});

describe("aggregate / AggregateRepoEntry(get_aggregate_repos 返回)", () => {
  it("有效仓:valid=true 且 entry 非空", () => {
    const entry: AggregateRepoEntry = {
      path: "/repos/alpha",
      valid: true,
      entry: {
        path: "/repos/alpha",
        name: "alpha",
        head_branch: "main",
        head_sha: "abc1234",
        dirty: false,
        has_git_ai_dir: true,
        working_logs_count: 3,
      },
    };
    expect(entry.valid).toBe(true);
    expect(entry.entry?.name).toBe("alpha");
  });

  it("失效仓:valid=false 且 entry=null —— 路径还在勾选集但仓已不可用(被删/移动)", () => {
    const entry: AggregateRepoEntry = { path: "/repos/gone", valid: false, entry: null };
    expect(entry.valid).toBe(false);
    expect(entry.entry).toBeNull();
    // Dashboard 只把 valid 仓喂给 included(过滤失效仓),失效仓在 Repo 页提示
  });
});

describe("aggregate / reposKey 作聚合查询缓存键", () => {
  it("勾选集相同、顺序不同 → 同一 key(切勾选顺序不触发重取)", () => {
    expect(reposKey(["/repos/b", "/repos/a"])).toBe(reposKey(["/repos/a", "/repos/b"]));
  });

  it("空集 → 稳定 key(未勾选态也可作 enabled=false 的 query key,不抛错)", () => {
    expect(reposKey([])).toBe(reposKey([]));
  });

  it("子集 ≠ 全集 → 不同 key(增删勾选必触发重取)", () => {
    expect(reposKey(["/repos/a"])).not.toBe(reposKey(["/repos/a", "/repos/b"]));
  });
});

describe("aggregate / 本地未提交快照(AggregateWorkingStatus)", () => {
  // 真源:src-tauri/src/commands/history.rs::AggregateWorkingStatusPayload / WorkingRepoSlice
  // (均 #[serde(rename_all = "snake_case")];Result tag=status / Degraded reason 复用 AggregateDegradedReason)
  it("payload 三桶 + per_repo 切片字段对齐 Rust", () => {
    const slice: WorkingRepoSlice = {
      repo_path: "/repos/alpha",
      human_additions: 3,
      unknown_additions: 1,
      ai_additions: 6,
    };
    const payload: AggregateWorkingStatusPayload = {
      repos_with_changes: 1,
      human_additions: 3,
      unknown_additions: 1,
      ai_additions: 6,
      per_repo: [slice],
      failed_repos: [],
      took_ms: 12,
    };
    // 卡片 AI 占比 = ai / (human + unknown + ai),与 Dashboard 主指标同口径
    const total = payload.human_additions + payload.unknown_additions + payload.ai_additions;
    expect(payload.ai_additions / total).toBeCloseTo(0.6, 5);
    expect(payload.per_repo[0].repo_path).toBe("/repos/alpha");
  });

  it("失败诚实性:失败仓进 failed_repos,绝不当 0 并入三桶", () => {
    const failed: FailedRepo = { repo_path: "/repos/no-head", reason: "no HEAD" };
    const payload: AggregateWorkingStatusPayload = {
      repos_with_changes: 0,
      human_additions: 0,
      unknown_additions: 0,
      ai_additions: 0,
      per_repo: [],
      failed_repos: [failed],
      took_ms: 5,
    };
    expect(payload.failed_repos).toHaveLength(1);
    expect(payload.repos_with_changes).toBe(0);
  });

  it("空集 / git-ai 缺失 → Degraded(复用聚合 degraded kind)", () => {
    const r: AggregateWorkingStatusResult = {
      status: "degraded",
      reason: { kind: "no_repos_selected" },
    };
    expect(r.status === "degraded" && r.reason.kind).toBe("no_repos_selected");
  });
});
