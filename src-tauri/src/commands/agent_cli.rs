//! Tauri 命令层:Claude Code / Codex 的 npm 安装·卸载·版本探测。
//!
//! 复用 git-ai 安装的传输层:`proc::run_streaming` 把 npm 输出流式回传到
//! `install://<job_id>/log`(与 git-ai 安装同协议,前端订阅逻辑可共用),全局
//! `install_lock` 串行(装 Claude Code 时不能并发切 hooks / 装 git-ai)。
//!
//! 失败响亮:npm 缺失在动手前 `Err`;npm 非 0 退出 → `Err`(同时 exit 事件已流回前端)。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::agent_cli::{self, AgentCli};
use crate::commands::install::{acquire_lock, release_lock, InstalledVersion};
use crate::proc::run_streaming;
use crate::state::AppState;

/// npm 安装/卸载超时。npm 全局装含网络下载,给 5min。
const AGENT_INSTALL_TIMEOUT_SECS: u64 = 300;

/// npm 探测结果。`available=false` 是预期空态(用户未装 Node),前端据此禁用装/卸并提示,
/// 不弹错(degraded 而非 error)。
#[derive(Debug, Serialize, Deserialize)]
pub struct NpmStatus {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[tauri::command]
pub async fn detect_npm() -> Result<NpmStatus, String> {
    match agent_cli::resolve_npm() {
        Ok(path) => {
            let version = crate::proc::run_capture_with_timeout(
                &path,
                &["--version"],
                None,
                Duration::from_secs(5),
            )
            .await
            .ok()
            .filter(|c| c.status == 0)
            .map(|c| c.stdout.trim().to_string())
            .filter(|s| !s.is_empty());
            Ok(NpmStatus {
                available: true,
                version,
                path: Some(path.display().to_string()),
            })
        }
        Err(_) => Ok(NpmStatus {
            available: false,
            version: None,
            path: None,
        }),
    }
}

#[tauri::command]
pub async fn detect_agent_cli(agent: AgentCli) -> Result<InstalledVersion, String> {
    Ok(agent_cli::detect(agent).await)
}

#[tauri::command]
pub async fn install_agent_cli(
    app: AppHandle,
    state: State<'_, AppState>,
    agent: AgentCli,
    version: Option<String>,
    job_id: String,
) -> Result<i32, String> {
    let npm = agent_cli::resolve_npm()?;
    acquire_lock(&state, &job_id)?;

    let topic = format!("install://{job_id}/log");
    let args = agent_cli::build_install_args(agent, version.as_deref());
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = run_streaming(
        &app,
        &npm,
        &args_ref,
        None,
        &[],
        &topic,
        Duration::from_secs(AGENT_INSTALL_TIMEOUT_SECS),
    )
    .await;
    release_lock(&state);

    match result {
        Ok(0) => Ok(0),
        Ok(code) => Err(format!(
            "{} 安装失败(npm 退出码 {code}),详见日志",
            agent.display_name()
        )),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn uninstall_agent_cli(
    app: AppHandle,
    state: State<'_, AppState>,
    agent: AgentCli,
    job_id: String,
    confirm_token: String,
) -> Result<(), String> {
    if confirm_token != "uninstall" {
        return Err("二次确认 token 错误".into());
    }
    let npm = agent_cli::resolve_npm()?;
    acquire_lock(&state, &job_id)?;

    let topic = format!("install://{job_id}/log");
    let args = agent_cli::build_uninstall_args(agent);
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = run_streaming(
        &app,
        &npm,
        &args_ref,
        None,
        &[],
        &topic,
        Duration::from_secs(AGENT_INSTALL_TIMEOUT_SECS),
    )
    .await;
    release_lock(&state);

    match result {
        Ok(0) => Ok(()),
        Ok(code) => Err(format!(
            "{} 卸载失败(npm 退出码 {code}),详见日志",
            agent.display_name()
        )),
        Err(e) => Err(e.to_string()),
    }
}
