import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { buildHash, EMPTY_QUERY, parseHash, type QueryMap, type RouteId } from "./routerCore";

export type { QueryMap, RouteId } from "./routerCore";

interface RouterCtx {
  current: RouteId;
  /** 二级 segment(如 `#/stats/<sha>`),可选;现仅 Stats 页用来恢复 commit 选择。 */
  params: string | undefined;
  /** URL query string 解析结果(`?sha=abc&line=10` → Map)。
   *  默认为空 Map,Blame 页据此读 `?sha=<x>` 应用到 RefPicker。 */
  query: QueryMap;
  navigate: (r: RouteId, params?: string, query?: Record<string, string>) => void;
}

const Ctx = createContext<RouterCtx | null>(null);

export function RouterProvider({ children, initial }: { children: ReactNode; initial?: RouteId }) {
  const [parsed, setParsed] = useState(() =>
    initial
      ? { id: initial, params: undefined as string | undefined, query: EMPTY_QUERY }
      : parseHash(),
  );

  const navigate = useCallback((r: RouteId, params?: string, query?: Record<string, string>) => {
    // 计算下次内存 state 用的 query map(navigate 调用方传 plain object,内存里存 Map)
    let nextQuery: QueryMap = EMPTY_QUERY;
    if (query) {
      const m = new Map<string, string>();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") m.set(k, v);
      }
      if (m.size > 0) nextQuery = m;
    }
    setParsed({ id: r, params, query: nextQuery });
    const target = buildHash(r, params, query);
    if (window.location.hash !== target) window.location.hash = target;
  }, []);

  useEffect(() => {
    const onPop = () => setParsed(parseHash());
    window.addEventListener("hashchange", onPop);
    return () => window.removeEventListener("hashchange", onPop);
  }, []);

  // 首次写入 hash 以让用户能直接刷新到当前页
  useEffect(() => {
    if (!window.location.hash) window.location.hash = `#/${parsed.id}`;
  }, [parsed.id]);

  const value = useMemo<RouterCtx>(
    () => ({ current: parsed.id, params: parsed.params, query: parsed.query, navigate }),
    [parsed.id, parsed.params, parsed.query, navigate],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useRouter(): RouterCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRouter must be used within RouterProvider");
  return v;
}
