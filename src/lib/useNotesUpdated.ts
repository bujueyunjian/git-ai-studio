import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 后端 `refs/notes/ai` 变化事件:commit 完成后 1-3s 触发,载荷带 `repo_path`。
 * 真源:`src-tauri/src/repo_notes_watcher.rs`(NOTES_UPDATED_EVENT)。
 */
export const NOTES_UPDATED_EVENT = "git-ai-studio://notes-updated";

/**
 * 订阅 notes-updated,对**当前仓库**幂等触发 `onUpdate`。
 *
 * 切仓后旧仓库的延迟事件会被 `repo_path` 比对过滤掉(与 LowAiShareWatcher 同口径)。
 * `onUpdate` 必须用 `useCallback` 保持稳定,否则每次渲染都会重订阅。
 */
export function useNotesUpdated(repoPath: string | null, onUpdate: () => void): void {
  useEffect(() => {
    if (!repoPath) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<{ repo_path?: string }>(NOTES_UPDATED_EVENT, (event) => {
      // 幂等:只处理当前仓库的事件,过滤切仓后晚到的旧事件。
      if (event.payload?.repo_path && event.payload.repo_path !== repoPath) return;
      onUpdate();
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [repoPath, onUpdate]);
}
