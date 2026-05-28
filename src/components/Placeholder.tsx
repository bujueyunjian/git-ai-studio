import type { LucideIcon } from "lucide-react";
import { Construction } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  title: string;
  description?: ReactNode;
  Icon?: LucideIcon;
  phase?: string;
}

/** 未实现页面的占位:不在 P1 范围内的 9 个页面用它。 */
export function Placeholder({ title, description, Icon = Construction, phase }: Props) {
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="max-w-md rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center shadow-xs dark:border-border dark:bg-card">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800">
          <Icon className="h-6 w-6" />
        </div>
        <div className="mt-4 text-lg font-semibold">{title}</div>
        {phase && (
          <div className="mt-1 text-xs text-slate-400">
            将在阶段 <span className="font-mono">{phase}</span> 实现
          </div>
        )}
        {description && <div className="mt-3 text-sm text-slate-500">{description}</div>}
      </div>
    </div>
  );
}
