// BlamePayload → 逐行渲染数据的纯派生:AI 行 promptId 索引 + 每行作者/模型标签。
// 从原 Blame 页 / Stats 弹窗两处逐字节重复的实现抽出,单一权威、可单测。
// 口径:`lines` 的 key 形如 "12" 或 "12-34"(上游 blame-analysis),命中即标 AI;
// 其余行按 hunks 的 git 作者着色。AI 行标模型(tool::model),人写行标作者。

import type { BlameLineAuthor } from "../components/BlameCodeView";
import type { BlamePayload } from "./types";

export interface DerivedBlameLines {
  /** 行号 → promptId:命中 AI prompt 记录的行。 */
  aiLines: Map<number, string>;
  /** 行号 → 作者/模型标签:AI 行标模型,人写行标 git 作者。 */
  lineAuthors: Map<number, BlameLineAuthor>;
}

export function deriveBlameLines(payload: BlamePayload | null): DerivedBlameLines {
  const aiLines = new Map<number, string>();
  const lineAuthors = new Map<number, BlameLineAuthor>();
  if (!payload) return { aiLines, lineAuthors };

  for (const [key, promptId] of Object.entries(payload.lines)) {
    const mr = /^(\d+)(?:-(\d+))?$/.exec(key);
    if (!mr) continue;
    const a = Number(mr[1]);
    const b = mr[2] ? Number(mr[2]) : a;
    if (a < 1 || b < a) continue;
    for (let n = a; n <= b; n++) aiLines.set(n, promptId);
  }

  for (const hunk of payload.hunks) {
    const [start, end] = hunk.range;
    if (start < 1 || end < start) continue;
    const dateLabel = hunk.author_time
      ? new Date(hunk.author_time * 1000).toISOString().slice(0, 10)
      : "—";
    const baseTitle = `${hunk.original_author || "(unknown)"} · ${hunk.abbrev_sha || hunk.commit_sha.slice(0, 7)} · ${dateLabel}`;
    for (let n = start; n <= end; n++) {
      const pid = aiLines.get(n);
      if (pid) {
        const prompt = payload.prompts[pid];
        const tool = prompt?.agent_id.tool ?? "ai";
        const model = prompt?.agent_id.model ?? tool;
        lineAuthors.set(n, {
          label: model,
          tone: "ai",
          title: prompt ? `AI: ${tool}::${model}` : "AI",
        });
      } else {
        const label = hunk.original_author || "(unknown)";
        lineAuthors.set(n, { label, tone: "human", title: baseTitle });
      }
    }
  }
  return { aiLines, lineAuthors };
}

/**
 * 解析 Stats 深链的行范围 query 值 `?L=<a>-<b>` → `[a, b]`。
 * 非法(空 / 格式错 / a<1 / b<a)一律返回 null(不静默纠正)。
 * 取代原 blameUrl.ts 的 path 段 `L` 前缀方案:行范围改走独立 query key,
 * 不再与文件路径拼在同一 path 段,天然规避"文件名末段像 12-34"的歧义。
 */
export function parseLRange(value: string | null | undefined): [number, number] | null {
  if (!value) return null;
  const m = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a < 1 || b < a) return null;
  return [a, b];
}
