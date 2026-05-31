// router parseHash 的 query 段解析契约。
//
// 覆盖:
// - 无 query → query 为空 Map(Stats sha 段直读 params)
// - 单 / 多 / 重复 key → URLSearchParams 标准行为
// - encodeURIComponent 的 params 与 query 互不干扰
// - 非法 route → 退到默认落地页 dashboard + 空 query(IA 重构:旧版默认是 diagnostic)
// - 提交归因逐行深链:`#/stats/<sha>?file=<路径>&L=<a>-<b>` 同时拿到 params(sha)和 query(file/L)
//   (Blame 独立页已并入 Stats;文件/行范围从 path 段迁到独立 query key,避免与文件路径拼段歧义)

import { describe, expect, it } from "vitest";

import { buildHash, parseHash } from "../routerCore";

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

  it("多段 params 仍支持(`#/stats/a/b/c` → params=a/b/c)", () => {
    const r = parseHash("#/stats/a/b/c");
    expect(r.id).toBe("stats");
    expect(r.params).toBe("a/b/c");
    expect(r.query.size).toBe(0);
  });
});

describe("parseHash 解析 ?query 段", () => {
  it("仅 query:`#/stats?file=foo.ts`", () => {
    const r = parseHash("#/stats?file=foo.ts");
    expect(r.id).toBe("stats");
    expect(r.params).toBeUndefined();
    expect(r.query.get("file")).toBe("foo.ts");
  });

  it("params(sha) + query(file/L) 同时:`#/stats/abc1234?file=src%2Ffoo.ts&L=1-10`", () => {
    const r = parseHash("#/stats/abc1234?file=src%2Ffoo.ts&L=1-10");
    expect(r.id).toBe("stats");
    expect(r.params).toBe("abc1234");
    // URLSearchParams 自动 decode % 转义:file 路径里的 / 无损还原
    expect(r.query.get("file")).toBe("src/foo.ts");
    expect(r.query.get("L")).toBe("1-10");
  });

  it("多 key 都拿到", () => {
    const r = parseHash("#/stats/abc?file=foo.ts&L=1-10");
    expect(r.query.get("file")).toBe("foo.ts");
    expect(r.query.get("L")).toBe("1-10");
    expect(r.query.size).toBe(2);
  });

  it("同 key 重复 → 后者覆盖(Map.set 迭代约定)", () => {
    // 实现用 URLSearchParams.entries() 顺序迭代 + Map.set,后者覆盖前者
    const r = parseHash("#/stats?file=first&file=second");
    expect(r.query.get("file")).toBe("second");
    expect(r.query.size).toBe(1);
  });

  it("空 query 段 `#/stats?`(只有 ?) → 空 Map", () => {
    const r = parseHash("#/stats?");
    expect(r.id).toBe("stats");
    expect(r.query.size).toBe(0);
  });

  it("非法 route + query → 退到默认落地页 dashboard,query 也丢弃", () => {
    const r = parseHash("#/not-a-route?sha=abc");
    expect(r.id).toBe("dashboard");
    expect(r.query.size).toBe(0);
  });
});

describe("parseHash 不破文件路径中已被 encode 的字符", () => {
  it("query 里的文件路径含空格(%20)→ 正确 decode", () => {
    const r = parseHash("#/stats/abc?file=src%2Fmy%20file.ts");
    expect(r.params).toBe("abc");
    expect(r.query.get("file")).toBe("src/my file.ts");
  });
});

// 取代被删的 blameUrl roundtrip:Notes/Checkpoints 跳转 → buildHash(stats, sha, {file,L}) →
// 刷新 → parseHash 必须无损还原 sha/file/L,尤其 file 含 URL 元字符(原 blameUrl 的 L 前缀防歧义在此被
// query 段 + URLSearchParams 编码取代,这组往返就是新方案的等价保障)。
describe("buildHash ∘ parseHash 往返(Stats 逐行深链)", () => {
  const sha = "abc1234";
  const files = [
    "src/foo.ts",
    "src/my file.ts", // 空格
    "包/中文文件.ts", // 非 ASCII
    "weird/a&b=c?d#e.ts", // URL 元字符:& = ? #
    "migrations/100-200", // 末段像 range(原 L 前缀方案要防的歧义)
  ];
  for (const file of files) {
    it(`file=${file}(无 L)`, () => {
      const p = parseHash(buildHash("stats", sha, { file }));
      expect(p.id).toBe("stats");
      expect(p.params).toBe(sha);
      expect(p.query.get("file")).toBe(file);
      expect(p.query.get("L")).toBeUndefined();
    });
    it(`file=${file} + L=12-34`, () => {
      const p = parseHash(buildHash("stats", sha, { file, L: "12-34" }));
      expect(p.params).toBe(sha);
      expect(p.query.get("file")).toBe(file);
      expect(p.query.get("L")).toBe("12-34");
    });
  }
});
