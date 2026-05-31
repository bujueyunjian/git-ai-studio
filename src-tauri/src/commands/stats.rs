//! Stats 模块 Tauri 命令层。
//!
//! 暴露 3 个命令:
//! - `get_commit_stats(sha?)` → 单 commit 的 AI 归因数字 + tool_model_breakdown
//! - `get_commit_status()`    → working dir(未提交)的同上数字
//! - `list_recent_commits(maxCount)` → 最近 commit 列表(供 UI 选择 commit)
//!
//! # 返回结构
//! 前两个返回 [`StatsResult`] —— 一个 tagged enum:
//! - `{ status: "ok", view: StatsView }`
//! - `{ status: "degraded", reason: { kind: ... } }`
//!
//! degraded(返回 Ok,前端渲染空态卡):未选仓库 / git-ai 未安装 / HEAD 不存在。
//! 其余错误(子进程失败 / JSON 解析失败 / git log 失败)走 `Err(String)`,前端弹 toast 红。
//!
//! # 跨命令分工
//! - JSON 反序列化在 `git_ai::stats::run_stats / run_status`(纯解析)
//! - merge 探测在 `repo::commits::is_merge_commit`(底层 git rev-list)
//! - 本文件做组装、degraded 判定、NoteKind 派生、commits_cache 命中。

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::git_ai;
use crate::repo::commits::{self, CommitBrief};
use crate::state::{AppState, CachedCommits};

const COMMITS_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StatsKind {
    /// commit 级 stats(`git-ai stats [sha]`)。
    Commit,
    /// working dir 级 stats(`git-ai status`)。
    Working,
}

/// 提示性的 note 类型;文案放前端 copy.ts。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NoteKind {
    /// merge commit:git-ai 设计上 ai_accepted 永远 0,全部桶通常为 0。
    Merge,
    /// 4 桶之和为 0(commit 无 additions / 纯删除 / 纯 rename)。
    EmptyAdditions,
    /// 有 additions 但全部归 unknown,提示用户没装 hook。
    WorkingLogsMissing,
}

/// degraded 原因。前端按 `kind` 切换空态卡。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DegradedReason {
    /// 未选仓库。
    RepoMissing,
    /// git-ai 二进制不存在。
    GitAiMissing,
    /// 当前仓库的 HEAD 不可读(空仓 / detached 未初始化等)。
    NoHead,
}

/// Stats 完整视图。前端据此渲染 5 数字 + 进度条 + breakdown 表。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatsView {
    pub kind: StatsKind,
    /// 仅 commit 模式有值;working 模式恒为 None。
    pub commit_sha: Option<String>,
    pub is_merge: bool,
    /// 直接平铺 git-ai 11 字段 + tool_model_breakdown。
    pub stats: git_ai::stats::AiStats,
    /// `ai_additions + human_additions + mixed_additions + unknown_additions`,后端聚合一次作为公式分母锚点。
    pub total_additions: u64,
    pub note_kind: Option<NoteKind>,
}

/// 命令返回:成功视图 / degraded 空态。tagged on `status`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum StatsResult {
    Ok { view: StatsView },
    Degraded { reason: DegradedReason },
}

#[tauri::command]
pub async fn get_commit_stats(
    sha: Option<String>,
    state: State<'_, AppState>,
) -> Result<StatsResult, String> {
    let Some((repo_path, head_sha)) = take_repo_path(&state)? else {
        return Ok(StatsResult::Degraded {
            reason: DegradedReason::RepoMissing,
        });
    };
    let git_ai_bin = match git_ai::binary::resolve() {
        Ok(p) => p,
        Err(_) => {
            return Ok(StatsResult::Degraded {
                reason: DegradedReason::GitAiMissing,
            })
        }
    };

    // sha 缺省时用 RepoEntry.head_sha;若 head 也无,说明是空仓 / detached 未初始化 → no_head。
    let resolved_sha = sha.clone().or(head_sha);
    let Some(target_sha) = resolved_sha else {
        return Ok(StatsResult::Degraded {
            reason: DegradedReason::NoHead,
        });
    };

    let stats = git_ai::stats::run_stats(&git_ai_bin, &repo_path, Some(&target_sha))
        .await
        .map_err(|e| e.to_string())?;

    // merge 探测:git-ai stats --json 不含 is_merge 字段,只能问 git。
    let is_merge = commits::is_merge_commit(&repo_path, &target_sha)
        .await
        .map_err(|e| e.to_string())?;

    let total = stats.total_additions();
    let note_kind = derive_note_kind(&stats, total, is_merge);

    Ok(StatsResult::Ok {
        view: StatsView {
            kind: StatsKind::Commit,
            commit_sha: Some(target_sha),
            is_merge,
            stats,
            total_additions: total,
            note_kind,
        },
    })
}

#[tauri::command]
pub async fn get_commit_status(state: State<'_, AppState>) -> Result<StatsResult, String> {
    let Some((repo_path, _head_sha)) = take_repo_path(&state)? else {
        return Ok(StatsResult::Degraded {
            reason: DegradedReason::RepoMissing,
        });
    };
    let git_ai_bin = match git_ai::binary::resolve() {
        Ok(p) => p,
        Err(_) => {
            return Ok(StatsResult::Degraded {
                reason: DegradedReason::GitAiMissing,
            })
        }
    };

    let status = git_ai::stats::run_status(&git_ai_bin, &repo_path)
        .await
        .map_err(|e| e.to_string())?;

    let total = status.stats.total_additions();
    // working dir 模式不存在 merge 概念。NoteKind 仅判 Empty / WorkingLogsMissing。
    let note_kind = derive_note_kind(&status.stats, total, false);

    Ok(StatsResult::Ok {
        view: StatsView {
            kind: StatsKind::Working,
            commit_sha: None,
            is_merge: false,
            stats: status.stats,
            total_additions: total,
            note_kind,
        },
    })
}

#[tauri::command]
pub async fn list_recent_commits(
    max_count: u32,
    state: State<'_, AppState>,
) -> Result<Vec<CommitBrief>, String> {
    let Some((repo_path, repo_key, _)) = take_repo(&state)? else {
        // 未选仓库时直接返回空数组(不算错误;UI 自己空态)。
        return Ok(Vec::new());
    };

    // 缓存命中:同一仓库(用 RepoEntry.path 字符串作 key,避免 PathBuf::display() 漂移)
    // + 同一 max_count + 30s 内,直接复用。
    if let Some(cached) = read_commits_cache(&state, &repo_key, max_count) {
        return Ok(cached);
    }

    let items = commits::list_recent(&repo_path, max_count)
        .await
        .map_err(|e| e.to_string())?;

    if let Ok(mut g) = state.commits_cache.write() {
        *g = Some(CachedCommits {
            repo_path: repo_key,
            max_count,
            at: Instant::now(),
            items: items.clone(),
        });
    }
    Ok(items)
}

// ===== 私有 helper =====

/// 返回 `(PathBuf 用于子进程 cwd, repo_key 原始字符串用作 cache key, head_sha 选填)`。
/// 把 PathBuf 与 cache key 解耦后,无论 PathBuf::display() 怎么规整(verbatim 前缀 / 大小写),
/// commits_cache 的命中只比 `RepoEntry.path` 字符串本身。
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

/// 单仓库变种:`get_commit_stats` / `get_commit_status` 无需 cache key。
fn take_repo_path(
    state: &State<'_, AppState>,
) -> Result<Option<(PathBuf, Option<String>)>, String> {
    Ok(take_repo(state)?.map(|(p, _, sha)| (p, sha)))
}

fn read_commits_cache(
    state: &State<'_, AppState>,
    repo_key: &str,
    max_count: u32,
) -> Option<Vec<CommitBrief>> {
    let g = state.commits_cache.read().ok()?;
    let c = g.as_ref()?;
    if c.repo_path != repo_key {
        return None;
    }
    if c.max_count != max_count {
        return None;
    }
    if c.at.elapsed() > COMMITS_CACHE_TTL {
        return None;
    }
    Some(c.items.clone())
}

/// 单一来源的 NoteKind 派生规则。优先级:Merge > Empty > WorkingLogsMissing。
///
/// WorkingLogsMissing:当前 commit 有 additions(total > 0),且 AI 桶完全为 0
/// (ai_additions==0 && ai_accepted==0),且 unknown_additions > 0。
/// 基于上游字段定义:`unknown_additions` = "lines with no attestation at all"(stats.rs:22)。
pub(crate) fn derive_note_kind(
    stats: &git_ai::stats::AiStats,
    total: u64,
    is_merge: bool,
) -> Option<NoteKind> {
    if is_merge {
        return Some(NoteKind::Merge);
    }
    if total == 0 {
        return Some(NoteKind::EmptyAdditions);
    }
    let no_current_ai = stats.ai_additions == 0 && stats.ai_accepted == 0;
    if no_current_ai && stats.unknown_additions > 0 {
        return Some(NoteKind::WorkingLogsMissing);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_ai::stats::AiStats;

    fn s(human: u64, unknown: u64, ai: u64, accepted: u64) -> AiStats {
        AiStats {
            human_additions: human,
            unknown_additions: unknown,
            ai_additions: ai,
            ai_accepted: accepted,
            ..Default::default()
        }
    }

    #[test]
    fn note_kind_merge_wins() {
        let st = s(100, 10, 50, 50);
        let total = st.total_additions();
        assert_eq!(derive_note_kind(&st, total, true), Some(NoteKind::Merge));
    }

    #[test]
    fn note_kind_empty_when_zero_total() {
        let st = s(0, 0, 0, 0);
        assert_eq!(
            derive_note_kind(&st, 0, false),
            Some(NoteKind::EmptyAdditions)
        );
    }

    #[test]
    fn note_kind_working_logs_missing() {
        // total>0 + AI 全 0 + unknown>0
        let st = s(0, 500, 0, 0);
        let total = st.total_additions();
        assert_eq!(
            derive_note_kind(&st, total, false),
            Some(NoteKind::WorkingLogsMissing)
        );
    }

    #[test]
    fn note_kind_none_when_ai_present() {
        let st = s(120, 15, 80, 80);
        let total = st.total_additions();
        assert_eq!(derive_note_kind(&st, total, false), None);
    }

    #[test]
    fn no_working_logs_missing_when_ai_partially_present() {
        // AI 桶非零 ⇒ hook 在工作,不报 WorkingLogsMissing
        let st = s(0, 100, 5, 5);
        let total = st.total_additions();
        assert_eq!(derive_note_kind(&st, total, false), None);
    }

    #[test]
    fn no_working_logs_missing_when_only_human() {
        // 纯人写 commit:total>0、AI=0、unknown=0 ⇒ 没必要报"hook 没装"
        let st = s(200, 0, 0, 0);
        let total = st.total_additions();
        assert_eq!(derive_note_kind(&st, total, false), None);
    }
}
