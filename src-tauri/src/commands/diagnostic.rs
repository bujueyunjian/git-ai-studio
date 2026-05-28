use std::time::{Duration, Instant};

use futures::future::join_all;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::agents::{all_probes, AgentHookStatus, AgentKind};
use crate::git_ai;
use crate::git_ai::debug::DebugReport;
use crate::git_ai::shim::ShimStatus;
use crate::state::AppState;

const CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DegradeReason {
    GitAiNotFound { hint: String },
    CommandFailed { code: i32, stderr: String },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiagnosticOverview {
    pub generated_at_unix_ms: i64,
    pub took_ms: u128,
    pub repo: Option<crate::state::RepoEntry>,
    pub report: DebugReport,
    pub shim: ShimStatus,
    pub agents: Vec<AgentHookStatus>,
    /// 当后端某项关键检测整体降级(例:git-ai 未装),给前端的一句话提示。
    pub degraded: Option<DegradeReason>,
}

#[tauri::command]
pub async fn diagnose_environment(
    force: bool,
    state: State<'_, AppState>,
) -> Result<DiagnosticOverview, String> {
    if !force {
        if let Some(cached) = state.diag_cache.read().ok().and_then(|g| {
            g.as_ref().and_then(|c| {
                if c.at.elapsed() < CACHE_TTL {
                    Some(c.value.clone())
                } else {
                    None
                }
            })
        }) {
            if let Ok(v) = serde_json::from_value::<DiagnosticOverview>(cached) {
                return Ok(v);
            }
        }
    }

    let start = Instant::now();

    // 1) 当前仓库
    let repo = state.current_repo.read().ok().and_then(|g| g.clone());

    // 2) git-ai debug report —— 走子进程
    let report = match git_ai::binary::resolve() {
        Ok(path) => {
            let cwd = repo.as_ref().map(|r| std::path::PathBuf::from(&r.path));
            match crate::proc::run_capture(&path, &["debug", "report"], cwd.as_deref()).await {
                Ok(out) if out.status == 0 => git_ai::debug::parse_debug_report(&out.stdout),
                Ok(out) => DebugReport {
                    ok: false,
                    git_ai_version: None,
                    generated_at: None,
                    sections: vec![],
                    raw: out.stderr,
                },
                Err(e) => DebugReport {
                    ok: false,
                    git_ai_version: None,
                    generated_at: None,
                    sections: vec![],
                    raw: e.to_string(),
                },
            }
        }
        Err(_) => DebugReport::empty(),
    };

    // 3) git shim 校验(独立于 git-ai 是否装,即使没装也能跑)
    let shim = git_ai::shim::check().await.unwrap_or(ShimStatus {
        resolved_paths: vec![],
        first_is_shim: false,
        expected_shim: String::new(),
        ok: false,
    });

    // 4) 7 个 Agent 并行
    let probes = all_probes();
    let agents = join_all(probes.into_iter().map(|p| async move { p.probe().await })).await;

    // 5) 综合降级判断
    let degraded = if git_ai::binary::resolve().is_err() {
        Some(DegradeReason::GitAiNotFound {
            hint: "前往 Install 页一键安装,或在设置里通过 GIT_AI_PATH 指定二进制路径".into(),
        })
    } else if !report.ok {
        Some(DegradeReason::CommandFailed {
            code: -1,
            stderr: report.raw.clone(),
        })
    } else {
        None
    };

    let overview = DiagnosticOverview {
        generated_at_unix_ms: chrono_now_ms(),
        took_ms: start.elapsed().as_millis(),
        repo,
        report,
        shim,
        agents,
        degraded,
    };

    if let Ok(mut g) = state.diag_cache.write() {
        if let Ok(v) = serde_json::to_value(&overview) {
            *g = Some(crate::state::CachedDiag {
                value: v,
                at: Instant::now(),
            });
        }
    }

    Ok(overview)
}

#[tauri::command]
pub async fn invalidate_diagnostic_cache(state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut g) = state.diag_cache.write() {
        *g = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn check_agent_hooks(agent: AgentKind) -> Result<AgentHookStatus, String> {
    let probes = all_probes();
    for p in probes {
        if p.kind() == agent {
            return Ok(p.probe().await);
        }
    }
    Err(format!("unknown agent: {agent:?}"))
}

/// 探测 git-ai daemon 是否健康(主要用于"僵尸 lock"的可视提醒)。
/// 与 [`diagnose_environment`] 解耦:它只跑 ~100ms,可独立刷新,且 Diagnostic 顶部
/// 横幅按需显示,不必与重型环境诊断同周期。
#[tauri::command]
pub async fn diagnose_git_ai_daemon() -> Result<crate::git_ai::daemon::DaemonHealth, String> {
    Ok(crate::git_ai::daemon::detect_daemon_health().await)
}

/// 用户在诊断页确认后处理 git-ai daemon lock。
#[tauri::command]
pub async fn repair_git_ai_daemon() -> Result<crate::git_ai::daemon::DaemonRepairResult, String> {
    crate::git_ai::daemon::repair_daemon_lock().await
}

fn chrono_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
