// P10 #42 + #39 — Notes attestation 跳 Blame 带 ranges 的契约测试。
//
// 覆盖:
// - `parseLineRanges`(`lib/types.ts`):上游 `format_line_ranges` 真源
//   (`git-ai/src/authorship/authorship_log_serialization.rs:576-598`)
// - `parseBlameParams` / `buildBlameUrlParams`(`lib/blameUrl.ts`):L 前缀方案(评审 #39)
// - Roundtrip(parse∘build = id)
// - 边界:文件路径末段为 `\d+-\d+` / 单行 range / 起点 0 / start > end

import { describe, expect, it } from "vitest";

import { buildBlameUrlParams, parseBlameParams } from "../lib/blameUrl";
import { parseLineRanges } from "../lib/types";

describe("parseLineRanges(上游 format_line_ranges 真源)", () => {
  it("Single → [l,l](`5` → `[[5,5]]`)", () => {
    expect(parseLineRanges("5")).toEqual([[5, 5]]);
  });

  it("Range → [start,end](`1-10` → `[[1,10]]`)", () => {
    expect(parseLineRanges("1-10")).toEqual([[1, 10]]);
  });

  it("多段升序(`5,10-15,20-25` 全部保留)", () => {
    expect(parseLineRanges("5,10-15,20-25")).toEqual([
      [5, 5],
      [10, 15],
      [20, 25],
    ]);
  });

  it("空字符串 / 仅空白 → []", () => {
    expect(parseLineRanges("")).toEqual([]);
    expect(parseLineRanges("   ")).toEqual([]);
  });

  it("空段跳过(`5,,10`)", () => {
    expect(parseLineRanges("5,,10")).toEqual([
      [5, 5],
      [10, 10],
    ]);
  });

  it("非法段整段 fail(`abc` / `5-abc` / `10-5` / `0`)", () => {
    expect(parseLineRanges("abc")).toEqual([]);
    expect(parseLineRanges("5-abc")).toEqual([]);
    expect(parseLineRanges("10-5")).toEqual([]); // start > end
    expect(parseLineRanges("0")).toEqual([]); // line 1-based
    expect(parseLineRanges("5,abc,10")).toEqual([]); // 一坏全坏
  });

  it("不接受负数 / 浮点 / 空格夹中", () => {
    expect(parseLineRanges("-5")).toEqual([]);
    expect(parseLineRanges("5.5")).toEqual([]);
    expect(parseLineRanges("5 - 10")).toEqual([]); // regex 不允许内部空白
  });
});

describe("parseBlameParams(L 前缀方案,#39 修复)", () => {
  it("仅 file:无 range", () => {
    expect(parseBlameParams("src/foo.ts")).toEqual({ file: "src/foo.ts", range: null });
  });

  it("file + range:`src/foo.ts/L5-10` → range=[5,10]", () => {
    expect(parseBlameParams("src/foo.ts/L5-10")).toEqual({
      file: "src/foo.ts",
      range: [5, 10],
    });
  });

  it("纯数字-数字文件路径不再误识别(#39 红线)", () => {
    // 老 bug:`migrations/100-200` 末段 `100-200` 匹配 `\d+-\d+` → 被切成 range。
    // 现在末段必须是 `L\d+-\d+`,故下例 file 保留完整。
    expect(parseBlameParams("migrations/100-200")).toEqual({
      file: "migrations/100-200",
      range: null,
    });
  });

  it("文件名恰好是 `100-200` 单段也不误判", () => {
    expect(parseBlameParams("100-200")).toEqual({ file: "100-200", range: null });
  });

  it("非法 range(start > end / 0 起点)→ 不识别为 range,整段当 file", () => {
    expect(parseBlameParams("foo/L10-5")).toEqual({ file: "foo/L10-5", range: null });
    expect(parseBlameParams("foo/L0-10")).toEqual({ file: "foo/L0-10", range: null });
  });

  it("空 params → {file: null, range: null}", () => {
    expect(parseBlameParams(undefined)).toEqual({ file: null, range: null });
  });
});

describe("buildBlameUrlParams ∘ parseBlameParams = id", () => {
  it.each([
    ["src/foo.ts", null],
    ["src/foo.ts", [1, 1]],
    ["src/foo.ts", [10, 25]],
    ["a/b/c/deep/file.rs", [100, 200]],
    ["migrations/100-200", null],
  ] as Array<[string, [number, number] | null]>)("roundtrip file=%s range=%j", (file, range) => {
    const built = buildBlameUrlParams(file, range);
    const parsed = parseBlameParams(built);
    expect(parsed.file).toBe(file);
    expect(parsed.range).toEqual(range);
  });

  it("file=null → 不输出 URL", () => {
    expect(buildBlameUrlParams(null, null)).toBeUndefined();
    expect(buildBlameUrlParams(null, [1, 10])).toBeUndefined();
  });
});
