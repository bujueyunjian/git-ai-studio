//! `git-ai stats --json` / `status --json` 的输出反序列化与归一。
//!
//! # 权威依据
//! 字段对齐 git-ai 上游 `src/authorship/stats.rs::CommitStats`
//! (`git-ai/src/authorship/stats.rs:9-33`,7 字段含 `tool_model_breakdown`)。
//!
//! # 公式
//! - `stats.rs:114`:`total_additions = human + unknown + ai`(3 桶并列)
//! - `stats.rs:116` 注释:`ai_additions == ai_accepted` 恒成立
//!
//! # No-fallback
//! - struct 带 `#[serde(default)]`,未来字段增减不破坏解析
//! - malformed JSON → `AppError::Json`

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::proc::run_capture_with_timeout;

const STATS_TIMEOUT: Duration = Duration::from_secs(15);

/// 范围聚合 `git-ai stats <range> --json` 的独立超时,远大于单 commit 的 15s。
///
/// # 为什么单独加长
/// 上游 `range_authorship.rs:119,131-135` 对整段 `start..end` 的 changed 文件做行级
/// blame 反查 prompt(squash 视角),**无 per-commit 缓存**,大/长历史仓库固有耗时 50s+。
/// 共享 15s `STATS_TIMEOUT` 会让首次打开 Dashboard 必然超时;range 结果由 Studio 自己
/// 缓存(`db::stats_cache::range`),冷启一次慢,之后命中秒回,故给它充裕的 180s 上限。
const RANGE_STATS_TIMEOUT: Duration = Duration::from_secs(180);

/// Git 内置的"空树"对象哈希。任何 git 仓库即使**未物理存储**这个对象,`git rev-parse`
/// 也会识别并接受它作为 ref-spec。`git rev-list <empty-tree>..<commit>` 行为等价于
/// `git rev-list <commit>`(从 commit 可达的全部 commit)。
///
/// # 用途
/// `run_range_stats` 在仓库根 commit 没有 parent 时,用此 hash 作为 start;
/// 与上游 `range_authorship::range_authorship` 对此 hash 的特判完全一致
/// (`git-ai/src/authorship/range_authorship.rs:18, 224`,
///  以及 `src/git/repository.rs:375` `CommitRange::is_valid` 对此 hash 跳验证)。
///
/// # 实测验证(2026-05-12)
/// 1. 单 commit 仓库 `git rev-parse --verify 4b825dc...` → 返回该 hash(不报错)
/// 2. `git rev-list 4b825dc..HEAD` → 返回 HEAD 可达全部 commit
/// 3. `git-ai stats 4b825dc..<sha> --json` → CommitRange::is_valid 跳过 start 验证
pub const EMPTY_TREE_HASH: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// `git-ai stats --json [sha]` 输出。字段与上游 `CommitStats` 完全一致。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AiStats {
    /// 上游注释:Number of lines committed with human attribution
    pub human_additions: u64,
    /// 上游注释:Number of lines with no attestation at all
    pub unknown_additions: u64,
    /// 上游注释:Number of lines committed with AI attribution
    pub ai_additions: u64,
    /// 上游注释:Number of AI-generated lines that were accepted by the user without any human edits
    /// 当前 schema 下 `ai_additions == ai_accepted` 恒成立(上游 stats.rs:116 注释)。
    pub ai_accepted: u64,
    pub git_diff_deleted_lines: u64,
    pub git_diff_added_lines: u64,
    /// key 形如 `"claude_code::claude-sonnet-4-5-20250929"`。
    /// runtime 真源 `git-ai/src/authorship/stats.rs:470,477` + `diff_ai_accepted.rs:62` 用
    /// `format!("{}::{}", tool, model)`(双冒号);上游 README 的单斜杠示例是过期文档,以代码为准。
    pub tool_model_breakdown: HashMap<String, ToolModelStats>,
}

/// 对齐上游 `ToolModelHeadlineStats`(`src/authorship/stats.rs:9-15`)。**只有 2 字段**。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ToolModelStats {
    pub ai_additions: u64,
    pub ai_accepted: u64,
}

/// `git-ai status --json` 输出(working dir 未提交改动)。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AiStatus {
    pub stats: AiStats,
    /// checkpoint 列表;schema 不稳定,以 Value 兜底保留(P8 再细化)。
    pub checkpoints: Vec<serde_json::Value>,
}

/// `git-ai stats <start>..<end> --json` 输出。
/// 字段对齐上游 `git-ai/src/authorship/range_authorship.rs:27-40`。
///
/// `range_stats` 是 **squash 视角**:`git diff start..end` 整 diff 作为一次大变更,
/// 然后对 end 态净新增行做 blame 反查 prompt(`diff_ai_accepted.rs:66`)。
/// 因此 P5 Dashboard 的"N 天累计"**不**用这个值,改用 per-commit cache 求和(累加视角)。
/// 本类型的真正用途是 `authorship_stats` 段:hook 覆盖率等仓库级健康指标。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct RangeAuthorshipStats {
    pub authorship_stats: RangeAuthorshipStatsData,
    pub range_stats: AiStats,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct RangeAuthorshipStatsData {
    pub total_commits: u64,
    pub commits_with_authorship: u64,
    /// 上游是 `HashSet<String>`(`range_authorship.rs:36`),序列化为 JSON 数组,顺序不稳定。
    pub authors_committing_authorship: std::collections::HashSet<String>,
    pub authors_not_committing_authorship: std::collections::HashSet<String>,
    pub commits_without_authorship: Vec<String>,
    /// `Vec<(sha, git_author)>` 上游用 tuple,JSON 编码为长度 2 的数组。
    pub commits_without_authorship_with_authors: Vec<(String, String)>,
}

impl AiStats {
    /// 上游 stats.rs:114 公式:**3 桶并列**相加。
    #[inline]
    pub fn total_additions(&self) -> u64 {
        self.human_additions
            .saturating_add(self.unknown_additions)
            .saturating_add(self.ai_additions)
    }
}

/// 纯函数:把子进程 (status, stdout, stderr) 三元组归一为 [`AiStats`] 或 [`AppError`]。
///
/// # 决策表
/// - `status == 0` → 反序列化 stdout 为 `AiStats`;坏 JSON 走 [`AppError::Json`]
/// - `status != 0` → [`AppError::GitAiFailed`],stderr 经 `trim` 透传给前端 toast
///
/// 抽离的目的:让 status≠0 错误归类可单测(否则需要 spawn 真实失败子进程)。
fn parse_stats_response(status: i32, stdout: &str, stderr: &str) -> Result<AiStats> {
    if status != 0 {
        return Err(AppError::GitAiFailed {
            code: status,
            stderr: stderr.trim().to_string(),
        });
    }
    serde_json::from_str::<AiStats>(stdout).map_err(AppError::Json)
}

/// 纯函数:同 [`parse_stats_response`],但产出 [`AiStatus`]。
fn parse_status_response(status: i32, stdout: &str, stderr: &str) -> Result<AiStatus> {
    if status != 0 {
        return Err(AppError::GitAiFailed {
            code: status,
            stderr: stderr.trim().to_string(),
        });
    }
    serde_json::from_str::<AiStatus>(stdout).map_err(AppError::Json)
}

/// 调 `git-ai stats [sha] --json`。失败统一为 [`AppError`],由上层 commands 决定 degraded / toast。
pub async fn run_stats(git_ai: &Path, repo: &Path, sha: Option<&str>) -> Result<AiStats> {
    let mut args: Vec<&str> = vec!["stats"];
    if let Some(s) = sha {
        args.push(s);
    }
    args.push("--json");

    let out = run_capture_with_timeout(git_ai, &args, Some(repo), STATS_TIMEOUT).await?;
    parse_stats_response(out.status, &out.stdout, &out.stderr)
}

/// 调 `git-ai status --json`(working dir 未提交)。
pub async fn run_status(git_ai: &Path, repo: &Path) -> Result<AiStatus> {
    let out =
        run_capture_with_timeout(git_ai, &["status", "--json"], Some(repo), STATS_TIMEOUT).await?;
    parse_status_response(out.status, &out.stdout, &out.stderr)
}

/// 调 `git-ai stats <start>..<end> --json`,解析 [`RangeAuthorshipStats`]。
pub async fn run_range_stats(
    git_ai: &Path,
    repo: &Path,
    start_sha: &str,
    end_sha: &str,
) -> Result<RangeAuthorshipStats> {
    let range_arg = format!("{start_sha}..{end_sha}");
    let out = run_capture_with_timeout(
        git_ai,
        &["stats", &range_arg, "--json"],
        Some(repo),
        RANGE_STATS_TIMEOUT,
    )
    .await?;
    if out.status != 0 {
        return Err(AppError::GitAiFailed {
            code: out.status,
            stderr: out.stderr.trim().to_string(),
        });
    }
    serde_json::from_str::<RangeAuthorshipStats>(&out.stdout).map_err(AppError::Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 来源:git-ai 上游 runtime 真源(stats.rs:470,477 + diff_ai_accepted.rs:62)
    // tool_model key 用 `tool::model` 双冒号拼接;数值取自上游 README 示例。
    const README_EXAMPLE: &str = r#"{
        "human_additions": 28,
        "unknown_additions": 0,
        "ai_additions": 76,
        "ai_accepted": 76,
        "git_diff_deleted_lines": 34,
        "git_diff_added_lines": 104,
        "tool_model_breakdown": {
            "claude_code::claude-sonnet-4-5-20250929": {
                "ai_additions": 76,
                "ai_accepted": 76
            }
        }
    }"#;

    // merge commit:上游 spec v3.0.0 §2.2 — "merge commit MAY have an empty authorship log",
    // 实际 stats 输出全 0。
    const MERGE: &str = r#"{
        "human_additions":0,"unknown_additions":0,
        "ai_additions":0,"ai_accepted":0,
        "git_diff_deleted_lines":0,"git_diff_added_lines":0,
        "tool_model_breakdown":{}
    }"#;

    // 全 unknown:新装 git-ai 还没 checkpoint 时,所有 additions 都无 attestation。
    const ALL_UNKNOWN: &str = r#"{
        "human_additions":0,"unknown_additions":500,
        "ai_additions":0,"ai_accepted":0,
        "git_diff_deleted_lines":12,"git_diff_added_lines":500,
        "tool_model_breakdown":{}
    }"#;

    // 多 tool 并存,3 桶非零。
    const MULTI_TOOL: &str = r#"{
        "human_additions":120,"unknown_additions":15,
        "ai_additions":80,"ai_accepted":80,
        "git_diff_deleted_lines":20,"git_diff_added_lines":215,
        "tool_model_breakdown":{
            "claude_code::claude-opus-4-7":{"ai_additions":60,"ai_accepted":60},
            "cursor::gpt-5":{"ai_additions":20,"ai_accepted":20}
        }
    }"#;

    const EMPTY: &str = r#"{}"#;

    #[test]
    #[allow(clippy::identity_op)]
    fn parse_readme_example() {
        let s: AiStats = serde_json::from_str(README_EXAMPLE).unwrap();
        assert_eq!(s.human_additions, 28);
        assert_eq!(s.ai_additions, 76);
        assert_eq!(s.ai_accepted, 76);
        // 上游不变式(stats.rs:116):ai_additions == ai_accepted
        assert_eq!(s.ai_additions, s.ai_accepted);
        // 上游 stats.rs:114 公式:total = human + unknown + ai(3 桶并列,保留 + 0 显示语义)
        assert_eq!(s.total_additions(), 28 + 0 + 76);
        // git_diff_added_lines 是 git 自身视角,可能含 mixed 等差异(本例 104 vs 总 104)。
        // 不在测试里强制等于 total_additions,避免锁死 git-ai 的内部口径。
    }

    #[test]
    fn parse_merge_all_zero() {
        let s: AiStats = serde_json::from_str(MERGE).unwrap();
        assert_eq!(s.total_additions(), 0);
        assert!(s.tool_model_breakdown.is_empty());
    }

    #[test]
    fn parse_all_unknown() {
        let s: AiStats = serde_json::from_str(ALL_UNKNOWN).unwrap();
        assert_eq!(s.unknown_additions, 500);
        assert_eq!(s.total_additions(), 500);
        assert_eq!(s.ai_additions, 0);
        assert_eq!(s.ai_accepted, 0);
    }

    #[test]
    fn parse_multi_tool() {
        let s: AiStats = serde_json::from_str(MULTI_TOOL).unwrap();
        assert_eq!(s.total_additions(), 120 + 15 + 80);
        assert_eq!(s.tool_model_breakdown.len(), 2);
        let claude = s
            .tool_model_breakdown
            .get("claude_code::claude-opus-4-7")
            .unwrap();
        assert_eq!(claude.ai_additions, 60);
        assert_eq!(claude.ai_accepted, 60);
    }

    #[test]
    fn parse_empty_yields_defaults() {
        let s: AiStats = serde_json::from_str(EMPTY).unwrap();
        assert_eq!(s.total_additions(), 0);
        assert!(s.tool_model_breakdown.is_empty());
    }

    #[test]
    fn unknown_fields_ignored() {
        // 未来 schema 加字段或保留旧字段(如团队 fork 仍带 mixed_additions),serde_json 会丢弃。
        let json = r#"{
            "ai_additions":1,"git_diff_added_lines":1,
            "mixed_additions":99,
            "some_future_field":"whatever"
        }"#;
        let s: AiStats = serde_json::from_str(json).unwrap();
        assert_eq!(s.ai_additions, 1);
        // 即使 JSON 里有 mixed_additions,struct 没有此字段 —— 直接丢弃。
    }

    #[test]
    fn malformed_json_fails_fast() {
        // No-fallback 约束:坏 JSON 必须报错,不要静默回退 0。
        let bad = r#"{"ai_additions":"three"}"#;
        let r: std::result::Result<AiStats, _> = serde_json::from_str(bad);
        assert!(r.is_err(), "字段类型错应解析失败而非默认 0");
    }

    #[test]
    fn status_parses_with_empty_checkpoints() {
        let json = r#"{"stats":{"ai_additions":2,"git_diff_added_lines":2},"checkpoints":[]}"#;
        let st: AiStatus = serde_json::from_str(json).unwrap();
        assert_eq!(st.stats.ai_additions, 2);
        assert!(st.checkpoints.is_empty());
    }

    // ===== RangeAuthorshipStats(P5) =====
    //
    // fixture 字段顺序与上游 `git-ai/src/authorship/range_authorship.rs:27-40` 完全对齐。
    // `commits_without_authorship_with_authors` 上游是 `Vec<(String, String)>`,JSON 编码为
    // 长度 2 的数组,serde 默认按 tuple 反序列化。
    const RANGE_NORMAL: &str = r#"{
        "authorship_stats": {
            "total_commits": 12,
            "commits_with_authorship": 9,
            "authors_committing_authorship": ["alice", "bob"],
            "authors_not_committing_authorship": ["charlie"],
            "commits_without_authorship": ["sha-x", "sha-y", "sha-z"],
            "commits_without_authorship_with_authors": [
                ["sha-x", "charlie"],
                ["sha-y", "charlie"],
                ["sha-z", "alice"]
            ]
        },
        "range_stats": {
            "human_additions": 120,
            "unknown_additions": 30,
            "ai_additions": 80,
            "ai_accepted": 80,
            "git_diff_deleted_lines": 20,
            "git_diff_added_lines": 230,
            "tool_model_breakdown": {
                "claude_code/claude-opus-4-7": {"ai_additions": 80, "ai_accepted": 80}
            }
        }
    }"#;

    #[test]
    fn parse_range_authorship_stats() {
        let r: RangeAuthorshipStats = serde_json::from_str(RANGE_NORMAL).unwrap();
        assert_eq!(r.authorship_stats.total_commits, 12);
        assert_eq!(r.authorship_stats.commits_with_authorship, 9);
        assert_eq!(r.authorship_stats.authors_committing_authorship.len(), 2);
        assert!(r
            .authorship_stats
            .authors_committing_authorship
            .contains("alice"));
        assert!(r
            .authorship_stats
            .authors_committing_authorship
            .contains("bob"));
        assert_eq!(r.authorship_stats.commits_without_authorship.len(), 3);
        // tuple 是按数组顺序入 Vec,保留顺序
        assert_eq!(
            r.authorship_stats.commits_without_authorship_with_authors[0],
            ("sha-x".to_string(), "charlie".to_string())
        );
        // range_stats 是 squash 视角的 AiStats,字段完全一致
        assert_eq!(r.range_stats.ai_additions, 80);
        assert_eq!(r.range_stats.total_additions(), 230);
    }

    #[test]
    fn range_stats_empty_yields_defaults() {
        let r: RangeAuthorshipStats = serde_json::from_str("{}").unwrap();
        assert_eq!(r.authorship_stats.total_commits, 0);
        assert!(r.authorship_stats.commits_without_authorship.is_empty());
        assert_eq!(r.range_stats.total_additions(), 0);
    }

    // ===== exit code 非 0 stderr 透传 (P10 #14) =====
    //
    // 真源:`run_capture_with_timeout` 已有覆盖,这里只针对 `parse_*_response` 的决策分支:
    //   - status == 0 + valid JSON → Ok
    //   - status != 0           → AppError::GitAiFailed{code, stderr-trimmed}
    //   - status == 0 + bad JSON → AppError::Json
    // 错误用 `match` 解构变体,而非字符串比较,避免锁死 thiserror Display 文案。

    #[test]
    #[allow(clippy::identity_op)]
    fn parse_stats_response_ok_when_exit_zero() {
        let out = parse_stats_response(0, README_EXAMPLE, "").expect("exit=0 valid JSON 应 Ok");
        assert_eq!(out.ai_additions, 76);
        assert_eq!(out.total_additions(), 28 + 0 + 76);
    }

    #[test]
    fn parse_stats_response_propagates_stderr_on_nonzero_exit() {
        let err = parse_stats_response(1, "", "fatal: not a git repository").unwrap_err();
        match err {
            AppError::GitAiFailed { code, stderr } => {
                assert_eq!(code, 1);
                assert_eq!(stderr, "fatal: not a git repository");
            }
            other => panic!("expected GitAiFailed, got {other:?}"),
        }
    }

    #[test]
    fn parse_stats_response_trims_multiline_stderr() {
        // git-ai 失败时常多行输出,我方约定 trim 头尾空白(`stderr.trim().to_string()`)。
        // 这个测试锁死 trim 行为,防止以后误改成原样透传或更激进的清洗。
        let raw = "\n  error: bad ref\n  hint: run git-ai install\n  ";
        let err = parse_stats_response(2, "", raw).unwrap_err();
        match err {
            AppError::GitAiFailed { code, stderr } => {
                assert_eq!(code, 2);
                assert_eq!(stderr, "error: bad ref\n  hint: run git-ai install");
            }
            other => panic!("expected GitAiFailed, got {other:?}"),
        }
    }

    #[test]
    fn parse_stats_response_malformed_json_yields_json_err() {
        // exit=0 但 stdout 不是合法 JSON(或字段类型错):必须报 Json,绝不静默 default。
        let err = parse_stats_response(0, r#"{"ai_additions":"three"}"#, "").unwrap_err();
        assert!(
            matches!(err, AppError::Json(_)),
            "expected AppError::Json, got {err:?}"
        );
    }

    #[test]
    fn parse_status_response_ok_when_exit_zero() {
        let json = r#"{"stats":{"ai_additions":2,"git_diff_added_lines":2},"checkpoints":[]}"#;
        let out = parse_status_response(0, json, "").expect("exit=0 valid JSON 应 Ok");
        assert_eq!(out.stats.ai_additions, 2);
        assert!(out.checkpoints.is_empty());
    }

    #[test]
    fn parse_status_response_propagates_stderr_on_nonzero_exit() {
        let err = parse_status_response(127, "", "git-ai: command not found").unwrap_err();
        match err {
            AppError::GitAiFailed { code, stderr } => {
                assert_eq!(code, 127);
                assert_eq!(stderr, "git-ai: command not found");
            }
            other => panic!("expected GitAiFailed, got {other:?}"),
        }
    }

    #[test]
    fn parse_status_response_malformed_json_yields_json_err() {
        // `checkpoints` 应是数组,这里给 number → serde 失败,必须报 Json。
        let err = parse_status_response(0, r#"{"stats":{},"checkpoints":42}"#, "").unwrap_err();
        assert!(
            matches!(err, AppError::Json(_)),
            "expected AppError::Json, got {err:?}"
        );
    }

    #[test]
    fn empty_tree_hash_matches_upstream_constant() {
        // 上游 git-ai/src/authorship/range_authorship.rs:18 与
        //      git-ai/src/git/repository.rs:375 都用同一字面值。
        // 这是 git 内置的"空树"对象 SHA-1,任何 git 仓库都接受。
        assert_eq!(EMPTY_TREE_HASH, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
        assert_eq!(EMPTY_TREE_HASH.len(), 40);
        assert!(EMPTY_TREE_HASH.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
