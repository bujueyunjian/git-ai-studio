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
          className="z-50 max-w-xs rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-lg"
        >
          {content}
          <TT.Arrow className="fill-foreground" />
        </TT.Content>
      </TT.Portal>
    </TT.Root>
  );
}
