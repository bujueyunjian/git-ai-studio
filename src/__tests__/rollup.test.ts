// M3 纯函数单测:reposKey(顺序无关稳定)+ rollupBuckets(日/周/月,周一为周首)。

import { describe, expect, it } from "vitest";

import { reposKey } from "../lib/queryKeys";
import { rollupBuckets } from "../lib/rollup";
import type { DailyBucket } from "../lib/types";

describe("reposKey", () => {
  it("顺序无关:勾选顺序不同、集合相同 → 同一 key", () => {
    expect(reposKey(["/c", "/a", "/b"])).toBe(reposKey(["/a", "/b", "/c"]));
  });
  it("多次调用稳定", () => {
    expect(reposKey(["/x", "/y"])).toBe(reposKey(["/x", "/y"]));
  });
  it("不同集合 → 不同 key", () => {
    expect(reposKey(["/a"])).not.toBe(reposKey(["/a", "/b"]));
  });
});

function bucket(
  date: string,
  human: number,
  unknown: number,
  ai: number,
  commits = 1,
): DailyBucket {
  return {
    date,
    human_additions: human,
    unknown_additions: unknown,
    ai_additions: ai,
    commit_count: commits,
  };
}

describe("rollupBuckets", () => {
  const daily: DailyBucket[] = [
    bucket("2025-05-05", 10, 1, 5, 2), // 周一
    bucket("2025-05-07", 4, 0, 6, 1), // 同周(周三)
    bucket("2025-05-12", 2, 2, 8, 3), // 下一周(周一)
  ];

  it("day:原样返回", () => {
    expect(rollupBuckets(daily, "day")).toBe(daily);
  });

  it("空输入:任一粒度都返回空数组(不抛错)", () => {
    expect(rollupBuckets([], "day")).toEqual([]);
    expect(rollupBuckets([], "week")).toEqual([]);
    expect(rollupBuckets([], "month")).toEqual([]);
  });

  it("week:按周一分组,三桶+commit_count 相加,周一日期作 key", () => {
    const weeks = rollupBuckets(daily, "week");
    expect(weeks.map((w) => w.date)).toEqual(["2025-05-05", "2025-05-12"]);
    // 第一周 = 05-05 + 05-07 合并
    expect(weeks[0]).toMatchObject({
      date: "2025-05-05",
      human_additions: 14,
      unknown_additions: 1,
      ai_additions: 11,
      commit_count: 3,
    });
    // 第二周 = 05-12
    expect(weeks[1]).toMatchObject({ date: "2025-05-12", ai_additions: 8, commit_count: 3 });
  });

  it("week:周日归入上一个周一(05-11 周日 → 05-05 周一)", () => {
    const weeks = rollupBuckets([bucket("2025-05-11", 1, 0, 0)], "week");
    expect(weeks[0].date).toBe("2025-05-05");
  });

  it("month:按当月首日分组合并", () => {
    const months = rollupBuckets(daily, "month");
    expect(months).toHaveLength(1);
    expect(months[0]).toMatchObject({
      date: "2025-05-01",
      human_additions: 16,
      ai_additions: 19,
      commit_count: 6,
    });
  });

  it("不预存占比:输出只有行数桶,无 rate 字段", () => {
    const weeks = rollupBuckets(daily, "week");
    expect(Object.keys(weeks[0]).sort()).toEqual(
      ["ai_additions", "commit_count", "date", "human_additions", "unknown_additions"].sort(),
    );
  });
});
