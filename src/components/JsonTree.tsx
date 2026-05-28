// 递归渲染任意 JSON-like 值的 viewer 组件。
//
// # 设计
// - object/array 折叠;primitive 平铺
// - 折叠节点用 `<button aria-expanded>` + Enter/Space 触发(浏览器原生支持)
// - 默认展开层数可控,深层默认折叠减少首屏 DOM
// - 字符串值 white-space:pre-wrap 保留换行;长字符串不截断(用户主动看)
// - 不做脱敏 / 不打码(数据是用户自己的,viewer 中性透传)

import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../lib/cn";

export interface JsonTreeProps {
  value: unknown;
  /** 当前节点的 key/index 标签(顶层省略)。 */
  label?: string;
  /** 顶层为 0;每深一层 +1。 */
  depth?: number;
  /** 小于等于该深度的 object/array 默认展开。primitive 不受影响。默认 1。 */
  defaultOpenDepth?: number;
  /** 递归深度上限;超过转 `<pre>` 兜底,防极端嵌套爆栈(评审 P7 #43)。默认 50。 */
  maxDepth?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function JsonTree({
  value,
  label,
  depth = 0,
  defaultOpenDepth = 1,
  maxDepth = 50,
}: JsonTreeProps) {
  // 深度防御:超过 maxDepth 不再递归,直接 stringify 兜底(避免 React reconciler 爆栈)
  if (depth >= maxDepth) {
    return (
      <div className="font-mono text-xs leading-5">
        {label && <span className="text-purple-700 dark:text-purple-300">{label}: </span>}
        <pre className="my-1 whitespace-pre-wrap wrap-break-word rounded-sm bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {(() => {
            try {
              return JSON.stringify(value);
            } catch {
              return "(无法序列化:循环引用或 BigInt)";
            }
          })()}
        </pre>
      </div>
    );
  }
  if (Array.isArray(value)) {
    return (
      <CollapsibleLine
        depth={depth}
        label={label}
        preview={`[${value.length} items]`}
        defaultOpen={depth < defaultOpenDepth}
      >
        {value.length === 0 ? (
          <EmptyHint text="(空数组)" />
        ) : (
          <ul className="space-y-0.5">
            {value.map((item, i) => (
              <li key={i}>
                <JsonTree
                  value={item}
                  label={`[${i}]`}
                  depth={depth + 1}
                  defaultOpenDepth={defaultOpenDepth}
                  maxDepth={maxDepth}
                />
              </li>
            ))}
          </ul>
        )}
      </CollapsibleLine>
    );
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    return (
      <CollapsibleLine
        depth={depth}
        label={label}
        preview={`{${keys.length} keys}`}
        defaultOpen={depth < defaultOpenDepth}
      >
        {keys.length === 0 ? (
          <EmptyHint text="(空对象)" />
        ) : (
          <ul className="space-y-0.5">
            {keys.map((k) => (
              <li key={k}>
                <JsonTree
                  value={value[k]}
                  label={k}
                  depth={depth + 1}
                  defaultOpenDepth={defaultOpenDepth}
                  maxDepth={maxDepth}
                />
              </li>
            ))}
          </ul>
        )}
      </CollapsibleLine>
    );
  }

  return <PrimitiveLine label={label} value={value} />;
}

function CollapsibleLine({
  depth,
  label,
  preview,
  defaultOpen,
  children,
}: {
  depth: number;
  label?: string;
  preview: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="font-mono text-xs leading-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform",
            open && "rotate-90",
          )}
        />
        {label && <span className="text-purple-700 dark:text-purple-300">{label}:</span>}
        <span className="text-slate-400">{preview}</span>
      </button>
      {open && (
        <div
          className="ml-3 border-l border-slate-200 pl-3 dark:border-border"
          style={{ marginLeft: depth === 0 ? "0.75rem" : undefined }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function PrimitiveLine({ label, value }: { label?: string; value: unknown }) {
  return (
    <div className="font-mono text-xs leading-5">
      {label && <span className="text-purple-700 dark:text-purple-300">{label}: </span>}
      {renderPrimitive(value)}
    </div>
  );
}

function renderPrimitive(v: unknown): ReactNode {
  if (v === null) return <span className="text-slate-400">null</span>;
  if (typeof v === "undefined") return <span className="text-slate-400">undefined</span>;
  if (typeof v === "boolean")
    return <span className="text-amber-700 dark:text-amber-300">{String(v)}</span>;
  if (typeof v === "number")
    return <span className="text-emerald-700 dark:text-emerald-300">{String(v)}</span>;
  if (typeof v === "string") {
    return (
      <span className="whitespace-pre-wrap wrap-break-word text-primary">{JSON.stringify(v)}</span>
    );
  }
  // 兜底:Symbol / BigInt / Function 等极少出现的类型,字符串化展示
  return <span className="text-slate-500">{String(v)}</span>;
}

function EmptyHint({ text }: { text: string }) {
  return <div className="font-mono text-[11px] text-slate-400">{text}</div>;
}
