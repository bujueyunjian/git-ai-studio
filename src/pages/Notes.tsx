// Notes 页(P7):git notes --ref=ai 列表 + authorship/3.0.0 详情可视化。
//
// # 权威口径
// - 字段对齐 git-ai/specs/git_ai_standard_v3.0.0.md §1.2
// - 实现镜像 git-ai/src/authorship/authorship_log_serialization.rs:28-37
//
// # 路由
// `#/notes` 或 `#/notes/<sha>`(刷新可恢复选中 sha;格式合法性由后端校验)
//
// # 数据流
// - list_ai_notes 一次拉全量富化(commit_sha + short + committed_at + subject + note_oid)
// - show_ai_note(sha) 按选中 sha 拉单 note 全量解析
// - queryKey 含 repo_path + sha + note_oid(后者保证 rewrite-authorship 后 cache 失效)
// - staleTime 30s,与 P5/P6 节奏一致
//
// # eager(评审 C §F17)
// 本页不挂 CodeMirror / 大依赖,~5-8KB gzip 增量;**不**走 lazy import,与 Stats/Dashboard 一致。

import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, FileJson, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "../components/EmptyState";
import { NoteDetail } from "../components/NoteDetail";
import { NotesList } from "../components/NotesList";
import { listAiNotes, showAiNote } from "../lib/api";
import type { NotesListResult, ShowNoteResult } from "../lib/types";
import { useRouter } from "../router";

const STALE_TIME_MS = 30_000;

/** 简单合法性校验:sha 路径段必须是 7-64 位 hex;不合法则视为未选。 */
function sanitizeSha(s: string | undefined): string | null {
  if (!s) return null;
  return /^[0-9a-fA-F]{7,64}$/.test(s) ? s : null;
}

export default function NotesPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const selectedSha = sanitizeSha(router.params);

  const listQ = useQuery<NotesListResult>({
    queryKey: ["list_ai_notes"],
    queryFn: () => listAiNotes(),
    staleTime: STALE_TIME_MS,
  });

  const payload = listQ.data?.status === "ok" ? listQ.data.payload : null;
  const noteOidLookup = useMemo(() => {
    const m = new Map<string, string>();
    if (payload) {
      for (const n of payload.notes) m.set(n.commit_sha, n.note_oid);
    }
    return m;
  }, [payload]);

  const selectedMeta = useMemo(() => {
    if (!payload || !selectedSha) return null;
    return payload.notes.find((n) => n.commit_sha === selectedSha) ?? null;
  }, [payload, selectedSha]);

  const showQ = useQuery<ShowNoteResult>({
    queryKey: [
      "show_ai_note",
      payload?.repo_path ?? "",
      selectedSha ?? "",
      noteOidLookup.get(selectedSha ?? "") ?? "",
    ],
    queryFn: () => showAiNote(selectedSha as string),
    enabled: !!selectedSha && !!payload,
    staleTime: STALE_TIME_MS,
  });

  // 若用户手贴 URL 到一个不在 list 里的 sha,清掉 URL params(避免一直跳错)。
  useEffect(() => {
    if (!listQ.data || listQ.data.status !== "ok") return;
    if (!router.params) return;
    const valid = sanitizeSha(router.params);
    if (!valid) {
      router.navigate("notes");
      return;
    }
    const exists = listQ.data.payload.notes.some((n) => n.commit_sha === valid);
    if (!exists) router.navigate("notes");
  }, [listQ.data, router]);

  // ===== degraded =====
  if (listQ.data?.status === "degraded") {
    const reason = listQ.data.reason;
    if (reason.kind === "repo_missing") {
      return (
        <EmptyState
          Icon={FolderOpen}
          title={t("notes.degraded.repoMissing.title")}
          description={t("notes.degraded.repoMissing.description")}
          ctaLabel={t("notes.degraded.repoMissing.cta")}
          onCta={() => router.navigate("repo")}
        />
      );
    }
    return (
      <EmptyState
        Icon={Activity}
        title={t("notes.degraded.noNotesInRepo.title")}
        description={t("notes.degraded.noNotesInRepo.description")}
        ctaLabel={t("notes.degraded.noNotesInRepo.cta")}
        onCta={() => router.navigate("hooks")}
        tone="amber"
      />
    );
  }

  if (listQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在读取 git notes --ref=ai…
      </div>
    );
  }
  if (listQ.isError) {
    return (
      <div className="p-6">
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          列表加载失败:{(listQ.error as Error).message}
        </div>
      </div>
    );
  }
  if (!payload) return null;

  return (
    <div className="flex h-full flex-col">
      {payload.unreachable_shas.length > 0 && <UnreachableBanner shas={payload.unreachable_shas} />}
      <div className="flex flex-1 min-h-0">
        <NotesList
          notes={payload.notes}
          selectedSha={selectedSha}
          onSelect={(sha) => router.navigate("notes", sha)}
        />
        <div className="flex-1 overflow-y-auto">
          {!selectedSha || !selectedMeta ? (
            <Instructions />
          ) : showQ.isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在解析 authorship log…
            </div>
          ) : showQ.isError ? (
            <ParseFailed message={(showQ.error as Error).message} />
          ) : showQ.data?.status === "ok" ? (
            <NoteDetail
              log={showQ.data.payload.log}
              meta={selectedMeta}
              headSha={payload.head_sha}
              onNavigate={(route, params) => router.navigate(route, params)}
            />
          ) : (
            <CommitNoNote onViewStats={() => router.navigate("stats", selectedSha)} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * notes ref 引用但本地仓库不存在的 sha banner。
 * 用户看到这个,意味着需要 git fetch(或这些 commit 已被仓库维护者 GC 但 note 还留着)。
 * 不展示占位条目,只在列表顶部提示真相 —— 不存在就明说不存在。
 */
function UnreachableBanner({ shas }: { shas: string[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="flex-1">
          <div>
            <span className="font-medium">{shas.length}</span> 条 ai notes 引用的 commit
            在本地仓库不存在,无法展示。 常见原因:协作 push 了 notes 但 commit 未抵达本地、shallow
            clone、或仓库做过历史重写。 可尝试 <code className="font-mono">git fetch</code> 后刷新。
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 underline-offset-2 hover:underline"
          >
            {expanded ? "收起 sha 列表" : "展开查看 sha 列表"}
          </button>
          {expanded && (
            <ul className="mt-1.5 max-h-32 overflow-y-auto rounded-sm border border-amber-200 bg-white/60 p-1.5 font-mono text-[11px] dark:border-amber-900/40 dark:bg-amber-950/40">
              {shas.map((s) => (
                <li key={s} className="truncate">
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Instructions() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="max-w-md rounded-lg border border-slate-200 bg-white p-8 text-center shadow-xs dark:border-border dark:bg-card">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800">
          <FileJson className="h-7 w-7" />
        </div>
        <div className="mt-4 text-lg font-semibold">{t("notes.instructions.title")}</div>
        <div className="mt-2 text-sm text-slate-500">{t("notes.instructions.description")}</div>
      </div>
    </div>
  );
}

function CommitNoNote({ onViewStats }: { onViewStats: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      Icon={FileJson}
      title={t("notes.commitNoNote.title")}
      description={t("notes.commitNoNote.description")}
      ctaLabel={t("notes.commitNoNote.viewStats")}
      onCta={onViewStats}
      tone="neutral"
    />
  );
}

function ParseFailed({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="p-6">
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
        <div className="font-medium">{t("notes.parseFailed.title")}</div>
        <div className="mt-1 text-xs">{t("notes.parseFailed.description")}</div>
        <details className="mt-3 rounded-md border border-amber-300 bg-white px-3 py-2 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-card dark:text-amber-200">
          <summary className="cursor-pointer font-medium">
            {t("notes.parseFailed.rawLabel")}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap wrap-break-word font-mono">{message}</pre>
        </details>
      </div>
    </div>
  );
}
