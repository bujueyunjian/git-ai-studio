import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  CheckCircle2,
  FileJson,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "../components/Badge";
import { Dialog } from "../components/ui/DialogShell";
import { RadioGroup, RadioItem } from "../components/ui/RadioGroupBar";
import { StatusDot } from "../components/StatusDot";
import {
  claudeSettingsMerge,
  diagnoseEnvironment,
  getHooksStatus,
  installHooksOfficial,
  listSettingsBackups,
  readClaudeSettings,
  restoreClaudeSettings,
} from "../lib/api";
import { cn } from "../lib/cn";
import {
  HOOKS_MODE_DESCRIPTIONS,
  HOOKS_SWITCH_SIDE_EFFECTS_TO_NONE,
  HOOKS_SWITCH_SIDE_EFFECTS_TO_OFFICIAL,
  MSG,
} from "../lib/copy";
import type { HooksMode, InstallLogEvent, SettingsBackup } from "../lib/types";

type LogLine = { stream: "stdout" | "stderr" | "exit"; line: string; ts: number };

function genJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** embedded=true 时收进 Setup 容器的 tab,隐藏自带大标题(Setup 已提供页级标题)。 */
export default function HooksPage({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const [pendingMode, setPendingMode] = useState<HooksMode | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const [showTerminalDialog, setShowTerminalDialog] = useState(false);
  const [showFailDialog, setShowFailDialog] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffContent, setDiffContent] = useState<string>("");
  const [restoreTarget, setRestoreTarget] = useState<SettingsBackup | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const statusQ = useQuery({
    queryKey: ["hooks_status"],
    queryFn: getHooksStatus,
    refetchInterval: 5_000,
  });
  const settingsQ = useQuery({
    queryKey: ["claude_settings"],
    queryFn: readClaudeSettings,
    staleTime: 5_000,
  });
  const backupsQ = useQuery({
    queryKey: ["settings_backups"],
    queryFn: listSettingsBackups,
    staleTime: 30_000,
  });
  const diagQ = useQuery({
    queryKey: ["diagnose_environment"],
    queryFn: () => diagnoseEnvironment(false),
    staleTime: 30_000,
  });

  const status = statusQ.data;
  const settings = settingsQ.data;
  const agentList = diagQ.data?.agents ?? [];

  // 完成后清理 unlisten
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const startJob = useCallback(async <T,>(topicNs: string, run: (jobId: string) => Promise<T>) => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    const id = genJobId();
    let sawExit = false;
    setLogs([]);
    const un = await listen<InstallLogEvent>(`${topicNs}://${id}/log`, (e) => {
      setLogs((prev) => [
        ...prev,
        { stream: e.payload.stream, line: e.payload.line ?? "", ts: e.payload.ts },
      ]);
      if (e.payload.stream === "exit") {
        sawExit = true;
        const ok = (e.payload.code ?? 0) === 0;
        if (ok) setShowRestartDialog(true);
        else setShowFailDialog(true);
      }
    });
    unlistenRef.current = un;
    try {
      return await run(id);
    } catch (e) {
      if (!sawExit) {
        setLogs((prev) => [
          ...prev,
          { stream: "stderr", line: (e as Error).message, ts: Date.now() },
          { stream: "exit", line: "exit 1", ts: Date.now() },
        ]);
        setShowFailDialog(true);
      }
      throw e;
    }
  }, []);

  const installOfficialM = useMutation({
    mutationFn: () => startJob("hooks", (id) => installHooksOfficial(id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hooks_status"] });
      qc.invalidateQueries({ queryKey: ["claude_settings"] });
      qc.invalidateQueries({ queryKey: ["settings_backups"] });
      qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
    },
    onError: (e) => toast.error("git-ai install 失败", { description: (e as Error).message }),
  });

  const switchModeM = useMutation({
    mutationFn: async (mode: HooksMode) => {
      if (mode === "official") {
        return startJob("hooks", (id) => installHooksOfficial(id)).then(() => undefined);
      }
      await startJob("hooks", (id) => claudeSettingsMerge(id, "none"));
      return undefined;
    },
    onSuccess: () => {
      setPendingMode(null);
      setConfirmText("");
      setShowRestartDialog(true);
      qc.invalidateQueries({ queryKey: ["hooks_status"] });
      qc.invalidateQueries({ queryKey: ["claude_settings"] });
      qc.invalidateQueries({ queryKey: ["settings_backups"] });
      qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
    },
    onError: (e) => {
      setShowFailDialog(true);
      toast.error("模式切换失败", { description: (e as Error).message });
    },
  });

  const restoreM = useMutation({
    mutationFn: (path: string) => startJob("hooks", (id) => restoreClaudeSettings(id, path)),
    onSuccess: () => {
      setRestoreTarget(null);
      toast.success("已还原 settings.json");
      qc.invalidateQueries({ queryKey: ["hooks_status"] });
      qc.invalidateQueries({ queryKey: ["claude_settings"] });
      qc.invalidateQueries({ queryKey: ["settings_backups"] });
      // 还原会改写 hook 配置,AgentCard 注册状态(diagnose_environment)也要刷新。
      qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
    },
    onError: (e) => toast.error("还原失败", { description: (e as Error).message }),
  });

  const busy = installOfficialM.isPending || switchModeM.isPending || restoreM.isPending;

  const expectedConfirm = pendingMode === "none" ? "disable" : "switch";

  function openSwitchDialog(target: HooksMode) {
    if (target === status?.mode) return;
    setPendingMode(target);
    setConfirmText("");
  }

  return (
    <div className={cn("space-y-4", embedded ? "" : "p-6")}>
      {!embedded && (
        <div>
          <h1 className="text-xl font-semibold">Hooks 配置</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            AI agent 编辑事件的 checkpoint 入口。配置后 stats 才不会掉零。
          </p>
        </div>
      )}

      {/* 当前模式 + 切换 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">当前模式</h2>
            <ModeBadge mode={status?.mode ?? "none"} />
          </div>
          <button
            // 同时刷新 hooks_status(当前模式)与 diagnose_environment(AgentCard 注册状态);
            // 后者是 AI Agent 卡片的数据源,只刷前者会让"修复后再次检测"看不到状态更新。
            onClick={() => {
              void statusQ.refetch();
              void diagQ.refetch();
            }}
            disabled={statusQ.isFetching || diagQ.isFetching}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw
              className={cn("h-3 w-3", (statusQ.isFetching || diagQ.isFetching) && "animate-spin")}
            />{" "}
            刷新
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {HOOKS_MODE_DESCRIPTIONS[(status?.mode ?? "none") as "official" | "none"]}
        </p>

        <div className="mt-3">
          <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">切换到</h3>
          <RadioGroup
            value={status?.mode ?? "none"}
            onValueChange={(v: HooksMode) => openSwitchDialog(v)}
          >
            <RadioItem value="official">官方 hooks</RadioItem>
            <RadioItem value="none">暂不配置</RadioItem>
          </RadioGroup>
        </div>
      </section>

      {/* settings.json 概览 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <FileJson className="h-4 w-4 text-muted-foreground" /> ~/.claude/settings.json
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={async () => {
                setDiffContent(settings?.raw ?? "(文件不存在)");
                setDiffOpen(true);
              }}
              className="inline-flex items-center gap-1 rounded-sm p-1 text-xs text-muted-foreground hover:bg-accent"
            >
              查看原文
            </button>
          </div>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {settings?.exists ? `${settings.raw_size} bytes · ${settings.path}` : "文件不存在"}
        </div>
        <p className="mt-2 rounded-sm bg-amber-50 p-2 text-[11px] text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {MSG.ccSwitchWarning}
        </p>
      </section>

      {/* 备份列表 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
          <History className="h-4 w-4 text-muted-foreground" /> 最近 5 次备份
        </h2>
        <ul className="space-y-1 text-xs">
          {(backupsQ.data ?? []).slice(0, 5).map((b) => (
            <BackupRow key={b.path} b={b} onRestore={() => setRestoreTarget(b)} />
          ))}
          {(backupsQ.data ?? []).length === 0 && (
            <li className="text-muted-foreground">尚无备份(任意一次写入操作都会自动备份原文件)</li>
          )}
        </ul>
      </section>

      {/* AI Agent 子卡 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">AI Agent hook 注册状态</h2>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {agentList.map((a) => (
            <AgentCard key={a.agent} a={a} />
          ))}
        </div>
      </section>

      {/* 日志区(切换 / install 时) */}
      {logs.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-medium">操作日志</h2>
          <div className="max-h-48 overflow-y-auto rounded-sm bg-neutral-900 p-3 font-mono text-[11px] leading-relaxed">
            {logs.map((l, i) => (
              <div
                key={i}
                className={cn(
                  l.stream === "stderr"
                    ? "text-rose-400"
                    : l.stream === "exit"
                      ? "text-emerald-400"
                      : "text-neutral-200",
                )}
              >
                {l.line}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 切换确认 Dialog */}
      <Dialog
        open={pendingMode !== null}
        onOpenChange={(v) => {
          if (!v) {
            setPendingMode(null);
            setConfirmText("");
          }
        }}
        title={`切换到「${modeLabel(pendingMode ?? "none")}」`}
        description="此操作会改写 ~/.claude/settings.json,详情如下。"
        size="lg"
        footer={
          <>
            <button
              onClick={() => {
                setPendingMode(null);
                setConfirmText("");
              }}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted dark:border-border dark:hover:bg-muted"
            >
              取消
            </button>
            <button
              onClick={() => pendingMode && switchModeM.mutate(pendingMode)}
              disabled={confirmText !== expectedConfirm || switchModeM.isPending}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50",
                pendingMode === "none"
                  ? "bg-rose-600 hover:bg-rose-500"
                  : "bg-primary hover:bg-primary/90",
              )}
            >
              {switchModeM.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              确认切换
            </button>
          </>
        }
      >
        {pendingMode && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmText === expectedConfirm) switchModeM.mutate(pendingMode);
            }}
            className="space-y-3"
          >
            <div>
              <div className="font-medium text-foreground/80">将会做这些:</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {sideEffectsFor(pendingMode).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-sm bg-amber-50 p-2 text-[12px] text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
              {MSG.mustRestartAgent}
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                输入 <span className="font-mono">{expectedConfirm}</span> 确认
              </label>
              <input
                autoFocus
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value.trim().toLowerCase())}
                className="mt-1 w-full rounded-sm border border-border bg-card px-2 py-1 text-sm dark:border-border dark:bg-card"
                placeholder={expectedConfirm}
              />
            </div>
            <input type="submit" hidden />
          </form>
        )}
      </Dialog>

      <Dialog
        open={restoreTarget !== null}
        onOpenChange={(v) => !restoreM.isPending && !v && setRestoreTarget(null)}
        title="还原 settings.json 备份"
        description="此操作会用选中的备份覆盖当前 ~/.claude/settings.json。"
        dismissible={!restoreM.isPending}
        footer={
          <>
            <button
              onClick={() => setRestoreTarget(null)}
              disabled={restoreM.isPending}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50 dark:border-border dark:hover:bg-muted"
            >
              取消
            </button>
            <button
              onClick={() => restoreTarget && restoreM.mutate(restoreTarget.path)}
              disabled={restoreM.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {restoreM.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              确认还原
            </button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <div className="font-mono text-xs text-muted-foreground">{restoreTarget?.path}</div>
          <div className="rounded-sm bg-amber-50 p-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
            还原后需要重启 AI agent,否则新 settings.json 不会被当前会话读取。
          </div>
        </div>
      </Dialog>

      {/* 完成后强制 Dialog 串(同 Install 页) */}
      <Dialog
        open={showRestartDialog}
        onOpenChange={() => {}}
        title="操作完成 — 第 1 步:重启 AI agent"
        size="md"
        dismissible={false}
        footer={
          <button
            onClick={() => {
              setShowRestartDialog(false);
              setShowTerminalDialog(true);
            }}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Check className="h-3.5 w-3.5" /> 我已重启 AI agent
          </button>
        }
      >
        <p>{MSG.mustRestartAgent}</p>
      </Dialog>
      <Dialog
        open={showTerminalDialog}
        onOpenChange={() => {}}
        title="操作完成 — 第 2 步:重开终端"
        size="md"
        dismissible={false}
        footer={
          <button
            onClick={() => {
              setShowTerminalDialog(false);
              qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
            }}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Check className="h-3.5 w-3.5" /> 我已重开终端
          </button>
        }
      >
        <p>{MSG.mustReopenTerminal}</p>
      </Dialog>

      {/* 失败 Dialog */}
      <Dialog
        open={showFailDialog}
        onOpenChange={() => {}}
        title="操作未成功"
        description="请查看上方日志区,或复制后求助。"
        dismissible={false}
        footer={
          <button
            onClick={() => setShowFailDialog(false)}
            className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500"
          >
            我知道了
          </button>
        }
      >
        <p>日志已保留在下方,可滚动查看 stdout / stderr 完整内容。</p>
      </Dialog>

      {/* settings.json 原文 Dialog */}
      <Dialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        title="~/.claude/settings.json 原文"
        size="lg"
      >
        <pre className="max-h-80 overflow-auto rounded-sm bg-neutral-900 p-3 font-mono text-[11px] text-neutral-200">
          {diffContent}
        </pre>
      </Dialog>

      <details className="rounded-sm border border-border bg-card p-3 text-xs text-muted-foreground dark:border-border dark:bg-card">
        <summary className="cursor-pointer text-foreground/80">
          <ArrowDown className="mr-1 inline h-3 w-3" />
          单独 git-ai install 一次(仅安装/修复官方 hooks)
        </summary>
        <p className="mt-2">
          点下方按钮直接调用 <code className="font-mono">git-ai install</code>,这是 git-ai
          官方推荐的写入方式,会同步处理 Cursor 等其它 agent。
        </p>
        <button
          onClick={() => installOfficialM.mutate()}
          disabled={busy}
          className="mt-2 inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {installOfficialM.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          运行 git-ai install
        </button>
      </details>
    </div>
  );
}

function sideEffectsFor(mode: HooksMode): string[] {
  switch (mode) {
    case "official":
      return HOOKS_SWITCH_SIDE_EFFECTS_TO_OFFICIAL;
    case "none":
      return HOOKS_SWITCH_SIDE_EFFECTS_TO_NONE;
  }
}

function modeLabel(mode: HooksMode): string {
  return {
    official: "官方 hooks",
    none: "暂不配置",
  }[mode];
}

function ModeBadge({ mode }: { mode: HooksMode }) {
  const map: Record<HooksMode, { tone: "success" | "warn" | "danger" | "neutral"; text: string }> =
    {
      official: { tone: "success", text: "官方 ✓" },
      none: { tone: "danger", text: "未配置" },
    };
  const m = map[mode];
  return <Badge tone={m.tone}>{m.text}</Badge>;
}

function BackupRow({ b, onRestore }: { b: SettingsBackup; onRestore: () => void }) {
  return (
    <li className="flex items-center justify-between rounded-sm border border-border px-2 py-1 dark:border-border">
      <div className="flex flex-1 items-center gap-2 truncate">
        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
        <span className="font-mono text-[11px]">{new Date(b.at_unix_ms).toLocaleString()}</span>
        <span className="truncate text-muted-foreground">{b.path}</span>
      </div>
      <button
        onClick={onRestore}
        className="inline-flex items-center gap-1 rounded-sm p-1 text-xs text-muted-foreground hover:bg-accent"
      >
        <RotateCcw className="h-3 w-3" /> 还原
      </button>
    </li>
  );
}

function AgentCard({ a }: { a: import("../lib/types").AgentHookStatus }) {
  const level: import("../lib/types").StatusLevel = a.configured
    ? "ok"
    : a.detected
      ? "err"
      : "muted";
  return (
    <div className="rounded-md border border-border p-2.5">
      <div className="flex items-center gap-1.5 text-sm">
        <StatusDot level={level} size="sm" />
        <span className="font-medium">{a.agent}</span>
        {a.hook_type && <Badge tone="neutral">{a.hook_type}</Badge>}
      </div>
      {a.config_path && (
        <div className="mt-2">
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            配置文件
          </div>
          <code className="block break-all rounded border border-border bg-muted px-2 py-1 font-mono text-[11px] leading-relaxed text-foreground/90 dark:bg-background">
            {a.config_path}
          </code>
        </div>
      )}
      {a.raw_excerpt && (
        <div className="mt-1.5">
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            hook 命令
          </div>
          <code className="block break-all rounded border border-border bg-muted px-2 py-1 font-mono text-[11px] leading-relaxed text-foreground/90 dark:bg-background">
            {a.raw_excerpt}
          </code>
        </div>
      )}
      {a.issues.length > 0 && (
        <ul className="mt-2 list-disc pl-4 text-[11px] text-amber-700 dark:text-amber-400">
          {a.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
