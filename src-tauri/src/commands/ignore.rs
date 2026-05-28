//! P11-C `effective-ignore-patterns` 命令层。
//!
//! 暴露 `list_effective_ignore_patterns()`,Settings 页用来展示当前生效的合并 patterns,
//! 让用户**看见**哪些文件被排除在 stats / blame 之外。
//!
//! # 返回结构
//! tagged enum `Ok / Degraded`,与 P5/P6/P7 同模式:repo_missing / git_ai_missing 走 Degraded。
//! 业务错误(子进程失败 / JSON 解析失败)走 `Err(String)`。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::git_ai;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IgnoreDegradedReason {
    RepoMissing,
    GitAiMissing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EffectiveIgnorePatternsPayload {
    pub repo_path: String,
    pub patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum EffectiveIgnorePatternsResult {
    Ok {
        payload: EffectiveIgnorePatternsPayload,
    },
    Degraded {
        reason: IgnoreDegradedReason,
    },
}

#[tauri::command]
pub async fn list_effective_ignore_patterns(
    state: State<'_, AppState>,
) -> Result<EffectiveIgnorePatternsResult, String> {
    let Some((repo_path_buf, repo_key)) = take_repo(&state)? else {
        return Ok(EffectiveIgnorePatternsResult::Degraded {
            reason: IgnoreDegradedReason::RepoMissing,
        });
    };

    let bin = match git_ai::binary::resolve() {
        Ok(p) => p,
        Err(_) => {
            return Ok(EffectiveIgnorePatternsResult::Degraded {
                reason: IgnoreDegradedReason::GitAiMissing,
            });
        }
    };

    let patterns = git_ai::ignore::run_effective_patterns(&bin, &repo_path_buf)
        .await
        .map_err(|e| e.to_string())?;

    Ok(EffectiveIgnorePatternsResult::Ok {
        payload: EffectiveIgnorePatternsPayload {
            repo_path: repo_key,
            patterns,
        },
    })
}

fn take_repo(state: &State<'_, AppState>) -> Result<Option<(PathBuf, String)>, String> {
    let g = state
        .current_repo
        .read()
        .map_err(|_| "current_repo 锁中毒".to_string())?;
    Ok(g.as_ref().map(|r| (PathBuf::from(&r.path), r.path.clone())))
}
