// P8 mock_checkpoint 二次确认 Dialog + 流式日志区。
//
// # 危险动作护栏(前评审 B C-1..C-5 + C C9..C14 综合)
// 1. 输入 "mock" 二次确认(对齐 P2 uninstall 范式)
// 2. 副作用清单逐条明示(写入路径 + 不可撤销 + 跨视图影响)
// 3. dirty files 预览(lazy load,git status --porcelain -z)
// 4. dirty 文件超阈值(>20)显示警告,建议传 pathspecs
// 5. pathspecs 用 textarea 多行(Windows 含空格路径)
// 6. 启动后:同窗口下移到流式日志区(不替换 Dialog 内容);完成后自动 invalidate + 关闭
// 7. fire-and-forget 提示:git-ai CLI 退出 ≠ daemon 落盘成功;前端轮询 N=10 × 500ms 验证
// 8. 三锁互斥由后端保证,前端用 isMockRunning 实时禁用按钮

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Loader2, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Dialog } from "./ui/DialogShell";
import { gitStatusPorcelain, mockCheckpoint } from "../lib/api";
import type { GitStatusFile, MockPreset } from "../lib/types";

interface Props {
  open: boolean;
  preset: MockPreset;
  onOpenChange: (open: boolean) => void;
  /** mock 成功后回调(前端用于 invalidate query + 滚动到顶部)。 */
  onDone: () => void;
}

interface LogLine {
  stream: "stdout" | "stderr" | "exit";
  line: string;
  ts: number;
}

const DIRTY_PREVIEW_LIMIT = 20;
const DIRTY_WARN_THRESHOLD = 20;

export function MockCheckpointDialog({ open, preset, onOpenChange, onDone }: Props) {
  const { t } = useTranslation();
  const [pathspecs, setPathspecs] = useState("");
  const [confirm, setConfirm] = useState("");
  const [dirty, setDirty] = useState<GitStatusFile[] | null>(null);
  const [dirtyError, setDirtyError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // 打开 Dialog 时 lazy load dirty files
  useEffect(() => {
    if (!open) return;
    setDirty(null);
    setDirtyError(null);
    gitStatusPorcelain()
      .then((p) => setDirty(p.files))
      .catch((e: Error) => setDirtyError(e.message));
  }, [open]);

  // 关闭时清状态
  useEffect(() => {
    if (open) return;
    setPathspecs("");
    setConfirm("");
    setRunning(false);
    setLogs([]);
    setExitCode(null);
    unlistenRef.current?.();
    unlistenRef.current = null;
  }, [open]);

  // 卸载时清 listener
  useEffect(
    () => () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    },
    [],
  );

  const presetLabel = preset; // 直接展示 snake_case CLI 名,与文档一致
  const parsedPathspecs = useMemo(
    () =>
      pathspecs
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [pathspecs],
  );

  const canSubmit =
    !running &&
    confirm.trim() === t("checkpoints.mockDialog.confirmPlaceholder") &&
    exitCode === null;

  const dirtyCount = dirty?.length ?? 0;
  const showDirtyWarn = parsedPathspecs.length === 0 && dirtyCount > DIRTY_WARN_THRESHOLD;

  const start = async () => {
    if (!canSubmit) return;
    const jobId = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setRunning(true);
    setLogs([]);
    setExitCode(null);

    // 先挂 listener,再 invoke,避免早期日志丢失
    unlistenRef.current?.();
    const un = await listen<LogLine & { code?: number }>(`checkpoint://${jobId}/log`, (e) => {
      setLogs((prev) => [
        ...prev,
        {
          stream: e.payload.stream,
          line: e.payload.line ?? "",
          ts: e.payload.ts,
        },
      ]);
      if (e.payload.stream === "exit") {
        const code = e.payload.code ?? 0;
        setExitCode(code);
        if (code === 0) {
          toast.success(t("checkpoints.mockDialog.doneOk"), {
            description: t("checkpoints.mockDialog.fireAndForgetHint"),
          });
          // 给 daemon 一点时间落盘,然后让父组件 invalidate
          window.setTimeout(() => {
            onDone();
            onOpenChange(false);
          }, 800);
        } else {
          toast.error(`mock_checkpoint 失败(exit ${code})`);
        }
      }
    });
    unlistenRef.current = un;

    try {
      await mockCheckpoint(jobId, preset, parsedPathspecs, confirm.trim());
    } catch (e) {
      const msg = (e as Error).message;
      setLogs((prev) => [...prev, { stream: "stderr", line: msg, ts: Date.now() }]);
      setExitCode(-1);
      setRunning(false);
      toast.error(msg);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (running && exitCode === null) return; // 执行中不允许关闭
        onOpenChange(v);
      }}
      title={
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-600" />
          {t("checkpoints.mockDialog.titleTemplate", { preset: presetLabel })}
        </div>
      }
      description={t("checkpoints.mockDialog.intro")}
      size="lg"
      dismissible={!running || exitCode !== null}
    >
      <div className="space-y-4">
        {/* 副作用清单 */}
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            副作用
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-[12px] text-foreground/80">
            {(t("checkpoints.mockDialog.sideEffects", { returnObjects: true }) as string[]).map(
              (s) => (
                <li key={s}>{s}</li>
              ),
            )}
          </ul>
        </section>

        {/* pathspecs 输入 */}
        <section>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("checkpoints.mockDialog.pathspecsLabel")}
          </label>
          <textarea
            value={pathspecs}
            onChange={(e) => setPathspecs(e.target.value)}
            placeholder={t("checkpoints.mockDialog.pathspecsPlaceholder")}
            spellCheck={false}
            rows={3}
            disabled={running}
            className="w-full rounded-md border border-border bg-card px-2 py-1.5 font-mono text-xs shadow-xs focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-ring dark:border-border dark:bg-card"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            {t("checkpoints.mockDialog.pathspecsHelp")}
          </p>
        </section>

        {/* dirty files 预览 */}
        {parsedPathspecs.length === 0 && (
          <section>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">
              {t("checkpoints.mockDialog.dirtyPreviewTitle")}
            </h3>
            {dirty === null && !dirtyError ? (
              <div className="text-[11px] text-muted-foreground">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                加载中…
              </div>
            ) : dirtyError ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                {t("checkpoints.mockDialog.dirtyPreviewUnavailable")}
              </div>
            ) : dirtyCount === 0 ? (
              <div className="text-[11px] text-muted-foreground">无 dirty 文件</div>
            ) : (
              <>
                <ul className="max-h-32 overflow-y-auto rounded-md border border-border bg-muted px-2 py-1 font-mono text-[11px] dark:border-border dark:bg-card/40">
                  {(dirty ?? []).slice(0, DIRTY_PREVIEW_LIMIT).map((f) => (
                    <li key={f.path} className="flex items-center gap-2">
                      <code className="text-muted-foreground">{f.status}</code>
                      <span className="truncate">{f.path}</span>
                    </li>
                  ))}
                </ul>
                {dirtyCount > DIRTY_PREVIEW_LIMIT && (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {t("checkpoints.mockDialog.dirtyPreviewMoreTemplate", {
                      n: dirtyCount - DIRTY_PREVIEW_LIMIT,
                    })}
                  </p>
                )}
                {showDirtyWarn && (
                  <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                    {t("checkpoints.mockDialog.dirtyPreviewTooManyWarnTemplate", { n: dirtyCount })}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {/* 二次确认输入 */}
        {exitCode === null && (
          <section>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t("checkpoints.mockDialog.confirmInputLabel")}
            </label>
            <input
              type="text"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={t("checkpoints.mockDialog.confirmPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              disabled={running}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) {
                  e.preventDefault();
                  void start();
                }
              }}
              className="w-40 rounded-md border border-border bg-card px-2 py-1 font-mono text-xs shadow-xs focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-ring dark:border-border dark:bg-card"
            />
            <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
              {t("checkpoints.mockDialog.irreversibleWarn")}
            </p>
          </section>
        )}

        {/* 流式日志区 */}
        {(running || exitCode !== null) && (
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("checkpoints.mockDialog.logTitle")}
            </h3>
            <div
              role="log"
              aria-live="polite"
              aria-atomic="false"
              className="max-h-48 overflow-y-auto rounded-md border border-border bg-neutral-900 px-2 py-1.5 font-mono text-[11px] text-neutral-100"
            >
              {logs.length === 0 ? (
                <span className="text-muted-foreground">
                  <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                  {t("checkpoints.mockDialog.starting")}
                </span>
              ) : (
                logs.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.stream === "stderr"
                        ? "text-rose-300"
                        : l.stream === "exit"
                          ? "text-amber-300"
                          : "text-neutral-200"
                    }
                  >
                    {l.stream === "exit" ? `[exit] ${l.line || ""}` : l.line}
                  </div>
                ))
              )}
            </div>
            {exitCode === 0 && (
              <p className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                {t("checkpoints.mockDialog.fireAndForgetHint")}
              </p>
            )}
          </section>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          disabled={running && exitCode === null}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted"
        >
          {t("checkpoints.mockDialog.cancel")}
        </button>
        <button
          type="button"
          onClick={() => void start()}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
        >
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("checkpoints.mockDialog.running")}
            </>
          ) : (
            t("checkpoints.mockDialog.start")
          )}
        </button>
      </div>
    </Dialog>
  );
}
