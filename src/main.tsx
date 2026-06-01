import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

// i18n 必须在任何使用文案的模块加载之前初始化:copy.ts 的 module-load 期间会读 i18n。
import "./i18n";

import App from "./App";
import { InkPetWindow } from "./components/InkPetWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { RouterProvider } from "./router";
import { UpdateProvider } from "./contexts/UpdateContext";
import "./App.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// pet 窗口与主窗口共用这一份 bundle,按窗口 label 分流渲染:
//   - "pet":只挂极简墨团(纯 listen + Canvas),不需要 QueryClient / Router / Updater
//   - 其它(main):完整应用
// 纯浏览器(pnpm dev,无 Tauri shell)读不到 label,退回主窗口视图。
function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (currentWindowLabel() === "pet") {
  // 在 React 挂载前给 <html> 打标记:App.css 据此把整份 pet 文档压成透明无滚动
  // (与主窗共用 index.html / CSS 时,压平 body 底色 / color-scheme / overflow)。
  document.documentElement.classList.add("pet-window");
  root.render(
    <React.StrictMode>
      <InkPetWindow />
    </React.StrictMode>,
  );
} else {
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider>
          {/* UpdateProvider 放在 RouterProvider 内、App 外:App 顶层用 key={lang} 在切语言时
              重挂子树,Provider 放外面才不会丢失更新状态或重复触发启动检查。 */}
          <UpdateProvider>
            <App />
          </UpdateProvider>
          <Toaster
            richColors
            closeButton
            position="bottom-right"
            toastOptions={{ duration: 3500 }}
          />
        </RouterProvider>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
