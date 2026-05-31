// Dashboard 页(P5):仓库级 AI 归因聚合。Linear 风极简改版。
//
// # 权威口径
// - 3 桶 total(stats.rs:114):human + unknown + ai
// - 累加视角 vs squash 视角:Dashboard 用累加(逐 commit cache 求和),与时间序列自洽
// - hook 覆盖率(range_authorship.rs:32-40):commits_with_authorship / total_commits
// - SQLite cache 用 notes_oid 失效(stats.rs:388 依赖 git notes)
//
// # 视觉设计
// 整页几乎单色 + 极少 accent;数据数字用 mono + tabular-nums 主导视觉,无大面积色块、无装饰。
// 数据进入用 `animate-in fade-in slide-in-from-bottom-2 duration-200`,hover 用 `transition-colors`。
// 单一 KPI(窗口 AI 占比)+ 与上一同长度窗口的环比 → 取代旧的 3 卡并排。

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  FolderGit2,
  FolderOpen,
  Info,
  ListTodo,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { EmptyState } from "../components/EmptyState";
import { FormulaPopover } from "../components/FormulaPopover";
import { OnboardingCard } from "../components/OnboardingCard";
import { ScopeToggle } from "../components/ScopeToggle";
import { WORKING_DIR_SHA_TOKEN } from "../components/WorkingDirSummary";
import { TimeRangePicker } from "../components/TimeRangePicker";
import { axisDefaultProps, CHART_COLORS } from "../components/charts/theme";
import {
  currentRepo as currentRepoApi,
  getAggregateHistory,
  getAggregateRepos,
  getAggregateWorkingStatus,
  selectRepo,
  setAggregateRepos,
} from "../lib/api";
import { formatInt, formatPercent, formatRelativeFromNow } from "../lib/formulas";
import { rangeKey, reposKey } from "../lib/queryKeys";
import { rollupBuckets, type Granularity } from "../lib/rollup";
import type {
  AggregateHistoryPayload,
  AggregateHistoryResult,
  AggregatePerCommit,
  AggregateWorkingStatusPayload,
  AggregateWorkingStatusResult,
  DailyBucket,
  TimeRange,
} from "../lib/types";
import { useRepoChanged } from "../lib/useRepoChanged";
import { useRouter, type RouteId } from "../router";

/** dashboard 缓存过期时间(秒),对齐后端 SQLite 缓存策略。 */
const DASHBOARD_STALE_TIME_SECONDS = 30;
const STALE_TIME_MS = DASHBOARD_STALE_TIME_SECONDS * 1000;
const DEFAULT_RANGE: TimeRange = { kind: "this_week" };
/** Recent commits 表格上限 — 超过的 commit 提示有"更多"。 */
const RECENT_LIMIT = 12;

export default function DashboardPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const qc = useQueryClient();
  const [range, setRange] = useState<TimeRange>(DEFAULT_RANGE);
  // 「只看我」口径:默认 true(单开发者本机工具的本分),后端逐仓按 git user.email 过滤。
  // 进 queryKey ⇒ 切换会重取(stats 缓存按 sha,与作者无关,故命中快)。
  const [onlyMine, setOnlyMine] = useState(true);
  // 日/周/月 粒度:纯前端对 daily_buckets 做 rollup,**不进 queryKey、不触发取数**(M3/M4)。
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [now, setNow] = useState(Date.now());
  const handleRepoChanged = useRepoChanged();

  // 跨仓聚合数据源 = 用户显式勾选的仓库集(M1 aggregate_repos)。与下钻焦点 current_repo 正交。
  const aggregateReposQ = useQuery({
    queryKey: ["aggregate_repos"],
    queryFn: getAggregateRepos,
    staleTime: STALE_TIME_MS,
  });
  const included = useMemo(
    () => (aggregateReposQ.data ?? []).filter((r) => r.valid).map((r) => r.path),
    [aggregateReposQ.data],
  );
  const reposK = reposKey(included);

  // 当前下钻仓库(与聚合集正交)。用于"搭桥":若你正在看的仓不在 Dashboard 聚合集里,
  // 提示并给一键加入 —— 解决"提交归因页有数据、Dashboard 却没有"的认知断层。
  const currentRepoQ = useQuery({
    queryKey: ["current_repo"],
    queryFn: currentRepoApi,
    staleTime: STALE_TIME_MS,
  });
  const currentPath = currentRepoQ.data?.path ?? null;
  const currentName = currentRepoQ.data?.name ?? null;
  const allAggregatePaths = useMemo(
    () => (aggregateReposQ.data ?? []).map((r) => r.path),
    [aggregateReposQ.data],
  );
  const currentInAggregate =
    !!currentPath && allAggregatePaths.some((p) => p.toLowerCase() === currentPath.toLowerCase());
  const addCurrentToAggregate = () => {
    if (!currentPath) return;
    setAggregateRepos([...allAggregatePaths, currentPath])
      .then(() => {
        qc.invalidateQueries({ queryKey: ["aggregate_repos"] });
        qc.invalidateQueries({ queryKey: ["history_agg"] });
        qc.invalidateQueries({ queryKey: ["working_agg"] });
      })
      .catch(() => {});
  };

  const historyQ = useQuery<AggregateHistoryResult>({
    queryKey: ["history_agg", reposK, rangeKey(range), onlyMine],
    queryFn: () => getAggregateHistory(range, onlyMine),
    enabled: aggregateReposQ.isSuccess && included.length > 0,
    staleTime: STALE_TIME_MS,
    // 切勾选集立即清空占位,切窗口/口径保留(同一 reposKey 才复用)。
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === reposK ? prev : undefined),
  });

  // 环比基准:上一同长度窗口(跨仓集合固定,可推)。仅在主 query 拿到 payload 后再请求。
  const prevRange = useMemo(() => derivePrevRange(range), [range]);
  const prevHistoryQ = useQuery<AggregateHistoryResult>({
    queryKey: ["history_agg", reposK, rangeKey(prevRange), onlyMine],
    queryFn: () => getAggregateHistory(prevRange, onlyMine),
    enabled: historyQ.data?.status === "ok",
    staleTime: STALE_TIME_MS,
  });

  // 「本地未提交」快照:跨选中仓现读 git ai status。只在窗口含"现在"时取(已结束区间配"当前未提交"没意义)。
  // 不进 onlyMine/range queryKey:工作树天然只看我、与窗口正交;reposK 进 key 防切聚合集串数据。
  const showWorking = rangeIncludesNow(range);
  const workingQ = useQuery<AggregateWorkingStatusResult>({
    queryKey: ["working_agg", reposK],
    queryFn: getAggregateWorkingStatus,
    enabled: aggregateReposQ.isSuccess && included.length > 0 && showWorking,
    staleTime: STALE_TIME_MS,
  });
  const workingPayload: AggregateWorkingStatusPayload | null =
    workingQ.data?.status === "ok" ? workingQ.data.payload : null;

  // 5s tick(原 10s 会让"N 秒前"卡顿)+ visibilitychange(后台切回前台立刻更新)。
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    const onVis = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["history_agg", reposK, rangeKey(range), onlyMine] });
    qc.invalidateQueries({ queryKey: ["history_agg", reposK, rangeKey(prevRange), onlyMine] });
    qc.invalidateQueries({ queryKey: ["working_agg", reposK] });
    qc.invalidateQueries({ queryKey: ["aggregate_repos"] });
  };

  // 跨仓 per_commit 带 repo_path:点某条 commit 先把它的仓设为下钻焦点,再跳提交归因页。
  const drillToCommit = (sha: string, repoPath: string) => {
    selectRepo(repoPath)
      .then(() => {
        handleRepoChanged();
        router.navigate("stats", sha);
      })
      .catch(() => router.navigate("stats", sha));
  };
  // 按仓分解表点某仓:设为下钻焦点并进提交归因页(HEAD)。
  const drillToRepo = (repoPath: string) => {
    selectRepo(repoPath)
      .then(() => {
        handleRepoChanged();
        router.navigate("stats");
      })
      .catch(() => router.navigate("stats"));
  };
  // 未提交卡点某仓:设为当前仓并直接进该仓的「工作树未提交」视图。
  const drillToWorking = (repoPath: string) => {
    selectRepo(repoPath)
      .then(() => {
        handleRepoChanged();
        router.navigate("stats", WORKING_DIR_SHA_TOKEN);
      })
      .catch(() => router.navigate("stats", WORKING_DIR_SHA_TOKEN));
  };

  // ===== 未勾选任何仓库:专属空态(引导去 Repo 页勾选)=====
  if (aggregateReposQ.isSuccess && included.length === 0) {
    return <NoReposSelected onNavigate={(r) => router.navigate(r)} />;
  }

  // ===== degraded(git-ai 缺失;no_repos_selected 后端也会返,统一引导去勾选)=====
  if (historyQ.data?.status === "degraded") {
    const kind = historyQ.data.reason.kind;
    if (kind === "no_repos_selected") {
      return <NoReposSelected onNavigate={(r) => router.navigate(r)} />;
    }
    return (
      <div className="mx-auto max-w-[1100px] space-y-6 px-8 py-8">
        <OnboardingCard onNavigate={(r) => router.navigate(r)} />
        <EmptyState
          Icon={Activity}
          title={t("dashboard.degraded.gitAiMissing.title")}
          description={t("dashboard.degraded.gitAiMissing.description")}
          ctaLabel={t("dashboard.degraded.gitAiMissing.cta")}
          onCta={() => router.navigate("install")}
        />
      </div>
    );
  }

  if ((historyQ.isLoading || !aggregateReposQ.isSuccess) && !historyQ.data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t("dashboard.aggregating", { n: included.length })}
      </div>
    );
  }

  if (historyQ.isError) {
    return (
      <div className="p-8">
        <div className="rounded-xl border border-danger bg-danger-muted p-4 text-sm text-danger">
          {t("dashboard.aggregateFailed", { msg: (historyQ.error as Error).message })}
        </div>
      </div>
    );
  }

  const payload: AggregateHistoryPayload | null =
    historyQ.data?.status === "ok" ? historyQ.data.payload : null;
  if (!payload) return null;

  const prevPayload: AggregateHistoryPayload | null =
    prevHistoryQ.data?.status === "ok" ? prevHistoryQ.data.payload : null;

  const aiShareCurrent = computeWindowAiShare(payload.per_commit);
  const aiSharePrev = prevPayload ? computeWindowAiShare(prevPayload.per_commit) : null;
  const aiShareDelta =
    aiShareCurrent != null && aiSharePrev != null ? aiShareCurrent - aiSharePrev : null;

  const windowAiTotal = payload.per_commit.reduce((acc, c) => acc + c.stats.ai_additions, 0);
  // granularity 纯前端 rollup(O(n);**不进 queryKey** ⇒ 切日/周/月不触发取数)。
  const rolledBuckets = rollupBuckets(payload.daily_buckets, granularity);

  return (
    <div className="mx-auto max-w-[1100px] space-y-10 px-8 py-8 animate-in fade-in duration-200">
      <Header
        repoCount={included.length}
        range={range}
        onChangeRange={setRange}
        onlyMine={onlyMine}
        onChangeOnlyMine={setOnlyMine}
        isFetching={historyQ.isFetching || prevHistoryQ.isFetching}
        onRefresh={refresh}
        onManageRepos={() => router.navigate("repo")}
      />

      <OnboardingCard onNavigate={(r) => router.navigate(r)} />

      {/* 搭桥:你当前下钻的仓不在 Dashboard 聚合集时,显式说明 + 一键加入 ——
          否则会困惑"提交归因页(看当前仓)有数据,Dashboard(看聚合集)却没有"。 */}
      {currentName && !currentInAggregate && (
        <CurrentRepoNotInAggregateBanner repoName={currentName} onAdd={addCurrentToAggregate} />
      )}

      {/* 失败诚实性:失败仓 / 截断仓 / 失败 commit 显式列出,聚合数绝不把它们当 0 并入。 */}
      {payload.failed_repos.length > 0 && (
        <InlineBanner
          kind="warn"
          text={t("dashboard.failedReposHint", { n: payload.failed_repos.length })}
        />
      )}
      {payload.truncated_repos.length > 0 && (
        <InlineBanner
          kind="warn"
          text={t("dashboard.truncatedReposHint", { n: payload.truncated_repos.length })}
        />
      )}
      {payload.failed_shas.length > 0 && (
        <InlineBanner
          kind="warn"
          text={t("dashboard.failedHint", { n: payload.failed_shas.length })}
        />
      )}

      {/* 本地未提交快照:与时间窗口正交的"现在"卡,委员会决策为独立呈现、不折进窗口指标。
          只要窗口含"现在"且数据就绪就常驻(有改动显示数字、无改动显示"无未提交改动"),
          以便用户始终能发现该入口;即使本窗口已提交为 0(空窗口)也照常显示。 */}
      {showWorking && workingPayload && (
        <WorkingUncommittedCard payload={workingPayload} onDrill={drillToWorking} />
      )}

      {payload.total_commits_in_window === 0 ? (
        <EmptyWindowCard
          range={range}
          onWiden={() => setRange({ kind: "last_n_days", days: 90 })}
        />
      ) : (
        <>
          <HeroKpiRow
            aiShare={aiShareCurrent}
            aiShareDelta={aiShareDelta}
            windowAiTotal={windowAiTotal}
            commitCount={payload.total_commits_in_window}
          />

          <WindowAiChart
            daily={rolledBuckets}
            granularity={granularity}
            onChangeGranularity={setGranularity}
          />

          <RepoBreakdownTable perCommit={payload.per_commit} onDrill={drillToRepo} />

          <RecentCommitsTable commits={payload.per_commit} onPick={drillToCommit} />
        </>
      )}

      <RawDataLinks onViewCheckpoints={() => router.navigate("checkpoints")} />

      <Footnote
        fetchedAt={historyQ.dataUpdatedAt}
        now={now}
        cacheHits={payload.cache_hits}
        totalInWindow={payload.total_commits_in_window}
      />
    </div>
  );
}

// ============ Header ============

function Header({
  repoCount,
  range,
  onChangeRange,
  onlyMine,
  onChangeOnlyMine,
  isFetching,
  onRefresh,
  onManageRepos,
}: {
  repoCount: number;
  range: TimeRange;
  onChangeRange: (next: TimeRange) => void;
  onlyMine: boolean;
  onChangeOnlyMine: (v: boolean) => void;
  isFetching: boolean;
  onRefresh: () => void;
  onManageRepos: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        {/* 聚合范围做成可点 chip(仓库图标 + chevron),一眼可辨"可点去管理";不再和右上角
            「只看我/全部」开关重复(那条已删),隐私提示退为纯文本 —— 三类信息层次分明。 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={onManageRepos}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-muted"
          >
            <FolderGit2 className="h-3 w-3 text-muted-foreground" />
            {t("dashboard.aggregateScope", { n: repoCount })}
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          </button>
          <span className="text-muted-foreground/40">·</span>
          <span>本机解析,不上传</span>
        </div>
        {/* 数据怎么统计的一行说明:点各指标 / 区块标题旁的 ⓘ 看完整公式与口径。 */}
        <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
          {t("dashboard.dataHint")}
        </p>
      </div>
      {/* 顶部工具栏只留两个正交维度 + 刷新:口径(谁)/ 时间范围(看多长)。
          图表粒度(按天/周/月)从属于时间轴,已下沉到折线图自己的标题行,不在这里争视觉。 */}
      <div className="flex items-center gap-2">
        <ScopeToggle onlyMine={onlyMine} onChange={onChangeOnlyMine} />
        <TimeRangePicker value={range} onChange={onChangeRange} />
        <button
          type="button"
          onClick={onRefresh}
          disabled={isFetching}
          aria-label="立即刷新 Dashboard"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          {isFetching ? t("dashboard.cacheHint.refreshing") : t("dashboard.cacheHint.refreshNow")}
        </button>
      </div>
    </div>
  );
}

/** 日/周/月 segmented control。切换只触发前端 rollup,不重取数。 */
function GranularityToggle({
  value,
  onChange,
}: {
  value: Granularity;
  onChange: (g: Granularity) => void;
}) {
  const { t } = useTranslation();
  const opts: Array<{ k: Granularity; label: string }> = [
    { k: "day", label: t("dashboard.granularity.day") },
    { k: "week", label: t("dashboard.granularity.week") },
    { k: "month", label: t("dashboard.granularity.month") },
  ];
  return (
    <div className="inline-flex h-8 items-center rounded-md border border-border p-0.5 text-xs">
      {opts.map((o) => (
        <button
          key={o.k}
          type="button"
          onClick={() => onChange(o.k)}
          className={`rounded-sm px-2 py-1 transition-colors duration-150 ${
            value === o.k
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 未勾选任何聚合仓库的专属空态:引导去 Repo 页勾选(NoReposSelected degraded 与客户端空集共用)。 */
function NoReposSelected({ onNavigate }: { onNavigate: (r: RouteId) => void }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-[1100px] space-y-6 px-8 py-8">
      <OnboardingCard onNavigate={onNavigate} />
      <EmptyState
        Icon={FolderOpen}
        title={t("dashboard.degraded.noReposSelected.title")}
        description={t("dashboard.degraded.noReposSelected.description")}
        ctaLabel={t("dashboard.degraded.noReposSelected.cta")}
        onCta={() => onNavigate("repo")}
      />
    </div>
  );
}

/** 按仓库分解小计:跨仓聚合下"哪个仓贡献多"。单仓时不渲染(无分解意义)。点行 → 下钻该仓。 */
function RepoBreakdownTable({
  perCommit,
  onDrill,
}: {
  perCommit: AggregatePerCommit[];
  onDrill: (repoPath: string) => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const map = new Map<string, { ai: number; total: number; commits: number }>();
    for (const c of perCommit) {
      const e = map.get(c.repo_path) ?? { ai: 0, total: 0, commits: 0 };
      e.ai += c.stats.ai_additions;
      e.total += c.stats.human_additions + c.stats.unknown_additions + c.stats.ai_additions;
      e.commits += 1;
      map.set(c.repo_path, e);
    }
    return [...map.entries()]
      .map(([repoPath, v]) => ({ repoPath, ...v, share: v.total > 0 ? v.ai / v.total : null }))
      .sort((a, b) => b.ai - a.ai);
  }, [perCommit]);
  if (rows.length <= 1) return null;
  return (
    <section className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <h2 className="flex items-center gap-1 text-sm font-medium text-foreground">
        {t("dashboard.repoBreakdown.title")}
        <FormulaPopover metricId="ai_share" />
      </h2>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">
                {t("dashboard.repoBreakdown.repo")}
              </th>
              <th className="w-[80px] px-3 py-2 text-right font-medium">
                {t("dashboard.repoBreakdown.aiShare")}
              </th>
              <th className="w-[80px] px-3 py-2 text-right font-medium">
                {t("dashboard.repoBreakdown.aiLines")}
              </th>
              <th className="w-[80px] px-3 py-2 text-right font-medium">
                {t("dashboard.repoBreakdown.commits")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.repoPath}
                onClick={() => onDrill(r.repoPath)}
                className="group cursor-pointer border-t border-border/60 transition-colors duration-150 hover:bg-primary/5 first:border-t-0"
              >
                <td className="px-3 py-2 text-foreground group-hover:underline">
                  {repoBasename(r.repoPath)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                  {formatPercent(r.share)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {formatInt(r.ai)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {formatInt(r.commits)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function repoBasename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// ============ 本地未提交快照卡 ============

/**
 * 「本地未提交」独立卡(群贤决策:不折进时间窗口指标,单独呈现)。
 * 跨选中仓聚合 `git ai status`(当前工作树未提交改动),与"已提交·本窗口"主指标物理分开。
 * 点某仓 chip → 进该仓的「工作树未提交」视图。失败仓显式列出、绝不当 0 并入。
 */
function WorkingUncommittedCard({
  payload,
  onDrill,
}: {
  payload: AggregateWorkingStatusPayload;
  onDrill: (repoPath: string) => void;
}) {
  const { t } = useTranslation();
  const total = payload.human_additions + payload.unknown_additions + payload.ai_additions;
  const aiShare = total > 0 ? payload.ai_additions / total : null;
  return (
    <section className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-foreground">{t("dashboard.working.title")}</h2>
        <span className="text-[10px] text-muted-foreground">{t("dashboard.working.hint")}</span>
      </div>
      <div className="rounded-xl border border-dashed border-border p-4">
        {payload.failed_repos.length > 0 && (
          <div className="mb-3 flex items-start gap-2 text-[11px] text-warning-foreground dark:text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span>{t("dashboard.working.failedHint", { n: payload.failed_repos.length })}</span>
          </div>
        )}
        {total === 0 ? (
          <p className="text-xs text-muted-foreground">{t("dashboard.working.allClean")}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t("dashboard.working.aiShare")}
                </div>
                <div className="mt-1 font-mono text-3xl font-light leading-none tabular-nums text-primary">
                  {formatPercent(aiShare)}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t("dashboard.working.aiLines")}
                </div>
                <div className="mt-1 font-mono text-2xl font-light leading-none tabular-nums text-foreground">
                  {formatInt(payload.ai_additions)}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("dashboard.working.scope", { n: payload.repos_with_changes })}
              </p>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {payload.per_repo.map((r) => (
                <button
                  key={r.repo_path}
                  type="button"
                  onClick={() => onDrill(r.repo_path)}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-primary/5 hover:text-foreground"
                >
                  <span className="font-medium text-foreground">{repoBasename(r.repo_path)}</span>
                  <span className="font-mono tabular-nums">AI {formatInt(r.ai_additions)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ============ Hero KPI ============

/**
 * 主指标行:窗口 AI 占比(大数字)+ 两个次级 KPI(AI 总行 / Hook 覆盖率)。
 * 用单 col 大数字 + 2 col 次级,避免"3 卡平铺"的卡片堆视觉。
 */
function HeroKpiRow({
  aiShare,
  aiShareDelta,
  windowAiTotal,
  commitCount,
}: {
  aiShare: number | null;
  aiShareDelta: number | null;
  windowAiTotal: number;
  commitCount: number;
}) {
  const { t } = useTranslation();
  // 跨仓聚合无单一 hook 覆盖率(各仓 git-ai 版本/配置可不同),覆盖率改在单仓下钻视图看(M4)。
  return (
    <section className="grid grid-cols-1 gap-x-12 gap-y-8 md:grid-cols-2">
      <HeroKpi
        label={t("dashboard.metricTitles.headAiRate")}
        value={formatPercent(aiShare)}
        delta={aiShareDelta}
        deltaSuffix={t("dashboard.delta.vsPrevPeriod")}
        formulaId="ai_share"
      />
      <SecondaryKpi
        label={t("dashboard.metricTitles.windowAiTotal")}
        value={formatInt(windowAiTotal)}
        unit="行"
        caption={`窗口含 ${formatInt(commitCount)} 个 commit`}
        formulaId="window_ai_total"
      />
    </section>
  );
}

function HeroKpi({
  label,
  value,
  delta,
  deltaSuffix,
  formulaId,
}: {
  label: string;
  value: string;
  delta: number | null;
  deltaSuffix: string;
  formulaId: Parameters<typeof FormulaPopover>[0]["metricId"];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <FormulaPopover metricId={formulaId} />
      </div>
      <div className="font-mono text-5xl font-light leading-none tabular-nums text-primary">
        {value}
      </div>
      <DeltaPill delta={delta} suffix={deltaSuffix} />
    </div>
  );
}

function SecondaryKpi({
  label,
  value,
  unit,
  caption,
  formulaId,
  onClick,
  ariaLabel,
}: {
  label: string;
  value: string;
  unit?: string;
  caption: string;
  formulaId: Parameters<typeof FormulaPopover>[0]["metricId"];
  onClick?: () => void;
  ariaLabel?: string;
}) {
  // 整个 KPI 单元可选可点(hook coverage 微卡跳 Hooks 页)。
  // 用 button 而非 div+onClick:无障碍键盘焦点白送 + role 已是 button。
  const inner = (
    <div className="flex flex-col gap-2 text-left">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <FormulaPopover metricId={formulaId} />
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-3xl font-light leading-none tabular-nums text-foreground">
          {value}
        </span>
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </div>
      <p className="text-xs text-muted-foreground">{caption}</p>
    </div>
  );
  if (!onClick) return inner;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="group rounded-md outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex flex-col gap-2 text-left">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors group-hover:text-foreground">
            {label}
          </span>
          <FormulaPopover metricId={formulaId} />
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-3xl font-light leading-none tabular-nums text-foreground">
            {value}
          </span>
          {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
        </div>
        <p className="text-xs text-muted-foreground transition-colors group-hover:text-foreground/80">
          {caption}
          <ArrowRight className="ml-1 inline h-3 w-3 align-[-1px] opacity-0 transition-opacity group-hover:opacity-100" />
        </p>
      </div>
    </button>
  );
}

/** 环比胶囊:三角箭头 + 绝对差值百分点。delta 为 null 时显示"—",避免 NaN 进 UI。 */
function DeltaPill({ delta, suffix }: { delta: number | null; suffix: string }) {
  if (delta == null) {
    return (
      <p className="text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">—</span>
        <span className="ml-1">{suffix}</span>
      </p>
    );
  }
  const pct = delta * 100;
  const Icon = pct >= 0 ? ArrowUpRight : ArrowDownRight;
  // 三角颜色是整页唯一允许 saturated tint 的位置(emerald / rose),其余坚守 neutral。
  // 上涨方向不一定"好"(AI 占比涨可能是项目结构变化),所以颜色只表达"方向"不表达"价值"。
  const tone =
    pct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
  const sign = pct >= 0 ? "+" : "";
  return (
    <p className="text-xs text-muted-foreground">
      <span className={`inline-flex items-center font-mono tabular-nums ${tone}`}>
        <Icon className="mr-0.5 h-3 w-3" />
        {sign}
        {pct.toFixed(1)} pp
      </span>
      <span className="ml-1.5">{suffix}</span>
    </p>
  );
}

// ============ 折线图 ============

/**
 * Window AI 折线图:单条线表 AI additions per day。
 *
 * # 取舍
 * 旧版本是堆叠 AreaChart(human / unknown / ai 3 桶),信息量大但视觉很满。
 * Linear 风重点是"trend at a glance",所以这里只画 AI 线,把 human / unknown
 * 数值塞进 tooltip(`<RTooltip />` 自定义 formatter 完成)。
 * grid 几乎不可见,axis 弱化,主线用 currentColor(深色模式自动反相)。
 */
function WindowAiChart({
  daily,
  granularity,
  onChangeGranularity,
}: {
  daily: DailyBucket[];
  granularity: Granularity;
  onChangeGranularity: (g: Granularity) => void;
}) {
  const { t } = useTranslation();
  const data = useMemo(
    () =>
      daily.map((b) => ({
        date: b.date,
        ai: b.ai_additions,
        human: b.human_additions,
        unknown: b.unknown_additions,
      })),
    [daily],
  );
  const allZero = data.length === 0 || data.every((d) => d.ai + d.human + d.unknown === 0);

  return (
    <section className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
      {/* 粒度切换归属于这张图:按天/周/月只改本图的 rollup,放在图标题行才说得通(从属时间轴)。 */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-1 text-sm font-medium text-foreground">
          {granularity === "week"
            ? "每周 AI 行数"
            : granularity === "month"
              ? "每月 AI 行数"
              : "每日 AI 行数"}
          <FormulaPopover metricId="window_ai_total" />
        </h2>
        <GranularityToggle value={granularity} onChange={onChangeGranularity} />
      </div>
      {allZero ? (
        <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground">
          {t("dashboard.chartAllZero")}
        </div>
      ) : (
        // text-primary 让 SVG 内 `stroke="currentColor"` 取品牌蓝(AI 语义色),并自动跟主题翻色
        <div className="h-56 w-full text-primary">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="dash-ai-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" stroke={CHART_COLORS.grid} vertical={false} />
              <XAxis
                dataKey="date"
                {...axisDefaultProps}
                tickFormatter={(v) => formatBucketLabel(String(v), granularity)}
              />
              <YAxis {...axisDefaultProps} width={32} />
              <RTooltip
                cursor={{ stroke: CHART_COLORS.grid, strokeWidth: 1 }}
                content={<MinimalTooltip granularity={granularity} />}
              />
              <Area
                type="monotone"
                dataKey="ai"
                stroke={CHART_COLORS.primary}
                strokeWidth={1.5}
                fill="url(#dash-ai-fill)"
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

interface ChartDatum {
  date: string;
  ai: number;
  human: number;
  unknown: number;
}

interface TooltipPayloadItem {
  payload: ChartDatum;
}

/** 桶键 → X 轴短标签。桶键:day/week = "YYYY-MM-DD"(week 为周一那天),month = "YYYY-MM-01"。
 *  month 显示 "YYYY-MM";day/week 显示 "MM-DD"(配合标题"每周/每日"区分粒度)。 */
function formatBucketLabel(date: string, g: Granularity): string {
  return g === "month" ? date.slice(0, 7) : date.slice(5);
}

/** tooltip 顶部日期:按粒度点明"当周/当月",避免周/月桶的日期被误读成某一天。 */
function formatBucketTooltipDate(date: string, g: Granularity): string {
  if (g === "month") return `${date.slice(0, 7)} 当月`;
  if (g === "week") return `${date.slice(5)} 当周(周一起)`;
  return date;
}

/** 自定义 tooltip:三行,date 顶,3 桶下方,等宽对齐;沿用 popover 主题色。 */
function MinimalTooltip({
  active,
  payload,
  granularity,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  granularity: Granularity;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-sm">
      <div className="font-mono text-[11px] text-muted-foreground">
        {formatBucketTooltipDate(d.date, granularity)}
      </div>
      <div className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums">
        <span className="text-muted-foreground">AI</span>
        <span className="text-right">{formatInt(d.ai)}</span>
        <span className="text-muted-foreground">人工</span>
        <span className="text-right">{formatInt(d.human)}</span>
        <span className="text-muted-foreground">未归因</span>
        <span className="text-right">{formatInt(d.unknown)}</span>
      </div>
    </div>
  );
}

// ============ Recent commits 表 ============

/**
 * 最近 commit 表(替代旧"堆 3 卡"的设计)。
 *
 * 列:sha · 时间 · AI 占比 · AI 行 · 总行。整行可点跳 Stats 详情。
 * hover 用 `bg-muted/40` 微变色,无边框、无 zebra,行间距 + tabular-nums 对齐承担可读性。
 */
function RecentCommitsTable({
  commits,
  onPick,
}: {
  commits: AggregatePerCommit[];
  onPick: (sha: string, repoPath: string) => void;
}) {
  const { t } = useTranslation();
  // 后端 per_commit 已按 authored_at 倒序;这里只取头 RECENT_LIMIT 条
  const visible = commits.slice(0, RECENT_LIMIT);
  const more = Math.max(0, commits.length - visible.length);
  return (
    <section className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-baseline justify-between">
        <h2 className="flex items-center gap-1 text-sm font-medium text-foreground">
          最近 commit
          <FormulaPopover metricId="ai_share" />
        </h2>
        <span className="text-[10px] text-muted-foreground">点击进入 commit 详情</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="w-[88px] px-3 py-2 text-left font-medium">SHA</th>
              <th className="px-3 py-2 text-left font-medium">
                {t("dashboard.recentCommits.repo")}
              </th>
              <th className="px-3 py-2 text-left font-medium">时间</th>
              <th className="w-[80px] px-3 py-2 text-right font-medium">AI 占比</th>
              <th className="w-[80px] px-3 py-2 text-right font-medium">AI 行</th>
              <th className="w-[80px] px-3 py-2 text-right font-medium">总行</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => {
              const total = totalAdditions(c);
              const share = total > 0 ? c.stats.ai_additions / total : null;
              return (
                <tr
                  key={`${c.repo_path}:${c.sha}`}
                  onClick={() => onPick(c.sha, c.repo_path)}
                  className="group cursor-pointer border-t border-border/60 transition-colors duration-150 hover:bg-primary/5 first:border-t-0"
                >
                  <td className="px-3 py-2 font-mono text-[11px] tabular-nums text-primary group-hover:underline">
                    {c.short}
                  </td>
                  <td className="truncate px-3 py-2 text-muted-foreground">
                    {repoBasename(c.repo_path)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatAuthoredAt(c.authored_at)}
                    {c.is_merge && (
                      <span className="ml-1.5 rounded border border-border px-1 text-[10px] uppercase text-muted-foreground">
                        merge
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                    {formatPercent(share)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                    {formatInt(c.stats.ai_additions)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                    {formatInt(total)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {more > 0 && (
        <p className="text-[11px] text-muted-foreground">
          还有 <span className="font-mono tabular-nums">{more}</span> 个 commit 未显示 —
          切换更大时间窗口或在 People / Blame 页深入。
        </p>
      )}
    </section>
  );
}

function totalAdditions(c: AggregatePerCommit): number {
  return c.stats.human_additions + c.stats.unknown_additions + c.stats.ai_additions;
}

/** authored_at ISO → "MM-DD HH:mm"(年份省略,与 Linear / Vercel commit 列表同款)。 */
function formatAuthoredAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

// ============ 内联 banner(警示横条) ============

/**
 * 单行警示横条 — 取代旧的 Card 包裹的 banner。
 * 警示语义由琥珀左强调条(border-l-warning)+ AlertTriangle 图标承载,正文用可读的
 * foreground —— 琥珀做正文在亮色页背景上偏淡不可读(该色系固有约束),故文字走中性高对比色。
 */
function InlineBanner({ kind, text }: { kind: "warn"; text: string }) {
  const tone =
    kind === "warn" ? "border-l-warning text-foreground" : "border-l-border text-foreground";
  return (
    <div
      className={`flex items-start gap-2 border-l-2 ${tone} pl-3 text-xs animate-in fade-in duration-200`}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      <span>{text}</span>
    </div>
  );
}

/** 搭桥条:当前下钻仓不在聚合集时,说明"Dashboard 看的是聚合集"并给一键加入。 */
function CurrentRepoNotInAggregateBanner({
  repoName,
  onAdd,
}: {
  repoName: string;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-xs animate-in fade-in duration-200">
      <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">
        {t("dashboard.currentNotIncluded", { repo: repoName })}
      </span>
      <button
        type="button"
        onClick={onAdd}
        className="ml-auto inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <Plus className="h-3 w-3" /> {t("dashboard.addCurrentToAggregate")}
      </button>
    </div>
  );
}

// ============ 缺 hook 的 commit 列表 ============

// ============ 空窗口 ============

function EmptyWindowCard({ range, onWiden }: { range: TimeRange; onWiden: () => void }) {
  const { t } = useTranslation();
  const label = describeRange(range);
  const alreadyWidest = range.kind === "last_n_days" && range.days >= 90;
  return (
    <div className="rounded-xl border border-dashed border-border px-8 py-10 text-center animate-in fade-in duration-200">
      <div className="text-sm font-medium text-foreground">{t("dashboard.emptyWindow.title")}</div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {t("dashboard.emptyWindow.descriptionTemplate", { rangeLabel: label })}
      </p>
      {!alreadyWidest && (
        <button
          type="button"
          onClick={onWiden}
          className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-muted/60"
        >
          {t("dashboard.emptyWindow.widenCta")}
        </button>
      )}
    </div>
  );
}

// ============ 原始数据深链 ============

/**
 * 原始归因数据入口(IA 重构):Checkpoints 不再占主侧栏顶级菜单,改为这里的深链进入。
 * (原始 git notes 的深链在 Stats 页的「查看原始 notes」按钮,二者互补。)
 * 极弱视觉,只给需要查底层 checkpoint 的高级用户一条可达路径,不抢主体注意力。
 */
function RawDataLinks({ onViewCheckpoints }: { onViewCheckpoints: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-end">
      <button
        type="button"
        onClick={onViewCheckpoints}
        title={t("deepLink.viewCheckpointsHint")}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ListTodo className="h-3.5 w-3.5" />
        {t("deepLink.viewCheckpoints")}
      </button>
    </div>
  );
}

// ============ Footnote ============

/** 页面底部静态信息(刷新时间 / 缓存命中 / 累计 commit 数)。极小字号,不抢主体注意力。 */
function Footnote({
  fetchedAt,
  now,
  cacheHits,
  totalInWindow,
}: {
  fetchedAt: number;
  now: number;
  cacheHits: number;
  totalInWindow: number;
}) {
  const { t } = useTranslation();
  const rel = fetchedAt ? formatRelativeFromNow(fetchedAt, now) : "—";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-[10px] text-muted-foreground">
      <div>
        数据更新于 <span className="font-mono tabular-nums">{rel}</span>
        <span className="mx-1.5">·</span>缓存 {DASHBOARD_STALE_TIME_SECONDS}s
      </div>
      <div className="font-mono tabular-nums">
        {t("dashboard.cacheHint.cachedTemplate", { hits: cacheHits, total: totalInWindow })}
      </div>
    </div>
  );
}

// ============ 派生 helpers ============

/**
 * 窗口是否"含现在"——决定是否显示「本地未提交」卡。
 * today / this_week / this_month / last_n_days 的 end 都是当前时刻 → 含现在;
 * yesterday / last_week / last_month 是已结束区间 → 不含;custom 看 end 是否 ≥ 现在(留 1min 容差)。
 * 给"上周"配一张"当前未提交"卡没有意义,故已结束区间不显示。
 */
function rangeIncludesNow(range: TimeRange): boolean {
  switch (range.kind) {
    case "today":
    case "this_week":
    case "this_month":
    case "last_n_days":
      return true;
    case "yesterday":
    case "last_week":
    case "last_month":
      return false;
    case "custom":
      return range.end_unix_ms >= Date.now() - 60_000;
  }
}

/** 窗口内 AI 占比 = Σ ai_additions / Σ (human + unknown + ai)。total=0 → null。 */
function computeWindowAiShare(per: AggregatePerCommit[]): number | null {
  let ai = 0;
  let total = 0;
  for (const c of per) {
    ai += c.stats.ai_additions;
    total += c.stats.human_additions + c.stats.unknown_additions + c.stats.ai_additions;
  }
  return total > 0 ? ai / total : null;
}

/**
 * 当前 TimeRange → 前一个同长度窗口,用于"环比"计算。
 *
 * - today          → yesterday
 * - yesterday      → 前一天再之前(用 custom 镜像)
 * - this_week      → last_week
 * - last_week      → 再前一周(custom 镜像)
 * - this_month     → last_month
 * - last_month     → 再前一月(custom 镜像)
 * - last_n_days N  → custom: now-2N ~ now-N
 * - custom         → custom: 起点 - 长度 ~ 起点
 */
function derivePrevRange(r: TimeRange): TimeRange {
  switch (r.kind) {
    case "today":
      return { kind: "yesterday" };
    case "this_week":
      return { kind: "last_week" };
    case "this_month":
      return { kind: "last_month" };
    case "yesterday": {
      const end = startOfLocalDay(Date.now()) - 1; // 昨天 23:59:59.999 的前一毫秒
      const start = end - 24 * 60 * 60 * 1000 + 1;
      return { kind: "custom", start_unix_ms: start, end_unix_ms: end };
    }
    case "last_week": {
      const start = startOfThisWeek() - 14 * 24 * 60 * 60 * 1000;
      const end = start + 7 * 24 * 60 * 60 * 1000 - 1;
      return { kind: "custom", start_unix_ms: start, end_unix_ms: end };
    }
    case "last_month": {
      // cur = 上一整月(本月若 5 月 → cur=4 月)。prev 取**再上一整月**(3 月)完整日历月,
      // 与 cur 不重叠、不跨错月,对齐后端 last_month 的 start_of_month 语义(history.rs)。
      const now = new Date();
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(); // cur 起点(4 月 1 日 00:00)
      const startOfLastLastMonth = new Date(now.getFullYear(), now.getMonth() - 2, 1).getTime(); // prev 起点(3 月 1 日 00:00)
      return {
        kind: "custom",
        start_unix_ms: startOfLastLastMonth, // 上上月 1 日 00:00
        end_unix_ms: startOfLastMonth - 1, // 上月 1 日 00:00 前 1ms = 上上月最后一天 23:59:59.999
      };
    }
    case "last_n_days": {
      const n = Math.max(1, r.days);
      const end = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      return {
        kind: "custom",
        start_unix_ms: end - 2 * n * oneDayMs,
        end_unix_ms: end - n * oneDayMs,
      };
    }
    case "custom": {
      const len = r.end_unix_ms - r.start_unix_ms;
      return {
        kind: "custom",
        start_unix_ms: r.start_unix_ms - len,
        end_unix_ms: r.start_unix_ms - 1,
      };
    }
  }
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本周一 00:00 的本地时间戳。 */
function startOfThisWeek(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = 周日
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

/** TimeRange → 中文标签(空窗口提示用)。 */
function describeRange(r: TimeRange): string {
  switch (r.kind) {
    case "today":
      return "今天";
    case "yesterday":
      return "昨天";
    case "this_week":
      return "本周";
    case "last_week":
      return "上周";
    case "this_month":
      return "本月";
    case "last_month":
      return "上月";
    case "last_n_days":
      return `近 ${r.days} 天`;
    case "custom": {
      const fmt = (ms: number) => {
        const d = new Date(ms);
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      };
      return `${fmt(r.start_unix_ms)} ~ ${fmt(r.end_unix_ms)}`;
    }
  }
}
