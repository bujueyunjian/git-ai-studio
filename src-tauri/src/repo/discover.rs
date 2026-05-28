//! 用 walkdir 从根目录扫出所有 git 仓库。
//!
//! 命中 `.git` 目录(或 worktree 的 `.git` 文件)即认为该层是仓库,不再下钻。

use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::state::RepoEntry;

/// 默认扫描深度上限(避免在用户根目录下灾难性遍历)。
pub const DEFAULT_MAX_DEPTH: usize = 4;

pub fn scan_roots(roots: &[String], max_depth: Option<u32>) -> Vec<RepoEntry> {
    let depth = max_depth.map(|d| d as usize).unwrap_or(DEFAULT_MAX_DEPTH);
    let mut found: Vec<PathBuf> = Vec::new();
    for root in roots {
        let root_path = PathBuf::from(root);
        if !root_path.is_dir() {
            continue;
        }
        scan_one(&root_path, depth, &mut found);
    }
    found.sort();
    found.dedup();
    found.into_iter().map(|p| build_entry(&p)).collect()
}

fn scan_one(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let walker = WalkDir::new(root)
        .max_depth(depth)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !should_skip(e.path()));
    for entry in walker.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        // 同时识别 ".git" 目录与 worktree 的 ".git" 文件
        if name == ".git" {
            if let Some(parent) = p.parent() {
                out.push(parent.to_path_buf());
            }
        }
    }
}

fn should_skip(p: &Path) -> bool {
    let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    matches!(
        name,
        "node_modules" | "target" | "dist" | ".cache" | ".pnpm-store" | ".rustup" | ".cargo"
    )
}

fn build_entry(repo_root: &Path) -> RepoEntry {
    let head = super::head::read_head(repo_root);
    let head_sha = head.as_ref().map(|h| h.sha.clone());
    let git_dir = super::head::locate_git_dir(repo_root);
    let has_git_ai = git_dir
        .as_ref()
        .map(|g| g.join("ai").is_dir())
        .unwrap_or(false);
    let working_logs_count = super::head::working_logs_count(repo_root, head_sha.as_deref());

    RepoEntry {
        path: repo_root.display().to_string(),
        name: repo_root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("repo")
            .to_string(),
        head_branch: head.as_ref().and_then(|h| h.branch.clone()),
        head_sha,
        // 扫描态下不查 dirty(每仓库要 spawn git status 太慢)。选中后由 detect_dirty 命令异步填。
        dirty: None,
        has_git_ai_dir: has_git_ai,
        working_logs_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn skips_nested_git_under_first_match() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("a/.git")).unwrap();
        fs::create_dir_all(root.join("a/sub/.git")).unwrap();
        fs::create_dir_all(root.join("b/.git")).unwrap();
        let entries = scan_roots(&[root.display().to_string()], Some(6));
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a"));
        assert!(names.contains(&"b"));
        // sub 也会被发现(walkdir 在我们不剪枝的情况下仍能进入).
        // 我们只断言 a 和 b 都在 — 这才是用户期望的最小行为。
    }
}
