//! P11-D `git-ai show <sha>` Tauri 命令层。
//!
//! 暴露 `get_show_raw(sha)` → 上游官方 show 命令的原文文本输出。
//! Stats 页"求助原文"按钮用这个。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::git_ai;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ShowDegradedReason {
    RepoMissing,
    GitAiMissing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ShowRawPayload {
    pub commit_sha: String,
    /// 上游 serialize_to_string 的原文(JSON metadata + `---` divider + attestations)。
    /// UI 用 `<pre>` 渲染,不再解析。
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ShowRawResult {
    Ok { payload: ShowRawPayload },
    Degraded { reason: ShowDegradedReason },
}

#[tauri::command]
pub async fn get_show_raw(
    sha: String,
    state: State<'_, AppState>,
) -> Result<ShowRawResult, String> {
    let Some(repo_path_buf) = take_repo(&state)? else {
        return Ok(ShowRawResult::Degraded {
            reason: ShowDegradedReason::RepoMissing,
        });
    };

    let bin = match git_ai::binary::resolve() {
        Ok(p) => p,
        Err(_) => {
            return Ok(ShowRawResult::Degraded {
                reason: ShowDegradedReason::GitAiMissing,
            });
        }
    };

    let raw = git_ai::show::run_show(&bin, &repo_path_buf, &sha)
        .await
        .map_err(|e| e.to_string())?;

    Ok(ShowRawResult::Ok {
        payload: ShowRawPayload {
            commit_sha: sha,
            raw,
        },
    })
}

fn take_repo(state: &State<'_, AppState>) -> Result<Option<PathBuf>, String> {
    let g = state
        .current_repo
        .read()
        .map_err(|_| "current_repo 锁中毒".to_string())?;
    Ok(g.as_ref().map(|r| PathBuf::from(&r.path)))
}
