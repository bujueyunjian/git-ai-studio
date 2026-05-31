// Notes attestation 行范围解析的契约测试。
//
// 覆盖 `parseLineRanges`(`lib/types.ts`):上游 `format_line_ranges` 真源
// (`git-ai/src/authorship/authorship_log_serialization.rs:576-598`)。
// Notes 详情据此把 attestation 的 line_ranges 解析出首段,拼成提交归因深链
// `#/stats/<sha>?file=<路径>&L=<a>-<b>`(`?L=` 的解析见 blameLines.test 的 parseLRange)。

import { describe, expect, it } from "vitest";

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
