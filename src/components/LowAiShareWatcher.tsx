/**
 * 全局挂载的"低 AI 占比"后台提醒。
 *
 * # 数据来源
 * 默认按当前仓库 `git config user.email` 走 People 聚合;用户手动配置邮箱时按配置聚合;
 * 两者都为空才复用 Dashboard 的 `getHistory` 仓库整体口径。
 *
 * # 触发链
 * `decideLowAiShareNotification` 是唯一判定函数(纯函数 + 单测覆盖)。本组件只负责:
 *   1. 调度 useQuery(visibility 闸 + staleTime + refetchInterval)
 *   2. 把 settings / payload / cooldown 时间戳喂给判定函数
 *   3. trigger=true 时弹 toast,onDismiss/action 写 localStorage
 *
 * # 多重冷却
 * - 距上次提醒 < 配置的提醒间隔 → 不弹
 * - 距上次切仓 < 5 分钟 → 不弹
 * - 用户主动 X 后,配置的静默时长内不弹
 *
 * # 切仓库时间戳
 * 由 useEffect 监听 `repoPath` 变化记录到 ref。注意:首次挂载时 repoPath 从 null→某值
 * 也算"切换",会进 5 分钟冷却。这是想要的:启动恢复仓库后立即弹太突兀。
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";

import { currentGitUserEmail, currentRepo, getHistory, getPeopleBreakdown } from "../lib/api";
import { notify } from "../lib/osNotify";
import { LOW_AI_SHARE_ALERT } from "../lib/copy";
import {
  LOW_AI_SHARE_CHECK_INTERVAL_MS,
  LOW_AI_SHARE_DEFAULT_DISMISS_MINUTES,
  LOW_AI_SHARE_DEFAULT_REMIND_INTERVAL_MINUTES,
  LOW_AI_SHARE_DEFAULT_THRESHOLD,
  LOW_AI_SHARE_MAX_DISMISS_MINUTES,
  LOW_AI_SHARE_MAX_REMIND_INTERVAL_MINUTES,
  LOW_AI_SHARE_MIN_DISMISS_MINUTES,
  LOW_AI_SHARE_MIN_REMIND_INTERVAL_MINUTES,
  LOW_AI_SHARE_RESET_EVENT,
  LOW_AI_SHARE_WINDOW_DAYS,
  clampLowAiShareMinutes,
  decideLowAiShareNotification,
  dismissedUntilKey,
  lastShownKey,
  lowAiShareScopeKey,
  normalizeLowAiShareTargetEmails,
  readMsFromStorage,
  summarizeAiShare,
  summarizeAiShareForEmails,
  writeMsToStorage,
} from "../lib/lowAiShareNotifier";
import { rangeKey } from "../lib/queryKeys";
import type { RouteId } from "../router";
import type { AppSettings, HistoryResult, PeopleBreakdownResult, TimeRange } from "../lib/types";

const STATS_STALE_MS = 5 * 60 * 1000;
// 与 Dashboard 共用 rangeKey() 函数,确保 queryKey 字符串字段完全一致 —— 这是
// "Dashboard 选 7 天时,watcher 与之共享缓存不重跑子进程" 承诺的前提。
const SEVEN_DAY_RANGE: TimeRange = { kind: "last_n_days", days: LOW_AI_SHARE_WINDOW_DAYS };

interface Props {
  settings: AppSettings | undefined;
  /** 主路由,用于"点击 toast 跳 Dashboard"的 navigate 注入(不直接依赖 useRouter,组件可独立测试)。 */
  onNavigate: (r: RouteId) => void;
}

export function LowAiShareWatcher({ settings, onNavigate }: Props) {
  const qc = useQueryClient();
  const lowAi = settings?.notifications?.low_ai_share;
  const enabled = lowAi?.enabled ?? false;
  const threshold = lowAi?.threshold_percent ?? LOW_AI_SHARE_DEFAULT_THRESHOLD;
  const targetEmailsConfig = lowAi?.target_emails;
  const manualTargetEmails = useMemo(
    () => normalizeLowAiShareTargetEmails(targetEmailsConfig ?? []),
    [targetEmailsConfig],
  );
  const remindIntervalMinutes = clampLowAiShareMinutes(
    lowAi?.remind_interval_minutes,
    LOW_AI_SHARE_DEFAULT_REMIND_INTERVAL_MINUTES,
    LOW_AI_SHARE_MIN_REMIND_INTERVAL_MINUTES,
    LOW_AI_SHARE_MAX_REMIND_INTERVAL_MINUTES,
  );
  const dismissMinutes = clampLowAiShareMinutes(
    lowAi?.dismiss_minutes,
    LOW_AI_SHARE_DEFAULT_DISMISS_MINUTES,
    LOW_AI_SHARE_MIN_DISMISS_MINUTES,
    LOW_AI_SHARE_MAX_DISMISS_MINUTES,
  );

  const repoQ = useQuery({
    queryKey: ["current_repo"],
    queryFn: currentRepo,
    staleTime: 30_000,
    enabled,
  });
  const repoPath = repoQ.data?.path ?? null;

  // 切仓时间戳:repoPath 变化即记一次。冷启从 null → 某值也视为切换 → 5 分钟冷却。
  //
  // 用组件级 useRef 而不是 per-repo localStorage:`decideLowAiShareNotification` 的
  // 语义是"距上次任意切仓 < 5 分钟则不弹"(`lowAiShareNotifier.ts:154`)。A→B→A 序列里
  // T2(回到 A 的时刻)被记下,5 分钟冷却从 T2 算 — 这是想要的"刚切完仓库别立刻骚扰"。
  // 改 per-repo localStorage 反而会让冷启动失去 5 分钟静默(localStorage 里上次切换
  // 可能是几天前)。
  const repoSwitchedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (repoPath !== null) repoSwitchedAtRef.current = Date.now();
  }, [repoPath]);

  const gitEmailQ = useQuery<string | null>({
    queryKey: ["current_git_user_email", repoPath],
    queryFn: currentGitUserEmail,
    enabled: enabled && repoPath !== null && manualTargetEmails.length === 0,
    staleTime: 60_000,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === repoPath ? prev : undefined),
  });

  const effectiveTargetEmails = useMemo(
    () =>
      manualTargetEmails.length > 0
        ? manualTargetEmails
        : gitEmailQ.data
          ? normalizeLowAiShareTargetEmails([gitEmailQ.data])
          : [],
    [gitEmailQ.data, manualTargetEmails],
  );
  const usePeopleBreakdown = effectiveTargetEmails.length > 0;
  const useRepoSummary =
    manualTargetEmails.length === 0 && gitEmailQ.isFetched && effectiveTargetEmails.length === 0;
  const scopeKey = lowAiShareScopeKey(effectiveTargetEmails);
  const scopeLabel =
    effectiveTargetEmails.length > 0 ? `作者: ${effectiveTargetEmails.join(", ")}` : "仓库整体";

  const historyQ = useQuery<HistoryResult>({
    queryKey: ["history", repoPath, rangeKey(SEVEN_DAY_RANGE)],
    queryFn: () => getHistory(SEVEN_DAY_RANGE),
    enabled: enabled && repoPath !== null && useRepoSummary,
    staleTime: STATS_STALE_MS,
    // 后台仍跑:15 分钟一次的聚合统计,频率最低,但用户最小化时仍要能收 OS 通知
    // ("AI 占比 < 阈值"也是用户配的关键告警,不应因为窗口隐藏就停推)。
    refetchInterval: LOW_AI_SHARE_CHECK_INTERVAL_MS,
    refetchIntervalInBackground: true,
    // 与 Dashboard 一致的 placeholderData 守卫:切仓不串旧数据。
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === repoPath ? prev : undefined),
  });

  const peopleQ = useQuery<PeopleBreakdownResult>({
    queryKey: ["people", repoPath, rangeKey(SEVEN_DAY_RANGE)],
    queryFn: () => getPeopleBreakdown(SEVEN_DAY_RANGE),
    enabled: enabled && repoPath !== null && usePeopleBreakdown,
    staleTime: STATS_STALE_MS,
    refetchInterval: LOW_AI_SHARE_CHECK_INTERVAL_MS,
    refetchIntervalInBackground: true,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === repoPath ? prev : undefined),
  });

  useEffect(() => {
    const reset = () => {
      void historyQ.refetch();
      void peopleQ.refetch();
    };
    window.addEventListener(LOW_AI_SHARE_RESET_EVENT, reset);
    return () => window.removeEventListener(LOW_AI_SHARE_RESET_EVENT, reset);
  }, [historyQ, peopleQ]);

  // 监听后端 fsnotify watcher 的 refs/notes/ai 变化事件:commit 完成后 1-3s 触发,
  // 立刻 invalidate history / people,跳过 15 分钟轮询。
  //
  // 依赖只保留 [enabled, repoPath, qc] —— historyQ / peopleQ 是 useQuery 返回的对象,
  // 每次 render 都是新引用,放进依赖会导致 listener 在每次 render 都 cleanup + 重新注册,
  // 既增加事件丢失窗口又把 useEffect 退化成"每次 render 副作用"。
  // invalidate active query 会让 react-query 自己 refetch,无需手动调 .refetch()。
  useEffect(() => {
    if (!enabled || !repoPath) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<{ repo_path?: string }>("git-ai-studio://notes-updated", (event) => {
      // 幂等保护:切仓后旧事件可能晚到,只处理当前仓库的事件
      if (event.payload?.repo_path && event.payload.repo_path !== repoPath) return;
      void qc.invalidateQueries({ queryKey: ["history", repoPath] });
      void qc.invalidateQueries({ queryKey: ["people", repoPath] });
    }).then((un) => {
      if (cancelled) {
        un();
      } else {
        unlisten = un;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled, repoPath, qc]);

  useEffect(() => {
    if (!enabled || !repoPath) return;
    const summary = (() => {
      if (usePeopleBreakdown) {
        const result = peopleQ.data;
        if (!result || result.status !== "ok") return null;
        return summarizeAiShareForEmails(result.payload, effectiveTargetEmails);
      }
      if (useRepoSummary) {
        const result = historyQ.data;
        if (!result || result.status !== "ok") return null;
        return summarizeAiShare(result.payload);
      }
      return null;
    })();
    if (!summary) return;

    const nowMs = Date.now();
    const decision = decideLowAiShareNotification({
      enabled,
      thresholdPercent: threshold,
      summary,
      nowMs,
      repoSwitchedAtMs: repoSwitchedAtRef.current,
      remindIntervalMs: remindIntervalMinutes * 60 * 1000,
      lastShownAtMs: readMsFromStorage(lastShownKey(repoPath, scopeKey)),
      dismissedUntilMs: readMsFromStorage(dismissedUntilKey(repoPath, scopeKey)),
    });
    if (!decision.trigger) return;

    // 标记 + 落盘
    writeMsToStorage(lastShownKey(repoPath, scopeKey), nowMs);

    const pct = summary.sharePercent ?? 0;
    const repoName = repoQ.data?.name ?? null;
    // OS 通知:与应用内 toast 并行推送,让用户在窗口最小化 / 隐藏到托盘时仍可见。
    // notify() 内部已做权限缓存与失败吞咽,不需要前端 catch。
    void notify(
      LOW_AI_SHARE_ALERT.toast_title(pct, threshold, repoName),
      `仓库: ${repoPath}\n统计对象: ${scopeLabel}\n近 ${LOW_AI_SHARE_WINDOW_DAYS} 天新增: ${summary.totalAdditions}\nAI 新增: ${summary.aiAdditions}\n提醒间隔: ${formatMinutes(remindIntervalMinutes)}`,
    );
    const dismiss = () => {
      const dismissedAt = Date.now();
      writeMsToStorage(
        dismissedUntilKey(repoPath, scopeKey),
        dismissedAt + dismissMinutes * 60 * 1000,
      );
      // 双保险:同步刷新 lastShownAt,即便 dismissedUntil 因任何边界(scope 切换等)失效,
      // cross_session_cooldown 也会按 remindInterval 兜住。
      writeMsToStorage(lastShownKey(repoPath, scopeKey), dismissedAt);
      toast.info(LOW_AI_SHARE_ALERT.dismissed_toast(formatMinutes(dismissMinutes)));
    };

    // duration: Infinity —— 不自动消失,必须用户显式操作才关闭。
    // 「查看 Dashboard」只跳转、不进静默;静默按钮与右上角 X 都按配置写入静默时长。
    //
    // id: 固定到 (repoPath, scopeKey) —— sonner 见到同 id 会"更新现有 toast",不会再叠一条。
    // 即使 effect 因任何原因(StrictMode 双调用、依赖抖动、并发 refetch)在用户关掉这条
    // 之前又跑到 trigger=true,屏幕上也只会刷新这一条 toast,不会出现"关一个又冒一个"。
    const toastId = `low-ai-share:${repoPath}:${scopeKey}`;
    toast.custom(
      (id) => (
        <LowAiShareToastCard
          title={LOW_AI_SHARE_ALERT.toast_title(pct, threshold, repoName)}
          description={`${LOW_AI_SHARE_ALERT.toast_description} ${scopeLabel}。`}
          onView={() => onNavigate("dashboard")}
          onDismiss={dismiss}
          onClose={() => toast.dismiss(id)}
          dismissLabel={LOW_AI_SHARE_ALERT.toast_action_dismiss(formatMinutes(dismissMinutes))}
        />
      ),
      { duration: Infinity, unstyled: true, id: toastId },
    );
  }, [
    enabled,
    effectiveTargetEmails,
    dismissMinutes,
    repoPath,
    repoQ.data?.name,
    remindIntervalMinutes,
    scopeKey,
    scopeLabel,
    threshold,
    historyQ.data,
    historyQ.dataUpdatedAt,
    peopleQ.data,
    peopleQ.dataUpdatedAt,
    onNavigate,
    usePeopleBreakdown,
    useRepoSummary,
  ]);

  return null;
}

/**
 * 低 AI 占比提醒的卡片视图。Watcher 真实提醒与 Settings「测试一下」共用同一张卡片,
 * 保证外观完全一致。
 *
 * # 职责边界
 * 卡片只负责布局与"点了哪个按钮",不持有静默时长 / 跳转等业务语义:
 * - `onView`:业务侧"查看 Dashboard"动作(测试态为 no-op)
 * - `onDismiss`:业务侧"静默一段时间"动作(测试态为 no-op)
 * - `onClose`:关闭这条 toast(`toast.dismiss(id)`)
 * 「查看」「静默按钮」「右上角 X」点击后都会调 `onClose`;
 * 其中「查看」走 onView,后两者走 onDismiss。
 */
export function LowAiShareToastCard({
  title,
  description,
  onView,
  onDismiss,
  onClose,
  dismissLabel = LOW_AI_SHARE_ALERT.toast_action_dismiss("24 小时"),
}: {
  title: string;
  description: string;
  onView: () => void;
  onDismiss: () => void;
  onClose: () => void;
  dismissLabel?: string;
}) {
  const handleView = () => {
    onView();
    onClose();
  };
  const handleDismiss = () => {
    onDismiss();
    onClose();
  };
  return (
    <div className="relative w-[360px] rounded-lg border border-border bg-card p-4 shadow-lg">
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="关闭并暂时不再提示"
        className="absolute right-2.5 top-2.5 rounded-sm p-0.5 text-slate-400 hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <div className="pr-5">
        <div className="text-sm font-medium leading-snug text-foreground">{title}</div>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{description}</p>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={handleView}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90"
        >
          {LOW_AI_SHARE_ALERT.toast_action_view}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="rounded-md border border-slate-200 px-3 py-1.5 text-xs hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800"
        >
          {dismissLabel}
        </button>
      </div>
    </div>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}
