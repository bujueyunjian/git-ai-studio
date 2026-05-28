import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import i18n from "./i18n";

import { LowAiShareWatcher } from "./components/LowAiShareWatcher";
import { DaemonWatcher } from "./components/DaemonWatcher";
import { Rail } from "./components/Layout/Rail";
import { RepoSetupGuide } from "./components/RepoSetupGuide";
import { TopBar } from "./components/Layout/TopBar";
import { TooltipProvider } from "./components/ui/TooltipBubble";
import { getAppSettings, restoreLastRepo } from "./lib/api";
import { loadTheme, subscribeSystemTheme } from "./lib/theme";
import { useRepoChanged } from "./lib/useRepoChanged";
import { useRouter } from "./router";

import DiagnosticPage from "./pages/Diagnostic";
import InstallPage from "./pages/Install";
import HooksPage from "./pages/Hooks";
import LogsPage from "./pages/Logs";
import DashboardPage from "./pages/Dashboard";
import PeoplePage from "./pages/People";
import StatsPage from "./pages/Stats";
// Blame 页带 CodeMirror 6 + 8 lang 包 ≈ +500KB,懒加载避免污染首屏 bundle
const BlamePage = lazy(() => import("./pages/Blame"));
import NotesPage from "./pages/Notes";
import CheckpointsPage from "./pages/Checkpoints";
import ManualPage from "./pages/Manual";
import RepoPage from "./pages/Repo";
import SettingsPage from "./pages/Settings";

export default function App() {
  const qc = useQueryClient();
  const { current, navigate } = useRouter();
  // 语言切换:订阅 i18next 的 languageChanged 事件,把当前语言作为下方子树的 key。
  // 切换语言时 key 变更 → React 重挂载子树 → copy.ts 中 getter 形态的常量被重新求值;
  // 配合 copy.ts 的 getter 对象 / 数组 Proxy,无需手动刷新页面即可全屏切换文案。
  const [lang, setLang] = useState<string>(i18n.language);
  useEffect(() => {
    const handler = (l: string) => setLang(l);
    i18n.on("languageChanged", handler);
    return () => i18n.off("languageChanged", handler);
  }, []);
  // 切仓 / 启动恢复 / 切分支共用同一套副作用(invalidate + URL params reset),见 useRepoChanged 注释
  const handleRepoChanged = useRepoChanged();

  // LowAiShareWatcher 用的 app_settings:不走 watcher 内部独立 useQuery,与 Settings 页共享同一 key,
  // 修改设置后两边同步,无 refetch 延迟。
  const appSettingsQ = useQuery({
    queryKey: ["app_settings"],
    queryFn: getAppSettings,
    staleTime: 30_000,
  });

  // 启动时自动恢复上次仓库;失败静默,Diagnostic 页自然降级。
  // 恢复成功 = 一次"切仓库",必须走 handleRepoChanged(含 URL reset)否则旧 hash 上的 blame
  // file path 会被新仓库当 deep-link,落到 file_not_in_head。
  //
  // 用 ref 持有最新 handleRepoChanged + 空依赖只跑一次:handleRepoChanged 依赖
  // useRouter().current,路由一变就换引用。若把它作 effect 依赖,这个"启动恢复"
  // effect 会随路由反复重触发;又因 restoreLastRepo() 异步,resolve 时调用的是旧
  // 闭包里的 navigate(current),stale 与新闭包交替把路由在 stats↔blame 间来回推,
  // 表现为左侧菜单无限横跳。恢复仓库本就只该在挂载时发生一次。
  const handleRepoChangedRef = useRef(handleRepoChanged);
  handleRepoChangedRef.current = handleRepoChanged;
  useEffect(() => {
    restoreLastRepo()
      .then((r) => {
        if (r) handleRepoChangedRef.current();
      })
      .catch(() => {});
    // 仅挂载时执行一次 —— 见上方注释,依赖 handleRepoChanged 会引发路由横跳死循环;
    // 回调通过 handleRepoChangedRef 读取,不进依赖数组。
  }, []);

  // 启动时挂上 system 主题监听(FOUC 脚本已经预设 .dark class,这里仅订阅系统切换)
  useEffect(() => {
    subscribeSystemTheme(loadTheme());
  }, []);

  // cc-switch 守护事件订阅:任意页面下都需要看到 toast(用户不一定在 Settings)。
  // 后端 emit "cc-switch-watcher://event" payload = { level, message }。
  useEffect(() => {
    const unlistenPromise = listen<{ level: string; message: string }>(
      "cc-switch-watcher://event",
      (e) => {
        const { level, message } = e.payload;
        if (level === "success") {
          toast.success(message);
          qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
          qc.invalidateQueries({ queryKey: ["hooks_status"] });
        } else if (level === "warn") {
          toast.message(message);
        } else if (level === "error") {
          toast.error(message);
        } else {
          toast.info(message);
        }
      },
    );
    return () => {
      unlistenPromise.then((un) => un()).catch(() => {});
    };
  }, [qc]);

  return (
    <TooltipProvider>
      {/* key={lang} 让整棵 UI 子树在语言切换时重新挂载,保证所有 copy.ts 文案立即换新语言。
          watcher 组件(LowAiShare / Daemon / RepoSetupGuide)与轮询 / 后台监控相关,
          重挂载会重置其内部 query state,语言切换是低频操作,可接受。 */}
      <div key={lang} className="contents">
        <LowAiShareWatcher settings={appSettingsQ.data} onNavigate={navigate} />
        <DaemonWatcher settings={appSettingsQ.data} />
        <RepoSetupGuide settings={appSettingsQ.data} onRepoChanged={handleRepoChanged} />
        <div className="flex h-full">
          <Rail current={current} onNavigate={navigate} />
          <div className="flex flex-1 flex-col overflow-hidden">
            <TopBar onNavigate={navigate} onRepoChanged={handleRepoChanged} />
            <main className="relative flex-1 overflow-y-auto">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {i18n.t("common.loading")}
                  </div>
                }
              >
                {renderPage(current)}
              </Suspense>
            </main>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function renderPage(r: ReturnType<typeof useRouter>["current"]) {
  switch (r) {
    case "diagnostic":
      return <DiagnosticPage />;
    case "install":
      return <InstallPage />;
    case "hooks":
      return <HooksPage />;
    case "logs":
      return <LogsPage />;
    case "dashboard":
      return <DashboardPage />;
    case "people":
      return <PeoplePage />;
    case "stats":
      return <StatsPage />;
    case "blame":
      return <BlamePage />;
    case "notes":
      return <NotesPage />;
    case "checkpoints":
      return <CheckpointsPage />;
    case "manual":
      return <ManualPage />;
    case "repo":
      return <RepoPage />;
    case "settings":
      return <SettingsPage />;
  }
}
