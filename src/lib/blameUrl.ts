// Blame 页 URL 路径段 ↔ {file, range} 的双向编解码。
//
// # URL 形态
// - 仅 file:`<file/path>`
// - 带 range:`<file/path>/L<start>-<end>`(`L` 前缀沿用 `git blame -L` 语义)
//
// # 为什么用 `L` 前缀(评审 P7 #39 红线)
// 历史方案 `<file>/<a>-<b>` 在文件路径末段恰好为 `\d+-\d+` 时(如 `migrations/100-200`)
// 会被误识别为 range,导致 file 段丢失。`L` 前缀让 range 段无法与合法文件路径冲突
// (文件路径段几乎不可能精确等于 `L\d+-\d+`)。

export interface BlameUrlParams {
  file: string | null;
  range: [number, number] | null;
}

export function parseBlameParams(params: string | undefined): BlameUrlParams {
  if (!params) return { file: null, range: null };
  const parts = params.split("/");
  let range: [number, number] | null = null;
  let fileParts = parts;
  if (parts.length >= 1) {
    const last = parts[parts.length - 1];
    const m = /^L(\d+)-(\d+)$/.exec(last);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a >= 1 && b >= a) {
        range = [a, b];
        fileParts = parts.slice(0, -1);
      }
    }
  }
  const file = fileParts.length > 0 ? fileParts.join("/") : null;
  return { file, range };
}

export function buildBlameUrlParams(
  file: string | null,
  range: [number, number] | null,
): string | undefined {
  if (!file) return undefined;
  return range ? `${file}/L${range[0]}-${range[1]}` : file;
}
