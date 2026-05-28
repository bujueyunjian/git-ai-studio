// 报表系统共用卡片组件。
//
// # 设计目标
// 1. 视觉对齐 cc-switch(cc-switch/src\components\ui\card.tsx),
//    但弃用 shadow-sm —— 改用细微 ring 在深色下更柔和(避免 box-shadow 在
//    cc-switch 风格的偏暖暗色面上拉出灰色"脏边")。
// 2. 完全走 CSS 变量语义类(bg-card / border-border / text-foreground 等),
//    不写 `bg-white dark:bg-slate-900` 这类硬编码 dark variant。
// 3. 支持 hover 时 border 高亮(`hover:border-primary/40`),给指标卡 / 表格卡
//    提供"可点 / 可关注"的轻量视觉反馈。
//
// # 与 cc-switch 的差异
// - 我方不暴露 CardTitle / CardDescription(报表场景标题在 Header 里单独处理,
//   避免双重间距);取而代之是 `title` / `icon` / `actions` 三 props 走快路径。
// - padding 用 "sm" | "md" | "lg" 离散档,匹配本项目密集表格(sm)与图表卡(md)
//   两种节奏,而非 cc-switch 的固定 p-6。

import * as React from "react";

import { cn } from "../../lib/cn";

/** 内容区 padding 档:对应 p-3 / p-4 / p-6。none 用于自行控制内边距(如 PeopleTable 整张表)。 */
type CardPadding = "none" | "sm" | "md" | "lg";

const PADDING_CLASS: Record<CardPadding, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

// Omit 原生 HTMLDivElement.title:那个属性签名是 string(浏览器 tooltip),
// 与本组件 ReactNode 标题语义冲突 —— 我们让 `title` 接管这个名字
export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** 可选标题文本;给了就渲染内置 CardHeader。 */
  title?: React.ReactNode;
  /** 标题左侧 lucide icon 节点。 */
  icon?: React.ReactNode;
  /** 标题右侧操作区(按钮 / 标签 / FormulaPopover)。 */
  actions?: React.ReactNode;
  /** 内容区内边距档。none 表示完全交给调用方自己包 padding。 */
  padding?: CardPadding;
  /** 鼠标悬浮时高亮 border(用于可点卡或希望强调互动的卡)。 */
  interactive?: boolean;
}

/**
 * 通用卡片容器。给 title 就自动出 CardHeader + CardBody 两段;不给就裸渲染 children。
 *
 * 默认样式:`rounded-xl border bg-card`,细微 ring 替代 shadow。
 * interactive=true 时 hover 边框转 `border-primary/40`(150ms transition)。
 */
export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, title, icon, actions, padding = "md", interactive, children, ...rest }, ref) => {
    const hasHeader = title !== undefined || icon !== undefined || actions !== undefined;
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-xl border border-border bg-card text-card-foreground",
          // 细 ring 替代 shadow-sm:深色面上不会留灰边
          "ring-1 ring-border/40",
          interactive && "transition-colors duration-150 hover:border-primary/40",
          className,
        )}
        {...rest}
      >
        {hasHeader ? (
          <>
            <CardHeader>
              <div className="flex items-center gap-2 min-w-0">
                {icon}
                {title !== undefined && (
                  <div className="text-sm font-semibold text-foreground truncate">{title}</div>
                )}
              </div>
              {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
            </CardHeader>
            <CardBody padding={padding}>{children}</CardBody>
          </>
        ) : (
          // 无 header:children 与 padding 直接挂在卡片根上,避免嵌套两层 div
          <div className={cn(PADDING_CLASS[padding])}>{children}</div>
        )}
      </div>
    );
  },
);
Card.displayName = "Card";

/**
 * 卡片顶部 header 行:左标题 + 右操作,padding 与 body 解耦。
 * 调用方也可单独 import,在 Card 外组合(适合自定义 header 布局)。
 */
export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5",
        className,
      )}
      {...rest}
    />
  ),
);
CardHeader.displayName = "CardHeader";

/** 卡片内容区:接受 padding 档,默认 md(p-4)。 */
export const CardBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { padding?: CardPadding }
>(({ className, padding = "md", ...rest }, ref) => (
  <div ref={ref} className={cn(PADDING_CLASS[padding], className)} {...rest} />
));
CardBody.displayName = "CardBody";

/** 卡片底部行(可选):带顶部分割线。 */
export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5",
        className,
      )}
      {...rest}
    />
  ),
);
CardFooter.displayName = "CardFooter";
