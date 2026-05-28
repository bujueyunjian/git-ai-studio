//! P7 Notes 模块 Tauri 命令层。
//!
//! 暴露 2 个命令:
//! - `list_ai_notes()` → NotesListResult(commit 列表富化 + ref 缺失走 degraded 空态)
//! - `show_ai_note(sha)` → ShowNoteResult(authorship/3.0.0 完整解析)
//!
//! # 返回结构
//! 两者都是 `{ status: "ok" | "degraded", ... }` tagged enum,与 P5/P6 模式一致:
//! - degraded(Ok 返回):未选仓库 / git 不可用 / ref 不存在(仅 list)
//! - 其余错误(子进程失败 / JSON 解析失败 / size 超限 / sha 不存在 note):走 Err(String)
//!
//! # 跨命令分工
//! - 子进程调用 + raw 解析在 `git_ai::notes_ai`
//! - 本文件做 take_repo / degraded 判定 + 注入 head_sha(供前端判定 HEAD-only 跳 Blame)

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::git_ai::notes_ai::{self, AuthorshipLog, NoteListEntry};
use crate::state::AppState;

// 上游 notes_ai 模块返回的"已富化条目 + 不可达 sha"两段;命令层把它们和仓库元数据拼成 UI payload。

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotesDegradedReason {
    /// 未选仓库。
    RepoMissing,
    /// 整仓库无任何 ai note(`refs/notes/ai` 不存在或为空)。
    NoNotesInRepo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct NotesListPayload {
    pub repo_path: String,
    /// HEAD commit sha(供前端判断"当前选中 sha === HEAD"以启用 Blame 跳转)。
    pub head_sha: Option<String>,
    pub notes: Vec<NoteListEntry>,
    /// notes ref 引用但本地仓库不存在的 commit sha。
    /// 不混入 notes(避免占位行误导),由前端 banner 提示用户 fetch / 联系仓库维护者。
    pub unreachable_shas: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum NotesListResult {
    Ok { payload: NotesListPayload },
    Degraded { reason: NotesDegradedReason },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ShowNotePayload {
    pub commit_sha: String,
    pub log: AuthorshipLog,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ShowNoteResult {
    Ok { payload: ShowNotePayload },
    Degraded { reason: NotesDegradedReason },
}

#[tauri::command]
pub async fn list_ai_notes(state: State<'_, AppState>) -> Result<NotesListResult, String> {
    let Some((repo_path, repo_key, head_sha)) = take_repo(&state)? else {
        return Ok(NotesListResult::Degraded {
            reason: NotesDegradedReason::RepoMissing,
        });
    };

    let result = notes_ai::list_with_richen(&repo_path)
        .await
        .map_err(|e| e.to_string())?;

    // 仓库里完全无 ai notes(ref 不存在或为空):走 degraded;
    // 全部 sha unreachable 也算 degraded(没有可呈现的条目),但 unreachable 列表也透出
    if result.entries.is_empty() && result.unreachable_shas.is_empty() {
        return Ok(NotesListResult::Degraded {
            reason: NotesDegradedReason::NoNotesInRepo,
        });
    }

    Ok(NotesListResult::Ok {
        payload: NotesListPayload {
            repo_path: repo_key,
            head_sha,
            notes: result.entries,
            unreachable_shas: result.unreachable_shas,
        },
    })
}

#[tauri::command]
pub async fn show_ai_note(
    sha: String,
    state: State<'_, AppState>,
) -> Result<ShowNoteResult, String> {
    let Some((repo_path, _repo_key, _head_sha)) = take_repo(&state)? else {
        return Ok(ShowNoteResult::Degraded {
            reason: NotesDegradedReason::RepoMissing,
        });
    };

    let log = notes_ai::run_show(&repo_path, &sha)
        .await
        .map_err(|e| e.to_string())?;

    Ok(ShowNoteResult::Ok {
        payload: ShowNotePayload {
            commit_sha: sha,
            log,
        },
    })
}

/// 返回 `(PathBuf 用于子进程 cwd, repo_key 原始字符串, head_sha 选填)`。
/// 与 `commands::stats::take_repo` 同款模式:RwLock 短读后释放,后续整条命令走 owned 值。
fn take_repo(
    state: &State<'_, AppState>,
) -> Result<Option<(PathBuf, String, Option<String>)>, String> {
    let g = state
        .current_repo
        .read()
        .map_err(|_| "current_repo 锁中毒".to_string())?;
    Ok(g.as_ref()
        .map(|r| (PathBuf::from(&r.path), r.path.clone(), r.head_sha.clone())))
}
