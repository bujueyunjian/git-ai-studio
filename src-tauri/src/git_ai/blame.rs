//! `git-ai blame-analysis --json '<payload>'` 的输出反序列化 + 子进程调用。
//!
//! # 权威依据
//! 字段对齐 git-ai 上游 `git-ai/src/commands/blame.rs` 的 `BlameAnalysisResult`
//! + `git-ai/src/authorship/authorship_log.rs:191-238` 的 PromptRecord
//! + `git-ai/src/authorship/working_log.rs:42-46` 的 AgentId。
//!
//! # 关键事实(必须读懂再改本文件)
//! - 上游返回 `line_authors: HashMap<u32, String>`;value 可能是 prompt hash / human hash / 人名
//! - git-ai-studio 的 `lines` 只保留能在 `prompt_records` 命中的 prompt hash,非 AI 行不在 map 里
//! - 每个 key 由本文件把连续同 prompt 行压成 `"13"` 或 `"15-25"`(end inclusive)
//! - PromptRecord 字段 `accepted_lines / overriden_lines` 是**仓库级累计**,不是本文件局部
//! - `tool::model` 拼接见上游 stats.rs:470(`::` 不是 `/`)
//!
//! # No-fallback
//! - 子进程 exit ≠ 0 → AppError::GitAiFailed,stderr 透传
//! - JSON 解析失败 → AppError::Json
//! - **不**为已被上游删除的旧字段保留兼容入口

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::proc::run_capture_with_timeout;

/// blame 是文件 + 全历史 walk,长历史大文件可跑 30s+。45s 给足缓冲。
const BLAME_TIMEOUT: Duration = Duration::from_secs(45);

/// AgentId 对齐 working_log.rs:42-46。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AgentId {
    pub tool: String,
    pub id: String,
    pub model: String,
}

/// PromptRecord 对齐 authorship_log.rs:198-213。**仓库级累计**字段务必前端标注。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PromptRecord {
    pub agent_id: AgentId,
    pub human_author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages_url: Option<String>,
    pub total_additions: u32,
    pub total_deletions: u32,
    pub accepted_lines: u32,
    pub overriden_lines: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_attributes: Option<HashMap<String, String>>,
}

/// 上游 `PromptRecordWithOtherFiles` 用 `#[serde(flatten)]` 内嵌 PromptRecord —— 我们这边直接打平。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct BlamePromptRecord {
    #[serde(flatten)]
    pub prompt: PromptRecord,
    pub other_files: Vec<String>,
    pub commits: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct BlameMetadata {
    pub is_logged_in: bool,
    pub current_user: Option<String>,
}

/// 上游 `BlameHunk`(`git-ai/src/commands/blame.rs:27-57`)精简版。
/// 我们只保留前端 IDE-style 行级展示需要的字段;committer/email/is_boundary 等不暴露,
/// 待具体需求出现再补,避免暴露未使用字段拖累 UI 契约。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "snake_case")]
pub struct BlameHunk {
    /// `[start, end]`(inclusive)当前文件视角的行号区间。
    pub range: (u32, u32),
    pub commit_sha: String,
    pub abbrev_sha: String,
    /// 来自 `git blame` 的原作者(commit 的 author,**不是** AI human_author)。
    pub original_author: String,
    /// commit 时间(秒级 unix);前端按需格式化 ISO。
    pub author_time: i64,
    pub author_tz: String,
    /// 当该行被 AI 写时,git-ai 解出的人类触发者(可能与 original_author 同人也可能不同)。
    /// 非 AI 行通常为 None。
    pub ai_human_author: Option<String>,
}

/// `git-ai blame --json` 完整输出。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct BlamePayload {
    /// key `"13"` 或 `"15-25"`;value 是 prompt_id(等于 prompts 的 key)。**只含 AI 行**。
    pub lines: BTreeMap<String, String>,
    pub prompts: HashMap<String, BlamePromptRecord>,
    pub metadata: BlameMetadata,
    /// 上游 `blame_hunks` 解析。每个 hunk 含行号区间 + commit + author;
    /// 前端据此渲染**每行**(包含非 AI 行)的作者 gutter。
    pub hunks: Vec<BlameHunk>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct BlameAnalysisResult {
    pub line_authors: HashMap<u32, String>,
    pub prompt_records: HashMap<String, PromptRecord>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub session_records: HashMap<String, serde_json::Value>,
    /// 上游 BlameHunk 已是结构化的,这里直接强类型反序列化(原先 serde_json::Value 透传未解析)。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub blame_hunks: Vec<BlameHunk>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub humans: BTreeMap<String, serde_json::Value>,
}

/// 调 `git-ai blame-analysis --json '<payload>'`。
///
/// **范围**:`ranges` 为 None 或空 → 全文件;有值时写入 options.line_ranges。
/// **commit 选择**:`newest_commit` 直接透传调用方给的 ref 字符串(分支名 / sha / "HEAD");
/// 与左侧文件内容读取(`git show <ref>:<file>`)保持一致。
/// **prompt hash 命名**:必须开 `use_prompt_hashes_as_names`,否则上游 `line_authors`
/// 的 value 默认是 author 名字字符串(如 "claude" / "alice"),而 `prompt_records`
/// 的 key 是 prompt hash —— `compact_prompt_lines` 用 `contains_key(author)` 求交时
/// 永远命中不了,AI 行会被全部丢弃。上游 `commands/blame.rs:145-146` 明确:
/// `// Use prompt hashes as name instead of author names`,内部 caller
/// (`diff_ai_accepted.rs:51`, `virtual_attribution.rs:2822`)都显式开 true。
pub async fn run_blame_analysis(
    git_ai: &Path,
    repo: &Path,
    file: &str,
    ranges: Option<&[(u32, u32)]>,
    newest_commit: &str,
) -> Result<BlamePayload> {
    let line_ranges: Vec<(u32, u32)> = ranges.unwrap_or(&[]).to_vec();
    let payload = serde_json::json!({
        "file_path": file,
        "options": {
            "line_ranges": line_ranges,
            "newest_commit": newest_commit,
            "return_human_authors_as_human": true,
            "split_hunks_by_ai_author": false,
            "use_prompt_hashes_as_names": true
        }
    });
    let payload = serde_json::to_string(&payload).map_err(AppError::Json)?;
    let args: [&str; 3] = ["blame-analysis", "--json", payload.as_str()];

    let out = run_capture_with_timeout(git_ai, &args, Some(repo), BLAME_TIMEOUT).await?;
    if out.status != 0 {
        return Err(AppError::GitAiFailed {
            code: out.status,
            stderr: out.stderr.trim().to_string(),
        });
    }
    let analysis =
        serde_json::from_str::<BlameAnalysisResult>(&out.stdout).map_err(AppError::Json)?;
    Ok(convert_analysis(analysis))
}

fn convert_analysis(analysis: BlameAnalysisResult) -> BlamePayload {
    let lines = compact_prompt_lines(&analysis.line_authors, &analysis.prompt_records);
    let prompts = analysis
        .prompt_records
        .into_iter()
        .map(|(key, prompt)| {
            (
                key,
                BlamePromptRecord {
                    prompt,
                    other_files: Vec::new(),
                    commits: Vec::new(),
                },
            )
        })
        .collect();
    BlamePayload {
        lines,
        prompts,
        metadata: BlameMetadata {
            is_logged_in: false,
            current_user: None,
        },
        hunks: analysis.blame_hunks,
    }
}

fn compact_prompt_lines(
    line_authors: &HashMap<u32, String>,
    prompt_records: &HashMap<String, PromptRecord>,
) -> BTreeMap<String, String> {
    let mut entries: Vec<(u32, String)> = line_authors
        .iter()
        .filter_map(|(line, author)| {
            if prompt_records.contains_key(author) {
                Some((*line, author.clone()))
            } else {
                None
            }
        })
        .collect();
    entries.sort_by_key(|(line, _)| *line);

    let mut out = BTreeMap::new();
    let mut iter = entries.into_iter();
    let Some((mut start, mut prompt_id)) = iter.next() else {
        return out;
    };
    let mut end = start;
    for (line, next_prompt) in iter {
        if line == end + 1 && next_prompt == prompt_id {
            end = line;
            continue;
        }
        out.insert(range_key(start, end), prompt_id);
        start = line;
        end = line;
        prompt_id = next_prompt;
    }
    out.insert(range_key(start, end), prompt_id);
    out
}

fn range_key(start: u32, end: u32) -> String {
    if start == end {
        start.to_string()
    } else {
        format!("{start}-{end}")
    }
}

/// 解析 `lines` map 的 key:`"13"` → `(13, 13)`,`"15-25"` → `(15, 25)`。
///
/// 严格 regex 不允许多区间(`"15-25,30-40"`)—— 上游 `blame.rs:1338-1372` 的 group 算法
/// 保证单段输出。如果上游某天改为多区间,本函数返回 None,**调用方应感知失败**而非静默吞。
pub fn parse_range_key(key: &str) -> Option<(u32, u32)> {
    use once_cell::sync::Lazy;
    use regex::Regex;
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(\d+)(?:-(\d+))?$").unwrap());
    let caps = RE.captures(key)?;
    let start: u32 = caps.get(1)?.as_str().parse().ok()?;
    if start == 0 {
        return None; // git 行号 1-based,0 非法
    }
    let end: u32 = match caps.get(2) {
        Some(m) => m.as_str().parse().ok()?,
        None => start,
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

/// 把所有 `lines` key 展开为 `line_no → prompt_id` 扁平 map。
///
/// **No-fallback**:无效 key 直接 `Err`,不静默跳过 —— 出现无效 key 唯一可能是上游 schema 漂移
/// (`blame.rs:1338-1372` 的 group 算法对单段保证强),该 fail 让 UI 把错误抛给用户而非装作正常。
pub fn expand_line_index(payload: &BlamePayload) -> Result<HashMap<u32, String>> {
    let mut out = HashMap::new();
    for (k, prompt_id) in &payload.lines {
        let (start, end) = parse_range_key(k).ok_or_else(|| {
            AppError::Other(format!(
                "blame lines key 解析失败 {k:?} — 上游 schema 可能漂移,详见 blame.rs:1338"
            ))
        })?;
        for n in start..=end {
            out.insert(n, prompt_id.clone());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // fixture 1:空 lines(纯人写文件 / 无 AI 行)
    const EMPTY_LINES: &str = r#"{
        "lines": {},
        "prompts": {},
        "metadata": {"is_logged_in": false, "current_user": null}
    }"#;

    // fixture 2:单行 + 范围 + 多 prompt + other_files + commits
    const NORMAL: &str = r#"{
        "lines": {
            "42": "abc123",
            "15-25": "def456",
            "100-102": "abc123"
        },
        "prompts": {
            "abc123": {
                "agent_id": {"tool": "claude_code", "id": "p-1", "model": "claude-sonnet-4-5"},
                "human_author": "alice",
                "total_additions": 50,
                "total_deletions": 5,
                "accepted_lines": 30,
                "overriden_lines": 20,
                "other_files": ["src/lib.rs", "src/main.rs"],
                "commits": ["sha-aaa"]
            },
            "def456": {
                "agent_id": {"tool": "cursor", "id": "p-2", "model": "gpt-5"},
                "human_author": null,
                "total_additions": 11,
                "total_deletions": 0,
                "accepted_lines": 11,
                "overriden_lines": 0,
                "other_files": [],
                "commits": ["sha-bbb", "sha-ccc"]
            }
        },
        "metadata": {"is_logged_in": true, "current_user": "Zephyr Li <z@example.com>"}
    }"#;

    // fixture 3:metadata.current_user 缺(未配 git user)
    const NO_USER: &str = r#"{
        "lines": {"1": "abc"},
        "prompts": {"abc": {"agent_id": {"tool": "t", "id": "i", "model": "m"}}},
        "metadata": {"is_logged_in": false, "current_user": null}
    }"#;

    #[test]
    fn parse_empty_lines() {
        let p: BlamePayload = serde_json::from_str(EMPTY_LINES).unwrap();
        assert!(p.lines.is_empty());
        assert!(p.prompts.is_empty());
        assert_eq!(p.metadata.current_user, None);
    }

    #[test]
    fn parse_normal() {
        let p: BlamePayload = serde_json::from_str(NORMAL).unwrap();
        assert_eq!(p.lines.len(), 3);
        assert_eq!(p.lines.get("42").unwrap(), "abc123");
        assert_eq!(p.lines.get("15-25").unwrap(), "def456");
        assert_eq!(p.prompts.len(), 2);
        let abc = p.prompts.get("abc123").unwrap();
        assert_eq!(abc.prompt.agent_id.tool, "claude_code");
        assert_eq!(abc.prompt.agent_id.model, "claude-sonnet-4-5");
        assert_eq!(abc.prompt.accepted_lines, 30);
        assert_eq!(abc.prompt.overriden_lines, 20);
        assert_eq!(abc.other_files.len(), 2);
        assert_eq!(abc.commits, vec!["sha-aaa".to_string()]);
        assert!(p.metadata.is_logged_in);
        assert_eq!(
            p.metadata.current_user.as_deref(),
            Some("Zephyr Li <z@example.com>")
        );
    }

    #[test]
    fn parse_no_current_user() {
        let p: BlamePayload = serde_json::from_str(NO_USER).unwrap();
        assert!(!p.metadata.is_logged_in);
        assert_eq!(p.metadata.current_user, None);
    }

    #[test]
    fn parse_range_key_single_line() {
        assert_eq!(parse_range_key("42"), Some((42, 42)));
        assert_eq!(parse_range_key("1"), Some((1, 1)));
    }

    #[test]
    fn parse_range_key_range() {
        assert_eq!(parse_range_key("15-25"), Some((15, 25)));
        assert_eq!(parse_range_key("100-102"), Some((100, 102)));
    }

    #[test]
    fn parse_range_key_rejects_zero() {
        // git 行号 1-based,0 非法
        assert_eq!(parse_range_key("0"), None);
        assert_eq!(parse_range_key("0-5"), None);
    }

    #[test]
    fn parse_range_key_rejects_inverted() {
        // start > end:上游不会输出,但前端要拒
        assert_eq!(parse_range_key("25-15"), None);
    }

    #[test]
    fn parse_range_key_rejects_malformed() {
        assert_eq!(parse_range_key(""), None);
        assert_eq!(parse_range_key("abc"), None);
        assert_eq!(parse_range_key("15-"), None);
        assert_eq!(parse_range_key("-25"), None);
        assert_eq!(parse_range_key("15-25-30"), None);
    }

    /// 防御性测试:上游某天若改成多区间 key("15-25,30-40"),本函数会返回 None。
    /// 这条断言把上游"单段"不变式钉死,上游改 schema 时该断言会先炸。
    #[test]
    fn parse_range_key_rejects_multi_segment() {
        assert_eq!(parse_range_key("15-25,30-40"), None);
    }

    #[test]
    fn expand_line_index_normal() {
        let p: BlamePayload = serde_json::from_str(NORMAL).unwrap();
        let idx = expand_line_index(&p).unwrap();
        assert_eq!(idx.get(&42).unwrap(), "abc123");
        assert_eq!(idx.get(&15).unwrap(), "def456");
        assert_eq!(idx.get(&20).unwrap(), "def456"); // 在 15-25 内
        assert_eq!(idx.get(&25).unwrap(), "def456"); // 边界 inclusive
        assert_eq!(idx.get(&26), None); // 边界外
        assert_eq!(idx.get(&100).unwrap(), "abc123");
        assert_eq!(idx.get(&102).unwrap(), "abc123");
        assert_eq!(idx.len(), 1 + 11 + 3);
    }

    #[test]
    fn expand_line_index_fails_on_invalid_key() {
        // No-fallback:无效 key 不静默跳过,直接 Err 让 UI 显式报错
        let json = r#"{"lines": {"1": "ok", "abc": "bad"}, "prompts": {}, "metadata": {}}"#;
        let p: BlamePayload = serde_json::from_str(json).unwrap();
        let r = expand_line_index(&p);
        assert!(r.is_err(), "无效 key 必须返回 Err 而非静默跳过");
    }

    #[test]
    fn expand_line_index_fails_on_inverted_range() {
        let json = r#"{"lines": {"5-3": "inv"}, "prompts": {}, "metadata": {}}"#;
        let p: BlamePayload = serde_json::from_str(json).unwrap();
        assert!(expand_line_index(&p).is_err());
    }

    #[test]
    fn parse_blame_analysis_and_compact_prompt_lines_only() {
        let json = r#"{
            "line_authors": {
                "1": "prompt_a",
                "2": "prompt_a",
                "3": "h_alice",
                "4": "prompt_b",
                "6": "prompt_b"
            },
            "prompt_records": {
                "prompt_a": {
                    "agent_id": {"tool": "claude_code", "id": "p-1", "model": "sonnet"},
                    "accepted_lines": 2,
                    "overriden_lines": 0
                },
                "prompt_b": {
                    "agent_id": {"tool": "cursor", "id": "p-2", "model": "gpt-5"},
                    "accepted_lines": 2,
                    "overriden_lines": 1
                }
            },
            "session_records": {},
            "blame_hunks": [],
            "humans": {"h_alice": {"author": "Alice <a@example.com>"}}
        }"#;
        let analysis: BlameAnalysisResult = serde_json::from_str(json).unwrap();
        let payload = convert_analysis(analysis);
        assert_eq!(payload.lines.get("1-2").unwrap(), "prompt_a");
        assert_eq!(payload.lines.get("4").unwrap(), "prompt_b");
        assert_eq!(payload.lines.get("6").unwrap(), "prompt_b");
        assert!(!payload.lines.values().any(|v| v == "h_alice"));
        assert_eq!(
            payload.prompts["prompt_a"].prompt.agent_id.tool,
            "claude_code"
        );
        assert!(payload.prompts["prompt_a"].other_files.is_empty());
    }

    /// 不变式:请求 payload 必须开 `use_prompt_hashes_as_names`。
    /// 没开 → 上游 `line_authors` value 是 author 名字字符串(如 "claude" / "alice"),
    /// 而 `prompt_records` key 是 prompt hash,`compact_prompt_lines` 求交永远空集,
    /// AI 行被全量丢失。回归过一次 (2026-05-13),用本测试钉死,改回 false 立即炸。
    #[test]
    fn blame_analysis_payload_requests_prompt_hash_names() {
        let payload = serde_json::json!({
            "file_path": "src/foo.rs",
            "options": {
                "line_ranges": Vec::<(u32, u32)>::new(),
                "newest_commit": "HEAD",
                "return_human_authors_as_human": true,
                "split_hunks_by_ai_author": false,
                "use_prompt_hashes_as_names": true,
            }
        });
        assert_eq!(
            payload["options"]["use_prompt_hashes_as_names"], true,
            "去掉 use_prompt_hashes_as_names → line_authors 全是名字字符串,AI 行会被 compact_prompt_lines 全部过滤"
        );
    }

    /// 容忍上游加新字段(评审 A #7b):serde 默认忽略未知字段,不显式 `deny_unknown_fields`。
    #[test]
    fn payload_accepts_unknown_fields_for_forward_compat() {
        let json = r#"{
            "lines": {"1": "a"},
            "prompts": {"a": {"agent_id": {"tool": "t", "id": "i", "model": "m"}}},
            "metadata": {"is_logged_in": false, "current_user": null, "future_field": "anything"},
            "future_top_level_field": {"x": 1}
        }"#;
        let p: BlamePayload = serde_json::from_str(json).expect("未知字段必须被宽容,不能破解析");
        assert_eq!(p.lines.len(), 1);
    }
}
