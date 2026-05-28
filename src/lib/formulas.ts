// 指标公式与文案的"单一来源"。
//
// # 风格约束
// 每条指标必须能用三句话讲清:
//   - definition  : 这个指标统计的是什么(一句话)
//   - formula     : 怎么算(token 化表达,可点击跳到依赖指标)
//   - example     : 一个具体数值例子(可选,数字 > 描述)
// 不写"与上游 xx 对齐 / source: xxx" —— 文案给用户看,出处放代码注释。
//
// # 上游对照(只放在文件注释,不出现在 UI)
// - 字段定义:`git-ai/src/authorship/stats.rs::CommitStats`
// - 三桶并列公式:`total = human + unknown + ai`(stats.rs 114 行)
// - `ai_additions == ai_accepted` 恒等(stats.rs 116 行注释)

import type { AiStats } from "./types";

export type FormulaToken = { kind: "metric"; id: MetricId } | { kind: "text"; text: string };

/** 本地可计算且对用户可解释的指标 ID。每个 ID 对应 git-ai stats 的一个或一组字段。 */
export type MetricId =
  | "human_additions"
  | "unknown_additions"
  | "ai_additions"
  | "ai_share"
  | "window_ai_total"
  | "hook_coverage_rate"
  | "tool_model_breakdown";

export interface MetricMeta {
  id: MetricId;
  title: string;
  unit: "lines" | "percent" | "table";
  kind: "raw" | "derived";
  /** 一句话:这个指标是什么。 */
  definition: string;
  /** token 化公式;raw 指标也给一行口语化的来源描述。 */
  formula: FormulaToken[];
  /** 数值例子(可选);写在 `definition` 之后帮用户落地。 */
  example?: string;
  depends_on?: MetricId[];
}

const m = (id: MetricId): FormulaToken => ({ kind: "metric", id });
const t = (text: string): FormulaToken => ({ kind: "text", text });

export const METRICS: Record<MetricId, MetricMeta> = {
  human_additions: {
    id: "human_additions",
    title: "人工新增行",
    unit: "lines",
    kind: "raw",
    definition: "本次 commit 中,被 git-ai 归属为人类作者的新增行数。",
    formula: [t("git-ai 从 working log 里识别出的人类编辑行数,在 commit 时落到 notes 里。")],
    example: "一次 commit 改了 100 行新增,80 行 AI、20 行人手敲,这里就是 20。",
  },
  unknown_additions: {
    id: "unknown_additions",
    title: "未归因行",
    unit: "lines",
    kind: "raw",
    definition: "本次 commit 中,既没标 AI 也没标人类的新增行数 —— 没经过 git-ai hook 跟踪。",
    formula: [t("git 新增总行数 - 已识别为 AI 的行 - 已识别为人类的行")],
    example:
      "改了 100 行新增,80 AI / 5 人手 / 15 未归因 → 这里是 15。用户绕过 hook 直接 commit 或外部脚本生成的代码会进这桶。",
  },
  ai_additions: {
    id: "ai_additions",
    title: "AI 归属行",
    unit: "lines",
    kind: "raw",
    definition: "本次 commit 中,被 git-ai 归属为 AI agent 生成的新增行数。",
    formula: [t("hook 在每次 AI 编辑落 checkpoint,commit 时算出最终保留下来的 AI 行数")],
    example:
      "Claude / Cursor / Codex 等 agent 写的行都进这桶。改了 100 行新增,80 行是 AI 写的 → 这里是 80。",
  },
  ai_share: {
    id: "ai_share",
    title: "AI 占比",
    unit: "percent",
    kind: "derived",
    definition: "本次 commit 的新增行里,AI 生成的占多少。",
    formula: [
      m("ai_additions"),
      t(" / ("),
      m("human_additions"),
      t(" + "),
      m("unknown_additions"),
      t(" + "),
      m("ai_additions"),
      t(")"),
    ],
    example: "改了 100 行新增,80 AI / 20 人手 → 占比 80%。total 为 0(纯删除 / merge)时显示 —。",
    depends_on: ["ai_additions", "human_additions", "unknown_additions"],
  },
  window_ai_total: {
    id: "window_ai_total",
    title: "窗口 AI 累计行",
    unit: "lines",
    kind: "derived",
    definition: "Dashboard 当前时间窗口内,所有 commit 的 AI 归属行加起来。",
    formula: [t("窗口内每个 commit 的 "), m("ai_additions"), t(" 求和(累加视角)")],
    example:
      "近 30 天每个 commit 的 AI 行数累加。注意是「生产量」视角,被后续 commit 改掉的旧 AI 行也计入。",
    depends_on: ["ai_additions"],
  },
  hook_coverage_rate: {
    id: "hook_coverage_rate",
    title: "Hook 覆盖率",
    unit: "percent",
    kind: "derived",
    definition: "窗口内有 git-ai authorship notes 的 commit 占总 commit 数的比例。",
    formula: [t("commits_with_authorship / total_commits")],
    example: "比例不到 100% 说明仓库里有人没装 hook 就提交;具体作者可在 Hook 详情里看。",
  },
  tool_model_breakdown: {
    id: "tool_model_breakdown",
    title: "工具 / 模型分布",
    unit: "table",
    kind: "raw",
    definition: "按 AI 工具 + 模型拆分 AI 行数,看是哪个 agent 在写。",
    formula: [t("key = 'tool::model',如 'claude_code::claude-sonnet-4-5-20250929'")],
    example: "切换 Cursor / Claude / Codex 后这里能看见各自贡献量。",
  },
};

// ============ 派生计算 ============

export interface DerivedRates {
  /** ai_additions / total(3 桶并列分母);total=0 时返回 null。 */
  ai_share: number | null;
}

/**
 * 派生率。total=0(merge / 纯删除)时 ai_share 为 null,UI 显示 —。
 *
 * 不提供 ai_acceptance_rate:`ai_additions == ai_accepted` 恒成立(stats.rs:116),
 * 本地"采纳率"永远 100%,展示无诊断价值。
 */
export function deriveRates(stats: AiStats, total: number): DerivedRates {
  return {
    ai_share: total > 0 ? stats.ai_additions / total : null,
  };
}

// ============ 格式化 helper ============

const integer = new Intl.NumberFormat("zh-CN");

export function formatInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return integer.format(Math.trunc(n));
}

export function formatPercent(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** 显示相对时间:N 秒前 / N 分钟前。用于"上次刷新于"提示。 */
export function formatRelativeFromNow(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 1) return "刚刚";
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}
