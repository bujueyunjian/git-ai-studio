// 通用日志 tail viewer。app 日志 tab 复用。
//
// # 设计
// - 拉取走 useQuery,自动刷新由 refetchInterval 控制(默认 OFF,Switch 切换)。
// - refetchOnWindowFocus=false:tab 失焦时不偷拉。
// - Header:路径(monospace)+ 大小(KB)+ mtime 相对时间 + truncated 角标。
// - 工具栏:刷新 / 自动刷新 Switch / 在资源管理器中打开(可选)。
// - Body:`<pre>` 自动滚到底部(自动刷新或刚刷新时);用户手动上滚后不再强滚。
// - 不存在 / 空文件:展示 emptyHint 子节点。

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileText, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { openLogDir, readLogFile } from "../lib/api";
import type { LogFilePayload, LogKind } from "../lib/types";
import { Switch } from "./ui/SwitchToggle";

interface Props {
  kind: LogKind;
  /** 默认是否打开自动刷新。 */
  defaultAutoRefresh?: boolean;
  /** 文件不存在或为空时显示的内容(由调用方提供,文案灵活)。 */
  emptyHint: ReactNode;
  /** 是否显示"在资源管理器中打开"按钮。 */
  showOpenInExplorer?: boolean;
  /** 最大尾部字节数(默认后端常量 256KB)。 */
  maxBytes?: number;
}

export function LogTailViewer({
  kind,
  defaultAutoRefresh = false,
  emptyHint,
  showOpenInExplorer = true,
  maxBytes,
}: Props) {
  const { t } = useTranslation();
  const [autoRefresh, setAutoRefresh] = useState(defaultAutoRefresh);
  const preRef = useRef<HTMLPreElement | null>(null);
  const userScrolledUpRef = useRef(false);

  const q = useQuery<LogFilePayload>({
    queryKey: ["logFile", kind.kind, maxBytes ?? null],
    queryFn: () => readLogFile(kind, maxBytes),
    refetchInterval: autoRefresh ? 5_000 : false,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });

  // 内容更新后自动滚到底部(除非用户手动滚上去过)
  useLayoutEffect(() => {
    if (!preRef.current) return;
    if (userScrolledUpRef.current) return;
    preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [q.data?.content]);

  // 监听滚动:用户滚离底部 > 32px 时记一下"自主滚动",回到底部时清掉
  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    const handler = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUpRef.current = distFromBottom > 32;
    };
    el.addEventListener("scroll", handler);
    return () => el.removeEventListener("scroll", handler);
  }, []);

  const open = async () => {
    try {
      // 后端用 `Path::parent()` 处理跨平台 root 边界:
      // Windows `C:\file.log` → `C:\`,POSIX `/file.log` → `/`,纯文件名 → 当前目录。
      await openLogDir(kind);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (q.isLoading && !q.data) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-200">
        {t("logs.viewer.loadFailed")}: {(q.error as Error).message}
      </div>
    );
  }

  const payload = q.data;
  if (!payload) return null;

  // 不存在 / 空文件:展示 emptyHint
  if (!payload.exists || payload.size === 0) {
    return (
      <div className="space-y-2">
        <ViewerHeader payload={payload} />
        <div className="rounded-md border border-dashed border-border bg-card p-4 text-center text-xs text-muted-foreground">
          {emptyHint}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ViewerHeader payload={payload} />
      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${q.isFetching ? "animate-spin" : ""}`} />
          {q.isFetching ? t("logs.viewer.refreshing") : t("logs.viewer.refresh")}
        </button>
        <label className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
          {t("logs.viewer.autoRefresh")}
        </label>
        {showOpenInExplorer && (
          <button
            type="button"
            onClick={() => void open()}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-accent"
          >
            <ExternalLink className="h-3 w-3" />
            {t("logs.viewer.openInExplorer")}
          </button>
        )}
      </div>
      <pre
        ref={preRef}
        className="max-h-[480px] min-h-[200px] overflow-y-auto rounded-md border border-border bg-slate-950 px-3 py-2 font-mono text-[11px] leading-5 text-slate-100"
      >
        {payload.content}
      </pre>
    </div>
  );
}

function ViewerHeader({ payload }: { payload: LogFilePayload }) {
  const { t } = useTranslation();
  const sizeText = t("logs.viewer.sizeKbTemplate", { kb: (payload.size / 1024).toFixed(1) });
  const mtime = payload.mtime_unix_ms
    ? formatRelative(payload.mtime_unix_ms)
    : t("logs.viewer.mtimeUnknown");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card px-3 py-1.5 text-[11px]">
      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
      <code className="break-all font-mono text-muted-foreground">{payload.path}</code>
      <span className="text-muted-foreground">·</span>
      <span className="text-muted-foreground">{sizeText}</span>
      <span className="text-muted-foreground">·</span>
      <span
        className="text-muted-foreground"
        title={new Date(payload.mtime_unix_ms ?? 0).toLocaleString()}
      >
        {mtime}
      </span>
      {payload.truncated_head && (
        <span className="ml-1 rounded-sm bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
          {t("logs.viewer.truncatedBadgeTemplate", {
            kb: Math.round(payload.content.length / 1024),
          })}
        </span>
      )}
    </div>
  );
}

const RTF = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
function formatRelative(unixMs: number): string {
  const diffSec = (unixMs - Date.now()) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 60) return RTF.format(Math.round(diffSec), "second");
  if (abs < 3600) return RTF.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return RTF.format(Math.round(diffSec / 3600), "hour");
  return RTF.format(Math.round(diffSec / 86400), "day");
}
