// CodeMirror 6 行级 Blame 视图(单一克制编码:整行淡底 + 行号染色,代码当主角)。
//
// # 关键事实
// - AI 行映射来自后端 `lines` BTreeMap("13" 或 "15-25" → prompt_id);**只含 AI 行**
// - 非 AI 行不在 map 里 → 无 decoration,背景是 vscode theme 默认底色(克制:人写行=默认)
// - aiLines 通过 StateField 持有,decoration / gutterLineClass 都从 view.state.field 读(不靠闭包)
// - aiLines 引用变化时 dispatch StateEffect,EditorView 不重建
//
// # AI 编码(默认只此一种,刻意克制)
// - AI 行整行淡主色底(`.blame-ai-line`)+ 行号染主色加粗(`gutterLineClass` → `.blame-ai-linenum`)
//
// # 可选作者/模型列(`lineAuthors`)
// - **仅当调用方传入 `lineAuthors` 时**渲染左侧作者列:AI 行标模型、人写行标作者(色调区分)。
// - Blame 页不传 → 全宽代码;Stats 的"文件逐行弹窗"传入 → 一眼看清每行是人还是哪个模型写的。
//
// # 点击下钻
// 点 AI 行任意位置 → `posAtCoords` 反推行号 → 命中 aiLinesField 则上抛 `BlameLineClickEvent`,
// 由上层渲染详情。键盘:editor 内插入符落在 AI 行时 Enter 触发。

import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, RangeSet, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  gutterLineClass,
  lineNumbers,
} from "@codemirror/view";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef } from "react";

import { bucketColor } from "../lib/chartColors";

/** lang 包按文件后缀映射;默认 null = 纯文本。 */
function langExtensionFor(file: string) {
  const dot = file.lastIndexOf(".");
  const ext = dot >= 0 ? file.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: ext.endsWith("x"), typescript: ext.startsWith("ts") });
    case "json":
      return json();
    case "py":
      return python();
    case "rs":
      return rust();
    case "css":
    case "scss":
      return css();
    case "html":
    case "htm":
      return html();
    case "md":
    case "markdown":
      return markdown();
    default:
      return null;
  }
}

/** aiLines 推送 effect。 */
const setAiLines = StateEffect.define<Map<number, string>>();

/** StateField:为 line decoration 与 gutterLineClass 提供数据源(消除闭包陈旧)。 */
const aiLinesField = StateField.define<Map<number, string>>({
  create: () => new Map(),
  update(map, tr) {
    for (const e of tr.effects) {
      if (e.is(setAiLines)) return e.value;
    }
    return map;
  },
});

/** lineAuthors 推送 effect + StateField(可选作者列的数据源)。 */
const setLineAuthors = StateEffect.define<Map<number, BlameLineAuthor>>();
const lineAuthorsField = StateField.define<Map<number, BlameLineAuthor>>({
  create: () => new Map(),
  update(map, tr) {
    for (const e of tr.effects) {
      if (e.is(setLineAuthors)) return e.value;
    }
    return map;
  },
});

function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${a})`;
}

/** AI 行整行淡主色底。 */
const aiLineDecorations = EditorView.decorations.compute([aiLinesField], (state) => {
  const map = state.field(aiLinesField);
  const sorted = [...map.keys()].sort((a, b) => a - b);
  const ranges = sorted
    .filter((line) => line >= 1 && line <= state.doc.lines)
    .map((line) =>
      Decoration.line({ attributes: { class: "blame-ai-line" } }).range(state.doc.line(line).from),
    );
  return Decoration.set(ranges);
});

/** 行号染色 marker:给 AI 行的 gutter 元素(含行号)加 class,CSS 染主色。 */
class AiLineNumberMarker extends GutterMarker {
  override elementClass = "blame-ai-linenum";
}

/** 行号 gutter 的 AI 行着色(从 aiLinesField 计算)。 */
const aiLineNumberClass = gutterLineClass.compute([aiLinesField], (state) => {
  const map = state.field(aiLinesField);
  const sorted = [...map.keys()]
    .sort((a, b) => a - b)
    .filter((line) => line >= 1 && line <= state.doc.lines);
  return RangeSet.of(
    sorted.map((line) => new AiLineNumberMarker().range(state.doc.line(line).from)),
    true,
  );
});

/** 作者/模型列 marker。display only,展开详情走点击 AI 行。 */
class AuthorGutterMarker extends GutterMarker {
  constructor(
    private readonly label: string,
    private readonly tone: "ai" | "human",
    private readonly title: string,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof AuthorGutterMarker &&
      other.label === this.label &&
      other.tone === this.tone &&
      other.title === this.title
    );
  }
  override toDOM() {
    const el = document.createElement("span");
    el.className = `blame-author-marker blame-author-${this.tone}`;
    el.textContent = this.label;
    el.title = this.title;
    return el;
  }
}

export interface BlameLineClickEvent {
  lineNumber: number;
  promptId: string;
}

/**
 * 每行作者归因(可选作者列用)。AI 行标模型简称(tone="ai"),人写行标 git 作者(tone="human")。
 */
export interface BlameLineAuthor {
  /** 显示文本(已截到 ~14 字符)。 */
  label: string;
  tone: "ai" | "human";
  /** hover tooltip 全文。 */
  title: string;
}

export interface BlameCodeViewProps {
  code: string;
  filePath: string;
  aiLines: Map<number, string>;
  theme: "light" | "dark";
  onLineClick: (e: BlameLineClickEvent) => void;
  /** 传入则渲染左侧作者/模型列(每行是人还是哪个模型);不传 → 全宽代码,无此列。 */
  lineAuthors?: Map<number, BlameLineAuthor>;
}

export function BlameCodeView({
  code,
  filePath,
  aiLines,
  theme,
  onLineClick,
  lineAuthors,
}: BlameCodeViewProps) {
  const viewRef = useRef<EditorView | null>(null);
  const onLineClickRef = useRef(onLineClick);
  onLineClickRef.current = onLineClick;
  const withAuthors = !!lineAuthors;

  const extensions = useMemo(() => {
    const lang = langExtensionFor(filePath);
    const aiColor = bucketColor("ai", theme);

    // 点 AI 行任意位置 → 反推行号 → 命中则上抛(不带 rect,上层用停靠/弹窗详情)。
    const clickHandler = EditorView.domEventHandlers({
      mousedown(evt, view) {
        const pos = view.posAtCoords({ x: evt.clientX, y: evt.clientY });
        if (pos == null) return false;
        const lineNum = view.state.doc.lineAt(pos).number;
        const promptId = view.state.field(aiLinesField).get(lineNum);
        if (!promptId) return false;
        onLineClickRef.current({ lineNumber: lineNum, promptId });
        return false;
      },
    });

    // 可选作者列:仅当调用方传入 lineAuthors 时启用,渲染在行号之后、代码之前。
    const authorGutter = gutter({
      class: "blame-author-gutter",
      lineMarker(view, line) {
        const lineNum = view.state.doc.lineAt(line.from).number;
        const a = view.state.field(lineAuthorsField).get(lineNum);
        return a ? new AuthorGutterMarker(a.label, a.tone, a.title) : null;
      },
      lineMarkerChange: (update) =>
        update.docChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setLineAuthors))),
      // 占位用最长可能 label(14 字符)保证列宽稳定不抖动
      initialSpacer: () => new AuthorGutterMarker("M".repeat(14), "human", ""),
    });

    return [
      EditorState.readOnly.of(true),
      lineNumbers(),
      aiLinesField,
      aiLineDecorations,
      aiLineNumberClass,
      clickHandler,
      ...(withAuthors ? [lineAuthorsField, authorGutter] : []),
      EditorView.theme({
        // `&` = `.cm-editor`:把编辑器盒子钉死在右栏宽度内,否则下面 `.cm-content`
        // 的 `max-content` 会把整个编辑器撑得比右栏宽,被祖先 overflow-hidden 裁掉
        // (看不到右侧 + 无横向滚动条;纵向滚动时按可见行重算宽度而抖动)。
        "&": {
          width: "100%",
          maxWidth: "100%",
          height: "100%",
          maxHeight: "100%",
          overflow: "hidden",
        },
        // 横向滚动收敛到 scroller 内部:长行在此滚动,而非让编辑器整体溢出。
        ".cm-scroller": {
          width: "100%",
          maxWidth: "100%",
          height: "100%",
          overflow: "auto",
        },
        ".cm-content": { minWidth: "max-content" }, // 防 AI 行背景水平滚动露白
        ".blame-ai-line": {
          backgroundColor: withAlpha(aiColor, 0.18),
          cursor: "pointer",
        },
        // 行号 gutter 上 AI 行染主色加粗(单一编码的第二半:行号着色)
        ".blame-ai-linenum": {
          color: aiColor,
          fontWeight: "600",
        },
        ".blame-author-gutter": {
          paddingLeft: "6px",
          paddingRight: "6px",
          borderRight: theme === "dark" ? "1px solid #1e293b" : "1px solid #e2e8f0",
        },
        ".blame-author-marker": {
          display: "inline-block",
          fontSize: "10px",
          lineHeight: "inherit",
          maxWidth: "112px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
          cursor: "default",
        },
        ".blame-author-ai": { color: aiColor },
        ".blame-author-human": { color: theme === "dark" ? "#94a3b8" : "#64748b" },
      }),
      ...(lang ? [lang] : []),
    ];
  }, [filePath, theme, withAuthors]);

  // aiLines 引用变化 → dispatch effect 推送到 StateField(不重建 view)
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: setAiLines.of(aiLines) });
  }, [aiLines]);

  // lineAuthors 同路径推送(可选列;未传则推空 Map,gutter 渲染为空)
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: setLineAuthors.of(lineAuthors ?? new Map()) });
  }, [lineAuthors]);

  // 键盘可达性:editor 内插入符落在 AI 行时按 Enter 触发同下钻路径(readOnly 仍可移动插入符)
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const head = v.state.selection.main.head;
      const lineNum = v.state.doc.lineAt(head).number;
      const promptId = v.state.field(aiLinesField).get(lineNum);
      if (!promptId) return;
      e.preventDefault();
      onLineClickRef.current({ lineNumber: lineNum, promptId });
    };
    const dom = v.scrollDOM;
    dom.addEventListener("keydown", onKeyDown);
    return () => dom.removeEventListener("keydown", onKeyDown);
  }, []);

  // height="100%" 只通过 CM6 theme 注入到 `.cm-editor`,但 `@uiw/react-codemirror` 的外层 wrapper
  // `<div class="cm-theme-*">` 没有 inline height(参见 node_modules/.../react-codemirror/src/index.tsx:167)。
  // 不补 `className="h-full"`,wrapper 默认按内容高度撑开,长文件会被父 `flex-1 overflow-hidden` 直接裁掉
  // (踩坑:Blame 92 行文件只显示到第 27 行,2026-05-13)。
  return (
    <CodeMirror
      className="h-full min-h-0 w-full min-w-0 overflow-hidden"
      value={code}
      theme={theme === "dark" ? vscodeDark : vscodeLight}
      extensions={extensions}
      onCreateEditor={(view) => {
        viewRef.current = view;
        view.dispatch({
          effects: [setAiLines.of(aiLines), setLineAuthors.of(lineAuthors ?? new Map())],
        });
      }}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: false,
        searchKeymap: false,
      }}
      readOnly
      height="100%"
    />
  );
}
