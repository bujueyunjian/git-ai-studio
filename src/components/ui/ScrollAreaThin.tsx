import * as SA from "@radix-ui/react-scroll-area";
import type { ReactNode } from "react";

export function ScrollArea({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <SA.Root className={className}>
      <SA.Viewport className="h-full w-full">{children}</SA.Viewport>
      <SA.Scrollbar
        orientation="vertical"
        className="flex w-2 select-none touch-none p-0.5 bg-transparent"
      >
        <SA.Thumb className="relative flex-1 rounded-full bg-slate-300 dark:bg-slate-700" />
      </SA.Scrollbar>
    </SA.Root>
  );
}
