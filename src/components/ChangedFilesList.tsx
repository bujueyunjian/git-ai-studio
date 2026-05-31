// 单 commit 改动文件面板(数据容器 + 纯展示)。Stats 详情区与 Blame 左栏共用。
//
// # 数据口径
// - 改动文件来自 `list_changed_files_in_commit`(git diff status code 透传 A/M/D/R/C/T/...)
// - 每文件 AI 行数来自 `list_ai_lines_in_commit`,同文件多段累加;**只显真实 AI 行数,不编造分母**
//
// # 抽象边界
// onOpenFile 由调用方注入(Stats 开弹窗 / Blame 在主区渲染整文件逐行 blame);
// selectedFile 仅用于高亮当前文件(Blame 传当前文件,Stats 不传)——纯展示态,非行为分支。

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { listAiLinesInCommit, listChangedFilesInCommit } from "../lib/api";
import { cn } from "../lib/cn";
import type { AiLinesResult, ChangedFile, ChangedFilesResult } from "../lib/types";

export function ChangedFilesPanel({
  sha,
  onOpenFile,
  selectedFile,
}: {
  sha: string;
  onOpenFile: (file: string) => void;
  /** 高亮当前打开的文件(Blame 左栏用);Stats 弹窗模式不传。 */
  selectedFile?: string;
}) {
  const { t } = useTranslation();
  const changedQ = useQuery<ChangedFilesResult>({
    queryKey: ["changed_files", sha],
    queryFn: () => listChangedFilesInCommit(sha),
    staleTime: 60_000,
  });
  const aiLinesQ = useQuery<AiLinesResult>({
    queryKey: ["ai_lines_in_commit", sha],
    queryFn: () => listAiLinesInCommit(sha),
    staleTime: 60_000,
  });

  // file path → AI 行数(同文件多段累加)。真实值,不派生分母。
  const aiLinesByFile = useMemo(() => {
    const m = new Map<string, number>();
    if (aiLinesQ.data?.status === "ok") {
      for (const ref of aiLinesQ.data.lines) {
        m.set(ref.file, (m.get(ref.file) ?? 0) + (ref.line_end - ref.line_start + 1));
      }
    }
    return m;
  }, [aiLinesQ.data]);

  const data = changedQ.data;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {t("changedFiles.title")}
        {data?.status === "ok" && (
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {data.files.length}
          </span>
        )}
      </div>
      {changedQ.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("changedFiles.loading")}
        </div>
      ) : changedQ.isError ? (
        <div className="text-xs text-danger">
          {t("changedFiles.failedPrefix")}:{(changedQ.error as Error).message}
        </div>
      ) : !data ? null : data.status === "degraded" ? (
        <div className="text-xs text-muted-foreground">
          {data.reason.kind === "invalid_sha"
            ? t("changedFiles.invalidSha")
            : t("stats.degraded.repoMissing.title")}
        </div>
      ) : data.files.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t("changedFiles.empty")}</div>
      ) : (
        <ChangedFilesList
          files={data.files}
          aiLinesByFile={aiLinesByFile}
          onOpenFile={onOpenFile}
          selectedFile={selectedFile}
        />
      )}
    </div>
  );
}

function ChangedFilesList({
  files,
  aiLinesByFile,
  onOpenFile,
  selectedFile,
}: {
  files: ChangedFile[];
  aiLinesByFile: Map<string, number>;
  onOpenFile: (file: string) => void;
  selectedFile?: string;
}) {
  const { t } = useTranslation();
  const statusLabelMap = t("changedFiles.status", { returnObjects: true }) as Record<
    string,
    string
  >;
  return (
    <ul className="space-y-0.5 text-xs">
      {files.map((f) => {
        const aiCount = aiLinesByFile.get(f.path) ?? 0;
        const statusLabel = statusLabelMap[f.status] ?? f.status;
        const disabled = f.status === "D";
        const active = selectedFile === f.path;
        return (
          <li key={`${f.status}:${f.path}`}>
            <button
              type="button"
              onClick={() => !disabled && onOpenFile(f.path)}
              disabled={disabled}
              title={
                disabled ? t("changedFiles.deletedFileTitle") : t("changedFiles.viewBlameTitle")
              }
              className={cn(
                "group flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
                active ? "bg-primary/10" : "hover:bg-muted",
              )}
            >
              <StatusBadge status={f.status} label={statusLabel} />
              <code
                className={cn(
                  "min-w-0 flex-1 truncate font-mono text-[11px] group-hover:text-foreground",
                  active ? "text-primary" : "text-foreground/90",
                )}
              >
                {f.path}
              </code>
              {aiCount > 0 && (
                <span className="shrink-0 rounded-sm bg-ai/10 px-1.5 py-0.5 text-[10px] font-medium text-ai ring-1 ring-inset ring-ai/30">
                  {t("changedFiles.aiLineChipTemplate", { n: aiCount })}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// git diff status 字符 → 语义 tone(与 AI / 人工数据色解耦,表达文件级 git 操作)。
const STATUS_TONE: Record<string, string> = {
  A: "bg-success-muted text-success",
  M: "bg-warning-muted text-warning-foreground dark:text-warning",
  D: "bg-danger-muted text-danger",
  C: "bg-info-muted text-info",
};
const STATUS_TONE_NEUTRAL = "bg-muted text-muted-foreground";

function StatusBadge({ status, label }: { status: string; label: string }) {
  const cls = STATUS_TONE[status] ?? STATUS_TONE_NEUTRAL;
  return (
    <span
      className={`inline-flex w-[42px] shrink-0 items-center justify-center rounded-sm px-1 py-0.5 text-[10px] font-medium ${cls}`}
      title={`${status} · ${label}`}
    >
      {label}
    </span>
  );
}
