import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Download,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
  X as XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Badge } from "../components/Badge";
import { QuickFixDialog } from "../components/QuickFixDialog";
import { Dialog } from "../components/ui/DialogShell";
import { Switch } from "../components/ui/SwitchToggle";
import { Tooltip } from "../components/ui/TooltipBubble";
import {
  getGitAiConfig,
  getInstalledVersion,
  installGitAi,
  isInstallRunning,
  listReleases,
  setAutoUpdate,
  uninstallGitAi,
} from "../lib/api";
import { cn } from "../lib/cn";
import type { InstallLogEvent, ReleaseSummary } from "../lib/types";

type LogLine = { stream: "stdout" | "stderr" | "exit"; line: string; ts: number };

function genJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 归一化版本字符串用于比较:strip 前置 v/V。
 * - installed.version:来自 git-ai --version 的纯 semver(`extract_version` 正则只抓 `\d+.\d+.\d+`)
 * - latest.tag:GitHub `tag_name` 原值,git-ai 上游 release 习惯带 v 前缀(`v1.4.7`)
 * 字符串 === 比较会因为前缀漂移误报"未到最新",主按钮永远是"升级到 X" 状态。
 */
function normalizeTag(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/^v/i, "");
}

/** embedded=true 时收进 Setup 容器的 tab,隐藏自带大标题(Setup 已提供页级标题)。 */
export default function InstallPage({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const { t } = useTranslation();

  const installedQ = useQuery({
    queryKey: ["installed_version"],
    queryFn: getInstalledVersion,
    staleTime: 10_000,
  });
  const releasesQ = useQuery({
    queryKey: ["releases"],
    queryFn: () => listReleases(false),
    staleTime: 5 * 60_000,
  });
  const cfgQ = useQuery({
    queryKey: ["git_ai_config"],
    queryFn: getGitAiConfig,
    staleTime: 30_000,
  });
  const runningQ = useQuery({
    queryKey: ["install_running"],
    queryFn: isInstallRunning,
    refetchInterval: (q) => (q.state.data ? 1_500 : 5_000),
  });

  const installed = installedQ.data;
  const releases = useMemo(() => releasesQ.data?.releases ?? [], [releasesQ.data]);
  const cfg = cfgQ.data;
  const running = !!runningQ.data;

  const [logs, setLogs] = useState<LogLine[]>([]);
  const [exitOk, setExitOk] = useState<boolean | null>(null);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const [showTerminalDialog, setShowTerminalDialog] = useState(false);
  const [showFailDialog, setShowFailDialog] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [uninstallConfirm, setUninstallConfirm] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [versionMenuOpen, setVersionMenuOpen] = useState(false);
  const [reinstallOpen, setReinstallOpen] = useState(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const versionMenuRef = useRef<HTMLDivElement | null>(null);

  // 自动滚到底
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs.length]);

  // 版本下拉点击外部关闭
  useEffect(() => {
    if (!versionMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!versionMenuRef.current?.contains(e.target as Node)) setVersionMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [versionMenuOpen]);

  // 启动 install / uninstall 前同步挂 event listener,避免早期日志丢失。
  const startJob = useCallback(async (run: (jobId: string) => Promise<unknown>) => {
    // 先卸掉旧的(避免 leak)
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
      if (e.payload.stream === "exit") {
        const ok = (e.payload.code ?? 0) === 0;
        setExitOk(ok);
        if (ok) {
          setShowRestartDialog(true);
        } else {
          setShowFailDialog(true);
        }
      }
    });
    unlistenRef.current = un;
    return run(id);
  }, []);

  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const latest = useMemo<ReleaseSummary | null>(
    () => releases.find((r) => r.is_latest) ?? releases[0] ?? null,
    [releases],
  );

  const installM = useMutation({
    mutationFn: (version?: string) =>
      startJob((id) => installGitAi(id, version)) as Promise<number>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installed_version"] });
      qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
      qc.invalidateQueries({ queryKey: ["resolve_git_ai_path"] });
    },
    onError: (e) =>
      toast.error("安装命令执行失败", {
        description: (e as Error).message,
        duration: 6_000,
      }),
  });

  const uninstallM = useMutation({
    mutationFn: () => startJob((id) => uninstallGitAi(id, "uninstall")) as Promise<void>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installed_version"] });
      qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
      qc.invalidateQueries({ queryKey: ["resolve_git_ai_path"] });
      setUninstallOpen(false);
      setUninstallConfirm("");
    },
    onError: (e) => toast.error("卸载失败", { description: (e as Error).message, duration: 6_000 }),
  });

  const autoUpdateM = useMutation({
    mutationFn: setAutoUpdate,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["git_ai_config"] }),
    onError: (e) => toast.error("写入失败", { description: (e as Error).message }),
  });

  const copyLogs = useCallback(async () => {
    await navigator.clipboard.writeText(logs.map((l) => `[${l.stream}] ${l.line}`).join("\n"));
    toast.success("日志已复制");
  }, [logs]);

  return (
    <div className={cn("space-y-4", embedded ? "" : "p-6")}>
      {/* 顶部进度条:贴主内容区顶端(inset-x-0 跟随 Rail 宽度,避免硬编码侧栏宽) */}
      {running && (
        <div className="fixed inset-x-0 top-12 z-30 h-px bg-primary/100/80">
          <div className="h-full w-1/3 animate-pulse bg-primary/100" />
        </div>
      )}

      {!embedded && (
        <div>
          <h1 className="text-xl font-semibold">安装与升级 git-ai</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            默认安装最新稳定版,不预判 / 不推荐特定版本。
          </p>
        </div>
      )}

      {/* 当前版本 + 主操作 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="grid grid-cols-2 gap-6">
          <div>
            <h2 className="text-sm font-medium text-muted-foreground">当前已装版本</h2>
            <div className="mt-1 flex items-center gap-2">
              <Package className="h-5 w-5 text-muted-foreground" />
              {installedQ.isLoading ? (
                <span className="text-sm text-muted-foreground">检测中…</span>
              ) : installed?.installed ? (
                <span className="text-lg font-semibold">
                  {installed.version ?? "已装(版本未知)"}
                </span>
              ) : (
                <Badge tone="danger">未安装</Badge>
              )}
            </div>
            {installed?.binary_path && (
              <div
                className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                title={installed.binary_path}
              >
                {installed.binary_path}
              </div>
            )}
            {installed?.installed && (
              <button
                type="button"
                onClick={() => setReinstallOpen(true)}
                disabled={running || installM.isPending}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50 dark:text-muted-foreground dark:hover:text-neutral-200"
                title="重新下载并覆盖当前版本(仅在怀疑二进制损坏时使用)"
              >
                <RefreshCw className="h-3 w-3" />
                重新安装当前版本
              </button>
            )}
          </div>
          <div>
            <h2 className="text-sm font-medium text-muted-foreground">远端最新版本</h2>
            <div className="mt-1 flex items-center gap-2">
              <ArrowUp
                className={cn("h-5 w-5", latest ? "text-emerald-500" : "text-muted-foreground/50")}
              />
              {releasesQ.isLoading ? (
                <span className="text-sm text-muted-foreground">查询中…</span>
              ) : latest ? (
                <>
                  <span className="text-lg font-semibold">{latest.tag}</span>
                  <Badge tone="success">latest</Badge>
                </>
              ) : releasesQ.isError ? (
                <span className="text-sm text-muted-foreground">暂不可达</span>
              ) : (
                <span className="text-sm text-muted-foreground">无可用版本</span>
              )}
            </div>
            {releasesQ.data?.from_etag_cache && (
              <div className="mt-1 text-[11px] text-muted-foreground">
                304 命中(版本列表自上次以来未变化)
              </div>
            )}
            {/* 远端版本查询失败属**良性暂时态**(多为 GitHub 匿名 API 限流 60次/小时·按 IP,或网络不通),
                不影响已装版本使用 —— 故用中性提示 + 就近重试,而非醒目红错;原始状态留 title 供排查。 */}
            {releasesQ.isError && (
              <div
                className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground"
                title={(releasesQ.error as Error).message}
              >
                <span>GitHub 暂时限流或不可达,稍后重试(不影响已装版本)。</span>
                <button
                  type="button"
                  onClick={() => releasesQ.refetch()}
                  disabled={releasesQ.isFetching}
                  className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                >
                  {releasesQ.isFetching ? "重试中…" : "重试"}
                </button>
              </div>
            )}
            {latest && (
              <div className="mt-1 text-[11px] text-muted-foreground">
                发布于 {new Date(latest.published_at).toLocaleDateString()}
              </div>
            )}
          </div>
        </div>

        {/* 主操作 —— 已是最新版时禁用 + 文案明示;重新安装作为次级动作(放在已装版本块下) */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {(() => {
            const isUpToDate = !!(
              installed?.installed &&
              latest?.tag &&
              normalizeTag(installed.version) === normalizeTag(latest.tag)
            );
            const disabled = running || installM.isPending || !latest || isUpToDate;
            const label = isUpToDate
              ? `已是最新 ${latest!.tag}`
              : installed?.installed
                ? `升级到 ${latest?.tag ?? "latest"}`
                : `安装 ${latest?.tag ?? "latest"}`;
            return (
              <button
                onClick={() => installM.mutate(undefined)}
                disabled={disabled}
                title={isUpToDate ? "如需重装,请使用左侧「重新安装当前版本」" : undefined}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium",
                  isUpToDate
                    ? "border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300"
                    : "bg-primary text-primary-foreground hover:bg-primary/90",
                  "disabled:cursor-not-allowed",
                  isUpToDate ? "" : "disabled:opacity-60",
                )}
              >
                {running || installM.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : isUpToDate ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {label}
              </button>
            );
          })()}

          {/* 安装其它版本 */}
          <div className="relative" ref={versionMenuRef}>
            <button
              onClick={() => setVersionMenuOpen((v) => !v)}
              disabled={running || installM.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50 dark:border-border dark:bg-card dark:hover:bg-muted"
            >
              安装其它版本 <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {versionMenuOpen && (
              <div className="absolute z-20 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border border-border bg-card p-1 shadow-lg dark:border-border dark:bg-card">
                {releases.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">没有可选版本</div>
                )}
                {releases.map((r) => (
                  <button
                    key={r.tag}
                    onClick={() => {
                      setVersionMenuOpen(false);
                      setSelectedVersion(r.tag);
                      installM.mutate(r.tag);
                    }}
                    className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono">{r.tag}</span>
                      {r.is_latest && <Badge tone="success">latest</Badge>}
                      {r.is_prerelease && <Badge tone="warn">prerelease</Badge>}
                      {installed?.version === r.tag && <Badge tone="info">当前</Badge>}
                    </span>
                    <span className="text-muted-foreground">
                      {new Date(r.published_at).toLocaleDateString()}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Tooltip content="刷新远端版本列表">
            <button
              onClick={() => releasesQ.refetch()}
              disabled={releasesQ.isFetching}
              className="inline-flex items-center rounded-sm p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-50 dark:hover:bg-muted"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", releasesQ.isFetching && "animate-spin")} />
            </button>
          </Tooltip>

          <div className="flex-1" />

          {installed?.installed && (
            <button
              onClick={() => setUninstallOpen(true)}
              disabled={running}
              className="inline-flex items-center gap-1 rounded-md border border-rose-200 px-2.5 py-1.5 text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/40"
            >
              <Trash2 className="h-3.5 w-3.5" /> 卸载…
            </button>
          )}
        </div>

        {selectedVersion && (
          <div className="mt-2 text-[11px] text-muted-foreground">
            当前选择安装: <span className="font-mono">{selectedVersion}</span>
          </div>
        )}
      </section>

      {/* 自动更新 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">禁用 git-ai 自动更新</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              首次安装默认开启(禁用 git-ai 后台自更新,由 Studio 统一管理升级)。关闭则允许 git-ai
              自检更新。开启时写入下方 JSON。
            </p>
          </div>
          <Switch
            checked={cfg?.disable_auto_updates ?? false}
            onCheckedChange={(checked) => autoUpdateM.mutate(!checked)}
            disabled={cfgQ.isLoading || autoUpdateM.isPending}
            aria-label="禁用 git-ai 自动更新"
          />
        </div>
        {(cfg?.disable_auto_updates ?? false) && (
          <pre className="mt-3 overflow-x-auto rounded-sm bg-muted p-3 text-[11px] text-muted-foreground dark:bg-background dark:text-muted-foreground">
            {`将写入 ~/.git-ai/config.json:
{
  "disable_auto_updates": true,
  "update_channel": "none"
}`}
          </pre>
        )}
      </section>

      {/* 实时日志 */}
      {(logs.length > 0 || running) && (
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              安装日志
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              {!running && exitOk === true && <Badge tone="success">成功 exit 0</Badge>}
              {!running && exitOk === false && <Badge tone="danger">失败</Badge>}
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={copyLogs}
                disabled={logs.length === 0}
                className="inline-flex items-center gap-1 rounded-sm p-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50 dark:hover:bg-muted"
              >
                <Copy className="h-3 w-3" /> 复制
              </button>
              <button
                onClick={() => setLogs([])}
                disabled={logs.length === 0 || running}
                className="rounded-sm p-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50 dark:hover:bg-muted"
              >
                清空
              </button>
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-sm bg-neutral-900 p-3 font-mono text-[11px] leading-relaxed">
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
        </section>
      )}

      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
        <AlertTriangle className="mr-1 inline h-3 w-3" />
        {t("common.winPathSafeHint")}
      </div>

      <p className="text-center text-[11px] text-muted-foreground">{t("common.noUploadNotice")}</p>

      {/* 卸载确认 Dialog */}
      <Dialog
        open={uninstallOpen}
        onOpenChange={(v) => {
          setUninstallOpen(v);
          if (!v) setUninstallConfirm("");
        }}
        title="卸载 git-ai"
        description="此操作将移除 git-ai 二进制与代理 shim。"
        size="lg"
        footer={
          <>
            <button
              onClick={() => setUninstallOpen(false)}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted dark:border-border dark:hover:bg-muted"
            >
              取消
            </button>
            <button
              onClick={() => uninstallM.mutate()}
              disabled={uninstallConfirm !== "uninstall" || uninstallM.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
            >
              {uninstallM.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              卸载
            </button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (uninstallConfirm === "uninstall") uninstallM.mutate();
          }}
          className="space-y-3 text-sm"
        >
          <div>
            <div className="font-medium text-foreground/80">将移除的项:</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
              {(t("install.uninstallRemoved", { returnObjects: true }) as string[]).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="font-medium text-emerald-700 dark:text-emerald-400">保留不动:</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-emerald-700/80 dark:text-emerald-400/80">
              {(t("install.uninstallKept", { returnObjects: true }) as string[]).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-sm bg-amber-50 p-2 text-[12px] text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
            {t("common.mustRestartAgent")}
          </div>
          <div>
            <label className="text-xs text-muted-foreground">输入 uninstall 确认</label>
            <input
              autoFocus
              value={uninstallConfirm}
              onChange={(e) => setUninstallConfirm(e.target.value.trim().toLowerCase())}
              className="mt-1 w-full rounded-sm border border-border bg-card px-2 py-1 text-sm dark:border-border dark:bg-card"
              placeholder="uninstall"
            />
          </div>
          <input type="submit" hidden />
        </form>
      </Dialog>

      {/* 失败 Dialog(不可 dismiss,只能"我知道了"或"复制日志") */}
      <Dialog
        open={showFailDialog}
        onOpenChange={() => {
          /* 不可关闭,只能用按钮 */
        }}
        title="操作未成功"
        description="脚本返回非 0,请查看日志找原因或复制后求助。"
        dismissible={false}
        footer={
          <>
            <button
              onClick={copyLogs}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted dark:border-border dark:hover:bg-muted"
            >
              <Copy className="mr-1 inline h-3.5 w-3.5" /> 复制日志
            </button>
            <button
              onClick={() => setShowFailDialog(false)}
              className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500"
            >
              <XIcon className="h-3.5 w-3.5" /> 我知道了
            </button>
          </>
        }
      >
        <p>日志已保留在下方,可滚动查看 stdout / stderr 完整内容。</p>
      </Dialog>

      {/* 成功后强制串两个 Dialog(不可 dismiss) */}
      <Dialog
        open={showRestartDialog}
        onOpenChange={() => {
          /* not dismissible */
        }}
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
        <p>{t("common.mustRestartAgent")}</p>
      </Dialog>
      <Dialog
        open={showTerminalDialog}
        onOpenChange={() => {
          /* not dismissible */
        }}
        title="操作完成 — 第 2 步:重开终端"
        size="md"
        dismissible={false}
        footer={
          <button
            onClick={() => {
              setShowTerminalDialog(false);
              qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
              toast.success("Diagnostic 将自动重新检测");
            }}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Check className="h-3.5 w-3.5" /> 我已重开终端
          </button>
        }
      >
        <p>{t("common.mustReopenTerminal")}</p>
      </Dialog>

      {/* 安装副作用清单(常驻可展开) */}
      <details className="rounded-sm border border-border bg-card p-3 text-xs text-muted-foreground dark:border-border dark:bg-card">
        <summary className="cursor-pointer text-foreground/80">
          <ArrowDown className="mr-1 inline h-3 w-3" />
          安装会做哪些事(展开查看)
        </summary>
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {(t("install.sideEffects", { returnObjects: true }) as string[]).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </details>

      {/* 重新安装当前版本确认:覆盖式操作(下载 + 覆盖二进制),走 danger 风格 */}
      <QuickFixDialog
        open={reinstallOpen}
        onOpenChange={setReinstallOpen}
        title="重新安装当前版本"
        description={
          installed?.installed && installed.version
            ? `将重新下载并覆盖 git-ai ${installed.version}。仅在怀疑二进制损坏时使用。`
            : "将重新下载并覆盖当前 git-ai 二进制。"
        }
        willDo={[
          `从远端重新下载 ${installed?.version ?? "当前版本"} 二进制`,
          `覆盖现有路径:${installed?.binary_path ?? "(待定)"}`,
        ]}
        confirmLabel="确认重装"
        danger
        busy={installM.isPending || running}
        onConfirm={() => {
          setReinstallOpen(false);
          installM.mutate(undefined);
        }}
      />
    </div>
  );
}
