import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Download,
  ExternalLink,
  Filter,
  Loader2,
  LogOut,
  Minimize2,
  Moon,
  Palette,
  Power,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Sun,
  Upload,
  UserCircle2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { useUpdate } from "../contexts/UpdateContext";
import { relaunchApp, type UpdateProgressEvent } from "../lib/updater";
import { RadioGroup, RadioItem } from "../components/ui/RadioGroupBar";
import { Switch } from "../components/ui/SwitchToggle";
import { Dialog } from "../components/ui/DialogShell";
import {
  exportAppSettings,
  currentGitUserEmail,
  getAppSettings,
  getAutoLaunchStatus,
  getGitAiConfig,
  getWhoami,
  importAppSettings,
  listEffectiveIgnorePatterns,
  logoutGitAi,
  setAppSettings,
  setAutoLaunch,
} from "../lib/api";
import {
  applyTheme,
  loadTheme,
  persistTheme,
  subscribeSystemTheme,
  type Theme,
} from "../lib/theme";
import i18n, { setLanguage, type SupportedLanguage } from "../i18n";
import { LowAiShareToastCard } from "../components/LowAiShareWatcher";
import { DAEMON_RESET_EVENT, clearDaemonSilence } from "../lib/daemonNotifier";
import { REPO_SETUP_GUIDE_OPEN_EVENT } from "../components/RepoSetupGuide";
import {
  LOW_AI_SHARE_DEFAULT_DISMISS_MINUTES,
  LOW_AI_SHARE_DEFAULT_REMIND_INTERVAL_MINUTES,
  LOW_AI_SHARE_DEFAULT_THRESHOLD,
  LOW_AI_SHARE_MAX_DISMISS_MINUTES,
  LOW_AI_SHARE_MAX_REMIND_INTERVAL_MINUTES,
  LOW_AI_SHARE_MIN_DISMISS_MINUTES,
  LOW_AI_SHARE_MIN_REMIND_INTERVAL_MINUTES,
  LOW_AI_SHARE_RESET_EVENT,
  LOW_AI_SHARE_THRESHOLD_OPTIONS,
  clampLowAiShareMinutes,
  clearLowAiShareSilence,
  normalizeLowAiShareTargetEmails,
} from "../lib/lowAiShareNotifier";
import type {
  AppSettingsPatch,
  AuthState,
  CloseBehavior,
  EffectiveIgnorePatternsResult,
  WhoamiResult,
} from "../lib/types";
import { DEFAULT_PET_THEME_ID, PET_THEMES } from "../lib/petState";
import { useRouter } from "../router";

type SettingsTabId = "general" | "monitor" | "data";

const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = [
  { id: "general", label: "通用" },
  { id: "monitor", label: "守护与通知" },
  { id: "data", label: "数据与集成" },
];

export default function SettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { navigate } = useRouter();
  const [tab, setTab] = useState<SettingsTabId>("general");
  const settingsQ = useQuery({ queryKey: ["app_settings"], queryFn: getAppSettings });
  const cfgQ = useQuery({ queryKey: ["git_ai_config"], queryFn: getGitAiConfig });
  const gitEmailQ = useQuery({
    queryKey: ["current_git_user_email"],
    queryFn: currentGitUserEmail,
    enabled: settingsQ.data?.notifications?.low_ai_share?.enabled ?? false,
    staleTime: 60_000,
  });

  const [theme, setTheme] = useState<Theme>(() => loadTheme());

  // 用户点 RadioGroup 触发的副作用:仅持久化 + 应用。
  // 不依赖 settingsQ.data?.theme,避免后端 query 刷新时回写自身造成循环写入。
  useEffect(() => {
    persistTheme(theme);
    applyTheme(theme);
    subscribeSystemTheme(theme);
  }, [theme]);

  // 单独把"theme 变化 → 通知后端"做防抖式写入:只在与服务器值不一致时写。
  useEffect(() => {
    const serverTheme = settingsQ.data?.theme ?? null;
    if (settingsQ.isLoading) return;
    if (serverTheme === theme) return;
    setAppSettings({ theme }).catch(() => {});
    qc.invalidateQueries({ queryKey: ["app_settings"] });
  }, [theme, settingsQ.data?.theme, settingsQ.isLoading, qc]);

  const closeBehaviorM = useMutation({
    mutationFn: (b: CloseBehavior) => setAppSettings({ close_behavior: b }),
    onSuccess: (_, b) => {
      qc.invalidateQueries({ queryKey: ["app_settings"] });
      toast.success(b === "tray" ? "已切换为最小化到托盘" : "已切换为关闭即退出");
    },
    onError: (e) => toast.error("保存失败", { description: (e as Error).message }),
  });
  const closeBehavior: CloseBehavior =
    (settingsQ.data?.close_behavior as CloseBehavior | null) ?? "exit";

  // 开机自启:真源为操作系统登录项,直接读 OS 状态(不落 app config)。
  const autoLaunchQ = useQuery({
    queryKey: ["auto_launch_status"],
    queryFn: getAutoLaunchStatus,
  });
  const autoLaunchM = useMutation({
    mutationFn: (enable: boolean) => setAutoLaunch(enable),
    onSuccess: (enabled) => {
      qc.invalidateQueries({ queryKey: ["auto_launch_status"] });
      toast.success(enabled ? "已开启开机自启" : "已关闭开机自启");
    },
    onError: (e) => toast.error("设置开机自启失败", { description: (e as Error).message }),
  });

  // 注:cc_switch_auto_repair 已搬到 notifications 嵌套结构;读取兼容旧顶层字段(后端会迁移)。
  const ccSwitchAutoRepair =
    settingsQ.data?.notifications?.cc_switch_auto_repair ??
    settingsQ.data?.cc_switch_auto_repair ??
    false;
  const ccSwitchM = useMutation({
    mutationFn: (enable: boolean) => setAppSettings({ cc_switch_auto_repair: enable }),
    onSuccess: (_, enable) => {
      qc.invalidateQueries({ queryKey: ["app_settings"] });
      toast.success(enable ? "cc-switch 守护已启用" : "cc-switch 守护已停用");
    },
    onError: (e) => toast.error("保存失败", { description: (e as Error).message }),
  });

  // ===== 低 AI 占比提醒 =====
  const lowAi = settingsQ.data?.notifications?.low_ai_share;
  const lowAiEnabled = lowAi?.enabled ?? false;
  const lowAiThreshold = lowAi?.threshold_percent ?? LOW_AI_SHARE_DEFAULT_THRESHOLD;
  const lowAiTargetEmails = normalizeLowAiShareTargetEmails(lowAi?.target_emails ?? []);
  const lowAiTargetEmailsText = lowAiTargetEmails.join("\n");
  const lowAiRemindInterval = clampLowAiShareMinutes(
    lowAi?.remind_interval_minutes,
    LOW_AI_SHARE_DEFAULT_REMIND_INTERVAL_MINUTES,
    LOW_AI_SHARE_MIN_REMIND_INTERVAL_MINUTES,
    LOW_AI_SHARE_MAX_REMIND_INTERVAL_MINUTES,
  );
  const lowAiDismissMinutes = clampLowAiShareMinutes(
    lowAi?.dismiss_minutes,
    LOW_AI_SHARE_DEFAULT_DISMISS_MINUTES,
    LOW_AI_SHARE_MIN_DISMISS_MINUTES,
    LOW_AI_SHARE_MAX_DISMISS_MINUTES,
  );
  const lowAiEnableM = useMutation({
    mutationFn: (enable: boolean) => setAppSettings({ low_ai_share_enabled: enable }),
    onSuccess: (_, enable) => {
      qc.invalidateQueries({ queryKey: ["app_settings"] });
      toast.success(enable ? "低 AI 占比提醒已开启" : "低 AI 占比提醒已关闭");
    },
    onError: (e) => toast.error("保存失败", { description: (e as Error).message }),
  });
  const lowAiThresholdM = useMutation({
    mutationFn: (n: number) => setAppSettings({ low_ai_share_threshold_percent: n }),
    onSuccess: (_, n) => {
      qc.invalidateQueries({ queryKey: ["app_settings"] });
      toast.success(`阈值已保存(${n}%)`);
    },
    onError: (e) => toast.error("保存失败", { description: (e as Error).message }),
  });
  const lowAiTargetEmailsM = useMutation({
    mutationFn: (emails: string[]) => setAppSettings({ low_ai_share_target_emails: emails }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app_settings"] });
      toast.success("关注邮箱已保存");
    },
    onError: (e) => toast.error("保存关注邮箱失败", { description: (e as Error).message }),
  });
  const lowAiRemindIntervalM = useMutation({
    mutationFn: (minutes: number) =>
      setAppSettings({ low_ai_share_remind_interval_minutes: minutes }),
    onSuccess: (_, minutes) => {
      qc.invalidateQueries({ queryKey: ["app_settings"] });
      toast.success(`提醒间隔已保存(${minutes} 分钟)`);
    },
    onError: (e) => toast.error("保存提醒间隔失败", { description: (e as Error).message }),
  });
  const lowAiDismissMinutesM = useMutation({
    mutationFn: (minutes: number) => setAppSettings({ low_ai_share_dismiss_minutes: minutes }),
    onSuccess: (_, minutes) => {
      qc.invalidateQueries({ queryKey: ["app_settings"] });
      toast.success(`静默时长已保存(${minutes} 分钟)`);
    },
    onError: (e) => toast.error("保存静默时长失败", { description: (e as Error).message }),
  });
  // 实时触发开关:null = 走前端默认 true(向后兼容老配置无此字段的场景)
  const lowAiRealtime = lowAi?.realtime_enabled ?? true;
  const lowAiRealtimeM = useMutation({
    mutationFn: (enable: boolean) => setAppSettings({ low_ai_share_realtime_enabled: enable }),
    onSuccess: (_, enable) => {
      qc.invalidateQueries({ queryKey: ["app_settings"] });
      toast.success(
        enable ? "实时触发已开启(commit 后 1-3s 推送)" : "实时触发已关闭(回到 15 分钟轮询)",
      );
    },
    onError: (e) => toast.error("保存实时开关失败", { description: (e as Error).message }),
  });
  const [targetEmailsDraft, setTargetEmailsDraft] = useState("");
  useEffect(() => {
    setTargetEmailsDraft(lowAiTargetEmailsText);
  }, [lowAiTargetEmailsText]);
  // 当前阈值是否落在预设档:落在 → 高亮对应档;不在 → 视为自定义并展开输入框。
  const isPresetThreshold = (LOW_AI_SHARE_THRESHOLD_OPTIONS as readonly number[]).includes(
    lowAiThreshold,
  );
  const [customThresholdOpen, setCustomThresholdOpen] = useState(false);
  const [customThresholdDraft, setCustomThresholdDraft] = useState("");
  const showCustomThreshold = customThresholdOpen || !isPresetThreshold;
  const commitCustomThreshold = () => {
    const n = Math.round(Number(customThresholdDraft));
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      toast.error("阈值需为 1–100 的整数");
      return;
    }
    lowAiThresholdM.mutate(n);
  };
  const saveTargetEmails = () => {
    lowAiTargetEmailsM.mutate(normalizeLowAiShareTargetEmails(targetEmailsDraft));
  };
  const saveRemindInterval = (minutes: number) => {
    lowAiRemindIntervalM.mutate(
      clampLowAiShareMinutes(
        minutes,
        LOW_AI_SHARE_DEFAULT_REMIND_INTERVAL_MINUTES,
        LOW_AI_SHARE_MIN_REMIND_INTERVAL_MINUTES,
        LOW_AI_SHARE_MAX_REMIND_INTERVAL_MINUTES,
      ),
    );
  };
  const saveDismissMinutes = (minutes: number) => {
    lowAiDismissMinutesM.mutate(
      clampLowAiShareMinutes(
        minutes,
        LOW_AI_SHARE_DEFAULT_DISMISS_MINUTES,
        LOW_AI_SHARE_MIN_DISMISS_MINUTES,
        LOW_AI_SHARE_MAX_DISMISS_MINUTES,
      ),
    );
  };
  // 测试按钮:用当前阈值 + 一个明显低于阈值的示例占比,完整复刻真实提醒外观。
  // 不写 localStorage / 不进冷却,纯预览,不影响真实提醒节奏。
  const handleTestLowAiToast = () => {
    const exampleShare = Math.max(0, lowAiThreshold - 5);
    // 纯预览:与真实提醒共用 LowAiShareToastCard,onView/onDismiss 为 no-op,
    // 不写 localStorage、不进冷却,仅复刻外观与"必须点击才关"行为。
    // 固定 id:连点「测试一下」时 sonner 会复用同一条 toast 而不是叠加多条预览。
    toast.custom(
      (id) => (
        <LowAiShareToastCard
          title={t("lowAiShare.toastTitleWithRepoTemplate", {
            pct: exampleShare,
            threshold: lowAiThreshold,
            repoName: "示例仓库",
          })}
          description={t("lowAiShare.toastDescription")}
          onView={() => {}}
          onDismiss={() => {}}
          onClose={() => toast.dismiss(id)}
        />
      ),
      { duration: Infinity, unstyled: true, id: "low-ai-share:test-preview" },
    );
  };

  // ===== task #7:daemon 异常告警独立总开关 =====
  const daemonAlert = settingsQ.data?.notifications?.daemon_unhealthy_alert ?? false;
  const daemonAlertM = useMutation({
    mutationFn: (enable: boolean) => setAppSettings({ daemon_unhealthy_alert: enable }),
    onSuccess: (_, enable) => {
      qc.invalidateQueries({ queryKey: ["app_settings"] });
      toast.success(enable ? "daemon 异常告警已开启" : "daemon 异常告警已关闭");
    },
    onError: (e) => toast.error("保存失败", { description: (e as Error).message }),
  });
  // ===== 桌面宠物(Ink pet)=====
  const petEnabled = settingsQ.data?.pet?.enabled ?? false;
  const petThemeId = settingsQ.data?.pet?.theme_id ?? DEFAULT_PET_THEME_ID;
  const petSize = settingsQ.data?.pet?.size ?? "medium";
  const petOpacity = settingsQ.data?.pet?.opacity ?? 1;
  const petAlertSec = settingsQ.data?.pet?.alert_interval_sec ?? 30;
  // 透明度拖动期间走本地草稿,松手才提交,避免每帧打一次 setAppSettings。
  const [petOpacityDraft, setPetOpacityDraft] = useState<number | null>(null);
  const petOpacityValue = petOpacityDraft ?? petOpacity;
  const petEnableM = useMutation({
    mutationFn: (enable: boolean) => setAppSettings({ pet_enabled: enable }),
    onSuccess: (_, enable) => {
      qc.invalidateQueries({ queryKey: ["app_settings"] });
      toast.success(enable ? i18n.t("pet.toast.enabled") : i18n.t("pet.toast.disabled"));
    },
    onError: (e) => toast.error("保存失败", { description: (e as Error).message }),
  });
  // 主题 / 大小 / 透明度 / 提醒间隔共用一个增量 patch mutation。
  const petPatchM = useMutation({
    mutationFn: (patch: AppSettingsPatch) => setAppSettings(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app_settings"] }),
    onError: (e) => toast.error("保存失败", { description: (e as Error).message }),
  });
  // 分段按钮统一样式(选中高亮 / 未选中描边)。
  const segCls = (active: boolean) =>
    active
      ? "rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
      : "rounded-md border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800";

  const resetDaemonSilence = () => {
    clearDaemonSilence();
    window.dispatchEvent(new Event(DAEMON_RESET_EVENT));
    toast.success("已重置 daemon 静默,下次探测到异常会重新提醒");
  };

  const resetLowAiSilence = () => {
    clearLowAiShareSilence(null);
    window.dispatchEvent(new Event(LOW_AI_SHARE_RESET_EVENT));
    toast.success("已恢复低 AI 占比提醒");
  };

  async function handleExport() {
    try {
      const json = await exportAppSettings();
      await navigator.clipboard.writeText(json);
      toast.success("配置 JSON 已复制到剪贴板");
    } catch (e) {
      toast.error("导出失败", { description: (e as Error).message });
    }
  }

  async function handleImport() {
    const text = window.prompt("粘贴配置 JSON 文本:");
    if (!text) return;
    try {
      await importAppSettings(text);
      qc.invalidateQueries({ queryKey: ["app_settings"] });
      qc.invalidateQueries({ queryKey: ["scan_roots"] });
      qc.invalidateQueries({ queryKey: ["recent_repos"] });
      toast.success("配置已导入");
    } catch (e) {
      toast.error("导入失败,请检查 JSON 格式", { description: (e as Error).message });
    }
  }

  const autoUpdateEnabled = !(cfgQ.data?.disable_auto_updates ?? false);

  // ===== 客户端自更新(tauri-plugin-updater)=====
  // 应用版本号:从 Tauri 运行时读取,替代硬编码。非 Tauri 环境(浏览器调试)下为空串。
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(""));
  }, []);

  const { hasUpdate, updateInfo, updateHandle, checkUpdate, resetDismiss } = useUpdate();
  const [isDownloading, setIsDownloading] = useState(false);
  // 下载进度:已下载 / 总字节数,用于按钮上的百分比展示。
  const [downloadProgress, setDownloadProgress] = useState<{ downloaded: number; total: number }>({
    downloaded: 0,
    total: 0,
  });

  // 检查更新 / 下载并安装:无更新时仅检查并提示;有更新时下载、安装、重启。
  // 复刻 cc-switch AboutSection.tsx:397-439,省略 portable 分支(本项目无便携版)。
  async function handleCheckOrInstall() {
    if (hasUpdate && updateHandle) {
      setIsDownloading(true);
      setDownloadProgress({ downloaded: 0, total: 0 });
      try {
        resetDismiss();
        await updateHandle.downloadAndInstall((evt: UpdateProgressEvent) => {
          setDownloadProgress((prev) => {
            if (evt.event === "Started") {
              return { downloaded: 0, total: evt.total ?? 0 };
            }
            if (evt.event === "Progress") {
              return { ...prev, downloaded: prev.downloaded + (evt.downloaded ?? 0) };
            }
            return prev;
          });
        });
        await relaunchApp();
      } catch (e) {
        toast.error(i18n.t("update.installFailed"), { description: (e as Error).message });
      } finally {
        setIsDownloading(false);
      }
      return;
    }

    try {
      const available = await checkUpdate();
      if (!available) {
        toast.success(i18n.t("update.upToDate"));
      }
    } catch (e) {
      toast.error(i18n.t("update.checkFailed"), { description: (e as Error).message });
    }
  }

  const downloadPercent =
    downloadProgress.total > 0
      ? Math.min(100, Math.round((downloadProgress.downloaded / downloadProgress.total) * 100))
      : 0;

  // Tab 隐藏 helper:把每个 section 的 className 拼上 hidden 条件,切 tab 时该 section 直接 hidden。
  // 用 CSS 隐藏而非条件渲染:组件保持 mount,form draft / mutation 状态不丢失。
  const tabClass = (t: SettingsTabId) => (tab === t ? "" : "hidden ");

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">设置</h1>
        <p className="mt-0.5 text-xs text-slate-500">应用外观、数据存储、关键配置入口。</p>
      </div>

      {/* Tab 切换栏。用 hidden className 控制可见性而非条件渲染,切 tab 时组件保持 mount,
          表单 draft / mutation 状态不丢失。 */}
      <nav className="flex items-center gap-1 border-b border-border">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={
              tab === t.id
                ? "border-b-2 border-primary px-3 py-2 text-sm font-medium text-primary"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-slate-500 hover:text-foreground"
            }
            aria-selected={tab === t.id}
            role="tab"
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* 外观 — general */}
      <section className={`${tabClass("general")}rounded-lg border border-border bg-card p-4`}>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Palette className="h-4 w-4 text-slate-500" /> 外观主题
        </h2>
        <RadioGroup value={theme} onValueChange={(v: Theme) => setTheme(v)}>
          <RadioItem value="light">
            <Sun className="h-3.5 w-3.5" /> 浅色
          </RadioItem>
          <RadioItem value="dark">
            <Moon className="h-3.5 w-3.5" /> 深色
          </RadioItem>
          <RadioItem value="system">
            <RefreshCw className="h-3.5 w-3.5" /> 跟随系统
          </RadioItem>
        </RadioGroup>
        <p className="mt-2 text-[11px] text-slate-400">
          切换"跟随系统"后,会监听操作系统的浅色/深色偏好并自动同步。
        </p>
      </section>

      {/* 界面语言 — general */}
      <section className={`${tabClass("general")}rounded-lg border border-border bg-card p-4`}>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Palette className="h-4 w-4 text-slate-500" /> {i18n.t("settings.language.label")}
        </h2>
        <div className="flex items-center gap-2">
          <select
            value={(i18n.language === "en" ? "en" : "zh-CN") as SupportedLanguage}
            onChange={(e) => setLanguage(e.target.value as SupportedLanguage)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm dark:border-border dark:bg-card"
            aria-label={i18n.t("settings.language.label")}
          >
            <option value="zh-CN">{i18n.t("settings.language.zh_CN")}</option>
            <option value="en">{i18n.t("settings.language.en")}</option>
          </select>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">{i18n.t("settings.language.hint")}</p>
      </section>

      {/* 关闭窗口时的行为 — general */}
      <section className={`${tabClass("general")}rounded-lg border border-border bg-card p-4`}>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Minimize2 className="h-4 w-4 text-slate-500" /> 关闭窗口时
        </h2>
        <RadioGroup
          value={closeBehavior}
          onValueChange={(v: CloseBehavior) => closeBehaviorM.mutate(v)}
        >
          <RadioItem value="exit">
            <LogOut className="h-3.5 w-3.5" /> 退出应用(默认)
          </RadioItem>
          <RadioItem value="tray">
            <Minimize2 className="h-3.5 w-3.5" /> 最小化到系统托盘
          </RadioItem>
        </RadioGroup>
        <p className="mt-2 text-[11px] text-slate-400">
          选「最小化到托盘」后,点窗口 X 不退出进程;左键点托盘图标或从托盘菜单选「显示主窗口」恢复。
          托盘菜单始终提供「退出」入口。
        </p>
      </section>

      {/* 开机自启(应用本体) — general */}
      <section className={`${tabClass("general")}rounded-lg border border-border bg-card p-4`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <Power className="h-4 w-4 text-slate-500" /> 开机自启
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              开启后,登录系统时自动启动 Git AI Studio(配合「关闭窗口时 → 最小化到托盘」可常驻后台)。
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              真值为操作系统登录项,卸载应用前请先关闭此项,避免残留启动项。
            </p>
          </div>
          <Switch
            checked={autoLaunchQ.data ?? false}
            onCheckedChange={(v) => autoLaunchM.mutate(v)}
            disabled={autoLaunchQ.isLoading || autoLaunchM.isPending}
            aria-label="开启开机自启"
          />
        </div>
      </section>

      {/* cc-switch 守护 — monitor */}
      <section className={`${tabClass("monitor")}rounded-lg border border-border bg-card p-4`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="h-4 w-4 text-slate-500" /> cc-switch 守护
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              cc-switch 切换 Codex profile 时会整体覆盖{" "}
              <code className="font-mono">~/.codex/config.toml</code>
              ,git-ai 写入的 hooks 段必然丢失。开启后,studio 监听该文件变化,发现 hook 缺失则自动调
              <code className="ml-1 font-mono">git-ai install-hooks</code>
              增量恢复(toml_edit 字段级合并,不冲突 cc-switch 写入的{" "}
              <code className="font-mono">[model_providers.*]</code> 等字段)。
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              默认关闭。无明确授权前 studio 不会替用户改这些文件。
            </p>
          </div>
          <Switch
            checked={ccSwitchAutoRepair}
            onCheckedChange={(v) => ccSwitchM.mutate(v)}
            disabled={ccSwitchM.isPending}
            aria-label="开启 cc-switch 守护"
          />
        </div>
      </section>

      {/* 桌面宠物 — monitor */}
      <section className={`${tabClass("monitor")}rounded-lg border border-border bg-card p-4`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-4 w-4 text-slate-500" /> {i18n.t("pet.settings.title")}
            </h2>
            <p className="mt-1 text-xs text-slate-500">{i18n.t("pet.settings.hint")}</p>
          </div>
          <Switch
            checked={petEnabled}
            onCheckedChange={(v) => petEnableM.mutate(v)}
            disabled={petEnableM.isPending}
            aria-label={i18n.t("pet.settings.title")}
          />
        </div>
        {petEnabled && (
          <div className="mt-3 space-y-3 border-t border-border pt-3">
            {/* 形象主题 */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground">
                  {i18n.t("pet.settings.themeLabel")}
                </div>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {i18n.t("pet.settings.themeHint")}
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-1.5">
                {PET_THEMES.map((th) => (
                  <button
                    key={th.id}
                    type="button"
                    onClick={() => petPatchM.mutate({ pet_theme_id: th.id })}
                    disabled={petPatchM.isPending}
                    className={`inline-flex items-center gap-1.5 ${segCls(petThemeId === th.id)}`}
                  >
                    <img src={th.images.idle} alt="" className="h-4 w-4 object-contain" />
                    {i18n.t(`pet.settings.themes.${th.id}` as never)}
                  </button>
                ))}
              </div>
            </div>
            {/* 大小 */}
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-foreground">
                {i18n.t("pet.settings.sizeLabel")}
              </div>
              <div className="flex gap-1.5">
                {(["small", "medium", "large"] as const).map((sz) => (
                  <button
                    key={sz}
                    type="button"
                    onClick={() => petPatchM.mutate({ pet_size: sz })}
                    disabled={petPatchM.isPending}
                    className={segCls(petSize === sz)}
                  >
                    {i18n.t(`pet.settings.sizes.${sz}`)}
                  </button>
                ))}
              </div>
            </div>
            {/* 透明度 */}
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-foreground">
                {i18n.t("pet.settings.opacityLabel")}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={20}
                  max={100}
                  step={5}
                  value={Math.round(petOpacityValue * 100)}
                  onChange={(e) => setPetOpacityDraft(Number(e.target.value) / 100)}
                  onMouseUp={() => {
                    if (petOpacityDraft != null) petPatchM.mutate({ pet_opacity: petOpacityDraft });
                  }}
                  onTouchEnd={() => {
                    if (petOpacityDraft != null) petPatchM.mutate({ pet_opacity: petOpacityDraft });
                  }}
                  className="w-32 accent-primary"
                  aria-label={i18n.t("pet.settings.opacityLabel")}
                />
                <span className="w-9 text-right text-xs tabular-nums text-slate-500">
                  {Math.round(petOpacityValue * 100)}%
                </span>
              </div>
            </div>
            {/* 醒目提醒间隔 */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground">
                  {i18n.t("pet.settings.alertLabel")}
                </div>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {i18n.t("pet.settings.alertHint")}
                </p>
              </div>
              <div className="flex gap-1.5">
                {[0, 30, 60, 120].map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => petPatchM.mutate({ pet_alert_interval_sec: sec })}
                    disabled={petPatchM.isPending}
                    className={segCls(petAlertSec === sec)}
                  >
                    {sec === 0 ? i18n.t("pet.settings.alertOff") : `${sec}s`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 扫描根目录 — data */}
      <section className={`${tabClass("data")}rounded-lg border border-border bg-card p-4`}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">扫描根目录(共享自 Repo 页)</h2>
          <button onClick={() => navigate("repo")} className="text-xs text-primary hover:underline">
            前往管理 →
          </button>
        </div>
        <ul className="mt-2 space-y-0.5 text-xs">
          {(settingsQ.data?.scan_roots ?? []).length === 0 && (
            <li className="text-slate-500">尚未设置任何扫描根目录</li>
          )}
          {(settingsQ.data?.scan_roots ?? []).map((r) => (
            <li key={r} className="truncate font-mono text-slate-600 dark:text-slate-400">
              {r}
            </li>
          ))}
        </ul>
      </section>

      {/* git-ai 账号 / 登录态 — data */}
      <div className={tabClass("data") || undefined}>
        <GitAiAccountCard />
      </div>

      {/* 当前生效的 ignore patterns — data */}
      <div className={tabClass("data") || undefined}>
        <EffectiveIgnoreCard />
      </div>

      {/* 通知大块(低 AI / daemon)— monitor */}
      <section className={`${tabClass("monitor")}rounded-lg border border-border bg-card p-4`}>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Bell className="h-4 w-4 text-slate-500" /> 通知
        </h2>
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t("lowAiShare.settingsTitle")}</div>
              <p className="mt-0.5 text-xs text-slate-500">{t("lowAiShare.settingsHint")}</p>
            </div>
            <Switch
              checked={lowAiEnabled}
              onCheckedChange={(v) => lowAiEnableM.mutate(v)}
              disabled={lowAiEnableM.isPending}
              aria-label="开启低 AI 占比提醒"
            />
          </div>
          {lowAiEnabled && (
            <div className="space-y-2 pl-1">
              <div className="flex items-center justify-between gap-3">
                <label className="text-xs text-slate-500">{t("lowAiShare.thresholdLabel")}</label>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {LOW_AI_SHARE_THRESHOLD_OPTIONS.map((n) => {
                    const active = !showCustomThreshold && lowAiThreshold === n;
                    return (
                      <button
                        key={n}
                        onClick={() => {
                          setCustomThresholdOpen(false);
                          lowAiThresholdM.mutate(n);
                        }}
                        disabled={lowAiThresholdM.isPending}
                        className={
                          active
                            ? "rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary dark:bg-primary/10 dark:text-primary"
                            : "rounded-md border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800"
                        }
                      >
                        {n}%
                      </button>
                    );
                  })}
                  <button
                    onClick={() => {
                      setCustomThresholdDraft(String(lowAiThreshold));
                      setCustomThresholdOpen(true);
                    }}
                    disabled={lowAiThresholdM.isPending}
                    className={
                      showCustomThreshold
                        ? "rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary dark:bg-primary/10 dark:text-primary"
                        : "rounded-md border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800"
                    }
                  >
                    自定义
                  </button>
                </div>
              </div>
              {showCustomThreshold && (
                <div className="flex items-center justify-end gap-2">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={customThresholdDraft}
                    onChange={(e) => setCustomThresholdDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitCustomThreshold();
                    }}
                    placeholder={String(lowAiThreshold)}
                    className="w-20 rounded-md border border-slate-200 px-2 py-1 text-xs dark:border-border dark:bg-card"
                  />
                  <span className="text-xs text-slate-500">%</span>
                  <button
                    onClick={commitCustomThreshold}
                    disabled={lowAiThresholdM.isPending}
                    className="rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary dark:bg-primary/10 dark:text-primary"
                  >
                    保存
                  </button>
                </div>
              )}
              <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-foreground">实时监听文件变化</div>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    关闭后每 15 分钟检查一次,开启时 commit 完成后 1-3 秒内推送(后端 fsnotify 监听
                    refs/notes/ai)。既有冷却(切仓 5min / 提醒间隔 6h)在两种模式下都生效。
                  </p>
                </div>
                <Switch
                  checked={lowAiRealtime}
                  onCheckedChange={(v) => lowAiRealtimeM.mutate(v)}
                  disabled={lowAiRealtimeM.isPending}
                  aria-label="开启实时监听文件变化"
                />
              </div>
              <div className="grid gap-2 rounded-md border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <label className="text-xs font-medium text-foreground">
                      {t("lowAiShare.targetEmailsLabel")}
                    </label>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {t("lowAiShare.targetEmailsHelp")}
                    </p>
                    {targetEmailsDraft.trim().length === 0 && (
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        当前自动邮箱:
                        <span className="ml-1 font-mono">
                          {gitEmailQ.data ?? "未读取到,将按仓库整体统计"}
                        </span>
                      </p>
                    )}
                  </div>
                  <button
                    onClick={saveTargetEmails}
                    disabled={lowAiTargetEmailsM.isPending}
                    className="rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary dark:bg-primary/10 dark:text-primary"
                  >
                    保存
                  </button>
                </div>
                <textarea
                  value={targetEmailsDraft}
                  onChange={(e) => setTargetEmailsDraft(e.target.value)}
                  placeholder={t("lowAiShare.targetEmailsPlaceholder")}
                  rows={3}
                  className="min-h-20 resize-y rounded-md border border-slate-200 px-2 py-1.5 font-mono text-xs dark:border-border dark:bg-card"
                />
              </div>
              <div className="grid gap-3 rounded-md border border-border p-3 md:grid-cols-2">
                <NumberSetting
                  label={t("lowAiShare.remindIntervalLabel")}
                  value={lowAiRemindInterval}
                  min={LOW_AI_SHARE_MIN_REMIND_INTERVAL_MINUTES}
                  max={LOW_AI_SHARE_MAX_REMIND_INTERVAL_MINUTES}
                  onSave={saveRemindInterval}
                  disabled={lowAiRemindIntervalM.isPending}
                  presets={[
                    ["15 分钟", 15],
                    ["1 小时", 60],
                    ["6 小时", 360],
                    ["24 小时", 1440],
                  ]}
                />
                <NumberSetting
                  label={t("lowAiShare.dismissMinutesLabel")}
                  value={lowAiDismissMinutes}
                  min={LOW_AI_SHARE_MIN_DISMISS_MINUTES}
                  max={LOW_AI_SHARE_MAX_DISMISS_MINUTES}
                  onSave={saveDismissMinutes}
                  disabled={lowAiDismissMinutesM.isPending}
                  presets={[
                    ["1 小时", 60],
                    ["6 小时", 360],
                    ["24 小时", 1440],
                    ["7 天", 10080],
                  ]}
                />
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-border dark:bg-slate-900/30 dark:text-slate-300">
                <div className="mb-1.5 font-medium text-foreground">
                  {t("lowAiShare.rulesTitle")}
                </div>
                <ul className="list-disc space-y-1 pl-4">
                  {(t("lowAiShare.rules", { returnObjects: true }) as string[]).map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  onClick={resetLowAiSilence}
                  className="rounded-md border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800"
                >
                  重新开启提醒
                </button>
                <button
                  onClick={handleTestLowAiToast}
                  className="rounded-md border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800"
                >
                  测试一下
                </button>
              </div>
            </div>
          )}
          <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">git-ai daemon 异常告警</div>
              <p className="mt-0.5 text-xs text-slate-500">
                后台连续 2 次探测到 daemon lock 异常时,通过 OS 通知中心提醒(macOS 通知中心 / Linux
                libnotify / Windows toast)。
              </p>
              <p className="mt-1 text-[11px] text-slate-400">
                关闭后停止 30s 轮询,不再消耗 tasklist 子进程。
              </p>
            </div>
            <Switch
              checked={daemonAlert}
              onCheckedChange={(v) => daemonAlertM.mutate(v)}
              disabled={daemonAlertM.isPending}
              aria-label="开启 git-ai daemon 异常告警"
            />
          </div>
          {daemonAlert && (
            <div className="flex items-center justify-end rounded-md border border-border p-3">
              <button
                type="button"
                onClick={resetDaemonSilence}
                className="rounded-md border border-slate-200 px-2.5 py-1 text-[11px] hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800"
              >
                重置 daemon 已 X 静默
              </button>
            </div>
          )}
        </div>
      </section>

      {/* git-ai 自动更新(readonly + 跳转)— data */}
      <section className={`${tabClass("data")}rounded-lg border border-border bg-card p-4`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">git-ai 自动更新</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              当前: {autoUpdateEnabled ? "启用(默认)" : "已禁用(disable_auto_updates=true)"}
            </p>
          </div>
          <button
            onClick={() => navigate("install")}
            className="text-xs text-primary hover:underline"
          >
            前往修改 →
          </button>
        </div>
      </section>

      {/* 导入 / 导出 — data */}
      <section className={`${tabClass("data")}rounded-lg border border-border bg-card p-4`}>
        <h2 className="mb-2 text-sm font-medium">配置导入 / 导出</h2>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleExport}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800"
          >
            <Download className="h-3.5 w-3.5" /> 复制配置 JSON
          </button>
          <button
            onClick={handleImport}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800"
          >
            <Upload className="h-3.5 w-3.5" /> 从 JSON 导入
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-slate-400">
          导入会覆盖 ~/.git-ai-studio/config.json 全部字段,请谨慎。
        </p>
      </section>

      {/* 首次引导 — general */}
      <section className={`${tabClass("general")}rounded-lg border border-border bg-card p-4`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">首次引导</h2>
            <p className="mt-1 text-xs text-slate-500">
              重新打开 5 步上手向导:介绍 Studio 能力、检查 git-ai 安装、选仓库、检查 hook、收尾。
              卸载客户端不会清
              `~/.git-ai-studio/config.json`,所以重装后默认不会再弹引导;需要时点这里。
            </p>
          </div>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event(REPO_SETUP_GUIDE_OPEN_EVENT))}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800"
          >
            重新查看引导
          </button>
        </div>
      </section>

      {/* 关于 — general(放最末) */}
      <section
        className={`${tabClass("general")}rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-500 dark:border-border dark:bg-card`}
      >
        <div className="font-medium text-foreground/80">关于</div>
        <div className="mt-1">git-ai-studio{appVersion ? ` v${appVersion}` : ""}</div>
        <div>
          源代码:
          <a
            href="https://github.com/bbujueyunjian-boop/git-ai-studio"
            target="_blank"
            rel="noreferrer noopener"
            className="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline"
          >
            bbujueyunjian-boop/git-ai-studio <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={handleCheckOrInstall}
            disabled={isDownloading}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-foreground hover:bg-slate-50 disabled:opacity-60 dark:border-border dark:hover:bg-slate-800"
          >
            {isDownloading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {downloadProgress.total > 0
                  ? i18n.t("update.downloadingPercent", { percent: downloadPercent })
                  : i18n.t("update.downloading")}
              </>
            ) : hasUpdate && updateInfo ? (
              <>
                <Download className="h-3.5 w-3.5" />
                {i18n.t("update.downloadAndInstall", {
                  version: updateInfo.availableVersion,
                })}
              </>
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5" />
                {i18n.t("update.checkForUpdates")}
              </>
            )}
          </button>
        </div>
        <div className="mt-1 text-[11px] text-slate-400">所有数据均在本机解析,不会上传。</div>
      </section>
    </div>
  );
}

// ============ P11-D git-ai 账号卡 ============

function GitAiAccountCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  /** 将登录态枚举映射为显示文本 + 色调。t 从外层组件传入,确保语言切换后重渲染。 */
  function stateLabel(s: AuthState): { text: string; tone: "ok" | "warn" | "err" | "muted" } {
    switch (s.kind) {
      case "logged_in":
        return { text: t("gitAiAccount.stateLoggedIn"), tone: "ok" };
      case "logged_out":
        return { text: t("gitAiAccount.stateLoggedOut"), tone: "muted" };
      case "refresh_expired":
        return { text: t("gitAiAccount.stateRefreshExpired"), tone: "warn" };
      case "error":
        return { text: `${t("gitAiAccount.stateError")}: ${s.message}`, tone: "err" };
    }
  }
  const whoamiQ = useQuery<WhoamiResult>({
    queryKey: ["whoami"],
    queryFn: getWhoami,
    staleTime: 60_000,
  });
  const logoutM = useMutation({
    mutationFn: () => logoutGitAi(),
    onSuccess: () => {
      setConfirmOpen(false);
      toast.success(t("gitAiAccount.logoutOkToast"));
      qc.invalidateQueries({ queryKey: ["whoami"] });
      qc.invalidateQueries({ queryKey: ["diagnose_environment"] });
    },
    onError: (e) =>
      toast.error(t("gitAiAccount.logoutFailed"), { description: (e as Error).message }),
  });

  const data = whoamiQ.data;
  const payload = data?.status === "ok" ? data.payload : null;
  const label = payload ? stateLabel(payload.state) : null;
  const loggedIn = payload?.state.kind === "logged_in";

  const toneClass = (tone: "ok" | "warn" | "err" | "muted") =>
    tone === "ok"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "err"
          ? "text-rose-600 dark:text-rose-400"
          : "text-slate-500";

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <UserCircle2 className="h-4 w-4 text-slate-500" /> {t("gitAiAccount.title")}
        </h2>
        <button
          type="button"
          onClick={() => whoamiQ.refetch()}
          disabled={whoamiQ.isFetching}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:hover:bg-slate-800"
        >
          <RefreshCw className={`h-3 w-3 ${whoamiQ.isFetching ? "animate-spin" : ""}`} />
          {whoamiQ.isFetching ? t("gitAiAccount.refreshing") : t("gitAiAccount.refresh")}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">{t("gitAiAccount.hint")}</p>

      {data?.status === "degraded" && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          {t("gitAiAccount.degradedGitAiMissing")}
        </p>
      )}

      {whoamiQ.isError && (
        <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
          {(whoamiQ.error as Error).message}
        </p>
      )}

      {payload && label && (
        <div className="mt-3 grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">
          <Field label="状态" value={<span className={toneClass(label.tone)}>{label.text}</span>} />
          <Field label="API" value={<span className="font-mono">{payload.api_base_url}</span>} />
          {payload.email && <Field label="Email" value={payload.email} />}
          {payload.name && <Field label="Name" value={payload.name} />}
          {payload.user_id && (
            <Field label="User ID" value={<span className="font-mono">{payload.user_id}</span>} />
          )}
          {payload.api_key_masked && (
            <Field
              label="API key"
              value={<span className="font-mono">{payload.api_key_masked}</span>}
            />
          )}
          {payload.access_token_expires_at && (
            <Field label="Token 到期" value={payload.access_token_expires_at} />
          )}
          {payload.orgs.length > 0 && (
            <div className="sm:col-span-2">
              <div className="mb-1 text-[11px] text-slate-500">组织</div>
              <ul className="space-y-0.5 text-[11px]">
                {payload.orgs.map((o, i) => (
                  <li
                    key={`${o.org_id ?? "x"}-${i}`}
                    className="font-mono text-slate-600 dark:text-slate-400"
                  >
                    {o.org_slug ?? "—"} ({o.org_name ?? "—"}) · role={o.role ?? "—"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        {loggedIn ? (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={logoutM.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-rose-200 px-2.5 py-1 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/40"
          >
            {logoutM.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            <LogOut className="h-3 w-3" />
            {t("gitAiAccount.logoutButton")}
          </button>
        ) : payload && payload.state.kind !== "logged_in" ? (
          <p className="text-[11px] text-slate-500">{t("gitAiAccount.cliLoginHint")}</p>
        ) : null}
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={(v) => !logoutM.isPending && setConfirmOpen(v)}
        title={t("gitAiAccount.logoutConfirmTitle")}
        description={t("gitAiAccount.logoutConfirmDescription")}
        dismissible={!logoutM.isPending}
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              disabled={logoutM.isPending}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:hover:bg-slate-800"
            >
              {t("gitAiAccount.logoutCancel")}
            </button>
            <button
              type="button"
              onClick={() => logoutM.mutate()}
              disabled={logoutM.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
            >
              {logoutM.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("gitAiAccount.logoutConfirmCta")}
            </button>
          </>
        }
      >
        {/* 内容已经在 description 里;Dialog 主体留空以减少视觉噪声 */}
      </Dialog>
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className="truncate text-right">{value}</span>
    </div>
  );
}

function NumberSetting({
  label,
  value,
  min,
  max,
  presets,
  disabled,
  onSave,
  unit = "分钟",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  presets: Array<[string, number]>;
  disabled: boolean;
  onSave: (value: number) => void;
  /** 单位文案,默认"分钟"。新接入的 hook-server 配置传 "毫秒" / "次"。 */
  unit?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n) || n < min || n > max) {
      toast.error(`${label}需为 ${min}–${max} ${unit}`);
      return;
    }
    onSave(n);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium text-foreground">{label}</label>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={min}
            max={max}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
            className="w-20 rounded-md border border-slate-200 px-2 py-1 text-xs dark:border-border dark:bg-card"
          />
          <span className="text-xs text-slate-500">{unit}</span>
          <button
            onClick={commit}
            disabled={disabled}
            className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:hover:bg-slate-800"
          >
            保存
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map(([text, minutes]) => (
          <button
            key={`${label}-${minutes}`}
            onClick={() => onSave(minutes)}
            disabled={disabled}
            className={
              value === minutes
                ? "rounded-md border border-primary bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary dark:bg-primary/10 dark:text-primary"
                : "rounded-md border border-slate-200 px-2 py-0.5 text-[11px] hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:hover:bg-slate-800"
            }
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

// ============ P11-C 当前生效 ignore patterns ============

function EffectiveIgnoreCard() {
  const { t } = useTranslation();
  const q = useQuery<EffectiveIgnorePatternsResult>({
    queryKey: ["effective_ignore_patterns"],
    queryFn: listEffectiveIgnorePatterns,
    // 不主动跑:用户点"重新读取"按钮时才查;避免每次进 Settings 页都拉一次子进程
    enabled: false,
  });

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Filter className="h-4 w-4 text-slate-500" /> {t("effectiveIgnore.title")}
        </h2>
        <button
          type="button"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:hover:bg-slate-800"
        >
          <RefreshCw className={`h-3 w-3 ${q.isFetching ? "animate-spin" : ""}`} />
          {q.isFetching ? t("effectiveIgnore.refreshing") : t("effectiveIgnore.refresh")}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">{t("effectiveIgnore.hint")}</p>

      {q.data?.status === "degraded" && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          {q.data.reason.kind === "repo_missing"
            ? t("effectiveIgnore.degradedRepoMissing")
            : t("effectiveIgnore.degradedGitAiMissing")}
        </p>
      )}

      {q.isError && (
        <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
          {(q.error as Error).message}
        </p>
      )}

      {q.data?.status === "ok" && (
        <div className="mt-2">
          <div className="text-[11px] text-slate-500">
            仓库:<span className="font-mono">{q.data.payload.repo_path}</span> · 共{" "}
            {q.data.payload.patterns.length} 条
          </div>
          {q.data.payload.patterns.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">{t("effectiveIgnore.listEmpty")}</p>
          ) : (
            <ul className="mt-2 max-h-64 overflow-y-auto rounded-sm border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[11px] dark:border-border dark:bg-background">
              {q.data.payload.patterns.map((p, i) => (
                <li key={`${p}-${i}`} className="truncate">
                  {p}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
