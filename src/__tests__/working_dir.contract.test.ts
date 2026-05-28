// P10 #18/#37/#49 WorkingDirSummary 契约测试。
//
// 覆盖:
// - WORKING_DIR_SHA_TOKEN 字面值锁(Stats / Dashboard 跨页共用 router segment)
// - 不与合法 git sha 冲突(sha 只用 hex)
// - 不含 router 会切分 / 编码的字符
// - StatsResult 的 working kind 与 commit kind 同形 schema(后端 StatsView 统一)

import { describe, expect, it } from "vitest";

import { WORKING_DIR_SHA_TOKEN } from "../components/WorkingDirSummary";
import type { StatsView } from "../lib/types";

describe("WORKING_DIR_SHA_TOKEN 字面值锁", () => {
  it("默认值 `__WORKING__`,与 git sha 物理隔离", () => {
    expect(WORKING_DIR_SHA_TOKEN).toBe("__WORKING__");
    // 合法 git sha 仅含 [0-9a-f];token 含下划线即天然不冲突
    expect(WORKING_DIR_SHA_TOKEN).toMatch(/[^0-9a-f]/);
  });

  it("不含 router segment 会切分 / 编码的字符", () => {
    for (const ch of ["/", "#", "?", " "]) {
      expect(WORKING_DIR_SHA_TOKEN).not.toContain(ch);
    }
  });
});

describe("StatsView working kind schema 锁", () => {
  it("kind=working 时 commit_sha=null,is_merge=false(后端 commands/stats.rs:165 真源)", () => {
    const view: StatsView = {
      kind: "working",
      commit_sha: null,
      is_merge: false,
      stats: {
        human_additions: 0,
        unknown_additions: 0,
        ai_additions: 0,
        ai_accepted: 0,
        git_diff_deleted_lines: 0,
        git_diff_added_lines: 0,
        tool_model_breakdown: {},
      },
      total_additions: 0,
      note_kind: null,
    };
    expect(view.kind).toBe("working");
    expect(view.commit_sha).toBeNull();
    expect(view.is_merge).toBe(false);
  });

  it("kind=commit 时 commit_sha 有值;两者共用 stats 字段子树(7 字段)", () => {
    const view: StatsView = {
      kind: "commit",
      commit_sha: "abcdef1234567890abcdef1234567890abcdef12",
      is_merge: false,
      stats: {
        human_additions: 1,
        unknown_additions: 2,
        ai_additions: 3,
        ai_accepted: 3,
        git_diff_deleted_lines: 0,
        git_diff_added_lines: 6,
        tool_model_breakdown: {},
      },
      total_additions: 6,
      note_kind: null,
    };
    expect(view.kind).toBe("commit");
    expect(view.commit_sha?.length).toBe(40);
    // total_additions 是后端聚合(stats.rs:114 公式),前端不重算
    expect(view.total_additions).toBe(
      view.stats.human_additions + view.stats.unknown_additions + view.stats.ai_additions,
    );
  });
});
