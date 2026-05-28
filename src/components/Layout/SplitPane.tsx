// SplitPane:水平左右分栏 + 可拖拽分隔条 + localStorage 持久化宽度。
//
// # 为什么抽出来
// Blame / Logs / Hooks 都是"左导航 + 右详情"布局,原本各页硬编码 `<aside class="w-72">`
// 让用户没法适应长文件名 / 长 agent 名 / 长备份名。布局意图应由容器承担,而不是页面 owns。
//
// # 持久化
// `storageKey` 走 localStorage,记住用户上次拖到的宽度;未提供 storageKey → 受控外部
// state 或仅生命周期内 in-memory。这不是 fallback —— 用户显式拖动的偏好不是数据缺失兜底。
//
// # 拖拽
// `pointerdown` 标记拖拽态 + 全局 `pointermove/pointerup` 监听;期间 body cursor 改为 col-resize,
// 用 `user-select: none` 防止误选文本。松开持久化。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  /** localStorage 持久化键;省略时仅 in-memory(每次进页面回到 default)。 */
  storageKey?: string;
  /** 初始左侧宽度(px)。 */
  defaultLeftWidth?: number;
  /** 左侧最小宽度,防止拖到 0 看不到。 */
  minLeftWidth?: number;
  /** 左侧最大宽度,避免挤掉右侧。 */
  maxLeftWidth?: number;
  className?: string;
}

function readPersistedWidth(key: string | undefined, fallback: number): number {
  if (!key || typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function persistWidth(key: string | undefined, w: number) {
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(Math.round(w)));
  } catch {
    /* localStorage 不可用就忽略,持久化不是关键路径 */
  }
}

export function SplitPane({
  left,
  right,
  storageKey,
  defaultLeftWidth = 288,
  minLeftWidth = 160,
  maxLeftWidth = 640,
  className,
}: SplitPaneProps) {
  const [leftWidth, setLeftWidth] = useState<number>(() =>
    readPersistedWidth(storageKey, defaultLeftWidth),
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragStateRef.current = { startX: e.clientX, startWidth: leftWidth };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [leftWidth],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const s = dragStateRef.current;
      if (!s) return;
      const delta = e.clientX - s.startX;
      let next = s.startWidth + delta;
      next = Math.max(minLeftWidth, Math.min(maxLeftWidth, next));
      setLeftWidth(next);
    };
    const onUp = () => {
      if (!dragStateRef.current) return;
      dragStateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // 用闭包外最新值持久化 —— setLeftWidth 已 commit
      setLeftWidth((w) => {
        persistWidth(storageKey, w);
        return w;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [minLeftWidth, maxLeftWidth, storageKey]);

  const onDoubleClick = useCallback(() => {
    setLeftWidth(defaultLeftWidth);
    persistWidth(storageKey, defaultLeftWidth);
  }, [defaultLeftWidth, storageKey]);

  return (
    <div ref={containerRef} className={`flex h-full min-h-0 ${className ?? ""}`}>
      <div className="shrink-0 overflow-hidden" style={{ width: leftWidth }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整左侧宽度,双击恢复默认"
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        className="group relative w-1 shrink-0 cursor-col-resize bg-slate-200 hover:bg-primary/70 active:bg-primary dark:bg-slate-800 dark:hover:bg-primary/90"
        title="拖拽调整宽度 · 双击恢复默认"
      >
        {/* 加宽热区,实际拖拽容差更大 */}
        <span className="absolute inset-y-0 -left-1 -right-1" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{right}</div>
    </div>
  );
}
