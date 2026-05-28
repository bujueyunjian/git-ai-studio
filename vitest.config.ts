import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 与 vite.config.ts 的 alias 对齐:测试代码若间接 import 到 ui/* 也要能 resolve `@/lib/utils`。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/__tests__/*.test.ts", "src/**/__tests__/*.test.tsx"],
  },
});
