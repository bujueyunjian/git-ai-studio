// Stats 页(P4):单 commit 的 AI 归因可视化。
//
// # 权威 schema 来源
// - 字段定义:`git-ai/src/authorship/stats.rs:9-33`
// - 公式:`stats.rs:114`(total = human + unknown + ai)
// - merge 行为:`specs/git_ai_standard_v3.0.0.md` §2.2(MAY have empty authorship log)

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  GitMerge,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Dialog } from "../components/ui/DialogShell";
import { Card } from "../components/ui/CardPanel";
import { EmptyState } from "../components/EmptyState";
import { FormulaPopover } from "../components/FormulaPopover";
import { StatsBar } from "../components/StatsBar";
import { WorkingDirSummary, WORKING_DIR_SHA_TOKEN } from "../components/WorkingDirSummary";
import {
  getCommitStats,
  getCommitStatus,
  getShowRaw,
  listAiLinesInCommit,
  listChangedFilesInCommit,
  listRecentCommits,
} from "../lib/api";
import { buildBlameUrlParams } from "../lib/blameUrl";
import {
  deriveRates,
  formatInt,
  formatPercent,
  formatRelativeFromNow,
  METRICS,
} from "../lib/formulas";
import type { MetricId } from "../lib/formulas";
import type {
  AiLinesResult,
  ChangedFilesResult,
  CommitBrief,
  ShowRawResult,
  StatsResult,
  StatsView,
  ToolModelStats,
} from "../lib/types";
import { useRouter } from "../router";

const COMMIT_LIST_LIMIT = 30;
/** stats 缓存过期时间(秒),对齐后端 SQLite 缓存策略。 */
const STATS_STALE_TIME_SECONDS = 30;
const STALE_TIME_MS = STATS_STALE_TIME_SECONDS * 1000;

export default function StatsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const qc = useQueryClient();
  const [shaInput, setShaInput] = useState("");
  const [now, setNow] = useState(Date.now());
  const [showSha, setShowSha] = useState<string | null>(null);

  const selectedSha = router.params || undefined;
  const isWorking = selectedSha === WORKING_DIR_SHA_TOKEN;

  const commitsQ = useQuery({
    queryKey: ["list_recent_commits", COMMIT_LIST_LIMIT],
    queryFn: () => listRecentCommits(COMMIT_LIST_LIMIT),
    staleTime: STALE_TIME_MS,
  });

  // 选 __WORKING__ 时切到 working dir 视图(`git-ai status --json`);
  // 其它情况走 `git-ai stats [sha] --json`。两者后端返同形 StatsResult。
  const statsQ = useQuery<StatsResult>({
    queryKey: ["commit_stats", isWorking ? "__WORKING__" : (selectedSha ?? "__HEAD__")],
    queryFn: () => (isWorking ? getCommitStatus() : getCommitStats(selectedSha)),
    staleTime: STALE_TIME_MS,
  });

  useEffect(() => {
    setShaInput(selectedSha ?? "");
  }, [selectedSha]);

  // 让"N 秒前"自然走;每 10s 重渲染一次足够,不需要每秒。
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["commit_stats", selectedSha ?? "__HEAD__"] });
    qc.invalidateQueries({ queryKey: ["list_recent_commits", COMMIT_LIST_LIMIT] });
  };

  // ===== degraded 空态 =====
  if (statsQ.data?.status === "degraded") {
    const kind = statsQ.data.reason.kind;
    // kind → i18n key 前缀:repo_missing / git_ai_missing / no_head
    const keyPrefix =
      kind === "repo_missing"
        ? "stats.degraded.repoMissing"
        : kind === "git_ai_missing"
          ? "stats.degraded.gitAiMissing"
          : "stats.degraded.noHead";
    const ctaKey = kind !== "no_head" ? `${keyPrefix}.cta` : undefined;
    return (
      <EmptyState
        Icon={kind === "repo_missing" ? FolderOpen : Activity}
        title={t(`${keyPrefix}.title`)}
        description={t(`${keyPrefix}.description`)}
        ctaLabel={ctaKey ? t(ctaKey as never) : undefined}
        onCta={
          ctaKey ? () => router.navigate(kind === "repo_missing" ? "repo" : "install") : undefined
        }
      />
    );
  }

  if (statsQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在解析 git-ai stats…
      </div>
    );
  }
  if (statsQ.isError) {
    return (
      <div className="p-6">
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          解析失败:{(statsQ.error as Error).message}
        </div>
      </div>
    );
  }

  const view: StatsView | null = statsQ.data?.status === "ok" ? statsQ.data.view : null;
  if (!view) return null;

  const rates = deriveRates(view.stats, view.total_additions);

  // commit 下拉 value 锚定 URL 真值,而不是后端返回值,避免"选 HEAD 又跳回具体 sha"
  const selectValue = selectedSha ?? "";

  return (
    <div className="space-y-5 p-6">
      <Header
        view={view}
        commits={commitsQ.data ?? []}
        selectValue={selectValue}
        shaInput={shaInput}
        setShaInput={setShaInput}
        onPickSha={(sha) => router.navigate("stats", sha)}
        onClearSha={() => router.navigate("stats")}
        onViewNotes={(sha) => router.navigate("notes", sha)}
        onViewShow={(sha) => setShowSha(sha)}
      />

      {/* working dir banner:已在 working 视图时隐藏(自指无意义) */}
      {view.kind !== "working" && (
        <WorkingDirSummary repoPath={null} jumpTo="stats" refetchMs={30_000} />
      )}

      <CacheBar
        fetchedAt={statsQ.dataUpdatedAt}
        now={now}
        isFetching={statsQ.isFetching || commitsQ.isFetching}
        onRefresh={refresh}
      />

      <NoteBanners view={view} />

      {/* 任务 #2:本 commit 改动文件折叠 section(working 视图无 sha,不渲染) */}
      {view.kind === "commit" && view.commit_sha && <ChangedFilesSection sha={view.commit_sha} />}

      <Card>
        <StatsBar stats={view.stats} total={view.total_additions} />
      </Card>

      <MetricsRow view={view} rates={rates} />

      <ToolModelTable breakdown={view.stats.tool_model_breakdown} />

      <ShowRawDialog sha={showSha} onClose={() => setShowSha(null)} />
    </div>
  );
}

// ============ 顶部 ============

function Header({
  view,
  commits,
  selectValue,
  shaInput,
  setShaInput,
  onPickSha,
  onClearSha,
  onViewNotes,
  onViewShow,
}: {
  view: StatsView;
  commits: CommitBrief[];
  selectValue: string;
  shaInput: string;
  setShaInput: (v: string) => void;
  onPickSha: (sha: string) => void;
  onClearSha: () => void;
  onViewNotes: (sha: string) => void;
  onViewShow: (sha: string) => void;
}) {
  const { t } = useTranslation();
  const isWorking = view.kind === "working";
  // HEAD 短 sha,仅在非 working 视图时显示;working 时下拉的 HEAD 选项保持中性"HEAD"标签
  const headLabel = !isWorking && view.commit_sha ? view.commit_sha.slice(0, 7) : "HEAD";

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold">{isWorking ? "工作树未提交摘要" : "Commit 详情"}</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          {isWorking
            ? "本地工作树未提交改动的 AI 归因。"
            : "选中 commit 的 AI 归因明细;数字本地解析,不上传。"}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-slate-500">选择 commit:</label>
        <select
          aria-label="选择 commit"
          className="rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-xs shadow-xs dark:border-border dark:bg-card"
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) onClearSha();
            else onPickSha(v);
          }}
        >
          <option value="">HEAD ({headLabel})</option>
          <option value={WORKING_DIR_SHA_TOKEN}>本地工作树(未提交)</option>
          {commits.map((c) => (
            <option key={c.sha} value={c.sha}>
              {c.short} · {c.authored_at.slice(0, 10)} · {c.subject.slice(0, 50)}
              {c.is_merge ? " (merge)" : ""}
            </option>
          ))}
        </select>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = shaInput.trim();
            if (trimmed) onPickSha(trimmed);
          }}
          className="flex items-center gap-1"
        >
          <input
            type="text"
            value={shaInput}
            onChange={(e) => setShaInput(e.target.value)}
            placeholder="或粘贴 sha…"
            spellCheck={false}
            className="w-44 rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-xs shadow-xs focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-ring dark:border-border dark:bg-card"
          />
          <button
            type="submit"
            disabled={!shaInput.trim()}
            className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
          >
            查看
          </button>
        </form>

        {view.commit_sha && (
          <>
            <code className="ml-auto rounded-sm bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {view.commit_sha}
            </code>
            <button
              type="button"
              onClick={() => onViewNotes(view.commit_sha as string)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-slate-800"
              title="查看 git notes --ref=ai 原始内容"
            >
              查看原始 notes
            </button>
            <button
              type="button"
              onClick={() => onViewShow(view.commit_sha as string)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-slate-800"
              title="git-ai show <sha> 原文"
            >
              <FileText className="h-3 w-3" />
              {t("showRaw.trigger")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ============ 缓存可见性条 ============

function CacheBar({
  fetchedAt,
  now,
  isFetching,
  onRefresh,
}: {
  fetchedAt: number;
  now: number;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const rel = fetchedAt ? formatRelativeFromNow(fetchedAt, now) : "—";
  return (
    <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500 dark:border-border dark:bg-card/40">
      <div>
        {t("stats.cacheHint.refreshedPrefix")} <span className="font-mono">{rel}</span>
        <span className="ml-2 text-slate-400">· 缓存 {STATS_STALE_TIME_SECONDS}s · 数据不上传</span>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={isFetching}
        className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-slate-600 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"
        aria-label="立即刷新 stats"
      >
        <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
        {isFetching ? t("stats.cacheHint.refreshing") : t("stats.cacheHint.refreshNow")}
      </button>
    </div>
  );
}

// ============ Note 警示条(基于客观字段,无启发式阈值) ============

function NoteBanners({ view }: { view: StatsView }) {
  const { t } = useTranslation();
  const router = useRouter();
  type Banner = {
    tone: "amber" | "info";
    text: string;
    key: string;
    cta?: { label: string; onClick: () => void };
  };
  const banners: Banner[] = [];

  if (view.note_kind === "merge") {
    banners.push({ tone: "info", text: t("stats.noteText.merge"), key: "merge" });
  }
  if (view.note_kind === "empty_additions") {
    banners.push({ tone: "info", text: t("stats.noteText.emptyAdditions"), key: "empty" });
  }
  if (view.note_kind === "working_logs_missing") {
    // working_logs_missing 文案引导用户去 Hooks 页确认 —— 配套提供跳转按钮,避免"读到指令找不到入口"。
    banners.push({
      tone: "amber",
      text: t("stats.noteText.workingLogsMissing"),
      key: "wlm",
      cta: { label: "前往 Hooks", onClick: () => router.navigate("hooks") },
    });
  }

  if (banners.length === 0) return null;
  return (
    <div className="space-y-2">
      {banners.map((b) => (
        <div
          key={b.key}
          className={
            b.tone === "amber"
              ? "flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200"
              : "flex items-start gap-2 rounded-md border border-primary bg-primary/10 p-3 text-xs text-primary dark:border-primary/40 dark:bg-primary/10 dark:text-primary"
          }
        >
          <GitMerge className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex-1">{b.text}</div>
          {b.cta && (
            <button
              type="button"
              onClick={b.cta.onClick}
              className="shrink-0 rounded-sm border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-900/40"
            >
              {b.cta.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ============ 本 commit 改动文件折叠 section(任务 #2) ============
//
// 默认折叠;展开后并发拉 changed-files 与 ai-lines,按 path 索引出每文件的 AI 行数。
// 点击文件行 → 跳 Blame 锁定到该 sha(经 router query `?sha=<sha>` 传给 Blame 页)。
function ChangedFilesSection({ sha }: { sha: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // 默认折叠:不展开时不发起后端请求,省一次子进程开销
  const changedQ = useQuery<ChangedFilesResult>({
    queryKey: ["changed_files", sha],
    queryFn: () => listChangedFilesInCommit(sha),
    enabled: open,
    staleTime: 60_000,
  });

  // AI 行查询与 changed files 解耦:有 commit 但无 ai notes 时也能列改动文件
  const aiLinesQ = useQuery<AiLinesResult>({
    queryKey: ["ai_lines_in_commit", sha],
    queryFn: () => listAiLinesInCommit(sha),
    enabled: open,
    staleTime: 60_000,
  });

  // 索引:file path → AI 行数(同文件多段累加)。降级 / 失败 → 空 Map(UI 静默不报错)。
  const aiLinesByFile = useMemo(() => {
    const m = new Map<string, number>();
    if (aiLinesQ.data?.status === "ok") {
      for (const ref of aiLinesQ.data.lines) {
        const count = ref.line_end - ref.line_start + 1;
        m.set(ref.file, (m.get(ref.file) ?? 0) + count);
      }
    }
    return m;
  }, [aiLinesQ.data]);

  // 第一个有 AI 行的文件:用作"展开后默认跳转目标"的回退线索(本组件不主动跳)
  // 此处仅为索引可用性,后续按钮点击单文件时用各自 path

  const jumpToBlame = (file: string, line?: number) => {
    // 路径:#/blame/<encoded-path>(可选 /L<a>-<b>)?sha=<sha>
    const params = buildBlameUrlParams(file, line ? [line, line] : null);
    router.navigate("blame", params, { sha });
  };

  return (
    <section className="rounded-lg border border-border bg-card shadow-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-semibold text-foreground hover:bg-slate-50 dark:hover:bg-slate-800/60"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <span>{t("changedFiles.title")}</span>
        {open && changedQ.data?.status === "ok" && (
          <span className="ml-2 rounded-sm bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {changedQ.data.files.length}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3">
          <ChangedFilesBody
            changedQ={changedQ}
            aiLinesByFile={aiLinesByFile}
            onJump={jumpToBlame}
          />
        </div>
      )}
    </section>
  );
}

function ChangedFilesBody({
  changedQ,
  aiLinesByFile,
  onJump,
}: {
  changedQ: ReturnType<typeof useQuery<ChangedFilesResult>>;
  aiLinesByFile: Map<string, number>;
  onJump: (file: string, line?: number) => void;
}) {
  const { t } = useTranslation();
  if (changedQ.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("changedFiles.loading")}
      </div>
    );
  }
  if (changedQ.isError) {
    return (
      <div className="text-xs text-red-600 dark:text-red-400">
        {t("changedFiles.failedPrefix")}:{(changedQ.error as Error).message}
      </div>
    );
  }
  const data = changedQ.data;
  if (!data) return null;
  if (data.status === "degraded") {
    if (data.reason.kind === "invalid_sha") {
      return <div className="text-xs text-muted-foreground">{t("changedFiles.invalidSha")}</div>;
    }
    // repo_missing:整页已经走 degraded 不会到这,保险给个提示
    return (
      <div className="text-xs text-muted-foreground">{t("stats.degraded.repoMissing.title")}</div>
    );
  }
  if (data.files.length === 0) {
    return <div className="text-xs text-muted-foreground">{t("changedFiles.empty")}</div>;
  }
  // status 字符 → 中文标签(changedFiles.status 是 returnObjects map)
  const statusLabelMap = t("changedFiles.status", { returnObjects: true }) as Record<
    string,
    string
  >;
  return (
    <ul className="space-y-1 text-xs">
      {data.files.map((f) => {
        const aiCount = aiLinesByFile.get(f.path) ?? 0;
        const statusLabel = statusLabelMap[f.status] ?? f.status;
        // 删除的文件:对应路径在当前 ref 下不存在,Blame 跳过去会 file_not_in_head → 显示但禁用
        const disabled = f.status === "D";
        return (
          <li key={`${f.status}:${f.path}`}>
            <button
              type="button"
              onClick={() => !disabled && onJump(f.path)}
              disabled={disabled}
              title={disabled ? "已删除文件,无法在 Blame 中查看" : t("changedFiles.jumpBlameTitle")}
              className="group flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-slate-800/60"
            >
              <StatusBadge status={f.status} label={statusLabel} />
              <code className="flex-1 truncate font-mono text-foreground/90 group-hover:text-foreground">
                {f.path}
              </code>
              {aiCount > 0 && (
                <span className="shrink-0 rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary ring-1 ring-inset ring-ring dark:bg-primary/10 dark:text-primary dark:ring-ring">
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

/** git diff status 字符 → 色块。A/M/D/R/C/T/U/X/B 各自一种 tone,未知字符退化到 slate。 */
function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone: Record<string, string> = {
    A: "bg-emerald-100 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800",
    M: "bg-amber-100 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800",
    D: "bg-rose-100 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800",
    R: "bg-purple-100 text-purple-700 ring-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:ring-purple-800",
    C: "bg-primary/10 text-primary ring-primary/30",
  };
  const cls =
    tone[status] ??
    "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700";
  return (
    <span
      className={`inline-flex w-[42px] shrink-0 items-center justify-center rounded-sm px-1 py-0.5 text-[10px] font-medium ring-1 ring-inset ${cls}`}
      title={`${status} · ${label}`}
    >
      {label}
    </span>
  );
}

// ============ 4 张指标卡(3 原始 + 1 派生) ============
//
// 一行 4 卡:人工新增 / 未归因 / AI 归属 / AI 占比。删除原因见 src/lib/formulas.ts MetricId 注释。

function MetricsRow({ view, rates }: { view: StatsView; rates: ReturnType<typeof deriveRates> }) {
  const items: Array<{ id: MetricId; display: string; subline?: string }> = [
    {
      id: "human_additions",
      display: formatInt(view.stats.human_additions),
      subline: "本机人工敲入",
    },
    {
      id: "unknown_additions",
      display: formatInt(view.stats.unknown_additions),
      subline: "hook 未捕获 / 外部脚本",
    },
    {
      id: "ai_additions",
      display: formatInt(view.stats.ai_additions),
      subline: "AI agent 写入",
    },
    {
      id: "ai_share",
      display: formatPercent(rates.ai_share),
      subline:
        view.total_additions === 0
          ? "本 commit 无新增行"
          : `AI / 总新增 ${formatInt(view.total_additions)}`,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((r) => (
        <MetricCardCell key={r.id} metricId={r.id} display={r.display} subline={r.subline} />
      ))}
    </div>
  );
}

function MetricCardCell({
  metricId,
  display,
  subline,
}: {
  metricId: MetricId;
  display: string;
  subline?: string;
}) {
  const meta = METRICS[metricId];
  // Stats 一行 4 卡比 Dashboard 密集 → 主数字 28px(比 Dashboard 36px 收窄),
  // subline 11px;hover 高亮 border 与 Dashboard 一致。
  return (
    <Card padding="sm" interactive className="flex min-h-[112px] flex-col justify-between">
      <div className="flex items-start justify-between gap-1">
        <div className="text-[11px] font-medium text-muted-foreground">{meta.title}</div>
        <FormulaPopover metricId={metricId} />
      </div>
      <div className="mt-1 font-mono text-[28px] font-bold leading-tight tabular-nums text-foreground">
        {display}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{subline ?? ""}</div>
    </Card>
  );
}

// ============ Tool/Model breakdown 表 ============

function ToolModelTable({ breakdown }: { breakdown: Record<string, ToolModelStats> }) {
  const entries = useMemo(() => Object.entries(breakdown), [breakdown]);
  return (
    <Card
      title="工具 / 模型分布"
      actions={<FormulaPopover metricId="tool_model_breakdown" />}
      padding="md"
    >
      {entries.length === 0 ? (
        <div className="text-xs text-slate-400">
          无 tool/model 数据(本 commit 无 AI 桶 ⇒ breakdown 为空)
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[360px] text-xs">
            <thead className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:border-border">
              <tr>
                <th className="sticky left-0 bg-white py-2 pr-4 font-medium dark:bg-card">
                  tool::model
                </th>
                <th className="py-2 pr-4 font-medium">AI 行数</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([k, v]) => (
                <tr key={k} className="border-b border-slate-100 last:border-0 dark:border-border">
                  <td className="sticky left-0 bg-white py-2 pr-4 font-mono dark:bg-card">{k}</td>
                  <td className="py-2 pr-4 font-mono">{formatInt(v.ai_additions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ============ git-ai show <sha> 原文 Dialog(P11-D) ============

const NO_AUTHORSHIP_MARKER = "No authorship data found for this revision";

/**
 * 上游 git-ai show 的输出格式:`<JSON metadata>\n---\n<attestations 段(file/line ranges)>`。
 * 见 git-ai/src\authorship\authorship_log_serialization.rs。
 * 分段渲染:JSON 用语法高亮风格(纯 CSS 高亮 key 颜色不做,先保 monospace),
 *           attestations 段保留缩进与原文,各自独立可滚 + 各自一颗复制按钮。
 */
function splitShowRaw(raw: string): { json: string; attestations: string | null } {
  const idx = raw.indexOf("\n---\n");
  if (idx < 0) return { json: raw, attestations: null };
  return { json: raw.slice(0, idx), attestations: raw.slice(idx + 5) };
}

function ShowRawDialog({ sha, onClose }: { sha: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const open = sha !== null;
  const showQ = useQuery<ShowRawResult>({
    queryKey: ["show_raw", sha],
    queryFn: () => getShowRaw(sha as string),
    enabled: open,
    staleTime: 30_000,
  });

  // degraded 走 toast,不渲染 Dialog 体内 banner——保持和 SyncNotes / EffectiveIgnore 一致的交互
  useEffect(() => {
    if (!open) return;
    const data = showQ.data;
    if (data?.status === "degraded") {
      toast.error(
        data.reason.kind === "repo_missing"
          ? t("showRaw.degradedRepoMissing")
          : t("showRaw.degradedGitAiMissing"),
      );
      onClose();
    }
  }, [open, showQ.data, onClose, t]);

  const copyM = useMutation({
    mutationFn: async (text: string) => {
      await navigator.clipboard.writeText(text);
    },
    onSuccess: () => toast.success(t("showRaw.copiedToast")),
    onError: (e) => toast.error("复制失败", { description: (e as Error).message }),
  });

  const payload = showQ.data?.status === "ok" ? showQ.data.payload : null;
  const raw = payload?.raw ?? "";
  const isEmpty = raw.trim() === NO_AUTHORSHIP_MARKER;
  const sections = useMemo(() => (raw && !isEmpty ? splitShowRaw(raw) : null), [raw, isEmpty]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title={sha ? t("showRaw.dialogTitleTemplate", { sha: sha.slice(0, 7) }) : ""}
      description={t("showRaw.dialogDescription")}
      size="xl"
      footer={
        <>
          <button
            type="button"
            onClick={() => copyM.mutate(raw)}
            disabled={!payload || isEmpty || copyM.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:hover:bg-slate-800"
          >
            {copyM.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {t("showRaw.copyButton")}(全文)
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            关闭
          </button>
        </>
      }
    >
      {showQ.isLoading && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在调 git-ai show…
        </div>
      )}
      {showQ.isError && (
        <p className="text-xs text-rose-600 dark:text-rose-400">
          {t("showRaw.loadFailed")}:{(showQ.error as Error).message}
        </p>
      )}
      {payload && isEmpty && <p className="text-xs text-slate-500">{t("showRaw.empty")}</p>}
      {payload && !isEmpty && sections && (
        <div className="space-y-3">
          <RawSection
            label="JSON 元数据"
            body={sections.json}
            onCopy={(s) => copyM.mutate(s)}
            copyPending={copyM.isPending}
          />
          {sections.attestations !== null && (
            <RawSection
              label="Attestations(文件 / 行号归因)"
              body={sections.attestations}
              onCopy={(s) => copyM.mutate(s)}
              copyPending={copyM.isPending}
            />
          )}
        </div>
      )}
    </Dialog>
  );
}

function RawSection({
  label,
  body,
  onCopy,
  copyPending,
}: {
  label: string;
  body: string;
  onCopy: (s: string) => void;
  copyPending: boolean;
}) {
  return (
    <section className="rounded-md border border-border">
      <header className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 dark:border-border dark:bg-card dark:text-slate-300">
        <span>{label}</span>
        <button
          type="button"
          onClick={() => onCopy(body)}
          disabled={copyPending}
          className="inline-flex items-center gap-1 rounded-sm p-0.5 text-slate-500 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-50 dark:hover:bg-slate-700 dark:hover:text-slate-200"
          title={`复制${label}`}
        >
          <Copy className="h-3 w-3" />
        </button>
      </header>
      <pre className="max-h-[60vh] overflow-auto whitespace-pre rounded-b-md bg-white p-3 font-mono text-xs leading-relaxed text-slate-800 dark:bg-background dark:text-slate-200">
        {body}
      </pre>
    </section>
  );
}
