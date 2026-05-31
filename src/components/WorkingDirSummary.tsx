// P10 #18/#37/#49 — 未提交 working dir 的 AI 占比 banner,Dashboard / Stats 顶部复用。
//
// # 权威 schema 来源
// - 后端 `git-ai status --json` 输出 `StatusOutput { stats: CommitStats, checkpoints: [...] }`
//   真源:`git-ai/src/commands/status.rs:25-29`
// - 我方包装为 `StatsResult { kind: "working", stats, total_additions, note_kind }`
//   真源:`src-tauri/src/commands/stats.rs::get_commit_status`
//
// # UX 决策
// - **total_additions > 0** 才显示:零修改时静默隐藏,避免空 banner 噪音
// - **degraded / error**:静默隐藏(后台 polling 时不打扰;Stats / Install 页本身有强提示)
// - **note_kind == working_logs_missing**:显示提示但跳 Hooks 页(grounded:`git-ai status`
//   会在无 checkpoint 时返空 stats — 上游 `status.rs:65`)
// - **跳 Stats**:已选 commit 时切到 Working 视图,需要 Stats 页支持 `__WORKING__` segment

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowRight, Loader2 } from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { getCommitStatus } from "../lib/api";
import { formatInt, formatPercent } from "../lib/formulas";
import type { StatsResult } from "../lib/types";
import { useNotesUpdated } from "../lib/useNotesUpdated";
import { useRouter } from "../router";

interface Props {
  /** 进 queryKey 防"切仓库串数据"(对齐 Dashboard headStatsQ 模式)。 */
  repoPath: string | null;
  /** 当前 HEAD sha,进 queryKey:切分支 / 提交后 HEAD 变 → key 变 → 自动重取(A1)。 */
  headSha?: string | null;
  /** 点 banner 的目标页。默认 `stats`(走 #/stats/__WORKING__),也可指向 `checkpoints`。 */
  jumpTo?: "stats" | "checkpoints";
  /** 自动刷新间隔。Dashboard 默认 10s;Stats 页 30s(不让用户看着抖)。 */
  refetchMs?: number;
}

/** `#/stats/<sha>` 的特殊 segment,选中后切到 working dir 视图。 */
export const WORKING_DIR_SHA_TOKEN = "__WORKING__";

export function WorkingDirSummary({
  repoPath,
  headSha = null,
  jumpTo = "stats",
  refetchMs = 10_000,
}: Props) {
  const router = useRouter();
  const { t } = useTranslation();
  const qc = useQueryClient();

  const statusQ = useQuery<StatsResult>({
    queryKey: ["commit_status", repoPath, headSha],
    queryFn: () => getCommitStatus(),
    refetchInterval: refetchMs,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
    // 网络抖动 / git-ai 临时失败时不抛红 banner,默默 retry
    retry: 1,
  });

  // 提交后(refs/notes/ai 变化)立即失效,不等 refetchMs 轮询 —— 解决"已提交仍显示未提交 xx 行"(A1)。
  useNotesUpdated(
    repoPath,
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: ["commit_status", repoPath] });
    }, [qc, repoPath]),
  );

  // degraded / error / loading 都静默隐藏(banner 是辅助信息,失败时不上 UI 噪音)
  if (statusQ.isLoading && !statusQ.data) return null;
  if (statusQ.isError) return null;
  if (statusQ.data?.status !== "ok") return null;

  const view = statusQ.data.view;
  // total_additions 是后端聚合(stats.rs:114 的 3 桶相加),不在前端重算
  const total = view.total_additions;
  if (total === 0) return null;

  const aiPct = total > 0 ? view.stats.ai_additions / total : 0;
  const handleJump = () => {
    if (jumpTo === "checkpoints") {
      router.navigate("checkpoints");
    } else {
      router.navigate("stats", WORKING_DIR_SHA_TOKEN);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleJump}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleJump();
        }
      }}
      title={t("workingDir.tooltipTemplate", {
        h: view.stats.human_additions,
        u: view.stats.unknown_additions,
        a: view.stats.ai_additions,
      })}
      className="group flex cursor-pointer items-center gap-3 rounded-md border border-primary bg-primary/5 px-3 py-2 text-xs transition-colors hover:bg-primary/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring dark:border-primary/40 dark:bg-primary/10 dark:hover:bg-primary/20"
    >
      {statusQ.isFetching && (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-hidden />
      )}
      {!statusQ.isFetching && (
        <Activity className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      )}
      <span className="font-medium text-primary">{t("workingDir.label")}</span>
      <span className="font-mono text-primary">{formatInt(total)} 行</span>
      <ThreeSegmentBar
        human={view.stats.human_additions}
        unknown={view.stats.unknown_additions}
        ai={view.stats.ai_additions}
        total={total}
      />
      <span className="font-mono text-primary">AI {formatPercent(aiPct)}</span>
      <ArrowRight className="ml-auto h-3.5 w-3.5 text-primary transition-transform group-hover:translate-x-0.5" />
    </div>
  );
}

function ThreeSegmentBar({
  human,
  unknown,
  ai,
  total,
}: {
  human: number;
  unknown: number;
  ai: number;
  total: number;
}) {
  // 三段数据色对齐 StatsBar(T4):人工=human 绿、未归因=unknown 灰、AI=ai 蓝,全站同口径。
  const segs = [
    { v: human, cls: "bg-human" },
    { v: unknown, cls: "bg-unknown" },
    { v: ai, cls: "bg-ai" },
  ];
  return (
    <div className="flex h-1.5 w-32 overflow-hidden rounded-full bg-muted">
      {segs.map((s, i) => {
        const pct = (s.v / total) * 100;
        if (pct <= 0) return null;
        return <div key={i} className={s.cls} style={{ width: `${pct}%` }} />;
      })}
    </div>
  );
}
