// QuickFix Catalog:把"用户碰到的常见 git-ai 异常 → 该跑哪些命令 / 跳哪个页"集中管理。
//
// 设计要点:
// 1. 单一真源:Diagnostic 页的"自动检测到的问题"区块、任何后续位置(Stats / Blame degraded 文案)
//    都通过 evaluateQuickFixes(ctx) 命中条目;不再各处散写"先 cd 再 git-ai fetch-notes…"。
// 2. detect 纯函数,只依赖 DiagnosticOverview + HooksStatus + WhoamiPayload 这三类结构化输入,
//    不读 DOM、不发请求,便于单测。
// 3. commands 文案是"可直接复制运行"的整行;Windows PowerShell 与 Bash 二选一,Windows 优先
//    (本项目主要受众),`cd` 这种跨 shell 通用就直接用。
// 4. cta 字段指向 router.tsx 的 RouteId,UI 渲染"前往修复"按钮跳过去。

import type { RouteId } from "../router";
import type { AgentHookStatus, DiagnosticOverview, HooksStatus, WhoamiPayload } from "./types";

/** evaluateQuickFixes 的输入快照。Diagnostic 页拼好后传入即可。 */
export interface QuickFixContext {
  /** diagnose_environment 返回值,可能 undefined(尚未加载完)。 */
  diagnostic: DiagnosticOverview | undefined;
  /** get_hooks_status 返回值,可能 undefined。 */
  hooks: HooksStatus | undefined;
  /** get_whoami 返回值,可能 undefined。 */
  whoami: WhoamiPayload | undefined;
  /** 当前是否在 Windows 平台。影响 schtasks 类命令是否展示。 */
  isWindows: boolean;
}

/** 命令行单条 + 中文解释。每行渲染为 mono 字体 + Copy 按钮 + 解释。 */
export interface QuickFixCommand {
  /** 单行命令,允许包含占位 `<repo>` 等(UI 不替换,提示用户改)。 */
  cmd: string;
  /** 这一行干什么用,1 句话讲清楚。 */
  comment: string;
}

/** "前往修复"跳转按钮配置。 */
export interface QuickFixCta {
  label: string;
  route: RouteId;
}

/** Catalog 单条目的完整定义。 */
export interface QuickFixEntry {
  /** 唯一稳定 id,前端 key / 测试断言用。 */
  id: string;
  /** 卡片标题(短,一行内放下)。 */
  title: string;
  /** 问题描述(1-2 句中文,讲"为什么这是问题")。 */
  problem: string;
  /** 命中判定。返回 true 时该条目出现在"自动检测到的问题"区。 */
  detect: (ctx: QuickFixContext) => boolean;
  /** 修复要跑的命令,按顺序展示;可选(有些只是引导到对应页面)。 */
  commands?: QuickFixCommand[];
  /** "前往修复"按钮(可选)。 */
  cta?: QuickFixCta;
  /** 严重度,UI 用于排序/染色:err=红、warn=黄、info=蓝。 */
  severity: "err" | "warn" | "info";
}

// ===== 内部判定辅助 =====
// 登录态判定:git-ai status 的 "Login Status" 以 "logged in" 开头即视为已登录。
function isLoggedInRaw(v: string | undefined): boolean {
  if (!v) return false;
  return /^\s*logged\s*in\b/i.test(v.trim());
}

function reportEntry(
  diagnostic: DiagnosticOverview | undefined,
  sectionName: string,
  key: string,
): string | undefined {
  if (!diagnostic) return undefined;
  const s = diagnostic.report.sections.find(
    (x) => x.name.toLowerCase() === sectionName.toLowerCase(),
  );
  if (!s) return undefined;
  const found = s.entries.find(([k]) => k.toLowerCase() === key.toLowerCase());
  return found ? found[1] : undefined;
}

/** detected 且 !configured 视为 hook 缺失,与 Diagnostic.partitionAgentsForFix 同口径。 */
function hasMissingHook(agents: AgentHookStatus[]): boolean {
  return agents.some((a) => a.detected && !a.configured);
}

// ===== Catalog 主体 =====

/**
 * 预置 catalog。新增条目时:
 * - id 保持稳定(测试 / 用户 dismiss 记录都按 id 锁定)
 * - detect 写成纯函数;读不到的数据 fail-fast 返 false,不要兜底
 * - 文案走 i18n(quickFixCatalog.* keys),由 Diagnostic 页消费;这里只写 id / detect
 */
export const QUICK_FIX_CATALOG: readonly QuickFixEntry[] = [
  // ----- 1. git-ai 二进制不存在 -----
  {
    id: "git-ai-not-installed",
    severity: "err",
    title: "未检测到 git-ai 二进制",
    problem:
      "where/which 都找不到 git-ai。没有它,所有 AI 归因功能(stats / blame / notes)都无法工作。",
    detect: (ctx) => ctx.diagnostic?.degraded?.kind === "git_ai_not_found",
    cta: { label: "前往安装", route: "install" },
  },

  // ----- 2. refs/notes/ai 远端落后:本地有 commit 但 Dashboard 数据没刷新 -----
  // 当 git-ai 已装 + 已选仓库 + 已登录,但用户场景里常见远端 notes 落后。
  // 这条不靠后端"diff 远端 vs 本地",而是当上面三个前置都满足时主动提示"如果数据看着不对就跑这三行"。
  {
    id: "refs-notes-ai-stale",
    severity: "info",
    title: "Dashboard 数据可能落后于远端",
    problem:
      "如果你看到本机的 AI 归因比同事少,通常是 refs/notes/ai 还没从远端拉下来。手动 fetch 一次即可对齐。",
    detect: (ctx) => {
      const d = ctx.diagnostic;
      if (!d) return false;
      if (d.degraded?.kind === "git_ai_not_found") return false;
      if (!d.repo) return false;
      const login = reportEntry(d, "Git AI Login", "Status");
      return isLoggedInRaw(login);
    },
    commands: [
      { cmd: "cd <repo>", comment: "切到对应仓库根目录(把 <repo> 换成你的仓库路径)" },
      {
        cmd: "git-ai fetch-notes --remote origin",
        comment: "从 origin 拉取 refs/notes/ai,把同事 push 的 AI 归因同步到本地",
      },
      {
        cmd: "git-ai status",
        comment: "确认拉取后的归因状态,Dashboard / Stats 重新打开会读新数据",
      },
    ],
    cta: { label: "前往 Hooks 同步", route: "hooks" },
  },

  // ----- 3. whoami:token 失效 -----
  {
    id: "whoami-error",
    severity: "warn",
    title: "git-ai 登录态异常",
    problem:
      "本机 git-ai 凭据已过期或异常。本地归因仍工作,但远端聚合(部门看板)推送会失败。需要在终端重新登录。",
    detect: (ctx) => {
      const w = ctx.whoami;
      if (!w) return false;
      const s = w.state.kind;
      return s === "refresh_expired" || s === "error";
    },
    commands: [
      {
        cmd: "git-ai logout",
        comment: "清掉本机过期凭据,避免下次 login 被旧 token 卡住",
      },
      {
        cmd: "git-ai login",
        comment: "走 OAuth 重新登录,登录后回到本应用 Settings 页点「刷新登录态」即可看到已登录",
      },
    ],
    cta: { label: "前往 Settings 查看", route: "settings" },
  },

  // ----- 4. hooks 缺失(detected 但未 configured 的 agent ≥ 1)-----
  // 与 Diagnostic 顶部"修复缺失({n})"按钮互补:这里只在 Catalog 角度提示,具体修复仍走 Diagnostic 自带流程。
  {
    id: "hooks-missing-for-installed-agents",
    severity: "err",
    title: "已安装的 AI agent 未配置 git-ai hook",
    problem:
      "检测到至少一个 AI agent 已安装但 settings.json 内没有 git-ai 的 checkpoint hook。该 agent 编辑的代码会全部归为 unknown_additions,指标会失真。",
    detect: (ctx) => {
      const d = ctx.diagnostic;
      if (!d) return false;
      if (d.degraded?.kind === "git_ai_not_found") return false;
      return hasMissingHook(d.agents);
    },
    cta: { label: "前往 Hooks 修复", route: "hooks" },
  },
] as const;

/**
 * 对快照执行所有 catalog 条目的 detect,返回命中条目列表(按 severity err > warn > info 排序)。
 *
 * 调用方:Diagnostic 页 useMemo 包裹,避免每次渲染重算。
 */
export function evaluateQuickFixes(ctx: QuickFixContext): QuickFixEntry[] {
  const hits = QUICK_FIX_CATALOG.filter((e) => {
    try {
      return e.detect(ctx);
    } catch {
      // detect 抛错视为"不命中":单条规则 bug 不应导致整页崩。
      return false;
    }
  });
  const rank = { err: 0, warn: 1, info: 2 } as const;
  return [...hits].sort((a, b) => rank[a.severity] - rank[b.severity]);
}
