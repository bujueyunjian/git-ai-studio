//! `.git-ai-ignore` 摘要,用于 SQLite stats cache 的失效判定。
//!
//! # 为什么需要 hash(P10 #29)
//! `git-ai stats <sha> --json` 的 ignore 处理路径在
//! `git-ai/src/authorship/ignore.rs::effective_ignore_patterns`(230-243 行):
//!
//! ```text
//! 1. default_ignore_patterns()                                 (7-39 行)
//! 2. + .gitattributes 中 linguist-generated=true 段             (102-153 行)
//! 3. + repo 根 .git-ai-ignore                                   (171-187 行)
//! 4. + extra_patterns(CLI)
//! 5. + user_patterns(.git/config 等)
//! 6. dedupe
//! ```
//!
//! 我方通过 git-ai 子进程拿 stats(不传 CLI ignore),`.git-ai-ignore` 改动会让同一 commit 的输出变化,
//! 但 SQLite cache 只看 `notes_oid`,无法感知 ignore 变化。本模块计算 `.git-ai-ignore` 文件内容的
//! SHA-256,存入 cache 行,查询时一并比对。
//!
//! # 范围
//! - 只 hash 仓库根 `.git-ai-ignore`(对齐上游 `load_root_git_ai_ignore_contents` 173-200 行)
//! - 不 hash `.gitattributes`:上游只取 linguist-generated 段,本身用户改 `.gitattributes`
//!   多半也会 commit,与 stats 一起作用域变化;P10 任务范围只覆盖 `.git-ai-ignore`,
//!   `.gitattributes` 列入未来 issue
//! - 不 hash `default_ignore_patterns()`:它由 git-ai 版本决定,git-ai 升级时 cache 自然失效是另一回事
//!
//! # 失效行为
//! - 文件不存在 → 空串 `""`(与"上游加载到空 patterns"语义一致)
//! - 文件存在但空 → 仍计算 SHA-256(`e3b0...` 空串 hash);与"文件不存在"区分
//! - 文件读失败(权限等)→ Error 透出,**不静默退化为空**(memory#6 no-fallback)

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, Result};
use crate::proc::run_capture_with_timeout;

/// 仓库根下的 `.git-ai-ignore` 文件名,与上游 `ignore.rs:198` 一致。
const GIT_AI_IGNORE_FILENAME: &str = ".git-ai-ignore";

/// 计算 `.git-ai-ignore` 内容的 SHA-256 hex digest。
///
/// 返回:
/// - `Ok("")` —— 文件不存在(对齐上游 `load_git_ai_ignore_patterns` 返回空 Vec 的语义)
/// - `Ok(hex)` —— 64 字符小写 hex
/// - `Err(_)` —— 读文件失败(权限 / IO 等),由调用方决定是否阻断
pub fn compute_ignore_hash(repo_root: &Path) -> Result<String> {
    let path = repo_root.join(GIT_AI_IGNORE_FILENAME);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(AppError::Other(format!("读 {} 失败: {e}", path.display()))),
    };
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

// ============================================================================
// effective-ignore-patterns(P11-C):调上游 `git-ai effective-ignore-patterns --json`
// ============================================================================

/// `git-ai effective-ignore-patterns` 的请求 / 响应 schema,镜像上游
/// `git-ai/src/commands/git_ai_handlers.rs:499-507`。
#[derive(Debug, Clone, Serialize)]
struct EffectivePatternsRequest {
    user_patterns: Vec<String>,
    extra_patterns: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct EffectivePatternsResponse {
    patterns: Vec<String>,
}

const EFFECTIVE_PATTERNS_TIMEOUT: Duration = Duration::from_secs(5);

/// 调上游 CLI 拿当前仓库实际生效的 ignore patterns 合并结果(默认 + .gitattributes
/// linguist-generated + .git-ai-ignore + 用户/extra)。Studio UI 用它做"信任感"展示,
/// 让用户**看见**到底排除了哪些文件,而不是只算 hash。
///
/// # 入参
/// `user_patterns` / `extra_patterns` 当前都传空 —— Studio 不需要叠加自己的 patterns。
/// 上游 CLI 仍把这两参当必填(`deny_unknown_fields` 严格 JSON),所以必须给空数组,不能省略。
pub async fn run_effective_patterns(git_ai: &Path, repo: &Path) -> Result<Vec<String>> {
    let request = EffectivePatternsRequest {
        user_patterns: Vec::new(),
        extra_patterns: Vec::new(),
    };
    let payload = serde_json::to_string(&request).map_err(AppError::Json)?;
    let out = run_capture_with_timeout(
        git_ai,
        &["effective-ignore-patterns", "--json", &payload],
        Some(repo),
        EFFECTIVE_PATTERNS_TIMEOUT,
    )
    .await?;
    if out.status != 0 {
        return Err(AppError::GitAiFailed {
            code: out.status,
            stderr: out.stderr.trim().to_string(),
        });
    }
    let resp: EffectivePatternsResponse =
        serde_json::from_str(out.stdout.trim()).map_err(AppError::Json)?;
    Ok(resp.patterns)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn missing_file_returns_empty_string() {
        let tmp = TempDir::new().unwrap();
        let h = compute_ignore_hash(tmp.path()).unwrap();
        assert_eq!(h, "");
    }

    #[test]
    fn empty_file_hashes_to_sha256_empty() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(".git-ai-ignore"), "").unwrap();
        let h = compute_ignore_hash(tmp.path()).unwrap();
        // SHA-256 of empty string
        assert_eq!(
            h,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn content_change_changes_hash() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".git-ai-ignore");
        fs::write(&path, "*.lock\n").unwrap();
        let h1 = compute_ignore_hash(tmp.path()).unwrap();
        fs::write(&path, "*.lock\n*.snap\n").unwrap();
        let h2 = compute_ignore_hash(tmp.path()).unwrap();
        assert_ne!(h1, h2);
        assert_eq!(h1.len(), 64);
        assert_eq!(h2.len(), 64);
    }

    #[test]
    fn identical_content_same_hash() {
        let tmp1 = TempDir::new().unwrap();
        let tmp2 = TempDir::new().unwrap();
        fs::write(tmp1.path().join(".git-ai-ignore"), "*.lock\n").unwrap();
        fs::write(tmp2.path().join(".git-ai-ignore"), "*.lock\n").unwrap();
        assert_eq!(
            compute_ignore_hash(tmp1.path()).unwrap(),
            compute_ignore_hash(tmp2.path()).unwrap()
        );
    }

    #[test]
    fn whitespace_difference_changes_hash() {
        // 上游 load_git_ai_ignore_patterns 会 trim + 去空行,但 raw bytes 不同 → hash 不同。
        // 这是可接受的"过度失效":用户加空行 → cache miss → 重跑结果一致。
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".git-ai-ignore");
        fs::write(&path, "*.lock").unwrap();
        let h1 = compute_ignore_hash(tmp.path()).unwrap();
        fs::write(&path, "*.lock\n").unwrap();
        let h2 = compute_ignore_hash(tmp.path()).unwrap();
        assert_ne!(h1, h2);
    }
}
