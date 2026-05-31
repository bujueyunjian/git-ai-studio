import type { ReactNode } from "react";
import { cn } from "../lib/cn";

type Tone = "neutral" | "success" | "warn" | "danger" | "info";

// tone 走 T1 语义 token(bg-{tone}-muted 软底 + text-{tone} 实色),删硬编码双 variant,
// 一处改全站 badge 明暗一致。注:warn 的 text-warning(琥珀)在浅底上偏淡,故 warn 用 -foreground
// 深色文字(near-black on 琥珀软底)保证可读 —— 琥珀做"文字色"天生不可读,这是该色系的固有约束。
const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success-muted text-success",
  warn: "bg-warning-muted text-warning-foreground dark:text-warning",
  danger: "bg-danger-muted text-danger",
  info: "bg-info-muted text-info",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
