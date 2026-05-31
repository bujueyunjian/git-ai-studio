import { Activity } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "./EmptyState";
import type { BlameDegradedReason } from "../lib/types";
import { useRouter } from "../router";

/**
 * 逐行归因的硬故障空态:按 `reason.kind` 逐一给专用文案 + CTA,
 * 不塌缩成一句泛化"无法显示"。从原 Blame 页 FileDegraded 抽出,
 * 提交归因(Stats)弹窗承接深链(可能落到不存在的 file/sha)失败时复用 —— 响亮失败。
 */
export function FileDegradedCard({ reason }: { reason: BlameDegradedReason }) {
  const { t } = useTranslation();
  const router = useRouter();
  let title = t("blame.fileDegradedFallbackTitle");
  let description = "";
  let ctaLabel: string | undefined;
  let onCta: (() => void) | undefined;
  switch (reason.kind) {
    case "repo_missing": {
      title = t("blame.degraded.repoMissing.title");
      description = t("blame.degraded.repoMissing.description");
      ctaLabel = t("blame.degraded.repoMissing.cta");
      onCta = () => router.navigate("repo");
      break;
    }
    case "git_ai_missing": {
      title = t("blame.degraded.gitAiMissing.title");
      description = t("blame.degraded.gitAiMissing.description");
      ctaLabel = t("blame.degraded.gitAiMissing.cta");
      onCta = () => router.navigate("install");
      break;
    }
    case "no_head": {
      title = t("blame.degraded.noHead.title");
      description = t("blame.degraded.noHead.description");
      break;
    }
    case "commit_not_found": {
      title = t("blame.degraded.commitNotFound.title");
      description = t("blame.degraded.commitNotFound.descriptionTemplate", { sha: reason.sha });
      break;
    }
    case "file_not_in_head": {
      title = t("blame.degraded.fileNotInHead.title");
      description = t("blame.degraded.fileNotInHead.descriptionTemplate", { file: reason.file });
      break;
    }
    case "file_too_large": {
      title = t("blame.degraded.fileTooLarge.title");
      description = t("blame.degraded.fileTooLarge.descriptionTemplate", {
        sizeKb: (reason.size / 1024).toFixed(1),
        limitKb: (reason.limit / 1024).toFixed(0),
      });
      break;
    }
    case "file_binary": {
      title = t("blame.degraded.fileBinary.title");
      description = t("blame.degraded.fileBinary.description");
      break;
    }
    case "ref_not_found": {
      title = t("blame.refPicker.refNotFoundTitle");
      description = t("blame.refPicker.refNotFoundTemplate", { r: reason.ref });
      break;
    }
  }
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <EmptyState
        Icon={Activity}
        title={title}
        description={description}
        ctaLabel={ctaLabel}
        onCta={onCta}
      />
    </div>
  );
}
