/**
 * 新用户引导 wizard(5 步)。
 *
 * # 设计
 * 单 Dialog 内分 5 步逐次展示:welcome / 检查 git-ai / 配置仓库 / 检查 hook / 完成。
 * 每步内置"上一步 / 跳过 / 下一步",末步标 `repo_setup_seen=true` 后关闭。
 *
 * # 触发渠道
 * 1. 首次启动:三条件齐(!repo_setup_seen && !last_repo && scan_roots empty)→ 自动 open
 * 2. 手动:Settings 通用 Tab 「重新查看引导」按钮 dispatch `REPO_SETUP_GUIDE_OPEN_EVENT`
 *
 * # 与 Diagnostic / Hooks 页的关系
 * step 2 / 4 的检查是"轻量提示",不替代 Diagnostic / Hooks 页;按钮可直接 navigate 过去。
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  FolderGit2,
  FolderOpen,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Dialog } from "./ui/DialogShell";
import {
  discoverRepos,
  getAggregateRepos,
  getGitAiConfig,
  getHooksStatus,
  selectRepo,
  setAggregateRepos,
  setAppSettings,
  setScanRoots,
} from "../lib/api";
import { pickDirectory } from "../lib/pickDirectory";
import { useRouter } from "../router";
import type { AppSettings, RepoEntry } from "../lib/types";

interface Props {
  settings: AppSettings | undefined;
  onRepoChanged: () => void;
}

/** 让 Settings「重新查看引导」按钮触发 wizard 重新打开;App 顶层挂载 wizard,监听该事件。 */
export const REPO_SETUP_GUIDE_OPEN_EVENT = "git-ai-studio:repo-setup-guide-open";

type WizardStep = 0 | 1 | 2 | 3 | 4;

const STEP_TITLE_KEYS = [
  "repoSetupGuide.steps.welcome.title",
  "repoSetupGuide.steps.gitAi.title",
  "repoSetupGuide.steps.repo.title",
  "repoSetupGuide.steps.hook.title",
  "repoSetupGuide.steps.done.title",
] as const;

const STEP_HINT_KEYS = [
  "repoSetupGuide.steps.welcome.hint",
  "repoSetupGuide.steps.gitAi.hint",
  "repoSetupGuide.steps.repo.hint",
  "repoSetupGuide.steps.hook.hint",
  "repoSetupGuide.steps.done.hint",
] as const;

export function RepoSetupGuide({ settings, onRepoChanged }: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { navigate } = useRouter();
  const [explicitOpen, setExplicitOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>(0);
  // 默认空 — UX 上推用户点「选择目录」按钮走原生 OS picker;input 保留为 fallback
  // (Tauri dialog 在某些环境下偶发卡顿时,用户仍能手动粘路径)。
  const [root, setRoot] = useState("");

  // 首次启动检测三件齐(原 RepoSetupGuide 语义保留):未引导过 + 未选仓库 + 未配扫描根
  const initialShouldOpen =
    !!settings &&
    !settings.repo_setup_seen &&
    !settings.last_repo &&
    settings.scan_roots.length === 0;
  const open = initialShouldOpen || explicitOpen;

  // Settings「重新查看引导」按钮触发的事件
  useEffect(() => {
    const onOpen = () => {
      setStep(0);
      setExplicitOpen(true);
    };
    window.addEventListener(REPO_SETUP_GUIDE_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(REPO_SETUP_GUIDE_OPEN_EVENT, onOpen);
  }, []);

  // step 2(git-ai):open + step===1 才查;失败不抛 toast,unset 视为未装。
  const gitAiQ = useQuery({
    queryKey: ["onboarding_git_ai_config"],
    queryFn: getGitAiConfig,
    enabled: open && step === 1,
    retry: false,
  });
  // step 4(hook):open + step===3 才查
  const hooksQ = useQuery({
    queryKey: ["onboarding_hooks_status"],
    queryFn: getHooksStatus,
    enabled: open && step === 3,
    retry: false,
  });

  // step 3 仓库扫描(沿用原 RepoSetupGuide 的扫描逻辑)
  const reposQ = useQuery({
    queryKey: ["onboarding_repos", root],
    queryFn: () => discoverRepos([root.trim()], 4),
    enabled: false,
  });
  const repos = useMemo(() => reposQ.data ?? [], [reposQ.data]);

  const markSeen = async () => {
    await setAppSettings({ repo_setup_seen: true });
    await qc.invalidateQueries({ queryKey: ["app_settings"] });
  };

  const scanM = useMutation({
    mutationFn: async () => {
      const trimmed = root.trim();
      if (!trimmed) throw new Error(t("repoSetupGuide.toast.rootRequired"));
      await setScanRoots([trimmed]);
      await qc.invalidateQueries({ queryKey: ["scan_roots"] });
      await qc.invalidateQueries({ queryKey: ["repos"] });
      return reposQ.refetch();
    },
    onError: (e) =>
      toast.error(t("repoSetupGuide.toast.scanFailed"), { description: (e as Error).message }),
  });

  // 批量加入聚合集(并集去重,复用 Repo 页 aggregateAll 语义)+ 把第一个设为当前仓
  // (否则 Stats/Blame 仍空),然后进 hook 检查。引导默认走批量;单仓精细管理在 Repo 页。
  const addReposM = useMutation({
    mutationFn: async (toAdd: RepoEntry[]) => {
      if (toAdd.length === 0) throw new Error(t("repoSetupGuide.toast.rootRequired"));
      const existing = await getAggregateRepos();
      const union = new Set([...existing.map((e) => e.path), ...toAdd.map((r) => r.path)]);
      await setAggregateRepos([...union]);
      await selectRepo(toAdd[0].path);
      return { count: toAdd.length, name: toAdd[0].name };
    },
    onSuccess: ({ count, name }) => {
      toast.success(t("repoSetupGuide.toast.reposAdded", { n: count, name }));
      void qc.invalidateQueries({ queryKey: ["aggregate_repos"] });
      onRepoChanged();
      setStep(3); // 进 hook 检查
    },
    onError: (e) =>
      toast.error(t("repoSetupGuide.toast.addFailed"), { description: (e as Error).message }),
  });
  // 单仓「加入」按钮的精确 spinner 归属:仅当本次 mutate 的是单个仓时取其 path。
  const addingSinglePath =
    addReposM.isPending && addReposM.variables?.length === 1
      ? addReposM.variables?.[0]?.path
      : undefined;

  const skipM = useMutation({
    mutationFn: markSeen,
    onSuccess: () => toast.message(t("repoSetupGuide.toast.skipped")),
    onError: (e) =>
      toast.error(t("repoSetupGuide.toast.saveStateFailed"), { description: (e as Error).message }),
  });

  const closeWizard = () => {
    setExplicitOpen(false);
    setStep(0);
  };

  const finish = () => {
    void markSeen().then(closeWizard);
  };

  const goNext = () => {
    if (step >= 4) return;
    setStep((s) => (s + 1) as WizardStep);
  };
  const goBack = () => {
    if (step <= 0) return;
    setStep((s) => (s - 1) as WizardStep);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !skipM.isPending) {
          // 关闭(点 X 或 Esc)= 跳过引导
          skipM.mutate();
          closeWizard();
        }
      }}
      title={t(STEP_TITLE_KEYS[step])}
      description={t(STEP_HINT_KEYS[step])}
      size="lg"
      footer={
        <WizardFooter
          step={step}
          onBack={goBack}
          onNext={goNext}
          onSkip={() => {
            skipM.mutate();
            closeWizard();
          }}
          onFinish={finish}
          nextDisabled={step === 2 /* repo step 没选仓就不能 Next,改用 select 按钮自动跳 */}
        />
      }
    >
      <div className="space-y-3">
        <StepIndicator current={step} />

        {step === 0 && <WelcomeStep />}
        {step === 1 && (
          <CheckGitAiStep
            loading={gitAiQ.isLoading}
            installed={!!gitAiQ.data && !gitAiQ.isError}
            onNavigateInstall={() => navigate("install")}
            onRecheck={() => void gitAiQ.refetch()}
          />
        )}
        {step === 2 && (
          <RepoStep
            root={root}
            onRootChange={setRoot}
            repos={repos}
            scanning={scanM.isPending || reposQ.isFetching}
            scanned={reposQ.isFetched}
            busy={addReposM.isPending}
            addingPath={addingSinglePath}
            onScan={() => scanM.mutate()}
            onAdd={(toAdd) => addReposM.mutate(toAdd)}
          />
        )}
        {step === 3 && (
          <CheckHookStep
            loading={hooksQ.isLoading}
            mode={hooksQ.data?.mode}
            onNavigateHooks={() => navigate("hooks")}
            onRecheck={() => void hooksQ.refetch()}
          />
        )}
        {step === 4 && (
          <DoneStep
            settings={settings}
            onGoDashboard={() => {
              navigate("dashboard");
              finish();
            }}
            onGoSettings={() => {
              navigate("settings");
              finish();
            }}
          />
        )}
      </div>
    </Dialog>
  );
}

// ============ Step Indicator ============

function StepIndicator({ current }: { current: WizardStep }) {
  return (
    <ol className="flex items-center justify-between gap-1">
      {STEP_TITLE_KEYS.map((_, i) => {
        const active = i === current;
        const done = i < current;
        return (
          <li key={i} className="flex flex-1 items-center gap-1">
            <span
              className={
                done
                  ? "flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-medium text-white"
                  : active
                    ? "flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground"
                    : "flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 text-[10px] text-slate-500 dark:border-border"
              }
            >
              {done ? <CheckCircle2 className="h-3 w-3" /> : i + 1}
            </span>
            {i < STEP_TITLE_KEYS.length - 1 && (
              <span
                className={
                  done ? "h-px flex-1 bg-emerald-500" : "h-px flex-1 bg-slate-200 dark:bg-border"
                }
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ============ Footer ============

function WizardFooter({
  step,
  onBack,
  onNext,
  onSkip,
  onFinish,
  nextDisabled,
}: {
  step: WizardStep;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  onFinish: () => void;
  nextDisabled: boolean;
}) {
  const { t } = useTranslation();
  if (step === 4) {
    return (
      <button
        type="button"
        onClick={onFinish}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {t("repoSetupGuide.footer.finish")}
      </button>
    );
  }
  return (
    <>
      {step > 0 ? (
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800"
        >
          {t("repoSetupGuide.footer.back")}
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        onClick={onSkip}
        className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-slate-800"
      >
        {t("repoSetupGuide.footer.skip")}
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {t("repoSetupGuide.footer.next")}
      </button>
    </>
  );
}

// ============ Step 0: Welcome ============

function WelcomeStep() {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-md border border-primary bg-primary/10 p-4 text-sm dark:border-primary dark:bg-primary/10">
      <div className="flex items-center gap-2 font-medium text-primary">
        <Sparkles className="h-4 w-4" /> {t("repoSetupGuide.welcome.heading")}
      </div>
      <p className="text-primary/80 dark:text-primary/80">{t("repoSetupGuide.welcome.intro")}</p>
      <ul className="ml-4 list-disc space-y-1 text-primary/80 dark:text-primary/80">
        <li>
          <strong>Dashboard / Stats</strong>
          {t("repoSetupGuide.welcome.featureDashboard")}
        </li>
        <li>
          <strong>People</strong>
          {t("repoSetupGuide.welcome.featurePeople")}
        </li>
        <li>
          <strong>Blame</strong>
          {t("repoSetupGuide.welcome.featureBlame")}
        </li>
        <li>
          <strong>Hooks / Diagnostic</strong>
          {t("repoSetupGuide.welcome.featureHooks")}
        </li>
      </ul>
      <p className="text-[11px] text-primary/60 dark:text-primary/60">
        {t("repoSetupGuide.welcome.noUpload")}
      </p>
    </div>
  );
}

// ============ Step 1: Check git-ai ============

function CheckGitAiStep({
  loading,
  installed,
  onNavigateInstall,
  onRecheck,
}: {
  loading: boolean;
  installed: boolean;
  onNavigateInstall: () => void;
  onRecheck: () => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border p-4 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> {t("repoSetupGuide.gitAi.checking")}
      </div>
    );
  }
  if (installed) {
    return (
      <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/40">
        <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-200">
          <CheckCircle2 className="h-4 w-4" /> {t("repoSetupGuide.gitAi.detectedTitle")}
        </div>
        <p className="text-emerald-900/80 dark:text-emerald-100/80">
          {t("repoSetupGuide.gitAi.detectedBody")}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm dark:border-rose-900 dark:bg-rose-950/40">
      <div className="flex items-center gap-2 font-medium text-rose-700 dark:text-rose-200">
        <XCircle className="h-4 w-4" /> {t("repoSetupGuide.gitAi.missingTitle")}
      </div>
      <p className="text-rose-900/80 dark:text-rose-100/80">
        {t("repoSetupGuide.gitAi.missingBody")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onNavigateInstall}
          className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-rose-500"
        >
          <Wrench className="h-3.5 w-3.5" /> {t("repoSetupGuide.gitAi.goInstall")}
        </button>
        <button
          type="button"
          onClick={onRecheck}
          className="rounded-md border border-rose-200 px-2.5 py-1.5 text-xs hover:bg-white dark:border-rose-900 dark:hover:bg-rose-950"
        >
          {t("repoSetupGuide.recheck")}
        </button>
      </div>
    </div>
  );
}

// ============ Step 2: Repo(沿用原扫描 + 选仓 UI) ============

function RepoStep({
  root,
  onRootChange,
  repos,
  scanning,
  scanned,
  busy,
  addingPath,
  onScan,
  onAdd,
}: {
  root: string;
  onRootChange: (v: string) => void;
  repos: RepoEntry[];
  scanning: boolean;
  scanned: boolean;
  busy: boolean;
  addingPath: string | undefined;
  onScan: () => void;
  onAdd: (repos: RepoEntry[]) => void;
}) {
  const { t } = useTranslation();
  const handlePick = async () => {
    try {
      const picked = await pickDirectory(t("repoSetupGuide.repo.pickDialogTitle"));
      if (picked) onRootChange(picked);
    } catch (e) {
      toast.error(t("repoSetupGuide.toast.pickDirFailed"), { description: (e as Error).message });
    }
  };
  return (
    <div className="space-y-3">
      {/* 为什么要选仓库:讲清「加入聚合集 → Dashboard 跨仓 / 第一个设当前仓 → Stats·Blame 单仓」 */}
      <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs dark:border-primary/30 dark:bg-primary/10">
        <div className="font-medium text-primary">{t("repoSetupGuide.repo.purposeTitle")}</div>
        <p className="mt-1 text-primary/80 dark:text-primary/80">
          {t("repoSetupGuide.repo.purposeBody")}
        </p>
      </div>

      {/* 主行动:原生目录选择器 + 显示已选路径 + 扫描按钮 */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handlePick}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800"
        >
          <FolderOpen className="h-3.5 w-3.5" /> {t("repoSetupGuide.repo.pickDir")}
        </button>
        <div className="flex-1 truncate rounded-md border border-dashed border-slate-200 px-3 py-1.5 font-mono text-xs text-slate-600 dark:border-border dark:text-slate-300">
          {root.trim() ? (
            root
          ) : (
            <span className="text-slate-400">{t("repoSetupGuide.repo.noDirPicked")}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onScan}
          disabled={scanning || !root.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {scanning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          {t("repoSetupGuide.repo.scan")}
        </button>
      </div>
      {/* Fallback:手动粘路径(默认折叠,极端情况绕过 Tauri dialog 卡顿) */}
      <details className="text-[11px] text-slate-500">
        <summary className="cursor-pointer">{t("repoSetupGuide.repo.pasteAdvanced")}</summary>
        <input
          value={root}
          onChange={(e) => onRootChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onScan();
          }}
          placeholder={t("repoSetupGuide.repo.pathPlaceholder")}
          className="mt-1 w-full rounded-md border border-slate-200 px-3 py-1.5 font-mono text-xs dark:border-border dark:bg-card"
        />
      </details>
      {/* 扫描有结果:批量「全部加入 (N)」行 —— 全部并入聚合集 + 第一个设当前仓 */}
      {repos.length > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {t("repoSetupGuide.repo.foundCount", { n: repos.length })}
          </span>
          <button
            type="button"
            onClick={() => onAdd(repos)}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy && addingPath === undefined ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {t("repoSetupGuide.repo.addAll", { n: repos.length })}
          </button>
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded-md border border-border">
        {repos.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-slate-500">
            {scanned
              ? t("repoSetupGuide.repo.emptyAfterScan")
              : t("repoSetupGuide.repo.pickThenScan")}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {repos.map((repo) => (
              <li key={repo.path} className="flex items-center gap-3 px-3 py-2">
                <FolderGit2 className="h-4 w-4 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{repo.name}</div>
                  <div className="truncate font-mono text-[11px] text-slate-500">{repo.path}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onAdd([repo])}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/15 disabled:opacity-50 dark:bg-primary/10 dark:text-primary"
                >
                  {addingPath === repo.path && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t("repoSetupGuide.repo.addOne")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ============ Step 3: Check hook ============

function CheckHookStep({
  loading,
  mode,
  onNavigateHooks,
  onRecheck,
}: {
  loading: boolean;
  mode: string | undefined;
  onNavigateHooks: () => void;
  onRecheck: () => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border p-4 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> {t("repoSetupGuide.hook.checking")}
      </div>
    );
  }
  if (mode === "official") {
    return (
      <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/40">
        <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-200">
          <CheckCircle2 className="h-4 w-4" /> {t("repoSetupGuide.hook.configuredTitle", { mode })}
        </div>
        <p className="text-emerald-900/80 dark:text-emerald-100/80">
          {t("repoSetupGuide.hook.configuredBody")}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40">
      <div className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200">
        <XCircle className="h-4 w-4" />{" "}
        {t("repoSetupGuide.hook.unconfiguredTitle", {
          mode: mode ?? t("repoSetupGuide.hook.modeUnknown"),
        })}
      </div>
      <p className="text-amber-900/80 dark:text-amber-100/80">
        {t("repoSetupGuide.hook.unconfiguredBody")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onNavigateHooks}
          className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
        >
          <Wrench className="h-3.5 w-3.5" /> {t("repoSetupGuide.hook.goHooks")}
        </button>
        <button
          type="button"
          onClick={onRecheck}
          className="rounded-md border border-amber-200 px-2.5 py-1.5 text-xs hover:bg-white dark:border-amber-900 dark:hover:bg-amber-950"
        >
          {t("repoSetupGuide.recheck")}
        </button>
      </div>
    </div>
  );
}

// ============ Step 4: Done ============

function DoneStep({
  settings,
  onGoDashboard,
  onGoSettings,
}: {
  settings: AppSettings | undefined;
  onGoDashboard: () => void;
  onGoSettings: () => void;
}) {
  const { t } = useTranslation();
  const n = settings?.notifications;
  // 3 项进阶配置概览。默认全关,所以新用户一眼能看到自己还能开什么。
  // 实际配置统一在 Settings → 守护与通知,这里只做"知会 + 跳转"。
  const items: Array<{ label: string; enabled: boolean; hint: string }> = [
    {
      label: t("repoSetupGuide.done.items.ccSwitch.label"),
      enabled: n?.cc_switch_auto_repair ?? false,
      hint: t("repoSetupGuide.done.items.ccSwitch.hint"),
    },
    {
      label: t("repoSetupGuide.done.items.lowAiShare.label"),
      enabled: n?.low_ai_share?.enabled ?? false,
      hint: t("repoSetupGuide.done.items.lowAiShare.hint"),
    },
    {
      label: t("repoSetupGuide.done.items.daemonUnhealthy.label"),
      enabled: n?.daemon_unhealthy_alert ?? false,
      hint: t("repoSetupGuide.done.items.daemonUnhealthy.hint"),
    },
  ];
  return (
    <div className="space-y-3">
      {/* 顶部 — 完成确认 + 进入 Dashboard */}
      <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/40">
        <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-200">
          <CheckCircle2 className="h-4 w-4" /> {t("repoSetupGuide.done.completeTitle")}
        </div>
        <p className="text-emerald-900/80 dark:text-emerald-100/80">
          {t("repoSetupGuide.done.completeBody")}
        </p>
        <button
          type="button"
          onClick={onGoDashboard}
          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
        >
          {t("repoSetupGuide.done.goDashboard")}
        </button>
      </div>

      {/* 进阶:3 项监控告警(默认全关) */}
      <div className="space-y-2 rounded-md border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">{t("repoSetupGuide.done.advancedTitle")}</div>
          <button
            type="button"
            onClick={onGoSettings}
            className="rounded-md border border-slate-200 px-2.5 py-1 text-[11px] hover:bg-slate-50 dark:border-border dark:hover:bg-slate-800"
          >
            {t("repoSetupGuide.done.goSettings")}
          </button>
        </div>
        <p className="text-[11px] text-slate-500">{t("repoSetupGuide.done.advancedHint")}</p>
        <ul className="space-y-1.5">
          {items.map((it) => (
            <li
              key={it.label}
              className="flex items-start gap-2 rounded-sm border border-border/60 px-2.5 py-1.5"
            >
              <span
                className={
                  it.enabled
                    ? "mt-0.5 inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                    : "mt-0.5 inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full bg-slate-100 px-1.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                }
              >
                {it.enabled
                  ? t("repoSetupGuide.done.statusOn")
                  : t("repoSetupGuide.done.statusOff")}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{it.label}</div>
                <div className="text-[11px] text-slate-500">{it.hint}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-[11px] text-slate-400">{t("repoSetupGuide.done.footerHint")}</p>
    </div>
  );
}
