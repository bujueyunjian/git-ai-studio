import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ChevronRight,
  Copy,
  Info,
  Loader2,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Badge } from "../components/Badge";
import { Collapsible } from "../components/ui/CollapsibleSection";
import { QuickFixDialog, type QuickFixSkipEntry } from "../components/QuickFixDialog";
import { Dialog } from "../components/ui/DialogShell";
import { StatusDot } from "../components/StatusDot";
import { Tooltip } from "../components/ui/TooltipBubble";
import {
  diagnoseEnvironment,
  diagnoseGitAiDaemon,
  getAppSettings,
  getHooksStatus,
  getWhoami,
  installHooksForAgent,
  installHooksOfficial,
  invalidateDiagnosticCache,
  repairGitAiDaemon,
} from "../lib/api";
import { notify } from "../lib/osNotify";
import { cn } from "../lib/cn";
import { buildCheckList } from "../lib/diagnosticChecks";

// ===== daemon lock 清理命令生成（本地逻辑，与文案无关） =====

/** 僵尸 lock：进程已死，直接删除 lock/pid 文件 */
const staleLockCmd = {
  forWindows: (lockPath: string, pidPath: string) => `del /f /q "${lockPath}" "${pidPath}"`,
  forUnix: (lockPath: string, pidPath: string) => `rm -f "${lockPath}" "${pidPath}"`,
};

/** 进程阻塞 lock：先结束持锁进程，再删除 lock/pid 文件，最后验证 */
const blockedLockCmd = {
  forWindows: (lockPath: string, pidPath: string, pid: number | null) =>
    [
      pid === null ? "Get-Process git-ai" : `taskkill /F /T /PID ${pid}`,
      `del /f /q "${lockPath}" "${pidPath}"`,
      "git-ai status --json",
    ].join("; "),
  forUnix: (lockPath: string, pidPath: string, pid: number | null) =>
    [
      pid === null ? "ps -ef | grep git-ai" : `kill -9 ${pid}`,
      `rm -f "${lockPath}" "${pidPath}"`,
      "git-ai status --json",
    ].join(" && "),
};
import { evaluateQuickFixes, type QuickFixEntry } from "../lib/quickFixCatalog";
import type {
  AgentHookStatus,
  AgentKind,
  AppSettings,
  DaemonHealth,
  DaemonRepairResult,
  DiagnosticOverview,
  StatusLevel,
} from "../lib/types";
import { useRouter, type RouteId } from "../router";

const AGENT_LABEL: Record<AgentHookStatus["agent"], string> = {
  Claude: "Claude Code",
  Cursor: "Cursor",
  Codex: "Codex",
  OpenCode: "OpenCode",
  Gemini: "Gemini",
  Pi: "Pi",
};

function agentLevel(a: AgentHookStatus): StatusLevel {
  if (!a.detected) return "muted";
  if (a.configured) return "ok";
  return "err";
}

function genJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 是否在 daemon 修复完成后推送 OS 通知。
 * 复用「daemon 异常告警」总开关 —— 修复结果是告警闭环的一部分,
 * 用户开启告警就意味着希望被通知"已处理 / 处理失败"。
 */
function shouldPushDaemonRepairResult(settings: AppSettings | undefined): boolean {
  return !!settings?.notifications?.daemon_unhealthy_alert;
}

/** t 的宽松别名:模块级 helper 拼装 toast/通知文案时用,绕开 react-i18next 严格 key 类型 + 深实例化。 */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

function formatDaemonRepairResult(result: DaemonRepairResult, tt: Translate): string {
  const none = tt("diagnostic.daemonRepair.format.none");
  return [
    formatDaemonHealthForAlert(result.before, tt),
    tt("diagnostic.daemonRepair.format.killedPidsTemplate", {
      pids: result.killed_pids.length > 0 ? result.killed_pids.join(", ") : none,
    }),
    tt("diagnostic.daemonRepair.format.removedPathsTemplate", {
      paths: result.removed_paths.length > 0 ? result.removed_paths.join(", ") : none,
    }),
    tt("diagnostic.daemonRepair.format.afterStateTemplate", { kind: result.after.kind }),
  ].join("\n");
}

function formatDaemonHealthForAlert(health: DaemonHealth | null, tt: Translate): string {
  if (!health) return tt("diagnostic.daemonRepair.format.beforeUnknown");
  if (health.kind === "idle") return tt("diagnostic.daemonRepair.format.beforeIdle");
  if (health.kind === "running")
    return tt("diagnostic.daemonRepair.format.beforeRunningTemplate", { pid: health.pid });
  const lines = [
    tt("diagnostic.daemonRepair.format.beforeKindTemplate", { kind: health.kind }),
    `lock: ${health.lock_path}`,
    `pid metadata: ${health.pid_meta_path}`,
    `last pid: ${health.last_pid ?? "unknown"}`,
  ];
  if (health.kind === "blocked_lock_unknown_pid") {
    lines.push(
      `candidate pids: ${health.candidate_pids.length > 0 ? health.candidate_pids.join(", ") : "none"}`,
    );
  }
  return lines.join("\n");
}

/**
 * 把 agent 矩阵按"是否需要修复 / 跳过原因"分桶。
 * 修复目标:detected && !configured(install_hooks_official 只对这一桶生效)。
 * 跳过桶:未安装 / 已配置,各自标明原因供 QuickFixDialog 展示。
 */
function partitionAgentsForFix(
  agents: AgentHookStatus[],
  tt: Translate,
): {
  toFix: AgentHookStatus[];
  toSkip: QuickFixSkipEntry[];
} {
  const toFix: AgentHookStatus[] = [];
  const toSkip: QuickFixSkipEntry[] = [];
  for (const a of agents) {
    const label = AGENT_LABEL[a.agent];
    if (!a.detected) {
      toSkip.push({ item: label, reason: tt("diagnostic.agentHooks.skipNotInstalled") });
    } else if (a.configured) {
      toSkip.push({ item: label, reason: tt("diagnostic.agentHooks.skipConfigured") });
    } else {
      toFix.push(a);
    }
  }
  return { toFix, toSkip };
}

/** embedded=true 时收进 Setup 容器的 tab,Setup 已提供页级标题,这里隐藏自带大标题避免重复。 */
export default function DiagnosticPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const tt = t as unknown as Translate;
  const { navigate } = useRouter();
  const qc = useQueryClient();
  const [fixOpen, setFixOpen] = useState(false);
  const [daemonRepairTarget, setDaemonRepairTarget] = useState<Extract<
    DaemonHealth,
    { kind: "stale_lock" | "blocked_lock_unknown_pid" }
  > | null>(null);
  // 任务 #7:Catalog 单条命中后点开的"命令详情" dialog,与"修复缺失 hooks"互相独立。
  const [catalogEntry, setCatalogEntry] = useState<QuickFixEntry | null>(null);
  const winOs = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

  const q = useQuery({
    queryKey: ["diagnose_environment"],
    queryFn: () => diagnoseEnvironment(false),
    staleTime: 30_000,
  });
  // 读 hooks_status 用于推断默认 fixMode 和复用 self-hosted 端口。
  // refetchInterval 15s 与 TopBar 对齐,避免两份 query 抢同一份后端读但节奏不一。
  const hooksQ = useQuery({
    queryKey: ["hooks_status"],
    queryFn: getHooksStatus,
    refetchInterval: 15_000,
  });
  const settingsQ = useQuery({ queryKey: ["app_settings"], queryFn: getAppSettings });
  // 任务 #7 catalog whoami-error 条目需要的登录态。失败时不抛错,允许 catalog 兜底跳过该条规则。
  // staleTime 30s 与 diagnose 同档;不在此 refetchInterval(登录态变化不快,15s 轮询无价值)。
  const whoamiQ = useQuery({
    queryKey: ["get_whoami"],
    queryFn: getWhoami,
    staleTime: 30_000,
    retry: false,
  });
  // 单独探测 daemon 健康。100ms 级,单独 query 不进 diagnose payload —— stale 状态
  // 是用户必须立刻看到的"hook 全线阻塞"信号,需要独立刷新与高优先级横幅展示。
  const daemonHealthQ = useQuery({
    queryKey: ["diagnose_git_ai_daemon"],
    queryFn: diagnoseGitAiDaemon,
    refetchInterval: 30_000,
  });

  const refreshM = useMutation({
    mutationFn: async () => {
      await invalidateDiagnosticCache();
      return diagnoseEnvironment(true);
    },
    onSuccess: (data) => {
      qc.setQueryData(["diagnose_environment"], data);
      toast.success(t("diagnostic.refresh.success"));
    },
    onError: (e) =>
      toast.error(t("diagnostic.refresh.error"), { description: (e as Error).message }),
  });

  const daemonRepairM = useMutation({
    mutationFn: repairGitAiDaemon,
    onSuccess: (result) => {
      setDaemonRepairTarget(null);
      qc.invalidateQueries({ queryKey: ["diagnose_git_ai_daemon"] });
      // "已自愈"分支:后端在 before=Idle/Running 时返 no-op Ok(killed_pids/removed_paths 均空)。
      // 这种情况下用户在告警和点击修复之间 daemon 已经恢复,UI 应展示"虚惊一场",不再发 OS 通知。
      const selfHealed =
        result.killed_pids.length === 0 &&
        result.removed_paths.length === 0 &&
        (result.before.kind === "idle" || result.before.kind === "running");
      if (selfHealed) {
        toast.info(t("diagnostic.daemonRepair.selfHealed.title"), {
          description:
            result.before.kind === "running"
              ? t("diagnostic.daemonRepair.selfHealed.runningDescTemplate", {
                  pid: result.before.pid,
                })
              : t("diagnostic.daemonRepair.selfHealed.idleDesc"),
        });
        return;
      }
      toast.success(t("diagnostic.daemonRepair.success.title"), {
        description: t("diagnostic.daemonRepair.success.descTemplate", {
          killed: result.killed_pids.length,
          removed: result.removed_paths.length,
        }),
      });
      if (shouldPushDaemonRepairResult(settingsQ.data)) {
        void notify(
          t("diagnostic.daemonRepair.notify.successTitle"),
          formatDaemonRepairResult(result, tt),
        );
      }
    },
    onError: (e) => {
      const message = (e as Error).message;
      toast.error(t("diagnostic.daemonRepair.error.title"), { description: message });
      if (shouldPushDaemonRepairResult(settingsQ.data)) {
        void notify(
          t("diagnostic.daemonRepair.error.title"),
          t("diagnostic.daemonRepair.notify.errorBodyTemplate", {
            health: formatDaemonHealthForAlert(daemonRepairTarget, tt),
            message,
          }),
        );
      }
    },
  });

  const data: DiagnosticOverview | undefined = q.data;
  const items = useMemo(() => (data ? buildCheckList(data) : []), [data]);

  // 自动检查清单派生:异常(err/warn)置顶,统计通过数;全绿则默认折叠。
  const checklist = useMemo(() => {
    const rank: Record<StatusLevel, number> = { err: 0, warn: 1, ok: 2, muted: 3 };
    const problems = items.filter((it) => it.level === "err" || it.level === "warn");
    const passCount = items.filter((it) => it.level === "ok").length;
    const sorted = [...items].sort((a, b) => rank[a.level] - rank[b.level]);
    return { problems, passCount, total: items.length, allGreen: problems.length === 0, sorted };
  }, [items]);

  // 任务 #7 catalog 命中:把三份 query 数据组装成 ctx 后跑 evaluateQuickFixes。
  // whoamiQ 在 ok 时 payload 在 .data.payload,degraded 时无 payload。
  const whoamiPayload = whoamiQ.data?.status === "ok" ? whoamiQ.data.payload : undefined;
  const catalogHits = useMemo(
    () =>
      evaluateQuickFixes({
        diagnostic: data,
        hooks: hooksQ.data,
        whoami: whoamiPayload,
        isWindows: winOs,
      }),
    [data, hooksQ.data, whoamiPayload, winOs],
  );

  // P11 anti-pattern A 修复:把"修复缺失"从"跳转 Hooks 页"改造为同页 QuickFixDialog。
  // installHooksOfficial 是幂等命令,Diagnostic 已持有 agents 数据,
  // 中间不需要让用户再去 Hooks 页点一次。
  const { toFix, toSkip } = useMemo(
    () => (data ? partitionAgentsForFix(data.agents, tt) : { toFix: [], toSkip: [] }),
    [data, tt],
  );

  const officialFixM = useMutation({
    mutationFn: () => installHooksOfficial(genJobId()),
    onSuccess: () => {
      setFixOpen(false);
      toast.success(t("diagnostic.officialFix.successTemplate", { n: toFix.length }));
      toast.message(t("common.mustRestartAgent"));
      toast.message(t("common.mustReopenTerminal"));
      qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
      qc.invalidateQueries({ queryKey: ["hooks_status"] });
      qc.invalidateQueries({ queryKey: ["claude_settings"] });
    },
    onError: (e) =>
      toast.error(t("diagnostic.officialFix.error"), { description: (e as Error).message }),
  });

  /**
   * 单 agent 修复(P0b):点击 agent 卡片下的"修复此项"按钮。
   *
   * 后端 install_hooks_for_agent 接收 agent 枚举,内部仍调 `git-ai install`(idempotent)。
   * 多次点不同 agent 的按钮会被 hooks_lock 串行(同一时刻只能跑一个 hooks 任务)。
   * variables 字段保存正在跑的 agent kind,用于卡片上的 spinner 精确归属。
   */
  const repairAgentM = useMutation({
    mutationFn: (agent: AgentKind) => installHooksForAgent(genJobId(), agent),
    onSuccess: (_, agent) => {
      toast.success(t("diagnostic.repairAgent.successTemplate", { agent: AGENT_LABEL[agent] }));
      toast.message(t("common.mustRestartAgent"));
      qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
      qc.invalidateQueries({ queryKey: ["hooks_status"] });
      qc.invalidateQueries({ queryKey: ["claude_settings"] });
    },
    onError: (e, agent) =>
      toast.error(t("diagnostic.repairAgent.errorTemplate", { agent: AGENT_LABEL[agent] }), {
        description: (e as Error).message,
      }),
  });

  const fixM = officialFixM;
  const willDo = useMemo(
    () =>
      toFix.map((a) =>
        t("diagnostic.officialFix.willDoTemplate", {
          agent: AGENT_LABEL[a.agent],
          path: a.config_path ?? t("diagnostic.officialFix.defaultConfigPath"),
        }),
      ),
    [toFix, t],
  );

  // 健康总判定(健康优先重构):daemon 锁 / catalog 命中 / 检查清单 err|warn 任一存在即"需处理"。
  // 健康时整页收敛成一张结论卡 + 三个折叠抽屉;有问题时把问题顶到结论卡下方。
  const daemonProblem =
    daemonHealthQ.data?.kind === "stale_lock" ||
    daemonHealthQ.data?.kind === "blocked_lock_unknown_pid";
  const attentionCount = checklist.problems.length + catalogHits.length + (daemonProblem ? 1 : 0);
  const configuredAgents = data ? data.agents.filter((a) => a.configured).length : 0;
  const totalAgents = data ? data.agents.length : 0;

  // ===== empty state: git-ai not found =====
  if (data?.degraded?.kind === "git_ai_not_found") {
    return <GitAiNotFoundEmpty onGoInstall={() => navigate("install")} />;
  }

  return (
    <div className={cn("space-y-4", embedded ? "" : "p-6")}>
      {/* 顶部 */}
      <div className="flex items-center justify-between">
        <div className={embedded ? "text-xs text-muted-foreground" : undefined}>
          {!embedded && <h1 className="text-xl font-semibold">{t("diagnostic.pageTitle")}</h1>}
          <p className={cn(embedded ? "" : "mt-0.5", "text-xs text-muted-foreground")}>
            {t("diagnostic.basedOnRepoLabel")}
            <span className="font-mono">{data?.repo?.path ?? t("diagnostic.noRepoSelected")}</span>
            {data && (
              <>
                {" · "}
                {t("diagnostic.lastCheckedTemplate", {
                  time: new Date(data.generated_at_unix_ms).toLocaleTimeString(),
                  ms: data.took_ms,
                })}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip content={t("diagnostic.copyAll.tooltip")}>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(data?.report.raw ?? "");
                toast.success(t("diagnostic.copyAll.success"));
              }}
              disabled={!data?.report.raw}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50 dark:border-border dark:bg-card dark:hover:bg-muted"
            >
              <Copy className="h-3.5 w-3.5" /> {t("diagnostic.copyAll.label")}
            </button>
          </Tooltip>
          <button
            onClick={() => refreshM.mutate()}
            disabled={refreshM.isPending || q.isFetching}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {refreshM.isPending || q.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t("diagnostic.refresh.label")}
          </button>
        </div>
      </div>

      {/* 需要处理:有问题(daemon 锁 / catalog 命中 / 检查清单 err|warn)时顶一个带计数的小标题;
          健康时整块不显示(无标题、无横幅、无列表),页面回到平静。 */}
      {data && attentionCount > 0 && (
        <h2 className="flex items-center gap-2 text-sm font-semibold text-warning-foreground dark:text-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t("diagnostic.attention.headingTemplate", { n: attentionCount })}
        </h2>
      )}

      {/* 僵尸 daemon lock 横幅:lock 文件还在但 PID 已死,所有 hook 命令会被一直阻塞。
          独立横幅 + 复制清理命令,不卷进自动检查清单(后者是 git-ai 健康全景,不易凸显)。 */}
      {daemonHealthQ.data?.kind === "stale_lock" && (
        <DaemonStaleLockBanner
          health={daemonHealthQ.data}
          winOs={winOs}
          busy={daemonRepairM.isPending}
          onRepair={() =>
            setDaemonRepairTarget(
              daemonHealthQ.data as Extract<
                DaemonHealth,
                { kind: "stale_lock" | "blocked_lock_unknown_pid" }
              >,
            )
          }
        />
      )}
      {daemonHealthQ.data?.kind === "blocked_lock_unknown_pid" && (
        <DaemonBlockedLockBanner
          health={daemonHealthQ.data}
          winOs={winOs}
          busy={daemonRepairM.isPending}
          onRepair={() =>
            setDaemonRepairTarget(
              daemonHealthQ.data as Extract<
                DaemonHealth,
                { kind: "stale_lock" | "blocked_lock_unknown_pid" }
              >,
            )
          }
        />
      )}

      {/* 任务 #7:自动检测到的问题。空时不渲染,避免占用屏幕。 */}
      {catalogHits.length > 0 && (
        <QuickFixCatalogSection hits={catalogHits} onOpenEntry={setCatalogEntry} />
      )}

      {/* 需要处理:检查清单里 err/warn 的项顶到结论卡下方,每条带跳转修复;健康时整块消失。 */}
      {data && checklist.problems.length > 0 && (
        <ul className="space-y-2">
          {checklist.problems.map((it) => (
            <li
              key={it.id}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-3",
                it.level === "err"
                  ? "border-danger bg-danger-muted/50"
                  : "border-warning bg-warning-muted/50",
              )}
            >
              <StatusDot level={it.level} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{it.label}</div>
                {it.impact && (
                  <div className="mt-0.5 text-xs text-muted-foreground">{it.impact}</div>
                )}
              </div>
              {it.fix && (
                <button
                  onClick={() => navigate(it.fix!.to as never)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs hover:bg-muted dark:border-border dark:hover:bg-muted"
                >
                  {it.fix.label}
                  <ArrowRight className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {q.isLoading && <SkeletonBlocks />}

      {data && (
        <>
          {/* AI Agent Hooks:圆形状态徽标网格(简洁、可视化);有问题在对应 agent 正下方就地修复。
              6 个 agent 用 grid-cols-3 lg:grid-cols-6 自适应,窄屏 2 行、宽屏 1 行。 */}
          <section className="rounded-lg border border-border bg-card p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-baseline gap-2 text-sm font-medium">
                {t("diagnostic.agentHooks.title")}
                <span className="text-xs font-normal text-muted-foreground">
                  {t("diagnostic.agentHooks.configuredCountTemplate", {
                    configured: configuredAgents,
                    total: totalAgents,
                  })}
                </span>
              </h2>
              <button
                onClick={() => setFixOpen(true)}
                disabled={toFix.length === 0}
                title={
                  toFix.length === 0
                    ? t("diagnostic.agentHooks.fixMissingDisabledTitle")
                    : t("diagnostic.agentHooks.fixMissingTitleTemplate", { n: toFix.length })
                }
                className="inline-flex items-center gap-1 rounded-sm border border-primary px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:border-border disabled:text-muted-foreground disabled:hover:bg-transparent dark:border-primary/40 dark:hover:bg-primary/15"
              >
                <Wrench className="h-3 w-3" />
                {t("diagnostic.agentHooks.fixMissingTemplate", { n: toFix.length })}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-4 lg:grid-cols-6">
              {data.agents.map((a) => {
                const statusLabel = !a.detected
                  ? t("diagnostic.agentHooks.statusNotInstalled")
                  : a.configured
                    ? t("diagnostic.agentHooks.statusConfigured")
                    : t("diagnostic.agentHooks.statusMissing");
                const repairing = repairAgentM.isPending && repairAgentM.variables === a.agent;
                return (
                  <Tooltip
                    key={a.agent}
                    content={
                      <div className="space-y-1">
                        <div className="font-medium">{AGENT_LABEL[a.agent]}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {a.config_path ?? t("diagnostic.agentHooks.unknownPath")}
                        </div>
                        {a.issues.length > 0 && (
                          <ul className="list-disc pl-4 text-[11px] text-amber-300 dark:text-amber-700">
                            {a.issues.map((i) => (
                              <li key={i}>{i}</li>
                            ))}
                          </ul>
                        )}
                        {a.raw_excerpt && (
                          <div className="font-mono text-[11px]">{a.raw_excerpt}</div>
                        )}
                      </div>
                    }
                  >
                    <div className="flex cursor-default flex-col items-center gap-1.5 text-center">
                      <StatusDot level={agentLevel(a)} size="lg" />
                      <span className="text-xs font-medium text-foreground">
                        {AGENT_LABEL[a.agent]}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{statusLabel}</span>
                      {a.detected && !a.configured && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            repairAgentM.mutate(a.agent);
                          }}
                          disabled={repairing}
                          title={t("diagnostic.agentHooks.fixThisTitleTemplate", {
                            agent: AGENT_LABEL[a.agent],
                          })}
                          className="mt-0.5 inline-flex cursor-pointer items-center gap-0.5 rounded-sm border border-primary px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50 dark:border-primary/40 dark:text-primary dark:hover:bg-primary/15"
                        >
                          {repairing ? (
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          ) : (
                            <Wrench className="h-2.5 w-2.5" />
                          )}
                          {t("diagnostic.agentHooks.fixThis")}
                        </button>
                      )}
                    </div>
                  </Tooltip>
                );
              })}
            </div>
          </section>

          {/* 全部检查项抽屉:默认折叠的完整清单(问题已在上方"需要处理"突出);异常项置顶 + 状态 chip,detail/impact 收进 ⓘ。 */}
          <Collapsible
            title={t("diagnostic.checklist.title")}
            summary={t("diagnostic.checklist.allPassTemplate", {
              pass: checklist.passCount,
              total: checklist.total,
            })}
          >
            <ul className="divide-y divide-border">
              {checklist.sorted.map((it) => {
                const chipLabel =
                  it.level === "ok"
                    ? t("diagnostic.checklist.statusPass")
                    : it.level === "warn"
                      ? t("diagnostic.checklist.statusWarn")
                      : it.level === "err"
                        ? t("diagnostic.checklist.statusFail")
                        : t("diagnostic.checklist.statusNa");
                const chipCls =
                  it.level === "ok"
                    ? "bg-success-muted text-success"
                    : it.level === "warn"
                      ? "bg-warning-muted text-warning-foreground dark:text-warning"
                      : it.level === "err"
                        ? "bg-danger-muted text-danger"
                        : "bg-muted text-muted-foreground";
                return (
                  <li key={it.id} className="flex items-center gap-3 py-2">
                    <StatusDot level={it.level} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm">{it.label}</span>
                    {(it.impact || it.detail) && (
                      <Tooltip
                        content={
                          <div className="space-y-1">
                            {it.impact && (
                              <div className="text-[12px] leading-relaxed">{it.impact}</div>
                            )}
                            {it.detail && (
                              <div className="break-all font-mono text-[11px] text-muted-foreground">
                                {it.detail}
                              </div>
                            )}
                          </div>
                        }
                      >
                        <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground" />
                      </Tooltip>
                    )}
                    <span
                      className={cn(
                        "shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium",
                        chipCls,
                      )}
                    >
                      {chipLabel}
                    </span>
                    {it.fix && (
                      <button
                        onClick={() => navigate(it.fix!.to as never)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border px-2 py-0.5 text-xs hover:bg-muted dark:border-border dark:hover:bg-muted"
                      >
                        {it.fix.label}
                        <ArrowRight className="h-3 w-3" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Collapsible>

          {/* 隐私基线一行常驻;"重启 agent / 重开终端"已在修复动作后 toast 提示,不长期占屏。
              详细报告(git-ai debug 原文)已移除;顶部「复制全部」仍可一键复制原文供排障/反馈。 */}
          <p className="py-2 text-center text-[11px] text-muted-foreground">
            {t("common.noUploadNotice")}
          </p>
        </>
      )}

      {/* QuickFix:同页执行 install hooks,模式由用户在对话框内选择 */}
      <Dialog
        open={daemonRepairTarget !== null}
        onOpenChange={(v) => !daemonRepairM.isPending && !v && setDaemonRepairTarget(null)}
        title={t("diagnostic.daemonRepairDialog.title")}
        description={t("diagnostic.daemonRepairDialog.description")}
        dismissible={!daemonRepairM.isPending}
        footer={
          <>
            <button
              type="button"
              onClick={() => setDaemonRepairTarget(null)}
              disabled={daemonRepairM.isPending}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50 dark:border-border dark:hover:bg-muted"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => daemonRepairM.mutate()}
              disabled={daemonRepairM.isPending || !daemonRepairTarget}
              className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
            >
              {daemonRepairM.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("diagnostic.daemonRepairDialog.confirm")}
            </button>
          </>
        }
      >
        {daemonRepairTarget && <DaemonRepairConfirmBody health={daemonRepairTarget} />}
      </Dialog>

      <QuickFixDialog
        open={fixOpen}
        onOpenChange={setFixOpen}
        title={t("diagnostic.fixMissingDialog.title")}
        description={t("diagnostic.fixMissingDialog.description")}
        willDo={willDo}
        willSkip={toSkip}
        confirmLabel={t("diagnostic.fixMissingDialog.confirmLabel")}
        busy={fixM.isPending}
        onConfirm={() => fixM.mutate()}
      />

      {/* 任务 #7:catalog 命中条目详情 dialog */}
      <QuickFixDialog
        open={catalogEntry !== null}
        onOpenChange={(v) => !v && setCatalogEntry(null)}
        title={catalogEntry?.title ?? ""}
        description={catalogEntry?.problem}
        commands={catalogEntry?.commands}
        cta={
          catalogEntry?.cta
            ? {
                label: catalogEntry.cta.label,
                onClick: () => navigate(catalogEntry.cta!.route as RouteId),
              }
            : undefined
        }
      />
    </div>
  );
}

/**
 * 任务 #7 "自动检测到的问题" 区块。空命中时调用方不渲染本组件。
 *
 * 每行展示:严重度色块 + 标题 + problem 简介 + 右侧"查看修复"按钮。
 * 点行任意位置都打开 catalogEntry dialog,符合"卡片即按钮"的直觉。
 */
function QuickFixCatalogSection({
  hits,
  onOpenEntry,
}: {
  hits: QuickFixEntry[];
  onOpenEntry: (e: QuickFixEntry) => void;
}) {
  const { t } = useTranslation();
  const sevTone: Record<QuickFixEntry["severity"], string> = {
    err: "bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-950/30 dark:border-rose-900/40 dark:text-rose-300",
    warn: "bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/30 dark:border-amber-900/40 dark:text-amber-300",
    info: "bg-primary/10 border-primary text-primary dark:bg-primary/10 dark:border-primary/40 dark:text-primary",
  };
  // severity_label 映射：err/warn/info → quickFixCatalog.severityErr/Warn/Info
  const severityLabel: Record<QuickFixEntry["severity"], string> = {
    err: t("quickFixCatalog.severityErr"),
    warn: t("quickFixCatalog.severityWarn"),
    info: t("quickFixCatalog.severityInfo"),
  };
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        <h2 className="text-sm font-medium">{t("quickFixCatalog.sectionTitle")}</h2>
        <Badge tone="warn">{hits.length}</Badge>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t("quickFixCatalog.sectionHint")}</p>
      <ul className="space-y-2">
        {hits.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => onOpenEntry(e)}
              className="flex w-full items-start gap-3 rounded-md border border-border bg-card p-3 text-left hover:bg-accent/50"
            >
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium",
                  sevTone[e.severity],
                )}
              >
                {severityLabel[e.severity]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{e.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{e.problem}</div>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SkeletonBlocks() {
  return (
    <div className="space-y-3">
      <div className="h-24 animate-pulse rounded-lg bg-secondary" />
      <div className="h-40 animate-pulse rounded-lg bg-secondary" />
      <div className="h-64 animate-pulse rounded-lg bg-secondary" />
    </div>
  );
}

/**
 * 「git-ai daemon 僵尸 lock」横幅。仅在 [`DaemonHealth.kind`]==="stale_lock" 时挂载。
 *
 * 视觉等同 Hooks.tsx 的 conflict 横幅(rose 配色 + AlertTriangle),含两个文件路径与
 * 复制清理命令。不提供"一键删除"按钮 —— 涉及 home 目录文件的破坏性动作,且需要重启
 * client 命令拉起新 daemon,留给用户在终端执行更安全。
 */
function DaemonStaleLockBanner({
  health,
  winOs,
  busy,
  onRepair,
}: {
  health: Extract<DaemonHealth, { kind: "stale_lock" }>;
  winOs: boolean;
  busy: boolean;
  onRepair: () => void;
}) {
  const { t } = useTranslation();
  const cmd = winOs
    ? staleLockCmd.forWindows(health.lock_path, health.pid_meta_path)
    : staleLockCmd.forUnix(health.lock_path, health.pid_meta_path);
  return (
    <div className="rounded-lg border border-rose-300 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950/40">
      <div className="flex items-start gap-2 text-rose-700 dark:text-rose-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium">{t("daemon.staleLock.title")}</div>
          <p className="mt-1 text-rose-700/80 dark:text-rose-300/80">
            {t("daemon.staleLock.hint")}
          </p>
          {health.last_pid !== null && (
            <p className="mt-1 text-[11px] text-rose-700/70 dark:text-rose-300/70">
              {t("daemon.staleLock.lastPidTemplate", { pid: health.last_pid })}
            </p>
          )}
          <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-rose-800 dark:text-rose-200">
            <li>{health.lock_path}</li>
            <li>{health.pid_meta_path}</li>
          </ul>
          <p className="mt-2 text-[11px] text-rose-700/80 dark:text-rose-300/80">
            {t("daemon.staleLock.stepLabel")}
          </p>
          <div className="mt-2 flex items-center gap-2 rounded-sm bg-card/60 p-2 font-mono text-[11px] dark:bg-card/60">
            <code className="flex-1 break-all">{cmd}</code>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(cmd);
                toast.success(t("daemon.staleLock.copySuccess"));
              }}
              className="rounded-sm p-1 text-rose-600 hover:bg-rose-100 dark:text-rose-400 dark:hover:bg-rose-950/40"
              title={t("daemon.staleLock.copyCmdLabel")}
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
          <div className="mt-3">
            <button
              type="button"
              onClick={onRepair}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wrench className="h-3.5 w-3.5" />
              )}
              {t("daemon.repairNow")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DaemonBlockedLockBanner({
  health,
  winOs,
  busy,
  onRepair,
}: {
  health: Extract<DaemonHealth, { kind: "blocked_lock_unknown_pid" }>;
  winOs: boolean;
  busy: boolean;
  onRepair: () => void;
}) {
  const { t } = useTranslation();
  const cmd = winOs
    ? blockedLockCmd.forWindows(
        health.lock_path,
        health.pid_meta_path,
        health.last_pid ?? health.candidate_pids[0] ?? null,
      )
    : blockedLockCmd.forUnix(
        health.lock_path,
        health.pid_meta_path,
        health.last_pid ?? health.candidate_pids[0] ?? null,
      );
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
      <div className="flex items-start gap-2 text-amber-800 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium">{t("daemon.blockedLock.title")}</div>
          <p className="mt-1 text-amber-800/80 dark:text-amber-300/80">
            {t("daemon.blockedLock.hint")}
          </p>
          {health.last_pid !== null && (
            <p className="mt-1 text-[11px] text-amber-800/70 dark:text-amber-300/70">
              {t("daemon.blockedLock.lastPidUnavailableTemplate", { pid: health.last_pid })}
            </p>
          )}
          {health.candidate_pids.length > 0 && (
            <p className="mt-1 text-[11px] text-amber-800/70 dark:text-amber-300/70">
              {t("daemon.blockedLock.candidatePidsTemplate", {
                pids: health.candidate_pids.join(", "),
              })}
            </p>
          )}
          <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-amber-900 dark:text-amber-200">
            <li>{health.lock_path}</li>
            <li>{health.pid_meta_path}</li>
          </ul>
          <p className="mt-2 text-[11px] text-amber-800/80 dark:text-amber-300/80">
            {t("daemon.blockedLock.stepLabel")}
          </p>
          <div className="mt-2 flex items-center gap-2 rounded-sm bg-card/60 p-2 font-mono text-[11px] dark:bg-card/60">
            <code className="flex-1 break-all">{cmd}</code>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(cmd);
                toast.success(t("daemon.blockedLock.copySuccess"));
              }}
              className="rounded-sm p-1 text-amber-700 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-950/40"
              title={t("daemon.blockedLock.copyCmdLabel")}
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
          <div className="mt-3">
            <button
              type="button"
              onClick={onRepair}
              disabled={busy || (health.last_pid === null && health.candidate_pids.length === 0)}
              title={
                health.last_pid === null && health.candidate_pids.length === 0
                  ? t("daemon.blockedLock.noPidTitle")
                  : t("daemon.blockedLock.confirmTitle")
              }
              className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wrench className="h-3.5 w-3.5" />
              )}
              {t("daemon.repairNow")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DaemonRepairConfirmBody({
  health,
}: {
  health: Extract<DaemonHealth, { kind: "stale_lock" | "blocked_lock_unknown_pid" }>;
}) {
  const { t } = useTranslation();
  const pids =
    health.kind === "blocked_lock_unknown_pid"
      ? Array.from(
          new Set([
            ...(health.last_pid !== null ? [health.last_pid] : []),
            ...health.candidate_pids,
          ]),
        )
      : [];
  return (
    <div className="space-y-3">
      {pids.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-rose-600 dark:text-rose-400">
            {t("diagnostic.daemonRepairConfirm.willKill")}
          </div>
          <ul className="space-y-0.5 font-mono text-xs">
            {pids.map((pid) => (
              <li key={pid}>git-ai.exe PID {pid}</li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground dark:text-neutral-300">
          {t("diagnostic.daemonRepairConfirm.willDelete")}
        </div>
        <ul className="space-y-0.5 break-all font-mono text-xs">
          <li>{health.lock_path}</li>
          <li>{health.pid_meta_path}</li>
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">{t("diagnostic.daemonRepairConfirm.note")}</p>
    </div>
  );
}

function GitAiNotFoundEmpty({ onGoInstall }: { onGoInstall: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="max-w-md rounded-lg border border-border bg-card p-8 text-center shadow-xs dark:border-border dark:bg-card">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-950/40">
          <Activity className="h-7 w-7" />
        </div>
        <div className="mt-4 text-lg font-semibold">{t("diagnostic.gitAiNotFound.title")}</div>
        <p className="mt-2 text-sm text-muted-foreground">{t("diagnostic.gitAiNotFound.body")}</p>
        <button
          onClick={onGoInstall}
          className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t("diagnostic.gitAiNotFound.goInstall")} <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <p className="mt-3 text-[11px] text-muted-foreground">{t("common.noUploadNotice")}</p>
      </div>
    </div>
  );
}
