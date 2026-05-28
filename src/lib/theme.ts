// 主题应用 helper。与 index.html 顶部的 FOUC 内联脚本共用 storage key。

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "git-ai-studio.theme";

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

export function persistTheme(t: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* ignore */
  }
}

export function applyTheme(t: Theme) {
  const isDark =
    t === "dark" ||
    (t === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", !!isDark);
}

let mq: MediaQueryList | null = null;
let listener: ((e: MediaQueryListEvent) => void) | null = null;

/** 切到 system 时挂上 matchMedia 监听;切到 light/dark 时清理。 */
export function subscribeSystemTheme(currentTheme: Theme) {
  if (mq && listener) {
    mq.removeEventListener("change", listener);
    mq = null;
    listener = null;
  }
  if (currentTheme !== "system" || typeof window === "undefined" || !window.matchMedia) return;
  mq = window.matchMedia("(prefers-color-scheme: dark)");
  listener = () => applyTheme("system");
  mq.addEventListener("change", listener);
}
