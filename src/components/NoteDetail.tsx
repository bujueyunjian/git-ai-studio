// P7 Notes 页右侧详情视图。
//
// # 分层
// - Header:full sha + 概要 chip + 跳 Stats / 复制 JSON 按钮
// - Attestations 卡:每文件一段折叠 → 文件内每个 entry(hash chip + line ranges)
//   - HEAD-only 时 file_path 是链接,行 ranges 是链接;非 HEAD 时全部静态
// - Prompts / Humans / Sessions 三段独立卡(空集隐藏整段;符合 no-explain-absent)
//
// # Hash 分类(评审 A §1.c)
// - 无前缀 → prompts;
// - h_ → humans;
// - s_(可能 s_::t_)→ sessions(split("::").next() 取 session_key 查 map)。
//
// # 隐私
// - messages_url 只显示 + 复制,不调用 opener(transcript 可能在远端,UI 不主动拉取)
//   注:内联 messages 数组自 v1.3.4 起从 spec 移除(E-002),viewer 不再镜像/展示

import { Activity, Bot, Copy, ExternalLink, FileText, User } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { cn } from "../lib/cn";
import {
  classifyNotesHash,
  parseLineRanges,
  sessionKeyOf,
  type NoteListEntry,
  type NotesAuthorshipLog,
  type NotesAuthorshipMetadata,
  type NotesFileAttestation,
  type NotesHumanRecord,
  type NotesPromptRecord,
  type NotesSessionRecord,
} from "../lib/types";

export interface NoteDetailProps {
  log: NotesAuthorshipLog;
  /** commit 元数据(从 list 取),用于 header 显示 subject / committed_at / short。 */
  meta: NoteListEntry;
  /** 当前仓库 HEAD sha;若与 meta.commit_sha 相等,Blame 跳转可用。 */
  headSha: string | null;
  onNavigate: (route: "stats" | "blame", params?: string) => void;
}

/** hash chip 三分类:prompt(AI)/ human / session,与 classifyNotesHash 返回值对齐。 */
type ChipKind = "prompt" | "human" | "session";

/** 各 chip 的图标(UI 常量,与文案分离;文案走 i18n notes.chips.*)。 */
const chipIconMap: Record<ChipKind, LucideIcon> = {
  prompt: Bot,
  human: User,
  session: Activity,
};

/** 各 chip 的色调 class(UI 常量)。 */
const chipToneClass: Record<ChipKind, string> = {
  prompt:
    "bg-primary/10 text-primary ring-ring dark:bg-primary/10 dark:text-primary dark:ring-ring",
  human:
    "bg-slate-100 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  session:
    "bg-purple-50 text-purple-700 ring-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:ring-purple-800",
};

export function NoteDetail({ log, meta, headSha, onNavigate }: NoteDetailProps) {
  const { attestations, metadata } = log;
  const isHead = headSha != null && headSha === meta.commit_sha;
  const promptsCount = Object.keys(metadata.prompts).length;
  const humansCount = Object.keys(metadata.humans).length;
  const sessionsCount = Object.keys(metadata.sessions).length;

  return (
    <div className="space-y-4 p-6">
      <Header meta={meta} metadata={metadata} onNavigate={onNavigate} log={log} />

      {/* 各段空集则整段隐藏(no-explain-absent),四段一致。 */}
      {attestations.length > 0 && (
        <AttestationsCard
          attestations={attestations}
          metadata={metadata}
          isHead={isHead}
          onNavigate={onNavigate}
        />
      )}

      {promptsCount > 0 && <PromptsCard prompts={metadata.prompts} />}

      {humansCount > 0 && <HumansCard humans={metadata.humans} />}

      {sessionsCount > 0 && <SessionsCard sessions={metadata.sessions} />}
    </div>
  );
}

// ============================================================================
// Header
// ============================================================================

function Header({
  meta,
  metadata,
  onNavigate,
  log,
}: {
  meta: NoteListEntry;
  metadata: NotesAuthorshipMetadata;
  onNavigate: NoteDetailProps["onNavigate"];
  log: NotesAuthorshipLog;
}) {
  const { t } = useTranslation();
  const copyJson = () => {
    void navigator.clipboard
      .writeText(JSON.stringify(log, null, 2))
      .then(() =>
        toast.success(t("notes.header.copied"), { description: t("common.noUploadNotice") }),
      )
      .catch(() => toast.error("复制失败"));
  };

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-sm bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          {meta.commit_sha}
        </code>
        <span className="text-xs text-slate-500">
          {t("notes.header.committedAtLabel")} {meta.committed_at}
        </span>
        <button
          type="button"
          onClick={() => onNavigate("stats", meta.commit_sha)}
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/15 dark:bg-primary/10 dark:text-primary dark:hover:bg-primary/20"
        >
          {t("notes.header.viewStats")}
        </button>
        <button
          type="button"
          onClick={copyJson}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Copy className="h-3 w-3" />
          {t("notes.header.copyFullJson")}
        </button>
      </div>
      <div className="text-sm text-slate-800 dark:text-slate-200">{meta.subject}</div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        <span>
          {t("notes.header.schemaVersionLabel")}:{" "}
          <code className="font-mono">{metadata.schema_version}</code>
        </span>
        {metadata.git_ai_version && (
          <span>
            {t("notes.header.gitAiVersionLabel")}:{" "}
            <code className="font-mono">{metadata.git_ai_version}</code>
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Attestations
// ============================================================================

function AttestationsCard({
  attestations,
  metadata,
  isHead,
  onNavigate,
}: {
  attestations: NotesFileAttestation[];
  metadata: NotesAuthorshipMetadata;
  isHead: boolean;
  onNavigate: NoteDetailProps["onNavigate"];
}) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t("notes.sectionTitles.attestations")} count={attestations.length}>
      <ul className="space-y-2 px-3 pb-3">
        {attestations.map((f) => (
          <li key={f.file_path}>
            <FileAttestationBlock
              file={f}
              metadata={metadata}
              isHead={isHead}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function FileAttestationBlock({
  file,
  metadata,
  isHead,
  onNavigate,
}: {
  file: NotesFileAttestation;
  metadata: NotesAuthorshipMetadata;
  isHead: boolean;
  onNavigate: NoteDetailProps["onNavigate"];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const filePathBtn = isHead ? (
    <button
      type="button"
      onClick={() => onNavigate("blame", file.file_path)}
      className="inline-flex items-center gap-1 truncate font-mono text-xs text-primary hover:underline dark:text-primary"
      title={t("notes.actions.openBlameAtHead")}
    >
      <FileText className="h-3 w-3 shrink-0" />
      <span className="truncate">{file.file_path}</span>
    </button>
  ) : (
    <span
      className="inline-flex items-center gap-1 truncate font-mono text-xs text-foreground/80"
      title={t("notes.actions.blameDisabledNonHead")}
    >
      <FileText className="h-3 w-3 shrink-0 text-slate-400" />
      <span className="truncate">{file.file_path}</span>
    </span>
  );

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 dark:border-border">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          {open ? "▼" : "▶"}
        </button>
        {filePathBtn}
        <span className="ml-auto text-[10px] text-slate-400">{file.entries.length} entries</span>
      </div>
      {open && (
        <ul className="space-y-1 px-3 py-2">
          {file.entries.map((e, i) => {
            const kind = classifyNotesHash(e.hash);
            const Icon = chipIconMap[kind];
            const meta = chipMeta(e.hash, metadata);
            // 取首段 range 用于深链(上游 line_ranges 已按 start 升序,首段即最早行)。
            // 解析失败 / 空段 → ranges=[] → range chip 退化为纯文本。
            const ranges = parseLineRanges(e.line_ranges);
            const firstRange = ranges.length > 0 ? ranges[0] : null;
            const canJumpBlame = isHead && firstRange !== null;
            return (
              <li key={i} className="flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                    chipToneClass[kind],
                  )}
                  title={meta}
                >
                  <Icon className="h-3 w-3" />
                  {t(`notes.chips.${kind}Label` as never)}
                </span>
                <code className="font-mono text-[11px] text-muted-foreground">{e.hash}</code>
                {canJumpBlame ? (
                  <button
                    type="button"
                    onClick={() =>
                      onNavigate("blame", `${file.file_path}/L${firstRange[0]}-${firstRange[1]}`)
                    }
                    title={
                      ranges.length > 1
                        ? `跳 Blame(${ranges.length} 段,深链取首段 L${firstRange[0]}-${firstRange[1]})`
                        : t("notes.actions.openBlameAtHead")
                    }
                    className="font-mono text-[11px] text-primary hover:underline dark:text-primary"
                  >
                    {e.line_ranges}
                  </button>
                ) : (
                  <code
                    className="font-mono text-[11px] text-foreground/80"
                    title={
                      !isHead
                        ? t("notes.actions.blameDisabledNonHead")
                        : ranges.length === 0
                          ? "line_ranges 字符串无法解析,Blame 跳转禁用"
                          : undefined
                    }
                  >
                    {e.line_ranges}
                  </code>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** chip 的 tooltip 文案:展示对应 prompt/human/session 的核心标识。 */
function chipMeta(hash: string, metadata: NotesAuthorshipMetadata): string {
  const kind = classifyNotesHash(hash);
  if (kind === "prompt") {
    const p = metadata.prompts[hash];
    return p ? `${p.agent_id.tool}::${p.agent_id.model}` : "(prompt 未找到)";
  }
  if (kind === "human") {
    const h = metadata.humans[hash];
    return h?.author ?? "(human 未找到)";
  }
  const key = sessionKeyOf(hash);
  const s = metadata.sessions[key];
  return s ? `${s.agent_id.tool}::${s.agent_id.model}` : "(session 未找到)";
}

// ============================================================================
// Prompts
// ============================================================================

function PromptsCard({ prompts }: { prompts: Record<string, NotesPromptRecord> }) {
  const { t } = useTranslation();
  const entries = Object.entries(prompts);
  return (
    <SectionCard title={t("notes.sectionTitles.prompts")} count={entries.length}>
      <ul className="space-y-2 px-3 pb-3">
        {entries.map(([hash, p]) => (
          <li key={hash}>
            <PromptCard hash={hash} record={p} />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function PromptCard({ hash, record }: { hash: string; record: NotesPromptRecord }) {
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 dark:border-border">
        <ChipBadge kind="prompt" />
        <code className="font-mono text-[11px] text-muted-foreground">{hash}</code>
        <span className="ml-auto truncate text-[11px] text-foreground/80">
          <code className="font-mono">
            {record.agent_id.tool}
            ::
            {record.agent_id.model}
          </code>
        </span>
      </div>
      <div className="space-y-2 px-3 py-2">
        <StatsRow record={record} />
        {record.human_author && (
          <div className="text-xs text-slate-600 dark:text-slate-400">
            人类作者:<span className="font-mono">{record.human_author}</span>
          </div>
        )}
        {record.messages_url && <MessagesUrlRow url={record.messages_url} />}
        {record.custom_attributes && <CustomAttributesTable attrs={record.custom_attributes} />}
      </div>
    </div>
  );
}

function StatsRow({ record }: { record: NotesPromptRecord }) {
  // 注:这 4 个数字按 spec §1.2.4 表格,是该 prompt 在**本 commit** 的统计。
  return (
    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      <Stat label="total_additions" value={record.total_additions} />
      <Stat label="total_deletions" value={record.total_deletions} />
      <Stat label="accepted_lines" value={record.accepted_lines} />
      <Stat label="overriden_lines" value={record.overriden_lines} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-slate-50 px-2 py-1 dark:bg-slate-800/50">
      <div className="font-mono text-[10px] text-slate-500">{label}</div>
      <div className="font-mono text-sm text-slate-800 dark:text-slate-200">{value}</div>
    </div>
  );
}

function MessagesUrlRow({ url }: { url: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
      <ExternalLink className="h-3 w-3" />
      <span className="font-medium">messages_url</span>
      <code className="truncate font-mono text-[11px]">{url}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => toast.success("已复制链接"));
        }}
        className="ml-auto inline-flex items-center gap-1 rounded-sm border border-amber-300 px-1.5 py-0.5 text-[10px] font-medium hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-950/50"
      >
        <Copy className="h-3 w-3" />
        {t("notes.actions.copyMessagesUrl")}
      </button>
    </div>
  );
}

function CustomAttributesTable({ attrs }: { attrs: Record<string, string> }) {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return null;
  return (
    <div className="rounded-md bg-slate-50 px-2 py-1 text-xs dark:bg-slate-800/50">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
        custom_attributes
      </div>
      <ul className="space-y-0.5">
        {entries.map(([k, v]) => (
          <li key={k} className="grid grid-cols-[140px_1fr] gap-2">
            <code className="truncate font-mono text-[11px] text-slate-500">{k}</code>
            <code className="break-all font-mono text-[11px] text-foreground/80">{v}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ============================================================================
// Humans
// ============================================================================

function HumansCard({ humans }: { humans: Record<string, NotesHumanRecord> }) {
  const { t } = useTranslation();
  const entries = Object.entries(humans);
  return (
    <SectionCard title={t("notes.sectionTitles.humans")} count={entries.length}>
      <ul className="space-y-1 px-3 pb-3">
        {entries.map(([hash, h]) => (
          <li
            key={hash}
            className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-1.5 text-xs dark:border-border"
          >
            <ChipBadge kind="human" />
            <code className="font-mono text-[11px] text-muted-foreground">{hash}</code>
            <span className="ml-auto truncate font-mono text-[11px] text-foreground/80">
              {h.author}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ============================================================================
// Sessions
// ============================================================================

function SessionsCard({ sessions }: { sessions: Record<string, NotesSessionRecord> }) {
  const { t } = useTranslation();
  const entries = Object.entries(sessions);
  return (
    <SectionCard title={t("notes.sectionTitles.sessions")} count={entries.length}>
      <ul className="space-y-2 px-3 pb-3">
        {entries.map(([hash, s]) => (
          <li key={hash} className="rounded-md border border-border">
            <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 dark:border-border">
              <ChipBadge kind="session" />
              <code className="font-mono text-[11px] text-muted-foreground">{hash}</code>
              <span className="ml-auto truncate text-[11px] text-foreground/80">
                <code className="font-mono">
                  {s.agent_id.tool}
                  ::
                  {s.agent_id.model}
                </code>
              </span>
            </div>
            <div className="space-y-1 px-3 py-2 text-xs">
              {s.human_author && (
                <div className="text-slate-600 dark:text-slate-400">
                  人类作者:<span className="font-mono">{s.human_author}</span>
                </div>
              )}
              {s.custom_attributes && <CustomAttributesTable attrs={s.custom_attributes} />}
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ============================================================================
// 通用小件
// ============================================================================

function SectionCard({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-xs dark:border-border dark:bg-card">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2 dark:border-border">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-[11px] text-slate-400">({count})</span>
      </div>
      {children}
    </section>
  );
}

function ChipBadge({ kind }: { kind: ChipKind }) {
  const { t } = useTranslation();
  const Icon = chipIconMap[kind];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
        chipToneClass[kind],
      )}
    >
      <Icon className="h-3 w-3" />
      {t(`notes.chips.${kind}Label` as never)}
    </span>
  );
}
