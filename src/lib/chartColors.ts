// 3 桶 AI 归因的语义配色,对齐 git-ai 上游 stats.rs:114 的 human / unknown / ai_additions 口径。
// 这是 App.css 语义 token --ai/--human/--unknown 的 hex 镜像:Recharts/CodeMirror/canvas 不解析
// CSS var,故按主题给出 hex。**改值时必须与 App.css 的 --ai/--human/--unknown 同步**(T1)。

export const STATS_BUCKET_COLORS = {
  human: { light: "#10b981", dark: "#34d399" }, // = --human(翡翠绿)
  unknown: { light: "#94a3b8", dark: "#cbd5e1" }, // = --unknown(中性灰)
  ai: { light: "#3b82f6", dark: "#60a5fa" }, // = --ai(科技蓝)
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
