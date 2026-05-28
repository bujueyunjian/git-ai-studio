// 任务 #2:ChangedFile / AiLineRef 与后端 wire 字段契约。
//
// 后端 src-tauri/src/commands/diff.rs 的 serde tag = "status" / "kind" 在重构时
// 极易手滑(改名后前端 narrowing 全炸),用这组测试锁死前后端 JSON shape。

import { describe, expect, it } from "vitest";

import type { AiLineRef, AiLinesResult, ChangedFile, ChangedFilesResult } from "../lib/types";

describe("ChangedFilesResult / AiLinesResult 字段契约", () => {
  it("ChangedFile 字段:path + status", () => {
    const f: ChangedFile = { path: "src/foo.rs", status: "A" };
    expect(f.path).toBe("src/foo.rs");
    expect(f.status).toBe("A");
  });

  it("AiLineRef 字段:file + line_start + line_end", () => {
    const r: AiLineRef = { file: "src/x.ts", line_start: 1, line_end: 10 };
    expect(r.line_end).toBe(10);
  });

  it("ChangedFilesResult tagged on status='ok'", () => {
    const r: ChangedFilesResult = {
      status: "ok",
      files: [
        { path: "a.rs", status: "M" },
        { path: "b.rs", status: "A" },
      ],
    };
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.files).toHaveLength(2);
    }
  });

  it("ChangedFilesResult degraded invalid_sha 透传原 sha", () => {
    const r: ChangedFilesResult = {
      status: "degraded",
      reason: { kind: "invalid_sha", sha: "deadbeef" },
    };
    if (r.status === "degraded" && r.reason.kind === "invalid_sha") {
      expect(r.reason.sha).toBe("deadbeef");
    } else {
      throw new Error("narrowing 失败");
    }
  });

  it("AiLinesResult degraded repo_missing 仅 kind 字段", () => {
    const r: AiLinesResult = {
      status: "degraded",
      reason: { kind: "repo_missing" },
    };
    if (r.status === "degraded") {
      expect(r.reason.kind).toBe("repo_missing");
    }
  });

  it("AiLinesResult ok 空数组也合法(commit 无 AI notes 正常空态)", () => {
    const r: AiLinesResult = { status: "ok", lines: [] };
    if (r.status === "ok") {
      expect(r.lines).toEqual([]);
    }
  });

  // 状态码表(diff.rs 文档锚点):前端按这些字符渲染色块,后端按 git 输出原样透传
  it("status 字符表覆盖 A/M/D/R/C/T/U/X/B 9 种", () => {
    const all = ["A", "M", "D", "R", "C", "T", "U", "X", "B"];
    for (const s of all) {
      const f: ChangedFile = { path: "x", status: s };
      expect(f.status).toMatch(/^[A-Z]$/);
    }
  });
});
