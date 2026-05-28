import { ArrowRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { MSG } from "../lib/copy";

/**
 * 真实"degraded 空态"卡(未选仓库 / 缺二进制等)。
 * 与 Placeholder 区分:Placeholder 是"未实现页面"的灰底虚线占位;
 * EmptyState 是"功能可用但前置条件未满足"的实色卡 + 跳转 CTA。
 */
export function EmptyState({
  Icon,
  title,
  description,
  ctaLabel,
  onCta,
  tone = "amber",
}: {
  Icon: LucideIcon;
  title: string;
  description: ReactNode;
  ctaLabel?: string;
  onCta?: () => void;
  /** amber = 警告(语义色保留);neutral = 中性(走 muted)。 */
  tone?: "amber" | "neutral";
}) {
  const ring =
    tone === "amber"
      ? "bg-amber-100 text-amber-600 dark:bg-amber-950/40"
      : "bg-muted text-muted-foreground";
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="max-w-md rounded-lg border border-border bg-card p-8 text-center shadow-xs">
        <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${ring}`}>
          <Icon className="h-7 w-7" />
        </div>
        <div className="mt-4 text-lg font-semibold">{title}</div>
        <div className="mt-2 text-sm text-muted-foreground">{description}</div>
        {ctaLabel && onCta && (
          <button
            type="button"
            onClick={onCta}
            className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {ctaLabel} <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">{MSG.noUploadNotice}</p>
      </div>
    </div>
  );
}
