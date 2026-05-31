import { describe, expect, it } from "vitest";

import {
  LOW_AI_SHARE_DEFAULT_REMIND_INTERVAL_MINUTES,
  LOW_AI_SHARE_MIN_TOTAL_ADDITIONS,
  LOW_AI_SHARE_REPO_SWITCH_COOLDOWN_MS,
  decideLowAiShareNotification,
  lowAiShareScopeKey,
  normalizeLowAiShareTargetEmails,
  summarizeAiShare,
  summarizeAiShareForEmails,
} from "../lib/lowAiShareNotifier";
import type { HistoryPayload, PeopleBreakdownPayload } from "../lib/types";

function payload(buckets: { human: number; unknown: number; ai: number }[]): HistoryPayload {
  return {
    range: { kind: "last_n_days", days: 7 },
    range_start_unix_ms: 0,
    range_end_unix_ms: 0,
    total_commits_in_window: buckets.length,
    per_commit: [],
    daily_buckets: buckets.map((b, i) => ({
      date: `2026-05-${10 + i}`,
      human_additions: b.human,
      unknown_additions: b.unknown,
      ai_additions: b.ai,
      commit_count: 1,
    })),
    cache_hits: 0,
    cached_repo_total: 0,
    failed_shas: [],
    truncated: false,
    took_ms: 0,
  };
}

const NOW = 1_700_000_000_000;

function base() {
  return {
    enabled: true,
    thresholdPercent: 30,
    summary: { aiAdditions: 5, totalAdditions: 100, sharePercent: 5, shareRatio: 0.05 },
    nowMs: NOW,
    repoSwitchedAtMs: null,
    remindIntervalMs: LOW_AI_SHARE_DEFAULT_REMIND_INTERVAL_MINUTES * 60 * 1000,
    lastShownAtMs: null,
    dismissedUntilMs: null,
  };
}

function peoplePayload(rows: PeopleBreakdownPayload["rows"]): PeopleBreakdownPayload {
  return {
    range: { kind: "last_n_days", days: 7 },
    range_start_unix_ms: 0,
    range_end_unix_ms: 0,
    rows,
    grand_total: {
      commits: 0,
      human_additions: 0,
      unknown_additions: 0,
      ai_additions: 0,
      total_additions: 0,
    },
    failed_shas: [],
    truncated: false,
    cache_hits: 0,
    took_ms: 0,
  };
}

describe("summarizeAiShare", () => {
  it("累加 daily_buckets 的三桶", () => {
    const s = summarizeAiShare(
      payload([
        { human: 10, unknown: 5, ai: 35 },
        { human: 0, unknown: 0, ai: 0 },
      ]),
    );
    expect(s.aiAdditions).toBe(35);
    expect(s.totalAdditions).toBe(50);
    expect(s.sharePercent).toBe(70);
    expect(s.shareRatio).toBeCloseTo(0.7, 10);
  });

  it("总加为 0 时 sharePercent / shareRatio 均为 null", () => {
    const s = summarizeAiShare(payload([]));
    expect(s.totalAdditions).toBe(0);
    expect(s.sharePercent).toBeNull();
    expect(s.shareRatio).toBeNull();
  });
});

describe("低 AI 占比统计对象 helper", () => {
  it("归一化邮箱配置", () => {
    expect(
      normalizeLowAiShareTargetEmails("Bob@EXAMPLE.com, alice@example.com\nbob@example.com"),
    ).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("按邮箱聚合 People rows", () => {
    const s = summarizeAiShareForEmails(
      peoplePayload([
        {
          identity_key: "alice@example.com",
          author_name: "Alice",
          author_email: "Alice@Example.com",
          commits: 1,
          human_additions: 20,
          unknown_additions: 10,
          ai_additions: 30,
          total_additions: 60,
          commit_refs: [],
        },
        {
          identity_key: "bob@example.com",
          author_name: "Bob",
          author_email: "bob@example.com",
          commits: 1,
          human_additions: 90,
          unknown_additions: 0,
          ai_additions: 10,
          total_additions: 100,
          commit_refs: [],
        },
      ]),
      ["ALICE@example.com"],
    );
    expect(s).toEqual({ aiAdditions: 30, totalAdditions: 60, sharePercent: 50, shareRatio: 0.5 });
  });

  it("scope key 区分仓库整体和指定邮箱", () => {
    expect(lowAiShareScopeKey([])).toBe("repo");
    expect(lowAiShareScopeKey(["Bob@Example.com", "alice@example.com"])).toBe(
      "emails.alice@example.com,bob@example.com",
    );
  });
});

describe("decideLowAiShareNotification", () => {
  it("disabled 不触发", () => {
    const r = decideLowAiShareNotification({ ...base(), enabled: false });
    expect(r).toEqual({ trigger: false, reason: "disabled" });
  });

  it("总加行数低于下限不触发", () => {
    const r = decideLowAiShareNotification({
      ...base(),
      summary: {
        aiAdditions: 1,
        totalAdditions: LOW_AI_SHARE_MIN_TOTAL_ADDITIONS - 1,
        sharePercent: 2,
        shareRatio: 0.02,
      },
    });
    expect(r).toEqual({ trigger: false, reason: "insufficient_sample" });
  });

  it("占比 >= 阈值不触发", () => {
    const r = decideLowAiShareNotification({
      ...base(),
      summary: { aiAdditions: 30, totalAdditions: 100, sharePercent: 30, shareRatio: 0.3 },
    });
    expect(r.trigger).toBe(false);
    expect(r.reason).toBe("share_above_threshold");
  });

  it("占比 null 不触发", () => {
    const r = decideLowAiShareNotification({
      ...base(),
      summary: { aiAdditions: 0, totalAdditions: 100, sharePercent: null, shareRatio: null },
    });
    expect(r.reason).toBe("share_above_threshold");
  });

  it("阈值判定用精确 ratio:79.6%(round 后=80)仍触发,消除 0.5pp 漏报死区", () => {
    // 回归:旧实现用 round 后的 sharePercent=80,80>=80 不触发(漏报);精确 0.796*100<80 应触发。
    const r = decideLowAiShareNotification({
      ...base(),
      thresholdPercent: 80,
      summary: { aiAdditions: 796, totalAdditions: 1000, sharePercent: 80, shareRatio: 0.796 },
    });
    expect(r).toEqual({ trigger: true, reason: null });
  });

  it("精确占比恰好 >= 阈值仍不触发(80.4% 在 80% 阈值之上)", () => {
    const r = decideLowAiShareNotification({
      ...base(),
      thresholdPercent: 80,
      summary: { aiAdditions: 804, totalAdditions: 1000, sharePercent: 80, shareRatio: 0.804 },
    });
    expect(r.reason).toBe("share_above_threshold");
  });

  it("切仓 5 分钟内不触发", () => {
    const r = decideLowAiShareNotification({
      ...base(),
      repoSwitchedAtMs: NOW - (LOW_AI_SHARE_REPO_SWITCH_COOLDOWN_MS - 1),
    });
    expect(r.reason).toBe("repo_just_switched");
  });

  it("切仓刚好 5 分钟即可触发", () => {
    const r = decideLowAiShareNotification({
      ...base(),
      repoSwitchedAtMs: NOW - LOW_AI_SHARE_REPO_SWITCH_COOLDOWN_MS,
    });
    expect(r.trigger).toBe(true);
  });

  it("提醒间隔内不触发", () => {
    const interval = 15 * 60 * 1000;
    const r = decideLowAiShareNotification({
      ...base(),
      remindIntervalMs: interval,
      lastShownAtMs: NOW - (interval - 1),
    });
    expect(r.reason).toBe("cross_session_cooldown");
  });

  it("提醒间隔到达即可触发", () => {
    const interval = 15 * 60 * 1000;
    const r = decideLowAiShareNotification({
      ...base(),
      remindIntervalMs: interval,
      lastShownAtMs: NOW - interval,
    });
    expect(r.trigger).toBe(true);
  });

  it("用户主动 X 未解封不触发", () => {
    const r = decideLowAiShareNotification({ ...base(), dismissedUntilMs: NOW + 1 });
    expect(r.reason).toBe("user_dismissed");
  });

  it("用户主动 X 已过期可触发", () => {
    const r = decideLowAiShareNotification({ ...base(), dismissedUntilMs: NOW - 1 });
    expect(r.trigger).toBe(true);
  });

  it("典型触发:占比 5% < 阈值 30%,无任何冷却", () => {
    const r = decideLowAiShareNotification(base());
    expect(r).toEqual({ trigger: true, reason: null });
  });
});
