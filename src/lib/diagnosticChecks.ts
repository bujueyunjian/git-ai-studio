// 环境诊断的派生逻辑:把后端聚合 payload 翻译成人话级别的检查项清单(CheckItem[])。
//
// 这不是文案,是逻辑 —— 原先寄居在 copy.ts(i18n 门面)里,随 copy.ts 退役搬到此处。
// 文案仍走 i18n.t();本模块只负责"payload → 结构化检查项"的组装。
import i18n from "../i18n";
import type { AgentHookStatus, CheckItem, DiagnosticOverview, StatusLevel } from "./types";

// 内部 helper:key 是受控的代码常量,把 i18n.t cast 成宽松签名绕过 typed-key 字面量约束。
const t = (key: string, opts?: Record<string, unknown>): string =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, opts);

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

/** 把后端聚合 payload 翻译为人话级别的检查项清单。 */
export function buildCheckList(overview: DiagnosticOverview): CheckItem[] {
  const items: CheckItem[] = [];
  const { report, agents, degraded, repo } = overview;

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

  // 登录态检查已移除:本项目定位单开发者本机、无账号无云(登录仅为远端聚合/部门看板),
  // 本地归因不依赖登录,故"未登录"不应作为待处理项。需要登录指引时由 Settings 页承担。

  // 是否在 git 仓库内
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

  // 5) repo 自定义 core.hooksPath
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

  // 6) ~/.claude/settings.json 含 hook
  const claude = agents.find((a) => a.agent === "Claude");
  if (claude) {
    items.push(agentHookItem(claude));
  }

  // 7) 至少一个 agent 已配置
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

  // 8) 当前 HEAD 是否有 checkpoint
  // 0 个 checkpoint 是正常空态(新 HEAD 还没 AI 编辑/保存),不是配置错误也无从修复 ——
  // 故空时用 muted(中性信息)而非 warn,不污染"需要处理";有 checkpoint 时 ok。
  const wlc = repo?.working_logs_count ?? 0;
  items.push({
    id: "working-logs",
    label: t("diagnostic.check.workingLogsLabel"),
    level: wlc > 0 ? "ok" : "muted",
    detail: repo
      ? t("diagnostic.check.workingLogsDetailTemplate", { n: wlc })
      : t("diagnostic.check.workingLogsDetailNoRepo"),
    impact: wlc > 0 ? undefined : t("diagnostic.check.workingLogsImpactEmpty"),
  });

  // 9) GIT_AI_* 环境变量
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
