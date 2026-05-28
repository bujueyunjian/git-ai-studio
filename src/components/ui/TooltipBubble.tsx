import * as TT from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TT.Provider delayDuration={150} skipDelayDuration={300}>
      {children}
    </TT.Provider>
  );
}

interface Props {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}

export function Tooltip({ content, children, side = "top" }: Props) {
  return (
    <TT.Root>
      <TT.Trigger asChild>{children}</TT.Trigger>
      <TT.Portal>
        <TT.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-xs rounded-md bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 shadow-lg dark:bg-slate-100 dark:text-slate-900"
        >
          {content}
          <TT.Arrow className="fill-slate-900 dark:fill-slate-100" />
        </TT.Content>
      </TT.Portal>
    </TT.Root>
  );
}
