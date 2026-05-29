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
import { buildCheckList, buildOverviewChips } from "../lib/diagnosticChecks";

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

function formatDaemonRepairResult(result: DaemonRepairResult): string {
  return [
    formatDaemonHealthForAlert(result.before),
    `结束 PID: ${result.killed_pids.length > 0 ? result.killed_pids.join(", ") : "无"}`,
    `删除文件: ${result.removed_paths.length > 0 ? result.removed_paths.join(", ") : "无"}`,
    `处理后状态: ${result.after.kind}`,
  ].join("\n");
}

function formatDaemonHealthForAlert(health: DaemonHealth | null): string {
  if (!health) return "处理前状态: unknown";
  if (health.kind === "idle") return "处理前状态: idle";
  if (health.kind === "running") return `处理前状态: running\nPID: ${health.pid}`;
  const lines = [
    `处理前状态: ${health.kind}`,
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
function partitionAgentsForFix(agents: AgentHookStatus[]): {
  toFix: AgentHookStatus[];
  toSkip: QuickFixSkipEntry[];
} {
  const toFix: AgentHookStatus[] = [];
  const toSkip: QuickFixSkipEntry[] = [];
  for (const a of agents) {
    const label = AGENT_LABEL[a.agent];
    if (!a.detected) {
      toSkip.push({ item: label, reason: "未安装,跳过" });
    } else if (a.configured) {
      toSkip.push({ item: label, reason: "已配置,无需修改" });
    } else {
      toFix.push(a);
    }
  }
  return { toFix, toSkip };
}

/** embedded=true 时收进 Setup 容器的 tab,Setup 已提供页级标题,这里隐藏自带大标题避免重复。 */
export default function DiagnosticPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
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
      toast.success("已重新检测");
    },
    onError: (e) => toast.error("重新检测失败", { description: (e as Error).message }),
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
        toast.info("daemon 已自动恢复正常,无需手动处理", {
          description:
            result.before.kind === "running"
              ? `当前 PID ${result.before.pid} 正在运行,告警可能是 daemon 重启窗口期的瞬态状态。`
              : "lock 已被清理,daemon 处于空闲态。",
        });
        return;
      }
      toast.success("git-ai daemon lock 已处理", {
        description: `结束 ${result.killed_pids.length} 个进程 / 清理 ${result.removed_paths.length} 个文件`,
      });
      if (shouldPushDaemonRepairResult(settingsQ.data)) {
        void notify("git-ai daemon 处理成功", formatDaemonRepairResult(result));
      }
    },
    onError: (e) => {
      const message = (e as Error).message;
      toast.error("git-ai daemon 处理失败", { description: message });
      if (shouldPushDaemonRepairResult(settingsQ.data)) {
        void notify(
          "git-ai daemon 处理失败",
          `${formatDaemonHealthForAlert(daemonRepairTarget)}\n错误: ${message}`,
        );
      }
    },
  });

  const data: DiagnosticOverview | undefined = q.data;
  const items = useMemo(() => (data ? buildCheckList(data) : []), [data]);
  const chips = useMemo(() => buildOverviewChips(items), [items]);

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
    () => (data ? partitionAgentsForFix(data.agents) : { toFix: [], toSkip: [] }),
    [data],
  );

  const officialFixM = useMutation({
    mutationFn: () => installHooksOfficial(genJobId()),
    onSuccess: () => {
      setFixOpen(false);
      toast.success(`已为 ${toFix.length} 个 agent 写入官方 hooks`);
      toast.message(t("common.mustRestartAgent"));
      toast.message(t("common.mustReopenTerminal"));
      qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
      qc.invalidateQueries({ queryKey: ["hooks_status"] });
      qc.invalidateQueries({ queryKey: ["claude_settings"] });
    },
    onError: (e) => toast.error("修复 hooks 失败", { description: (e as Error).message }),
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
      toast.success(`已为 ${AGENT_LABEL[agent]} 触发 hook 修复`);
      toast.message(t("common.mustRestartAgent"));
      qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
      qc.invalidateQueries({ queryKey: ["hooks_status"] });
      qc.invalidateQueries({ queryKey: ["claude_settings"] });
    },
    onError: (e, agent) =>
      toast.error(`修复 ${AGENT_LABEL[agent]} 失败`, { description: (e as Error).message }),
  });

  const fixM = officialFixM;
  const willDo = useMemo(
    () =>
      toFix.map(
        (a) => `${AGENT_LABEL[a.agent]}:写入官方 hooks 到 ${a.config_path ?? "默认配置路径"}`,
      ),
    [toFix],
  );

  // ===== empty state: git-ai not found =====
  if (data?.degraded?.kind === "git_ai_not_found") {
    return <GitAiNotFoundEmpty onGoInstall={() => navigate("install")} />;
  }

  return (
    <div className={cn("space-y-4", embedded ? "" : "p-6")}>
      {/* 顶部 */}
      <div className="flex items-center justify-between">
        <div className={embedded ? "text-xs text-muted-foreground" : undefined}>
          {!embedded && <h1 className="text-xl font-semibold">环境诊断</h1>}
          <p className={cn(embedded ? "" : "mt-0.5", "text-xs text-muted-foreground")}>
            基于仓库:
            <span className="font-mono">{data?.repo?.path ?? "未选仓库(检查仅含全局项)"}</span>
            {data && (
              <>
                {" · "}上次检测 {new Date(data.generated_at_unix_ms).toLocaleTimeString()} · 耗时{" "}
                {data.took_ms}ms
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip content="把整份 git-ai debug report 原文复制到剪贴板,方便发给同事">
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(data?.report.raw ?? "");
                toast.success("已复制 debug report 原文");
              }}
              disabled={!data?.report.raw}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50 dark:border-border dark:bg-card dark:hover:bg-muted"
            >
              <Copy className="h-3.5 w-3.5" /> 复制全部
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
            重新检测
          </button>
        </div>
      </div>

      {/* 总览条 */}
      <div className="grid grid-cols-5 gap-3 rounded-lg border border-border bg-card p-3">
        {chips.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded-md px-2 py-1">
            <StatusDot level={(c.item?.level ?? "muted") as StatusLevel} size="sm" />
            <span className="truncate text-xs">{c.label}</span>
          </div>
        ))}
      </div>

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

      {q.isLoading && <SkeletonBlocks />}

      {data && (
        <>
          {/* Agent 矩阵 */}
          <section className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">AI Agent Hooks(4 项)</h2>
              <button
                onClick={() => setFixOpen(true)}
                disabled={toFix.length === 0}
                title={
                  toFix.length === 0
                    ? "当前没有需要修复的 agent"
                    : `将为 ${toFix.length} 个 agent 写入官方 hooks`
                }
                className="inline-flex items-center gap-1 rounded-sm border border-primary px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:border-border disabled:text-muted-foreground disabled:hover:bg-transparent dark:border-primary/40 dark:hover:bg-primary/15"
              >
                <Wrench className="h-3 w-3" />
                修复缺失({toFix.length})
              </button>
            </div>
            <div className="grid grid-cols-4 gap-3">
              {data.agents.map((a) => (
                <Tooltip
                  key={a.agent}
                  content={
                    <div className="space-y-1">
                      <div className="font-medium">{AGENT_LABEL[a.agent]}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {a.config_path ?? "(未知路径)"}
                      </div>
                      {a.issues.length > 0 && (
                        <ul className="list-disc pl-4 text-[11px] text-amber-300 dark:text-amber-700">
                          {a.issues.map((i) => (
                            <li key={i}>{i}</li>
                          ))}
                        </ul>
                      )}
                      {a.raw_excerpt && (
                        <div className="text-[11px] font-mono">{a.raw_excerpt}</div>
                      )}
                    </div>
                  }
                >
                  <div className="flex cursor-default flex-col items-center gap-1.5">
                    <StatusDot level={agentLevel(a)} size="lg" />
                    <span className="text-[11px] text-foreground/80">{AGENT_LABEL[a.agent]}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {!a.detected ? "未安装" : a.configured ? "已配置" : "缺失"}
                    </span>
                    {a.detected && !a.configured && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          repairAgentM.mutate(a.agent);
                        }}
                        disabled={repairAgentM.isPending && repairAgentM.variables === a.agent}
                        title={`仅为 ${AGENT_LABEL[a.agent]} 触发 hook 修复`}
                        className="mt-0.5 inline-flex cursor-pointer items-center gap-0.5 rounded-sm border border-primary px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50 dark:border-primary/40 dark:text-primary dark:hover:bg-primary/15"
                      >
                        {repairAgentM.isPending && repairAgentM.variables === a.agent ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        ) : (
                          <Wrench className="h-2.5 w-2.5" />
                        )}
                        修复此项
                      </button>
                    )}
                  </div>
                </Tooltip>
              ))}
            </div>
          </section>

          {/* 自动检查清单 */}
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
              自动检查清单
              <Badge tone="info">{items.length}</Badge>
            </h2>
            <ul className="divide-y divide-border">
              {items.map((it) => (
                <li key={it.id} className="flex items-start gap-3 py-2.5">
                  <StatusDot level={it.level} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{it.label}</span>
                      {it.impact && (
                        <Tooltip
                          content={<div className="text-[12px] leading-relaxed">{it.impact}</div>}
                        >
                          <Info className="h-3.5 w-3.5 cursor-help text-muted-foreground" />
                        </Tooltip>
                      )}
                    </div>
                    {it.detail && (
                      <div
                        className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                        title={it.detail}
                      >
                        {it.detail}
                      </div>
                    )}
                  </div>
                  {it.fix && (
                    <button
                      onClick={() => navigate(it.fix!.to as never)}
                      className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-0.5 text-xs hover:bg-muted dark:border-border dark:hover:bg-muted"
                    >
                      {it.fix.label}
                      <ArrowRight className="h-3 w-3" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* 6 段详细报告 */}
          <section>
            <h2 className="mb-2 mt-1 text-sm font-medium">详细报告</h2>
            <div className="space-y-2">
              {data.report.sections.length === 0 && (
                <div className="rounded-sm border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                  没有解析到任何段(可能 git-ai 未装或 debug report 为空)
                </div>
              )}
              {data.report.sections.map((s) => (
                <Collapsible
                  key={s.name}
                  title={s.name}
                  summary={`${s.entries.length} 项`}
                  rightExtra={
                    <button
                      onClick={async () => {
                        await navigator.clipboard.writeText(s.raw.trim());
                        toast.success(`已复制 ${s.name} 段原文`);
                      }}
                      className="inline-flex items-center gap-1 rounded-sm p-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  }
                >
                  <table className="w-full text-xs">
                    <tbody>
                      {s.entries.map(([k, v]) => (
                        <tr key={k} className="align-top">
                          <td className="w-1/3 py-1 pr-3 font-medium text-foreground/80">{k}</td>
                          <td className="break-all py-1 font-mono text-muted-foreground">{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Collapsible>
              ))}
            </div>
          </section>

          {/* 底部隐私 + 操作提示(每次安装/改 hooks 后这两句必出现) */}
          <p className="pt-2 text-center text-[11px] text-muted-foreground">
            {t("common.noUploadNotice")}
          </p>
          <p className="text-center text-[11px] text-amber-600 dark:text-amber-400">
            {t("common.mustRestartAgent")}
          </p>
          <p className="pb-4 text-center text-[11px] text-amber-600 dark:text-amber-400">
            {t("common.mustReopenTerminal")}
          </p>
        </>
      )}

      {/* QuickFix:同页执行 install hooks,模式由用户在对话框内选择 */}
      <Dialog
        open={daemonRepairTarget !== null}
        onOpenChange={(v) => !daemonRepairM.isPending && !v && setDaemonRepairTarget(null)}
        title="确认处理 git-ai daemon lock"
        description="该操作会处理 git-ai daemon 的运行态 lock/pid 文件;如果 lock 仍被进程占用,会先结束确认框中列出的 git-ai 进程。"
        dismissible={!daemonRepairM.isPending}
        footer={
          <>
            <button
              type="button"
              onClick={() => setDaemonRepairTarget(null)}
              disabled={daemonRepairM.isPending}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50 dark:border-border dark:hover:bg-muted"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => daemonRepairM.mutate()}
              disabled={daemonRepairM.isPending || !daemonRepairTarget}
              className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
            >
              {daemonRepairM.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              确认处理
            </button>
          </>
        }
      >
        {daemonRepairTarget && <DaemonRepairConfirmBody health={daemonRepairTarget} />}
      </Dialog>

      <QuickFixDialog
        open={fixOpen}
        onOpenChange={setFixOpen}
        title="修复缺失 hooks"
        description="对所有已安装但未配置的 AI agent 一次性写入官方 git-ai hooks。"
        willDo={willDo}
        willSkip={toSkip}
        confirmLabel="开始修复"
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
              上次 daemon PID {health.last_pid}(已不存活)
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
                toast.success("清理命令已复制");
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
              立即处理
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
              daemon.pid.json 记录的 PID {health.last_pid} 当前不可用,但 lock 仍被占用
            </p>
          )}
          {health.candidate_pids.length > 0 && (
            <p className="mt-1 text-[11px] text-amber-800/70 dark:text-amber-300/70">
              当前发现 git-ai.exe PID {health.candidate_pids.join(", ")}
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
                toast.success("排查命令已复制");
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
                  ? "未发现明确 git-ai.exe PID,请先手动结束持锁进程"
                  : "确认后结束 git-ai.exe 并清理 lock/pid 文件"
              }
              className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wrench className="h-3.5 w-3.5" />
              )}
              立即处理
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
            将结束进程
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
          将删除文件
        </div>
        <ul className="space-y-0.5 break-all font-mono text-xs">
          <li>{health.lock_path}</li>
          <li>{health.pid_meta_path}</li>
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">
        完成后下次 git-ai client 命令会自动拉起新的 daemon。
      </p>
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
        <div className="mt-4 text-lg font-semibold">未检测到 git-ai</div>
        <p className="mt-2 text-sm text-muted-foreground">
          检查过 <code className="font-mono">GIT_AI_PATH</code> 环境变量、
          <code className="font-mono">~/.git-ai/bin</code> 与系统 PATH,都没有找到。
        </p>
        <button
          onClick={onGoInstall}
          className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          前往安装 <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <p className="mt-3 text-[11px] text-muted-foreground">{t("common.noUploadNotice")}</p>
      </div>
    </div>
  );
}
