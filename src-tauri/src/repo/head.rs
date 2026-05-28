//! 读 git 仓库的 HEAD 信息;不依赖 git 二进制,直接读 `.git/HEAD` 与 `.git/refs/`。

use std::fs;
use std::path::{Path, PathBuf};

use crate::proc::apply_no_window_std;

#[derive(Debug, Clone)]
pub struct HeadInfo {
    pub branch: Option<String>,
    pub sha: String,
    pub detached: bool,
}

pub fn read_head(repo_root: &Path) -> Option<HeadInfo> {
    let git_dir = locate_git_dir(repo_root)?;
    let head_file = git_dir.join("HEAD");
    let content = fs::read_to_string(&head_file).ok()?;
    let content = content.trim();

    if let Some(rest) = content.strip_prefix("ref: ") {
        let ref_path = rest.trim();
        let branch = ref_path.strip_prefix("refs/heads/").map(|s| s.to_string());
        let sha = read_ref(&git_dir, ref_path).unwrap_or_default();
        Some(HeadInfo {
            branch,
            sha,
            detached: false,
        })
    } else {
        Some(HeadInfo {
            branch: None,
            sha: content.to_string(),
            detached: true,
        })
    }
}

fn read_ref(git_dir: &Path, ref_path: &str) -> Option<String> {
    let direct = git_dir.join(ref_path);
    if let Ok(s) = fs::read_to_string(&direct) {
        return Some(s.trim().to_string());
    }
    let packed = git_dir.join("packed-refs");
    if let Ok(s) = fs::read_to_string(&packed) {
        for line in s.lines() {
            if line.starts_with('#') || line.starts_with('^') {
                continue;
            }
            if let Some((sha, name)) = line.split_once(' ') {
                if name.trim() == ref_path {
                    return Some(sha.trim().to_string());
                }
            }
        }
    }
    None
}

/// 兼容 worktree:`.git` 可能是目录或 "gitdir: <path>" 文件。
pub fn locate_git_dir(repo_root: &Path) -> Option<PathBuf> {
    let dot_git = repo_root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    if dot_git.is_file() {
        if let Ok(content) = fs::read_to_string(&dot_git) {
            if let Some(rest) = content.trim().strip_prefix("gitdir:") {
                let p = PathBuf::from(rest.trim());
                if p.is_absolute() {
                    return Some(p);
                } else {
                    return Some(repo_root.join(p));
                }
            }
        }
    }
    None
}

/// 数 `.git/ai/working_logs/<head_sha>/*.jsonl` 的数量。
/// 这是判定"当前 HEAD 是否曾产生过 checkpoint"的关键指标。
pub fn working_logs_count(repo_root: &Path, head_sha: Option<&str>) -> u32 {
    let Some(git_dir) = locate_git_dir(repo_root) else {
        return 0;
    };
    let ai_dir = git_dir.join("ai").join("working_logs");
    if !ai_dir.is_dir() {
        return 0;
    }
    // 优先按 head_sha 子目录数;若 head_sha 未知,统计全量 jsonl
    if let Some(sha) = head_sha {
        let sub = ai_dir.join(sha);
        if sub.is_dir() {
            return count_jsonl(&sub);
        }
    }
    count_jsonl(&ai_dir)
}

fn count_jsonl(dir: &Path) -> u32 {
    let mut n: u32 = 0;
    let walker = match fs::read_dir(dir) {
        Ok(w) => w,
        Err(_) => return 0,
    };
    for e in walker.flatten() {
        let p = e.path();
        if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            n = n.saturating_add(1);
        } else if p.is_dir() {
            n = n.saturating_add(count_jsonl(&p));
        }
    }
    n
}

/// 通过 `git status --porcelain --untracked-files=no` 判 dirty。
/// 失败 / 超时 / git 缺失返回 `None` —— 调用方应把 `None` 渲染为"未知"而不是误报。
pub fn detect_dirty(repo_root: &Path) -> Option<bool> {
    let git_exe = which::which("git").ok()?;
    let mut cmd = std::process::Command::new(git_exe);
    cmd.args(["status", "--porcelain", "--untracked-files=no"])
        .current_dir(repo_root);
    apply_no_window_std(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(!output.stdout.is_empty())
}
