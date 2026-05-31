import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { invalidateRepoScopedQueries } from "./queryKeys";
import { useRouter } from "../router";

/**
 * 切仓库 / 切分支 / 启动恢复仓库后的统一副作用 hook。
 *
 * # 谁要调用
 * - App.tsx restoreLastRepo onSuccess
 * - App.tsx handleRepoChanged(给 TopBar 用,覆盖 BranchSwitcher + pickRecent 两个路径)
 * - Repo.tsx pickM.onSuccess
 *
 * # 副作用
 * 1. `invalidateRepoScopedQueries(qc)` —— 失效所有 HEAD 派生 query
 * 2. 当前路由在 stats 时,把 URL params/query 清掉。否则旧深链(如 `#/stats/<sha>?file=fileA&L=1-2`)
 *    会被新仓库当成 deep-link 解析,逐行弹窗落到 commit_not_found / file_not_in_head degraded。
 *    清成无参 `#/stats`,回到默认选中 HEAD。
 */
export function useRepoChanged(): () => void {
  const qc = useQueryClient();
  const { current, navigate } = useRouter();
  return useCallback(() => {
    invalidateRepoScopedQueries(qc);
    if (current === "stats") {
      navigate(current);
    }
  }, [qc, current, navigate]);
}
