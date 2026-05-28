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
  Download,
  FolderOpen,
  Info,
  Loader2,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import { useState } from "react";

import { EmptyState } from "../components/EmptyState";
import { TimeRangePicker } from "../components/TimeRangePicker";
import { Card } from "../components/ui/CardPanel";
import { Tooltip } from "../components/ui/TooltipBubble";
import {
  DASHBOARD_CACHE_HINT,
  PEOPLE_DEGRADED,
  PEOPLE_EMPTY_SEARCH,
  PEOPLE_EMPTY_WINDOW,
  PEOPLE_FAILED_HINT,
  PEOPLE_METRIC_TITLES,
  PEOPLE_PAGE,
  PEOPLE_ROW_COMMITS,
  PEOPLE_TABLE_HEADERS,
  PEOPLE_TRUNCATED_HINT,
} from "../lib/copy";
import { currentRepo, getPeopleBreakdown } from "../lib/api";
import { METRICS } from "../lib/formulas";
import { formatInt, formatPercent } from "../lib/formulas";
import { rangeKey } from "../lib/queryKeys";
import type {
  PeopleBreakdownPayload,
  PeopleBreakdownResult,
  PersonRow,
  TimeRange,
} from "../lib/types";
import { useRouter } from "../router";
import { buildCsv, filterRows, sortRows, type SortDir, type SortField } from "./peopleTable";

const STALE_TIME_MS = DASHBOARD_CACHE_HINT.stale_time_seconds * 1000;
const DEFAULT_RANGE: TimeRange = { kind: "last_n_days", days: 7 };

export default function PeoplePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [range, setRange] = useState<TimeRange>(DEFAULT_RANGE);
  const [query, setQuery] = useState("");
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
    const copy = PEOPLE_DEGRADED[kind];
    return (
      <EmptyState
        Icon={kind === "repo_missing" ? FolderOpen : Activity}
        title={copy.title}
        description={copy.description}
        ctaLabel={copy.cta}
        onCta={() => router.navigate(kind === "repo_missing" ? "repo" : "install")}
      />
    );
  }

  if (peopleQ.isLoading && !peopleQ.data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在按人聚合 stats…
      </div>
    );
  }

  if (peopleQ.isError) {
    return (
      <div className="p-6">
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          聚合失败:{(peopleQ.error as Error).message}
        </div>
      </div>
    );
  }

  const payload: PeopleBreakdownPayload | null =
    peopleQ.data?.status === "ok" ? peopleQ.data.payload : null;
  if (!payload) return null;

  const filteredRows = filterRows(payload.rows, query);
  const sortedRows = sortRows(filteredRows, sort);

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

  const onExportCsv = () => {
    const csv = buildCsv(sortedRows);
    downloadBlob(csv, `people-stats-${rangeKey(range)}.csv`);
  };

  return (
    <div className="space-y-5 p-6">
      <Header
        range={range}
        onChangeRange={setRange}
        query={query}
        onChangeQuery={setQuery}
        isFetching={peopleQ.isFetching}
        onRefresh={refresh}
        onExportCsv={onExportCsv}
        canExport={sortedRows.length > 0}
      />

      <CacheBar cacheHits={payload.cache_hits} totalCommits={payload.grand_total.commits} />

      {payload.failed_shas.length > 0 && <FailedBanner count={payload.failed_shas.length} />}
      {payload.truncated && <TruncatedBanner />}

      <OverviewCards total={payload.grand_total} />

      {payload.rows.length === 0 ? (
        <EmptyWindowCard />
      ) : sortedRows.length === 0 ? (
        <EmptySearchCard />
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
  query,
  onChangeQuery,
  isFetching,
  onRefresh,
  onExportCsv,
  canExport,
}: {
  range: TimeRange;
  onChangeRange: (next: TimeRange) => void;
  query: string;
  onChangeQuery: (next: string) => void;
  isFetching: boolean;
  onRefresh: () => void;
  onExportCsv: () => void;
  canExport: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold inline-flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            {PEOPLE_PAGE.title}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">{PEOPLE_PAGE.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TimeRangePicker value={range} onChange={onChangeRange} />
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => onChangeQuery(e.target.value)}
              placeholder={PEOPLE_PAGE.search_placeholder}
              aria-label={PEOPLE_PAGE.search_placeholder}
              className="w-60 rounded-md border border-slate-200 bg-white py-1 pl-7 pr-2 text-xs shadow-xs dark:border-border dark:bg-card"
            />
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isFetching}
            aria-label={PEOPLE_PAGE.refresh}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 shadow-xs hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-border dark:bg-card dark:text-slate-300"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            {isFetching ? PEOPLE_PAGE.refreshing : PEOPLE_PAGE.refresh}
          </button>
          <button
            type="button"
            onClick={onExportCsv}
            disabled={!canExport}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 shadow-xs hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-border dark:bg-card dark:text-slate-300"
          >
            <Download className="h-3 w-3" />
            {PEOPLE_PAGE.export_csv}
          </button>
        </div>
      </div>
      <div className="text-[11px] text-slate-400">{PEOPLE_PAGE.identity_hint}</div>
    </div>
  );
}

// ============ CacheBar ============

function CacheBar({ cacheHits, totalCommits }: { cacheHits: number; totalCommits: number }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500 dark:border-border dark:bg-card/40">
      <div>缓存 30s · 数据不上传</div>
      <div className="font-mono text-slate-500">
        {PEOPLE_PAGE.cached_template(cacheHits, totalCommits)}
      </div>
    </div>
  );
}

function FailedBanner({ count }: { count: number }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>{PEOPLE_FAILED_HINT(count)}</div>
    </div>
  );
}

function TruncatedBanner() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>{PEOPLE_TRUNCATED_HINT(500)}</div>
    </div>
  );
}

// ============ 4 总览卡 ============

function OverviewCards({ total }: { total: PeopleBreakdownPayload["grand_total"] }) {
  const aiShare = total.total_additions > 0 ? total.ai_additions / total.total_additions : null;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
      <MetricCard title={PEOPLE_METRIC_TITLES.total_commits} display={formatInt(total.commits)} />
      <MetricCard
        title={PEOPLE_METRIC_TITLES.total_human}
        display={formatInt(total.human_additions)}
      />
      <MetricCard title={PEOPLE_METRIC_TITLES.total_ai} display={formatInt(total.ai_additions)} />
      <MetricCard title={PEOPLE_METRIC_TITLES.overall_ai_rate} display={formatPercent(aiShare)} />
    </div>
  );
}

function MetricCard({ title, display }: { title: string; display: string }) {
  // People 总览卡阶梯:介于 Dashboard(36px)与 Stats(28px)之间,28px 保持密集
  return (
    <Card padding="sm" interactive className="flex min-h-[100px] flex-col justify-between">
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
                label={PEOPLE_TABLE_HEADERS.author_name}
                sort={sort}
                onToggle={onToggleSort}
                align="left"
              />
              <SortHeader
                field="author_email"
                label={PEOPLE_TABLE_HEADERS.author_email}
                sort={sort}
                onToggle={onToggleSort}
                align="left"
              />
              <SortHeader
                field="commits"
                label={PEOPLE_TABLE_HEADERS.commits}
                sort={sort}
                onToggle={onToggleSort}
                align="right"
              />
              <SortHeader
                field="human_additions"
                label={PEOPLE_TABLE_HEADERS.human_additions}
                sort={sort}
                onToggle={onToggleSort}
                align="right"
              />
              <SortHeader
                field="unknown_additions"
                label={PEOPLE_TABLE_HEADERS.unknown_additions}
                sort={sort}
                onToggle={onToggleSort}
                align="right"
                hint={`${METRICS.unknown_additions.definition} ${METRICS.unknown_additions.example ?? ""}`}
              />
              <SortHeader
                field="ai_additions"
                label={PEOPLE_TABLE_HEADERS.ai_additions}
                sort={sort}
                onToggle={onToggleSort}
                align="right"
              />
              <SortHeader
                field="total_additions"
                label={PEOPLE_TABLE_HEADERS.total_additions}
                sort={sort}
                onToggle={onToggleSort}
                align="right"
              />
              <SortHeader
                field="ai_share"
                label={PEOPLE_TABLE_HEADERS.ai_share}
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
        className="cursor-pointer border-b border-border/60 hover:bg-slate-50 dark:hover:bg-slate-800/40"
        onClick={onToggleExpand}
      >
        <td className="py-1.5 pl-2 align-middle">
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
          )}
        </td>
        <td className="py-1.5 pr-2 align-middle">
          <span className="truncate font-medium text-foreground" title={row.author_name}>
            {row.author_name || "—"}
          </span>
        </td>
        <td className="py-1.5 pr-2 align-middle text-slate-500">
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
        <tr className="border-b border-border/60 bg-slate-50/60 dark:bg-slate-800/20">
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
  if (commits.length === 0) {
    return <div className="text-[11px] text-slate-400">{PEOPLE_ROW_COMMITS.empty}</div>;
  }
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-slate-500">
        {PEOPLE_ROW_COMMITS.heading}
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
                className="flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-left text-slate-600 transition-colors hover:bg-slate-200/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring dark:text-slate-300 dark:hover:bg-slate-700/40"
                title={`点击查看 ${c.short} 的 Stats`}
              >
                <code className="rounded-sm bg-slate-200/70 px-1 font-mono dark:bg-slate-700/40">
                  {c.short}
                </code>
                {c.is_merge && (
                  <span className="rounded-sm bg-slate-200 px-1 text-[10px] dark:bg-slate-700">
                    {PEOPLE_ROW_COMMITS.merge_chip}
                  </span>
                )}
                <span className="truncate flex-1">{c.subject}</span>
                <span className="font-mono text-slate-400">
                  {PEOPLE_ROW_COMMITS.ai_template(c.ai_additions)} ·{" "}
                  {PEOPLE_ROW_COMMITS.human_template(c.human_additions)}
                </span>
                {failed && !c.is_merge && (
                  <span className="rounded-sm bg-amber-100 px-1 text-[10px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                    {PEOPLE_ROW_COMMITS.failed_chip}
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
    <th className={`py-2 ${alignCls} text-[11px] font-medium text-slate-500`}>
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
            <Info className="h-3 w-3 cursor-help text-slate-400" />
          </Tooltip>
        )}
      </div>
    </th>
  );
}

// ============ 空态 ============

function EmptyWindowCard() {
  return (
    <Card padding="lg" className="border-dashed text-center">
      <div className="font-medium text-foreground">{PEOPLE_EMPTY_WINDOW.title}</div>
      <p className="mt-1 text-xs text-muted-foreground">{PEOPLE_EMPTY_WINDOW.description}</p>
    </Card>
  );
}

function EmptySearchCard() {
  return (
    <Card padding="lg" className="border-dashed text-center">
      <div className="font-medium text-foreground">{PEOPLE_EMPTY_SEARCH.title}</div>
      <p className="mt-1 text-xs text-muted-foreground">{PEOPLE_EMPTY_SEARCH.description}</p>
    </Card>
  );
}

function downloadBlob(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 浏览器在某些场景下立即 revoke 会阻断下载,延后一拍释放
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
