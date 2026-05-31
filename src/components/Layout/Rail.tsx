// 主侧栏(IA · 顶部「仓库」+ 3 分组带标题)。
//
// # IA
// 顶部独立一个「仓库」入口(管理扫描根 / 多选聚合集 / 设当前下钻仓),它是所有分析的前置;
// 其余功能项分三组显式呈现,不折叠、不藏:
// - 「分析」:Dashboard / 提交归因(含文件逐行下钻)/ 作者归因 / git notes / Checkpoints
// - 「配置」:环境诊断 / 安装升级 / Hooks 配置 / 日志
// - 「帮助」:用户手册(纯文档,单列一组与功能页区隔)
// TopBar 仍保留**当前下钻仓库**的快速切换器(与左侧「仓库」管理页职责分明):TopBar 是快速切焦点,
// 左侧「仓库」是完整管理。设置齿轮留在 TopBar。
//
// # 视觉
// logo 用蓝色 Activity 标记;active 项 `bg-blue-50 text-blue-700`(深色 blue-950/blue-300)+ 蓝图标,
// 未选中项文字 slate-700 / 图标 slate-500(可读不发灰),hover `bg-slate-100`。
// 蓝色交互态刻意用字面 blue/slate 类(而非中性 token),与全站品牌蓝一致、观感更鲜明。

import {
  Activity,
  LayoutDashboard,
  BarChart3,
  Users,
  FileJson,
  FolderGit2,
  ListTodo,
  Package,
  Plug,
  ScrollText,
  BookOpen,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/cn";
import type { RouteId } from "../../router";

interface NavItem {
  id: RouteId;
  /** i18n key,渲染时 t(labelKey)。 */
  labelKey: string;
  icon: LucideIcon;
}

interface NavGroup {
  /** 分组标题的 i18n key。 */
  titleKey: string;
  items: NavItem[];
}

// 两组导航:label 中英规范 —— 能中文的中文(提交归因 / 作者归因 / 环境诊断 /
// 安装升级 / Hooks 配置),专有名词保留英文(Dashboard / git notes / Checkpoints)。
const GROUPS: NavGroup[] = [
  {
    titleKey: "rail.group.analysis",
    items: [
      { id: "dashboard", labelKey: "nav.dashboard", icon: LayoutDashboard },
      { id: "stats", labelKey: "nav.commits", icon: BarChart3 },
      { id: "people", labelKey: "nav.people", icon: Users },
      { id: "notes", labelKey: "nav.notes", icon: FileJson },
      { id: "checkpoints", labelKey: "nav.checkpoints", icon: ListTodo },
    ],
  },
  {
    titleKey: "rail.group.config",
    items: [
      { id: "diagnostic", labelKey: "nav.diagnostic", icon: Activity },
      { id: "install", labelKey: "nav.install", icon: Package },
      { id: "hooks", labelKey: "nav.hooks", icon: Plug },
      { id: "logs", labelKey: "nav.logs", icon: ScrollText },
    ],
  },
  {
    titleKey: "rail.group.help",
    items: [{ id: "manual", labelKey: "nav.manual", icon: BookOpen }],
  },
];

export function Rail({
  current,
  onNavigate,
}: {
  current: RouteId;
  onNavigate: (r: RouteId) => void;
}) {
  const { t } = useTranslation();

  return (
    <aside className="flex w-[200px] shrink-0 flex-col border-r border-border bg-background">
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          <div className="text-sm font-semibold tracking-tight">{t("nav.appName")}</div>
        </div>
        <div className="mt-0.5 pl-6 text-[10px] text-muted-foreground">{t("nav.appTagline")}</div>
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-2">
        {/* 「仓库」置顶独立项:分析的前置(选仓 / 多选聚合 / 设下钻焦点),不归入任何分组。 */}
        <div>
          <RailButton
            icon={FolderGit2}
            label={t("nav.repo")}
            active={current === "repo"}
            onClick={() => onNavigate("repo")}
          />
        </div>
        {GROUPS.map((group) => (
          <div key={group.titleKey}>
            <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t(group.titleKey as never)}
            </div>
            {group.items.map((it) => (
              <RailButton
                key={it.id}
                icon={it.icon}
                label={t(it.labelKey as never)}
                active={it.id === current}
                onClick={() => onNavigate(it.id)}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
        {t("nav.footer")}
      </div>
    </aside>
  );
}

function RailButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
          : "text-slate-700 hover:bg-blue-50 hover:text-blue-700 dark:text-slate-300 dark:hover:bg-blue-950/40 dark:hover:text-blue-300",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4",
          active
            ? "text-blue-600 dark:text-blue-400"
            : "text-slate-500 group-hover:text-blue-600 dark:group-hover:text-blue-400",
        )}
      />
      <span>{label}</span>
    </button>
  );
}
