// Setup 环境配置状态的统一派生 hook(IA 重构)。
//
// # 谁要用
// - Rail 底部 Setup 入口的状态点
// - TopBar 右侧 Setup 状态点
// - Dashboard 首访 onboarding 引导卡
//
// 三处共用同一份判定,避免各自重复探测导致结论不一致。

import { useQuery } from "@tanstack/react-query";

import { diagnoseEnvironment, getAggregateRepos, resolveGitAiPath } from "./api";
import type { StatusLevel } from "./types";

/** Setup 三件套各自的就绪态,供 onboarding 清单逐项打勾。 */
export interface SetupChecklist {
  /** git-ai CLI 是否已解析到。 */
  gitAiInstalled: boolean;
  /**
   * 是否至少有一个**有效**仓库被加入 Dashboard 聚合集(`aggregate_repos`)。
   * 刻意不看 `current_repo`(单仓下钻焦点):onboarding 卡挂在 Dashboard 上,"就绪"应当意味着
   * **Dashboard 真的有数据可看**——而 Dashboard 看的是聚合集,不是当前下钻仓。否则会出现
   * "走完引导 Dashboard 仍空"的脱节(当前仓有数据但没加入聚合)。
   */
  repoAdded: boolean;
  /** 是否至少有一个 AI agent 配好了 hook(detected && configured)。 */
  hasConfiguredHook: boolean;
}

export interface SetupStatus {
  /** 三件套逐项就绪态。 */
  checklist: SetupChecklist;
  /** 是否仍有未就绪项(= 任意一项为 false)。 */
  incomplete: boolean;
  /** 探测尚未完成(任一底层 query 仍在首登)。状态点此时按 muted 处理,避免误报。 */
  loading: boolean;
  /**
   * 状态点等级:
   * - 全部就绪 → ok(绿)
   * - 部分就绪 / 探测中 → warn(琥珀,提示"有待处理")
   * - 完全空白(git-ai 未装 且 无仓库)→ muted(灰,提示"尚未开始")
   */
  level: StatusLevel;
}

/**
 * 探测 Setup 三件套就绪态。
 *
 * # graceful 降级
 * 浏览器(无 Tauri 后端)下 invoke 会失败:`resolve_git_ai_path` 抛错时按"未装"处理,
 * `diagnose_environment` / `current_repo` 同理。不抛出、不白屏,各 query `retry: false`
 * 避免无谓重试刷屏。这让 onboarding 判定在缺后端时也能给出合理 fallback(显示"需配置")。
 */
export function useSetupStatus(): SetupStatus {
  const gitAiQ = useQuery({
    queryKey: ["resolve_git_ai_path"],
    queryFn: resolveGitAiPath,
    staleTime: 60_000,
    retry: false,
  });
  const aggregateQ = useQuery({
    queryKey: ["aggregate_repos"],
    queryFn: getAggregateRepos,
    staleTime: 5_000,
    retry: false,
  });
  const diagQ = useQuery({
    queryKey: ["diagnose_environment"],
    queryFn: () => diagnoseEnvironment(false),
    staleTime: 30_000,
    retry: false,
  });

  const gitAiInstalled = gitAiQ.data?.[0] === true;
  const repoAdded = (aggregateQ.data ?? []).some((e) => e.valid);
  const hasConfiguredHook = diagQ.data?.agents?.some((a) => a.detected && a.configured) ?? false;

  const checklist: SetupChecklist = { gitAiInstalled, repoAdded, hasConfiguredHook };
  const incomplete = !gitAiInstalled || !repoAdded || !hasConfiguredHook;
  const loading = gitAiQ.isLoading || aggregateQ.isLoading || diagQ.isLoading;

  let level: StatusLevel;
  if (loading) {
    level = "muted";
  } else if (!incomplete) {
    level = "ok";
  } else if (!gitAiInstalled && !repoAdded) {
    level = "muted";
  } else {
    level = "warn";
  }

  return { checklist, incomplete, loading, level };
}
