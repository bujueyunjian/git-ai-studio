import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";

import {
  currentRepo,
  diagnoseEnvironment,
  diagnoseGitAiDaemon,
  getHistory,
  setAppSettings,
} from "../lib/api";
import { daemonIssueKey } from "../lib/daemonNotifier";
import { getCurrentLanguage } from "../i18n";
import { focusMainWindow } from "../lib/osNotify";
import {
  LOW_AI_SHARE_CHECK_INTERVAL_MS,
  LOW_AI_SHARE_DEFAULT_THRESHOLD,
  LOW_AI_SHARE_MIN_TOTAL_ADDITIONS,
  LOW_AI_SHARE_WINDOW_DAYS,
  summarizeAiShare,
} from "../lib/lowAiShareNotifier";
import { rangeKey } from "../lib/queryKeys";
import {
  DEFAULT_PET_THEME_ID,
  PET_COMMAND_EVENT,
  PET_READY_EVENT,
  PET_STATE_EVENT,
  PET_THEMES,
  decidePetState,
} from "../lib/petState";
import type { PetStatePayload } from "../lib/petState";
import type { AppSettings, TimeRange } from "../lib/types";

/** 后端 repo_notes_watcher 在 commit 完成 1-3s 内 emit 的事件(与 LowAiShareWatcher 同源)。 */
const NOTES_UPDATED_EVENT = "git-ai-studio://notes-updated";
/** pet 与 daemon 探测共用的 30s 间隔(与 DaemonWatcher 一致,同 key 共享缓存)。 */
const PET_PROBE_INTERVAL_MS = 30 * 1000;
/** 收到 notes-updated 后"正在打标"动画的持续时长。 */
const ATTRIBUTING_LINGER_MS = 2000;
/** 距上次 git 提交活动多久后进入 sleeping(语义是"该仓库无新提交",非"用户离开")。 */
const IDLE_MS = 30 * 60 * 1000;
/** 与 LowAiShareWatcher 同窗口(7 天),共享 history 缓存 key。 */
const PET_RANGE: TimeRange = { kind: "last_n_days", days: LOW_AI_SHARE_WINDOW_DAYS };
/** 尺寸档位 → 窗口 / 画布边长(px)。 */
const PET_SIZE_PX: Record<string, number> = { small: 140, medium: 180, large: 240 };

interface Props {
  settings: AppSettings | undefined;
}

/**
 * 桌面宠物的"大脑":挂在主窗口顶层,复用现有 watcher 的 react-query 数据(同 queryKey
 * 共享缓存,不重复跑 git-ai 子进程),用 `decidePetState` 纯函数收敛出单一状态,emit 给
 * pet 窗口渲染(单向数据流,ADR-011)。本组件不渲染任何 UI。
 *
 * 关:`settings.pet.enabled = false` → 所有 query `enabled=false`,完全不查不 emit。
 */
export function InkPetController({ settings }: Props) {
  const qc = useQueryClient();
  const enabled = settings?.pet?.enabled ?? false;
  const themeId = settings?.pet?.theme_id ?? DEFAULT_PET_THEME_ID;
  const sizePx = PET_SIZE_PX[settings?.pet?.size ?? "medium"] ?? PET_SIZE_PX.medium;
  const opacity = settings?.pet?.opacity ?? 1;
  const alertIntervalSec = settings?.pet?.alert_interval_sec ?? 30;
  const threshold =
    settings?.notifications?.low_ai_share?.threshold_percent ?? LOW_AI_SHARE_DEFAULT_THRESHOLD;

  // 短暂的"正在打标"态(收到 notes-updated 后亮起,2s 后熄)。
  const [attributing, setAttributing] = useState(false);
  // 心跳:每 60s ++,驱动 idle 重算 + 周期性重 emit(兜底 pet 窗口迟挂载错过早期 emit)。
  const [tick, setTick] = useState(0);
  // 上次 git 活动时间;notes-updated 时刷新,用于判定 sleeping。
  const lastActivityRef = useRef<number>(Date.now());

  // 当前仓库:history 按它的 path 取缓存 key(与 Dashboard / LowAiShareWatcher 共享)。
  const repoQ = useQuery({ queryKey: ["current_repo"], queryFn: currentRepo, enabled });
  const repoPath = repoQ.data?.path ?? null;

  // daemon 健康:与 DaemonWatcher 同 key 共享缓存。pet 不看 daemon_unhealthy_alert 开关 ——
  // 只要宠物开着就探测,因为墨团要能显示"daemon 卡"。
  const daemonQ = useQuery({
    queryKey: ["diagnose_git_ai_daemon"],
    queryFn: diagnoseGitAiDaemon,
    enabled,
    refetchInterval: enabled ? PET_PROBE_INTERVAL_MS : false,
    refetchIntervalInBackground: true,
  });

  // 诊断(hook 状态):复用 diagnose_environment 缓存(诊断页 / cc-switch 事件也用它)。
  const diagQ = useQuery({
    queryKey: ["diagnose_environment"],
    queryFn: () => diagnoseEnvironment(false),
    enabled,
  });

  // 7 天 history:与 Dashboard / LowAiShareWatcher 同 key + 缓存,绝不重复跑子进程。
  const historyQ = useQuery({
    queryKey: ["history", repoPath, rangeKey(PET_RANGE)],
    queryFn: () => getHistory(PET_RANGE),
    enabled: enabled && !!repoPath,
    refetchInterval: enabled ? LOW_AI_SHARE_CHECK_INTERVAL_MS : false,
    refetchIntervalInBackground: true,
  });

  // notes-updated:刷新活动时间 + 进入短暂"打标中" + 让 history 立即重拉(实时 AI 率)。
  useEffect(() => {
    if (!enabled) return;
    let lingerTimer: number | undefined;
    const unlistenP = listen(NOTES_UPDATED_EVENT, () => {
      lastActivityRef.current = Date.now();
      setAttributing(true);
      qc.invalidateQueries({ queryKey: ["history"] });
      window.clearTimeout(lingerTimer);
      lingerTimer = window.setTimeout(() => setAttributing(false), ATTRIBUTING_LINGER_MS);
    });
    return () => {
      unlistenP.then((un) => un()).catch(() => {});
      window.clearTimeout(lingerTimer);
    };
  }, [enabled, qc]);

  // 60s 心跳:推进 idle 判定 + 周期重 emit。
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [enabled]);

  // 切仓 / 仓库首次加载后,把"上次活动"重置为当前 —— 避免启动后盯着老仓库看代码 30min
  // 就被误判 sleeping(idle 语义是"该仓库无新提交",不是"用户离开了")。
  useEffect(() => {
    if (enabled && repoPath) lastActivityRef.current = Date.now();
  }, [enabled, repoPath]);

  // pet 窗口挂载后会 emit pet-ready;收到就 bump tick,触发主 effect 立刻补发当前状态,
  // 消除"pet 窗刚显示时停在默认 ok 直到下次心跳"的同步窗口期。
  useEffect(() => {
    if (!enabled) return;
    let un: (() => void) | undefined;
    listen(PET_READY_EVENT, () => setTick((t) => t + 1))
      .then((u) => {
        un = u;
      })
      .catch(() => {});
    return () => un?.();
  }, [enabled]);

  // pet 窗口的交互(右键菜单 / 双击)通过 pet-command 回传,主窗(持有 QueryClient)执行 ——
  // pet 窗口不直接改 settings / 不操作主窗,保持单向数据流(ADR-011)。
  useEffect(() => {
    if (!enabled) return;
    let un: (() => void) | undefined;
    listen<{ action: string }>(PET_COMMAND_EVENT, (e) => {
      switch (e.payload.action) {
        case "open-main":
          void focusMainWindow();
          break;
        case "open-diagnostic":
          // urgent 态(hook 缺失 / daemon 异常)双击直达诊断页:改主窗 hash 触发 hash router,再聚焦。
          window.location.hash = "#/diagnostic";
          void focusMainWindow();
          break;
        case "hide":
          setAppSettings({ pet_enabled: false })
            .then(() => qc.invalidateQueries({ queryKey: ["app_settings"] }))
            .catch(() => {});
          break;
        case "cycle-theme": {
          const ids = PET_THEMES.map((th) => th.id);
          const next = ids[(ids.indexOf(themeId) + 1) % ids.length];
          setAppSettings({ pet_theme_id: next })
            .then(() => qc.invalidateQueries({ queryKey: ["app_settings"] }))
            .catch(() => {});
          break;
        }
      }
    })
      .then((u) => {
        un = u;
      })
      .catch(() => {});
    return () => un?.();
  }, [enabled, themeId, qc]);

  // 收敛状态并 emit 给 pet 窗口。enable / 任一数据源 / 打标态 / 心跳变化都重算。
  useEffect(() => {
    if (!enabled) return;

    // 数据未就绪(首次加载)时下发 unknown 而非默认 ok —— 不在数据未知时粉饰成"一切正常"
    // (ADR-011 形象即数据 / CLAUDE.md 不粉饰)。各 query settle 后才计算真实状态。
    const dataReady =
      !repoQ.isLoading &&
      !daemonQ.isLoading &&
      !diagQ.isLoading &&
      (!repoPath || !historyQ.isLoading);
    if (!dataReady) {
      void emit(PET_STATE_EVENT, {
        kind: "unknown",
        aiSharePercent: null,
        themeId,
        opacity,
        alertIntervalSec,
        sizePx,
        lang: getCurrentLanguage(),
      } satisfies PetStatePayload);
      return;
    }

    const daemonUnhealthy = daemonQ.data ? daemonIssueKey(daemonQ.data) !== null : false;
    const agents = diagQ.data?.agents ?? [];
    const hookMissing = agents.some((a) => a.detected && !a.configured);

    const hist = historyQ.data;
    const summary = hist && hist.status === "ok" ? summarizeAiShare(hist.payload) : null;
    const aiSharePercent = summary?.sharePercent ?? null;
    const attributionFailed = hist?.status === "ok" ? hist.payload.failed_shas.length > 0 : false;
    // 阈值判定用精确 shareRatio(与 decideLowAiShareNotification 一致),避免 round 后整数在
    // 边界造成宠物状态与提醒不同步(~0.5pp 死区);展示(aiSharePercent / 气泡)仍用 round 值。
    const lowAiShare =
      summary !== null &&
      summary.totalAdditions >= LOW_AI_SHARE_MIN_TOTAL_ADDITIONS &&
      summary.shareRatio !== null &&
      summary.shareRatio * 100 < threshold;
    const idle = Date.now() - lastActivityRef.current > IDLE_MS;

    const kind = decidePetState({
      attributionFailed,
      daemonUnhealthy,
      hookMissing,
      attributing,
      lowAiShare,
      idle,
    });
    const payload: PetStatePayload = {
      kind,
      aiSharePercent,
      themeId,
      opacity,
      alertIntervalSec,
      sizePx,
      lang: getCurrentLanguage(),
    };
    void emit(PET_STATE_EVENT, payload);
    // tick 进依赖数组以驱动周期重算 / 重 emit;lastActivityRef 是 ref 不触发渲染,靠 tick 兜底。
  }, [
    enabled,
    themeId,
    opacity,
    alertIntervalSec,
    sizePx,
    threshold,
    repoPath,
    repoQ.isLoading,
    daemonQ.isLoading,
    diagQ.isLoading,
    historyQ.isLoading,
    daemonQ.data,
    diagQ.data,
    historyQ.data,
    attributing,
    tick,
  ]);

  return null;
}
