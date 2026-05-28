// Logs 诊断 tab — git-ai 诊断流式 runner。
//
// # 设计
// - 状态机:idle → running → done(code)。
// - listener 用 useEffect 挂卸,先挂 listen 后 invoke。
// - timeout 由后端 run_streaming 控制(15s),前端不二次计时。
// - 真实命令是 `git-ai debug`(无子参数),见 commands/logs.rs 文件头注释;
//   命令名 run_git_ai_debug_report 仅为维持 API 契约稳定,展示文案按上游口径写。
// - copy_all 通过 navigator.clipboard,失败 toast。

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Copy, Loader2, Play, RotateCcw, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { runGitAiDebugReport } from "../lib/api";
import type { LogStreamEvent } from "../lib/types";
import { useRouter } from "../router";

interface LogLine {
  stream: "stdout" | "stderr" | "exit";
  line: string;
  ts: number;
}

interface Props {
  /** git-ai 二进制是否就绪;false 时按钮禁用,显示跳 Install 卡。 */
  gitAiInstalled: boolean;
}

export function DebugReportRunner({ gitAiInstalled }: Props) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const router = useRouter();

  useEffect(
    () => () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    },
    [],
  );

  const start = async () => {
    if (running || !gitAiInstalled) return;
    const jobId = `debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setRunning(true);
    setLogs([]);
    setExitCode(null);
    setEndedAt(null);
    setStartedAt(Date.now());

    unlistenRef.current?.();
    const un = await listen<LogStreamEvent>(`logs://debug/${jobId}`, (e) => {
      setLogs((prev) => [
        ...prev,
        {
          stream: e.payload.stream,
          line: e.payload.line ?? "",
          ts: e.payload.ts,
        },
      ]);
      if (e.payload.stream === "exit") {
        setExitCode(e.payload.code ?? 0);
        setEndedAt(Date.now());
        setRunning(false);
      }
    });
    unlistenRef.current = un;

    try {
      await runGitAiDebugReport(jobId);
    } catch (e) {
      const msg = (e as Error).message;
      setLogs((prev) => [...prev, { stream: "stderr", line: msg, ts: Date.now() }]);
      setExitCode(-1);
      setEndedAt(Date.now());
      setRunning(false);
      toast.error(msg);
    }
  };

  const copyAll = async () => {
    const text = logs
      .filter((l) => l.stream !== "exit")
      .map((l) => l.line)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("logs.debug.copyDone"));
    } catch {
      toast.error(t("logs.viewer.loadFailed"));
    }
  };

  if (!gitAiInstalled) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-6 text-center dark:border-amber-900/40 dark:bg-amber-950/30">
        <Terminal className="mx-auto h-6 w-6 text-amber-600 dark:text-amber-400" />
        <div className="mt-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
          {t("logs.debug.noGitAi.title")}
        </div>
        <div className="mt-1 text-xs text-amber-800 dark:text-amber-200">
          {t("logs.debug.noGitAi.detail")}
        </div>
        <button
          type="button"
          onClick={() => router.navigate("install")}
          className="mt-3 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
        >
          {t("logs.debug.noGitAi.cta")}
        </button>
      </div>
    );
  }

  const tookMs = startedAt && endedAt ? endedAt - startedAt : null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("logs.debug.intro")}</p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void start()}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
        >
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("logs.debug.running")}
            </>
          ) : exitCode === null ? (
            <>
              <Play className="h-3.5 w-3.5" />
              {t("logs.debug.runButton")}
            </>
          ) : (
            <>
              <RotateCcw className="h-3.5 w-3.5" />
              {t("logs.debug.rerunButton")}
            </>
          )}
        </button>
        <button
          type="button"
          onClick={() => void copyAll()}
          disabled={logs.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300"
        >
          <Copy className="h-3.5 w-3.5" />
          {t("logs.debug.copyAll")}
        </button>
      </div>

      <div
        role="log"
        aria-live="polite"
        aria-atomic="false"
        className="min-h-[200px] max-h-[480px] overflow-y-auto rounded-md border border-border bg-slate-950 px-3 py-2 font-mono text-[11px] leading-5 text-slate-100"
      >
        {logs.length === 0 ? (
          <span className="text-slate-400">{t("logs.debug.emptyIdle")}</span>
        ) : (
          logs.map((l, i) => (
            <div
              key={i}
              className={
                l.stream === "stderr"
                  ? "text-rose-300"
                  : l.stream === "exit"
                    ? "text-amber-300"
                    : "text-slate-100"
              }
            >
              {l.stream === "exit"
                ? t("logs.debug.exitTemplate", {
                    code: exitCode ?? 0,
                    seconds: ((tookMs ?? 0) / 1000).toFixed(1),
                  })
                : l.line || " "}
            </div>
          ))
        )}
      </div>

      {exitCode !== null && exitCode !== 0 && (
        <p className="text-xs text-rose-700 dark:text-rose-300">{t("logs.debug.failed")}</p>
      )}
    </div>
  );
}
