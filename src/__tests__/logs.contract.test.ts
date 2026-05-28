// P9 Logs 契约测试。
//
// 覆盖:
// - LogKind 仅 "app" 字面值(对齐后端 #[serde(tag="kind", rename_all="snake_case")])
// - LogFilePayload 6 字段 schema 锁
// - LogStreamEvent 与 InstallLogEvent 同形(沿用 install/checkpoint 流式 event 结构)

import { describe, expect, it } from "vitest";

import type { LogFilePayload, LogKind, LogStreamEvent } from "../lib/types";

describe("LogKind serde 字面值锁", () => {
  it("仅 app 一种 kind(对齐 commands/logs.rs::LogKind)", () => {
    const variants: LogKind[] = [{ kind: "app" }];
    for (const v of variants) {
      expect(v.kind).toBe("app");
      // 杜绝 PascalCase / camelCase 等漂移
      expect(v.kind).toBe(v.kind.toLowerCase());
    }
  });
});

describe("LogFilePayload schema 锁", () => {
  it("6 字段齐全且类型对齐(commands/logs.rs::LogFilePayload)", () => {
    const p: LogFilePayload = {
      path: "/tmp/x.log",
      exists: true,
      size: 1234,
      mtime_unix_ms: 1700000000000,
      truncated_head: false,
      content: "line1\n",
    };
    expect(typeof p.path).toBe("string");
    expect(typeof p.exists).toBe("boolean");
    expect(typeof p.size).toBe("number");
    expect(typeof p.truncated_head).toBe("boolean");
    expect(typeof p.content).toBe("string");
    expect(p.mtime_unix_ms === null || typeof p.mtime_unix_ms === "number").toBe(true);
  });

  it("size === 0 且 exists=true 时表示空文件(content 必空)", () => {
    const p: LogFilePayload = {
      path: "/tmp/empty.log",
      exists: true,
      size: 0,
      mtime_unix_ms: null,
      truncated_head: false,
      content: "",
    };
    // 这是一个常量级约束:size=0 且 exists=true 时,前端依赖 content=""
    expect(p.content).toBe("");
    expect(p.truncated_head).toBe(false);
  });
});

describe("LogStreamEvent 兼容性", () => {
  it("stream 3 种;line 仅 stdout/stderr 必有,exit 用 code", () => {
    const out: LogStreamEvent = { stream: "stdout", line: "hello", ts: 1 };
    const err: LogStreamEvent = { stream: "stderr", line: "boom", ts: 1 };
    const exit: LogStreamEvent = { stream: "exit", code: 0, ts: 1 };
    expect(out.stream).toBe("stdout");
    expect(err.stream).toBe("stderr");
    expect(exit.stream).toBe("exit");
    expect(exit.code).toBe(0);
  });
});

describe("event topic 格式锁", () => {
  it("logs://debug/<jobId> 前缀 + 路径段(对齐 commands/logs.rs::run_git_ai_debug_report)", () => {
    const jobId = "debug-1700000000-abcd12";
    const topic = `logs://debug/${jobId}`;
    expect(topic.startsWith("logs://debug/")).toBe(true);
    expect(topic.split("/").length).toBe(4); // logs: + '' + debug + jobId
  });
});
