//! git-ai daemon 进程健康探测。
//!
//! # 上游真源
//! - daemon 路径与锁:`git-ai/src/daemon.rs:170-205` (`DaemonConfig::from_internal_dir`,
//!   Windows 下 `lock_path = ~/.git-ai/internal/daemon/daemon.lock`)
//! - PID 元信息:`git-ai/src/daemon.rs:289-293` (`DaemonPidMeta { pid, started_at_ns }`)
//!   ,文件名 `daemon.pid.json`(同目录)
//! - 报错来源:`git-ai/src/commands/daemon.rs:109-113`
//!   `daemon startup blocked: lock held at <lock_path>` —— socket 不通且锁拿不到时触发,
//!   典型成因是 daemon 进程已死但 OS 文件锁未释放(僵尸 lock),client 命令(`git-ai checkpoint` 等)
//!   会被持续阻塞,hook PostToolUse 报错。
//!
//! # 判定口径
//! - lock 文件不存在 → [`DaemonHealth::Idle`](正常空闲;客户端首次调用会拉起 daemon)
//! - lock 文件存在 + pid.json 中的 PID 进程存活 → [`DaemonHealth::Running`]
//! - lock 文件存在但 PID 不存活 / pid.json 缺失/损坏 → [`DaemonHealth::StaleLock`]
//!
//! # 进程存活探测
//! - Windows: `tasklist /FI "PID eq <pid>" /NH /FO CSV`,stdout 含 `"<pid>"` 即存活
//! - 其它: `kill -0 <pid>`(POSIX 信号 0 不发送任何信号,仅做存在性检查)

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DaemonHealth {
    /// 没有 daemon 在跑(无 lock 文件)。客户端命令首次调用会自动拉起,无需用户介入。
    Idle,
    /// daemon 正常运行(lock 在 + PID 存活)。
    Running { pid: u32 },
    /// 僵尸 lock:lock 文件还在,但记录的 PID 已经不存活(或 pid.json 缺失/损坏)。
    /// 用户必须手动清理 `lock_path` 与 `pid_meta_path`,否则 `git-ai checkpoint` 会一直
    /// 报 "daemon startup blocked: lock held at ..." 阻塞所有 hook。
    StaleLock {
        lock_path: String,
        pid_meta_path: String,
        last_pid: Option<u32>,
    },
    /// lock 仍被某个进程持有,但 pid metadata 缺失/损坏或记录的 PID 已不可用。
    /// 这种状态下直接删除 daemon.lock 会在 Windows 上失败,必须先定位/结束持锁的 git-ai.exe。
    BlockedLockUnknownPid {
        lock_path: String,
        pid_meta_path: String,
        last_pid: Option<u32>,
        candidate_pids: Vec<u32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonRepairResult {
    pub before: DaemonHealth,
    pub after: DaemonHealth,
    pub killed_pids: Vec<u32>,
    pub removed_paths: Vec<String>,
}

/// 异步探测 git-ai daemon 健康状态。整体应在 ~400ms 内返回(2 次 pid.json 读 + 至多 2 次 tasklist)。
///
/// # 重读防抖(规避 daemon 重启竞态)
/// 系统启动 / `git-ai daemon restart` 后存在一个短窗口:旧 PID 已死、新 daemon 进程正在启动、
/// `daemon.pid.json` 尚未被新 PID 覆盖。此时只看一眼 pid.json 会把 last_pid 判为失活,
/// 误报 `StaleLock`;而几秒后 daemon 写入新 pid.json,`repair_daemon_lock` 又会拿到
/// `Running`,与告警自相矛盾。
///
/// 修复:第一次失活后 `sleep 300ms` 再重读 pid.json,任一次拿到活 PID 即返 `Running`。
/// 仍想进一步降噪由前端 watcher 用"连续 N 次告警"门槛兜底。
pub async fn detect_daemon_health() -> DaemonHealth {
    let lock_path = paths::git_ai_daemon_lock_path();
    if !lock_path.exists() {
        return DaemonHealth::Idle;
    }
    let pid_path = paths::git_ai_daemon_pid_meta_path();

    let first_pid = read_pid_from_meta(&pid_path);
    if let Some(pid) = first_pid {
        if process_alive(pid).await {
            return DaemonHealth::Running { pid };
        }
    }

    // 第一次判失活 → 等 300ms 让 daemon 重启窗口期写完 pid.json,再读一次确认。
    tokio::time::sleep(Duration::from_millis(300)).await;
    let second_pid = read_pid_from_meta(&pid_path);
    if let Some(pid) = second_pid {
        if process_alive(pid).await {
            return DaemonHealth::Running { pid };
        }
    }
    let last_pid = second_pid.or(first_pid);

    if daemon_lock_is_held(&lock_path) {
        DaemonHealth::BlockedLockUnknownPid {
            lock_path: lock_path.display().to_string(),
            pid_meta_path: pid_path.display().to_string(),
            last_pid,
            candidate_pids: find_git_ai_process_pids().await,
        }
    } else {
        DaemonHealth::StaleLock {
            lock_path: lock_path.display().to_string(),
            pid_meta_path: pid_path.display().to_string(),
            last_pid,
        }
    }
}

/// 修复僵尸 daemon lock。
///
/// # 自愈识别
/// 用户在告警 OS 通知 / UI 提示和点击「修复」之间通常有数秒到几分钟的延迟,daemon 本身
/// 可能已经被 schtasks ONLOGON / 客户端命令重新拉起。这两种"已自愈"状态都返
/// `Ok(no-op)` 让前端展示"无需处理 / 已恢复",而不是用 `Err` 触发"修复失败"通知,
/// 那会让用户看到"修复失败"以为出了大问题(详见 task #7 bug)。
///
/// - `before = Idle`:lock 已被自动清理(daemon 退出或别的客户端清掉) → no-op Ok
/// - `before = Running`:daemon 已经写入新 pid.json 在跑 → no-op Ok
/// - `before = StaleLock`:正常清理
/// - `before = BlockedLockUnknownPid`:杀候选 PID 后清理
pub async fn repair_daemon_lock() -> Result<DaemonRepairResult, String> {
    let before = detect_daemon_health().await;
    let mut killed_pids = Vec::new();
    match &before {
        DaemonHealth::StaleLock { .. } => {}
        DaemonHealth::BlockedLockUnknownPid {
            last_pid,
            candidate_pids,
            ..
        } => {
            let mut pids = Vec::new();
            if let Some(pid) = last_pid {
                pids.push(*pid);
            }
            for pid in candidate_pids {
                if !pids.contains(pid) {
                    pids.push(*pid);
                }
            }
            if pids.is_empty() {
                return Err("lock 仍被占用,但没有发现明确的 git-ai 进程 PID;请先在任务管理器中结束 git-ai.exe 后重试".to_string());
            }
            for pid in pids {
                kill_process(pid).await?;
                killed_pids.push(pid);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        DaemonHealth::Idle | DaemonHealth::Running { .. } => {
            // 已自愈:lock 已消失 / daemon 已重新启动并占住 lock。返 Ok no-op,前端按
            // before == after && killed_pids.is_empty() && removed_paths.is_empty()
            // 判定"无需修复 / 已恢复",不当作 error 推通知。
            return Ok(DaemonRepairResult {
                before: before.clone(),
                after: before,
                killed_pids: vec![],
                removed_paths: vec![],
            });
        }
    }

    let removed_paths = remove_daemon_runtime_files()?;
    let after = detect_daemon_health().await;
    Ok(DaemonRepairResult {
        before,
        after,
        killed_pids,
        removed_paths,
    })
}

#[cfg(target_os = "windows")]
fn daemon_lock_is_held(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;

    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .share_mode(0)
        .open(path)
        .is_err()
}

#[cfg(not(target_os = "windows"))]
fn daemon_lock_is_held(_path: &Path) -> bool {
    false
}

fn read_pid_from_meta(p: &PathBuf) -> Option<u32> {
    let raw = std::fs::read_to_string(p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("pid")?.as_u64().map(|n| n as u32)
}

#[cfg(target_os = "windows")]
async fn process_alive(pid: u32) -> bool {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]);
    crate::proc::apply_no_window_tokio(&mut cmd);
    let out = cmd.output().await;
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            // CSV 格式存活行形如 `"foo.exe","12345","Console","1","..."`;PID 不存在时
            // tasklist 输出 `INFO: No tasks ...` 到 stdout,不会包含被引号包裹的 PID。
            s.contains(&format!("\"{pid}\""))
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "windows")]
async fn find_git_ai_process_pids() -> Vec<u32> {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", "IMAGENAME eq git-ai.exe", "/NH", "/FO", "CSV"]);
    crate::proc::apply_no_window_tokio(&mut cmd);
    let out = cmd.output().await;
    let Ok(o) = out else {
        return Vec::new();
    };
    let s = String::from_utf8_lossy(&o.stdout);
    s.lines()
        .filter_map(|line| parse_tasklist_csv_pid(line))
        .collect()
}

#[cfg(not(target_os = "windows"))]
async fn find_git_ai_process_pids() -> Vec<u32> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn parse_tasklist_csv_pid(line: &str) -> Option<u32> {
    let mut cols = line.split("\",\"");
    let name = cols.next()?.trim_matches('"');
    let pid = cols.next()?.trim_matches('"');
    if !name.eq_ignore_ascii_case("git-ai.exe") {
        return None;
    }
    pid.parse::<u32>().ok()
}

fn remove_daemon_runtime_files() -> Result<Vec<String>, String> {
    let paths = [
        paths::git_ai_daemon_lock_path(),
        paths::git_ai_daemon_pid_meta_path(),
    ];
    let mut removed = Vec::new();
    for path in paths {
        if !path.exists() {
            continue;
        }
        std::fs::remove_file(&path).map_err(|e| format!("删除 {} 失败: {e}", path.display()))?;
        removed.push(path.display().to_string());
    }
    Ok(removed)
}

#[cfg(target_os = "windows")]
async fn kill_process(pid: u32) -> Result<(), String> {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
    crate::proc::apply_no_window_tokio(&mut cmd);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("结束 git-ai.exe PID {pid} 失败: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(format!(
            "结束 git-ai.exe PID {pid} 失败: {}{}",
            stdout.trim(),
            stderr.trim()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
async fn kill_process(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .await
        .map_err(|e| format!("结束 git-ai PID {pid} 失败: {e}"))?;
    if !status.success() {
        return Err(format!("结束 git-ai PID {pid} 失败"));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
async fn process_alive(pid: u32) -> bool {
    let status = Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .await;
    status.map(|s| s.success()).unwrap_or(false)
}
