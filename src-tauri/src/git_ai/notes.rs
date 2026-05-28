//! `refs/notes/ai` 的轻量探测,用于 stats cache 失效判定。
//!
//! # 为什么
//! `git-ai stats <sha> --json` 依赖 `git notes --ref=ai show <sha>`(上游
//! `git-ai/src/authorship/stats.rs:388 get_authorship`)。后续 checkpoint 补打 /
//! rewrite-authorship 会改 notes,使同一 commit 的 stats 输出变化 → SQLite cache 必须按
//! notes 状态做失效。
//!
//! # 怎么拿"当前 notes 状态"
//! `git notes --ref=ai list <sha>` 在该 commit **有** notes 时返回一行 `<note_blob_oid> <sha>`,
//! **无** notes 时输出空。`<note_blob_oid>` 是 git 对象 OID,内容变就变,是天然的版本指纹。
//! 空输出我们规整为空串 `""`,空串与空串相等也算"无 notes 状态一致"。

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use crate::error::{AppError, Result};
use crate::proc::run_capture_with_timeout;

const GIT_TIMEOUT: Duration = Duration::from_secs(10);
use super::{is_missing_notes_ref, NOTES_REF};

/// 一次性拉取整个仓库的 `commit_sha → notes_oid` 映射。
///
/// 对 N 个 commit 做 stats cache 失效判定时,**不要**对每个 sha 单独跑 `git notes list <sha>`
/// (N 次子进程 = 数十秒);跑一次 `git notes --ref=ai list`(无参数)拉全量,内存 HashMap 查询。
///
/// 输出格式:每行 `<note_blob_oid> <commit_sha>`,空仓 / 无 ai notes 时 stdout 空,返回空 map。
pub async fn read_all_notes_oids(repo: &Path) -> Result<HashMap<String, String>> {
    let git = which::which("git").map_err(|_| AppError::Other("未找到 git 二进制".into()))?;
    let out = run_capture_with_timeout(
        &git,
        &["notes", "--ref", NOTES_REF, "list"],
        Some(repo),
        GIT_TIMEOUT,
    )
    .await?;
    if out.status != 0 {
        if is_missing_notes_ref(&out.stderr) {
            return Ok(HashMap::new());
        }
        return Err(AppError::Other(format!(
            "git notes list(all)退出码 {}: {}",
            out.status,
            out.stderr.trim()
        )));
    }
    let mut map = HashMap::new();
    for line in out.stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let oid = match parts.next() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let sha = match parts.next() {
            Some(s) => s.to_string(),
            None => continue,
        };
        map.insert(sha, oid);
    }
    Ok(map)
}

/// 读 `refs/notes/ai` 的 **ref OID**(整棵 notes 树的指纹,非单 commit 的 note blob OID)。
///
/// # 用途
/// range 聚合 `git-ai stats <start>..<end> --json` 会对整段 commit 的 authorship 做汇总,
/// 任一 commit 的 ai notes 变化都会改变结果。逐 commit 比对 note blob OID 在 range 缓存里
/// 不现实(commit 集合随窗口浮动),改用 `refs/notes/ai` 这一个 ref OID 作粗粒度失效维度:
/// notes 树**任意**变动 → ref OID 变 → range 缓存整体失效重跑。比 per-commit 缓存更保守,
/// 但 range 结果天然是仓库级粗粒度,这个权衡可接受。
///
/// 返回:
/// - `Ok(Some(oid))` —— ref 存在
/// - `Ok(None)` —— `refs/notes/ai` 尚不存在(合法初始态,与 `is_missing_notes_ref` 对称)
/// - `Err(_)` —— 真错误(非 git 仓库 / 权限等),fail-fast 不吞
pub async fn read_notes_ref_oid(repo: &Path) -> Result<Option<String>> {
    let git = which::which("git").map_err(|_| AppError::Other("未找到 git 二进制".into()))?;
    let out = run_capture_with_timeout(
        &git,
        &["rev-parse", "--verify", "--quiet", NOTES_REF],
        Some(repo),
        GIT_TIMEOUT,
    )
    .await?;
    // `--verify --quiet`:ref 不存在时退出码非 0 且 stdout 空,不打印错误。
    if out.status != 0 {
        if is_missing_notes_ref(&out.stderr) {
            return Ok(None);
        }
        return Err(AppError::Other(format!(
            "git rev-parse {NOTES_REF} 退出码 {}: {}",
            out.status,
            out.stderr.trim()
        )));
    }
    let oid = out.stdout.trim();
    if oid.is_empty() {
        Ok(None)
    } else {
        Ok(Some(oid.to_string()))
    }
}

/// 解析 `git notes --ref=ai list`(无参数,全量)的 stdout。提出来作为公共纯函数让单测能直接覆盖。
pub fn parse_all_notes_list(stdout: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let oid = match parts.next() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let sha = match parts.next() {
            Some(s) => s.to_string(),
            None => continue,
        };
        map.insert(sha, oid);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_stdout_yields_empty_map() {
        assert!(parse_all_notes_list("").is_empty());
        assert!(parse_all_notes_list("   \n  \n").is_empty());
    }

    #[test]
    fn note_list_two_columns() {
        let s = "abc123 sha-1\ndef456 sha-2\n";
        let m = parse_all_notes_list(s);
        assert_eq!(m.len(), 2);
        assert_eq!(m.get("sha-1").unwrap(), "abc123");
        assert_eq!(m.get("sha-2").unwrap(), "def456");
    }

    #[test]
    fn missing_notes_ref_strict_match() {
        // 合法初始态:refs/notes/ai 不存在
        assert!(is_missing_notes_ref(""));
        assert!(is_missing_notes_ref("error: refs/notes/ai does not exist."));
        assert!(is_missing_notes_ref("refs/notes/ai not found"));
        // 真错误绝对不能吞:
        assert!(!is_missing_notes_ref(
            "fatal: not a git repository (or any parent up to mount point /)"
        ));
        assert!(!is_missing_notes_ref("fatal: file does not exist")); // 文件不是 ref,不能吞
        assert!(!is_missing_notes_ref("fatal: permission denied"));
        assert!(!is_missing_notes_ref(
            "error: object 0123456789 does not exist"
        )); // commit 对象缺失 ≠ notes ref 不存在
    }

    #[test]
    fn malformed_lines_skipped() {
        // 真正缺第二列的行(只有 1 个 whitespace-separated token)被跳过,不破坏整体解析
        let s = "lone-token-no-sha\nvalid-oid valid-sha\n";
        let m = parse_all_notes_list(s);
        assert_eq!(m.len(), 1);
        assert_eq!(m.get("valid-sha").unwrap(), "valid-oid");
    }
}
