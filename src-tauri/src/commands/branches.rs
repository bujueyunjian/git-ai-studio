//! 分支切换命令(E4 -> E5)。
//!
//! # 暴露
//! - `list_branches()` → 本地分支列表 + 当前分支
//! - `checkout_branch(name)` → 切换到指定分支(脏树拒切,失败返结构化 degraded)
//!
//! # 设计
//! - **本地分支唯**:remote-tracking(refs/remotes/*)本轮不暴露,避免误装 `-b` 创建
//! - **脏树拒切**:`git status --porcelain=v1 -z` 预检,非空 → Degraded::DirtyWorktree
//!   (列出脏文件名供前端引导用户去 Checkpoints 暂存)。**不**自动 stash / force —— 与
//!   项目 memory#6 "失败就 fail,不主动写 fallback" 对齐。
//! - **detached HEAD**:当前不在分支上 → current=None,前端 chip 显 "detached"。
//!
//! # 跨锁
//! 与 install / hooks / mock 三锁互不相干。切分支是只读 + 单次 checkout,无并发风险。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::proc::run_capture_with_timeout;
use crate::state::AppState;

const GIT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct BranchEntry {
    pub name: String,
    pub sha: String,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ListBranchesResult {
    Ok {
        /// 当前分支名;detached HEAD 时为 None。
        current: Option<String>,
        branches: Vec<BranchEntry>,
    },
    Degraded {
        reason: BranchesDegradedReason,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BranchesDegradedReason {
    RepoMissing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CheckoutOkPayload {
    pub branch: String,
    pub sha: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckoutDegradedReason {
    RepoMissing,
    /// 工作树有未提交改动,拒切 + 列前 N 个脏文件让前端引导用户去 Checkpoints 暂存
    DirtyWorktree {
        files: Vec<String>,
    },
    /// 切换失败(冲突 / 锁定 / 其它 git 错误);stderr 透传供用户判断
    Conflict {
        stderr: String,
    },
    /// 目标分支不存在
    NotFound {
        name: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CheckoutResult {
    Ok { payload: CheckoutOkPayload },
    Degraded { reason: CheckoutDegradedReason },
}

#[tauri::command]
pub async fn list_branches(state: State<'_, AppState>) -> Result<ListBranchesResult, String> {
    let Some(repo) = take_repo_path(&state)? else {
        return Ok(ListBranchesResult::Degraded {
            reason: BranchesDegradedReason::RepoMissing,
        });
    };
    let git = which::which("git").map_err(|_| "未找到 git 二进制".to_string())?;

    // 当前分支:`git symbolic-ref --short -q HEAD`,detached 时返回非 0 → current=None
    let cur_out = run_capture_with_timeout(
        &git,
        &["symbolic-ref", "--short", "-q", "HEAD"],
        Some(&repo),
        GIT_TIMEOUT,
    )
    .await
    .map_err(|e| e.to_string())?;
    let current = if cur_out.status == 0 {
        let s = cur_out.stdout.trim();
        if s.is_empty() {
            None
        } else {
            Some(s.to_string())
        }
    } else {
        None
    };

    // 分支列表:for-each-ref 一次拿 name + sha,LC_ALL=C 保英文 stderr(在 proc.rs 已默认)
    let list_out = run_capture_with_timeout(
        &git,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(objectname)",
            "refs/heads/",
        ],
        Some(&repo),
        GIT_TIMEOUT,
    )
    .await
    .map_err(|e| e.to_string())?;
    if list_out.status != 0 {
        return Err(format!(
            "git for-each-ref 失败(exit {}): {}",
            list_out.status,
            list_out.stderr.trim()
        ));
    }

    let branches = parse_for_each_ref(&list_out.stdout, current.as_deref());
    Ok(ListBranchesResult::Ok { current, branches })
}

#[tauri::command]
pub async fn checkout_branch(
    name: String,
    state: State<'_, AppState>,
) -> Result<CheckoutResult, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("分支名不能为空".to_string());
    }
    let Some(repo) = take_repo_path(&state)? else {
        return Ok(CheckoutResult::Degraded {
            reason: CheckoutDegradedReason::RepoMissing,
        });
    };
    let git = which::which("git").map_err(|_| "未找到 git 二进制".to_string())?;

    // 预检 1:目标分支存在?
    let exists_out = run_capture_with_timeout(
        &git,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{trimmed}"),
        ],
        Some(&repo),
        GIT_TIMEOUT,
    )
    .await
    .map_err(|e| e.to_string())?;
    if exists_out.status != 0 {
        return Ok(CheckoutResult::Degraded {
            reason: CheckoutDegradedReason::NotFound {
                name: trimmed.to_string(),
            },
        });
    }

    // 预检 2:工作树是否有未提交改动
    let dirty_out = run_capture_with_timeout(
        &git,
        &["status", "--porcelain=v1", "-z"],
        Some(&repo),
        GIT_TIMEOUT,
    )
    .await
    .map_err(|e| e.to_string())?;
    if dirty_out.status != 0 {
        return Err(format!(
            "git status 检查失败(exit {}): {}",
            dirty_out.status,
            dirty_out.stderr.trim()
        ));
    }
    let dirty_files = parse_porcelain_z(&dirty_out.stdout);
    if !dirty_files.is_empty() {
        return Ok(CheckoutResult::Degraded {
            reason: CheckoutDegradedReason::DirtyWorktree { files: dirty_files },
        });
    }

    // 真正执行 checkout
    let co_out = run_capture_with_timeout(&git, &["checkout", trimmed], Some(&repo), GIT_TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;
    if co_out.status != 0 {
        return Ok(CheckoutResult::Degraded {
            reason: CheckoutDegradedReason::Conflict {
                stderr: co_out.stderr.trim().to_string(),
            },
        });
    }

    // 拿新 HEAD sha
    let sha_out = run_capture_with_timeout(&git, &["rev-parse", "HEAD"], Some(&repo), GIT_TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;
    let sha = sha_out.stdout.trim().to_string();

    // 更新 current_repo state.head_sha + branch
    if let Ok(mut g) = state.current_repo.write() {
        if let Some(entry) = g.as_mut() {
            entry.head_branch = Some(trimmed.to_string());
            entry.head_sha = Some(sha.clone());
        }
    }

    Ok(CheckoutResult::Ok {
        payload: CheckoutOkPayload {
            branch: trimmed.to_string(),
            sha,
        },
    })
}

// ===== 解析层(纯函数,可单测) =====

/// 解析 `for-each-ref --format='%(refname:short)\t%(objectname)' refs/heads/` 输出。
pub fn parse_for_each_ref(stdout: &str, current: Option<&str>) -> Vec<BranchEntry> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(2, '\t');
        let Some(name) = parts.next() else { continue };
        let Some(sha) = parts.next() else { continue };
        let name = name.trim();
        let sha = sha.trim();
        if name.is_empty() || sha.is_empty() {
            continue;
        }
        let is_current = current.is_some_and(|c| c == name);
        out.push(BranchEntry {
            name: name.to_string(),
            sha: sha.to_string(),
            is_current,
        });
    }
    // 当前分支置顶,其余按字母序
    out.sort_by(|a, b| match (a.is_current, b.is_current) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    out
}

/// 解析 `git status --porcelain=v1 -z`,NUL 分隔,每条形如 `XY <path>`(2 状态字符 + 空格 + 路径)。
/// rename 形态 `R  old\0new`(2 段),本函数只取最后那段路径(用户视角更相关)。
pub fn parse_porcelain_z(stdout: &str) -> Vec<String> {
    let mut files = Vec::new();
    let mut chunks = stdout.split('\0').peekable();
    while let Some(entry) = chunks.next() {
        if entry.is_empty() {
            continue;
        }
        // entry 形如 "XY path"(至少 3 字符:2 状态 + 空格)
        if entry.len() < 3 {
            continue;
        }
        let xy = &entry[..2];
        let path = entry[3..].trim();
        // rename / copy:R/C → 下一段是 new path(取它)
        let first = xy.chars().next().unwrap_or(' ');
        if first == 'R' || first == 'C' {
            if let Some(new_path) = chunks.next() {
                let new_path = new_path.trim();
                if !new_path.is_empty() {
                    files.push(new_path.to_string());
                    continue;
                }
            }
        }
        if !path.is_empty() {
            files.push(path.to_string());
        }
    }
    files
}

fn take_repo_path(state: &State<'_, AppState>) -> Result<Option<PathBuf>, String> {
    let g = state
        .current_repo
        .read()
        .map_err(|_| "current_repo 锁中毒".to_string())?;
    Ok(g.as_ref().map(|r| PathBuf::from(&r.path)))
}

// 显式标注 Path 没被未使用——take_repo_path 用了
#[allow(dead_code)]
fn _path_marker(_p: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_for_each_ref_basic() {
        let stdout = "main\t1234567890abcdef\nfeat/x\tabcdef1234567890\nuat\t9876543210fedcba\n";
        let out = parse_for_each_ref(stdout, Some("uat"));
        // current 置顶
        assert_eq!(out[0].name, "uat");
        assert!(out[0].is_current);
        // 其余字母序
        assert_eq!(out[1].name, "feat/x");
        assert_eq!(out[2].name, "main");
    }

    #[test]
    fn parse_for_each_ref_skips_blank_lines() {
        let stdout = "main\t1234\n\n\nfoo\t5678\n";
        let out = parse_for_each_ref(stdout, None);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "foo");
        assert_eq!(out[1].name, "main");
    }

    #[test]
    fn parse_porcelain_z_basic() {
        let stdout = " M src/main.rs\0?? new_file.txt\0";
        let out = parse_porcelain_z(stdout);
        assert_eq!(out, vec!["src/main.rs", "new_file.txt"]);
    }

    #[test]
    fn parse_porcelain_z_rename_takes_new_path() {
        // R 类型:第一段是 "R  old",紧接第二段是 new path
        let stdout = "R  old/path.rs\0new/path.rs\0 M other.txt\0";
        let out = parse_porcelain_z(stdout);
        assert_eq!(out, vec!["new/path.rs", "other.txt"]);
    }

    #[test]
    fn parse_porcelain_z_empty() {
        assert!(parse_porcelain_z("").is_empty());
    }
}
