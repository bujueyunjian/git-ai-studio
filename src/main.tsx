import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

// i18n 必须在任何使用文案的模块加载之前初始化:copy.ts 的 module-load 期间会读 i18n。
import "./i18n";

import App from "./App";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider>
        {/* UpdateProvider 放在 RouterProvider 内、App 外:App 顶层用 key={lang} 在切语言时
            重挂子树,Provider 放外面才不会丢失更新状态或重复触发启动检查。 */}
        <UpdateProvider>
          <App />
        </UpdateProvider>
        <Toaster richColors closeButton position="bottom-right" toastOptions={{ duration: 3500 }} />
      </RouterProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
