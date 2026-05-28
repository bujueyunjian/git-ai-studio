import { getVersion } from "@tauri-apps/api/app";

// 仅取类型:运行时按需动态 import 插件,避免在未注册插件 / 非 Tauri 环境下构建期出错。
import type { Update } from "@tauri-apps/plugin-updater";

export type UpdateChannel = "stable" | "beta";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "restarting"
  | "upToDate"
  | "error";

export interface UpdateInfo {
  currentVersion: string;
  availableVersion: string;
  notes?: string;
  pubDate?: string;
}

export interface UpdateProgressEvent {
  event: "Started" | "Progress" | "Finished";
  total?: number;
  downloaded?: number;
}

export interface UpdateHandle {
  version: string;
  notes?: string;
  date?: string;
  downloadAndInstall: (onProgress?: (e: UpdateProgressEvent) => void) => Promise<void>;
  download?: () => Promise<void>;
  install?: () => Promise<void>;
}

export interface CheckOptions {
  timeout?: number;
  channel?: UpdateChannel;
}

/** 把插件返回的原始 Update 句柄包成 UI 友好的 UpdateHandle,下载进度统一为 UpdateProgressEvent。 */
function mapUpdateHandle(raw: Update): UpdateHandle {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    version: (raw as any).version ?? "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    notes: (raw as any).notes,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    date: (raw as any).date,
    async downloadAndInstall(onProgress?: (e: UpdateProgressEvent) => void) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (raw as any).downloadAndInstall((evt: any) => {
        if (!onProgress) return;
        const mapped: UpdateProgressEvent = {
          event: evt?.event,
        };
        if (evt?.event === "Started") {
          mapped.total = evt?.data?.contentLength ?? 0;
          mapped.downloaded = 0;
        } else if (evt?.event === "Progress") {
          mapped.downloaded = evt?.data?.chunkLength ?? 0; // 累积由调用方完成
        }
        onProgress(mapped);
      });
    },
    // 透传可选 API(若插件版本支持)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    download: (raw as any).download
      ? async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (raw as any).download();
        }
      : undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    install: (raw as any).install
      ? async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (raw as any).install();
        }
      : undefined,
  };
}

/** 读取当前应用版本;非 Tauri 环境下安全降级为空串。 */
export async function getCurrentVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}

/** 检查更新。endpoint / pubkey 由后端 tauri.conf 管理,前端不感知。 */
export async function checkForUpdate(
  opts: CheckOptions = {},
): Promise<
  { status: "up-to-date" } | { status: "available"; info: UpdateInfo; update: UpdateHandle }
> {
  // 动态引入,避免在未安装插件时导致打包期问题
  const { check } = await import("@tauri-apps/plugin-updater");

  const currentVersion = await getCurrentVersion();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update = await check({ timeout: opts.timeout ?? 30000 } as any);

  if (!update) {
    return { status: "up-to-date" };
  }

  const mapped = mapUpdateHandle(update);
  const info: UpdateInfo = {
    currentVersion,
    availableVersion: mapped.version,
    notes: mapped.notes,
    pubDate: mapped.date,
  };

  return { status: "available", info, update: mapped };
}

/** 安装完成后重启应用,使新版本生效。 */
export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
