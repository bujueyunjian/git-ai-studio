import * as P from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;

export function PopoverContent({
  children,
  className,
  side = "bottom",
  align = "center",
}: {
  children: ReactNode;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}) {
  return (
    <P.Portal>
      <P.Content
        side={side}
        align={align}
        sideOffset={6}
        className={cn(
          "z-50 max-w-sm rounded-md border border-slate-200 bg-white p-3 text-sm shadow-lg",
          "dark:border-border dark:bg-card",
          className,
        )}
      >
        {children}
      </P.Content>
    </P.Portal>
  );
}
