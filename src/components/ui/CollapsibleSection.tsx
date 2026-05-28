import * as Coll from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";
import type { ReactNode } from "react";

interface Props {
  title: ReactNode;
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** 受控模式:外部传 open + onOpenChange 时切换为受控,defaultOpen 失效。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  rightExtra?: ReactNode;
}

export function Collapsible({
  title,
  summary,
  defaultOpen,
  open,
  onOpenChange,
  children,
  rightExtra,
}: Props) {
  return (
    <Coll.Root
      defaultOpen={open === undefined ? defaultOpen : undefined}
      open={open}
      onOpenChange={onOpenChange}
      className="group rounded-lg border border-border bg-card"
    >
      <div className="flex items-center px-4 py-2.5">
        <Coll.Trigger className="flex flex-1 items-center gap-2 text-left text-sm font-medium">
          <ChevronRight className="h-4 w-4 text-slate-400 transition-transform group-data-[state=open]:rotate-90" />
          <span>{title}</span>
          {summary && <span className="ml-2 text-xs text-slate-500">{summary}</span>}
        </Coll.Trigger>
        {rightExtra}
      </div>
      <Coll.Content className={cn("border-t border-slate-100 px-4 py-3 dark:border-border")}>
        {children}
      </Coll.Content>
    </Coll.Root>
  );
}
