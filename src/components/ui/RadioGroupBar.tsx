import * as R from "@radix-ui/react-radio-group";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

interface GroupProps<T extends string> {
  value: T;
  onValueChange: (v: T) => void;
  className?: string;
  children: ReactNode;
}

export function RadioGroup<T extends string>({
  value,
  onValueChange,
  className,
  children,
}: GroupProps<T>) {
  return (
    <R.Root
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      className={cn("flex gap-3", className)}
    >
      {children}
    </R.Root>
  );
}

export function RadioItem({
  value,
  children,
  id,
}: {
  value: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <label
      htmlFor={id ?? value}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/10 has-data-[state=checked]:text-primary dark:has-data-[state=checked]:bg-primary/15 dark:has-data-[state=checked]:text-primary"
    >
      <R.Item
        value={value}
        id={id ?? value}
        className="h-3.5 w-3.5 rounded-full border border-slate-400 data-[state=checked]:border-primary data-[state=checked]:bg-primary"
      >
        <R.Indicator className="block h-1.5 w-1.5 rounded-full bg-white" />
      </R.Item>
      {children}
    </label>
  );
}
