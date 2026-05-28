/**
 * OS 原生通知统一出口。
 *
 * # 设计
 * - macOS → 通知中心(NSUserNotification)
 * - Linux → libnotify(需要 desktop session 提供 dbus)
 * - Windows → toast(Action Center)
 * 三者由 `@tauri-apps/plugin-notification` 抽象,前端只需调 `notify(title, body)`。
 *
 * # 权限懒授权
 * 浏览器规范:必须用户手势态触发首次 `requestPermission()` 才弹系统授权弹窗。
 * Watcher 在后台触发的通知如果尚未授权,本次会被静默吞掉,并把"已请求过"标志写到
 * module-level 单例;下一次再触发时直接读 `isPermissionGranted()` 即可。
 * 用户没授权不是致命错误 —— 应用主体功能仍可用,只是看不到 OS 通知。
 *
 * # 主窗口聚焦
 * macOS / Windows 点通知会自动让目标 app 取得焦点,但是从隐藏 / 最小化 / 托盘
 * 状态唤起主窗口在 tauri 2 里需要前端显式调用 `show + unminimize + setFocus`。
 * 这里不监听通知 click 事件(plugin 暂未稳定暴露 web-side click 回调),
 * 用户从托盘菜单或 dock 进入即可恢复;watcher 触发通知后立即调用 `focusMainWindow()`
 * 把主窗口拉到前台,避免 LowAiShare / Daemon 告警一弹用户却找不到窗口。
 */

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * 进程内权限缓存:首次查询后整个会话复用,避免每次告警都走 IPC。
 * 用户在 OS 系统设置里改授权状态会需要重启应用才被识别,这是 OS 通知规范的
 * 常见行为(浏览器、Slack 等都如此),不专门处理。
 */
let cachedPermission: boolean | null = null;

/**
 * 确保已拿到通知权限。
 * - 已授权:直接返 true。
 * - 未授权且尚未请求:发起一次 `requestPermission()`(权限弹窗会出现在前台窗口)。
 * - 用户拒绝或弹窗被忽略:返 false,本次告警吞掉。
 */
async function ensurePermission(): Promise<boolean> {
  if (cachedPermission !== null) return cachedPermission;
  try {
    const granted = await isPermissionGranted();
    if (granted) {
      cachedPermission = true;
      return true;
    }
    const result = await requestPermission();
    cachedPermission = result === "granted";
    return cachedPermission;
  } catch {
    // dbus 不存在 / OS 接口异常 → 视为不可用,避免后续重复抛异常打断 watcher 副作用
    cachedPermission = false;
    return false;
  }
}

/**
 * 把主窗口从隐藏 / 最小化 / 托盘态恢复并聚焦。失败静默(窗口可能已经被销毁、
 * 单元测试环境无 tauri runtime),不应中断 watcher 主流程。
 */
export async function focusMainWindow(): Promise<void> {
  try {
    const w = getCurrentWebviewWindow();
    await w.show();
    await w.unminimize();
    await w.setFocus();
  } catch {
    // 测试环境 / 无 webview 时安静忽略
  }
}

/**
 * 发送一条 OS 通知。无权限时整体 no-op(不抛异常),让 watcher 调用方不必包 try/catch。
 *
 * @param title 通知标题(macOS 加粗第一行)
 * @param body 通知正文(支持多行,Windows toast 自动换行)
 */
export async function notify(title: string, body: string): Promise<void> {
  const granted = await ensurePermission();
  if (!granted) return;
  try {
    sendNotification({ title, body });
  } catch {
    // OS 通知子系统异常不应让 watcher 链路炸,例如 Linux 缺 dbus 时
  }
}
