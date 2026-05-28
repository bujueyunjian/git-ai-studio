// QuickFixDialog:统一"陈述 → 确认 → 执行"骨架。
//
// 解决审查里 anti-pattern A(诊断/行动错位):后端有原子幂等命令,前端应在同页
// 直接执行,而不是"跳转到别的页让用户再点一次"。
//
// 三种典型场景共用此组件:
//   - Diagnostic 页"修复缺失 hooks" → installHooksOfficial
//   - Install 页"重新安装当前版本"   → installM(undefined)
//
// 关键设计:**先把"会改什么 / 会跳过什么"列出来再让用户点 confirm**。
// 不写降级/兜底——onConfirm 内的 promise reject 由调用方 onError 处理。
//
// 2026-05 升级(任务 #7):
//   - 新增 commands 区块,渲染 "$ <cmd>" + 中文解释 + Copy 按钮,用户碰到异常后可直接复制运行
//   - 新增 footer 上的 cta 按钮,点了跳到对应页面继续操作
//   - onConfirm 变为可选:某些条目(如 refs-notes-ai-stale)只用来"展示命令 + 跳转",
//     没有同页执行的动作,这时不渲染主按钮

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Copy,
  Loader2,
  MinusCircle,
  Terminal,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { Dialog } from "./ui/DialogShell";

export interface QuickFixSkipEntry {
  /** 被跳过的对象(例如 "Codex / Claude Code" / "端口 39393")。 */
  item: string;
  /** 跳过原因,要让用户一眼明白为什么不动它。 */
  reason: string;
}

/** 命令行单条:cmd 渲染为 mono `$ <cmd>`,comment 渲染在下方一行解释。 */
export interface QuickFixCommandEntry {
  cmd: string;
  comment: string;
}

/** Footer 的"前往修复"按钮配置。点了通常关闭对话框 + 调用 onNavigate。 */
export interface QuickFixCtaEntry {
  label: string;
  /** 由调用方决定跳哪 —— Dialog 自身不依赖 router,保持纯组件。 */
  onClick: () => void;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** 短描述,放在 title 下面,1-2 句解释这次修复要解决什么。 */
  description?: ReactNode;
  /** 即将执行的动作列表(可选)。为空且无 commands 时主按钮 disabled。 */
  willDo?: string[];
  /** 跳过项 + 原因,可选;为空时不渲染。 */
  willSkip?: QuickFixSkipEntry[];
  /** 命令列表(可选):每条 `$ cmd` + 中文解释 + Copy 按钮。 */
  commands?: QuickFixCommandEntry[];
  /** Footer 上的次要"前往修复"按钮(可选,例如跳 Hooks 页继续操作)。 */
  cta?: QuickFixCtaEntry;
  /** 主按钮文案,默认 "开始修复"。 */
  confirmLabel?: string;
  /** 危险动作(覆盖文件 / 杀进程 / 停 schtask),按钮变 rose 色。 */
  danger?: boolean;
  /**
   * 执行回调,返回 promise;期间 footer 显 loading。
   * 当只想用 Dialog 展示命令 + CTA 时,可传 undefined,主按钮不渲染。
   */
  onConfirm?: () => Promise<void> | void;
  /** 外部 mutation pending 态,优先级高于内部点击态。 */
  busy?: boolean;
  /** 可选自定义区,渲染在 willDo 上方。用于让调用方插入模式选择 / 端口输入等
   * 影响 willDo 内容的控件 —— willDo 仍由调用方根据当前选择实时计算。 */
  headerExtra?: ReactNode;
}

export function QuickFixDialog({
  open,
  onOpenChange,
  title,
  description,
  willDo,
  willSkip,
  commands,
  cta,
  confirmLabel = "开始修复",
  danger = false,
  onConfirm,
  busy = false,
  headerExtra,
}: Props) {
  const willDoList = willDo ?? [];
  const hasWillDo = willDoList.length > 0;
  const hasCommands = (commands?.length ?? 0) > 0;
  const hasOnConfirm = typeof onConfirm === "function";

  // 主按钮是否禁用:只有"有 confirm 回调"且"有可执行项"时才可点。
  // 仅展示命令的条目(commands 段)不应让主按钮亮着却点不动 —— 此时干脆不渲染主按钮。
  const renderConfirm = hasOnConfirm;
  const confirmDisabled = busy || (!hasWillDo && !hasCommands);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !busy && onOpenChange(v)}
      title={title}
      description={description}
      size="md"
      dismissible={!busy}
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:hover:bg-slate-800"
          >
            {renderConfirm ? "取消" : "关闭"}
          </button>
          {cta && (
            <button
              type="button"
              onClick={() => {
                cta.onClick();
                onOpenChange(false);
              }}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50 dark:border-primary/40 dark:text-primary dark:hover:bg-primary/15"
            >
              {cta.label}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
          {renderConfirm && (
            <button
              type="button"
              onClick={() => void onConfirm?.()}
              disabled={confirmDisabled}
              className={
                danger
                  ? "inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
                  : "inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              }
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {confirmLabel}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {headerExtra}

        {hasWillDo && (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">
              将执行{" "}
              <span className="text-emerald-600 dark:text-emerald-400">{willDoList.length}</span>{" "}
              项操作:
            </div>
            <ul className="space-y-1 rounded-md border border-emerald-200 bg-emerald-50/60 p-2 text-xs dark:border-emerald-900/40 dark:bg-emerald-950/20">
              {willDoList.map((d, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  <span>{d}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {hasCommands && (
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Terminal className="h-3.5 w-3.5" />
              建议在终端运行以下命令:
            </div>
            <ul className="space-y-2 rounded-md border border-border bg-card/60 p-2">
              {commands!.map((c, i) => (
                <CommandRow key={i} cmd={c.cmd} comment={c.comment} />
              ))}
            </ul>
          </div>
        )}

        {!hasWillDo && !hasCommands && !cta && (
          <p className="text-sm text-muted-foreground">当前没有需要修复的项。</p>
        )}

        {willSkip && willSkip.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">
              将跳过 {willSkip.length} 项:
            </div>
            <ul className="space-y-1 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs dark:border-border dark:bg-card/60">
              {willSkip.map((s, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <MinusCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <div>
                    <span className="font-medium">{s.item}</span>
                    <span className="text-muted-foreground"> — {s.reason}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {danger && (
          <div className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>此操作不可撤销,请确认后再继续。</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/**
 * 单条命令行 + 解释 + Copy 按钮。
 * - Copy 后短暂展示 ✓ 状态(2s)替代 toast,避免连续 copy 多行刷屏。
 * - 用 navigator.clipboard.writeText,Tauri 1.x 起 webview 支持(macOS/Windows/Linux 均测过)。
 */
function CommandRow({ cmd, comment }: { cmd: string; comment: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="space-y-1">
      <div className="flex items-start gap-1.5">
        <span className="select-none pt-0.5 font-mono text-xs text-muted-foreground">$</span>
        <code className="flex-1 break-all font-mono text-xs text-foreground">{cmd}</code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(cmd);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch (e) {
              // 剪贴板 API 在某些环境(无 https / 权限拒绝)会 reject,toast 提示用户手动复制
              toast.error("复制失败", { description: (e as Error).message });
            }
          }}
          title="复制此行命令"
          className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
        >
          {copied ? (
            <>
              <CheckCircle2 className="h-3 w-3 text-emerald-500" /> 已复制
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> 复制
            </>
          )}
        </button>
      </div>
      <div className="pl-3 text-[11px] text-muted-foreground">{comment}</div>
    </li>
  );
}
