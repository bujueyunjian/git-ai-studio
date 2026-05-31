// 提交归因 commit 列表(纯展示)。Stats 页与 Blame 页共用同一份 commit 行渲染:
// AI 热度点 + subject + 作者 + AI% + 日期。
//
// # 抽象边界(Linus Good Taste)
// 本组件只认 props + 回调,**无 mode 分支**:容器逻辑(commit 数据怎么来、点了去哪)留各自页面。
// Stats 在外层包未提交改动行 + 分隔条;Blame 在外层包搜索框 + 改动文件面板。共用的只有"一排 commit 行"。

import { useTranslation } from "react-i18next";

import { cn } from "../lib/cn";
import { commitTotal } from "../lib/formulas";
import type { CommitWithStats } from "../lib/types";

export function CommitAttributionList({
  commits,
  failedShas,
  selectedSha,
  onSelect,
}: {
  commits: CommitWithStats[];
  failedShas: Set<string>;
  selectedSha: string | undefined;
  onSelect: (sha: string) => void;
}) {
  const { t } = useTranslation();
  if (commits.length === 0) {
    return (
      <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
        {t("commitList.empty")}
      </div>
    );
  }
  return (
    <>
      {commits.map((c) => (
        <CommitRow
          key={c.sha}
          commit={c}
          failed={failedShas.has(c.sha)}
          selected={c.sha === selectedSha}
          onSelect={() => onSelect(c.sha)}
        />
      ))}
    </>
  );
}

function CommitRow({
  commit,
  failed,
  selected,
  onSelect,
}: {
  commit: CommitWithStats;
  failed: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const total = commitTotal(commit.stats);
  const pct = total > 0 ? Math.round((commit.stats.ai_additions / total) * 100) : 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs",
        selected ? "bg-primary/10" : "hover:bg-muted/40",
      )}
    >
      {/* graph 点:AI 占比染深浅(AI heat) */}
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary"
        style={{ opacity: failed ? 0.12 : 0.18 + 0.82 * (pct / 100) }}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">
        {commit.subject}
        {commit.is_merge && <span className="ml-1 text-muted-foreground/60">(merge)</span>}
      </span>
      <span className="w-20 shrink-0 truncate text-muted-foreground">{commit.author_name}</span>
      {failed ? (
        <span
          className="w-14 shrink-0 text-right text-[11px] text-danger"
          title={t("commitList.failedTitle")}
        >
          {t("commitList.failed")}
        </span>
      ) : (
        <span
          className={cn(
            "w-14 shrink-0 text-right font-mono tabular-nums",
            pct > 0 ? "font-medium text-primary" : "text-muted-foreground/50",
          )}
        >
          AI {pct}%
        </span>
      )}
      <span className="w-24 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
        {commit.authored_at.slice(0, 10)}
      </span>
    </button>
  );
}
