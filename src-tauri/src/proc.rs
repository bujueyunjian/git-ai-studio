//! 跨平台子进程封装:统一超时、Windows 隐藏窗口、UTF-8 输出收集、流式回调。

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::error::{AppError, Result};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 给 **std** `Command` 打 Windows `CREATE_NO_WINDOW` flag,避免 release 下子进程
/// 弹一闪而过的黑色控制台。tokio::process::Command 不需要 trait 直接有 `creation_flags`;
/// 但 std 版本必须经 `CommandExt` 引入。这里集中暴露给非 proc.rs 的 spawn 点
/// (`repo/head.rs` git、`hooks/server/status.rs` schtasks、`commands/*` explorer 等)。
#[cfg(windows)]
pub fn apply_no_window_std(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn apply_no_window_std(_cmd: &mut std::process::Command) {}

/// `apply_no_window_std` 的 tokio 版:`tokio::process::Command` 在 Windows 上直接有
/// `creation_flags`(无需 `CommandExt` trait),但仍需显式打 `CREATE_NO_WINDOW`,否则
/// release 下子进程会弹一闪而过的黑色控制台。集中暴露给不走 `proc.rs` 通道、直接
/// 用 tokio 起进程的 spawn 点(`git_ai/daemon.rs` tasklist、`cc_switch_watcher.rs`
/// git-ai install 等)。
#[cfg(windows)]
pub fn apply_no_window_tokio(cmd: &mut tokio::process::Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn apply_no_window_tokio(_cmd: &mut tokio::process::Command) {}

pub struct CaptureOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

/// 一次性命令(短时间任务,15s 内完成),返回完整 stdout/stderr。
pub async fn run_capture(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
) -> Result<CaptureOutput> {
    run_capture_with_timeout(program, args, cwd, Duration::from_secs(15)).await
}

pub async fn run_capture_with_timeout(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<CaptureOutput> {
    run_capture_internal(program, args, cwd, None, &[], timeout).await
}

/// 同 run_capture_with_timeout,但额外向子进程注入 env(键值覆盖继承环境)。用于把
/// `env_path` 的真实 PATH 镜像传给探测子进程(如 `claude --version` 的
/// `#!/usr/bin/env node` shebang 需要 node 在 PATH),不依赖全局 set_var。
pub async fn run_capture_with_env_timeout(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    env: &[(String, String)],
    timeout: Duration,
) -> Result<CaptureOutput> {
    run_capture_internal(program, args, cwd, None, env, timeout).await
}

/// 同 run_capture_with_timeout,但允许向子进程 stdin 一次性写入 `stdin_input` 然后关闭。
/// 用于 `git cat-file --batch-check` 这类"逐行 stdin"批查询接口。
pub async fn run_capture_with_stdin(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    stdin_input: &str,
    timeout: Duration,
) -> Result<CaptureOutput> {
    run_capture_internal(program, args, cwd, Some(stdin_input), &[], timeout).await
}

async fn run_capture_internal(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    stdin_input: Option<&str>,
    env: &[(String, String)],
    timeout: Duration,
) -> Result<CaptureOutput> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(if stdin_input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    // git/git-ai stderr 英文化(评审 P6 #33 全局 hardening):中文 locale 下
    // git 错误信息会本地化(如"致命错误"代替"fatal: ..."),让我们的 stderr 关键词
    // 匹配(`is_missing_notes_ref` / `is_empty_repo_stderr` 等)漂移。统一 LC_ALL=C。
    // 注意:不影响 commit subject / file content 等用户数据(它们走 stdout,且 git 不本地化数据)。
    cmd.env("LC_ALL", "C").env("LANG", "C");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(AppError::Io)?;
    if let Some(input) = stdin_input {
        use tokio::io::AsyncWriteExt;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Other("无法获取 stdin".to_string()))?;
        stdin
            .write_all(input.as_bytes())
            .await
            .map_err(AppError::Io)?;
        stdin.shutdown().await.map_err(AppError::Io)?;
        drop(stdin);
    }
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r.map_err(AppError::Io)?,
        Err(_) => {
            return Err(AppError::Other(format!(
                "command timed out after {}s: {}",
                timeout.as_secs(),
                program.display()
            )));
        }
    };

    Ok(CaptureOutput {
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// 长时任务:以 Tauri event 流式回传 stdout/stderr,每行一次 emit。
/// `event_topic` 形如 `"install://<job_id>/log"`,前端订阅。
/// payload:`{ "stream": "stdout"|"stderr"|"exit", "line"?: string, "code"?: number, "ts": number }`
pub async fn run_streaming(
    app: &AppHandle,
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    env: &[(String, String)],
    event_topic: &str,
    timeout: Duration,
) -> Result<i32> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(AppError::Io)?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("无法获取子进程 stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Other("无法获取子进程 stderr".to_string()))?;

    let app_out = app.clone();
    let topic_out = event_topic.to_string();
    let h_out = tokio::spawn(async move {
        let mut r = BufReader::new(stdout).lines();
        while let Ok(Some(l)) = r.next_line().await {
            let _ = app_out.emit(
                &topic_out,
                serde_json::json!({"stream":"stdout","line":l,"ts": now_ms()}),
            );
        }
    });
    let app_err = app.clone();
    let topic_err = event_topic.to_string();
    let h_err = tokio::spawn(async move {
        let mut r = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = r.next_line().await {
            let _ = app_err.emit(
                &topic_err,
                serde_json::json!({"stream":"stderr","line":l,"ts": now_ms()}),
            );
        }
    });

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(s) => s.map_err(AppError::Io)?,
        Err(_) => {
            let _ = child.start_kill();
            let _ = app.emit(
                event_topic,
                serde_json::json!({"stream":"exit","code":-9,"timeout":true,"ts":now_ms()}),
            );
            return Err(AppError::Other(format!(
                "命令执行超时({}s)",
                timeout.as_secs()
            )));
        }
    };
    let _ = h_out.await;
    let _ = h_err.await;

    let code = status.code().unwrap_or(-1);
    let _ = app.emit(
        event_topic,
        serde_json::json!({"stream":"exit","code":code,"ts":now_ms()}),
    );
    Ok(code)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
