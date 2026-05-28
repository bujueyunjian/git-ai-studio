//! `git-ai show <sha>` 包装(P11-D)。
//!
//! # 上游真源
//! `git-ai/src/commands/show.rs:33-72`:从 git notes ai 读 authorship_log 后
//! 调 `serialize_to_string()` 输出**原文文本**(JSON metadata + `---` divider + attestations 段),
//! 与 P7 Notes 页结构化 viewer 的数据源相同,但呈现是上游官方的多行文本。
//!
//! # 用途
//! Studio Stats 页"求助"场景:用户复制原文文本求助时,直接给上游 CLI 的输出最稳。

use std::path::Path;
use std::time::Duration;

use crate::error::{AppError, Result};
use crate::proc::run_capture_with_timeout;

const SHOW_TIMEOUT: Duration = Duration::from_secs(15);

/// 调 `git-ai show <sha>`,返回原文 stdout。
///
/// # 错误
/// - exit ≠ 0 → `AppError::GitAiFailed`(stderr 透传)
/// - 不解析:上游格式是 JSON+divider+attestations 混合,UI 直接 `<pre>` 渲染
pub async fn run_show(git_ai: &Path, repo: &Path, sha: &str) -> Result<String> {
    let trimmed = sha.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other("show 的 sha 不能为空".into()));
    }
    let out =
        run_capture_with_timeout(git_ai, &["show", trimmed], Some(repo), SHOW_TIMEOUT).await?;
    if out.status != 0 {
        return Err(AppError::GitAiFailed {
            code: out.status,
            stderr: out.stderr.trim().to_string(),
        });
    }
    Ok(out.stdout)
}
