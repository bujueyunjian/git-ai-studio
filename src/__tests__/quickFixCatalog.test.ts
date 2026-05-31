// 任务 #7 — QuickFix Catalog 命中规则单测。
//
// 覆盖:
// - QUICK_FIX_CATALOG 结构合法性(必填字段、id 唯一、命令至少一条 comment)
// - evaluateQuickFixes 排序(err > warn > info)
// - 每条 entry 的 detect 至少一组"命中" + "不命中"样本
// - 边界:全 undefined 上下文 / git-ai 未装时 catalog 只剩 git-ai-not-installed

import { describe, expect, it } from "vitest";

import { evaluateQuickFixes, QUICK_FIX_CATALOG } from "../lib/quickFixCatalog";
import type { QuickFixContext } from "../lib/quickFixCatalog";
import type {
  AgentHookStatus,
  DebugReport,
  DiagnosticOverview,
  HooksStatus,
  WhoamiPayload,
} from "../lib/types";

// ===== 构造器:把"诊断快照"的构造从测试用例剥出来 =====

function makeReport(loginStatus: string | null): DebugReport {
  const sections = loginStatus
    ? [
        {
          name: "Git AI Login",
          raw: `Status: ${loginStatus}\n`,
          entries: [["Status", loginStatus]] as [string, string][],
        },
      ]
    : [];
  return {
    ok: true,
    git_ai_version: "1.3.4",
    sections,
    raw: sections.map((s) => s.raw).join(""),
  };
}

function makeAgent(opts: {
  agent?: AgentHookStatus["agent"];
  detected?: boolean;
  configured?: boolean;
}): AgentHookStatus {
  return {
    agent: opts.agent ?? "Claude",
    detected: opts.detected ?? true,
    configured: opts.configured ?? true,
    config_path: "~/.claude/settings.json",
    hook_type: opts.configured ? "command" : null,
    raw_excerpt: null,
    issues: [],
  };
}

function makeDiagnostic(overrides: Partial<DiagnosticOverview>): DiagnosticOverview {
  return {
    generated_at_unix_ms: Date.now(),
    took_ms: 12,
    repo: {
      path: "C:/code/demo",
      name: "demo",
      head_branch: "main",
      head_sha: "abc123",
      dirty: false,
      has_git_ai_dir: true,
      working_logs_count: 1,
    },
    report: makeReport("logged in as alice@example.com"),
    agents: [makeAgent({ agent: "Claude" })],
    degraded: null,
    ...overrides,
  };
}

function makeHooks(mode: HooksStatus["mode"]): HooksStatus {
  return { mode };
}

function makeWhoami(stateKind: WhoamiPayload["state"]["kind"]): WhoamiPayload {
  const state: WhoamiPayload["state"] =
    stateKind === "error" ? { kind: "error", message: "refresh failed" } : { kind: stateKind };
  return {
    api_base_url: "https://api.git-ai.dev",
    backend: "production",
    api_key_masked: null,
    state,
    access_token_expires_at: null,
    refresh_token_expires_at: null,
    user_id: null,
    email: null,
    name: null,
    personal_org_id: null,
    orgs: [],
  };
}

const HEALTHY_CTX: QuickFixContext = {
  diagnostic: makeDiagnostic({}),
  hooks: makeHooks("official"),
  whoami: makeWhoami("logged_in"),
  isWindows: true,
};

// ===== 结构性断言 =====

describe("QUICK_FIX_CATALOG structure", () => {
  it("≥ 4 条预置条目(git shim 诊断已随上游淘汰移除)", () => {
    expect(QUICK_FIX_CATALOG.length).toBeGreaterThanOrEqual(4);
  });

  it("每条 id 唯一且非空", () => {
    const ids = QUICK_FIX_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });

  it("commands 段每条都带非空 comment(避免出现没解释的命令)", () => {
    for (const e of QUICK_FIX_CATALOG) {
      if (!e.commands) continue;
      for (const c of e.commands) {
        expect(c.cmd.trim().length).toBeGreaterThan(0);
        expect(c.comment.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("title / problem 都为非空中文(用户面),detect 是函数", () => {
    for (const e of QUICK_FIX_CATALOG) {
      expect(e.title.trim().length).toBeGreaterThan(0);
      expect(e.problem.trim().length).toBeGreaterThan(0);
      expect(typeof e.detect).toBe("function");
    }
  });
});

// ===== evaluateQuickFixes 整体行为 =====

describe("evaluateQuickFixes — sorting & empty cases", () => {
  it("健康 ctx:不命中任何 err / warn 条目", () => {
    // refs-notes-ai-stale 是 info 级别的主动提示(任务要求该条目在已登录场景下展示
    // "可能数据落后"修复路径,不依赖客观失败信号),所以健康 ctx 下允许它出现;
    // 但 err / warn 必须全部为 0。
    const hits = evaluateQuickFixes(HEALTHY_CTX);
    expect(hits.filter((h) => h.severity === "err").length).toBe(0);
    expect(hits.filter((h) => h.severity === "warn").length).toBe(0);
  });

  it("undefined diagnostic ctx 安全返回 [](不抛错)", () => {
    const hits = evaluateQuickFixes({
      diagnostic: undefined,
      hooks: undefined,
      whoami: undefined,
      isWindows: false,
    });
    expect(Array.isArray(hits)).toBe(true);
  });

  it("err 排在 warn / info 之前", () => {
    // 同时触发:hooks 缺失(err) + refs-notes-ai-stale(info)
    const ctx: QuickFixContext = {
      diagnostic: makeDiagnostic({
        agents: [makeAgent({ detected: true, configured: false })],
      }),
      hooks: makeHooks("official"),
      whoami: makeWhoami("logged_in"),
      isWindows: true,
    };
    const hits = evaluateQuickFixes(ctx);
    const severities = hits.map((h) => h.severity);
    // 至少有一条 err 在最前
    expect(severities[0]).toBe("err");
    // 任何 warn 索引必须小于任何 info 索引
    const warnMax = severities.lastIndexOf("warn");
    const infoMin = severities.indexOf("info");
    if (warnMax !== -1 && infoMin !== -1) {
      expect(warnMax).toBeLessThan(infoMin);
    }
  });
});

// ===== 每条规则单独测命中/不命中 =====

describe("git-ai-not-installed", () => {
  it("命中:degraded=git_ai_not_found", () => {
    const ctx: QuickFixContext = {
      diagnostic: makeDiagnostic({
        degraded: { kind: "git_ai_not_found", hint: "where 没找到" },
      }),
      hooks: undefined,
      whoami: undefined,
      isWindows: false,
    };
    const hits = evaluateQuickFixes(ctx);
    expect(hits.some((h) => h.id === "git-ai-not-installed")).toBe(true);
  });

  it("未装时其它依赖 git-ai 的规则不该重复命中(避免噪声)", () => {
    const ctx: QuickFixContext = {
      diagnostic: makeDiagnostic({
        degraded: { kind: "git_ai_not_found", hint: "x" },
      }),
      hooks: undefined,
      whoami: undefined,
      isWindows: true,
    };
    const hits = evaluateQuickFixes(ctx);
    expect(hits.some((h) => h.id === "refs-notes-ai-stale")).toBe(false);
    expect(hits.some((h) => h.id === "hooks-missing-for-installed-agents")).toBe(false);
  });
});

describe("refs-notes-ai-stale", () => {
  it("命中:git-ai 已装 + 有 repo + 已登录(主动提示用户可能数据落后)", () => {
    const hits = evaluateQuickFixes({
      diagnostic: makeDiagnostic({}),
      hooks: makeHooks("official"),
      whoami: makeWhoami("logged_in"),
      isWindows: true,
    });
    expect(hits.some((h) => h.id === "refs-notes-ai-stale")).toBe(true);
  });

  it("未登录时不命中(没登录就没远端可拉)", () => {
    const ctx: QuickFixContext = {
      diagnostic: makeDiagnostic({
        report: makeReport("not logged in"),
      }),
      hooks: makeHooks("official"),
      whoami: makeWhoami("logged_out"),
      isWindows: true,
    };
    const hits = evaluateQuickFixes(ctx);
    expect(hits.some((h) => h.id === "refs-notes-ai-stale")).toBe(false);
  });

  it("命中条目带 3 行命令且第一行是 cd <repo>", () => {
    const entry = QUICK_FIX_CATALOG.find((e) => e.id === "refs-notes-ai-stale")!;
    expect(entry.commands?.length).toBe(3);
    expect(entry.commands?.[0].cmd).toContain("cd ");
  });
});

describe("whoami-error", () => {
  it("命中:state.kind = refresh_expired", () => {
    const hits = evaluateQuickFixes({
      diagnostic: makeDiagnostic({}),
      hooks: makeHooks("official"),
      whoami: makeWhoami("refresh_expired"),
      isWindows: true,
    });
    expect(hits.some((h) => h.id === "whoami-error")).toBe(true);
  });

  it("命中:state.kind = error", () => {
    const hits = evaluateQuickFixes({
      diagnostic: makeDiagnostic({}),
      hooks: makeHooks("official"),
      whoami: makeWhoami("error"),
      isWindows: true,
    });
    expect(hits.some((h) => h.id === "whoami-error")).toBe(true);
  });

  it("不命中:state.kind = logged_in", () => {
    expect(evaluateQuickFixes(HEALTHY_CTX).some((h) => h.id === "whoami-error")).toBe(false);
  });

  it("whoami 缺失时不命中(数据未到 ≠ 异常)", () => {
    const hits = evaluateQuickFixes({
      diagnostic: makeDiagnostic({}),
      hooks: makeHooks("official"),
      whoami: undefined,
      isWindows: true,
    });
    expect(hits.some((h) => h.id === "whoami-error")).toBe(false);
  });
});

describe("hooks-missing-for-installed-agents", () => {
  it("命中:有 detected && !configured 的 agent", () => {
    const ctx: QuickFixContext = {
      diagnostic: makeDiagnostic({
        agents: [
          makeAgent({ agent: "Claude", detected: true, configured: false }),
          makeAgent({ agent: "Cursor", detected: false, configured: false }),
        ],
      }),
      hooks: makeHooks("official"),
      whoami: makeWhoami("logged_in"),
      isWindows: true,
    };
    const hits = evaluateQuickFixes(ctx);
    expect(hits.some((h) => h.id === "hooks-missing-for-installed-agents")).toBe(true);
  });

  it("不命中:detected 的 agent 全部 configured", () => {
    expect(
      evaluateQuickFixes(HEALTHY_CTX).some((h) => h.id === "hooks-missing-for-installed-agents"),
    ).toBe(false);
  });
});
