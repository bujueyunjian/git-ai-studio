//! Install 模块的 Tauri 命令层:版本列表、安装/卸载、自动更新开关、当前版本探测。
//!
//! 长任务通过 Tauri event `install://<job_id>/log` 流式回传:
//!   { stream: "stdout"|"stderr"|"exit", line?: string, code?: number, ts: number }
//!
//! 互斥:通过 `AppState.install_lock` 全局锁,同一时刻只能跑一个 install / uninstall。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::git_ai::{self};
use crate::installer::{config_file, releases, scripts};
use crate::paths::{git_ai_dir, studio_data_dir};
use crate::proc::run_streaming;
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct InstalledVersion {
    pub installed: bool,
    pub version: Option<String>,
    pub binary_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InstallHistoryEntry {
    pub at_unix_ms: i64,
    pub action: String, // install / upgrade / uninstall
    pub version_previous: Option<String>,
    pub version_current: Option<String>,
    pub outcome: String, // success / failed
    pub exit_code: Option<i32>,
}

const INSTALL_TIMEOUT_SECS: u64 = 600; // 10 min

#[tauri::command]
pub async fn list_releases(force: bool) -> Result<releases::ReleasesPayload, String> {
    Ok(releases::list(force).await?)
}

#[tauri::command]
pub async fn get_installed_version() -> Result<InstalledVersion, String> {
    match git_ai::binary::resolve() {
        Ok(p) => {
            // 调一次 git-ai --version
            let out = crate::proc::run_capture_with_timeout(
                &p,
                &["--version"],
                None,
                Duration::from_secs(5),
            )
            .await;
            let version = match out {
                Ok(c) if c.status == 0 => {
                    extract_version(&c.stdout).or_else(|| extract_version(&c.stderr))
                }
                _ => None,
            };
            Ok(InstalledVersion {
                installed: true,
                version,
                binary_path: Some(p.display().to_string()),
            })
        }
        Err(_) => Ok(InstalledVersion {
            installed: false,
            version: None,
            binary_path: None,
        }),
    }
}

fn extract_version(s: &str) -> Option<String> {
    // 严格匹配 semver `X.Y.Z`(可带 `-prerelease`),失败返回 None,由调用方让前端显示"版本未知"。
    static RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::Regex::new(r"\b(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\b").unwrap()
    });
    RE.captures(s)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

#[tauri::command]
pub async fn is_install_running(state: State<'_, AppState>) -> Result<Option<String>, String> {
    // 非阻塞读;读不到锁(几乎不可能,仅写锁瞬时持有时)返回 None。
    Ok(state.install_lock.read().ok().and_then(|g| g.clone()))
}

fn acquire_lock(state: &AppState, job_id: &str) -> Result<(), String> {
    // 跨锁对称:hooks 切换进行中拒绝
    if let Ok(g) = state.hooks_lock.read() {
        if g.is_some() {
            return Err("Hooks 切换正在进行,稍后再装/卸 git-ai".into());
        }
    }
    let mut g = state
        .install_lock
        .try_write()
        .map_err(|_| "另一个安装 / 卸载任务在运行,请等待完成".to_string())?;
    if g.is_some() {
        return Err("已有一个安装 / 卸载任务在运行,请等待完成".to_string());
    }
    *g = Some(job_id.to_string());
    Ok(())
}

fn release_lock(state: &AppState) {
    if let Ok(mut g) = state.install_lock.write() {
        *g = None;
    }
}

#[tauri::command]
pub async fn install_git_ai(
    app: AppHandle,
    state: State<'_, AppState>,
    version: Option<String>,
    job_id: String,
) -> Result<i32, String> {
    acquire_lock(&state, &job_id)?;

    let topic = format!("install://{job_id}/log");
    let prev_version = get_installed_version().await.ok().and_then(|v| v.version);
    let result = do_install(app.clone(), version.clone(), &topic).await;
    release_lock(&state);

    let new_version = match &result {
        Ok(_) => get_installed_version().await.ok().and_then(|v| v.version),
        Err(_) => None,
    };
    let is_fresh_install = prev_version.is_none();
    let entry = InstallHistoryEntry {
        at_unix_ms: now_ms(),
        action: if is_fresh_install {
            "install".into()
        } else {
            "upgrade".into()
        },
        version_previous: prev_version,
        version_current: new_version,
        outcome: if result.is_ok() {
            "success".into()
        } else {
            "failed".into()
        },
        exit_code: result.as_ref().ok().copied(),
    };
    append_history(&entry);

    // 首次安装默认禁用 git-ai 后台自更新:本项目以 GitHub Releases 为唯一发布渠道、
    // 由 Studio 统一管理 git-ai 升级(对齐 PR-FAQ "no auto-update ping"),git-ai 自更新会绕过 Studio。
    // 只在首装写默认,升级不动以保留用户后续显式设置;写失败仅告警,不阻断安装。
    if is_fresh_install && result.is_ok() {
        if let Err(e) = config_file::write(&config_file::GitAiConfigPatch {
            disable_auto_updates: Some(true),
            update_channel: Some("none".into()),
        }) {
            log::warn!("首装默认禁用 git-ai 自更新失败(不阻断安装): {e}");
        }
    }

    // 失效路径缓存,让下一次 resolve 重新探测
    git_ai::binary::invalidate_cache();
    if let Ok(mut g) = state.diag_cache.write() {
        *g = None;
    }

    result.map_err(|e| e.to_string())
}

async fn do_install(
    app: AppHandle,
    version: Option<String>,
    topic: &str,
) -> crate::error::Result<i32> {
    let script = scripts::download_install_script().await?;
    let (prog, args, env) = scripts::build_install_invocation(&script, version.as_deref());
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    let code = run_streaming(
        &app,
        &prog,
        &args_ref,
        None,
        &env,
        topic,
        Duration::from_secs(INSTALL_TIMEOUT_SECS),
    )
    .await?;
    if code != 0 {
        return Err(AppError::Other(format!("安装脚本退出码非 0: {code}")));
    }
    Ok(code)
}

#[tauri::command]
pub async fn uninstall_git_ai(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    confirm_token: String,
) -> Result<(), String> {
    if confirm_token != "uninstall" {
        return Err("二次确认 token 错误".into());
    }
    acquire_lock(&state, &job_id)?;

    let topic = format!("install://{job_id}/log");
    let previous = get_installed_version().await.ok().and_then(|v| v.version);

    // Step 1: 先调 git-ai remove-hooks(失败 ignore,继续)
    if let Ok(bin) = git_ai::binary::resolve() {
        let _ = crate::proc::run_capture_with_timeout(
            &bin,
            &["remove-hooks"],
            None,
            Duration::from_secs(30),
        )
        .await;
        let _ = app_log(
            &app,
            &topic,
            "stdout",
            &format!("已调用 {}: remove-hooks", bin.display()),
        );
    } else {
        let _ = app_log(
            &app,
            &topic,
            "stderr",
            "未找到 git-ai 二进制,跳过 remove-hooks",
        );
    }

    // Step 2: 删除 ~/.git-ai/ 目录(不动 git notes,不动各仓库 .git/ai)
    // 用 spawn_blocking,避免在 tokio worker 线程上做长 IO 阻塞 runtime。
    let dir = git_ai_dir();
    let result: std::result::Result<(), String> = if dir.is_dir() {
        let _ = app_log(
            &app,
            &topic,
            "stdout",
            &format!("正在删除目录: {}", dir.display()),
        );
        let dir_clone = dir.clone();
        tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&dir_clone))
            .await
            .map_err(|e| format!("spawn 失败: {e}"))?
            .map_err(|e| format!("删除 {} 失败: {e}", dir.display()))
    } else {
        let _ = app_log(&app, &topic, "stdout", "~/.git-ai/ 不存在,跳过");
        Ok(())
    };
    let _ = app_log(
        &app,
        &topic,
        "exit",
        match &result {
            Ok(_) => "卸载完成。git notes 与 .git/ai/working_logs/ 未动。",
            Err(_) => "卸载失败,请查看日志手动清理残留",
        },
    );

    release_lock(&state);
    git_ai::binary::invalidate_cache();
    if let Ok(mut g) = state.diag_cache.write() {
        *g = None;
    }

    let outcome = if result.is_ok() { "success" } else { "failed" };
    append_history(&InstallHistoryEntry {
        at_unix_ms: now_ms(),
        action: "uninstall".into(),
        version_previous: previous,
        version_current: None,
        outcome: outcome.into(),
        exit_code: Some(if result.is_ok() { 0 } else { 1 }),
    });

    result
}

#[tauri::command]
pub async fn get_git_ai_config() -> Result<config_file::GitAiConfig, String> {
    Ok(config_file::read()?)
}

#[tauri::command]
pub async fn set_git_ai_config(
    patch: config_file::GitAiConfigPatch,
) -> Result<config_file::GitAiConfig, String> {
    Ok(config_file::write(&patch)?)
}

#[tauri::command]
pub async fn set_auto_update(enabled: bool) -> Result<config_file::GitAiConfig, String> {
    // 仅写 disable_auto_updates;不主动覆盖 update_channel(否则会破坏用户原值)。
    // 禁用更新时把 channel 设 "none" 是 git-ai 官方文档的建议,但只在禁用路径写。
    let patch = if enabled {
        config_file::GitAiConfigPatch {
            disable_auto_updates: Some(false),
            update_channel: None,
        }
    } else {
        config_file::GitAiConfigPatch {
            disable_auto_updates: Some(true),
            update_channel: Some("none".into()),
        }
    };
    Ok(config_file::write(&patch)?)
}

#[tauri::command]
pub async fn install_history() -> Result<Vec<InstallHistoryEntry>, String> {
    let p = studio_data_dir().join("install-history.json");
    if !p.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<Vec<InstallHistoryEntry>>(&raw).unwrap_or_default())
}

fn append_history(entry: &InstallHistoryEntry) {
    let p = studio_data_dir().join("install-history.json");
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut list: Vec<InstallHistoryEntry> = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.push(InstallHistoryEntry {
        at_unix_ms: entry.at_unix_ms,
        action: entry.action.clone(),
        version_previous: entry.version_previous.clone(),
        version_current: entry.version_current.clone(),
        outcome: entry.outcome.clone(),
        exit_code: entry.exit_code,
    });
    // 限制 200 条
    if list.len() > 200 {
        let extra = list.len() - 200;
        list.drain(0..extra);
    }
    let _ = std::fs::write(&p, serde_json::to_string_pretty(&list).unwrap_or_default());
}

fn app_log(app: &AppHandle, topic: &str, stream: &str, line: &str) -> crate::error::Result<()> {
    use tauri::Emitter;
    app.emit(
        topic,
        serde_json::json!({"stream": stream, "line": line, "ts": now_ms()}),
    )
    .map_err(|e| AppError::Other(format!("emit failed: {e}")))
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
