//! P8 Checkpoints 命令层。暴露 4 个 #[tauri::command]:
//!
//! - `list_checkpoints(sha?)`  → 读 `.git/ai/working_logs/<sha>/checkpoints.jsonl`
//! - `is_mock_running()`       → 非阻塞查 mock_lock 状态
//! - `git_status_porcelain()`  → mock Dialog 内显示 dirty 文件预览(评审 B C-4)
//! - `mock_checkpoint(...)`    → **危险**:写盘动作,二次确认 token + 锁互斥 + git-ai 预校验
//!
//! # 危险动作护栏(评审 B C-1 ~ C-5)
//! - 输入字符串 token = "mock" 二次确认(对齐 P2 uninstall 范式)
//! - 三锁两两互斥:install_lock / hooks_lock / mock_lock 任一持有时其它拒绝
//! - 调 git-ai 前预校验 binary 存在,未装直接 Err
//! - 流式日志走 `proc::run_streaming`,event topic `checkpoint://<job_id>/log`
//! - timeout 5s(CLI 是 fire-and-forget,本体极快;daemon 异步写盘由前端轮询验证)
//!
//! # No CLI undo
//! git-ai 没有 `checkpoint reset` 子命令,撤销需要手动删 `.git/ai/working_logs/<sha>/checkpoints.jsonl`
//! 或整个 sha 目录(`reset_working_log` 是上游内部 API,不暴露给 CLI)。Dialog 文案必须明示。

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::git_ai;
use crate::proc::{run_capture_with_timeout, run_streaming};
use crate::repo::working_logs::{self, Checkpoint, WorkingLogPresence};
use crate::state::AppState;

const MOCK_TIMEOUT_SECS: u64 = 5;
const GIT_STATUS_TIMEOUT_SECS: u64 = 5;

// ============================================================================
// Degraded / Result enums(对齐 P4-P7 tagged enum 模式)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckpointsDegradedReason {
    RepoMissing,
    NoHead,
    GitAiMissing,
    /// `.git/ai/working_logs/<sha>/` 目录不存在 — git-ai 未在此 HEAD 跑过 checkpoint。
    WorkingLogsDirMissing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CheckpointsPayload {
    pub repo_path: String,
    pub head_sha: String,
    pub checkpoints: Vec<Checkpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CheckpointsResult {
    Ok { payload: CheckpointsPayload },
    Degraded { reason: CheckpointsDegradedReason },
}

// ============================================================================
// list_checkpoints
// ============================================================================

#[tauri::command]
pub async fn list_checkpoints(
    sha: Option<String>,
    state: State<'_, AppState>,
) -> Result<CheckpointsResult, String> {
    let Some((repo_path, repo_key, head_sha_opt)) = take_repo(&state)? else {
        return Ok(CheckpointsResult::Degraded {
            reason: CheckpointsDegradedReason::RepoMissing,
        });
    };
    let target_sha = match sha.or(head_sha_opt) {
        Some(s) => s,
        None => {
            return Ok(CheckpointsResult::Degraded {
                reason: CheckpointsDegradedReason::NoHead,
            });
        }
    };

    let ai_dir = resolve_worktree_ai_dir(&repo_path).await?;
    let presence = working_logs::probe_presence_in_ai_dir(&ai_dir, &target_sha);
    if matches!(presence, WorkingLogPresence::DirMissing) {
        return Ok(CheckpointsResult::Degraded {
            reason: CheckpointsDegradedReason::WorkingLogsDirMissing,
        });
    }

    let checkpoints = working_logs::read_checkpoints_in_ai_dir(&ai_dir, &target_sha)
        .await
        .map_err(|e| e.to_string())?;

    Ok(CheckpointsResult::Ok {
        payload: CheckpointsPayload {
            repo_path: repo_key,
            head_sha: target_sha,
            checkpoints,
        },
    })
}

// ============================================================================
// is_mock_running
// ============================================================================

#[tauri::command]
pub async fn is_mock_running(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.mock_lock.read().ok().and_then(|g| g.clone()))
}

// ============================================================================
// git_status_porcelain(mock Dialog 显示 dirty 文件预览)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GitStatusFile {
    /// 相对 repo workdir 的路径(POSIX 风格)。
    pub path: String,
    /// 2 字符状态码(`git status --porcelain` 首两列,如 ` M` / `MM` / `??`)。
    pub status: String,
}

/// 输出 dirty 文件列表 + truncated 标志。失败不阻塞 Dialog(评审 C C12):
/// 前端在显示"无法获取"提示后允许用户继续 mock,真实行为以 git-ai 实际执行为准。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DirtyFilesPayload {
    pub files: Vec<GitStatusFile>,
    pub total: usize,
}

/// 调 `git status --porcelain -z`(NUL 分隔规避带空格 / 换行的文件名)解析 dirty 列表。
/// 仅在 mock_checkpoint Dialog 预览时被前端调用;调用频率低,无需缓存。
#[tauri::command]
pub async fn git_status_porcelain(state: State<'_, AppState>) -> Result<DirtyFilesPayload, String> {
    let Some((repo_path, _, _)) = take_repo(&state)? else {
        return Err("未选仓库".into());
    };
    let git = which::which("git").map_err(|_| "未找到 git 二进制".to_string())?;
    let out = run_capture_with_timeout(
        &git,
        &["status", "--porcelain=v1", "-z"],
        Some(&repo_path),
        Duration::from_secs(GIT_STATUS_TIMEOUT_SECS),
    )
    .await
    .map_err(|e| e.to_string())?;
    if out.status != 0 {
        return Err(format!(
            "git status 退出码 {}: {}",
            out.status,
            out.stderr.trim()
        ));
    }
    let files = parse_porcelain_z(&out.stdout);
    Ok(DirtyFilesPayload {
        total: files.len(),
        files,
    })
}

/// `git status --porcelain=v1 -z` 输出格式:`XY <path>\0`(rename 时多一段 `<orig>\0`);
/// 此处把"重命名前路径"段合并进同条 status 的展示路径(用 ` -> ` 拼接),保留 rename 全貌。
fn parse_porcelain_z(stdout: &str) -> Vec<GitStatusFile> {
    let mut out = Vec::new();
    let mut chunks = stdout.split('\0').peekable();
    while let Some(rec) = chunks.next() {
        if rec.len() < 3 {
            // 最末一条 NUL 后是空串,跳过
            continue;
        }
        let status = rec[..2].to_string();
        let path = rec[3..].to_string();
        // rename / copy:首字符 'R' 或 'C' 时,下一条 NUL 后是 orig path
        let path = if status.starts_with('R') || status.starts_with('C') {
            match chunks.next() {
                Some(orig) if !orig.is_empty() => format!("{orig} -> {path}"),
                _ => path,
            }
        } else {
            path
        };
        out.push(GitStatusFile { path, status });
    }
    out
}

// ============================================================================
// mock_checkpoint(危险动作)
// ============================================================================

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MockPreset {
    /// `git-ai checkpoint human` — legacy 人类编辑标记
    Human,
    /// `git-ai checkpoint mock_ai` — 测试用 AI 标记
    MockAi,
    /// `git-ai checkpoint mock_known_human` — 测试用 known-human 标记(模拟 IDE 扩展)
    MockKnownHuman,
}

impl MockPreset {
    fn cli_arg(self) -> &'static str {
        match self {
            MockPreset::Human => "human",
            MockPreset::MockAi => "mock_ai",
            MockPreset::MockKnownHuman => "mock_known_human",
        }
    }
}

const MOCK_CONFIRM_TOKEN: &str = "mock";

#[tauri::command]
pub async fn mock_checkpoint(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    preset: MockPreset,
    pathspecs: Vec<String>,
    confirm_token: String,
) -> Result<i32, String> {
    // 1. 二次确认 token(对齐 P2 uninstall 范式)
    if confirm_token != MOCK_CONFIRM_TOKEN {
        return Err("二次确认 token 错误,请按 Dialog 提示输入 `mock`".into());
    }

    // 2. git-ai 预校验(评审 B C-5)
    let git_ai_bin = git_ai::binary::resolve()
        .map_err(|_| "git-ai 二进制未找到,请先在 Install 页安装".to_string())?;

    // 3. 取仓库 path(早于锁,避免 poison 时空锁)
    let Some((repo_path, _, _)) = take_repo(&state)? else {
        return Err("未选仓库".into());
    };

    // 4. 三锁互斥
    acquire_mock_lock(&state, &job_id)?;

    let topic = format!("checkpoint://{job_id}/log");
    let mut args: Vec<String> = vec!["checkpoint".into(), preset.cli_arg().into()];
    args.extend(pathspecs.iter().cloned());
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();

    let result = run_streaming(
        &app,
        &git_ai_bin,
        &args_ref,
        Some(&repo_path),
        &[],
        &topic,
        Duration::from_secs(MOCK_TIMEOUT_SECS),
    )
    .await;

    release_mock_lock(&state);

    match result {
        Ok(code) => {
            if code != 0 {
                return Err(format!(
                    "git-ai checkpoint {} 退出码 {}",
                    preset.cli_arg(),
                    code
                ));
            }
            Ok(code)
        }
        Err(e) => Err(e.to_string()),
    }
}

// ============================================================================
// 私有 helpers
// ============================================================================

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

async fn resolve_worktree_ai_dir(repo_path: &std::path::Path) -> Result<PathBuf, String> {
    let git = which::which("git").map_err(|_| "未找到 git 二进制".to_string())?;
    let git_dir_out = run_capture_with_timeout(
        &git,
        &["rev-parse", "--absolute-git-dir"],
        Some(repo_path),
        Duration::from_secs(GIT_STATUS_TIMEOUT_SECS),
    )
    .await
    .map_err(|e| e.to_string())?;
    if git_dir_out.status != 0 {
        return Err(format!(
            "git rev-parse --absolute-git-dir 退出码 {}: {}",
            git_dir_out.status,
            git_dir_out.stderr.trim()
        ));
    }
    let common_dir_out = run_capture_with_timeout(
        &git,
        &["rev-parse", "--git-common-dir"],
        Some(repo_path),
        Duration::from_secs(GIT_STATUS_TIMEOUT_SECS),
    )
    .await
    .map_err(|e| e.to_string())?;
    if common_dir_out.status != 0 {
        return Err(format!(
            "git rev-parse --git-common-dir 退出码 {}: {}",
            common_dir_out.status,
            common_dir_out.stderr.trim()
        ));
    }

    let git_dir = PathBuf::from(git_dir_out.stdout.trim());
    let common_raw = PathBuf::from(common_dir_out.stdout.trim());
    let git_common_dir = if common_raw.is_absolute() {
        common_raw
    } else {
        repo_path.join(common_raw)
    };
    Ok(working_logs::worktree_storage_ai_dir(
        &git_dir,
        &git_common_dir,
    ))
}

/// 三锁两两互斥:install_lock / hooks_lock / mock_lock 任一持有时 mock 拒绝。
fn acquire_mock_lock(state: &AppState, job_id: &str) -> Result<(), String> {
    if let Ok(g) = state.install_lock.read() {
        if g.is_some() {
            return Err("安装 / 卸载任务正在进行,稍后再 mock checkpoint".into());
        }
    }
    if let Ok(g) = state.hooks_lock.read() {
        if g.is_some() {
            return Err("Hooks 切换正在进行,稍后再 mock checkpoint".into());
        }
    }
    let mut g = state
        .mock_lock
        .try_write()
        .map_err(|_| "另一个 mock checkpoint 任务在运行,请等待完成".to_string())?;
    if g.is_some() {
        return Err("已有一个 mock checkpoint 任务在运行,请等待完成".into());
    }
    *g = Some(job_id.to_string());
    Ok(())
}

fn release_mock_lock(state: &AppState) {
    if let Ok(mut g) = state.mock_lock.write() {
        *g = None;
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_porcelain_z_simple() {
        // " M file1.txt\0?? new.txt\0"
        let s = " M file1.txt\0?? new.txt\0";
        let v = parse_porcelain_z(s);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].status, " M");
        assert_eq!(v[0].path, "file1.txt");
        assert_eq!(v[1].status, "??");
        assert_eq!(v[1].path, "new.txt");
    }

    #[test]
    fn parse_porcelain_z_rename_merges_two_segments() {
        // "R  newpath\0oldpath\0 M other\0"
        let s = "R  newpath\0oldpath\0 M other\0";
        let v = parse_porcelain_z(s);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].status, "R ");
        assert_eq!(v[0].path, "oldpath -> newpath");
        assert_eq!(v[1].status, " M");
        assert_eq!(v[1].path, "other");
    }

    #[test]
    fn parse_porcelain_z_empty_stdout() {
        assert!(parse_porcelain_z("").is_empty());
        assert!(parse_porcelain_z("\0").is_empty());
    }

    #[test]
    fn parse_porcelain_z_path_with_spaces() {
        // " M src/my file.rs\0"
        let s = " M src/my file.rs\0";
        let v = parse_porcelain_z(s);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].path, "src/my file.rs");
    }

    #[test]
    fn mock_preset_cli_arg() {
        assert_eq!(MockPreset::Human.cli_arg(), "human");
        assert_eq!(MockPreset::MockAi.cli_arg(), "mock_ai");
        assert_eq!(MockPreset::MockKnownHuman.cli_arg(), "mock_known_human");
    }
}
