import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AlertTriangle, Copy, Download, Loader2, Package, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  detectAgentCli,
  detectNpm,
  installAgentCli,
  refreshPathEnv,
  uninstallAgentCli,
} from "../lib/api";
import { cn } from "../lib/cn";
import type { AgentCli, InstallLogEvent } from "../lib/types";
import { Badge } from "./Badge";
import { Dialog } from "./ui/DialogShell";

type LogLine = { stream: "stdout" | "stderr" | "exit"; line: string; ts: number };

const AGENT_META: Record<AgentCli, { label: string; pkg: string; bin: string }> = {
  ClaudeCode: { label: "Claude Code", pkg: "@anthropic-ai/claude-code", bin: "claude" },
  Codex: { label: "Codex", pkg: "@openai/codex", bin: "codex" },
};
const AGENTS: AgentCli[] = ["ClaudeCode", "Codex"];

function genJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Claude Code / Codex 的 npm 装卸面板。嵌在 Diagnostic 页 agent hook 网格下方。
 * 复用 git-ai 安装的 `install://<job>/log` 流式协议 + 后端 install_lock(同一刻只跑一个)。
 */
export function AgentCliInstaller() {
  const qc = useQueryClient();
  const { t } = useTranslation();

  const npmQ = useQuery({ queryKey: ["npm_status"], queryFn: detectNpm, staleTime: 30_000 });
  const npmAvailable = !!npmQ.data?.available;

  // "重新检测":强制重读登录环境真实 PATH(覆盖"App 启动后才装 Node"),一次刷新即重探
  // npm + 两个 agent。自动探测信任启动时已 patch 的 PATH,不在此付费跑登录 shell。
  // refresh + 后续重探全 await 进 mutationFn,故 rechecking=isPending 精确反映本次操作、
  // 不被窗口聚焦等后台 refetch 误触发;refresh 失败(shell 超时)则弹红 toast 响亮上报。
  const recheckM = useMutation({
    mutationFn: async () => {
      await refreshPathEnv();
      await npmQ.refetch();
      await qc.invalidateQueries({ queryKey: ["agent_cli"] });
    },
    onError: (e) =>
      toast.error(t("diagnostic.agentCli.recheckFailed"), {
        description: (e as Error).message,
        duration: 6_000,
      }),
  });
  const rechecking = recheckM.isPending;

  const [logs, setLogs] = useState<LogLine[]>([]);
  const [exitOk, setExitOk] = useState<boolean | null>(null);
  const [runningAgent, setRunningAgent] = useState<AgentCli | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<AgentCli | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs.length]);
  useEffect(
    () => () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    },
    [],
  );

  // 启动 install / uninstall 前同步挂 listener,避免早期日志丢失(同 Install 页)。
  const startJob = useCallback(async (run: (jobId: string) => Promise<unknown>) => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    const id = genJobId();
    setLogs([]);
    setExitOk(null);
    const un = await listen<InstallLogEvent>(`install://${id}/log`, (e) => {
      setLogs((prev) => [
        ...prev,
        { stream: e.payload.stream, line: e.payload.line ?? "", ts: e.payload.ts },
      ]);
      if (e.payload.stream === "exit") setExitOk((e.payload.code ?? 0) === 0);
    });
    unlistenRef.current = un;
    return run(id);
  }, []);

  const installM = useMutation({
    mutationFn: ({ agent, version }: { agent: AgentCli; version?: string }) => {
      setRunningAgent(agent);
      return startJob((id) => installAgentCli(id, agent, version)) as Promise<number>;
    },
    onSuccess: (_d, { agent }) => {
      qc.invalidateQueries({ queryKey: ["agent_cli", agent] });
      qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
      toast.success(t("diagnostic.agentCli.installedToast", { name: AGENT_META[agent].label }));
    },
    onError: (e) =>
      toast.error(t("diagnostic.agentCli.installFailed"), {
        description: (e as Error).message,
        duration: 6_000,
      }),
    onSettled: () => setRunningAgent(null),
  });

  const uninstallM = useMutation({
    mutationFn: (agent: AgentCli) => {
      setRunningAgent(agent);
      return startJob((id) => uninstallAgentCli(id, agent, "uninstall")) as Promise<void>;
    },
    onSuccess: (_d, agent) => {
      qc.invalidateQueries({ queryKey: ["agent_cli", agent] });
      qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
      setUninstallTarget(null);
      toast.success(t("diagnostic.agentCli.uninstalledToast", { name: AGENT_META[agent].label }));
    },
    onError: (e) =>
      toast.error(t("diagnostic.agentCli.uninstallFailed"), {
        description: (e as Error).message,
        duration: 6_000,
      }),
    onSettled: () => setRunningAgent(null),
  });

  const busy = installM.isPending || uninstallM.isPending;

  const copyLogs = useCallback(async () => {
    await navigator.clipboard.writeText(logs.map((l) => `[${l.stream}] ${l.line}`).join("\n"));
    toast.success(t("diagnostic.agentCli.logsCopied"));
  }, [logs, t]);

  return (
    <section className="mt-6 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t("diagnostic.agentCli.title")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("diagnostic.agentCli.subtitle")}
          </p>
        </div>
        {npmAvailable && npmQ.data?.version && <Badge tone="info">npm {npmQ.data.version}</Badge>}
      </div>

      {/* npm 前置门禁:未装 Node 时禁用全部操作并诚实提示(degraded,非红错) */}
      {!npmQ.isLoading && !npmAvailable && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">{t("diagnostic.agentCli.npmMissing")}</div>
            <p className="mt-0.5 text-amber-700/80 dark:text-amber-300/80">
              {t("diagnostic.agentCli.npmMissingHint")} https://nodejs.org
            </p>
            <button
              type="button"
              onClick={() => recheckM.mutate()}
              disabled={rechecking}
              className="mt-1 inline-flex items-center gap-1 underline underline-offset-2 hover:text-amber-900 disabled:opacity-50 dark:hover:text-amber-200"
            >
              <RefreshCw className={cn("h-3 w-3", rechecking && "animate-spin")} />
              {t("diagnostic.agentCli.recheckNpm")}
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {AGENTS.map((agent) => (
          <AgentRow
            key={agent}
            agent={agent}
            npmAvailable={npmAvailable}
            busy={busy}
            running={runningAgent === agent}
            onInstall={(version) => installM.mutate({ agent, version })}
            onUninstallRequest={() => setUninstallTarget(agent)}
          />
        ))}
      </div>

      {/* 实时 npm 日志(两个 agent 共用一块:同一刻只跑一个) */}
      {(logs.length > 0 || busy) && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-xs font-medium">
              {t("diagnostic.agentCli.logTitle")}
              {busy && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
              {!busy && exitOk === true && <Badge tone="success">exit 0</Badge>}
              {!busy && exitOk === false && (
                <Badge tone="danger">{t("diagnostic.agentCli.failed")}</Badge>
              )}
            </h3>
            <button
              onClick={copyLogs}
              disabled={logs.length === 0}
              className="inline-flex items-center gap-1 rounded-sm p-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50 dark:hover:bg-muted"
            >
              <Copy className="h-3 w-3" /> {t("diagnostic.agentCli.copy")}
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto rounded-sm bg-neutral-900 p-3 font-mono text-[11px] leading-relaxed">
            {logs.map((l, i) => (
              <div
                key={i}
                className={cn(
                  l.stream === "stderr"
                    ? "text-rose-400"
                    : l.stream === "exit"
                      ? exitOk
                        ? "text-emerald-400"
                        : "text-rose-300"
                      : "text-neutral-200",
                )}
              >
                {l.line}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {/* 卸载确认 */}
      <Dialog
        open={uninstallTarget !== null}
        onOpenChange={(v) => {
          if (!v) setUninstallTarget(null);
        }}
        title={
          uninstallTarget
            ? t("diagnostic.agentCli.uninstallTitle", { name: AGENT_META[uninstallTarget].label })
            : ""
        }
        size="md"
        footer={
          <>
            <button
              onClick={() => setUninstallTarget(null)}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted dark:border-border dark:hover:bg-muted"
            >
              {t("diagnostic.agentCli.cancel")}
            </button>
            <button
              onClick={() => uninstallTarget && uninstallM.mutate(uninstallTarget)}
              disabled={uninstallM.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
            >
              {uninstallM.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("diagnostic.agentCli.uninstall")}
            </button>
          </>
        }
      >
        {uninstallTarget && (
          <div className="space-y-2 text-sm">
            <p className="font-mono text-xs text-muted-foreground">
              npm uninstall -g {AGENT_META[uninstallTarget].pkg}
            </p>
            <p className="text-muted-foreground">
              {t("diagnostic.agentCli.uninstallKeepConfig", {
                name: AGENT_META[uninstallTarget].label,
              })}
            </p>
          </div>
        )}
      </Dialog>
    </section>
  );
}

function AgentRow({
  agent,
  npmAvailable,
  busy,
  running,
  onInstall,
  onUninstallRequest,
}: {
  agent: AgentCli;
  npmAvailable: boolean;
  busy: boolean;
  running: boolean;
  onInstall: (version?: string) => void;
  onUninstallRequest: () => void;
}) {
  const { t } = useTranslation();
  const meta = AGENT_META[agent];
  const detectQ = useQuery({
    queryKey: ["agent_cli", agent],
    queryFn: () => detectAgentCli(agent),
    staleTime: 10_000,
  });
  const [version, setVersion] = useState("");
  const [showCmd, setShowCmd] = useState(false);

  const installed = detectQ.data;
  const isInstalled = !!installed?.installed;
  const disabled = !npmAvailable || busy;

  // 实时反映"点安装会真的执行什么":与后端 build_install_args 的拼法完全一致。
  const pinned = version.trim();
  const installCmd = `npm install -g ${pinned && pinned !== "latest" ? `${meta.pkg}@${pinned}` : meta.pkg}`;
  const uninstallCmd = `npm uninstall -g ${meta.pkg}`;
  const detectCmd = `${meta.bin} --version`;

  return (
    <div className="rounded-md border border-border bg-background p-3 dark:bg-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{meta.label}</span>
          <button
            type="button"
            onClick={() => setShowCmd((v) => !v)}
            title={t("diagnostic.agentCli.viewCommand")}
            aria-expanded={showCmd}
            className={cn(
              "inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] font-bold leading-none",
              showCmd
                ? "border-primary text-primary"
                : "border-border text-muted-foreground hover:border-primary hover:text-primary",
            )}
          >
            !
          </button>
        </div>
        {detectQ.isLoading ? (
          <span className="text-[11px] text-muted-foreground">
            {t("diagnostic.agentCli.checking")}
          </span>
        ) : isInstalled ? (
          <Badge tone="success">
            {installed?.version ?? t("diagnostic.agentCli.installedUnknown")}
          </Badge>
        ) : (
          <Badge tone="danger">{t("diagnostic.agentCli.notInstalled")}</Badge>
        )}
      </div>

      <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={meta.pkg}>
        {meta.pkg}
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <input
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          disabled={disabled}
          placeholder={t("diagnostic.agentCli.versionPlaceholder")}
          className="min-w-0 flex-1 rounded-sm border border-border bg-card px-2 py-1 text-xs disabled:opacity-50 dark:border-border dark:bg-background"
        />
        <button
          onClick={() => onInstall(version.trim() || undefined)}
          disabled={disabled}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
          {isInstalled
            ? t("diagnostic.agentCli.installOrUpdate")
            : t("diagnostic.agentCli.install")}
        </button>
        {isInstalled && (
          <button
            onClick={onUninstallRequest}
            disabled={disabled}
            title={t("diagnostic.agentCli.uninstall")}
            className="inline-flex shrink-0 items-center rounded-md border border-rose-200 p-1.5 text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/40"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* "!" 展开:把真正会执行的命令亮给用户,逐条说明用途(安装命令随版本输入框实时变化) */}
      {showCmd && (
        <div className="mt-2 space-y-1.5 rounded-sm border border-border bg-muted/40 p-2 text-[11px] dark:bg-background">
          <CmdLine cmd={installCmd} desc={t("diagnostic.agentCli.cmdInstallDesc")} />
          {isInstalled && (
            <CmdLine cmd={uninstallCmd} desc={t("diagnostic.agentCli.cmdUninstallDesc")} />
          )}
          <CmdLine cmd={detectCmd} desc={t("diagnostic.agentCli.cmdDetectDesc")} />
        </div>
      )}
    </div>
  );
}

function CmdLine({ cmd, desc }: { cmd: string; desc: string }) {
  return (
    <div>
      <code className="block break-all font-mono text-foreground">$ {cmd}</code>
      <span className="text-muted-foreground">{desc}</span>
    </div>
  );
}
