// Blame 页(P6/P10/方案 A):commit 驱动的行级 AI 归因可视化。
//
// # 形态(提交归因驱动 —— 与 Stats 页共用 commit 列表 + 改动文件组件)
// 左栏:搜索 + 只看我 → 提交归因 commit 列表 → 选中 commit → 列出它改动的文件。
// 右主区:点改动文件 → 在该 commit 下渲染整文件逐行 blame(AI 行淡蓝、行号染色)。
// 点 AI 行 → 最右停靠面板出 prompt 摘要(哪个 agent / 模型、采纳 / 被改)。
//
// # 权威口径
// - 后端调用上游 `git-ai blame-analysis --json '<payload>'`,只把 prompt_records 命中的行标为 AI
// - `tool::model` 拼接对齐 stats.rs:470
// - `accepted_lines / overriden_lines` 是**仓库级累计**,Popover 必标
//
// # URL
// `#/blame/<file>?sha=<commit>` 或带行范围 `#/blame/<file>/L<a>-<b>?sha=<commit>`
// (L 前缀防文件名歧义,见 lib/blameUrl.ts;sha 段定位到具体 commit,即 blame 的 ref)。
//
// # 为什么 commit 驱动(pantheon 决策:Jobs/Musk/Linus/Bezos)
// 旧版「全仓文件树」无人用 —— 用户从不浏览整棵树找文件。改为按 commit 浏览:
// "这次提交动了哪些文件、各自多少 AI 行",点进去看整文件归因。commit 列表 + 改动文件列表
// 与 Stats 页抽成同一份纯展示组件(真 DRY,非伪共享)。

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, FolderOpen, Loader2, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  BlameCodeView,
  type BlameLineAuthor,
  type BlameLineClickEvent,
} from "../components/BlameCodeView";
import { BlamePromptDetails } from "../components/BlamePromptDetails";
import { ChangedFilesPanel } from "../components/ChangedFilesList";
import { CommitAttributionList } from "../components/CommitAttributionList";
import { EmptyState } from "../components/EmptyState";
import { SplitPane } from "../components/Layout/SplitPane";
import { ScopeToggle } from "../components/ScopeToggle";
import {
  currentGitUserEmail,
  currentRepo,
  getBlameAtRef,
  listRecentCommitsWithStats,
  readFileAtRef,
} from "../lib/api";
import { buildBlameUrlParams, parseBlameParams } from "../lib/blameUrl";
import { detectTheme } from "../lib/chartColors";
import type {
  BlameDegradedReason,
  BlamePayload,
  BlamePromptRecord,
  BlameResult,
  CommitWithStats,
  ReadFileResult,
  RecentCommitsResult,
} from "../lib/types";
import { useNotesUpdated } from "../lib/useNotesUpdated";
import { useRouter } from "../router";

const STALE_TIME_MS = 30_000;

/** 一次拉的最近 commit 数。复用 get_history 的 per-commit 缓存,冷启首次才需子进程。 */
const COMMIT_LIST_LIMIT = 100;

export default function BlamePage() {
  const { t } = useTranslation();
  const router = useRouter();
  const qc = useQueryClient();
  const parsed = useMemo(() => parseBlameParams(router.params), [router.params]);
  const [theme, setTheme] = useState<"light" | "dark">(() => detectTheme());
  const [activeClick, setActiveClick] = useState<BlameLineClickEvent | null>(null);
  const [onlyMine, setOnlyMine] = useState(true); // 默认只看我(ADR-012:单开发者本机工具本分)
  const [query, setQuery] = useState("");
  const [lInput, setLInput] = useState(parsed.range ? `${parsed.range[0]},${parsed.range[1]}` : "");
  const [lError, setLError] = useState<string | null>(null);

  // 选中 commit 的 sha 走 URL `?sha=`;深链直达。
  const querySha = router.query.get("sha") ?? null;

  useEffect(() => {
    setLInput(parsed.range ? `${parsed.range[0]},${parsed.range[1]}` : "");
    setLError(null);
  }, [parsed.range]);

  useEffect(() => {
    const ob = new MutationObserver(() => setTheme(detectTheme()));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => ob.disconnect();
  }, []);

  const repoQ = useQuery({
    queryKey: ["current_repo_path"],
    queryFn: () => currentRepo(),
    staleTime: STALE_TIME_MS,
  });
  const repoPath = repoQ.data?.path ?? null;

  const userEmailQ = useQuery({
    queryKey: ["current_git_user_email", repoPath],
    queryFn: currentGitUserEmail,
    staleTime: STALE_TIME_MS,
  });
  const userEmail = userEmailQ.data?.toLowerCase() ?? null;

  const commitsQ = useQuery<RecentCommitsResult>({
    queryKey: ["recent_commits_with_stats", repoPath, COMMIT_LIST_LIMIT],
    queryFn: () => listRecentCommitsWithStats(COMMIT_LIST_LIMIT),
    staleTime: STALE_TIME_MS,
    enabled: !!repoPath,
  });

  // 提交后(refs/notes/ai 变化)立即失效 commit 列表缓存,与 Stats 同源同步。
  useNotesUpdated(
    repoPath,
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: ["recent_commits_with_stats", repoPath] });
    }, [qc, repoPath]),
  );

  const payload = commitsQ.data?.status === "ok" ? commitsQ.data.payload : null;
  const allCommits = useMemo(() => payload?.commits ?? [], [payload]);
  const failedShas = useMemo(() => new Set(payload?.failed_shas ?? []), [payload]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      allCommits.filter((c) => {
        if (onlyMine && userEmail && c.author_email.toLowerCase() !== userEmail) return false;
        if (q && !c.subject.toLowerCase().includes(q) && !c.sha.toLowerCase().includes(q))
          return false;
        return true;
      }),
    [allCommits, onlyMine, userEmail, q],
  );

  // 选中 commit 的 sha:URL 显式 sha 优先(可指向窗口外的老 commit);否则默认首条(HEAD)。
  // blame / 改动文件 / 列表高亮统一用它做单一 ref。
  const selectedSha = querySha ?? filtered[0]?.sha ?? allCommits[0]?.sha ?? null;

  const blameQ = useQuery<BlameResult>({
    queryKey: ["blame", repoPath, selectedSha, parsed.file, parsed.range],
    queryFn: () =>
      getBlameAtRef(
        selectedSha,
        parsed.file as string,
        parsed.range ? [[parsed.range[0], parsed.range[1]]] : null,
      ),
    staleTime: STALE_TIME_MS,
    enabled: !!repoPath && !!selectedSha && !!parsed.file,
  });

  const fileQ = useQuery<ReadFileResult>({
    queryKey: ["read_file", repoPath, selectedSha, parsed.file],
    queryFn: () => readFileAtRef(selectedSha, parsed.file as string),
    staleTime: STALE_TIME_MS,
    enabled: !!repoPath && !!selectedSha && !!parsed.file,
  });

  /** 选 commit:清掉当前文件(新 commit 下可能不存在),只锚定 sha。 */
  const onSelectCommit = (sha: string) => {
    router.navigate("blame", buildBlameUrlParams(null, null), { sha });
    setActiveClick(null);
  };

  /** 选改动文件:锚定到 (file, 当前 commit sha)。 */
  const onSelectFile = (file: string) => {
    if (!selectedSha) return;
    router.navigate("blame", buildBlameUrlParams(file, null), { sha: selectedSha });
    setActiveClick(null);
  };

  const applyRange = () => {
    if (!parsed.file || !selectedSha) return;
    const trimmed = lInput.trim();
    if (!trimmed) {
      router.navigate("blame", buildBlameUrlParams(parsed.file, null), { sha: selectedSha });
      setLError(null);
      return;
    }
    const m = /^(\d+)\s*,\s*(\d+)$/.exec(trimmed);
    if (!m) {
      setLError(t("blame.lrange.invalid"));
      return;
    }
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a < 1 || b < a) {
      setLError(t("blame.lrange.invalid"));
      return;
    }
    setLError(null);
    router.navigate("blame", buildBlameUrlParams(parsed.file, [a, b]), { sha: selectedSha });
  };

  if (repoQ.data === null) {
    return (
      <EmptyState
        Icon={FolderOpen}
        title={t("blame.degraded.repoMissing.title")}
        description={t("blame.degraded.repoMissing.description")}
        ctaLabel={t("blame.degraded.repoMissing.cta")}
        onCta={() => router.navigate("repo")}
      />
    );
  }

  // commit 列表 degraded(未选仓库 / git-ai 未装)→ 整页空态(与 Stats 同口径)。
  if (commitsQ.data?.status === "degraded") {
    const kind = commitsQ.data.reason.kind;
    const repoMissing = kind === "repo_missing";
    return (
      <EmptyState
        Icon={repoMissing ? FolderOpen : Activity}
        title={t(
          repoMissing ? "blame.degraded.repoMissing.title" : "blame.degraded.gitAiMissing.title",
        )}
        description={t(
          repoMissing
            ? "blame.degraded.repoMissing.description"
            : "blame.degraded.gitAiMissing.description",
        )}
        ctaLabel={t(
          repoMissing ? "blame.degraded.repoMissing.cta" : "blame.degraded.gitAiMissing.cta",
        )}
        onCta={() => router.navigate(repoMissing ? "repo" : "install")}
      />
    );
  }

  // 页级提取 blame payload:供右侧停靠详情面板查 prompts / metadata。
  const blamePayload: BlamePayload | null =
    blameQ.data?.status === "ok" ? blameQ.data.payload : null;

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      <Header
        lInput={lInput}
        setLInput={setLInput}
        lError={lError}
        onApplyRange={applyRange}
        fileSelected={!!parsed.file}
      />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <SplitPane
          className="min-w-0 flex-1"
          storageKey="blame.commitNav.width"
          defaultLeftWidth={340}
          minLeftWidth={260}
          maxLeftWidth={560}
          left={
            <CommitNav
              loading={commitsQ.isLoading}
              error={commitsQ.isError ? (commitsQ.error as Error).message : null}
              commits={filtered}
              total={allCommits.length}
              truncated={payload?.truncated ?? false}
              failedShas={failedShas}
              selectedSha={selectedSha ?? undefined}
              selectedFile={parsed.file ?? undefined}
              query={query}
              onQuery={setQuery}
              onlyMine={onlyMine}
              onOnlyMine={setOnlyMine}
              onSelectCommit={onSelectCommit}
              onSelectFile={onSelectFile}
            />
          }
          right={
            !parsed.file ? (
              <BlameInstructions hasCommit={!!selectedSha} />
            ) : (
              <FileView
                file={parsed.file}
                blameQ={blameQ}
                fileQ={fileQ}
                theme={theme}
                onLineClick={setActiveClick}
              />
            )
          }
        />
        {/* 右侧停靠详情面板:点 AI 行才出现。 */}
        <LineDetailAside
          click={activeClick}
          prompts={blamePayload?.prompts ?? {}}
          metadata={blamePayload?.metadata ?? { is_logged_in: false, current_user: null }}
          onClose={() => setActiveClick(null)}
        />
      </div>
    </div>
  );
}

function Header({
  lInput,
  setLInput,
  lError,
  onApplyRange,
  fileSelected,
}: {
  lInput: string;
  setLInput: (v: string) => void;
  lError: string | null;
  onApplyRange: () => void;
  fileSelected: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 border-b border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-foreground">{t("blame.title")}</h1>
        <span className="text-[11px] text-muted-foreground">{t("blame.commitNav.subtitle")}</span>

        {fileSelected && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onApplyRange();
              }}
              className="flex items-center gap-1"
            >
              <label htmlFor="lrange" className="text-xs font-medium text-muted-foreground">
                {t("blame.lrange.label")}:
              </label>
              <input
                id="lrange"
                type="text"
                value={lInput}
                onChange={(e) => setLInput(e.target.value)}
                placeholder={t("blame.lrange.placeholder")}
                spellCheck={false}
                aria-invalid={lError !== null}
                className="w-24 rounded-md border border-border bg-card px-2 py-1 font-mono text-xs text-foreground shadow-xs focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-ring"
              />
              <button
                type="submit"
                className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary/90"
              >
                {t("blame.lrange.apply")}
              </button>
            </form>
          </div>
        )}
      </div>
      {lError && <div className="text-[11px] text-red-600 dark:text-red-400">{lError}</div>}
    </div>
  );
}

/**
 * 左栏:提交归因驱动的文件导航。
 * 上半 = 搜索 + 只看我 + commit 列表(共享 CommitAttributionList);
 * 下半 = 选中 commit 的改动文件(共享 ChangedFilesPanel,点文件 → 主区 blame)。
 */
function CommitNav({
  loading,
  error,
  commits,
  total,
  truncated,
  failedShas,
  selectedSha,
  selectedFile,
  query,
  onQuery,
  onlyMine,
  onOnlyMine,
  onSelectCommit,
  onSelectFile,
}: {
  loading: boolean;
  error: string | null;
  commits: CommitWithStats[];
  total: number;
  truncated: boolean;
  failedShas: Set<string>;
  selectedSha: string | undefined;
  selectedFile: string | undefined;
  query: string;
  onQuery: (v: string) => void;
  onlyMine: boolean;
  onOnlyMine: (v: boolean) => void;
  onSelectCommit: (sha: string) => void;
  onSelectFile: (file: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      {/* 过滤条:搜索 + 只看我 */}
      <div className="shrink-0 space-y-2 border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={t("blame.commitNav.searchPlaceholder")}
            className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-ring"
          />
        </div>
        <ScopeToggle onlyMine={onlyMine} onChange={onOnlyMine} />
      </div>

      {/* commit 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("blame.commitNav.heading")}
          <span className="font-normal normal-case">
            · {t("commitList.countTemplate", { n: commits.length })}
          </span>
          {truncated && (
            <span
              className="ml-auto font-normal normal-case text-warning-foreground dark:text-warning"
              title={t("blame.commitNav.truncatedTitle", { n: total })}
            >
              {t("blame.commitNav.truncated", { n: COMMIT_LIST_LIMIT })}
            </span>
          )}
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("blame.commitNav.loading")}
          </div>
        ) : error ? (
          <div className="m-2 rounded-md border border-danger bg-danger-muted p-2 text-[11px] text-danger">
            {error}
          </div>
        ) : (
          <CommitAttributionList
            commits={commits}
            failedShas={failedShas}
            selectedSha={selectedSha}
            onSelect={onSelectCommit}
          />
        )}
      </div>

      {/* 选中 commit 的改动文件:点文件 → 主区整文件逐行 blame */}
      {selectedSha && (
        <div className="max-h-[42%] shrink-0 overflow-y-auto border-t border-border p-2">
          <ChangedFilesPanel
            sha={selectedSha}
            selectedFile={selectedFile}
            onOpenFile={onSelectFile}
          />
        </div>
      )}
    </div>
  );
}

function BlameInstructions({ hasCommit }: { hasCommit: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-10 text-sm text-muted-foreground">
      <div className="mb-2 font-medium text-foreground">
        {t(hasCommit ? "blame.instructions.pickFile" : "blame.instructions.pickCommit")}
      </div>
      <p className="max-w-md text-center text-xs text-muted-foreground">
        {t("blame.instructions.body")}
      </p>
    </div>
  );
}

function FileView({
  file,
  blameQ,
  fileQ,
  theme,
  onLineClick,
}: {
  file: string;
  blameQ: ReturnType<typeof useQuery<BlameResult>>;
  fileQ: ReturnType<typeof useQuery<ReadFileResult>>;
  theme: "light" | "dark";
  onLineClick: (e: BlameLineClickEvent) => void;
}) {
  const { t } = useTranslation();
  const fileResult = fileQ.data;
  const blameResult = blameQ.data;

  const blamePayload: BlamePayload | null =
    blameResult?.status === "ok" ? blameResult.payload : null;

  const aiLines = useMemo(() => {
    const m = new Map<number, string>();
    if (!blamePayload) return m;
    for (const [key, promptId] of Object.entries(blamePayload.lines)) {
      const mr = /^(\d+)(?:-(\d+))?$/.exec(key);
      if (!mr) continue;
      const a = Number(mr[1]);
      const b = mr[2] ? Number(mr[2]) : a;
      if (a < 1 || b < a) continue;
      for (let n = a; n <= b; n++) m.set(n, promptId);
    }
    return m;
  }, [blamePayload]);

  // 每行作者/模型列:AI 行标模型,人写行标 git 作者(hunks)——"这文件每行谁写"一眼可见。
  const lineAuthors = useMemo(() => {
    const m = new Map<number, BlameLineAuthor>();
    if (!blamePayload) return m;
    for (const hunk of blamePayload.hunks) {
      const [start, end] = hunk.range;
      if (start < 1 || end < start) continue;
      const dateLabel = hunk.author_time
        ? new Date(hunk.author_time * 1000).toISOString().slice(0, 10)
        : "—";
      const baseTitle = `${hunk.original_author || "(unknown)"} · ${hunk.abbrev_sha || hunk.commit_sha.slice(0, 7)} · ${dateLabel}`;
      for (let n = start; n <= end; n++) {
        const pid = aiLines.get(n);
        if (pid) {
          const prompt = blamePayload.prompts[pid];
          const tool = prompt?.agent_id.tool ?? "ai";
          const model = prompt?.agent_id.model ?? tool;
          m.set(n, { label: model, tone: "ai", title: prompt ? `AI: ${tool}::${model}` : "AI" });
        } else {
          const label = hunk.original_author || "(unknown)";
          m.set(n, { label, tone: "human", title: baseTitle });
        }
      }
    }
    return m;
  }, [blamePayload, aiLines]);

  if (fileQ.isLoading || blameQ.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t("blame.loading")}
      </div>
    );
  }
  if (fileQ.isError) {
    return <ErrorCard message={(fileQ.error as Error).message} />;
  }
  if (fileResult?.status === "degraded") {
    return <FileDegraded reason={fileResult.reason} />;
  }
  if (!fileResult || fileResult.status !== "ok") return null;

  // blame degraded 现在只剩"真硬故障"(file_too_large / file_binary / commit_not_found 等);
  // "无 AI 行" 已挪到 Ok payload + lines empty → 下方 banner,作者列照常渲染。
  if (blameResult?.status === "degraded") {
    return <FileDegraded reason={blameResult.reason} />;
  }
  const noAiBanner = !!blamePayload && Object.keys(blamePayload.lines).length === 0;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {noAiBanner && <NoAiAuthorshipBanner />}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <BlameCodeView
          code={fileResult.text}
          filePath={file}
          aiLines={aiLines}
          lineAuthors={lineAuthors}
          theme={theme}
          onLineClick={onLineClick}
        />
      </div>
      <Legend />
    </div>
  );
}

function NoAiAuthorshipBanner() {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 border-b border-border bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:bg-card/40 dark:text-slate-300">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div>
        <span className="font-medium">{t("blame.degraded.noAiAuthorship.title")}</span> —{" "}
        {t("blame.degraded.noAiAuthorship.description")}
        <div className="mt-1 text-[10px] text-muted-foreground">
          {t("blame.popover.mergeCaveat")}
        </div>
      </div>
    </div>
  );
}

function Legend() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <span className="inline-block h-2 w-2 rounded-xs bg-primary/100" />
        {t("blame.lineLegend.ai")}
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-2 w-2 rounded-xs border border-border bg-card" />
        {t("blame.lineLegend.nonAi")}
      </span>
    </div>
  );
}

/**
 * 逐行详情停靠面板:点 AI 行才出现,停靠在最右。
 * 内容用 PromptDetails;无匹配 prompt 记录时不渲染(等价关闭)。
 */
function LineDetailAside({
  click,
  prompts,
  metadata,
  onClose,
}: {
  click: BlameLineClickEvent | null;
  prompts: Record<string, BlamePromptRecord>;
  metadata: BlamePayload["metadata"];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const record = click ? prompts[click.promptId] : null;
  if (!click || !record) return null;
  return (
    <aside className="relative flex w-80 shrink-0 flex-col border-l border-border bg-card">
      <button
        type="button"
        onClick={onClose}
        aria-label={t("blame.lineDetail.close")}
        className="absolute right-2 top-2 z-10 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <div className="flex-1 overflow-y-auto p-3 pr-8">
        <BlamePromptDetails record={record} lineNumber={click.lineNumber} metadata={metadata} />
      </div>
    </aside>
  );
}

function FileDegraded({ reason }: { reason: BlameDegradedReason }) {
  const { t } = useTranslation();
  const router = useRouter();
  let title = t("blame.fileDegradedFallbackTitle");
  let description: React.ReactNode = "";
  let ctaLabel: string | undefined;
  let onCta: (() => void) | undefined;
  switch (reason.kind) {
    case "repo_missing": {
      title = t("blame.degraded.repoMissing.title");
      description = t("blame.degraded.repoMissing.description");
      ctaLabel = t("blame.degraded.repoMissing.cta");
      onCta = () => router.navigate("repo");
      break;
    }
    case "git_ai_missing": {
      title = t("blame.degraded.gitAiMissing.title");
      description = t("blame.degraded.gitAiMissing.description");
      ctaLabel = t("blame.degraded.gitAiMissing.cta");
      onCta = () => router.navigate("install");
      break;
    }
    case "no_head": {
      title = t("blame.degraded.noHead.title");
      description = t("blame.degraded.noHead.description");
      break;
    }
    case "commit_not_found": {
      title = t("blame.degraded.commitNotFound.title");
      description = t("blame.degraded.commitNotFound.descriptionTemplate", { sha: reason.sha });
      break;
    }
    case "file_not_in_head": {
      title = t("blame.degraded.fileNotInHead.title");
      description = t("blame.degraded.fileNotInHead.descriptionTemplate", { file: reason.file });
      break;
    }
    case "file_too_large": {
      title = t("blame.degraded.fileTooLarge.title");
      description = t("blame.degraded.fileTooLarge.descriptionTemplate", {
        sizeKb: (reason.size / 1024).toFixed(1),
        limitKb: (reason.limit / 1024).toFixed(0),
      });
      break;
    }
    case "file_binary": {
      title = t("blame.degraded.fileBinary.title");
      description = t("blame.degraded.fileBinary.description");
      break;
    }
    case "ref_not_found": {
      title = t("blame.refPicker.refNotFoundTitle");
      description = t("blame.refPicker.refNotFoundTemplate", { r: reason.ref });
      break;
    }
  }
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <EmptyState
        Icon={Activity}
        title={title}
        description={description}
        ctaLabel={ctaLabel}
        onCta={onCta}
      />
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="m-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
      {t("blame.errorPrefix")}:{message}
    </div>
  );
}
