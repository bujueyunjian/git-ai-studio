// i18next 配置 + 初始化。
//
// 设计要点:
// 1. **扁平 key + dot path 命名规范**:`namespace.subgroup.leafKey`(嵌套 ≤ 3 层)。
//    顶级命名空间按 copy.ts 既有分组对齐:install / hooks / stats / dashboard /
//    blame / notes / checkpoints / logs / people / diagnostic / settings / manual / formula /
//    timeRange / gitAiAccount / effectiveIgnore / chart / lowAiShare / quickFixCatalog /
//    daemon / workingDir / showRaw / changedFiles / authorsJumpBlame / common。
//
// 2. **添加新文案流程**:同时改 `locales/zh-CN.json` 与 `locales/en.json`,两边 key 必须一一对应。
//    带变量插值的字符串用 `{{name}}` 语法,调用侧:`t("foo.bar", { name: "x" })`。
//
// 3. **翻译质量约定**:不要"机翻字面值"——按英文语境自然表达。术语统一:
//    归因/authorship · 占比/share · 自研/custom · 本机/local · 钩子/hook ·
//    仓库/repository · 提交/commit · 归一/normalize。品牌名(git-ai / Claude / Cursor 等)保留。
//
// 4. 语言检测顺序:localStorage("git-ai-studio.lang") → navigator.language → fallback "zh-CN"。
//    fallbackLng = "en" —— 当某 key 在当前语言里缺失时回落英文,避免裸 key 出现。
//
// 5. 主入口 `src/main.tsx` 必须 `import "./i18n"` 在任何组件 mount 之前,确保
//    `i18n.t()` 在 copy.ts module-load 期间(eager getter)就已可用。

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enResources from "./locales/en.json";
import zhCNResources from "./locales/zh-CN.json";

export const SUPPORTED_LANGUAGES = ["zh-CN", "en"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const LANG_STORAGE_KEY = "git-ai-studio.lang";

/** 从 localStorage / navigator 推断初始语言。SSR / 隐私模式下安全降级到 zh-CN。 */
function detectInitialLanguage(): SupportedLanguage {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (stored === "zh-CN" || stored === "en") return stored;
  } catch {
    // localStorage 不可用(隐私模式 / SSR):忽略,落到 navigator
  }
  if (typeof navigator !== "undefined") {
    const lang = navigator.language || (navigator.languages && navigator.languages[0]) || "";
    if (lang.toLowerCase().startsWith("zh")) return "zh-CN";
    if (lang.toLowerCase().startsWith("en")) return "en";
  }
  return "zh-CN";
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCNResources },
    en: { translation: enResources },
  },
  lng: detectInitialLanguage(),
  fallbackLng: "en",
  interpolation: {
    // React 已经转义,关闭 i18next 自带转义避免 `&#39;` 之类双重转义。
    escapeValue: false,
  },
  returnNull: false,
  // 嵌套对象按 dot path 访问(`a.b.c`)。同时禁用 `:` 分隔的 namespace 解析,
  // 因为我们用单 namespace + dot path,避免 `git-ai:foo` 这种 key 被误拆。
  nsSeparator: false,
  keySeparator: ".",
});

/** 切换语言并持久化到 localStorage。语言切换后调用方应触发顶层 React 子树重新挂载,
 *  以确保 copy.ts 中 getter 形态的常量被重新求值(它们在 module load 时已 freeze 一次)。 */
export function setLanguage(lang: SupportedLanguage): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // localStorage 不可用:忽略持久化,仅切换当前会话语言
  }
  void i18n.changeLanguage(lang);
}

/** 获取当前生效语言(规整为 SupportedLanguage)。 */
export function getCurrentLanguage(): SupportedLanguage {
  const cur = i18n.language;
  if (cur === "en" || cur === "zh-CN") return cur;
  return cur && cur.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export default i18n;
