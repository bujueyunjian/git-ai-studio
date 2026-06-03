//! Hooks 模块的 Tauri 命令层。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::agents::{all_probes, AgentHookStatus};
use crate::error::AppError;
use crate::git_ai;
use crate::hooks::{
    backups,
    model::{HooksMode, HooksStatus, SettingsBackup},
    settings_json,
};
use crate::paths::claude_settings_json;
use crate::proc::run_streaming;
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct ClaudeSettingsView {
    pub path: String,
    pub exists: bool,
    pub raw_size: u64,
    pub raw: Option<String>,
    pub mode: HooksMode,
}

fn acquire_hooks_lock(state: &AppState, job_id: &str) -> Result<(), String> {
    // 跨锁 precondition:install / uninstall 进行时拒绝
    if let Ok(g) = state.install_lock.read() {
        if g.is_some() {
            return Err("Install / Uninstall 正在进行,稍后再切 hooks".into());
        }
    }
    let mut g = state
        .hooks_lock
        .try_write()
        .map_err(|_| "另一个 hooks 任务在跑,请等待完成".to_string())?;
    if g.is_some() {
        return Err("已有一个 hooks 任务在跑".to_string());
    }
    *g = Some(job_id.to_string());
    Ok(())
}

fn release_hooks_lock(state: &AppState) {
    if let Ok(mut g) = state.hooks_lock.write() {
        *g = None;
    }
}

#[tauri::command]
pub async fn get_hooks_status(_state: State<'_, AppState>) -> Result<HooksStatus, String> {
    // 跑在阻塞线程池里:detect_mode 读文件
    tokio::task::spawn_blocking(|| {
        let mode = settings_json::detect_mode();
        HooksStatus { mode }
    })
    .await
    .map_err(|e| format!("spawn 失败: {e}"))
}

#[tauri::command]
pub async fn read_claude_settings() -> Result<ClaudeSettingsView, String> {
    tokio::task::spawn_blocking(|| -> Result<ClaudeSettingsView, String> {
        let path = claude_settings_json();
        let exists = path.exists();
        let raw = if exists {
            Some(
                std::fs::read_to_string(&path)
                    .map_err(|e| format!("读 settings.json 失败: {e}"))?,
            )
        } else {
            None
        };
        let raw_size = raw.as_ref().map(|s| s.len() as u64).unwrap_or(0);
        Ok(ClaudeSettingsView {
            path: path.display().to_string(),
            exists,
            raw_size,
            raw,
            mode: settings_json::detect_mode(),
        })
    })
    .await
    .map_err(|e| format!("spawn 失败: {e}"))?
}

#[tauri::command]
pub async fn list_settings_backups() -> Result<Vec<SettingsBackup>, String> {
    backups::list_backups().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_claude_settings(
    app: AppHandle,
    job_id: String,
    backup_path: String,
) -> Result<(), String> {
    let topic = format!("hooks://{job_id}/log");
    let _ = app_log(
        &app,
        &topic,
        "stdout",
        &format!("正在还原 settings.json: {backup_path}"),
    );
    let result = backups::restore_from_backup(&backup_path).map_err(|e| e.to_string());
    emit_result(
        &app,
        &topic,
        &result,
        "settings.json 已还原",
        "settings.json 还原失败",
    );
    result
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApplyResult {
    pub mode_after: HooksMode,
    pub changed: bool,
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
}

/// 切到指定模式 — Official / None。
/// **不会**真正跑 git-ai install;那是 install_hooks_official 命令的事。
/// 这个命令只动 settings.json。
#[tauri::command]
pub async fn claude_settings_merge(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    mode: HooksMode,
) -> Result<ApplyResult, String> {
    let topic = format!("hooks://{job_id}/log");
    app_log(
        &app,
        &topic,
        "stdout",
        &format!("准备切换 Hooks 模式: {mode:?}"),
    )
    .ok();
    acquire_hooks_lock(&state, &job_id)?;

    let command_path = if mode == HooksMode::Official {
        match git_ai::binary::resolve() {
            Ok(p) => Some(p.display().to_string()),
            Err(_) => {
                release_hooks_lock(&state);
                let result = Err("Official 模式要求先安装 git-ai".to_string());
                emit_result(&app, &topic, &result, "", "Hooks 模式切换失败");
                return result;
            }
        }
    } else {
        None
    };

    let result = tokio::task::spawn_blocking(move || {
        settings_json::merge_to_mode(mode, command_path.as_deref())
    })
    .await
    .map_err(|e| format!("spawn 失败: {e}"))?
    .map_err(|e| e.to_string());
    release_hooks_lock(&state);
    if let Err(e) = &result {
        let result_for_log: Result<(), String> = Err(e.clone());
        emit_result(&app, &topic, &result_for_log, "", "Hooks 模式切换失败");
    }
    let report = result?;
    let _ = app_log(
        &app,
        &topic,
        "stdout",
        &format!(
            "settings.json 合并完成: added={}, updated={}, removed={}",
            report.added.len(),
            report.updated.len(),
            report.removed.len()
        ),
    );
    emit_result(
        &app,
        &topic,
        &Ok(()),
        "Hooks 模式切换完成",
        "Hooks 模式切换失败",
    );
    Ok(ApplyResult {
        mode_after: settings_json::detect_mode(),
        changed: report.changed,
        added: report.added,
        updated: report.updated,
        removed: report.removed,
    })
}

/// 跑 `git-ai install` 写入官方 hooks(它也会同步处理 Cursor / 其它 agent)。
#[tauri::command]
pub async fn install_hooks_official(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<i32, String> {
    acquire_hooks_lock(&state, &job_id)?;

    let topic = format!("hooks://{job_id}/log");
    let result = run_git_ai_install(app, &topic).await;
    release_hooks_lock(&state);

    // 无论成功失败,都让 diagnostic 重测
    if let Ok(mut g) = state.diag_cache.write() {
        *g = None;
    }

    result.map_err(|e| e.to_string())
}

/// 针对单个 AI agent 触发修复。
///
/// 现状(2026-05):上游 git-ai `install-hooks` 子命令**未提供 `--agents <id>` 过滤参数**
/// (见 `git-ai/src/commands/install_hooks.rs:299-312`,只支持 `--dry-run`
/// `--verbose` `--skills`),无法精确单装。但 `install-hooks` 是**幂等**的:对已正确
/// 配置的 agent 返回 `AlreadyInstalled` no-op(见上游 521-527 行),只对缺失的实际写入。
///
/// 因此本命令底层仍调 `git-ai install`(全装,idempotent),效果等价于"只补缺失的 agent"。
/// 用户视角:点 Codex 卡片下"修复此项",日志/结果显示该 agent 已修复;其它已配置的
/// agent 完全不会被改动。
///
/// 长期方向:推动 git-ai 上游加 `--agents <id>` 参数后,本命令切到精确单装。
#[tauri::command]
pub async fn install_hooks_for_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    agent: crate::agents::AgentKind,
) -> Result<i32, String> {
    acquire_hooks_lock(&state, &job_id)?;

    let topic = format!("hooks://{job_id}/log");
    let _ = app_log(
        &app,
        &topic,
        "stdout",
        &format!(
            "为 {} 修复 hooks(git-ai install-hooks 幂等,已正确配置的其它 agent 不会被改动)",
            agent.display_name()
        ),
    );
    let result = run_git_ai_install(app, &topic).await;
    release_hooks_lock(&state);

    if let Ok(mut g) = state.diag_cache.write() {
        *g = None;
    }

    let code = result.map_err(|e| e.to_string())?;
    let status = probe_agent_after_install(agent).await?;
    if !status.configured {
        let detail = if status.issues.is_empty() {
            "复测仍未检测到有效 git-ai hook".to_string()
        } else {
            status.issues.join("; ")
        };
        return Err(format!(
            "{} 修复命令已执行,但复测仍未通过: {detail}",
            agent.display_name()
        ));
    }

    Ok(code)
}

async fn run_git_ai_install(app: AppHandle, topic: &str) -> crate::error::Result<i32> {
    let bin = git_ai::binary::resolve()?;
    let code = run_streaming(
        &app,
        &bin,
        &["install"],
        None,
        &[],
        topic,
        Duration::from_secs(120),
    )
    .await?;
    if code != 0 {
        return Err(AppError::Other(format!("git-ai install 退出码 {code}")));
    }
    Ok(code)
}

async fn probe_agent_after_install(
    agent: crate::agents::AgentKind,
) -> Result<AgentHookStatus, String> {
    for probe in all_probes() {
        if probe.kind() == agent {
            return Ok(probe.probe().await);
        }
    }
    Err(format!("unknown agent: {agent:?}"))
}

fn app_log(app: &AppHandle, topic: &str, stream: &str, line: &str) -> crate::error::Result<()> {
    app.emit(
        topic,
        serde_json::json!({"stream": stream, "line": line, "ts": now_ms()}),
    )
    .map_err(|e| AppError::Other(format!("emit failed: {e}")))
}

fn emit_result<T>(
    app: &AppHandle,
    topic: &str,
    result: &Result<T, String>,
    ok_line: &str,
    err_prefix: &str,
) {
    match result {
        Ok(_) => {
            if !ok_line.is_empty() {
                let _ = app_log(app, topic, "stdout", ok_line);
            }
            let _ = app.emit(
                topic,
                serde_json::json!({"stream":"exit","code":0,"ts":now_ms()}),
            );
        }
        Err(e) => {
            let _ = app_log(app, topic, "stderr", &format!("{err_prefix}: {e}"));
            let _ = app.emit(
                topic,
                serde_json::json!({"stream":"exit","code":1,"ts":now_ms()}),
            );
        }
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
