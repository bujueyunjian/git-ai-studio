// 数据口径开关:只看我 / 全部作者。默认「只看我」(单开发者本机工具的本分,见 ADR-012 / PR-FAQ #6)。
//
// 视觉上刻意做得比相邻的时间/粒度控件**更醒目**:带人物图标 + 选中段填充主色(primary),
// 让"看谁的代码"这个最关键的口径一眼可辨,不再淹没在一排长得一样的 segmented 控件里。
// Dashboard 与 People 共用同一组件,保证两处口径开关观感一致。

import { User, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../lib/cn";

export function ScopeToggle({
  onlyMine,
  onChange,
}: {
  onlyMine: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const opts = [
    { v: true, label: t("dashboard.scope.onlyMine"), Icon: User },
    { v: false, label: t("dashboard.scope.everyone"), Icon: Users },
  ] as const;
  return (
    <div className="inline-flex h-8 items-center rounded-md border border-border bg-card p-0.5 text-xs">
      {opts.map(({ v, label, Icon }) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={onlyMine === v}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm px-2 py-1 transition-colors duration-150",
            onlyMine === v
              ? "bg-primary font-medium text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="h-3 w-3" />
          {label}
        </button>
      ))}
    </div>
  );
}
