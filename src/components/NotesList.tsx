// P7 Notes 页左侧 commit 列表。
//
// # 设计
// - 顶部搜索框:sha 前缀(不区分大小写)**或** subject 包含,任一命中即保留
// - 列表项:short_sha · subject 截断 · 本地化日期
// - 选中态用 bg-blue 背景,激活态键盘可达(button + focus-visible ring)
// - 不引入虚拟列表;典型 N <= 几千项,ScrollArea 即可

import { useMemo, useState } from "react";

import { NOTES_TEXT } from "../lib/copy";
import { cn } from "../lib/cn";
import type { NoteListEntry } from "../lib/types";

export interface NotesListProps {
  notes: NoteListEntry[];
  selectedSha: string | null;
  onSelect: (sha: string) => void;
}

export function NotesList({ notes, selectedSha, onSelect }: NotesListProps) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (n) =>
        n.commit_sha.toLowerCase().startsWith(q) ||
        n.short_sha.toLowerCase().startsWith(q) ||
        n.subject.toLowerCase().includes(q),
    );
  }, [notes, filter]);

  return (
    <div className="flex h-full w-[280px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-background">
      <div className="p-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={NOTES_TEXT.searchPlaceholder}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs shadow-xs focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-ring dark:border-border dark:bg-card"
        />
        <div className="mt-1 text-[10px] text-slate-400">
          {filtered.length} / {notes.length} 条
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {filtered.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-slate-400">{NOTES_TEXT.listEmpty}</div>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((n) => (
              <li key={n.commit_sha}>
                <NoteRow
                  entry={n}
                  active={selectedSha === n.commit_sha}
                  onSelect={() => onSelect(n.commit_sha)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NoteRow({
  entry,
  active,
  onSelect,
}: {
  entry: NoteListEntry;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "block w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-primary/10 text-primary dark:bg-primary/10 dark:text-primary"
          : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
      )}
      aria-current={active ? "true" : undefined}
    >
      <div className="flex items-center gap-2">
        <code className="font-mono text-[11px] text-muted-foreground">{entry.short_sha}</code>
        <span className="ml-auto text-[10px] text-slate-400">
          {entry.committed_at.slice(0, 10)}
        </span>
      </div>
      <div className="mt-0.5 line-clamp-2 wrap-break-word text-[12px]">{entry.subject}</div>
    </button>
  );
}
