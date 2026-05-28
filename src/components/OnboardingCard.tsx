// 首访 onboarding 引导卡(IA 重构)。
//
// # 触发条件
// Setup 三件套(git-ai 已装 / 已选仓库 / 至少一个 agent 配了 hook)未全部就绪,
// 且用户没点过「暂时跳过」(localStorage `git-ai-studio:onboarding-dismissed`)时显示。
//
// # 非强制墙
// 卡片渲染在 Dashboard 顶部,不挡住下方内容,提供「暂时跳过」选项。这是引导而非门槛 ——
// 用户即便没配好也能浏览空态,与"degraded 空态"协同(后者解释为什么没数据)。
//
// # graceful
// useSetupStatus 的底层 invoke 在无 Tauri 后端(浏览器)时按"未就绪"降级,不白屏崩。
// 探测中(loading)时本卡不渲染,避免一闪而过的误报。

import { ArrowRight, Check, Circle, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../lib/cn";
import { useSetupStatus, type SetupChecklist } from "../lib/useSetupStatus";
import type { RouteId } from "../router";

const DISMISS_KEY = "git-ai-studio:onboarding-dismissed";

/** module 级内存兜底:Private / 隐私模式下 localStorage 写入可能抛错,
 *  用内存 flag 保证当次会话点了「跳过」不会因写失败而反复弹出。 */
let dismissedInMemory = false;

function readDismissed(): boolean {
  if (dismissedInMemory) return true;
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  dismissedInMemory = true;
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // 隐私模式不可写:内存 flag 已兜底
  }
}

export function OnboardingCard({
  onNavigate,
}: {
  onNavigate: (r: RouteId, params?: string) => void;
}) {
  const { t } = useTranslation();
  const setup = useSetupStatus();
  const [dismissed, setDismissed] = useState(readDismissed);

  // 探测中 / 已就绪 / 已跳过 → 不渲染。
  if (setup.loading || !setup.incomplete || dismissed) return null;

  const steps: Array<{ key: keyof SetupChecklist; labelKey: string }> = [
    { key: "gitAiInstalled", labelKey: "onboarding.checklist.gitAi" },
    { key: "repoSelected", labelKey: "onboarding.checklist.repo" },
    { key: "hasConfiguredHook", labelKey: "onboarding.checklist.hook" },
  ];

  return (
    <section className="rounded-lg border border-border bg-card p-5 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{t("onboarding.title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("onboarding.description")}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            writeDismissed();
            setDismissed(true);
          }}
          aria-label={t("onboarding.skip")}
          title={t("onboarding.skip")}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <ul className="mt-4 space-y-1.5">
        {steps.map((s) => {
          const done = setup.checklist[s.key];
          return (
            <li key={s.key} className="flex items-center gap-2 text-xs">
              {done ? (
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />
              )}
              <span className={cn(done ? "text-muted-foreground line-through" : "text-foreground")}>
                {t(s.labelKey)}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onNavigate("diagnostic")}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t("onboarding.cta")}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            writeDismissed();
            setDismissed(true);
          }}
          className="inline-flex h-8 items-center rounded-md px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t("onboarding.skip")}
        </button>
      </div>
    </section>
  );
}
