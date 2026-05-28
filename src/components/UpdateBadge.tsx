import { ArrowUpCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useUpdate } from "../contexts/UpdateContext";
import { Button } from "./ui/button";

interface UpdateBadgeProps {
  className?: string;
  onClick?: () => void;
}

/** 顶栏更新徽章:仅在检测到新版本时渲染一个绿色箭头图标,点击跳转设置页查看 / 安装更新。 */
export function UpdateBadge({ className = "", onClick }: UpdateBadgeProps) {
  const { hasUpdate, updateInfo } = useUpdate();
  const { t } = useTranslation();
  const isActive = hasUpdate && updateInfo;

  if (!isActive) {
    return null;
  }

  const title = t("update.available", {
    version: updateInfo?.availableVersion ?? "",
  });

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`relative h-8 w-8 rounded-full text-green-600 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-500/10 ${className}`}
    >
      <ArrowUpCircle className="h-5 w-5" />
    </Button>
  );
}
