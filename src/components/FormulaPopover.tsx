import { Info } from "lucide-react";
import { useState } from "react";

import { FORMULA_POPOVER_LABELS } from "../lib/copy";
import { METRICS } from "../lib/formulas";
import type { FormulaToken, MetricId } from "../lib/formulas";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/PopoverPanel";

/**
 * 任意指标的"公式 / 数据来源 / 说明"Popover。
 * - trigger 是一个 16px 的 (i) icon button(可键盘 focus / Esc 关闭,由 Radix 提供)
 * - 公式以 token 数组形式渲染:metric token 是可点击 chip,点击切换到该 metric 的 Popover(单 level 二级展开,避免无限嵌套)
 * - aria-haspopup="dialog" 让屏读器知道这是一个对话面板
 */
export function FormulaPopover({ metricId }: { metricId: MetricId }) {
  const [active, setActive] = useState<MetricId>(metricId);
  // 注意:trigger 的 aria-label 锚定到原始 metricId,而不是 active —— 否则二级展开后
  // 关闭瞬间屏读器会读到错的标签。
  const triggerMeta = METRICS[metricId];
  const meta = METRICS[active];

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setActive(metricId);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${triggerMeta.title} 公式说明`}
          aria-haspopup="dialog"
          className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-slate-400 hover:text-slate-600 focus:outline-hidden focus:ring-2 focus:ring-ring dark:hover:text-slate-200"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="space-y-2.5">
          <div className="text-sm font-semibold">{meta.title}</div>

          <Section label={FORMULA_POPOVER_LABELS.definition}>
            <div className="text-[12px] leading-relaxed text-slate-700 dark:text-slate-200">
              {meta.definition}
            </div>
          </Section>

          <Section label={FORMULA_POPOVER_LABELS.formula}>
            <FormulaTokens tokens={meta.formula} activeId={active} onPick={(id) => setActive(id)} />
          </Section>

          {meta.example && (
            <Section label={FORMULA_POPOVER_LABELS.example}>
              <div className="text-[11px] leading-relaxed text-slate-500">{meta.example}</div>
            </Section>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function FormulaTokens({
  tokens,
  activeId,
  onPick,
}: {
  tokens: FormulaToken[];
  activeId: MetricId;
  onPick: (id: MetricId) => void;
}) {
  return (
    <div className="text-[12px] leading-snug text-slate-700 dark:text-slate-200">
      {tokens.map((tok, i) =>
        tok.kind === "text" ? (
          <span key={i}>{tok.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => onPick(tok.id)}
            aria-label={`查看 ${METRICS[tok.id].title} 的公式`}
            className={`mx-0.5 inline-flex items-center rounded px-1 font-mono text-[11px] transition-colors ${
              tok.id === activeId
                ? "bg-primary/10 text-primary dark:bg-primary/10 dark:text-primary"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            }`}
            title={`查看 ${METRICS[tok.id].title} 的公式`}
          >
            {tok.id}
          </button>
        ),
      )}
    </div>
  );
}
