// 日志页:2 Tab 给排错人员一手访问 git-ai 运行期诊断信息。
//
// # Tab 划分
// 1. 诊断 — 运行 `git-ai debug` 流式回传(原文,与 Diagnostic 解析视图互补)
// 2. 应用日志 — 应用自身日志(tauri-plugin-log 默认目标)
//
// # 设计要点
// - 全程**只读** + **本地**:顶部 noUploadNotice 横幅常驻
// - Tab 状态走 useState,不入 URL(对齐其它单页惯例)
// - 两个 Tab 全 mount,用 hidden 控制可见而非 mount/unmount,保留滚动位置与已运行 query
// - eager import

import { useQuery } from "@tanstack/react-query";
import { ScrollText, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DebugReportRunner } from "../components/DebugReportRunner";
import { LogTailViewer } from "../components/LogTailViewer";
import { getInstalledVersion } from "../lib/api";
import type { InstalledVersion } from "../lib/types";

type TabId = "debug" | "app";

export default function LogsPage() {
  const [tab, setTab] = useState<TabId>("debug");

  return (
    <div className="flex h-full flex-col">
      <Header />
      <TabBar tab={tab} onTabChange={setTab} />
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <section hidden={tab !== "debug"} aria-hidden={tab !== "debug"}>
          <DebugTab />
        </section>
        <section hidden={tab !== "app"} aria-hidden={tab !== "app"}>
          <AppTab />
        </section>
      </div>
    </div>
  );
}

function Header() {
  const { t } = useTranslation();
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-background px-6 py-3">
      <div className="flex items-center gap-2">
        <ScrollText className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("logs.page.title")}</h1>
      </div>
      <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <div className="font-medium">{t("common.noUploadNotice")}</div>
          <div className="mt-0.5 text-amber-800/80 dark:text-amber-200/70">
            {t("logs.page.intro")}
          </div>
        </div>
      </div>
    </div>
  );
}

function TabBar({ tab, onTabChange }: { tab: TabId; onTabChange: (t: TabId) => void }) {
  const { t } = useTranslation();
  return (
    <div className="border-b border-border px-6" role="tablist">
      <TabButton current={tab} value="debug" label={t("logs.tabs.debug")} onSelect={onTabChange} />
      <TabButton current={tab} value="app" label={t("logs.tabs.app")} onSelect={onTabChange} />
    </div>
  );
}

function TabButton({
  current,
  value,
  label,
  onSelect,
}: {
  current: TabId;
  value: TabId;
  label: string;
  onSelect: (t: TabId) => void;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(value)}
      className={`relative -mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-blue-600 text-blue-700 dark:text-blue-300"
          : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
      }`}
    >
      {label}
    </button>
  );
}

// 诊断 Tab —— git-ai debug 流式原文
function DebugTab() {
  const installedQ = useQuery<InstalledVersion>({
    queryKey: ["get_installed_version"],
    queryFn: getInstalledVersion,
    staleTime: 60_000,
  });
  return <DebugReportRunner gitAiInstalled={installedQ.data?.installed === true} />;
}

// 应用日志 Tab —— tauri-plugin-log 默认目标
function AppTab() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">{t("logs.app.title")}</h2>
      <p className="text-xs text-muted-foreground">{t("logs.app.hint")}</p>
      <LogTailViewer
        kind={{ kind: "app" }}
        emptyHint={
          <>
            <div className="font-medium text-slate-700 dark:text-slate-200">
              {t("logs.app.empty.title")}
            </div>
            <div className="mt-1 text-muted-foreground">{t("logs.app.empty.detail")}</div>
          </>
        }
      />
    </div>
  );
}
