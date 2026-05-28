import type * as React from "react";

// Linear 风 chart 主题:统一弱对比、单色 + 中性辅助色,axis / grid 几乎不可见。
//
// # 设计原则
// - 主线 = 前景灰(深色模式自动反相),不另选品牌色;数据本身是主角,颜色只承担"区分"
// - grid 线极淡(border 弱化),tickLine / axisLine 全关 — Linear / Vercel dashboard 同款
// - tooltip 用 popover 语义色,圆角 8 + 1px border,无 shadow 厚度
// - 3 桶 stats 仍走 `chartColors.ts`(human/unknown/ai 已有上游绑定);本文件只提供"通用图表"
//   场景的弱对比色组(单条主线 + 0~2 条辅助线)
//
// # 主题模式
// Recharts 不能直接读 CSS var(SVG 渲染时不解析 var)。
// `currentColor` 是个聪明的兜底:line `stroke="currentColor"` 时 SVG 会读取最近祖先的
// CSS color。把外层 div 设 text-foreground / text-muted-foreground 等语义类,
// chart 内部颜色就跟随主题切换,无需再监听 dark class。

/** 通用 chart 配色 — 单色弱对比方案,主题切换通过 CSS currentColor 完成。 */
export const CHART_COLORS = {
  /** 主数据线/区域:跟随当前文字色(text-foreground)。 */
  primary: "currentColor",
  /** 副数据线/对比基准:中性灰。 */
  secondary: "var(--color-muted-foreground)",
  /** 强调态(选中数据点 / hover 高亮)。 */
  accent: "var(--color-primary)",
  /** 网格线:极淡 border。 */
  grid: "var(--color-border)",
  /** axis tick 文字色:muted。 */
  axisTick: "var(--color-muted-foreground)",
  /** Tooltip 容器底色 / 边框:走 popover 语义。 */
  tooltipBg: "var(--color-popover)",
  tooltipBorder: "var(--color-border)",
  tooltipText: "var(--color-popover-foreground)",
} as const;

/**
 * Recharts `<XAxis />` / `<YAxis />` 默认 props。
 *
 * # 为什么 axisLine = false
 * Linear / Vercel 风:轴线本身在弱网格下显得多余,tick 标签的对齐已经隐含轴线方向。
 * 想要 X 轴底线时,用单独 1px border 在外层 div 上画,比 axisLine 更可控。
 */
export const axisDefaultProps = {
  stroke: CHART_COLORS.axisTick,
  fontSize: 10,
  tickLine: false,
  axisLine: false,
} as const;

/** 通用 tooltip contentStyle —— 与 shadcn popover 视觉一致。 */
export const tooltipContentStyle: React.CSSProperties = {
  background: CHART_COLORS.tooltipBg,
  border: `1px solid ${CHART_COLORS.tooltipBorder}`,
  borderRadius: 8,
  fontSize: 11,
  color: CHART_COLORS.tooltipText,
  boxShadow: "0 2px 8px rgb(0 0 0 / 0.04)",
  padding: "6px 8px",
};
