import { cn } from "../lib/cn";
import { formatInt } from "../lib/formulas";
import type { AiStats } from "../lib/types";

interface Segment {
  key: string;
  value: number;
  className: string;
  title: string;
}

/**
 * `you ████ ai` 进度条 — 三段并列(对齐 git-ai 上游 stats.rs:114 的 3 桶口径)。
 *
 * 上游 `write_stats_to_terminal`(stats.rs:80-226)的 ANSI 渲染对应:
 *   - human_additions → `█`(实心,本前端绿色 emerald)
 *   - unknown_additions → `·`(点,untracked,本前端中性灰 muted)
 *   - ai_additions     → `░`(浅,本前端主色 primary)
 */
export function StatsBar({ stats, total }: { stats: AiStats; total: number }) {
  const segments: Segment[] = [
    {
      key: "human",
      value: stats.human_additions,
      className: "bg-human",
      title: `human_additions: ${formatInt(stats.human_additions)} 行`,
    },
    {
      key: "unknown",
      value: stats.unknown_additions,
      className: "bg-unknown",
      title: `unknown_additions: ${formatInt(stats.unknown_additions)} 行(无 attestation)`,
    },
    {
      key: "ai_additions",
      value: stats.ai_additions,
      className: "bg-ai",
      title: `ai_additions: ${formatInt(stats.ai_additions)} 行`,
    },
  ];

  if (total === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>you 0</span>
          <span>ai 0</span>
        </div>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-secondary">
          <div className="h-full w-full bg-secondary" />
        </div>
        <div className="text-center text-xs text-muted-foreground">
          本 commit 无 additions(可能是纯删除 / 纯 rename / merge)
        </div>
      </div>
    );
  }

  // 左右两端标签:与上游 ANSI bar 保持一致 — 左 you = human + unknown(归入"非 AI 行"),
  // 右 ai = ai_additions。这是 stats.rs:246 的 `pure_human` 同款语义。
  const youSide = stats.human_additions + stats.unknown_additions;
  const aiSide = stats.ai_additions;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>
          you <span className="font-mono">{formatInt(youSide)}</span>
        </span>
        <span>
          ai <span className="font-mono">{formatInt(aiSide)}</span>
        </span>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-secondary">
        {segments.map((s) => {
          const pct = (s.value / total) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={s.key}
              title={s.title}
              className={cn("h-full", s.className)}
              style={{ width: `${pct}%` }}
            />
          );
        })}
      </div>
      <Legend />
    </div>
  );
}

function Legend() {
  const items: Array<{ label: string; cls: string }> = [
    { label: "human", cls: "bg-human" },
    { label: "unknown", cls: "bg-unknown" },
    { label: "ai", cls: "bg-ai" },
  ];
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1.5">
          <span className={cn("inline-block h-2.5 w-2.5 rounded-xs", i.cls)} />
          <span className="font-mono">{i.label}</span>
        </div>
      ))}
    </div>
  );
}
