/**
 * 原生 OS 目录选择器封装(Tauri v2 plugin-dialog)。
 *
 * # 用途
 * RepoSetupGuide wizard 与 Repo 页扫描根目录的"选择目录"按钮。
 *
 * # 行为
 * - 用户取消(点 Cancel)→ 返回 null,不抛错
 * - 用户选中目录 → 返回绝对路径字符串
 * - 出错(权限等)→ 抛错,由调用方决定 toast / 静默
 *
 * # 为什么不放在 lib/api.ts
 * api.ts 是 Tauri command 的统一封装(invoke 调后端 Rust);本 helper 调的是
 * tauri-plugin-dialog 的 JS API(不走 Rust command),路径不同,单独成文件。
 */

import { open } from "@tauri-apps/plugin-dialog";

export async function pickDirectory(title = "选择目录"): Promise<string | null> {
  const result = await open({
    directory: true,
    multiple: false,
    title,
  });
  // Tauri v2:取消时返回 null;选中时返回路径字符串
  return typeof result === "string" ? result : null;
}
