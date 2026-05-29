// P8 Checkpoints 单条 Card。
//
// # 设计要点
// - kind chip 色盲友好(icon + 文字 label)
// - 相对时间(`Intl.RelativeTimeFormat`)+ 绝对时间 tooltip
// - 默认折叠;父组件控制 `defaultOpen`(列表首条传 true 让用户进页有可见内容)
// - file_path 不做主链接;HEAD-only 时显示 "在 Blame 中查看 HEAD" 辅助按钮 + caveat tooltip
// - diff 默认折叠,显示行数预览(monospace pre,不上 CodeMirror)
// - agent_metadata 默认折叠(评审 C E19 隐私护栏)
// - line_attribution 用 `<table>` 语义(评审 C I29)

import {
  Bot,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Sparkles,
  User,
  UserCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { JsonTree } from "./JsonTree";
import { cn } from "../lib/cn";
import type { Checkpoint, CheckpointKind } from "../lib/types";

const KIND_ICONS: Record<CheckpointKind, LucideIcon> = {
  Human: User,
  AiAgent: Bot,
  AiTab: Sparkles,
  KnownHuman: UserCheck,
};

/**
 * icon/tone 是 UI 常量，与文案无关，从 copy.ts 搬至此处。
 * i18nKey 是该 kind 在 locales 中的段名（对齐 copy.ts 里 checkpoints.kind.<i18nKey>.label/tooltip）。
 * label/tooltip 在组件内通过 t(`checkpoints.kind.${i18nKey}.label`) 动态取值。
 */
const CHECKPOINT_KIND_META: Record<
  CheckpointKind,
  { icon: string; tone: "human" | "ai_agent" | "ai_tab" | "known_human"; i18nKey: string }
> = {
  Human: { icon: "User", tone: "human", i18nKey: "human" },
  AiAgent: { icon: "Bot", tone: "ai_agent", i18nKey: "aiAgent" },
  AiTab: { icon: "Sparkles", tone: "ai_tab", i18nKey: "aiTab" },
  KnownHuman: { icon: "UserCheck", tone: "known_human", i18nKey: "knownHuman" },
};

const KIND_TONE_CLASS: Record<CheckpointKind, string> = {
  Human:
    "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800",
  AiAgent:
    "bg-primary/10 text-primary ring-ring dark:bg-primary/10 dark:text-primary dark:ring-ring",
  AiTab:
    "bg-purple-50 text-purple-700 ring-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:ring-purple-800",
  KnownHuman:
    "bg-slate-100 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
};

const RTF = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

function formatRelative(unixSec: number, now: number): string {
  const diffSec = unixSec - now / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 60) return RTF.format(Math.round(diffSec), "second");
  if (abs < 3600) return RTF.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return RTF.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86400 * 30) return RTF.format(Math.round(diffSec / 86400), "day");
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

function formatAbsolute(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface CheckpointCardProps {
  checkpoint: Checkpoint;
  isHead: boolean;
  /** 当前 unix ms,用于相对时间(父组件每分钟刷新一次)。 */
  now: number;
  defaultOpen?: boolean;
  onOpenBlame: (file: string) => void;
}

export function CheckpointCard({
  checkpoint: cp,
  isHead,
  now,
  defaultOpen = false,
  onOpenBlame,
}: CheckpointCardProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const kindMeta = CHECKPOINT_KIND_META[cp.kind];
  const Icon = KIND_ICONS[cp.kind];

  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-xs dark:border-border dark:bg-card">
      <header className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? t("checkpoints.card.collapse") : t("checkpoints.card.expand")}
          className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
            KIND_TONE_CLASS[cp.kind],
          )}
          title={t(`checkpoints.kind.${kindMeta.i18nKey}.tooltip` as never)}
        >
          <Icon className="h-3 w-3" />
          {t(`checkpoints.kind.${kindMeta.i18nKey}.label` as never)}
        </span>
        <code className="font-mono text-xs text-foreground/80">{cp.author}</code>
        {cp.agent_id && (
          <code className="font-mono text-[11px] text-muted-foreground">
            · {cp.agent_id.tool}::{cp.agent_id.model}
          </code>
        )}
        <time
          dateTime={new Date(cp.timestamp * 1000).toISOString()}
          title={formatAbsolute(cp.timestamp)}
          className="ml-auto text-[11px] text-slate-500"
        >
          {formatRelative(cp.timestamp, now)}
        </time>
      </header>

      <div className="border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-500 dark:border-border">
        <span className="font-mono">
          {t("checkpoints.card.lineStatsTemplate", {
            a: cp.line_stats.additions,
            d: cp.line_stats.deletions,
            as: cp.line_stats.additions_sloc,
            ds: cp.line_stats.deletions_sloc,
          })}
        </span>
        <span className="ml-3 text-slate-400">
          {cp.entries.length} entries · {t("checkpoints.card.apiVersionLabel")}{" "}
          {cp.api_version || "—"}
        </span>
        {cp.trace_id && (
          <code className="ml-3 font-mono text-[10px] text-slate-400">
            {t("checkpoints.card.traceIdLabel")}: {cp.trace_id.slice(0, 10)}
          </code>
        )}
      </div>

      {open && (
        <div className="space-y-3 border-t border-slate-100 px-3 py-3 dark:border-border">
          {cp.known_human_metadata && <KnownHumanMetaBlock meta={cp.known_human_metadata} />}
          {cp.agent_metadata && Object.keys(cp.agent_metadata).length > 0 && (
            <AgentMetadataBlock metadata={cp.agent_metadata} />
          )}
          {cp.entries.length === 0 ? (
            <div className="text-[11px] text-slate-400">{t("checkpoints.card.noEntries")}</div>
          ) : (
            <EntriesBlock entries={cp.entries} isHead={isHead} onOpenBlame={onOpenBlame} />
          )}
          {cp.diff.length > 0 && <DiffBlock diff={cp.diff} />}
        </div>
      )}
    </section>
  );
}

// ---- Inner blocks ----

function KnownHumanMetaBlock({
  meta,
}: {
  meta: { editor: string; editor_version: string; extension_version: string };
}) {
  return (
    <div className="rounded-md bg-slate-50 px-2 py-1.5 text-xs dark:bg-slate-800/50">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
        known_human_metadata
      </div>
      <div className="grid grid-cols-3 gap-2">
        <KV label="editor" value={meta.editor} />
        <KV label="editor_version" value={meta.editor_version} />
        <KV label="extension_version" value={meta.extension_version} />
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] text-slate-500">{label}</div>
      <div className="font-mono text-[11px] text-slate-800 dark:text-slate-200">{value}</div>
    </div>
  );
}

function AgentMetadataBlock({ metadata }: { metadata: Record<string, string> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">
          {t("checkpoints.card.agentMetadataLabel").split("(")[0]}
        </span>
        <span className="text-[10px] text-slate-400">({Object.keys(metadata).length} keys)</span>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-2 py-2 dark:border-border">
          <JsonTree value={metadata} defaultOpenDepth={1} />
        </div>
      )}
    </div>
  );
}

function EntriesBlock({
  entries,
  isHead,
  onOpenBlame,
}: {
  entries: Checkpoint["entries"];
  isHead: boolean;
  onOpenBlame: (file: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-2">
      {entries.map((entry, i) => (
        <li key={`${entry.file}-${i}`} className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-slate-100 px-2 py-1 dark:border-border">
            <code className="truncate font-mono text-xs text-foreground/80">{entry.file}</code>
            {entry.blob_sha && (
              <code className="font-mono text-[10px] text-slate-400" title={entry.blob_sha}>
                {entry.blob_sha.slice(0, 8)}
              </code>
            )}
            {isHead && (
              <button
                type="button"
                onClick={() => onOpenBlame(entry.file)}
                title={t("checkpoints.card.blameAtHeadCaveat")}
                className="ml-auto inline-flex items-center gap-1 rounded-sm border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100 dark:border-border dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <ExternalLink className="h-3 w-3" />
                {t("checkpoints.card.blameAtHeadButton")}
              </button>
            )}
          </div>
          {entry.line_attributions.length > 0 ? (
            <LineAttributionsTable lines={entry.line_attributions} />
          ) : (
            <div className="px-2 py-1 text-[10px] text-slate-400">无 line_attributions</div>
          )}
        </li>
      ))}
    </ul>
  );
}

function LineAttributionsTable({
  lines,
}: {
  lines: Checkpoint["entries"][number]["line_attributions"];
}) {
  const { t } = useTranslation();
  return (
    <table className="w-full border-collapse text-[11px]">
      <thead>
        <tr className="text-slate-500">
          <th className="px-2 py-1 text-left font-medium">行范围</th>
          <th className="px-2 py-1 text-left font-medium">author_id</th>
          <th className="px-2 py-1 text-left font-medium">overrode</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((la, i) => (
          <tr key={i} className="border-t border-slate-100 dark:border-border">
            <td className="px-2 py-0.5 font-mono">
              {la.start_line === la.end_line ? la.start_line : `${la.start_line}-${la.end_line}`}
            </td>
            <td className="px-2 py-0.5 font-mono text-foreground/80">{la.author_id}</td>
            <td className="px-2 py-0.5 font-mono text-slate-500">
              {la.overrode
                ? t("checkpoints.card.lineAttributionOverrodeTemplate", {
                    prev: la.overrode.slice(0, 8),
                  })
                : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DiffBlock({ diff }: { diff: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const lineCount = diff.split("\n").length;
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">
          {t("checkpoints.card.diffLabelTemplate", { lines: lineCount })}
        </span>
      </button>
      {open && (
        <pre className="max-h-96 overflow-auto border-t border-slate-100 bg-slate-50 px-2 py-1.5 font-mono text-[11px] dark:border-border dark:bg-card/40">
          {diff}
        </pre>
      )}
    </div>
  );
}
