// 文案对外门面(已迁移到 i18next)。
//
// # 历史
// 早期版本里所有用户面文案硬编码在本文件;现在文案真源已挪到 `src/i18n/locales/{zh-CN,en}.json`,
// 本文件只剩 "结构化导出 + 调用 t()" 的薄壳,目的是不破坏既有 25+ 个消费方文件的 import 语句。
//
// # 设计
// - 所有 export 仍按页面/特性分组(`STATS_DEGRADED` / `HOOKS_MODE_DESCRIPTIONS` 等)。
// - 字符串字段用 getter 实现 —— 每次读取都重新调 `i18n.t()`,所以语言切换后,**新一次访问**
//   立即拿到新语言文案。
// - 派生函数(`(n: number) => ...`)在内部调 `i18n.t("key", { n })` 完成插值。
// - 仍包含 `buildCheckList` 这种结构化派生(把后端 payload 翻译为 CheckItem 列表),
//   它读 i18n 字段把结构填好,UI 拿到的还是同结构对象。
//
// # 加新文案的流程
// 1. 在 `src/i18n/locales/zh-CN.json` 与 `en.json` 同步加 key(扁平 dot path,见 `i18n/index.ts` 头注)
// 2. 在本文件相应分组对象里加 getter 字段(或直接在消费方组件里用 `useTranslation()` + `t("...")`)
// 3. 新组件首选 `useTranslation()`,不需要再扩本文件——本文件保留是为兼容存量代码。

import i18n from "../i18n";
import type {
  AgentHookStatus,
  CheckItem,
  DiagnosticOverview,
  ShimStatus,
  StatusLevel,
} from "./types";

const t = (key: string, opts?: Record<string, unknown>): string =>
  i18n.t(key, opts ?? {}) as string;

const tArray = (key: string): string[] => {
  const v = i18n.t(key, { returnObjects: true });
  return Array.isArray(v) ? (v as string[]) : [];
};

// P1 不预判任何版本(对齐 feedback_git_ai_latest):空集合 = 不主动报警。
const KNOWN_BAD_VERSIONS = new Set<string>();

// 只有这几个 GIT_AI_* 变量出现时才警告,其它(如 GIT_AI_LOG_LEVEL)视为开发者调试,放过。
const ENV_VARS_THAT_WARN = ["GIT_AI_PATH", "GIT_AI_HOME", "GIT_AI_BIN", "GIT_AI_HOOK_BIN"];

function section(report: DiagnosticOverview["report"], name: string) {
  return report.sections.find((s) => s.name.toLowerCase() === name.toLowerCase());
}
function entry(report: DiagnosticOverview["report"], section_name: string, key: string) {
  const s = section(report, section_name);
  if (!s) return undefined;
  const found = s.entries.find(([k]) => k.toLowerCase() === key.toLowerCase());
  return found ? found[1] : undefined;
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  return ["true", "yes", "y", "1", "in repository", "inside"].includes(v.trim().toLowerCase());
}

function isLoggedIn(v: string | undefined): boolean {
  if (!v) return false;
  return /^\s*logged\s*in\b/i.test(v.trim());
}

/** 把后端聚合 payload 翻译为人话级别的检查项清单。 */
export function buildCheckList(overview: DiagnosticOverview): CheckItem[] {
  const items: CheckItem[] = [];
  const { report, shim, agents, degraded, repo } = overview;

  // 1) git-ai 二进制
  if (degraded?.kind === "git_ai_not_found") {
    items.push({
      id: "git-ai-binary",
      label: t("diagnostic.check.gitAiBinaryLabel"),
      level: "err",
      detail: degraded.hint,
      impact: t("diagnostic.check.gitAiBinaryImpact"),
      fix: { to: "install", label: t("diagnostic.check.gitAiBinaryFix") },
    });
  } else {
    items.push({
      id: "git-ai-binary",
      label: t("diagnostic.check.gitAiBinaryLabel"),
      level: "ok",
      detail: entry(report, "Versions", "Git AI binary"),
    });
  }

  // 2) git-ai 版本
  const ver = report.git_ai_version;
  if (ver) {
    const lvl: StatusLevel = KNOWN_BAD_VERSIONS.has(ver) ? "warn" : "ok";
    items.push({
      id: "git-ai-version",
      label: t("diagnostic.check.gitAiVersionLabel"),
      level: lvl,
      detail: ver,
      impact: lvl === "warn" ? t("diagnostic.check.gitAiVersionImpactWarn") : undefined,
      fix:
        lvl === "warn"
          ? { to: "install", label: t("diagnostic.check.gitAiVersionFix") }
          : undefined,
    });
  }

  // 3) git shim PATH 顺序
  items.push(shimItem(shim));

  // 4) 登录态
  const login = entry(report, "Git AI Login", "Status");
  if (login) {
    const ok = isLoggedIn(login);
    items.push({
      id: "login",
      label: t("diagnostic.check.loginLabel"),
      level: ok ? "ok" : "warn",
      detail: login,
      impact: ok ? undefined : t("diagnostic.check.loginImpactNotLoggedIn"),
      fix: ok ? undefined : { to: "settings", label: t("diagnostic.check.loginFix") },
    });
  }

  // 5) 是否在 git 仓库内
  const inRepo = entry(report, "Repository", "In repository");
  if (inRepo) {
    const ok = isTruthy(inRepo);
    items.push({
      id: "in-repo",
      label: t("diagnostic.check.inRepoLabel"),
      level: ok ? "ok" : "warn",
      detail: repo?.path ?? entry(report, "Repository", "Workdir") ?? "—",
      impact: ok ? undefined : t("diagnostic.check.inRepoImpactMissing"),
      fix: ok ? undefined : { to: "repo", label: t("diagnostic.check.inRepoFix") },
    });
  }

  // 6) repo 自定义 core.hooksPath
  const hooksPath = entry(report, "Git Config", "core.hooksPath");
  if (hooksPath !== undefined && hooksPath !== "") {
    items.push({
      id: "core-hooks-path",
      label: t("diagnostic.check.coreHooksPathLabel"),
      level: "warn",
      detail: hooksPath,
      impact: t("diagnostic.check.coreHooksPathImpactWarn"),
      fix: { to: "hooks", label: t("diagnostic.check.coreHooksPathFixWarn") },
    });
  } else {
    items.push({
      id: "core-hooks-path",
      label: t("diagnostic.check.coreHooksPathLabel"),
      level: "ok",
    });
  }

  // 7) ~/.claude/settings.json 含 hook
  const claude = agents.find((a) => a.agent === "Claude");
  if (claude) {
    items.push(agentHookItem(claude));
  }

  // 8) 至少一个 agent 已配置
  const configuredCount = agents.filter((a) => a.configured).length;
  items.push({
    id: "any-agent-configured",
    label: t("diagnostic.check.anyAgentConfiguredLabel"),
    level: configuredCount > 0 ? "ok" : "err",
    detail: t("diagnostic.check.anyAgentConfiguredDetailTemplate", {
      configured: configuredCount,
      total: agents.length,
    }),
    impact: configuredCount > 0 ? undefined : t("diagnostic.check.anyAgentConfiguredImpactErr"),
    fix:
      configuredCount > 0
        ? undefined
        : { to: "hooks", label: t("diagnostic.check.anyAgentConfiguredFix") },
  });

  // 9) 当前 HEAD 是否有 checkpoint
  const wlc = repo?.working_logs_count ?? 0;
  items.push({
    id: "working-logs",
    label: t("diagnostic.check.workingLogsLabel"),
    level: wlc > 0 ? "ok" : "warn",
    detail: repo
      ? t("diagnostic.check.workingLogsDetailTemplate", { n: wlc })
      : t("diagnostic.check.workingLogsDetailNoRepo"),
    impact: wlc > 0 ? undefined : t("diagnostic.check.workingLogsImpactEmpty"),
  });

  // 10) GIT_AI_* 环境变量
  const envSection = section(report, "Git AI Environment");
  if (envSection) {
    const anyWarnVar = ENV_VARS_THAT_WARN.find((k) => envSection.raw.includes(`${k}=`));
    items.push({
      id: "git-ai-env",
      label: t("diagnostic.check.envLabel"),
      level: anyWarnVar ? "warn" : "ok",
      detail: anyWarnVar
        ? t("diagnostic.check.envDetectedTemplate", { var: anyWarnVar })
        : t("diagnostic.check.envNormal"),
      impact: anyWarnVar ? t("diagnostic.check.envImpactWarn") : undefined,
    });
  }

  return items;
}

function shimItem(shim: ShimStatus): CheckItem {
  if (shim.resolved_paths.length === 0) {
    return {
      id: "git-shim",
      label: t("diagnostic.check.gitShimLabel"),
      level: "err",
      detail: t("diagnostic.check.gitShimErrDetail"),
      impact: t("diagnostic.check.gitShimErrImpact"),
      fix: { to: "install", label: t("diagnostic.check.gitShimGoInstall") },
    };
  }
  return {
    id: "git-shim",
    label: t("diagnostic.check.gitShimLabel"),
    level: shim.first_is_shim ? "ok" : "err",
    detail: shim.first_is_shim
      ? t("diagnostic.check.gitShimFirstIsShimTemplate", { expected: shim.expected_shim })
      : t("diagnostic.check.gitShimMismatchTemplate", {
          actual: shim.resolved_paths[0],
          expected: shim.expected_shim,
        }),
    impact: shim.first_is_shim ? undefined : t("diagnostic.check.gitShimMismatchImpact"),
    fix: shim.first_is_shim
      ? undefined
      : { to: "install", label: t("diagnostic.check.gitShimReinstall") },
  };
}

function agentHookItem(a: AgentHookStatus): CheckItem {
  if (!a.detected) {
    return {
      id: `agent-${a.agent.toLowerCase()}`,
      label: t("diagnostic.check.agentDetectedFalseTemplate", { agent: a.agent }),
      level: "muted",
      detail: t("diagnostic.check.agentDetectedFalseDetail"),
    };
  }
  return {
    id: `agent-${a.agent.toLowerCase()}`,
    label: t("diagnostic.check.agentConfiguredTrueTemplate", { agent: a.agent }),
    level: a.configured ? "ok" : "err",
    detail: a.configured
      ? (a.raw_excerpt ?? t("diagnostic.check.agentConfiguredDetail"))
      : a.issues.join("; "),
    impact: a.configured
      ? undefined
      : t("diagnostic.check.agentConfiguredImpactErrTemplate", { agent: a.agent }),
    fix: a.configured
      ? undefined
      : { to: "hooks", label: t("diagnostic.check.agentConfiguredFixErr") },
  };
}

/** 顶部总览条用的 5 项摘要(粗粒度色块)。 */
export function buildOverviewChips(items: CheckItem[]) {
  const get = (id: string) => items.find((i) => i.id === id);
  return [
    { id: "git-ai-binary", label: t("diagnostic.overviewChips.gitAi"), item: get("git-ai-binary") },
    { id: "git-shim", label: t("diagnostic.overviewChips.gitShim"), item: get("git-shim") },
    { id: "login", label: t("diagnostic.overviewChips.login"), item: get("login") },
    {
      id: "any-agent-configured",
      label: t("diagnostic.overviewChips.hooks"),
      item: get("any-agent-configured"),
    },
    { id: "in-repo", label: t("diagnostic.overviewChips.repo"), item: get("in-repo") },
  ];
}

// ===== 必现提示文案 =====

/**
 * 单条消息文案的统一出口。每个字段是 getter,访问时实时调 i18n.t() 返回 **plain string**。
 *
 * # 为什么是 getter 对象而不是顶层 string 常量
 * React 渲染 children 时只接受 string / number / ReactElement 等,**不会**对 object 调
 * `.toString()` / `Symbol.toPrimitive` —— 直接把任意 object 当 `<div>{x}</div>` 的 child 会抛
 * "Objects are not valid as a React child"。所以"懒字符串包装对象"方案对 JSX child 不可行。
 * getter 字段每次返回真正的 string primitive:既能直接当 JSX child,又能在语言切换后
 * (组件树重渲染)拿到新语言文案。本文件所有零散字符串文案(MSG / *_TEXT)统一遵循此形态。
 */
export const MSG = {
  get mustRestartAgent(): string {
    return t("common.mustRestartAgent");
  },
  get mustReopenTerminal(): string {
    return t("common.mustReopenTerminal");
  },
  get noUploadNotice(): string {
    return t("common.noUploadNotice");
  },
  get winPathSafeHint(): string {
    return t("common.winPathSafeHint");
  },
  get ccSwitchWarning(): string {
    return t("common.ccSwitchWarning");
  },
};

/** 安装副作用清单。返回数组每次访问都重新生成(语言切换后立即反映)。 */
export const INSTALL_SIDE_EFFECTS: string[] = makeArrayProxy("install.sideEffects");
export const UNINSTALL_SIDE_EFFECTS_REMOVED: string[] = makeArrayProxy("install.uninstallRemoved");
export const UNINSTALL_SIDE_EFFECTS_KEPT: string[] = makeArrayProxy("install.uninstallKept");

/** Hooks 切换副作用清单 —— 两个目标模式。 */
export const HOOKS_SWITCH_SIDE_EFFECTS_TO_OFFICIAL: string[] = makeArrayProxy(
  "hooks.switchSideEffects.toOfficial",
);
export const HOOKS_SWITCH_SIDE_EFFECTS_TO_NONE: string[] = makeArrayProxy(
  "hooks.switchSideEffects.toNone",
);

/** Hooks 模式描述。getter 对象 —— 调用方写 `HOOKS_MODE_DESCRIPTIONS[mode]` 时实时求值。 */
export const HOOKS_MODE_DESCRIPTIONS: Record<"official" | "none", string> = Object.defineProperties(
  {} as Record<"official" | "none", string>,
  {
    official: { get: () => t("hooks.mode.official"), enumerable: true },
    none: { get: () => t("hooks.mode.none"), enumerable: true },
  },
);

/**
 * 把数组 i18n key 包成 Proxy:调用方既能 `arr.map(...)`,又能 `arr[0]`、`arr.length`,
 * 而内部每次都重新走 i18n。
 */
function makeArrayProxy(key: string): string[] {
  return new Proxy([] as string[], {
    get(_, prop, receiver) {
      const cur = tArray(key);
      const v = Reflect.get(cur, prop, receiver);
      return typeof v === "function" ? v.bind(cur) : v;
    },
    has(_, prop) {
      return prop in tArray(key);
    },
    ownKeys() {
      return Reflect.ownKeys(tArray(key));
    },
    getOwnPropertyDescriptor(_, prop) {
      return Object.getOwnPropertyDescriptor(tArray(key), prop);
    },
  });
}

/**
 * 把对象字面量(key -> 字符串字段)包成 getter 对象。各字段访问时实时调 t()。
 * 嵌套对象用嵌套调用本函数(本文件下方各模块即用此方式)。
 *
 * 用法:`makeObj({ title: "stats.degraded.repoMissing.title", cta: "stats.degraded.repoMissing.cta" })`
 */
function makeObj<T extends Record<string, string>>(map: T): { [K in keyof T]: string } {
  const out = {} as { [K in keyof T]: string };
  for (const k of Object.keys(map) as (keyof T)[]) {
    Object.defineProperty(out, k, {
      get: () => t(map[k]),
      enumerable: true,
    });
  }
  return out;
}

/** 同 makeObj,但每个字段可选 cta —— description / cta 可能为 undefined(原 copy.ts 行为)。 */
function degradedSection<T extends Record<string, string | undefined>>(
  map: T,
): { [K in keyof T]: T[K] extends undefined ? undefined : string } {
  const out = {} as { [K in keyof T]: T[K] extends undefined ? undefined : string };
  for (const k of Object.keys(map) as (keyof T)[]) {
    const key = map[k];
    Object.defineProperty(out, k, {
      get: () => (key === undefined ? undefined : t(key)),
      enumerable: true,
    });
  }
  return out;
}

/** git-ai daemon 僵尸 lock。 */
export const DAEMON_STALE_LOCK = {
  get title() {
    return t("daemon.staleLock.title");
  },
  get hint() {
    return t("daemon.staleLock.hint");
  },
  get step_label() {
    return t("daemon.staleLock.stepLabel");
  },
  get copy_cmd_label() {
    return t("daemon.staleLock.copyCmdLabel");
  },
  cmd_for_windows: (lockPath: string, pidPath: string) => `del /f /q "${lockPath}" "${pidPath}"`,
  cmd_for_unix: (lockPath: string, pidPath: string) => `rm -f "${lockPath}" "${pidPath}"`,
};

/** git-ai daemon lock 仍被进程持有,但 pid metadata 已缺失/损坏。 */
export const DAEMON_BLOCKED_LOCK = {
  get title() {
    return t("daemon.blockedLock.title");
  },
  get hint() {
    return t("daemon.blockedLock.hint");
  },
  get step_label() {
    return t("daemon.blockedLock.stepLabel");
  },
  get copy_cmd_label() {
    return t("daemon.blockedLock.copyCmdLabel");
  },
  cmd_for_windows: (lockPath: string, pidPath: string, pid: number | null) =>
    [
      pid === null ? "Get-Process git-ai" : `taskkill /F /T /PID ${pid}`,
      `del /f /q "${lockPath}" "${pidPath}"`,
      "git-ai status --json",
    ].join("; "),
  cmd_for_unix: (lockPath: string, pidPath: string, pid: number | null) =>
    [
      pid === null ? "ps -ef | grep git-ai" : `kill -9 ${pid}`,
      `rm -f "${lockPath}" "${pidPath}"`,
      "git-ai status --json",
    ].join(" && "),
};

// ===== Stats 页 =====

export const STATS_DEGRADED = {
  repo_missing: degradedSection({
    title: "stats.degraded.repoMissing.title",
    description: "stats.degraded.repoMissing.description",
    cta: "stats.degraded.repoMissing.cta",
  }),
  git_ai_missing: degradedSection({
    title: "stats.degraded.gitAiMissing.title",
    description: "stats.degraded.gitAiMissing.description",
    cta: "stats.degraded.gitAiMissing.cta",
  }),
  no_head: degradedSection({
    title: "stats.degraded.noHead.title",
    description: "stats.degraded.noHead.description",
    cta: undefined,
  }),
};

export const STATS_NOTE_TEXT = makeObj({
  merge: "stats.noteText.merge",
  empty_additions: "stats.noteText.emptyAdditions",
  working_logs_missing: "stats.noteText.workingLogsMissing",
});

export const FORMULA_POPOVER_LABELS = makeObj({
  definition: "formula.definition",
  formula: "formula.formula",
  example: "formula.example",
});

export const STATS_CACHE_HINT = {
  /** 30s 是策略常量,非文案。 */
  stale_time_seconds: 30,
  get refreshed_prefix() {
    return t("stats.cacheHint.refreshedPrefix");
  },
  get refresh_now() {
    return t("stats.cacheHint.refreshNow");
  },
  get refreshing() {
    return t("stats.cacheHint.refreshing");
  },
  get cache_policy() {
    return t("stats.cacheHint.cachePolicy");
  },
};

// ===== Dashboard 页 =====

export const DASHBOARD_METRIC_TITLES = makeObj({
  head_ai_rate: "dashboard.metricTitles.headAiRate",
  window_ai_total: "dashboard.metricTitles.windowAiTotal",
  hook_coverage: "dashboard.metricTitles.hookCoverage",
});

export const DASHBOARD_METRIC_SOURCES = makeObj({
  head_ai_rate: "dashboard.metricSources.headAiRate",
  window_ai_total: "dashboard.metricSources.windowAiTotal",
  hook_coverage: "dashboard.metricSources.hookCoverage",
});

export const DASHBOARD_METRIC_ERRORS = {
  get head_failed() {
    return t("dashboard.metricErrors.headFailed");
  },
  get head_unavailable() {
    return t("dashboard.metricErrors.headUnavailable");
  },
  get hook_failed() {
    return t("dashboard.metricErrors.hookFailed");
  },
  get diagnose_cta() {
    return t("dashboard.metricErrors.diagnoseCta");
  },
  degraded: makeObj({
    repo_missing: "dashboard.metricErrors.degraded.repoMissing",
    git_ai_missing: "dashboard.metricErrors.degraded.gitAiMissing",
    no_head: "dashboard.metricErrors.degraded.noHead",
  }),
};

export const DASHBOARD_DEGRADED = {
  repo_missing: degradedSection({
    title: "dashboard.degraded.repoMissing.title",
    description: "dashboard.degraded.repoMissing.description",
    cta: "dashboard.degraded.repoMissing.cta",
  }),
  git_ai_missing: degradedSection({
    title: "dashboard.degraded.gitAiMissing.title",
    description: "dashboard.degraded.gitAiMissing.description",
    cta: "dashboard.degraded.gitAiMissing.cta",
  }),
};

export const DASHBOARD_EMPTY_WINDOW = {
  get title() {
    return t("dashboard.emptyWindow.title");
  },
  description_template: (rangeLabel: string) =>
    t("dashboard.emptyWindow.descriptionTemplate", { rangeLabel }),
  get widen_cta() {
    return t("dashboard.emptyWindow.widenCta");
  },
};

/** Dashboard 页零散字符串文案。字段为 getter,访问时实时取 i18n。 */
export const DASHBOARD_TEXT = {
  get chartAllZero(): string {
    return t("dashboard.chartAllZero");
  },
};

export const DASHBOARD_TRUNCATED_HINT = (cap: number) => t("dashboard.truncatedHint", { cap });

export const DASHBOARD_FAILED_HINT = (n: number) => t("dashboard.failedHint", { n });

export const DASHBOARD_CACHE_HINT = {
  stale_time_seconds: 30,
  get refresh_now() {
    return t("dashboard.cacheHint.refreshNow");
  },
  get refreshing() {
    return t("dashboard.cacheHint.refreshing");
  },
  cached_template: (hits: number, total: number) =>
    t("dashboard.cacheHint.cachedTemplate", { hits, total }),
};

// ===== Blame 页 =====

export const BLAME_DEGRADED = {
  repo_missing: degradedSection({
    title: "blame.degraded.repoMissing.title",
    description: "blame.degraded.repoMissing.description",
    cta: "blame.degraded.repoMissing.cta",
  }),
  git_ai_missing: degradedSection({
    title: "blame.degraded.gitAiMissing.title",
    description: "blame.degraded.gitAiMissing.description",
    cta: "blame.degraded.gitAiMissing.cta",
  }),
  no_head: degradedSection({
    title: "blame.degraded.noHead.title",
    description: "blame.degraded.noHead.description",
    cta: undefined,
  }),
  commit_not_found: {
    get title() {
      return t("blame.degraded.commitNotFound.title");
    },
    description_template: (sha: string) =>
      t("blame.degraded.commitNotFound.descriptionTemplate", { sha }),
  },
  file_not_in_head: {
    get title() {
      return t("blame.degraded.fileNotInHead.title");
    },
    description_template: (file: string) =>
      t("blame.degraded.fileNotInHead.descriptionTemplate", { file }),
  },
  file_too_large: {
    get title() {
      return t("blame.degraded.fileTooLarge.title");
    },
    description_template: (size: number, limit: number) =>
      t("blame.degraded.fileTooLarge.descriptionTemplate", {
        sizeKb: (size / 1024).toFixed(1),
        limitKb: (limit / 1024).toFixed(0),
      }),
  },
  file_binary: makeObj({
    title: "blame.degraded.fileBinary.title",
    description: "blame.degraded.fileBinary.description",
  }),
  no_ai_authorship: makeObj({
    title: "blame.degraded.noAiAuthorship.title",
    description: "blame.degraded.noAiAuthorship.description",
  }),
};

export const BLAME_POPOVER = {
  get prompt_heading() {
    return t("blame.popover.promptHeading");
  },
  get agent_label() {
    return t("blame.popover.agentLabel");
  },
  get human_label() {
    return t("blame.popover.humanLabel");
  },
  get login_required() {
    return t("blame.popover.loginRequired");
  },
  get scope_warning_repo_wide() {
    return t("blame.popover.scopeWarningRepoWide");
  },
  accepted: (n: number) => t("blame.popover.acceptedTemplate", { n }),
  overriden: (n: number) => t("blame.popover.overridenTemplate", { n }),
  total_additions: (n: number) => t("blame.popover.totalAdditionsTemplate", { n }),
  total_deletions: (n: number) => t("blame.popover.totalDeletionsTemplate", { n }),
  get other_files_heading() {
    return t("blame.popover.otherFilesHeading");
  },
  other_files_more: (n: number) => t("blame.popover.otherFilesMoreTemplate", { n }),
  get commits_heading() {
    return t("blame.popover.commitsHeading");
  },
  get drift_caveat() {
    return t("blame.popover.driftCaveat");
  },
  get merge_caveat() {
    return t("blame.popover.mergeCaveat");
  },
};

export const BLAME_LINE_LEGEND = makeObj({
  ai: "blame.lineLegend.ai",
  non_ai: "blame.lineLegend.nonAi",
});

/** Blame 页零散字符串文案(行号范围输入 + 文件搜索)。字段为 getter,访问时实时取 i18n。 */
export const BLAME_TEXT = {
  get lrangeLabel(): string {
    return t("blame.lrange.label");
  },
  get lrangePlaceholder(): string {
    return t("blame.lrange.placeholder");
  },
  get lrangeInvalid(): string {
    return t("blame.lrange.invalid");
  },
  get fileSearchPlaceholder(): string {
    return t("blame.fileSearchPlaceholder");
  },
  get fileListEmpty(): string {
    return t("blame.fileListEmpty");
  },
};

export const BLAME_REF_PICKER = {
  get label() {
    return t("blame.refPicker.label");
  },
  get current_head() {
    return t("blame.refPicker.currentHead");
  },
  get trigger_title() {
    return t("blame.refPicker.triggerTitle");
  },
  get popover_title() {
    return t("blame.refPicker.popoverTitle");
  },
  get reset_to_head() {
    return t("blame.refPicker.resetToHead");
  },
  get branches_heading() {
    return t("blame.refPicker.branchesHeading");
  },
  get no_branches() {
    return t("blame.refPicker.noBranches");
  },
  get branches_loading() {
    return t("blame.refPicker.branchesLoading");
  },
  get branches_failed() {
    return t("blame.refPicker.branchesFailed");
  },
  get sha_input_heading() {
    return t("blame.refPicker.shaInputHeading");
  },
  get sha_input_placeholder() {
    return t("blame.refPicker.shaInputPlaceholder");
  },
  get sha_apply() {
    return t("blame.refPicker.shaApply");
  },
  get sha_empty() {
    return t("blame.refPicker.shaEmpty");
  },
  get ref_not_found_title() {
    return t("blame.refPicker.refNotFoundTitle");
  },
  ref_not_found_template: (r: string) => t("blame.refPicker.refNotFoundTemplate", { r }),
  active_chip_template: (r: string) => t("blame.refPicker.activeChipTemplate", { r }),
  get search_branches_placeholder() {
    return t("blame.refPicker.searchBranchesPlaceholder");
  },
};

export const BLAME_FILE_LIST_HINT = (n: number) => t("blame.fileListHintTemplate", { n });

// ===== Time range =====

export const TIME_RANGE_PRESETS: Array<{
  kind:
    | "today"
    | "yesterday"
    | "this_week"
    | "last_week"
    | "this_month"
    | "last_month"
    | "last_7_days"
    | "last_30_days"
    | "last_90_days";
  label: string;
}> = new Proxy([] as Array<{ kind: string; label: string }>, {
  get(_, prop) {
    const items = [
      { kind: "today", labelKey: "timeRange.presets.today" },
      { kind: "yesterday", labelKey: "timeRange.presets.yesterday" },
      { kind: "this_week", labelKey: "timeRange.presets.thisWeek" },
      { kind: "last_week", labelKey: "timeRange.presets.lastWeek" },
      { kind: "this_month", labelKey: "timeRange.presets.thisMonth" },
      { kind: "last_month", labelKey: "timeRange.presets.lastMonth" },
      { kind: "last_7_days", labelKey: "timeRange.presets.last7Days" },
      { kind: "last_30_days", labelKey: "timeRange.presets.last30Days" },
      { kind: "last_90_days", labelKey: "timeRange.presets.last90Days" },
    ];
    const resolved = items.map(({ kind, labelKey }) => ({ kind, label: t(labelKey) }));
    const v = Reflect.get(resolved, prop);
    return typeof v === "function" ? v.bind(resolved) : v;
  },
}) as never;

export const TIME_RANGE_CUSTOM_MAX_DAYS = 366;
export const TIME_RANGE_CUSTOM_TOO_WIDE = (max: number) =>
  t("timeRange.customTooWideTemplate", { max });

/** Time range 选择器零散字符串文案(自定义区间 + 触发按钮)。字段为 getter,访问时实时取 i18n。 */
export const TIME_RANGE_TEXT = {
  get customLabel(): string {
    return t("timeRange.customLabel");
  },
  get customStartLabel(): string {
    return t("timeRange.customStartLabel");
  },
  get customEndLabel(): string {
    return t("timeRange.customEndLabel");
  },
  get customApply(): string {
    return t("timeRange.customApply");
  },
  get customInvalidRange(): string {
    return t("timeRange.customInvalidRange");
  },
  get pickerLabel(): string {
    return t("timeRange.pickerLabel");
  },
};

// ===== git-ai 账号(Settings 页) =====

export const GIT_AI_ACCOUNT = makeObj({
  title: "gitAiAccount.title",
  hint: "gitAiAccount.hint",
  refresh: "gitAiAccount.refresh",
  refreshing: "gitAiAccount.refreshing",
  state_logged_in: "gitAiAccount.stateLoggedIn",
  state_logged_out: "gitAiAccount.stateLoggedOut",
  state_refresh_expired: "gitAiAccount.stateRefreshExpired",
  state_error: "gitAiAccount.stateError",
  logout_button: "gitAiAccount.logoutButton",
  logout_confirm_title: "gitAiAccount.logoutConfirmTitle",
  logout_confirm_description: "gitAiAccount.logoutConfirmDescription",
  logout_confirm_cta: "gitAiAccount.logoutConfirmCta",
  logout_cancel: "gitAiAccount.logoutCancel",
  logout_ok_toast: "gitAiAccount.logoutOkToast",
  logout_failed: "gitAiAccount.logoutFailed",
  degraded_git_ai_missing: "gitAiAccount.degradedGitAiMissing",
  cli_login_hint: "gitAiAccount.cliLoginHint",
});

// ===== show <sha> 原文 =====

export const SHOW_RAW = {
  get trigger() {
    return t("showRaw.trigger");
  },
  dialog_title: (sha: string) => t("showRaw.dialogTitleTemplate", { sha: sha.slice(0, 7) }),
  get dialog_description() {
    return t("showRaw.dialogDescription");
  },
  get empty() {
    return t("showRaw.empty");
  },
  get copy_button() {
    return t("showRaw.copyButton");
  },
  get copied_toast() {
    return t("showRaw.copiedToast");
  },
  get load_failed() {
    return t("showRaw.loadFailed");
  },
  get degraded_repo_missing() {
    return t("showRaw.degradedRepoMissing");
  },
  get degraded_git_ai_missing() {
    return t("showRaw.degradedGitAiMissing");
  },
};

// ===== effective-ignore-patterns(Settings 页) =====

export const EFFECTIVE_IGNORE = makeObj({
  title: "effectiveIgnore.title",
  hint: "effectiveIgnore.hint",
  refresh: "effectiveIgnore.refresh",
  refreshing: "effectiveIgnore.refreshing",
  list_empty: "effectiveIgnore.listEmpty",
  degraded_repo_missing: "effectiveIgnore.degradedRepoMissing",
  degraded_git_ai_missing: "effectiveIgnore.degradedGitAiMissing",
});

/** Chart 段标签(中文,与 chartColors 桶一一对应)。 */
export const CHART_BUCKET_LABEL: Record<"human" | "unknown" | "ai", string> =
  Object.defineProperties({} as Record<"human" | "unknown" | "ai", string>, {
    human: { get: () => t("chart.human"), enumerable: true },
    unknown: { get: () => t("chart.unknown"), enumerable: true },
    ai: { get: () => t("chart.ai"), enumerable: true },
  });

// ===== Notes 页 =====

export const NOTES_DEGRADED = {
  repo_missing: degradedSection({
    title: "notes.degraded.repoMissing.title",
    description: "notes.degraded.repoMissing.description",
    cta: "notes.degraded.repoMissing.cta",
  }),
  no_notes_in_repo: degradedSection({
    title: "notes.degraded.noNotesInRepo.title",
    description: "notes.degraded.noNotesInRepo.description",
    cta: "notes.degraded.noNotesInRepo.cta",
  }),
};

export const LOW_AI_SHARE_ALERT = {
  get settings_title() {
    return t("lowAiShare.settingsTitle");
  },
  get settings_hint() {
    return t("lowAiShare.settingsHint");
  },
  get rules_title() {
    return t("lowAiShare.rulesTitle");
  },
  get rules(): readonly string[] {
    return tArray("lowAiShare.rules");
  },
  get threshold_label() {
    return t("lowAiShare.thresholdLabel");
  },
  get target_emails_label() {
    return t("lowAiShare.targetEmailsLabel");
  },
  get target_emails_placeholder() {
    return t("lowAiShare.targetEmailsPlaceholder");
  },
  get target_emails_help() {
    return t("lowAiShare.targetEmailsHelp");
  },
  get remind_interval_label() {
    return t("lowAiShare.remindIntervalLabel");
  },
  get dismiss_minutes_label() {
    return t("lowAiShare.dismissMinutesLabel");
  },
  toast_title: (pct: number, threshold: number, repoName: string | null) => {
    if (repoName) {
      return t("lowAiShare.toastTitleWithRepoTemplate", { pct, threshold, repoName });
    }
    return t("lowAiShare.toastTitleTemplate", { pct, threshold });
  },
  get toast_description() {
    return t("lowAiShare.toastDescription");
  },
  get toast_action_view() {
    return t("lowAiShare.toastActionView");
  },
  toast_action_dismiss: (duration: string) =>
    t("lowAiShare.toastActionDismissTemplate", { duration }),
  dismissed_toast: (duration: string) => t("lowAiShare.dismissedToastTemplate", { duration }),
};

export const NOTES_COMMIT_NO_NOTE = makeObj({
  title: "notes.commitNoNote.title",
  description: "notes.commitNoNote.description",
  view_stats: "notes.commitNoNote.viewStats",
});

export const NOTES_HEADER = {
  get schema_version_label() {
    return t("notes.header.schemaVersionLabel");
  },
  get git_ai_version_label() {
    return t("notes.header.gitAiVersionLabel");
  },
  get base_commit_sha_label() {
    return t("notes.header.baseCommitShaLabel");
  },
  get committed_at_label() {
    return t("notes.header.committedAtLabel");
  },
  summary_template: (files: number, prompts: number, humans: number, sessions: number) =>
    t("notes.header.summaryTemplate", { files, prompts, humans, sessions }),
  get view_stats() {
    return t("notes.header.viewStats");
  },
  get copy_full_json() {
    return t("notes.header.copyFullJson");
  },
  get copied() {
    return t("notes.header.copied");
  },
};

export const NOTES_SECTION_TITLES = makeObj({
  attestations: "notes.sectionTitles.attestations",
  prompts: "notes.sectionTitles.prompts",
  humans: "notes.sectionTitles.humans",
  sessions: "notes.sectionTitles.sessions",
});

/** 三类 hash chip 元数据。 icon / tone 与文本分离;文本走 i18n。 */
export const NOTES_CHIPS = {
  prompt: {
    get label() {
      return t("notes.chips.promptLabel");
    },
    icon: "Bot" as const,
    tone: "ai" as const,
  },
  human: {
    get label() {
      return t("notes.chips.humanLabel");
    },
    icon: "User" as const,
    tone: "human" as const,
  },
  session: {
    get label() {
      return t("notes.chips.sessionLabel");
    },
    icon: "Activity" as const,
    tone: "session" as const,
  },
};

export const NOTES_MESSAGES = {
  get collapsed_hint() {
    return t("notes.messages.collapsedHint");
  },
  /** 展开后顶部 amber bar 与 common.noUploadNotice 同源。 */
  get expanded_warn() {
    return t("common.noUploadNotice");
  },
  get type_user() {
    return t("notes.messages.typeUser");
  },
  get type_assistant() {
    return t("notes.messages.typeAssistant");
  },
  get type_tool_use() {
    return t("notes.messages.typeToolUse");
  },
  get no_messages() {
    return t("notes.messages.noMessages");
  },
};

export const NOTES_ACTIONS = makeObj({
  copy_hash: "notes.actions.copyHash",
  copy_prompt_json: "notes.actions.copyPromptJson",
  copy_messages_url: "notes.actions.copyMessagesUrl",
  open_blame_at_head: "notes.actions.openBlameAtHead",
  blame_disabled_non_head: "notes.actions.blameDisabledNonHead",
  blame_disabled_drift_caveat: "notes.actions.blameDisabledDriftCaveat",
});

/** Notes 页零散字符串文案(搜索框 + 空列表)。字段为 getter,访问时实时取 i18n。 */
export const NOTES_TEXT = {
  get searchPlaceholder(): string {
    return t("notes.searchPlaceholder");
  },
  get listEmpty(): string {
    return t("notes.listEmpty");
  },
};

export const NOTES_INSTRUCTIONS = makeObj({
  title: "notes.instructions.title",
  description: "notes.instructions.description",
});

export const NOTES_PARSE_FAILED = makeObj({
  title: "notes.parseFailed.title",
  description: "notes.parseFailed.description",
  raw_label: "notes.parseFailed.rawLabel",
});

// ===== Checkpoints 页 =====

export const CHECKPOINTS_DEGRADED = {
  repo_missing: degradedSection({
    title: "checkpoints.degraded.repoMissing.title",
    description: "checkpoints.degraded.repoMissing.description",
    cta: "checkpoints.degraded.repoMissing.cta",
  }),
  no_head: degradedSection({
    title: "checkpoints.degraded.noHead.title",
    description: "checkpoints.degraded.noHead.description",
    cta: undefined,
  }),
  git_ai_missing: degradedSection({
    title: "checkpoints.degraded.gitAiMissing.title",
    description: "checkpoints.degraded.gitAiMissing.description",
    cta: "checkpoints.degraded.gitAiMissing.cta",
  }),
  working_logs_dir_missing: degradedSection({
    title: "checkpoints.degraded.workingLogsDirMissing.title",
    description: "checkpoints.degraded.workingLogsDirMissing.description",
    cta: "checkpoints.degraded.workingLogsDirMissing.cta",
  }),
};

export const CHECKPOINTS_HEADER = {
  get page_title() {
    return t("checkpoints.header.pageTitle");
  },
  get subtitle() {
    return t("checkpoints.header.subtitle");
  },
  count_template: (n: number) => t("checkpoints.header.countTemplate", { n }),
  get head_sha_label() {
    return t("checkpoints.header.headShaLabel");
  },
  get pre_commit_note() {
    return t("checkpoints.header.preCommitNote");
  },
  get debug_dropdown() {
    return t("checkpoints.header.debugDropdown");
  },
};

/** 4 种 CheckpointKind 文案 + icon name。文本通过 getter 跟随 i18n;icon/tone 是 UI 常量。 */
export const CHECKPOINTS_KIND_LABELS: Record<
  "Human" | "AiAgent" | "AiTab" | "KnownHuman",
  {
    label: string;
    icon: string;
    tone: "human" | "ai_agent" | "ai_tab" | "known_human";
    tooltip: string;
  }
> = {
  Human: {
    get label() {
      return t("checkpoints.kind.human.label");
    },
    icon: "User",
    tone: "human",
    get tooltip() {
      return t("checkpoints.kind.human.tooltip");
    },
  } as unknown as { label: string; icon: string; tone: "human"; tooltip: string },
  AiAgent: {
    get label() {
      return t("checkpoints.kind.aiAgent.label");
    },
    icon: "Bot",
    tone: "ai_agent",
    get tooltip() {
      return t("checkpoints.kind.aiAgent.tooltip");
    },
  } as unknown as { label: string; icon: string; tone: "ai_agent"; tooltip: string },
  AiTab: {
    get label() {
      return t("checkpoints.kind.aiTab.label");
    },
    icon: "Sparkles",
    tone: "ai_tab",
    get tooltip() {
      return t("checkpoints.kind.aiTab.tooltip");
    },
  } as unknown as { label: string; icon: string; tone: "ai_tab"; tooltip: string },
  KnownHuman: {
    get label() {
      return t("checkpoints.kind.knownHuman.label");
    },
    icon: "UserCheck",
    tone: "known_human",
    get tooltip() {
      return t("checkpoints.kind.knownHuman.tooltip");
    },
  } as unknown as { label: string; icon: string; tone: "known_human"; tooltip: string },
};

export const CHECKPOINTS_CARD = {
  get expand() {
    return t("checkpoints.card.expand");
  },
  get collapse() {
    return t("checkpoints.card.collapse");
  },
  diff_label_template: (lines: number) => t("checkpoints.card.diffLabelTemplate", { lines }),
  get agent_metadata_label() {
    return t("checkpoints.card.agentMetadataLabel");
  },
  line_stats_template: (a: number, d: number, as: number, ds: number) =>
    t("checkpoints.card.lineStatsTemplate", { a, d, as, ds }),
  line_attribution_overrode_template: (prev: string) =>
    t("checkpoints.card.lineAttributionOverrodeTemplate", { prev: prev.slice(0, 8) }),
  get trace_id_label() {
    return t("checkpoints.card.traceIdLabel");
  },
  get api_version_label() {
    return t("checkpoints.card.apiVersionLabel");
  },
  get blame_at_head_button() {
    return t("checkpoints.card.blameAtHeadButton");
  },
  get blame_at_head_caveat() {
    return t("checkpoints.card.blameAtHeadCaveat");
  },
  get no_entries() {
    return t("checkpoints.card.noEntries");
  },
  get copy_json() {
    return t("checkpoints.card.copyJson");
  },
};

export const CHECKPOINTS_EMPTY_LIST = makeObj({
  title: "checkpoints.emptyList.title",
  description: "checkpoints.emptyList.description",
  cta_hooks: "checkpoints.emptyList.ctaHooks",
});

export const CHECKPOINTS_MOCK_DIALOG = {
  title_template: (preset: string) => t("checkpoints.mockDialog.titleTemplate", { preset }),
  get intro() {
    return t("checkpoints.mockDialog.intro");
  },
  get side_effects(): readonly string[] {
    return tArray("checkpoints.mockDialog.sideEffects");
  },
  get pathspecs_label() {
    return t("checkpoints.mockDialog.pathspecsLabel");
  },
  get pathspecs_placeholder() {
    return t("checkpoints.mockDialog.pathspecsPlaceholder");
  },
  get pathspecs_help() {
    return t("checkpoints.mockDialog.pathspecsHelp");
  },
  get dirty_preview_title() {
    return t("checkpoints.mockDialog.dirtyPreviewTitle");
  },
  get dirty_preview_unavailable() {
    return t("checkpoints.mockDialog.dirtyPreviewUnavailable");
  },
  dirty_preview_more_template: (n: number) =>
    t("checkpoints.mockDialog.dirtyPreviewMoreTemplate", { n }),
  dirty_preview_too_many_warn_template: (n: number) =>
    t("checkpoints.mockDialog.dirtyPreviewTooManyWarnTemplate", { n }),
  get confirm_input_label() {
    return t("checkpoints.mockDialog.confirmInputLabel");
  },
  get confirm_placeholder() {
    return t("checkpoints.mockDialog.confirmPlaceholder");
  },
  get start() {
    return t("checkpoints.mockDialog.start");
  },
  get cancel() {
    return t("checkpoints.mockDialog.cancel");
  },
  get starting() {
    return t("checkpoints.mockDialog.starting");
  },
  get running() {
    return t("checkpoints.mockDialog.running");
  },
  get log_title() {
    return t("checkpoints.mockDialog.logTitle");
  },
  get fire_and_forget_hint() {
    return t("checkpoints.mockDialog.fireAndForgetHint");
  },
  get done_ok() {
    return t("checkpoints.mockDialog.doneOk");
  },
  get irreversible_warn() {
    return t("checkpoints.mockDialog.irreversibleWarn");
  },
};

/** Checkpoints 页 mock 操作的忙碌态提示文案。字段为 getter,访问时实时取 i18n。 */
export const CHECKPOINTS_TEXT = {
  get mockBusy(): string {
    return t("checkpoints.mockBusy");
  },
  get installBusy(): string {
    return t("checkpoints.installBusy");
  },
  get hooksBusy(): string {
    return t("checkpoints.hooksBusy");
  },
};

export const WORKING_DIR_SUMMARY = {
  get label() {
    return t("workingDir.label");
  },
  tooltip_template: (h: number, u: number, a: number) =>
    t("workingDir.tooltipTemplate", { h, u, a }),
};

// ===== QuickFix Catalog =====

export const QUICK_FIX_CATALOG_COPY = {
  get section_title() {
    return t("quickFixCatalog.sectionTitle");
  },
  get section_hint() {
    return t("quickFixCatalog.sectionHint");
  },
  get empty() {
    return t("quickFixCatalog.empty");
  },
  severity_label: {
    get err() {
      return t("quickFixCatalog.severityErr");
    },
    get warn() {
      return t("quickFixCatalog.severityWarn");
    },
    get info() {
      return t("quickFixCatalog.severityInfo");
    },
  } as Record<"err" | "warn" | "info", string>,
  get dialog_intro() {
    return t("quickFixCatalog.dialogIntro");
  },
};

// ===== People 页 =====

export const PEOPLE_PAGE = {
  get title() {
    return t("people.page.title");
  },
  get subtitle() {
    return t("people.page.subtitle");
  },
  get search_placeholder() {
    return t("people.page.searchPlaceholder");
  },
  get export_csv() {
    return t("people.page.exportCsv");
  },
  get refresh() {
    return t("people.page.refresh");
  },
  get refreshing() {
    return t("people.page.refreshing");
  },
  get identity_hint() {
    return t("people.page.identityHint");
  },
  cached_template: (hits: number, total: number) =>
    t("people.page.cachedTemplate", { hits, total }),
};

export const PEOPLE_DEGRADED = {
  repo_missing: degradedSection({
    title: "people.degraded.repoMissing.title",
    description: "people.degraded.repoMissing.description",
    cta: "people.degraded.repoMissing.cta",
  }),
  git_ai_missing: degradedSection({
    title: "people.degraded.gitAiMissing.title",
    description: "people.degraded.gitAiMissing.description",
    cta: "people.degraded.gitAiMissing.cta",
  }),
};

export const PEOPLE_EMPTY_WINDOW = makeObj({
  title: "people.emptyWindow.title",
  description: "people.emptyWindow.description",
});

export const PEOPLE_EMPTY_SEARCH = makeObj({
  title: "people.emptySearch.title",
  description: "people.emptySearch.description",
});

export const PEOPLE_FAILED_HINT = (n: number) => t("people.failedHintTemplate", { n });
export const PEOPLE_TRUNCATED_HINT = (cap: number) => t("people.truncatedHintTemplate", { cap });

export const PEOPLE_METRIC_TITLES = makeObj({
  total_commits: "people.metricTitles.totalCommits",
  total_human: "people.metricTitles.totalHuman",
  total_ai: "people.metricTitles.totalAi",
  overall_ai_rate: "people.metricTitles.overallAiRate",
});

export const PEOPLE_TABLE_HEADERS = makeObj({
  author_name: "people.tableHeaders.authorName",
  author_email: "people.tableHeaders.authorEmail",
  commits: "people.tableHeaders.commits",
  human_additions: "people.tableHeaders.humanAdditions",
  unknown_additions: "people.tableHeaders.unknownAdditions",
  ai_additions: "people.tableHeaders.aiAdditions",
  total_additions: "people.tableHeaders.totalAdditions",
  ai_share: "people.tableHeaders.aiShare",
});

export const PEOPLE_ROW_COMMITS = {
  get heading() {
    return t("people.rowCommits.heading");
  },
  get empty() {
    return t("people.rowCommits.empty");
  },
  get merge_chip() {
    return t("people.rowCommits.mergeChip");
  },
  get failed_chip() {
    return t("people.rowCommits.failedChip");
  },
  ai_template: (n: number) => t("people.rowCommits.aiTemplate", { n }),
  human_template: (n: number) => t("people.rowCommits.humanTemplate", { n }),
};

// ===== 任务 #2 =====

export const CHANGED_FILES_SECTION = {
  get title() {
    return t("changedFiles.title");
  },
  get empty() {
    return t("changedFiles.empty");
  },
  get loading() {
    return t("changedFiles.loading");
  },
  get failed_prefix() {
    return t("changedFiles.failedPrefix");
  },
  get invalid_sha() {
    return t("changedFiles.invalidSha");
  },
  /** status 字符 → 中文标签。git diff-tree --name-status 输出字符表。 */
  get status_label(): Record<string, string> {
    return i18n.t("changedFiles.status", { returnObjects: true }) as Record<string, string>;
  },
  ai_line_chip_template: (n: number) => t("changedFiles.aiLineChipTemplate", { n }),
  get jump_blame_title() {
    return t("changedFiles.jumpBlameTitle");
  },
};

export const AUTHORS_JUMP_BLAME = makeObj({
  no_ai_lines_disabled: "authorsJumpBlame.noAiLinesDisabled",
  jump_title: "authorsJumpBlame.jumpTitle",
});
