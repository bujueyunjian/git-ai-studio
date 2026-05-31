// People 页(P12):按 author_email + 时间范围聚合 AI 归因。
//
// # 口径
// - identity_key = author_email.toLowerCase()(不引 mailmap)
// - 时间归属:commit %cI(与 history.rs 一致)
// - AI 占比 = ai_additions / (human + unknown + ai),total=0 时 null,UI 显 "—"
//
// # 与 Dashboard 的关系
// Dashboard 是仓库整体 + 时间序列;People 是同窗口下"按人"的二维表。共享同一 SQLite
// stats_cache(notes_oid + ignore_hash 失效模型),后端命令几乎是 history.rs 的简化版。

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Info,
  Loader2,
  RefreshCw,
  Users,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "../components/EmptyState";
import { ScopeToggle } from "../components/ScopeToggle";
import { TimeRangePicker } from "../components/TimeRangePicker";
import { Card } from "../components/ui/CardPanel";
import { Tooltip } from "../components/ui/TooltipBubble";
import { currentGitUserEmail, currentRepo, getPeopleBreakdown } from "../lib/api";
import { METRICS } from "../lib/formulas";
import { formatInt, formatPercent } from "../lib/formulas";
import { rangeKey } from "../lib/queryKeys";
import type {
  PeopleBreakdownPayload,
  PeopleBreakdownResult,
  PeopleTotals,
  PersonRow,
  TimeRange,
} from "../lib/types";
import { useRouter } from "../router";
import { sortRows, sumRowsToTotals, type SortDir, type SortField } from "./peopleTable";

/** people 缓存过期时间(秒),对齐后端 SQLite 缓存策略。与 Dashboard 共用同一时长。 */
const PEOPLE_STALE_TIME_SECONDS = 30;
const STALE_TIME_MS = PEOPLE_STALE_TIME_SECONDS * 1000;
const DEFAULT_RANGE: TimeRange = { kind: "last_n_days", days: 7 };

export default function PeoplePage() {
  const { t } = useTranslation();
  const router = useRouter();
  const qc = useQueryClient();
  const [range, setRange] = useState<TimeRange>(DEFAULT_RANGE);
  // 「只看我」口径:默认 true(self-first,见 ADR-012)。纯前端按当前 git 用户邮箱过滤行,
  // 切换无需重取(数据已含 author_email)。
  const [onlyMine, setOnlyMine] = useState(true);
  const [sort, setSort] = useState<{ field: SortField; dir: SortDir }>({
    field: "ai_additions",
    dir: "desc",
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 当前仓库 path → 进 queryKey 防"切仓串数据"。
  const repoQ = useQuery({
    queryKey: ["current_repo_path"],
    queryFn: () => currentRepo(),
    staleTime: STALE_TIME_MS,
  });
  const repoPath = repoQ.data?.path ?? null;

  // 当前 git 用户邮箱(后端已 trim + lowercase),用于「只看我」按 identity_key 过滤。
  // 进 queryKey 带 repoPath:切仓后该仓 user.email 可能不同。
  const myEmailQ = useQuery({
    queryKey: ["current_git_user_email", repoPath],
    queryFn: currentGitUserEmail,
    staleTime: STALE_TIME_MS,
  });
  const myEmail = myEmailQ.data ?? null;

  const peopleQ = useQuery<PeopleBreakdownResult>({
    queryKey: ["people", repoPath, rangeKey(range)],
    queryFn: () => getPeopleBreakdown(range),
    staleTime: STALE_TIME_MS,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === repoPath ? prev : undefined),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["people", repoPath, rangeKey(range)] });
    qc.invalidateQueries({ queryKey: ["current_repo_path"] });
  };

  // ===== degraded =====
  if (peopleQ.data?.status === "degraded") {
    const kind = peopleQ.data.reason.kind;
    const seg = kind === "repo_missing" ? "repoMissing" : "gitAiMissing";
    return (
      <EmptyState
        Icon={kind === "repo_missing" ? FolderOpen : Activity}
        title={t(`people.degraded.${seg}.title` as never)}
        description={t(`people.degraded.${seg}.description` as never)}
        ctaLabel={t(`people.degraded.${seg}.cta` as never)}
        onCta={() => router.navigate(kind === "repo_missing" ? "repo" : "install")}
      />
    );
  }

  if (peopleQ.isLoading && !peopleQ.data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在按人聚合 stats…
      </div>
    );
  }

  if (peopleQ.isError) {
    return (
      <div className="p-6">
        <div className="rounded-md border border-danger bg-danger-muted p-4 text-sm text-danger">
          聚合失败:{(peopleQ.error as Error).message}
        </div>
      </div>
    );
  }

  const payload: PeopleBreakdownPayload | null =
    peopleQ.data?.status === "ok" ? peopleQ.data.payload : null;
  if (!payload) return null;

  // 「只看我」:按 identity_key(= author_email.toLowerCase())过滤。无法确定当前用户时
  // (该仓未配置 user.email)不静默放行全部,而是走专属空态引导切「全部」(响亮失败)。
  const cannotIdentifyMe = onlyMine && !myEmail;
  const scopedRows: PersonRow[] =
    onlyMine && myEmail ? payload.rows.filter((r) => r.identity_key === myEmail) : payload.rows;
  // 总览卡总计随展示范围重算:「只看我」时由 scopedRows 求和,「全部」时用后端 grand_total。
  const overviewTotal: PeopleTotals = onlyMine ? sumRowsToTotals(scopedRows) : payload.grand_total;

  const sortedRows = sortRows(scopedRows, sort);

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSort = (field: SortField) => {
    setSort((prev) => {
      if (prev.field === field) {
        return { field, dir: prev.dir === "asc" ? "desc" : "asc" };
      }
      // 第一次点击该列:数值列默认 desc,文本列默认 asc
      const isNumeric = field !== "author_name" && field !== "author_email";
      return { field, dir: isNumeric ? "desc" : "asc" };
    });
  };

  return (
    <div className="space-y-5 p-6">
      <Header
        range={range}
        onChangeRange={setRange}
        onlyMine={onlyMine}
        onChangeOnlyMine={setOnlyMine}
        isFetching={peopleQ.isFetching}
        onRefresh={refresh}
      />

      <CacheBar cacheHits={payload.cache_hits} totalCommits={overviewTotal.commits} />

      {payload.failed_shas.length > 0 && <FailedBanner count={payload.failed_shas.length} />}
      {payload.truncated && <TruncatedBanner />}

      <OverviewCards total={overviewTotal} />

      {cannotIdentifyMe ? (
        <CannotIdentifyMeCard onShowEveryone={() => setOnlyMine(false)} />
      ) : payload.rows.length === 0 ? (
        <EmptyWindowCard />
      ) : scopedRows.length === 0 ? (
        <EmptyMineCard onShowEveryone={() => setOnlyMine(false)} />
      ) : (
        <PeopleTable
          rows={sortedRows}
          sort={sort}
          onToggleSort={toggleSort}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          onJumpToStats={(sha) => router.navigate("stats", sha)}
        />
      )}
    </div>
  );
}

// ============ Header ============

function Header({
  range,
  onChangeRange,
  onlyMine,
  onChangeOnlyMine,
  isFetching,
  onRefresh,
}: {
  range: TimeRange;
  onChangeRange: (next: TimeRange) => void;
  onlyMine: boolean;
  onChangeOnlyMine: (v: boolean) => void;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold inline-flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            {t("people.page.title")}
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("people.page.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ScopeToggle onlyMine={onlyMine} onChange={onChangeOnlyMine} />
          <TimeRangePicker value={range} onChange={onChangeRange} />
          <button
            type="button"
            onClick={onRefresh}
            disabled={isFetching}
            aria-label={t("people.page.refresh")}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground shadow-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            {isFetching ? t("people.page.refreshing") : t("people.page.refresh")}
          </button>
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground">{t("people.page.identityHint")}</div>
    </div>
  );
}

// ============ CacheBar ============

function CacheBar({ cacheHits, totalCommits }: { cacheHits: number; totalCommits: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-1.5 text-[11px] text-muted-foreground">
      <div>缓存 {PEOPLE_STALE_TIME_SECONDS}s · 数据不上传</div>
      <div className="font-mono text-muted-foreground">
        {t("people.page.cachedTemplate", { hits: cacheHits, total: totalCommits })}
      </div>
    </div>
  );
}

function FailedBanner({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-muted p-3 text-xs text-warning-foreground dark:text-warning">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>{t("people.failedHintTemplate", { n: count })}</div>
    </div>
  );
}

function TruncatedBanner() {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-muted p-3 text-xs text-warning-foreground dark:text-warning">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>{t("people.truncatedHintTemplate", { cap: 500 })}</div>
    </div>
  );
}

// ============ 4 总览卡 ============

function OverviewCards({ total }: { total: PeopleBreakdownPayload["grand_total"] }) {
  const { t } = useTranslation();
  const aiShare = total.total_additions > 0 ? total.ai_additions / total.total_additions : null;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        title={t("people.metricTitles.totalCommits")}
        display={formatInt(total.commits)}
      />
      <MetricCard
        title={t("people.metricTitles.totalHuman")}
        display={formatInt(total.human_additions)}
        tone="human"
      />
      <MetricCard
        title={t("people.metricTitles.totalAi")}
        display={formatInt(total.ai_additions)}
        tone="ai"
      />
      <MetricCard
        title={t("people.metricTitles.overallAiRate")}
        display={formatPercent(aiShare)}
        tone="ai"
      />
    </div>
  );
}

function MetricCard({
  title,
  display,
  tone = "neutral",
}: {
  title: string;
  display: string;
  tone?: "ai" | "human" | "neutral";
}) {
  // 主数字 28px(font-bold),与 Stats 指标卡同档;Dashboard 用更大的 36px light 档(密度更低)。
  // 左色条:人工=human 绿、AI/占比=ai 蓝、总提交=neutral 无条,与 Stats/Dashboard 语义统一。
  return (
    <Card
      padding="sm"
      interactive
      tone={tone}
      className="flex min-h-[100px] flex-col justify-between"
    >
      <div className="text-[11px] font-medium text-muted-foreground">{title}</div>
      <div className="mt-1 font-mono text-[28px] font-bold leading-tight tabular-nums text-foreground">
        {display}
      </div>
    </Card>
  );
}

// ============ 主表 ============

function PeopleTable({
  rows,
  sort,
  onToggleSort,
  expanded,
  onToggleExpand,
  onJumpToStats,
}: {
  rows: PersonRow[];
  sort: { field: SortField; dir: SortDir };
  onToggleSort: (f: SortField) => void;
  expanded: Set<string>;
  onToggleExpand: (key: string) => void;
  onJumpToStats: (sha: string) => void;
}) {
  const { t } = useTranslation();
  // PeopleTable:padding=none,把控制权交给内部表头/表格 —— Card 仅承担
  // rounded-xl + border + ring + overflow-hidden 的容器职责
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="max-h-[68vh] overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border">
              <th className="w-7" aria-hidden />
              <SortHeader
                field="author_name"
                label={t("people.tableHeaders.authorName")}
                sort={sort}
                onToggle={onToggleSort}
                align="left"
              />
              <SortHeader
                field="author_email"
                label={t("people.tableHeaders.authorEmail")}
                sort={sort}
                onToggle={onToggleSort}
                align="left"
              />
              <SortHeader
                field="commits"
                label={t("people.tableHeaders.commits")}
                sort={sort}
                onToggle={onToggleSort}
                align="right"
              />
              <SortHeader
                field="human_additions"
                label={t("people.tableHeaders.humanAdditions")}
                sort={sort}
                onToggle={onToggleSort}
                align="right"
              />
              <SortHeader
                field="unknown_additions"
                label={t("people.tableHeaders.unknownAdditions")}
                sort={sort}
                onToggle={onToggleSort}
                align="right"
                hint={`${METRICS.unknown_additions.definition} ${METRICS.unknown_additions.example ?? ""}`}
              />
              <SortHeader
                field="ai_additions"
                label={t("people.tableHeaders.aiAdditions")}
                sort={sort}
                onToggle={onToggleSort}
                align="right"
              />
              <SortHeader
                field="total_additions"
                label={t("people.tableHeaders.totalAdditions")}
                sort={sort}
                onToggle={onToggleSort}
                align="right"
              />
              <SortHeader
                field="ai_share"
                label={t("people.tableHeaders.aiShare")}
                sort={sort}
                onToggle={onToggleSort}
                align="right"
              />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isOpen = expanded.has(r.identity_key);
              const aiShare = r.total_additions > 0 ? r.ai_additions / r.total_additions : null;
              return (
                <PeopleTableRow
                  key={r.identity_key}
                  row={r}
                  aiShare={aiShare}
                  isOpen={isOpen}
                  onToggleExpand={() => onToggleExpand(r.identity_key)}
                  onJumpToStats={onJumpToStats}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PeopleTableRow({
  row,
  aiShare,
  isOpen,
  onToggleExpand,
  onJumpToStats,
}: {
  row: PersonRow;
  aiShare: number | null;
  isOpen: boolean;
  onToggleExpand: () => void;
  onJumpToStats: (sha: string) => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/60 hover:bg-muted"
        onClick={onToggleExpand}
      >
        <td className="py-1.5 pl-2 align-middle">
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </td>
        <td className="py-1.5 pr-2 align-middle">
          <span className="truncate font-medium text-foreground" title={row.author_name}>
            {row.author_name || "—"}
          </span>
        </td>
        <td className="py-1.5 pr-2 align-middle text-muted-foreground">
          <span className="truncate font-mono text-[11px]" title={row.author_email}>
            {row.author_email || "—"}
          </span>
        </td>
        <td className="py-1.5 pr-3 text-right align-middle font-mono">{formatInt(row.commits)}</td>
        <td className="py-1.5 pr-3 text-right align-middle font-mono">
          {formatInt(row.human_additions)}
        </td>
        <td className="py-1.5 pr-3 text-right align-middle font-mono">
          {formatInt(row.unknown_additions)}
        </td>
        <td className="py-1.5 pr-3 text-right align-middle font-mono">
          {formatInt(row.ai_additions)}
        </td>
        <td className="py-1.5 pr-3 text-right align-middle font-mono">
          {formatInt(row.total_additions)}
        </td>
        <td className="py-1.5 pr-3 text-right align-middle font-mono">{formatPercent(aiShare)}</td>
      </tr>
      {isOpen && (
        <tr className="border-b border-border/60 bg-muted/40">
          <td className="px-3 py-2" colSpan={9}>
            <RowCommitList commits={row.commit_refs} onJumpToStats={onJumpToStats} />
          </td>
        </tr>
      )}
    </>
  );
}

function RowCommitList({
  commits,
  onJumpToStats,
}: {
  commits: PersonRow["commit_refs"];
  onJumpToStats: (sha: string) => void;
}) {
  const { t } = useTranslation();
  if (commits.length === 0) {
    return <div className="text-[11px] text-muted-foreground">{t("people.rowCommits.empty")}</div>;
  }
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">
        {t("people.rowCommits.heading")}
      </div>
      <ul className="max-h-56 space-y-1 overflow-y-auto pr-1 text-[11px]">
        {commits.map((c) => {
          const failed =
            c.ai_additions === 0 && c.human_additions === 0 && c.unknown_additions === 0;
          return (
            <li key={c.sha}>
              <button
                type="button"
                onClick={() => onJumpToStats(c.sha)}
                className="flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-left text-muted-foreground transition-colors hover:bg-foreground/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                title={`点击查看 ${c.short} 的 Stats`}
              >
                <code className="rounded-sm bg-foreground/10 px-1 font-mono">{c.short}</code>
                {c.is_merge && (
                  <span className="rounded-sm bg-foreground/10 px-1 text-[10px]">
                    {t("people.rowCommits.mergeChip")}
                  </span>
                )}
                <span className="truncate flex-1">{c.subject}</span>
                <span className="font-mono text-muted-foreground">
                  {t("people.rowCommits.aiTemplate", { n: c.ai_additions })} ·{" "}
                  {t("people.rowCommits.humanTemplate", { n: c.human_additions })}
                </span>
                {failed && !c.is_merge && (
                  <span className="rounded-sm bg-warning-muted px-1 text-[10px] text-warning-foreground dark:text-warning">
                    {t("people.rowCommits.failedChip")}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SortHeader({
  field,
  label,
  sort,
  onToggle,
  align,
  hint,
}: {
  field: SortField;
  label: string;
  sort: { field: SortField; dir: SortDir };
  onToggle: (f: SortField) => void;
  align: "left" | "right";
  /** 可选:label 旁渲染一个 ⓘ icon,hover 显示该列指标的口径解释。 */
  hint?: string;
}) {
  const active = sort.field === field;
  const arrow = active ? (sort.dir === "asc" ? "↑" : "↓") : "";
  const alignCls = align === "right" ? "text-right pr-3" : "text-left pr-2";
  return (
    <th className={`py-2 ${alignCls} text-[11px] font-medium text-muted-foreground`}>
      <div className={`inline-flex items-center gap-1 ${align === "right" ? "" : ""}`}>
        <button
          type="button"
          onClick={() => onToggle(field)}
          className={`inline-flex items-center gap-1 hover:text-foreground ${active ? "text-foreground" : ""}`}
        >
          {label}
          {arrow && <span className="text-[10px]">{arrow}</span>}
        </button>
        {hint && (
          <Tooltip content={<div className="max-w-xs text-[11px] leading-relaxed">{hint}</div>}>
            <Info className="h-3 w-3 cursor-help text-muted-foreground" />
          </Tooltip>
        )}
      </div>
    </th>
  );
}

// ============ 空态 ============

/** 「只看我」但无法确定当前 git 用户(该仓未配置 user.email):引导切「全部」。 */
function CannotIdentifyMeCard({ onShowEveryone }: { onShowEveryone: () => void }) {
  const { t } = useTranslation();
  return (
    <Card padding="lg" className="border-dashed text-center">
      <div className="font-medium text-foreground">{t("people.cannotIdentifyMe.title")}</div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("people.cannotIdentifyMe.description")}
      </p>
      <button
        type="button"
        onClick={onShowEveryone}
        className="mt-3 inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium hover:bg-muted"
      >
        {t("people.cannotIdentifyMe.cta")}
      </button>
    </Card>
  );
}

/** 「只看我」口径下当前用户在本窗口无 commit:引导切「全部」看其他作者。 */
function EmptyMineCard({ onShowEveryone }: { onShowEveryone: () => void }) {
  const { t } = useTranslation();
  return (
    <Card padding="lg" className="border-dashed text-center">
      <div className="font-medium text-foreground">{t("people.emptyMine.title")}</div>
      <p className="mt-1 text-xs text-muted-foreground">{t("people.emptyMine.description")}</p>
      <button
        type="button"
        onClick={onShowEveryone}
        className="mt-3 inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium hover:bg-muted"
      >
        {t("people.emptyMine.cta")}
      </button>
    </Card>
  );
}

function EmptyWindowCard() {
  const { t } = useTranslation();
  return (
    <Card padding="lg" className="border-dashed text-center">
      <div className="font-medium text-foreground">{t("people.emptyWindow.title")}</div>
      <p className="mt-1 text-xs text-muted-foreground">{t("people.emptyWindow.description")}</p>
    </Card>
  );
}
