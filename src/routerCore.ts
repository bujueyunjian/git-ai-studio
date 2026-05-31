// 路由的纯逻辑:URL hash ↔ 路由状态的编解码。与 RouterProvider 组件分离,
// 既便于单测(router_query.test),也满足 react-refresh「组件文件只导出组件」的约束。

export type RouteId =
  | "diagnostic"
  | "install"
  | "hooks"
  | "logs"
  | "dashboard"
  | "people"
  | "stats"
  | "notes"
  | "checkpoints"
  | "manual"
  | "repo"
  | "settings";

const ALL_ROUTES: RouteId[] = [
  "diagnostic",
  "install",
  "hooks",
  "logs",
  "dashboard",
  "people",
  "stats",
  "notes",
  "checkpoints",
  "manual",
  "repo",
  "settings",
];

/** 空 hash / 非法 route 的默认落地页。
 *  默认 `dashboard` —— 让新用户第一眼看到产品价值(AI 归因),而非一屏系统检查项。
 *  首访缺配置时由 Dashboard 顶部的 onboarding 卡引导到「环境诊断」。 */
const DEFAULT_ROUTE: RouteId = "dashboard";

/** URL query 段(`#/<route>/<params>?k=v&k2=v2`)解析后的只读 map。 */
export type QueryMap = ReadonlyMap<string, string>;

export const EMPTY_QUERY: QueryMap = new Map();

/**
 * 把 `#/<id>/<params>?<query>` 拆成 3 段。
 *
 * # 边界
 * - `?` 出现在 params 段内部仍按首个 `?` 切分(`encodeURIComponent` 已把合法路径里的 `?` 编为 `%3F`,
 *   所以裸 `?` 一定是 query 分隔符)
 * - query 段空字符串 / 无 `?` → 返回空 Map
 * - 同名 key 重复 → 后者覆盖前者(`URLSearchParams` 默认 `.get` 行为)
 */
export function parseHash(rawHash?: string): {
  id: RouteId;
  params: string | undefined;
  query: QueryMap;
} {
  // 显式 fallback 而非 default arg:default arg 在 Node 测试环境下 `window` 不存在会抛 ReferenceError,
  // typeof 探测后再读才能让纯 parse 测试在 jsdom-less 环境也跑得起来
  if (rawHash === undefined) {
    rawHash = typeof window !== "undefined" ? window.location.hash : "";
  }
  const raw = rawHash.replace(/^#\//, "");
  if (!raw) return { id: DEFAULT_ROUTE, params: undefined, query: EMPTY_QUERY };

  // 1) 先切 query 段
  const qIdx = raw.indexOf("?");
  const pathPart = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const queryPart = qIdx >= 0 ? raw.slice(qIdx + 1) : "";

  // 2) path 段沿用旧逻辑
  const [first, ...rest] = pathPart.split("/");
  if (!(ALL_ROUTES as string[]).includes(first)) {
    return { id: DEFAULT_ROUTE, params: undefined, query: EMPTY_QUERY };
  }
  const params = rest.length > 0 ? decodeURIComponent(rest.join("/")) : undefined;

  // 3) query 段解析(`URLSearchParams` 自动 decode % 转义)
  let query: QueryMap = EMPTY_QUERY;
  if (queryPart.length > 0) {
    const sp = new URLSearchParams(queryPart);
    const m = new Map<string, string>();
    for (const [k, v] of sp.entries()) {
      m.set(k, v);
    }
    query = m;
  }
  return { id: first as RouteId, params, query };
}

/** 按"path 段 + 可选 query"拼回 `#/<id>/<params>?<query>` URL。 */
export function buildHash(r: RouteId, params?: string, query?: Record<string, string>): string {
  const path = params ? `#/${r}/${encodeURIComponent(params)}` : `#/${r}`;
  if (!query) return path;
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return path;
  const sp = new URLSearchParams();
  for (const [k, v] of entries) sp.set(k, v);
  return `${path}?${sp.toString()}`;
}
