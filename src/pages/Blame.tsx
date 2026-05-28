// Blame 页(P6/P10):行级 AI 归因可视化。
//
// # 权威口径
// - 后端调用上游 `git-ai blame-analysis --json '<payload>'`,只把 prompt_records 命中的行标为 AI
// - `tool::model` 拼接对齐 stats.rs:470
// - `accepted_lines / overriden_lines` 是**仓库级累计**,Popover 必标
//
// # URL
// `#/blame` 或 `#/blame/<file>` 或 `#/blame/<file>/L<a>-<b>`(L 前缀防文件名歧义,见 lib/blameUrl.ts)
//
// # Ref 维度过滤(P10b)
// 顶部有 ref selector:默认 HEAD,可切本地分支或粘贴 sha / tag。
// 切 ref 重置 selectedFile + lRange,因为不同 ref 下的文件树 / 行号不可比。
// ref 状态目前只持在内存,不进 URL —— 避免和 file/range 段位 collide(后续若要分享 ref 视图再加)。

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  FolderOpen,
  GitBranch,
  Loader2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  BlameCodeView,
  type BlameLineAuthor,
  type BlameLineClickEvent,
} from "../components/BlameCodeView";
import { BlameFileTree } from "../components/BlameFileTree";
import { EmptyState } from "../components/EmptyState";
import { SplitPane } from "../components/Layout/SplitPane";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/Command";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/PopoverPanel";
import {
  currentRepo,
  getBlameAtRef,
  listBranches,
  listFilesAtRef,
  readFileAtRef,
} from "../lib/api";
import { buildBlameUrlParams, parseBlameParams } from "../lib/blameUrl";
import { detectTheme } from "../lib/chartColors";
import { cn } from "../lib/cn";
import {
  BLAME_DEGRADED,
  BLAME_LINE_LEGEND,
  BLAME_POPOVER,
  BLAME_REF_PICKER,
  BLAME_TEXT,
} from "../lib/copy";
import type {
  BlameDegradedReason,
  BlamePayload,
  BlamePromptRecord,
  BlameResult,
  ListBranchesResult,
  ReadFileResult,
} from "../lib/types";
import { useRouter } from "../router";

const STALE_TIME_MS = 30_000;

/** 分支条目数超过阈值才显示搜索框,小于则直接列点选,避免视觉噪声。 */
const REF_SEARCH_THRESHOLD = 10;

/**
 * Blame 视角的 ref 选择。
 *
 * # null
 * 等价 HEAD;HEAD 不固化为字符串以保留"跟随分支切换"语义 —— 切分支后 HEAD 自动指新 commit,
 * 不需要前端额外动作。
 *
 * # 字符串
 * 用户显式锁定到本地分支名 / sha / tag;不再随 HEAD 移动。
 */
type BlameRef = string | null;

export default function BlamePage() {
  const router = useRouter();
  const parsed = useMemo(() => parseBlameParams(router.params), [router.params]);
  const [theme, setTheme] = useState<"light" | "dark">(() => detectTheme());
  const [activeClick, setActiveClick] = useState<BlameLineClickEvent | null>(null);
  const [lInput, setLInput] = useState(parsed.range ? `${parsed.range[0]},${parsed.range[1]}` : "");
  const [lError, setLError] = useState<string | null>(null);
  // ref 选择(null = HEAD)。URL `?sha=<x>` 会通过下面 useEffect 同步进来。
  const [selectedRef, setSelectedRef] = useState<BlameRef>(null);

  useEffect(() => {
    setLInput(parsed.range ? `${parsed.range[0]},${parsed.range[1]}` : "");
    setLError(null);
  }, [parsed.range]);

  // 任务 #2:URL `?sha=<x>` → selectedRef。
  // 只在 URL 真带 sha 时覆盖;无 sha 时不主动 reset,避免用户从 RefPicker 切到分支后被无关 hashchange 回退到 HEAD。
  const querySha = router.query.get("sha") ?? null;
  useEffect(() => {
    if (querySha && querySha !== selectedRef) {
      setSelectedRef(querySha);
    }
    // 只跟随 querySha 变化触发(不依赖 selectedRef,否则会与下面 onSelectRef 写回 URL 形成循环)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [querySha]);

  useEffect(() => {
    const ob = new MutationObserver(() => setTheme(detectTheme()));
    ob.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => ob.disconnect();
  }, []);

  const repoQ = useQuery({
    queryKey: ["current_repo_path"],
    queryFn: () => currentRepo(),
    staleTime: STALE_TIME_MS,
  });
  const repoPath = repoQ.data?.path ?? null;

  // queryKey 加 selectedRef 维度:切 ref → 走新 query,不复用 HEAD 的缓存。
  // listFilesAtRef 在 ref 无效时会 reject(Err 字符串),由 React Query 进 isError 路径。
  const filesQ = useQuery({
    queryKey: ["blame_files", repoPath, selectedRef],
    queryFn: () => listFilesAtRef(selectedRef),
    staleTime: STALE_TIME_MS,
    enabled: !!repoPath,
    // ref 切换瞬时可能命中无效 ref,前端 UI 已先校验(ref selector 内部 verify),
    // 失败也不重试,避免无意义子进程压力。
    retry: false,
  });

  const blameQ = useQuery<BlameResult>({
    queryKey: ["blame", repoPath, selectedRef, parsed.file, parsed.range],
    queryFn: () =>
      getBlameAtRef(
        selectedRef,
        parsed.file as string,
        parsed.range ? [[parsed.range[0], parsed.range[1]]] : null,
      ),
    staleTime: STALE_TIME_MS,
    enabled: !!repoPath && !!parsed.file,
  });

  const fileQ = useQuery<ReadFileResult>({
    queryKey: ["read_file", repoPath, selectedRef, parsed.file],
    queryFn: () => readFileAtRef(selectedRef, parsed.file as string),
    staleTime: STALE_TIME_MS,
    enabled: !!repoPath && !!parsed.file,
  });

  const onSelectFile = (file: string) => {
    router.navigate("blame", buildBlameUrlParams(file, null));
  };

  /**
   * 切 ref 重置选中文件 + 行范围:
   * 不同 ref 下文件可能不存在 / 行号偏移,保留旧选择会让 FileView 闪 degraded,
   * 体验差;直接回到"未选文件"态由用户重新挑。
   */
  const onSelectRef = (next: BlameRef) => {
    setSelectedRef(next);
    router.navigate("blame", buildBlameUrlParams(null, null));
    setActiveClick(null);
  };

  const applyRange = () => {
    const trimmed = lInput.trim();
    if (!trimmed) {
      router.navigate("blame", buildBlameUrlParams(parsed.file, null));
      setLError(null);
      return;
    }
    const m = /^(\d+)\s*,\s*(\d+)$/.exec(trimmed);
    if (!m) {
      setLError(BLAME_TEXT.lrangeInvalid);
      return;
    }
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a < 1 || b < a) {
      setLError(BLAME_TEXT.lrangeInvalid);
      return;
    }
    setLError(null);
    router.navigate("blame", buildBlameUrlParams(parsed.file, [a, b]));
  };

  if (repoQ.data === null) {
    return (
      <EmptyState
        Icon={FolderOpen}
        title={BLAME_DEGRADED.repo_missing.title}
        description={BLAME_DEGRADED.repo_missing.description}
        ctaLabel={BLAME_DEGRADED.repo_missing.cta}
        onCta={() => router.navigate("repo")}
      />
    );
  }

  const filesData = filesQ.data ?? { files: [], truncated: false, total: 0 };
  // filesQ.error 一般来自 ref 无效(后端 `list_files_at_ref` 在 ref 不存在时 Err 返字符串)。
  // 透出文案而不静默吞 —— 与 no-fallback 原则对齐。
  const filesError = filesQ.isError ? (filesQ.error as Error).message : null;

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      <Header
        lInput={lInput}
        setLInput={setLInput}
        lError={lError}
        onApplyRange={applyRange}
        fileSelected={!!parsed.file}
        selectedRef={selectedRef}
        onSelectRef={onSelectRef}
      />
      {filesData.truncated && (
        <div className="border-b border-border bg-amber-50 px-3 py-1 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          仓库文件数 {filesData.total} 超出 {filesData.files.length} 上限,使用搜索过滤查找文件。
        </div>
      )}
      {filesError && (
        <div className="border-b border-border bg-red-50 px-3 py-1 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-300">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {filesError}
        </div>
      )}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <SplitPane
          storageKey="blame.fileTree.width"
          defaultLeftWidth={288}
          minLeftWidth={200}
          maxLeftWidth={560}
          left={
            <div className="h-full border-r border-border">
              <BlameFileTree
                files={filesData.files}
                selected={parsed.file}
                onSelect={onSelectFile}
              />
            </div>
          }
          right={
            !parsed.file ? (
              <BlameInstructions />
            ) : (
              <FileView
                file={parsed.file}
                blameQ={blameQ}
                fileQ={fileQ}
                theme={theme}
                activeClick={activeClick}
                setActiveClick={setActiveClick}
              />
            )
          }
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
  selectedRef,
  onSelectRef,
}: {
  lInput: string;
  setLInput: (v: string) => void;
  lError: string | null;
  onApplyRange: () => void;
  fileSelected: boolean;
  selectedRef: BlameRef;
  onSelectRef: (r: BlameRef) => void;
}) {
  const subline = selectedRef
    ? `基于 ${selectedRef} 的上游 blame-analysis 结果。`
    : "基于 HEAD 的上游 blame-analysis 结果。";
  return (
    <div className="space-y-2 border-b border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-foreground">Blame 行级</h1>
        <span className="text-[11px] text-muted-foreground">{subline}</span>

        <RefPicker selectedRef={selectedRef} onSelectRef={onSelectRef} />

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
                {BLAME_TEXT.lrangeLabel}:
              </label>
              <input
                id="lrange"
                type="text"
                value={lInput}
                onChange={(e) => setLInput(e.target.value)}
                placeholder={BLAME_TEXT.lrangePlaceholder}
                spellCheck={false}
                aria-invalid={lError !== null}
                className="w-24 rounded-md border border-border bg-card px-2 py-1 font-mono text-xs text-foreground shadow-xs focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-ring"
              />
              <button
                type="submit"
                className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary/90"
              >
                应用
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
 * Ref 选择器:Popover + Command 列本地分支,底部一个手贴 sha/tag 输入框。
 *
 * # 校验
 * 手贴入口在 submit 时不在前端做语法校验(后端 `git rev-parse --verify <ref>^{commit}`
 * 才是权威);后端返 `RefNotFound` 时 toast + 输入框红字。当前先信任后端 — 用户提交一次
 * 拿到 degraded 后,会通过 filesQ.error / blame degraded 看到错误反馈。
 *
 * # 与 TopBar BranchSwitcher 区别
 * - 这里**不切实际工作树**,只切 blame 视角;BranchSwitcher 调 `git checkout` 真切。
 * - 接受任意 commit-ish(sha / tag);BranchSwitcher 仅本地分支。
 */
function RefPicker({
  selectedRef,
  onSelectRef,
}: {
  selectedRef: BlameRef;
  onSelectRef: (r: BlameRef) => void;
}) {
  const [open, setOpen] = useState(false);
  const [shaInput, setShaInput] = useState("");
  const [shaError, setShaError] = useState<string | null>(null);

  const branchesQ = useQuery<ListBranchesResult>({
    queryKey: ["list_branches"],
    queryFn: listBranches,
    staleTime: 10_000,
    enabled: open,
  });

  const branches = branchesQ.data?.status === "ok" ? branchesQ.data.branches : [];
  const label = selectedRef ?? BLAME_REF_PICKER.current_head;

  const submitSha = () => {
    const v = shaInput.trim();
    if (!v) {
      setShaError(BLAME_REF_PICKER.sha_empty);
      return;
    }
    setShaError(null);
    setOpen(false);
    setShaInput("");
    onSelectRef(v);
  };

  const reset = () => {
    setOpen(false);
    setShaError(null);
    setShaInput("");
    onSelectRef(null);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={BLAME_REF_PICKER.trigger_title}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
            "border-border bg-card text-foreground hover:bg-slate-50 dark:hover:bg-slate-800",
          )}
        >
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">{BLAME_REF_PICKER.label}</span>
          <span className="max-w-[160px] truncate font-mono">{label}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] max-w-none p-0">
        <Command>
          {branches.length > REF_SEARCH_THRESHOLD && (
            <CommandInput placeholder={BLAME_REF_PICKER.search_branches_placeholder} />
          )}
          <CommandList>
            <CommandEmpty>{BLAME_REF_PICKER.no_branches}</CommandEmpty>
            <CommandGroup>
              {/* 回到 HEAD:始终展示,等价 selectedRef = null。 */}
              <CommandItem
                value="__head__"
                onSelect={reset}
                className="flex items-center justify-between"
              >
                <span className="flex items-center gap-1.5">
                  {selectedRef === null ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <span className="h-3 w-3" aria-hidden="true" />
                  )}
                  <span className="font-mono">{BLAME_REF_PICKER.current_head}</span>
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {BLAME_REF_PICKER.reset_to_head}
                </span>
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading={BLAME_REF_PICKER.branches_heading}>
              {branchesQ.isLoading && (
                <div className="px-2 py-1 text-xs text-muted-foreground">
                  {BLAME_REF_PICKER.branches_loading}
                </div>
              )}
              {branchesQ.isError && (
                <div className="px-2 py-1 text-xs text-red-600 dark:text-red-400">
                  {BLAME_REF_PICKER.branches_failed}
                </div>
              )}
              {!branchesQ.isLoading && !branchesQ.isError && branches.length === 0 && (
                <div className="px-2 py-1 text-xs text-muted-foreground">
                  {BLAME_REF_PICKER.no_branches}
                </div>
              )}
              {branches.map((b) => {
                const active = selectedRef === b.name;
                return (
                  <CommandItem
                    key={b.name}
                    value={b.name}
                    onSelect={() => {
                      setOpen(false);
                      onSelectRef(b.name);
                    }}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {active ? (
                        <Check className="h-3 w-3 shrink-0 text-emerald-500" />
                      ) : (
                        <span className="h-3 w-3 shrink-0" aria-hidden="true" />
                      )}
                      <span className="truncate font-mono">{b.name}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {b.sha.slice(0, 7)}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        <div className="border-t border-border p-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {BLAME_REF_PICKER.sha_input_heading}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitSha();
            }}
            className="flex gap-1"
          >
            <input
              type="text"
              value={shaInput}
              onChange={(e) => {
                setShaInput(e.target.value);
                setShaError(null);
              }}
              placeholder={BLAME_REF_PICKER.sha_input_placeholder}
              spellCheck={false}
              aria-invalid={shaError !== null}
              className="flex-1 rounded-md border border-border bg-card px-2 py-1 font-mono text-xs text-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-ring"
            />
            <button
              type="submit"
              className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary/90"
            >
              {BLAME_REF_PICKER.sha_apply}
            </button>
          </form>
          {shaError && (
            <div className="mt-1 text-[10px] text-red-600 dark:text-red-400">{shaError}</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BlameInstructions() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-10 text-sm text-muted-foreground">
      <div className="mb-2 font-medium text-foreground">从左侧选择一个文件</div>
      <p className="max-w-md text-center text-xs text-muted-foreground">
        AI 行渲染为蓝条 + 浅色背景;非 AI 行无色块。点击行号 gutter 上的蓝条展开 prompt 摘要。
      </p>
    </div>
  );
}

function FileView({
  file,
  blameQ,
  fileQ,
  theme,
  activeClick,
  setActiveClick,
}: {
  file: string;
  blameQ: ReturnType<typeof useQuery<BlameResult>>;
  fileQ: ReturnType<typeof useQuery<ReadFileResult>>;
  theme: "light" | "dark";
  activeClick: BlameLineClickEvent | null;
  setActiveClick: (e: BlameLineClickEvent | null) => void;
}) {
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

  // 每行作者:hunks 给出 commit-level author,aiLines 给出 AI prompt → tool/human。
  // AI 行优先用 prompt 的 tool 简称 + human;非 AI 行 fallback 到 hunk 的 original_author。
  // 这是上游 git-ai blame-analysis --json 一次性给的数据,无需再调原生 git blame。
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
        const promptId = aiLines.get(n);
        if (promptId) {
          const prompt = blamePayload.prompts[promptId];
          const tool = prompt?.agent_id.tool ?? "ai";
          const model = prompt?.agent_id.model ?? tool;
          const label = model;
          m.set(n, {
            label,
            tone: "ai",
            title: prompt ? `AI: ${tool}::${model}` : "AI",
          });
        } else {
          const label = hunk.original_author || "(unknown)";
          m.set(n, {
            label,
            tone: "human",
            title: baseTitle,
          });
        }
      }
    }
    return m;
  }, [blamePayload, aiLines]);

  if (fileQ.isLoading || blameQ.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中…
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
          onLineClick={setActiveClick}
        />
      </div>
      <PromptPopover
        click={activeClick}
        prompts={blamePayload?.prompts ?? {}}
        metadata={blamePayload?.metadata ?? { is_logged_in: false, current_user: null }}
        onClose={() => setActiveClick(null)}
      />
      <Legend />
    </div>
  );
}

function NoAiAuthorshipBanner() {
  const copy = BLAME_DEGRADED.no_ai_authorship;
  return (
    <div className="flex items-start gap-2 border-b border-border bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:bg-card/40 dark:text-slate-300">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div>
        <span className="font-medium">{copy.title}</span> — {copy.description}
        <div className="mt-1 text-[10px] text-muted-foreground">{BLAME_POPOVER.merge_caveat}</div>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <span className="inline-block h-2 w-2 rounded-xs bg-primary/100" />
        {BLAME_LINE_LEGEND.ai}
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-2 w-2 rounded-xs border border-border bg-card" />
        {BLAME_LINE_LEGEND.non_ai}
      </span>
    </div>
  );
}

function PromptPopover({
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
  const record = click ? prompts[click.promptId] : null;
  const open = click !== null && !!record;

  if (!open || !record || !click) return null;

  return (
    <Popover open={open} onOpenChange={(o) => !o && onClose()}>
      <PopoverAnchor asChild>
        <span
          style={{
            position: "fixed",
            left: click.rect.x,
            top: click.rect.y,
            width: 4,
            height: Math.max(1, click.rect.bottom - click.rect.y),
            pointerEvents: "none",
          }}
        />
      </PopoverAnchor>
      <PopoverContent className="w-96" side="right" align="start">
        <PromptDetails record={record} lineNumber={click.lineNumber} metadata={metadata} />
      </PopoverContent>
    </Popover>
  );
}

function PromptDetails({
  record,
  lineNumber,
  metadata,
}: {
  record: BlamePromptRecord;
  lineNumber: number;
  metadata: BlamePayload["metadata"];
}) {
  const toolModel = `${record.agent_id.tool}::${record.agent_id.model}`;
  const moreFiles = record.other_files.length > 5;
  const shownFiles = moreFiles ? record.other_files.slice(0, 5) : record.other_files;
  const hiddenFiles = moreFiles ? record.other_files.slice(5) : [];
  return (
    <div className="space-y-2 text-xs">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {BLAME_POPOVER.prompt_heading} · 第 {lineNumber} 行
        </div>
        <div className="font-mono text-foreground">{toolModel}</div>
        {record.human_author && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {BLAME_POPOVER.human_label}:{record.human_author}
          </div>
        )}
        {!record.human_author && !metadata.is_logged_in && (
          <div className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-300">
            {BLAME_POPOVER.login_required}
          </div>
        )}
      </div>

      <div className="rounded-sm border border-amber-200 bg-amber-50 p-2 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
        <div className="text-[10px] font-semibold uppercase tracking-wide">
          {BLAME_POPOVER.scope_warning_repo_wide}
        </div>
        <div className="mt-1 font-mono text-[11px]">
          {BLAME_POPOVER.accepted(record.accepted_lines)} ·{" "}
          {BLAME_POPOVER.overriden(record.overriden_lines)} ·{" "}
          {BLAME_POPOVER.total_additions(record.total_additions)} ·{" "}
          {BLAME_POPOVER.total_deletions(record.total_deletions)}
        </div>
      </div>

      {record.other_files.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {BLAME_POPOVER.other_files_heading}
          </div>
          <ul className="mt-0.5 space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {shownFiles.map((f) => (
              <li key={f} className="truncate" title={f}>
                {f}
              </li>
            ))}
            {moreFiles && (
              <li className="text-[10px] text-muted-foreground" title={hiddenFiles.join("\n")}>
                {BLAME_POPOVER.other_files_more(hiddenFiles.length)}
              </li>
            )}
          </ul>
        </div>
      )}

      {record.commits.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {BLAME_POPOVER.commits_heading}
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
        <div>{BLAME_POPOVER.drift_caveat}</div>
        <div>{BLAME_POPOVER.merge_caveat}</div>
      </div>
    </div>
  );
}

function FileDegraded({ reason }: { reason: BlameDegradedReason }) {
  const router = useRouter();
  let title = "无法显示文件";
  let description: React.ReactNode = "";
  let ctaLabel: string | undefined;
  let onCta: (() => void) | undefined;
  switch (reason.kind) {
    case "repo_missing": {
      const c = BLAME_DEGRADED.repo_missing;
      title = c.title;
      description = c.description;
      ctaLabel = c.cta;
      onCta = () => router.navigate("repo");
      break;
    }
    case "git_ai_missing": {
      const c = BLAME_DEGRADED.git_ai_missing;
      title = c.title;
      description = c.description;
      ctaLabel = c.cta;
      onCta = () => router.navigate("install");
      break;
    }
    case "no_head": {
      title = BLAME_DEGRADED.no_head.title;
      description = BLAME_DEGRADED.no_head.description;
      break;
    }
    case "commit_not_found": {
      title = BLAME_DEGRADED.commit_not_found.title;
      description = BLAME_DEGRADED.commit_not_found.description_template(reason.sha);
      break;
    }
    case "file_not_in_head": {
      title = BLAME_DEGRADED.file_not_in_head.title;
      description = BLAME_DEGRADED.file_not_in_head.description_template(reason.file);
      break;
    }
    case "file_too_large": {
      title = BLAME_DEGRADED.file_too_large.title;
      description = BLAME_DEGRADED.file_too_large.description_template(reason.size, reason.limit);
      break;
    }
    case "file_binary": {
      title = BLAME_DEGRADED.file_binary.title;
      description = BLAME_DEGRADED.file_binary.description;
      break;
    }
    case "ref_not_found": {
      title = BLAME_REF_PICKER.ref_not_found_title;
      description = BLAME_REF_PICKER.ref_not_found_template(reason.ref);
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
  return (
    <div className="m-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
      Blame 失败:{message}
    </div>
  );
}
