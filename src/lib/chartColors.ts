// 3 桶 AI 归因的语义配色,对齐 git-ai 上游 stats.rs:114 的 human / unknown / ai_additions 口径。
// ai 桶取品牌蓝,与 App.css 的 --primary、StatsBar 的 bg-primary、Dashboard 趋势图 text-primary 同步;
// Blame 行级视图(BlameCodeView)通过 bucketColor 取 hex 标记 AI 行(Recharts/CodeMirror 不解析 CSS var,故按主题给出 hex)。

export const STATS_BUCKET_COLORS = {
  human: { light: "#10b981", dark: "#34d399" }, // emerald
  unknown: { light: "#94a3b8", dark: "#cbd5e1" }, // slate
  ai: { light: "#3b82f6", dark: "#60a5fa" }, // 品牌蓝(blue-500 / blue-400),须与 --primary 同步
} as const;

/** Recharts 用到的"中性色"集中表(grid/axis/tooltip 框):避免散落 hex 在 chart 组件里。 */
export const CHART_NEUTRAL = {
  grid: { light: "#e2e8f0", dark: "#334155" },
  axisTick: { light: "#64748b", dark: "#94a3b8" },
  tooltipBg: { light: "#ffffff", dark: "#0f172a" },
  tooltipBorder: { light: "#e2e8f0", dark: "#334155" },
} as const;

export type StatsBucket = keyof typeof STATS_BUCKET_COLORS;
export type ChartNeutral = keyof typeof CHART_NEUTRAL;

/** 根据当前主题模式取一桶的颜色。Recharts 通过显式 prop 接收(无法读 CSS vars)。 */
export function bucketColor(bucket: StatsBucket, theme: "light" | "dark"): string {
  return STATS_BUCKET_COLORS[bucket][theme];
}

export function neutralColor(key: ChartNeutral, theme: "light" | "dark"): string {
  return CHART_NEUTRAL[key][theme];
}

/** 把 document.documentElement 上的 `dark` class 翻译成主题模式,与 lib/theme.ts 保持一致。 */
export function detectTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}
