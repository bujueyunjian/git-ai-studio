import { Check, Minus, AlertTriangle, X } from "lucide-react";
import type { StatusLevel } from "../lib/types";
import { cn } from "../lib/cn";

const STYLES: Record<StatusLevel, { bg: string; text: string; ring: string; Icon: typeof Check }> =
  {
    ok: { bg: "bg-emerald-500", text: "text-white", ring: "ring-emerald-500/30", Icon: Check },
    warn: {
      bg: "bg-amber-500",
      text: "text-white",
      ring: "ring-amber-500/30",
      Icon: AlertTriangle,
    },
    err: { bg: "bg-rose-500", text: "text-white", ring: "ring-rose-500/30", Icon: X },
    muted: {
      bg: "bg-muted",
      text: "text-muted-foreground",
      ring: "ring-border",
      Icon: Minus,
    },
  };

/** 色盲友好的状态点 — 颜色 + 字符同时出现。 */
export function StatusDot({
  level,
  size = "md",
}: {
  level: StatusLevel;
  size?: "sm" | "md" | "lg";
}) {
  const s = STYLES[level];
  const dim = { sm: "h-3.5 w-3.5", md: "h-5 w-5", lg: "h-7 w-7" }[size];
  const ic = { sm: "h-2.5 w-2.5", md: "h-3 w-3", lg: "h-4 w-4" }[size];
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full ring-2",
        s.bg,
        s.text,
        s.ring,
        dim,
      )}
    >
      <s.Icon className={ic} strokeWidth={3} />
    </span>
  );
}
