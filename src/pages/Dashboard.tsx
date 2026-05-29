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
  Eye,
  FolderOpen,
  ListTodo,
  Loader2,
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
import { TimeRangePicker } from "../components/TimeRangePicker";
import { WorkingDirSummary } from "../components/WorkingDirSummary";
import { axisDefaultProps, CHART_COLORS } from "../components/charts/theme";
import { currentRepo, getHistory, getRangeSummary } from "../lib/api";
import { formatInt, formatPercent, formatRelativeFromNow } from "../lib/formulas";
import { rangeKey } from "../lib/queryKeys";
import type {
  DailyBucket,
  HistoryPayload,
  HistoryResult,
  PerCommitStat,
  RangeAuthorshipStatsData,
  RangeSummaryResult,
  TimeRange,
} from "../lib/types";
import { useRouter } from "../router";

/** dashboard 缓存过期时间(秒),对齐后端 SQLite 缓存策略。 */
const DASHBOARD_STALE_TIME_SECONDS = 30;
const STALE_TIME_MS = DASHBOARD_STALE_TIME_SECONDS * 1000;
/**
 * hook 覆盖率 query 的 staleTime —— range 聚合固有耗时长(可达 50s+),且仓库级数据变化慢,
 * 用 5min 避免切窗口/刷新时频繁触发重算。比主体 30s 缓存长一个量级。
 */
const RANGE_SUMMARY_STALE_TIME_MS = 5 * 60 * 1000;
const DEFAULT_RANGE: TimeRange = { kind: "this_week" };
/** Recent commits 表格上限 — 超过的 commit 提示有"更多"。 */
const RECENT_LIMIT = 12;

export default function DashboardPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const qc = useQueryClient();
  const [range, setRange] = useState<TimeRange>(DEFAULT_RANGE);
  const [now, setNow] = useState(Date.now());

  // 当前仓库 path —— 进 queryKey 防"切仓库串数据"(评审 B bug A)。
  // null = 未选仓库,Query 仍跑,后端会返 degraded.repo_missing。
  const repoQ = useQuery({
    queryKey: ["current_repo_path"],
    queryFn: () => currentRepo(),
    staleTime: STALE_TIME_MS,
  });
  const repoPath = repoQ.data?.path ?? null;
  const repoName = repoQ.data?.name ?? null;

  const historyQ = useQuery<HistoryResult>({
    queryKey: ["history", repoPath, rangeKey(range)],
    queryFn: () => getHistory(range),
    staleTime: STALE_TIME_MS,
    // keepPreviousData,但**仅在同一 repoPath 内**生效 —— 切窗口不闪烁,切仓库立即清空。
    // 不加 repoPath 判断时,切仓后会把上一仓库的曲线短暂喂给新仓库 UI,数字不对很扎眼。
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === repoPath ? prev : undefined),
  });

  // 环比基准:上一同长度窗口。仅在主 query 拿到 payload 后再请求,避免空窗口 / degraded 时白白多打一次。
  const prevRange = useMemo(() => derivePrevRange(range), [range]);
  const prevHistoryQ = useQuery<HistoryResult>({
    queryKey: ["history_prev", repoPath, rangeKey(prevRange)],
    queryFn: () => getHistory(prevRange),
    enabled: historyQ.data?.status === "ok",
    staleTime: STALE_TIME_MS,
  });

  // hook 覆盖率独立 query:固有耗时长(可达 50s+),与主体解耦 —— 它的 loading / error /
  // degraded 只影响覆盖率卡 + 缺 hook 列表,绝不连累 AI 占比 / 趋势图 / 提交表的即时渲染。
  // 仅当主 query 拿到非空窗口后才请求,避免空窗口 / degraded 时白白多打一次。
  const windowHasCommits =
    historyQ.data?.status === "ok" && historyQ.data.payload.total_commits_in_window > 0;
  const rangeSummaryQ = useQuery<RangeSummaryResult>({
    queryKey: ["range_summary", repoPath, rangeKey(range)],
    queryFn: () => getRangeSummary(range),
    enabled: windowHasCommits,
    staleTime: RANGE_SUMMARY_STALE_TIME_MS,
    // range stats 固有耗时长(可达 50s+),自动重试只会让用户白等双倍时间;
    // 覆盖率卡自带手动「重试」按钮,失败交给用户主动触发。对齐 useSetupStatus 慢 query 的 retry:false。
    retry: false,
    // 守卫同时比对 repoPath(queryKey[1])与 rangeKey(queryKey[2]):
    // 覆盖率/缺-hook 列表是 range 强相关精确值,切时间窗口时绝不能把上一窗口的值当占位,
    // 否则会短暂显示不属于当前 range 的"9/12"。仅同仓库 + 同窗口才保留占位。
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[1] === repoPath && prevQuery?.queryKey[2] === rangeKey(range)
        ? prev
        : undefined,
  });

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
    qc.invalidateQueries({ queryKey: ["history", repoPath, rangeKey(range)] });
    qc.invalidateQueries({ queryKey: ["history_prev", repoPath, rangeKey(prevRange)] });
    qc.invalidateQueries({ queryKey: ["range_summary", repoPath, rangeKey(range)] });
    qc.invalidateQueries({ queryKey: ["current_repo_path"] });
  };

  // ===== degraded =====
  // 缺仓库 / 缺 git-ai 正是 onboarding 最该出现的时刻:在空态上方叠一张引导卡,
  // 用 Setup 容器收口环境配置,而非直接把用户甩去单页 repo/install。
  if (historyQ.data?.status === "degraded") {
    const kind = historyQ.data.reason.kind;
    const keyPrefix =
      kind === "repo_missing"
        ? "dashboard.degraded.repoMissing"
        : "dashboard.degraded.gitAiMissing";
    return (
      <div className="mx-auto max-w-[1100px] space-y-6 px-8 py-8">
        <OnboardingCard onNavigate={(r) => router.navigate(r)} />
        <EmptyState
          Icon={kind === "repo_missing" ? FolderOpen : Activity}
          title={t(`${keyPrefix}.title`)}
          description={t(`${keyPrefix}.description`)}
          ctaLabel={t(`${keyPrefix}.cta`)}
          onCta={() => router.navigate(kind === "repo_missing" ? "repo" : "install")}
        />
      </div>
    );
  }

  if (historyQ.isLoading && !historyQ.data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在聚合历史 stats…
      </div>
    );
  }

  if (historyQ.isError) {
    return (
      <div className="p-8">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          聚合失败:{(historyQ.error as Error).message}
        </div>
      </div>
    );
  }

  const payload: HistoryPayload | null =
    historyQ.data?.status === "ok" ? historyQ.data.payload : null;
  if (!payload) return null;

  const prevPayload: HistoryPayload | null =
    prevHistoryQ.data?.status === "ok" ? prevHistoryQ.data.payload : null;

  const aiShareCurrent = computeWindowAiShare(payload.per_commit);
  const aiSharePrev = prevPayload ? computeWindowAiShare(prevPayload.per_commit) : null;
  const aiShareDelta =
    aiShareCurrent != null && aiSharePrev != null ? aiShareCurrent - aiSharePrev : null;

  const windowAiTotal = payload.per_commit.reduce((acc, c) => acc + c.stats.ai_additions, 0);

  // hook 覆盖率视图模型:由独立的 rangeSummaryQ 驱动。区分 loading / error / 数据三态,
  // 让覆盖率卡自己显示转圈 / 重试,不影响整页其它指标。
  const rangeSummaryData =
    rangeSummaryQ.data?.status === "ok" ? rangeSummaryQ.data.range_summary : null;
  const authorshipStats = rangeSummaryData?.authorship_stats ?? null;
  const hookCoverage =
    authorshipStats && authorshipStats.total_commits > 0
      ? authorshipStats.commits_with_authorship / authorshipStats.total_commits
      : null;
  const hookCoverageDetail = authorshipStats
    ? `${authorshipStats.commits_with_authorship} / ${authorshipStats.total_commits}`
    : null;

  return (
    <div className="mx-auto max-w-[1100px] space-y-10 px-8 py-8 animate-in fade-in duration-200">
      <Header
        repoName={repoName}
        range={range}
        onChangeRange={setRange}
        isFetching={historyQ.isFetching || prevHistoryQ.isFetching}
        onRefresh={refresh}
      />

      <OnboardingCard onNavigate={(r) => router.navigate(r)} />

      {payload.failed_shas.length > 0 && (
        <InlineBanner
          kind="warn"
          text={t("dashboard.failedHint", { n: payload.failed_shas.length })}
        />
      )}
      {payload.truncated && (
        <InlineBanner kind="warn" text={t("dashboard.truncatedHint", { cap: 500 })} />
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
            hookCoverage={hookCoverage}
            hookCoverageDetail={hookCoverageDetail}
            hookCoverageLoading={rangeSummaryQ.isLoading}
            hookCoverageError={
              rangeSummaryQ.isError ? (rangeSummaryQ.error as Error).message : null
            }
            onRetryHookCoverage={() => rangeSummaryQ.refetch()}
            onJumpHooks={() => router.navigate("hooks")}
          />

          <WindowAiChart daily={payload.daily_buckets} />

          <RecentCommitsTable
            commits={payload.per_commit}
            onPickSha={(sha) => router.navigate("stats", sha)}
          />

          {authorshipStats && <MissingHookList payload={authorshipStats} />}
        </>
      )}

      <WorkingDirSummary repoPath={repoPath} jumpTo="stats" refetchMs={10_000} />

      <RawDataLinks onViewCheckpoints={() => router.navigate("checkpoints")} />

      <Footnote
        fetchedAt={historyQ.dataUpdatedAt}
        now={now}
        cacheHits={payload.cache_hits}
        totalInWindow={payload.total_commits_in_window}
        cachedRepoTotal={payload.cached_repo_total}
      />
    </div>
  );
}

// ============ Header ============

function Header({
  repoName,
  range,
  onChangeRange,
  isFetching,
  onRefresh,
}: {
  repoName: string | null;
  range: TimeRange;
  onChangeRange: (next: TimeRange) => void;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {repoName ? (
            <span className="truncate">{repoName}</span>
          ) : (
            <span className="italic">未选仓库</span>
          )}
          <span className="mx-1.5 text-muted-foreground/40">·</span>
          本机解析,不上传
        </p>
      </div>
      <div className="flex items-center gap-2">
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
  hookCoverage,
  hookCoverageDetail,
  hookCoverageLoading,
  hookCoverageError,
  onRetryHookCoverage,
  onJumpHooks,
}: {
  aiShare: number | null;
  aiShareDelta: number | null;
  windowAiTotal: number;
  commitCount: number;
  hookCoverage: number | null;
  hookCoverageDetail: string | null;
  hookCoverageLoading: boolean;
  hookCoverageError: string | null;
  onRetryHookCoverage: () => void;
  onJumpHooks: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="grid grid-cols-1 gap-x-12 gap-y-8 md:grid-cols-[1.4fr_1fr_1fr]">
      <HeroKpi
        label={t("dashboard.metricTitles.headAiRate")}
        value={formatPercent(aiShare)}
        delta={aiShareDelta}
        deltaSuffix="vs 上一同长度窗口"
        formulaId="ai_share"
      />
      <SecondaryKpi
        label={t("dashboard.metricTitles.windowAiTotal")}
        value={formatInt(windowAiTotal)}
        unit="行"
        caption={`窗口含 ${formatInt(commitCount)} 个 commit`}
        formulaId="window_ai_total"
      />
      <HookCoverageKpi
        hookCoverage={hookCoverage}
        hookCoverageDetail={hookCoverageDetail}
        loading={hookCoverageLoading}
        error={hookCoverageError}
        onRetry={onRetryHookCoverage}
        onJumpHooks={onJumpHooks}
      />
    </section>
  );
}

/**
 * hook 覆盖率次级 KPI —— 由独立 query 驱动,所以单独成组件处理它自己的三态:
 * - loading:数字位转圈(range 聚合慢,可达 50s+)
 * - error:显示"失败"+ 内联重试,**只**影响本卡
 * - 数据:与其它 SecondaryKpi 同款,可点跳 Hooks 页
 */
function HookCoverageKpi({
  hookCoverage,
  hookCoverageDetail,
  loading,
  error,
  onRetry,
  onJumpHooks,
}: {
  hookCoverage: number | null;
  hookCoverageDetail: string | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onJumpHooks: () => void;
}) {
  const { t } = useTranslation();
  // 数据未到位之前(loading / error)不可点跳 Hooks;有数据后整卡可点。
  if (loading) {
    return (
      <div className="flex flex-col gap-2 text-left">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("dashboard.metricTitles.hookCoverage")}
          </span>
          <FormulaPopover metricId="hook_coverage_rate" />
        </div>
        <div className="flex items-center gap-2 font-mono text-3xl font-light leading-none text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
        <p className="text-xs text-muted-foreground">正在采集范围聚合指标…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col gap-2 text-left">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("dashboard.metricTitles.hookCoverage")}
          </span>
          <FormulaPopover metricId="hook_coverage_rate" />
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-3xl font-light leading-none tabular-nums text-muted-foreground">
            —
          </span>
        </div>
        <button
          type="button"
          onClick={onRetry}
          title={error}
          className="inline-flex items-center gap-1 self-start rounded text-xs text-amber-700 transition-colors hover:text-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-300"
        >
          <RefreshCw className="h-3 w-3" />
          采集失败,点此重试
        </button>
      </div>
    );
  }
  return (
    <SecondaryKpi
      label={t("dashboard.metricTitles.hookCoverage")}
      value={formatPercent(hookCoverage)}
      caption={hookCoverageDetail ? `${hookCoverageDetail} commit 含 hook` : "—"}
      formulaId="hook_coverage_rate"
      onClick={onJumpHooks}
      ariaLabel="跳到 Hooks 页"
    />
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
function WindowAiChart({ daily }: { daily: DailyBucket[] }) {
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
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-foreground">每日 AI 行数</h2>
        <span className="text-[10px] text-muted-foreground">human / unknown 见 tooltip</span>
      </div>
      {allZero ? (
        <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
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
              <XAxis dataKey="date" {...axisDefaultProps} />
              <YAxis {...axisDefaultProps} width={32} />
              <RTooltip
                cursor={{ stroke: CHART_COLORS.grid, strokeWidth: 1 }}
                content={<MinimalTooltip />}
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

/** 自定义 tooltip:三行,date 顶,3 桶下方,等宽对齐;沿用 popover 主题色。 */
function MinimalTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayloadItem[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-sm">
      <div className="font-mono text-[11px] text-muted-foreground">{d.date}</div>
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
  onPickSha,
}: {
  commits: PerCommitStat[];
  onPickSha: (sha: string) => void;
}) {
  // 后端 per_commit 已按 authored_at 倒序;这里只取头 RECENT_LIMIT 条
  const visible = commits.slice(0, RECENT_LIMIT);
  const more = Math.max(0, commits.length - visible.length);
  return (
    <section className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-foreground">最近 commit</h2>
        <span className="text-[10px] text-muted-foreground">点击进入 commit 详情</span>
      </div>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="w-[88px] px-3 py-2 text-left font-medium">SHA</th>
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
                  key={c.sha}
                  onClick={() => onPickSha(c.sha)}
                  className="group cursor-pointer border-t border-border/60 transition-colors duration-150 hover:bg-primary/5 first:border-t-0"
                >
                  <td className="px-3 py-2 font-mono text-[11px] tabular-nums text-primary group-hover:underline">
                    {c.short}
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

function totalAdditions(c: PerCommitStat): number {
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
 * 颜色仍走 amber(警示语义),但去掉背景大色块、改为 border-l 强调条。
 */
function InlineBanner({ kind, text }: { kind: "warn"; text: string }) {
  const tone =
    kind === "warn"
      ? "border-l-amber-500 text-amber-700 dark:text-amber-300"
      : "border-l-border text-foreground";
  return (
    <div
      className={`flex items-start gap-2 border-l-2 ${tone} pl-3 text-xs animate-in fade-in duration-200`}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

// ============ 缺 hook 的 commit 列表 ============

function MissingHookList({ payload }: { payload: RangeAuthorshipStatsData }) {
  const router = useRouter();
  const missing = payload.commits_without_authorship_with_authors;
  if (missing.length === 0) return null;
  const PREVIEW = 8;
  return (
    <section className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-foreground">缺 hook 的 commit</h2>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {missing.length} / {payload.total_commits}
        </span>
      </div>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-border">
        {missing.slice(0, PREVIEW).map(([sha, author]) => (
          <li
            key={sha}
            className="flex items-center justify-between gap-2 px-3 py-2 text-xs transition-colors duration-150 hover:bg-muted/40"
          >
            <button
              type="button"
              onClick={() => router.navigate("stats", sha)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={`查看 ${sha.slice(0, 7)} 的 stats`}
            >
              <code className="font-mono text-[11px] tabular-nums text-foreground">
                {sha.slice(0, 7)}
              </code>
              <span className="truncate text-muted-foreground">{author}</span>
            </button>
            <button
              type="button"
              onClick={() => router.navigate("blame", undefined, { sha })}
              title={`在 Blame 中查看 ${sha.slice(0, 7)} 的代码`}
              aria-label="在 Blame 中查看代码"
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {missing.length > PREVIEW && (
        <p className="text-[11px] text-muted-foreground">
          …还有 <span className="font-mono tabular-nums">{missing.length - PREVIEW}</span> 个 — 去
          People 页按作者聚合查看。
        </p>
      )}
    </section>
  );
}

// ============ 空窗口 ============

function EmptyWindowCard({ range, onWiden }: { range: TimeRange; onWiden: () => void }) {
  const { t } = useTranslation();
  const label = describeRange(range);
  const alreadyWidest = range.kind === "last_n_days" && range.days >= 90;
  return (
    <div className="rounded-md border border-dashed border-border px-8 py-10 text-center animate-in fade-in duration-200">
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
  cachedRepoTotal,
}: {
  fetchedAt: number;
  now: number;
  cacheHits: number;
  totalInWindow: number;
  cachedRepoTotal: number;
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
        <span className="mx-1.5 opacity-60">·</span>
        本仓库累计 {cachedRepoTotal}
      </div>
    </div>
  );
}

// ============ 派生 helpers ============

/** 窗口内 AI 占比 = Σ ai_additions / Σ (human + unknown + ai)。total=0 → null。 */
function computeWindowAiShare(per: PerCommitStat[]): number | null {
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
      const now = new Date();
      const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const startOfLastLastMonth = new Date(now.getFullYear(), now.getMonth() - 2, 1).getTime();
      return {
        kind: "custom",
        start_unix_ms: startOfLastLastMonth,
        end_unix_ms: startOfThisMonth - 24 * 60 * 60 * 1000, // 上上月最后一天 00:00
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
