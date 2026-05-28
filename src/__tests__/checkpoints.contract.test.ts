// P8 Checkpoints 契约测试。
//
// 覆盖范围:
// - CheckpointKind 4 种 PascalCase 字符串(防退化锁定)
// - Checkpoint payload schema 锁(防误删字段)
// - MockPreset 三种 snake_case 字符串(对齐后端 Rust enum)
// - DirtyFilesPayload schema 锁

import { describe, expect, it } from "vitest";

import type {
  Checkpoint,
  CheckpointKind,
  CheckpointsPayload,
  DirtyFilesPayload,
  MockPreset,
} from "../lib/types";

describe("CheckpointKind PascalCase 锁", () => {
  it("4 种 kind 必须是字面 PascalCase(对齐上游 working_log.rs:48-54 默认 serde)", () => {
    const kinds: CheckpointKind[] = ["Human", "AiAgent", "AiTab", "KnownHuman"];
    for (const k of kinds) {
      // 编译期 + 运行期验证字面值不变
      expect([..."Human", ..."AiAgent", ..."AiTab", ..."KnownHuman"]).toContain(k[0]);
      // 不能是 snake_case
      expect(k).not.toBe("ai_agent");
      expect(k).not.toBe("known_human");
    }
    expect(kinds).toContain("AiAgent");
    expect(kinds).toContain("KnownHuman");
  });
});

describe("Checkpoint schema 锁", () => {
  it("12 字段齐全 + line_stats 4 字段", () => {
    const cp: Checkpoint = {
      kind: "AiAgent",
      diff: "",
      author: "claude",
      entries: [],
      timestamp: 1700000000,
      agent_id: { tool: "claude", id: "sess-1", model: "opus" },
      agent_metadata: null,
      line_stats: { additions: 3, deletions: 1, additions_sloc: 2, deletions_sloc: 1 },
      api_version: "checkpoint/1.0.0",
    };
    expect(cp).toHaveProperty("kind");
    expect(cp).toHaveProperty("diff");
    expect(cp).toHaveProperty("author");
    expect(cp).toHaveProperty("entries");
    expect(cp).toHaveProperty("timestamp");
    expect(cp).toHaveProperty("agent_id");
    expect(cp).toHaveProperty("agent_metadata");
    expect(cp).toHaveProperty("line_stats.additions");
    expect(cp).toHaveProperty("line_stats.deletions");
    expect(cp).toHaveProperty("line_stats.additions_sloc");
    expect(cp).toHaveProperty("line_stats.deletions_sloc");
    expect(cp).toHaveProperty("api_version");
  });

  it("agent_id 可为 null(Human / KnownHuman kind)", () => {
    const human: Checkpoint = {
      kind: "Human",
      diff: "",
      author: "alice",
      entries: [],
      timestamp: 1,
      agent_id: null,
      agent_metadata: null,
      line_stats: { additions: 0, deletions: 0, additions_sloc: 0, deletions_sloc: 0 },
      api_version: "checkpoint/1.0.0",
    };
    expect(human.agent_id).toBeNull();
  });

  it("known_human_metadata 三字段对齐", () => {
    const kh: Checkpoint = {
      kind: "KnownHuman",
      diff: "",
      author: "alice",
      entries: [],
      timestamp: 1,
      agent_id: null,
      agent_metadata: null,
      line_stats: { additions: 0, deletions: 0, additions_sloc: 0, deletions_sloc: 0 },
      api_version: "checkpoint/1.0.0",
      known_human_metadata: {
        editor: "vscode",
        editor_version: "1.85.0",
        extension_version: "0.4.1",
      },
    };
    expect(kh.known_human_metadata?.editor).toBe("vscode");
  });

  it("LineAttribution overrode 可选", () => {
    const cp: Checkpoint = {
      kind: "AiAgent",
      diff: "",
      author: "x",
      entries: [
        {
          file: "src/foo.rs",
          blob_sha: "abc",
          attributions: [],
          line_attributions: [
            { start_line: 1, end_line: 5, author_id: "p-1" },
            { start_line: 6, end_line: 8, author_id: "p-2", overrode: "p-1" },
          ],
        },
      ],
      timestamp: 1,
      agent_id: { tool: "claude", id: "s", model: "m" },
      agent_metadata: null,
      line_stats: { additions: 0, deletions: 0, additions_sloc: 0, deletions_sloc: 0 },
      api_version: "checkpoint/1.0.0",
    };
    expect(cp.entries[0].line_attributions[0].overrode).toBeUndefined();
    expect(cp.entries[0].line_attributions[1].overrode).toBe("p-1");
  });
});

describe("CheckpointsPayload 顶层结构", () => {
  it("repo_path / head_sha / checkpoints 三字段", () => {
    const p: CheckpointsPayload = {
      repo_path: "D:/repo",
      head_sha: "abc123",
      checkpoints: [],
    };
    expect(p).toHaveProperty("repo_path");
    expect(p).toHaveProperty("head_sha");
    expect(p).toHaveProperty("checkpoints");
  });
});

describe("MockPreset 字面值(对齐后端 snake_case rename)", () => {
  it("三 preset 字符串", () => {
    const presets: MockPreset[] = ["human", "mock_ai", "mock_known_human"];
    expect(presets).toEqual(["human", "mock_ai", "mock_known_human"]);
    for (const p of presets) {
      expect(p).not.toContain(" ");
      expect(p).toBe(p.toLowerCase());
    }
  });
});

describe("DirtyFilesPayload schema", () => {
  it("files + total 两字段;file 含 path + 2-char status", () => {
    const p: DirtyFilesPayload = {
      files: [{ path: "src/foo.rs", status: " M" }],
      total: 1,
    };
    expect(p.files[0].status).toHaveLength(2);
    expect(p.total).toBe(1);
  });
});
