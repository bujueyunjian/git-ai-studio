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
 * 2. 当前路由在 blame / stats 时,把 URL params 清掉。否则旧路径(如 `#/blame/fileA/L1-2`)
 *    会被新仓库当成 deep-link 解析,落到 file_not_in_head degraded,用户以为文件存在但空。
 *    用户切到 Repo 页选完仓再点回 Blame —— Rail 的 navigate("blame") 会重新生成无 params 的
 *    hash,无问题;但用户**直接刷新 / 后退**到含 params 的 hash 时会复发。这里集中清掉。
 */
export function useRepoChanged(): () => void {
  const qc = useQueryClient();
  const { current, navigate } = useRouter();
  return useCallback(() => {
    invalidateRepoScopedQueries(qc);
    if (current === "blame" || current === "stats") {
      navigate(current);
    }
  }, [qc, current, navigate]);
}
