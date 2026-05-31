// 逐行 AI 归属详情(prompt 记录)的共享渲染件。
//
// Blame 页(行级停靠面板)与 Stats 页(commit 文件逐行弹窗)共用同一份呈现:
// tool::model + human_author + 仓库级 accepted/overriden/additions/deletions + other_files + commits。
// `accepted_lines / overriden_lines` 是**仓库级累计**(不是本行/本文件),必标 scope 警示,口径对齐
// 上游 git-ai blame-analysis。

import { useTranslation } from "react-i18next";

import type { BlamePayload, BlamePromptRecord } from "../lib/types";

export function BlamePromptDetails({
  record,
  lineNumber,
  metadata,
}: {
  record: BlamePromptRecord;
  lineNumber: number;
  metadata: BlamePayload["metadata"];
}) {
  const { t } = useTranslation();
  const toolModel = `${record.agent_id.tool}::${record.agent_id.model}`;
  const moreFiles = record.other_files.length > 5;
  const shownFiles = moreFiles ? record.other_files.slice(0, 5) : record.other_files;
  const hiddenFiles = moreFiles ? record.other_files.slice(5) : [];
  return (
    <div className="space-y-2 text-xs">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("blame.popover.promptHeading")} · 第 {lineNumber} 行
        </div>
        <div className="font-mono text-foreground">{toolModel}</div>
        {record.human_author && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {t("blame.popover.humanLabel")}:{record.human_author}
          </div>
        )}
        {!record.human_author && !metadata.is_logged_in && (
          <div className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-300">
            {t("blame.popover.loginRequired")}
          </div>
        )}
      </div>

      <div className="rounded-sm border border-amber-200 bg-amber-50 p-2 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
        <div className="text-[10px] font-semibold uppercase tracking-wide">
          {t("blame.popover.scopeWarningRepoWide")}
        </div>
        <div className="mt-1 font-mono text-[11px]">
          {t("blame.popover.acceptedTemplate", { n: record.accepted_lines })} ·{" "}
          {t("blame.popover.overridenTemplate", { n: record.overriden_lines })} ·{" "}
          {t("blame.popover.totalAdditionsTemplate", { n: record.total_additions })} ·{" "}
          {t("blame.popover.totalDeletionsTemplate", { n: record.total_deletions })}
        </div>
      </div>

      {record.other_files.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("blame.popover.otherFilesHeading")}
          </div>
          <ul className="mt-0.5 space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {shownFiles.map((f) => (
              <li key={f} className="truncate" title={f}>
                {f}
              </li>
            ))}
            {moreFiles && (
              <li className="text-[10px] text-muted-foreground" title={hiddenFiles.join("\n")}>
                {t("blame.popover.otherFilesMoreTemplate", { n: hiddenFiles.length })}
              </li>
            )}
          </ul>
        </div>
      )}

      {record.commits.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("blame.popover.commitsHeading")}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">
            {record.commits
              .slice(0, 3)
              .map((c) => c.slice(0, 7))
              .join(", ")}
            {record.commits.length > 3 ? "…" : ""}
          </div>
        </div>
      )}

      <div className="space-y-1 border-t border-border pt-2 text-[10px] text-muted-foreground">
        <div>{t("blame.popover.driftCaveat")}</div>
        <div>{t("blame.popover.mergeCaveat")}</div>
      </div>
    </div>
  );
}
