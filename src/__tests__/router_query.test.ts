// router parseHash 的 query 段解析契约。
//
// 覆盖:
// - 无 query → query 为空 Map(Stats sha 段直读 params)
// - 单 / 多 / 重复 key → URLSearchParams 标准行为
// - encodeURIComponent 的 params 与 query 互不干扰
// - 非法 route → 退到默认落地页 dashboard + 空 query(IA 重构:旧版默认是 diagnostic)
// - Blame 场景:`#/blame/<file>/L<a>-<b>?sha=<x>` 同时拿到 params 和 query

import { describe, expect, it } from "vitest";

import { parseHash } from "../routerCore";

describe("parseHash 无 query 形态", () => {
  it("空 hash → dashboard(默认落地页) + 空 query", () => {
    const r = parseHash("");
    expect(r.id).toBe("dashboard");
    expect(r.params).toBeUndefined();
    expect(r.query.size).toBe(0);
  });

  it("`#/dashboard` 仅 route → params 空 + query 空", () => {
    const r = parseHash("#/dashboard");
    expect(r.id).toBe("dashboard");
    expect(r.params).toBeUndefined();
    expect(r.query.size).toBe(0);
  });

  it("`#/stats/abc1234` 仅 route + params → query 空 Map", () => {
    const r = parseHash("#/stats/abc1234");
    expect(r.id).toBe("stats");
    expect(r.params).toBe("abc1234");
    expect(r.query.size).toBe(0);
  });

  it("`#/blame/<file>/L1-10` 多段 params + 无 query → 行为不变", () => {
    const r = parseHash("#/blame/src%2Ffoo.ts/L1-10");
    expect(r.id).toBe("blame");
    expect(r.params).toBe("src/foo.ts/L1-10");
    expect(r.query.size).toBe(0);
  });
});

describe("parseHash 解析 ?query 段", () => {
  it("仅 query:`#/blame?sha=abc`", () => {
    const r = parseHash("#/blame?sha=abc");
    expect(r.id).toBe("blame");
    expect(r.params).toBeUndefined();
    expect(r.query.get("sha")).toBe("abc");
  });

  it("params + query 同时:`#/blame/<file>/L1-10?sha=feat%2Fx`", () => {
    const r = parseHash("#/blame/src%2Ffoo.ts/L1-10?sha=feat%2Fx");
    expect(r.id).toBe("blame");
    expect(r.params).toBe("src/foo.ts/L1-10");
    // URLSearchParams 自动 decode % 转义
    expect(r.query.get("sha")).toBe("feat/x");
  });

  it("多 key 都拿到", () => {
    const r = parseHash("#/blame?sha=abc&line=10");
    expect(r.query.get("sha")).toBe("abc");
    expect(r.query.get("line")).toBe("10");
    expect(r.query.size).toBe(2);
  });

  it("同 key 重复 → 后者覆盖(Map.set 迭代约定)", () => {
    // 实现用 URLSearchParams.entries() 顺序迭代 + Map.set,后者覆盖前者
    const r = parseHash("#/blame?sha=first&sha=second");
    expect(r.query.get("sha")).toBe("second");
    expect(r.query.size).toBe(1);
  });

  it("空 query 段 `#/blame?`(只有 ?) → 空 Map", () => {
    const r = parseHash("#/blame?");
    expect(r.id).toBe("blame");
    expect(r.query.size).toBe(0);
  });

  it("非法 route + query → 退到默认落地页 dashboard,query 也丢弃", () => {
    const r = parseHash("#/not-a-route?sha=abc");
    expect(r.id).toBe("dashboard");
    expect(r.query.size).toBe(0);
  });
});

describe("parseHash 不破文件路径中已被 encode 的字符", () => {
  it("文件路径含空格(%20) + query → 都正确 decode", () => {
    const r = parseHash("#/blame/src%2Fmy%20file.ts?sha=main");
    expect(r.params).toBe("src/my file.ts");
    expect(r.query.get("sha")).toBe("main");
  });
});
