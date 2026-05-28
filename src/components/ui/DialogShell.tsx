import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  /**
   * `false` 时禁掉 ESC / 点击遮罩 / 右上角 X,用户只能点 footer 按钮才能关。
   * 用于"必现强提示"(如安装后的重启 agent / 重开终端)。
   */
  dismissible?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
}: Props) {
  // xl 用于代码 / JSON 原文这类需要充分宽度的内容(git-ai show、stats raw);
  // full 几乎占满视口,留 32px gutter(blame 等"看完整文件"场景)。
  const w = {
    sm: "max-w-sm",
    md: "max-w-lg",
    lg: "max-w-2xl",
    xl: "max-w-5xl",
    full: "max-w-[calc(100vw-4rem)]",
  }[size];
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <D.Content
          onEscapeKeyDown={(e) => {
            if (!dismissible) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (!dismissible) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (!dismissible) e.preventDefault();
          }}
          className={`fixed left-1/2 top-1/2 z-50 ${w} -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-200 bg-white p-5 shadow-xl dark:border-border dark:bg-card`}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description && (
                <D.Description className="mt-1 text-sm text-slate-500">{description}</D.Description>
              )}
            </div>
            {dismissible && (
              <D.Close className="rounded-md p-1 text-slate-500 hover:bg-accent">
                <X className="h-4 w-4" />
              </D.Close>
            )}
          </div>
          {children && <div className="mt-4 text-sm">{children}</div>}
          {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
