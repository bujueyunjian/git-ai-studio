/**
 * 低 AI 占比提醒的纯逻辑层。
 *
 * # 触发判定
 * - `enabled` 关 → 不提示
 * - 仓库未选 / getHistory degraded → 不提示
 * - 窗口内 `total_additions < MIN_TOTAL_ADDITIONS` → 不提示(样本太小没意义)
 * - 当前 share% 严格小于阈值 → 候选触发
 * - 距上次切仓 < `REPO_SWITCH_COOLDOWN_MS` → 不提示
 * - 距上次弹出 < 配置的提醒间隔 → 不提示
 * - 用户主动 X → 配置的静默时长内不提示
 *
 * # 与口径
 * `total_additions = human + unknown + ai`(与 git-ai 上游 stats.rs:114 一致,3 桶并列)。
 * 数据来源 = 仓库整体用 Dashboard 的 `getHistory.daily_buckets`;按人统计用 People 的 author 聚合。
 */

import type { HistoryPayload, PeopleBreakdownPayload } from "./types";

/**
 * 阈值百分比预设档,与 Settings UI 同步。除这些档外 Settings 另给"自定义"入口
 * (1–100 整数,后端 `clamp(1,100)` 兜底)。判定逻辑层对任意整数阈值都成立,
 * 预设只是降低常用值的点击成本。
 */
export const LOW_AI_SHARE_THRESHOLD_OPTIONS = [100, 95, 90, 85, 80] as const;
export const LOW_AI_SHARE_DEFAULT_THRESHOLD = 80;

/** 窗口固定 7 天 —— 阈值已经一个,再加窗口长度会让用户配不过来,粗粒度信号即可。 */
export const LOW_AI_SHARE_WINDOW_DAYS = 7;
/** 总加行数下限。新仓 / 慢周容易低于此线,小样本结果不稳定。 */
export const LOW_AI_SHARE_MIN_TOTAL_ADDITIONS = 50;
/** 切仓后冷却期:刚切到一个老仓库不该立即被弹窗抢话。 */
export const LOW_AI_SHARE_REPO_SWITCH_COOLDOWN_MS = 5 * 60 * 1000;
/** 默认重复提醒间隔:同一仓库同一统计对象 6 小时最多提醒一次。 */
export const LOW_AI_SHARE_DEFAULT_REMIND_INTERVAL_MINUTES = 6 * 60;
/** 用户主动 X 后的默认静默时长。 */
export const LOW_AI_SHARE_DEFAULT_DISMISS_MINUTES = 24 * 60;
/** 提醒间隔的可配置边界。 */
export const LOW_AI_SHARE_MIN_REMIND_INTERVAL_MINUTES = 5;
export const LOW_AI_SHARE_MAX_REMIND_INTERVAL_MINUTES = 24 * 60;
/** 点 X 静默时长的可配置边界。 */
export const LOW_AI_SHARE_MIN_DISMISS_MINUTES = 5;
export const LOW_AI_SHARE_MAX_DISMISS_MINUTES = 7 * 24 * 60;
/** 前端轮询间隔。 */
export const LOW_AI_SHARE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
export const LOW_AI_SHARE_RESET_EVENT = "git-ai-studio:low-ai-share-reset";

export interface LowAiShareSummary {
  aiAdditions: number;
  totalAdditions: number;
  /** 当前 AI 占比 [0, 100],integer-rounded;无数据为 null。 */
  sharePercent: number | null;
}

/** 从 HistoryPayload 的 daily_buckets 聚合出 7 天总览。 */
export function summarizeAiShare(payload: HistoryPayload): LowAiShareSummary {
  let human = 0;
  let unknown = 0;
  let ai = 0;
  for (const b of payload.daily_buckets) {
    human += b.human_additions;
    unknown += b.unknown_additions;
    ai += b.ai_additions;
  }
  const total = human + unknown + ai;
  return {
    aiAdditions: ai,
    totalAdditions: total,
    sharePercent: total > 0 ? Math.round((ai / total) * 100) : null,
  };
}

/** 从 People 聚合结果中只统计指定邮箱;空邮箱列表不应调用此函数。 */
export function summarizeAiShareForEmails(
  payload: PeopleBreakdownPayload,
  targetEmails: readonly string[],
): LowAiShareSummary {
  const target = new Set(normalizeLowAiShareTargetEmails(targetEmails));
  let ai = 0;
  let total = 0;
  for (const row of payload.rows) {
    if (!target.has(row.identity_key.toLowerCase())) continue;
    ai += row.ai_additions;
    total += row.total_additions;
  }
  return {
    aiAdditions: ai,
    totalAdditions: total,
    sharePercent: total > 0 ? Math.round((ai / total) * 100) : null,
  };
}

/** 邮箱配置归一化:trim、lowercase、去重、排序,让持久化与 localStorage key 稳定。 */
export function normalizeLowAiShareTargetEmails(input: readonly string[] | string): string[] {
  const raw = typeof input === "string" ? input.split(/[,\n;]/) : input;
  return Array.from(
    new Set(raw.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)),
  ).sort();
}

export function clampLowAiShareMinutes(
  value: number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export interface ShouldNotifyInput {
  enabled: boolean;
  thresholdPercent: number;
  summary: LowAiShareSummary;
  nowMs: number;
  /** 仓库刚切换的时间戳(本仓);null 表示未记录(冷启动)。 */
  repoSwitchedAtMs: number | null;
  /** 重复提醒间隔。 */
  remindIntervalMs: number;
  /** 上次弹出时间(本仓 + 统计对象);从 localStorage 读。 */
  lastShownAtMs: number | null;
  /** 用户主动 X 的解封时间(本仓 + 统计对象);从 localStorage 读。 */
  dismissedUntilMs: number | null;
}

export interface NotifyDecision {
  trigger: boolean;
  /** 不触发时的原因(便于调试 / 不在 toast 显示);触发时为 null。 */
  reason:
    | null
    | "disabled"
    | "insufficient_sample"
    | "share_above_threshold"
    | "repo_just_switched"
    | "cross_session_cooldown"
    | "user_dismissed";
}

/** 唯一的判定函数。纯函数易测,不持有任何 state。 */
export function decideLowAiShareNotification(input: ShouldNotifyInput): NotifyDecision {
  if (!input.enabled) return { trigger: false, reason: "disabled" };
  if (input.summary.totalAdditions < LOW_AI_SHARE_MIN_TOTAL_ADDITIONS) {
    return { trigger: false, reason: "insufficient_sample" };
  }
  const share = input.summary.sharePercent;
  if (share === null || share >= input.thresholdPercent) {
    return { trigger: false, reason: "share_above_threshold" };
  }
  if (
    input.repoSwitchedAtMs !== null &&
    input.nowMs - input.repoSwitchedAtMs < LOW_AI_SHARE_REPO_SWITCH_COOLDOWN_MS
  ) {
    return { trigger: false, reason: "repo_just_switched" };
  }
  if (input.lastShownAtMs !== null && input.nowMs - input.lastShownAtMs < input.remindIntervalMs) {
    return { trigger: false, reason: "cross_session_cooldown" };
  }
  if (input.dismissedUntilMs !== null && input.nowMs < input.dismissedUntilMs) {
    return { trigger: false, reason: "user_dismissed" };
  }
  return { trigger: true, reason: null };
}

/**
 * localStorage 键名空间(遵循项目既有 dotted 前缀约定:`git-ai-studio.theme` 等)。
 * repoPath 含 `\\` `:` 等字符,转 `_` 后再嵌入,可读性 + 未来清理都更方便。
 */
function sanitizeStorageKeyPart(repoPath: string): string {
  return repoPath.replace(/[\\/:]+/g, "_");
}

export function lowAiShareScopeKey(targetEmails: readonly string[]): string {
  const normalized = normalizeLowAiShareTargetEmails(targetEmails);
  return normalized.length === 0 ? "repo" : `emails.${normalized.join(",")}`;
}

function scopedKeyPrefix(repoPath: string, scopeKey: string): string {
  const repoKey = sanitizeStorageKeyPart(repoPath);
  if (scopeKey === "repo") return `git-ai-studio.notifications.lowAiShare.${repoKey}`;
  return `git-ai-studio.notifications.lowAiShare.${repoKey}.${sanitizeStorageKeyPart(scopeKey)}`;
}

export function lastShownKey(repoPath: string, scopeKey = "repo"): string {
  return `${scopedKeyPrefix(repoPath, scopeKey)}.lastShownAt`;
}

export function dismissedUntilKey(repoPath: string, scopeKey = "repo"): string {
  return `${scopedKeyPrefix(repoPath, scopeKey)}.dismissedUntil`;
}

/**
 * localStorage 不可用时(Safari Private 模式等)的内存兜底。
 * lowAiShare / daemon 两份模块各自维护 Map,避免循环 import;key 前缀互不交叉,无冲突风险。
 */
const memoryFallback = new Map<string, number>();
let storageBlocklisted = false;

export function readMsFromStorage(key: string): number | null {
  if (!storageBlocklisted) {
    try {
      const v = window.localStorage.getItem(key);
      if (v !== null) {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }
    } catch {
      storageBlocklisted = true;
    }
  }
  return memoryFallback.get(key) ?? null;
}

export function writeMsToStorage(key: string, ms: number): void {
  memoryFallback.set(key, ms);
  if (storageBlocklisted) return;
  try {
    window.localStorage.setItem(key, String(ms));
  } catch {
    storageBlocklisted = true;
  }
}

export function clearLowAiShareSilence(repoPath: string | null): void {
  try {
    const prefix = "git-ai-studio.notifications.lowAiShare.";
    if (repoPath) {
      const repoPrefix = `${prefix}${sanitizeStorageKeyPart(repoPath)}`;
      const keys: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (key?.startsWith(repoPrefix)) keys.push(key);
      }
      keys.forEach((key) => window.localStorage.removeItem(key));
      return;
    }
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // localStorage 不可用时没有可清理的持久静默。
  }
}
