// P7 Notes 页前端契约测试。
//
// # 覆盖范围
// - classifyNotesHash 三类(prompt / human / session)
// - sessionKeyOf 复合 hash(s_xxx::t_yyy)
// - Payload schema 锁(无意删字段会炸)
// - line_ranges 字符串原样透传(viewer 不擅自 re-sort)
// - messages_url 字段存在与否的 shape

import { describe, expect, it } from "vitest";

import {
  classifyNotesHash,
  sessionKeyOf,
  type NotesAuthorshipLog,
  type NotesListPayload,
  type NotesPromptRecord,
} from "../lib/types";

describe("classifyNotesHash", () => {
  it("无前缀 16 hex → prompt", () => {
    expect(classifyNotesHash("abcd1234abcd1234")).toBe("prompt");
  });
  it("h_ 前缀 → human", () => {
    expect(classifyNotesHash("h_31dce776f88375")).toBe("human");
  });
  it("s_ 前缀 → session", () => {
    expect(classifyNotesHash("s_abcdef0123456")).toBe("session");
  });
  it("s_::t_ 复合 hash 仍属 session", () => {
    expect(classifyNotesHash("s_abcdef0123456::t_1234567890abcd")).toBe("session");
  });
});

describe("sessionKeyOf", () => {
  it("无 :: → 原 hash", () => {
    expect(sessionKeyOf("s_abcdef0123456")).toBe("s_abcdef0123456");
  });
  it("有 :: → 取首段(与上游 authorship_log_serialization.rs:278 一致)", () => {
    expect(sessionKeyOf("s_abcdef0123456::t_1234567890abcd")).toBe("s_abcdef0123456");
  });
  it("多 :: 取最左", () => {
    expect(sessionKeyOf("s_x::t_y::extra")).toBe("s_x");
  });
});

describe("NotesAuthorshipLog schema 锁", () => {
  it("PromptRecord 字段名 overriden_lines(单 r,上游 v3.0.0 typo errata E-001)", () => {
    const r: NotesPromptRecord = {
      agent_id: { tool: "claude", id: "x", model: "y" },
      human_author: null,
      total_additions: 0,
      total_deletions: 0,
      accepted_lines: 0,
      overriden_lines: 0,
    };
    // 编译期 + 运行期都用 overriden_lines,**禁止**改成 overridden_lines
    expect(Object.keys(r)).toContain("overriden_lines");
    expect(Object.keys(r)).not.toContain("overridden_lines");
  });

  it("AuthorshipLog 顶层有 attestations + metadata 两段", () => {
    const log: NotesAuthorshipLog = {
      attestations: [],
      metadata: {
        schema_version: "authorship/3.0.0",
        git_ai_version: null,
        base_commit_sha: "x",
        prompts: {},
        humans: {},
        sessions: {},
      },
    };
    expect(log).toHaveProperty("attestations");
    expect(log).toHaveProperty("metadata.schema_version");
    expect(log).toHaveProperty("metadata.prompts");
    expect(log).toHaveProperty("metadata.humans");
    expect(log).toHaveProperty("metadata.sessions");
  });

  it("line_ranges 是字符串而非数组(viewer 透传)", () => {
    const log: NotesAuthorshipLog = {
      attestations: [
        {
          file_path: "src/main.rs",
          entries: [{ hash: "abcd1234abcd1234", line_ranges: "1-10,15-20" }],
        },
      ],
      metadata: {
        schema_version: "authorship/3.0.0",
        git_ai_version: null,
        base_commit_sha: "x",
        prompts: {},
        humans: {},
        sessions: {},
      },
    };
    expect(typeof log.attestations[0].entries[0].line_ranges).toBe("string");
    expect(log.attestations[0].entries[0].line_ranges).toBe("1-10,15-20");
  });
});

describe("NotesListPayload schema 锁", () => {
  it("含 repo_path + head_sha + notes + unreachable_shas 四字段", () => {
    const p: NotesListPayload = {
      repo_path: "D:/repo",
      head_sha: "abc123",
      notes: [
        {
          commit_sha: "abc123abc123abc123abc123abc123abc123abc1",
          short_sha: "abc1234",
          note_oid: "oid1",
          committed_at: "2026-05-12T10:00:00+08:00",
          subject: "feat: x",
        },
      ],
      unreachable_shas: ["7ff9672042aea26b48f6638b34f1058f9efa0e2c"],
    };
    expect(p).toHaveProperty("repo_path");
    expect(p).toHaveProperty("head_sha");
    expect(p).toHaveProperty("notes");
    expect(p).toHaveProperty("unreachable_shas");
    expect(p.notes[0]).toHaveProperty("commit_sha");
    expect(p.notes[0]).toHaveProperty("short_sha");
    expect(p.notes[0]).toHaveProperty("note_oid");
    expect(p.notes[0]).toHaveProperty("committed_at");
    expect(p.notes[0]).toHaveProperty("subject");
    expect(Array.isArray(p.unreachable_shas)).toBe(true);
  });
});

describe("messages_url 可选字段", () => {
  it("缺省时 record 形状仍合法", () => {
    const r: NotesPromptRecord = {
      agent_id: { tool: "claude", id: "x", model: "y" },
      human_author: null,
      total_additions: 0,
      total_deletions: 0,
      accepted_lines: 0,
      overriden_lines: 0,
    };
    expect(r.messages_url).toBeUndefined();
  });
  it("存在时 url 透传", () => {
    const r: NotesPromptRecord = {
      agent_id: { tool: "claude", id: "x", model: "y" },
      human_author: null,
      messages_url: "https://example.com/conv/abc",
      total_additions: 0,
      total_deletions: 0,
      accepted_lines: 0,
      overriden_lines: 0,
    };
    expect(r.messages_url).toBe("https://example.com/conv/abc");
  });
});
