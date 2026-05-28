import * as DM from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;

export function DropdownMenuContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <DM.Portal>
      <DM.Content
        align="start"
        sideOffset={6}
        className={cn(
          "z-50 min-w-48 rounded-md border border-slate-200 bg-white p-1 shadow-lg",
          "dark:border-border dark:bg-card",
          className,
        )}
      >
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function DropdownMenuItem({
  children,
  onSelect,
  danger,
  disabled,
  className,
}: {
  children: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <DM.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        "cursor-pointer rounded-sm px-2 py-1.5 text-sm outline-hidden transition-colors",
        "data-highlighted:bg-slate-100 dark:data-highlighted:bg-slate-800",
        "data-disabled:cursor-default data-disabled:opacity-60 data-disabled:data-highlighted:bg-transparent",
        danger && "text-rose-600 data-highlighted:bg-rose-50 dark:data-highlighted:bg-rose-950/40",
        className,
      )}
    >
      {children}
    </DM.Item>
  );
}

export function DropdownMenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-secondary" />;
}

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return (
    <DM.Label className="px-2 py-1 text-xs uppercase tracking-wider text-slate-500">
      {children}
    </DM.Label>
  );
}
