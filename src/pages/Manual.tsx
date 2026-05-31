// 用户手册页:3 Tab 给用户一处集中查阅 git-ai 命令、指标口径与排错。
//
// # Tab 划分
// 1. 命令 — git-ai 常用命令(对齐官方 README 与本工具实际调用)
// 2. 指标 — 指标口径,定义直接复用 formulas.ts 的 METRICS(与 提交归因 / 作者归因 同源)
// 3. 排查 — 常见问题排查,含可复制的 git 命令块
//
// # 设计要点
// - 全程只读 + 纯文本,无截图依赖
// - Tab 状态走 useState,不入 URL(对齐其它单页惯例)
// - eager import(内容轻量,无重型依赖)
// - 文案走 i18n:命令 / 排查列表用 t(key, { returnObjects }) 取结构化数组;
//   指标定义复用 formulas.ts 的 METRICS,口径与上游 git-ai stats.rs 对齐(见 formulas.ts 头注)

import { BookOpen, Check, Copy as CopyIcon, Gauge, Terminal, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Card } from "../components/ui/card";
import { METRICS, type FormulaToken, type MetricId } from "../lib/formulas";

type TabId = "commands" | "metrics" | "troubleshooting";

const TABS: { id: TabId; labelKey: string; icon: LucideIcon }[] = [
  { id: "commands", labelKey: "manual.tabs.commands", icon: Terminal },
  { id: "metrics", labelKey: "manual.tabs.metrics", icon: Gauge },
  { id: "troubleshooting", labelKey: "manual.tabs.troubleshooting", icon: Wrench },
];

/** 命令条目:i18n manual.commands.items 的元素形态。 */
interface CommandItem {
  cmd: string;
  desc: string;
  example: string;
}

/** 排查 FAQ 段落:text 渲染为段落,cmd 渲染为带复制按钮的代码块 + 一句话 caption。 */
type FaqSegment = { kind: "text"; text: string } | { kind: "cmd"; cmd: string; caption?: string };

/** 排查条目:i18n manual.troubleshooting.items 的元素形态。 */
interface FaqItem {
  q: string;
  a: FaqSegment[];
}

/** FormulaToken[] → 纯文本:metric token 取其指标 title,text token 原样拼接。 */
function formulaText(tokens: FormulaToken[]): string {
  return tokens.map((tok) => (tok.kind === "metric" ? METRICS[tok.id].title : tok.text)).join("");
}

export default function ManualPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>("commands");

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <BookOpen className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          {t("manual.page.title")}
        </h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("manual.page.subtitle")}</p>
      </div>

      <div className="flex gap-1 border-b border-border" role="tablist">
        {TABS.map((it) => {
          const active = it.id === tab;
          const Icon = it.icon;
          return (
            <button
              key={it.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(it.id)}
              className={
                active
                  ? "inline-flex items-center gap-1.5 border-b-2 border-blue-600 px-3 py-2 text-sm font-medium text-blue-700 dark:text-blue-300"
                  : "inline-flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-slate-500 hover:text-foreground"
              }
            >
              <Icon className="h-3.5 w-3.5" />
              {t(it.labelKey as never)}
            </button>
          );
        })}
      </div>

      {tab === "commands" && <CommandsTab />}
      {tab === "metrics" && <MetricsTab />}
      {tab === "troubleshooting" && <TroubleshootingTab />}
    </div>
  );
}

function CommandsTab() {
  const { t } = useTranslation();
  const items = t("manual.commands.items", { returnObjects: true }) as CommandItem[];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("manual.commands.hint")}</p>
      {items.map((c) => (
        <Card key={c.cmd} className="gap-2 px-4 py-3">
          <div className="font-mono text-sm font-semibold text-foreground">{c.cmd}</div>
          <p className="text-xs text-muted-foreground">{c.desc}</p>
          <pre className="overflow-x-auto rounded bg-slate-950 p-2.5 font-mono text-[11px] leading-relaxed text-slate-200">
            {c.example}
          </pre>
        </Card>
      ))}
    </div>
  );
}

function MetricsTab() {
  const { t } = useTranslation();
  const ids = Object.keys(METRICS) as MetricId[];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("manual.metrics.hint")}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {ids.map((id) => {
          const meta = METRICS[id];
          return (
            <Card key={id} className="gap-2 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-foreground">{meta.title}</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {meta.kind === "raw"
                    ? t("manual.metrics.kindRaw")
                    : t("manual.metrics.kindDerived")}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{meta.definition}</p>
              <div className="rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-600 dark:bg-background dark:text-slate-300">
                {formulaText(meta.formula)}
              </div>
              {meta.example && (
                <p className="text-[11px] leading-relaxed text-slate-500">
                  {t("manual.metrics.examplePrefix")}
                  {meta.example}
                </p>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function TroubleshootingTab() {
  const { t } = useTranslation();
  const items = t("manual.troubleshooting.items", { returnObjects: true }) as FaqItem[];
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <Card key={item.q} className="gap-2 px-4 py-3">
          <div className="text-sm font-semibold text-foreground">{item.q}</div>
          <div className="space-y-2">
            {item.a.map((seg, idx) =>
              seg.kind === "text" ? (
                <p key={idx} className="text-xs leading-relaxed text-muted-foreground">
                  {seg.text}
                </p>
              ) : (
                <FaqCommand key={idx} cmd={seg.cmd} caption={seg.caption} />
              ),
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

/** 单条命令的代码块 + 复制按钮 + caption。 */
function FaqCommand({ cmd, caption }: { cmd: string; caption?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="relative overflow-hidden rounded border border-border bg-slate-950 dark:bg-background">
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 px-2.5 py-1 text-[10px] text-slate-400 dark:bg-card/40">
          <span className="font-mono">Bash</span>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(cmd);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              } catch {
                // 复制失败静默处理:Tauri webview 一般不会失败
              }
            }}
            aria-label={t("manual.copy.aria")}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-300 hover:bg-slate-800/60"
          >
            {copied ? <Check className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
            {copied ? t("manual.copy.done") : t("manual.copy.label")}
          </button>
        </div>
        <pre className="overflow-x-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed text-slate-100">
          {cmd}
        </pre>
      </div>
      {caption && <p className="text-[11px] leading-relaxed text-slate-500">{caption}</p>}
    </div>
  );
}
