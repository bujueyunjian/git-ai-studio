// CodeMirror 6 行级 Blame 视图。
//
// # 关键事实
// - AI 行映射来自后端 `lines` BTreeMap("13" 或 "15-25" → prompt_id);**只含 AI 行**
// - 非 AI 行不在 map 里 → 渲染无 line decoration,背景是 vscode theme 默认底色
// - aiLines 通过 StateField 持有,**gutter `lineMarker` 从 view.state.field 读**(不靠 useMemo 闭包)
// - aiLines 引用变化时 dispatch StateEffect,EditorView 不重建
//
// # 点击事件
// gutter `domEventHandlers.mousedown(view, line, event)` 拿 `event` 的 target rect 上抛 → React 控制 Popover 锚定
// (修正评审 B #3:原先用 `window.getSelection()` 在 readOnly CM6 + gutter 路径下永远拿不到 rangeCount > 0)
//
// # a11y
// - AiGutterMarker DOM 节点加 `role="button"`、`tabIndex=0`、`aria-label`、键盘 Enter/Space 触发

import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, gutter, GutterMarker, lineNumbers } from "@codemirror/view";
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

/** StateField:同时为 line decoration 与 gutter 提供数据源(消除闭包陈旧)。 */
const aiLinesField = StateField.define<Map<number, string>>({
  create: () => new Map(),
  update(map, tr) {
    for (const e of tr.effects) {
      if (e.is(setAiLines)) return e.value;
    }
    return map;
  },
});

/** lineAuthors 推送 effect + StateField。同 aiLines 走 effect → field 模式,避免 view 重建。 */
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

/** a11y-friendly gutter marker。 */
class AiGutterMarker extends GutterMarker {
  constructor(private readonly lineNumber: number) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof AiGutterMarker && other.lineNumber === this.lineNumber;
  }
  override toDOM() {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "blame-gutter-ai-marker";
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", `第 ${this.lineNumber} 行 AI 归属 — 点击展开 prompt 摘要`);
    return el;
  }
}

/** 行作者 gutter marker。display only,不可点(展开详情走 AI 蓝条 popover)。 */
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
  /** 点击元素的视口位置,React 端用作 Popover 锚点。 */
  rect: { x: number; y: number; bottom: number };
}

/**
 * 每行作者归因。AI 行优先标 AI tool 简称 + AI human(由调用方在 Blame.tsx 组装);
 * 非 AI 行用 git blame 的 original_author。
 */
export interface BlameLineAuthor {
  /** 显示文本(已截到 ~14 字符),如 "Alice" / "claude" / "Bob/cursor"。 */
  label: string;
  /** 显示色调:ai 蓝、human 灰。 */
  tone: "ai" | "human";
  /** hover tooltip 用的全文(commit 短 sha + 时间 + 作者全名)。 */
  title: string;
}

export interface BlameCodeViewProps {
  code: string;
  filePath: string;
  aiLines: Map<number, string>;
  /** 每行作者(包含 AI 与非 AI);key 为 1-based line number。无对应行 → 不渲染。 */
  lineAuthors: Map<number, BlameLineAuthor>;
  theme: "light" | "dark";
  onLineClick: (e: BlameLineClickEvent) => void;
}

export function BlameCodeView({
  code,
  filePath,
  aiLines,
  lineAuthors,
  theme,
  onLineClick,
}: BlameCodeViewProps) {
  const viewRef = useRef<EditorView | null>(null);
  const onLineClickRef = useRef(onLineClick);
  onLineClickRef.current = onLineClick;

  const extensions = useMemo(() => {
    const lang = langExtensionFor(filePath);
    const aiColor = bucketColor("ai", theme);

    const dispatchClick = (target: HTMLElement, lineNumber: number, promptId: string) => {
      const rect = target.getBoundingClientRect();
      onLineClickRef.current({
        lineNumber,
        promptId,
        rect: { x: rect.left, y: rect.top, bottom: rect.bottom },
      });
    };

    const aiGutter = gutter({
      class: "blame-ai-gutter",
      lineMarker(view, line) {
        const lineNum = view.state.doc.lineAt(line.from).number;
        const map = view.state.field(aiLinesField); // 从 state 读,避免闭包陈旧
        return map.has(lineNum) ? new AiGutterMarker(lineNum) : null;
      },
      lineMarkerChange: (update) =>
        update.docChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setAiLines))),
      initialSpacer: () => new AiGutterMarker(0),
      domEventHandlers: {
        mousedown(view, line, evt) {
          const lineNum = view.state.doc.lineAt(line.from).number;
          const map = view.state.field(aiLinesField);
          const promptId = map.get(lineNum);
          if (!promptId) return false;
          const target = evt.target as HTMLElement | null;
          if (target) dispatchClick(target, lineNum, promptId);
          return false;
        },
      },
    });

    // 作者列 gutter:显示在 lineNumbers 之前的最左侧。
    // 内容来自 lineAuthorsField,每行一个作者标签;AI 行用主色,非 AI 行用灰色。
    const authorGutter = gutter({
      class: "blame-author-gutter",
      lineMarker(view, line) {
        const lineNum = view.state.doc.lineAt(line.from).number;
        const map = view.state.field(lineAuthorsField);
        const a = map.get(lineNum);
        return a ? new AuthorGutterMarker(a.label, a.tone, a.title) : null;
      },
      lineMarkerChange: (update) =>
        update.docChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setLineAuthors))),
      // 占位用最长可能 label(14 字符)保证 gutter 宽度稳定不抖动
      initialSpacer: () => new AuthorGutterMarker("M".repeat(14), "human", ""),
    });

    return [
      EditorState.readOnly.of(true),
      lineNumbers(),
      aiLinesField,
      lineAuthorsField,
      aiLineDecorations,
      authorGutter,
      aiGutter,
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
        },
        ".blame-gutter-ai-marker": {
          display: "block",
          width: "4px",
          height: "100%",
          backgroundColor: aiColor,
          marginLeft: "2px",
          padding: 0,
          border: "none",
          cursor: "pointer",
        },
        ".blame-gutter-ai-marker:focus-visible": {
          outline: `2px solid ${aiColor}`,
          outlineOffset: "1px",
        },
        ".blame-ai-gutter": { paddingLeft: "0", paddingRight: "0" },
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
        ".blame-author-ai": {
          color: aiColor,
        },
        ".blame-author-human": {
          color: theme === "dark" ? "#94a3b8" : "#64748b",
        },
      }),
      ...(lang ? [lang] : []),
    ];
  }, [filePath, theme]);

  // aiLines 引用变化 → dispatch effect 推送到 StateField(不重建 view)
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: setAiLines.of(aiLines) });
  }, [aiLines]);

  // 同样路径推送 lineAuthors,不重建 view
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: setLineAuthors.of(lineAuthors) });
  }, [lineAuthors]);

  // 键盘可达性:Enter/Space 在 gutter 按钮上触发同 mousedown 路径
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const target = e.target as HTMLElement | null;
      if (!target?.classList?.contains("blame-gutter-ai-marker")) return;
      e.preventDefault();
      // 通过 DOM 顺序反推行号:walk up 找 .cm-gutterElement,index 与 doc.line 对应
      const gel = target.closest(".cm-gutterElement");
      if (!gel) return;
      const all = Array.from(gel.parentElement?.children ?? []);
      const visIdx = all.indexOf(gel);
      if (visIdx < 0) return;
      // 视口可见区域的首行
      const blockAtTop = v.lineBlockAtHeight(v.scrollDOM.scrollTop);
      const topLineNumber = v.state.doc.lineAt(blockAtTop.from).number;
      const lineNum = topLineNumber + visIdx;
      const map = v.state.field(aiLinesField);
      const pid = map.get(lineNum);
      if (!pid) return;
      const rect = target.getBoundingClientRect();
      onLineClickRef.current({
        lineNumber: lineNum,
        promptId: pid,
        rect: { x: rect.left, y: rect.top, bottom: rect.bottom },
      });
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
          effects: [setAiLines.of(aiLines), setLineAuthors.of(lineAuthors)],
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
