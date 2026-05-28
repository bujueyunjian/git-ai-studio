import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clock,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Badge } from "../components/Badge";
import { Tooltip } from "../components/ui/TooltipBubble";
import {
  currentRepo as currentRepoApi,
  discoverRepos,
  listRecentRepos,
  listScanRoots,
  openInExplorer,
  selectRepo,
  setScanRoots,
} from "../lib/api";
import { cn } from "../lib/cn";
import { pickDirectory } from "../lib/pickDirectory";
import type { RepoEntry } from "../lib/types";
import { useRepoChanged } from "../lib/useRepoChanged";

export default function RepoPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const handleRepoChanged = useRepoChanged();
  const [filter, setFilter] = useState("");
  const [newRoot, setNewRoot] = useState("");
  const [openingPath, setOpeningPath] = useState<string | null>(null);

  // 当前选中仓库,用于列表里高亮"当前"行。staleTime 与 TopBar 一致,共享缓存。
  const currentRepoQ = useQuery({
    queryKey: ["current_repo"],
    queryFn: currentRepoApi,
    staleTime: 5_000,
  });
  const currentPath = currentRepoQ.data?.path ?? null;
  const rootsQ = useQuery({ queryKey: ["scan_roots"], queryFn: listScanRoots, staleTime: 60_000 });
  const recentQ = useQuery({
    queryKey: ["recent_repos"],
    queryFn: listRecentRepos,
    staleTime: 30_000,
  });
  const reposQ = useQuery({
    queryKey: ["repos", rootsQ.data],
    queryFn: () => discoverRepos(rootsQ.data ?? [], 4),
    staleTime: 30_000,
    enabled: !!rootsQ.data,
  });

  const setRootsM = useMutation({
    mutationFn: setScanRoots,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scan_roots"] });
      qc.invalidateQueries({ queryKey: ["repos"] });
    },
    onError: (e) =>
      toast.error(t("repo.toast.saveRootsFailed"), { description: (e as Error).message }),
  });
  const pickM = useMutation({
    mutationFn: selectRepo,
    onSuccess: (entry) => {
      toast.success(t("repo.toast.switched"), { description: entry.path });
      // 切仓 = 全局副作用,统一走 hook(invalidate + URL reset 一次到位)。
      // 不再自动跳到 Diagnostic 页:UX 一致性(TopBar 切仓也不跳页),degraded 文案兜底就够。
      handleRepoChanged();
    },
    onError: (e) =>
      toast.error(t("repo.toast.switchFailed"), { description: (e as Error).message }),
  });

  const filtered = useMemo(() => {
    const all = reposQ.data ?? [];
    if (!filter.trim()) return all;
    const q = filter.toLowerCase();
    return all.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
  }, [reposQ.data, filter]);

  function addRoot() {
    const r = newRoot.trim();
    if (!r) return;
    const next = Array.from(new Set([...(rootsQ.data ?? []), r]));
    setRootsM.mutate(next);
    setNewRoot("");
  }
  function removeRoot(r: string) {
    setRootsM.mutate((rootsQ.data ?? []).filter((x) => x !== r));
  }
  async function openRepoInExplorer(path: string) {
    setOpeningPath(path);
    try {
      await openInExplorer(path);
    } catch (e) {
      toast.error(t("repo.toast.openFolderFailed"), { description: (e as Error).message });
    } finally {
      setOpeningPath((current) => (current === path ? null : current));
    }
  }

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">{t("repo.title")}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("repo.subtitle")}</p>
      </div>

      {/* 扫描根目录 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">{t("repo.scanRoots.title")}</h2>
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ["repos"] })}
            disabled={reposQ.isFetching}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", reposQ.isFetching && "animate-spin")} />{" "}
            {t("repo.scanRoots.rescan")}
          </button>
        </div>
        {(rootsQ.data ?? []).length === 0 && (
          <p className="mb-2 text-xs text-muted-foreground">
            {t("repo.scanRoots.emptyHint")} <span className="font-mono">D:\script</span>。
          </p>
        )}
        <ul className="mb-3 space-y-1">
          {(rootsQ.data ?? []).map((r) => (
            <li
              key={r}
              className="flex items-center justify-between rounded-sm border border-border px-2 py-1 text-xs dark:border-border"
            >
              <span className="truncate font-mono">{r}</span>
              <button
                onClick={() => removeRoot(r)}
                className="ml-2 inline-flex items-center gap-1 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-rose-500 dark:hover:bg-muted"
                title={t("repo.scanRoots.remove")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <div className="space-y-2">
          {/* 主行动:原生目录选择器 + 显示已选 + 添加 */}
          <div className="flex gap-2">
            <button
              onClick={async () => {
                try {
                  const picked = await pickDirectory(t("repo.scanRoots.pickDialogTitle"));
                  if (picked) setNewRoot(picked);
                } catch (e) {
                  toast.error(t("repo.toast.openPickerFailed"), {
                    description: (e as Error).message,
                  });
                }
              }}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted dark:border-border dark:hover:bg-muted"
            >
              <FolderOpen className="h-3 w-3" /> {t("repo.scanRoots.pickDir")}
            </button>
            <div className="flex-1 truncate rounded-sm border border-dashed border-border bg-card px-2 py-1 font-mono text-xs text-muted-foreground dark:border-border dark:bg-card dark:text-neutral-300">
              {newRoot.trim() ? (
                newRoot
              ) : (
                <span className="text-muted-foreground">{t("repo.scanRoots.noDirPicked")}</span>
              )}
            </div>
            <button
              onClick={addRoot}
              disabled={!newRoot.trim() || setRootsM.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Plus className="h-3 w-3" /> {t("repo.scanRoots.add")}
            </button>
          </div>
          {/* Fallback:手动粘路径(默认折叠) */}
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">{t("repo.scanRoots.pasteAdvanced")}</summary>
            <input
              value={newRoot}
              onChange={(e) => setNewRoot(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addRoot()}
              placeholder={t("repo.scanRoots.pastePlaceholder")}
              className="mt-1 w-full rounded-sm border border-border bg-card px-2 py-1 font-mono text-xs dark:border-border dark:bg-card"
            />
          </details>
        </div>
      </section>

      {/* 最近打开 */}
      {(recentQ.data?.length ?? 0) > 0 && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
            <Clock className="h-4 w-4 text-muted-foreground" /> {t("repo.recent.title")}
          </h2>
          <ul className="space-y-1">
            {(recentQ.data ?? []).slice(0, 5).map((p) => {
              const isCurrent = !!currentPath && currentPath.toLowerCase() === p.toLowerCase();
              return (
                <li key={p}>
                  <button
                    onClick={() => pickM.mutate(p)}
                    disabled={isCurrent || (pickM.isPending && pickM.variables === p)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-sm border px-2 py-1.5 text-left text-xs",
                      isCurrent
                        ? "border-primary bg-primary/10 dark:border-primary dark:bg-primary/10"
                        : "border-border hover:bg-muted dark:border-border dark:hover:bg-muted",
                    )}
                  >
                    <span className="truncate">{p}</span>
                    {isCurrent ? (
                      <Badge tone="info">{t("repo.current")}</Badge>
                    ) : (
                      <span className="text-muted-foreground">{t("repo.recent.open")}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* 全部仓库 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            {t("repo.all.title")}
            {reposQ.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : (
              <Badge tone="neutral">{filtered.length}</Badge>
            )}
          </h2>
          <div className="relative w-64">
            <Search className="absolute left-2 top-1.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("repo.all.filterPlaceholder")}
              className="w-full rounded-sm border border-border bg-card py-1 pl-7 pr-2 text-xs dark:border-border dark:bg-card"
            />
          </div>
        </div>
        {filtered.length === 0 && !reposQ.isFetching && (
          <div className="rounded-sm border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground dark:border-border">
            {t("repo.all.empty")}
          </div>
        )}
        <ul className="divide-y divide-border">
          {filtered.map((r) => (
            <RepoRow
              key={r.path}
              repo={r}
              isCurrent={!!currentPath && currentPath.toLowerCase() === r.path.toLowerCase()}
              selecting={pickM.isPending && pickM.variables === r.path}
              onSelect={() => pickM.mutate(r.path)}
              opening={openingPath === r.path}
              onOpen={() => openRepoInExplorer(r.path)}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function RepoRow({
  repo,
  isCurrent,
  selecting,
  opening,
  onSelect,
  onOpen,
}: {
  repo: RepoEntry;
  isCurrent: boolean;
  selecting: boolean;
  opening: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const rowDisabled = isCurrent || selecting;
  return (
    <li
      className={cn(
        "group -mx-2 flex items-center gap-3 rounded-sm px-2 py-2.5",
        isCurrent
          ? "cursor-default bg-primary/5 ring-1 ring-inset ring-ring dark:bg-primary/10 dark:ring-ring"
          : "hover:bg-muted/40",
        selecting && "pointer-events-none opacity-70",
      )}
    >
      <FolderGit2 className={cn("h-4 w-4", isCurrent ? "text-primary" : "text-muted-foreground")} />
      <button
        type="button"
        onClick={() => {
          if (!rowDisabled) onSelect();
        }}
        disabled={rowDisabled}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{repo.name}</span>
          {isCurrent && <Badge tone="info">{t("repo.current")}</Badge>}
          {repo.head_branch && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <GitBranch className="h-3 w-3" /> {repo.head_branch}
            </span>
          )}
          {repo.head_sha && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {repo.head_sha.slice(0, 7)}
            </span>
          )}
          {repo.dirty === true && <Badge tone="warn">{t("repo.row.dirty")}</Badge>}
          {repo.has_git_ai_dir && repo.working_logs_count > 0 && (
            <Badge tone="info">
              {t("repo.row.checkpointCount", { n: repo.working_logs_count })}
            </Badge>
          )}
          {repo.has_git_ai_dir && repo.working_logs_count === 0 && (
            <Badge tone="neutral">{t("repo.row.gitAiEmpty")}</Badge>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{repo.path}</div>
      </button>
      <Tooltip content={t("repo.row.openInExplorer")}>
        <button
          type="button"
          onClick={onOpen}
          disabled={opening}
          className="inline-flex rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-60 dark:hover:bg-muted"
        >
          {opening ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FolderOpen className="h-3.5 w-3.5" />
          )}
        </button>
      </Tooltip>
      <button
        type="button"
        onClick={() => {
          if (!isCurrent) onSelect();
        }}
        disabled={rowDisabled}
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium",
          isCurrent
            ? "cursor-default bg-muted text-muted-foreground"
            : "bg-primary/10 text-primary hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-primary/10 dark:text-primary dark:hover:bg-primary/20",
        )}
      >
        {selecting && <Loader2 className="h-3 w-3 animate-spin" />}
        {isCurrent
          ? t("repo.row.selected")
          : selecting
            ? t("repo.row.switching")
            : t("repo.row.select")}
      </button>
    </li>
  );
}
