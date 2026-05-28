//! P7 Notes 页后端:`git notes --ref=ai list/show` 富化 + `authorship/3.0.0` 解析。
//!
//! # 与 `git_ai/notes.rs` 的分工
//! - `notes.rs`:P5 stats cache 失效用的轻量探测(commit_sha → note_blob_oid 映射)
//! - `notes_ai.rs`(本文件):P7 Notes 页 UI 数据组装 —— commit 列表富化 + 单 note 全量解析
//!
//! 两者共用 `refs/notes/ai` namespace 与"ref 不存在 = 初始态"判定,但路径分离,
//! 不串改对方的数据生命周期(评审 B §A.3)。
//!
//! # 权威依据(schema 镜像必须对齐这里,**不**做容错兼容)
//! - 文档:`git-ai/specs/git_ai_standard_v3.0.0.md` §1.2
//! - 实现:`git-ai/src/authorship/authorship_log_serialization.rs:14-232`
//!   (常量 `AUTHORSHIP_LOG_VERSION` / 结构 `AuthorshipMetadata` / divider 解析 `position(|l| l=="---")`
//!   / 引号文件名 strip `line[1..len-1]`)
//! - 字段:`git-ai/src/authorship/authorship_log.rs:190-237`
//!   (`HumanRecord` / `PromptRecord` / `SessionRecord`)
//!
//! # Schema 关键事实
//! - `prompts` 普通 16-hex 无前缀 → 完整 PromptRecord(含 messages)
//! - `humans` 以 `h_<14hex>` 为 key,只有 `author: String`
//! - `sessions` 以 `s_<14hex>` 为 key,attestation hash 可能为 `s_xxx::t_yyy` 复合
//!   (split("::").next() 取 session_key,见上游 `:278`)
//! - `overriden_lines` 字段拼写为单 r,是上游 v3.0.0 已 ship 的 typo(spec E-001),
//!   v4.x 才会改名 → 此处原样照搬,不做兼容反序列化
//!
//! # No-fallback 红线
//! - `git notes --ref=ai list` stderr 命中"ref 不存在"→ `Ok(vec![])`(初始态例外)
//! - `git notes show <sha>` 任何失败 → fail-fast(由 UI 区分"未选 sha"与"sha 无 note")
//! - `git log --no-walk` 部分 sha 找不到 → 整体 fail-fast(评审 B §B 决策)
//! - 单 note raw 超过 `NOTE_SIZE_HARD_CAP` → fail-fast,不截断不解析
//! - JSON metadata 反序列化失败 → fail-fast,不返回半成品

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{is_missing_notes_ref, NOTES_REF};
use crate::error::{AppError, Result};
use crate::proc::{run_capture_with_stdin, run_capture_with_timeout};

const GIT_TIMEOUT: Duration = Duration::from_secs(15);
/// 单 commit 的 raw note 体积上限。AI 对话最长场景(50 轮 agentic loop)实测 1-2 MB;
/// 此处给 4 MB 留余量;超过即异常 / schema 漂移 / 误用,fail-fast 让用户提 issue。
const NOTE_SIZE_HARD_CAP: usize = 4 * 1024 * 1024;
/// `git log --no-walk` 单次最多接收的 sha 数。Windows CMD 命令行长度上限 8191 chars,
/// 单 sha 41 字符(40 hex + 空格),200 个 ≈ 8200 chars 已贴边 —— 取 150 留余量。
const LOG_BATCH_SIZE: usize = 150;
const RECORD_SEP: char = '\x1e';
const FIELD_SEP: char = '\x1f';

// ============================================================================
// Schema 镜像(对齐上游 authorship/3.0.0)
// ============================================================================

/// `AuthorshipMetadata.prompts` 与 `sessions` 共用的 AgentId 三元组。
/// 上游:`working_log.rs:42-46`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentId {
    pub tool: String,
    pub id: String,
    pub model: String,
}

/// `messages` 数组单条。`type` 取 `"user" / "assistant" / "tool_use"`。
/// `text` 在 user/assistant 时承载,`name + input` 在 tool_use 时承载。
/// `timestamp` 可选(ISO-8601)。
/// 上游不在 Rust 端反序列化 `messages` 数组,直接以 `serde_json::Value` 透传,
/// 我们 viewer 同样透传以承担"未来扩展 type"的零成本兼容。
pub type MessageValue = serde_json::Value;

/// `prompts.<hash>` 完整记录。字段顺序与上游 `authorship_log.rs:198-213` 一致。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PromptRecord {
    pub agent_id: AgentId,
    pub human_author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages_url: Option<String>,
    pub messages: Vec<MessageValue>,
    pub total_additions: u32,
    pub total_deletions: u32,
    pub accepted_lines: u32,
    /// 上游 v3.0.0 spec 拼写为 `overriden_lines`(单 r),为 spec errata E-001 已知 typo;
    /// v4.x 会重命名为 `overridden_lines`。此处与上游字段名严格对齐。
    pub overriden_lines: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_attributes: Option<BTreeMap<String, String>>,
}

/// `humans.<h_...>` 记录。上游 `authorship_log.rs:191-194`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct HumanRecord {
    /// 形如 `"Alice Smith <alice@example.com>"`。
    pub author: String,
}

/// `sessions.<s_...>` 轻量 session 记录。无 messages / stats,仅标"该 session 写过"。
/// 上游 `authorship_log.rs:217-222`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionRecord {
    pub agent_id: AgentId,
    pub human_author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_attributes: Option<BTreeMap<String, String>>,
}

/// authorship/3.0.0 metadata 段。
/// 与上游 `AuthorshipMetadata`(`authorship_log_serialization.rs:28-37`)5 字段一致。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuthorshipMetadata {
    pub schema_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_ai_version: Option<String>,
    pub base_commit_sha: String,
    #[serde(default)]
    pub prompts: BTreeMap<String, PromptRecord>,
    #[serde(default)]
    pub humans: BTreeMap<String, HumanRecord>,
    #[serde(default)]
    pub sessions: BTreeMap<String, SessionRecord>,
}

/// 单 attestation entry:`<hash> <line-ranges>`。
/// hash 分类(评审 A §1.c):
/// - `h_` 前缀 → humans
/// - `s_` 前缀(可能后缀 `::t_<14hex>`)→ sessions(lookup key 用 `split("::").next()`)
/// - 其余 → prompts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttestationEntry {
    pub hash: String,
    /// 原样透传字符串(如 `"1-4,9-10,12,14,16"`)。viewer 不擅自 re-sort,
    /// 也不解析为 (u32,u32) Vec —— 让前端按需切分,后端只做 "schema 是否合法"。
    pub line_ranges: String,
}

/// 单文件 attestation 块。spec §1.2.3 文件名含空格 / tab / 换行 MUST 用 `"` 包裹;
/// 解析时与上游一致直接 strip 引号首尾(`authorship_log_serialization.rs:670-676`)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileAttestation {
    pub file_path: String,
    pub entries: Vec<AttestationEntry>,
}

/// 完整 authorship log:attestation 段 + metadata 段(JSON)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorshipLog {
    pub attestations: Vec<FileAttestation>,
    pub metadata: AuthorshipMetadata,
}

// ============================================================================
// list:富化后的 commit 列表
// ============================================================================

/// `list_ai_notes` 单条输出。所有字段必填,来自 `git log --no-walk` 富化。
/// **不可达 sha 不出现在此**(协作 push notes 但 commit 未抵达本地 / shallow clone / rebase 孤儿 sha),
/// 它们被 hoist 到 `NotesListPayload::unreachable_shas`,前端单独提示用户 fetch,不混入正常条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteListEntry {
    pub commit_sha: String,
    pub short_sha: String,
    pub note_oid: String,
    /// ISO-8601 带时区(`%cI`)。
    pub committed_at: String,
    pub subject: String,
}

/// `list_ai_notes` 顶层返回结构。
/// notes ref 与 commits 是独立 ref namespace —— git 设计上允许 notes 指向 unreachable commit。
/// 我们 **不静默隐藏** 这些 sha(违背"告诉用户真相"),也 **不把它们混入正常列表**(降级展示会误导用户以为能看 stats);
/// 单独 hoist 到 unreachable_shas,前端 banner 提示 "N 条 ai notes 引用的 commit 在本地不存在,可能需要 git fetch"。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotesListPayload {
    pub entries: Vec<NoteListEntry>,
    pub unreachable_shas: Vec<String>,
}

// ============================================================================
// 解析层(纯函数,无 IO)
// ============================================================================

// `NOTES_REF` 与 `is_missing_notes_ref` 已在 `git_ai/mod.rs` 集中(评审 P7 #41 已修)。

/// 解析 `git notes --ref=ai list` 全量 stdout,返回 `(commit_sha → note_blob_oid)` 列表。
/// 每行 `<note_blob_oid> <commit_sha>`,空行 / 不足两列 → 跳过。
pub fn parse_notes_list(stdout: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(oid) = parts.next() else { continue };
        let Some(sha) = parts.next() else { continue };
        out.push((sha.to_string(), oid.to_string()));
    }
    out
}

/// 解析 authorship log raw text 为结构化 [`AuthorshipLog`]。
///
/// 算法 与上游 `authorship_log_serialization.rs:210-232` 同款:
/// 1. `content.lines()` 切行,找首个**整行等于 `---`** 的位置(`line == "---"` 严格比较,
///    与上游 `:214` 字面一致;`serde_json::to_string_pretty` 输出的 JSON 即便内含 `---` 字符串值
///    也是 quoted 状态,不会撞)
/// 2. divider 之前:attestation 段;之后:metadata JSON
/// 3. attestation 段按上游 `parse_attestation_section`(`:628-690`)算法解析:
///    - 非缩进行 → file path(含 `"..."` 包裹则 strip 首尾引号,不 unescape)
///    - 缩进 `"  "` 开头行 → entry(hash + 单空格 + line ranges)
///    - 不为空但格式错 → AppError::Other
pub fn parse_authorship_log(content: &str) -> Result<AuthorshipLog> {
    // 1. 找 divider
    let lines: Vec<&str> = content.lines().collect();
    let divider = lines
        .iter()
        .position(|&l| l == "---")
        .ok_or_else(|| AppError::Other("authorship log 缺少 divider `---`".into()))?;

    // 2. 切两段
    let attestation_lines = &lines[..divider];
    let metadata_lines = &lines[divider + 1..];

    // 3. 解析 attestation 段
    let attestations = parse_attestation_section(attestation_lines)?;

    // 4. 解析 metadata 段(JSON)
    let metadata_str = metadata_lines.join("\n");
    if metadata_str.trim().is_empty() {
        return Err(AppError::Other("authorship log metadata 段为空".into()));
    }
    let metadata: AuthorshipMetadata =
        serde_json::from_str(&metadata_str).map_err(AppError::Json)?;

    // 5. schema_version 必填校验(上游 :29 类型为 String 无 default)
    if metadata.schema_version.is_empty() {
        return Err(AppError::Other(
            "authorship log metadata.schema_version 缺失或空".into(),
        ));
    }

    Ok(AuthorshipLog {
        attestations,
        metadata,
    })
}

/// 与上游 `parse_attestation_section`(`authorship_log_serialization.rs:628-690`)同算法。
fn parse_attestation_section(lines: &[&str]) -> Result<Vec<FileAttestation>> {
    let mut out: Vec<FileAttestation> = Vec::new();
    let mut current: Option<FileAttestation> = None;

    for raw in lines {
        // 上游用 trim_end(),保留前导空白用以判定缩进
        let line = raw.trim_end();
        if line.is_empty() {
            continue;
        }

        if let Some(entry_line) = line.strip_prefix("  ") {
            // attestation entry:`<hash> <line-ranges>`
            let Some(space_pos) = entry_line.find(' ') else {
                return Err(AppError::Other(format!(
                    "attestation entry 缺少空格分隔:{entry_line:?}"
                )));
            };
            let hash = entry_line[..space_pos].to_string();
            let ranges = entry_line[space_pos + 1..].to_string();
            let Some(ref mut file) = current else {
                return Err(AppError::Other(format!(
                    "attestation entry 出现在 file path 之前:{entry_line:?}"
                )));
            };
            file.entries.push(AttestationEntry {
                hash,
                line_ranges: ranges,
            });
        } else {
            // file path 行:flush 上一组、开新组
            if let Some(prev) = current.take() {
                if !prev.entries.is_empty() {
                    out.push(prev);
                }
            }
            // 引号包裹直接 strip 首尾(与上游 :670-676 字面一致,不做 unescape)
            let path = if line.starts_with('"') && line.ends_with('"') && line.len() >= 2 {
                line[1..line.len() - 1].to_string()
            } else {
                line.to_string()
            };
            current = Some(FileAttestation {
                file_path: path,
                entries: Vec::new(),
            });
        }
    }

    if let Some(prev) = current {
        if !prev.entries.is_empty() {
            out.push(prev);
        }
    }
    Ok(out)
}

/// 解析 `git log --no-walk --format=%H\x1f%h\x1f%cI\x1f%s\x1e <sha...>` 的 stdout。
///
/// **失败语义**:返回 `HashMap<sha, (short, date, subject)>`;调用方按"sha 应有富化结果但缺失"
/// 即视为部分缺失 fail。
pub fn parse_log_richen(
    stdout: &str,
) -> std::collections::HashMap<String, (String, String, String)> {
    let mut map = std::collections::HashMap::new();
    for record in stdout.split(RECORD_SEP) {
        let record = record.trim_start_matches('\n').trim_matches('\n');
        if record.is_empty() {
            continue;
        }
        let mut parts = record.splitn(4, FIELD_SEP);
        let Some(sha) = parts.next() else { continue };
        let Some(short) = parts.next() else { continue };
        let Some(date) = parts.next() else { continue };
        let Some(subject) = parts.next() else {
            continue;
        };
        let sha = sha.trim().to_string();
        if sha.is_empty() {
            continue;
        }
        map.insert(
            sha,
            (
                short.trim().to_string(),
                date.trim().to_string(),
                subject.trim().to_string(),
            ),
        );
    }
    map
}

// ============================================================================
// 子进程层
// ============================================================================

/// 调 `git notes --ref=ai list`(无参数,全量)。
/// 与 P5 `notes.rs::read_all_notes_oids` 行为一致但返回 Vec 保序(便于 list_with_richen 富化批次拆分)。
pub async fn run_list(repo: &Path) -> Result<Vec<(String, String)>> {
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
            return Ok(Vec::new());
        }
        return Err(AppError::Other(format!(
            "git notes list 退出码 {}: {}",
            out.status,
            out.stderr.trim()
        )));
    }
    Ok(parse_notes_list(&out.stdout))
}

/// 调 `git notes --ref=ai show <sha>`。
///
/// **错误归类**:
/// - exit 0 + stdout 过大(> NOTE_SIZE_HARD_CAP)→ fail-fast,不解析
/// - exit ≠ 0 → fail-fast(由 UI 区分"列表过期"vs"用户瞎贴 sha")
pub async fn run_show(repo: &Path, sha: &str) -> Result<AuthorshipLog> {
    let git = which::which("git").map_err(|_| AppError::Other("未找到 git 二进制".into()))?;
    let out = run_capture_with_timeout(
        &git,
        &["notes", "--ref", NOTES_REF, "show", sha],
        Some(repo),
        GIT_TIMEOUT,
    )
    .await?;
    if out.status != 0 {
        return Err(AppError::Other(format!(
            "git notes show {} 退出码 {}: {}",
            sha,
            out.status,
            out.stderr.trim()
        )));
    }
    if out.stdout.len() > NOTE_SIZE_HARD_CAP {
        return Err(AppError::Other(format!(
            "authorship log 体积超过上限({} 字节 > {} MB),疑似 schema 漂移或异常,请提 issue",
            out.stdout.len(),
            NOTE_SIZE_HARD_CAP / (1024 * 1024)
        )));
    }
    parse_authorship_log(&out.stdout)
}

/// 给定 `(sha, oid)` 列表,先用 `git cat-file --batch-check` 预筛 reachable / unreachable,
/// 再用 `git log --no-walk` 批量富化 reachable 的 subject + date。
///
/// **预筛**:notes ref 与 commits 是独立 namespace,常见场景下 notes 会指向本地不存在的 commit。
/// 这种 sha 不混入 entries(避免无 subject/date 的占位行误导用户),单独 hoist 到 unreachable_shas,
/// 前端 banner 提示用户 fetch。
///
/// **批次**:每批 ≤ LOG_BATCH_SIZE(150 sha) —— 防 Windows 命令行 8191 字符上限。
/// **部分缺失**:预筛后整批 reachable sha 仍返回非 0 / 缺某 sha 行 → 真异常 fail-fast。
pub async fn list_with_richen(repo: &Path) -> Result<NotesListPayload> {
    let pairs = run_list(repo).await?;
    if pairs.is_empty() {
        return Ok(NotesListPayload {
            entries: Vec::new(),
            unreachable_shas: Vec::new(),
        });
    }

    let git = which::which("git").map_err(|_| AppError::Other("未找到 git 二进制".into()))?;

    // 预筛阶段:cat-file --batch-check 一次性判 reachable
    let all_shas: Vec<&str> = pairs.iter().map(|(s, _)| s.as_str()).collect();
    let reachable: std::collections::HashSet<String> =
        partition_reachable(&git, repo, &all_shas).await?;

    let (reachable_pairs, unreachable_pairs): (Vec<_>, Vec<_>) = pairs
        .into_iter()
        .partition(|(sha, _)| reachable.contains(sha));
    let unreachable_shas: Vec<String> = unreachable_pairs.into_iter().map(|(sha, _)| sha).collect();

    if reachable_pairs.is_empty() {
        return Ok(NotesListPayload {
            entries: Vec::new(),
            unreachable_shas,
        });
    }

    // 富化阶段:只对 reachable sha 跑 git log --no-walk
    let format_arg = format!(
        "--format=%H{F}%h{F}%cI{F}%s{R}",
        F = FIELD_SEP,
        R = RECORD_SEP
    );

    let mut richen_map = std::collections::HashMap::new();
    for chunk in reachable_pairs.chunks(LOG_BATCH_SIZE) {
        let mut args: Vec<&str> = vec!["log", "--no-walk", &format_arg];
        for (sha, _) in chunk {
            args.push(sha);
        }
        let out = run_capture_with_timeout(&git, &args, Some(repo), GIT_TIMEOUT).await?;
        if out.status != 0 {
            // 预筛已过滤 bad object,此处 fail 是真异常(权限 / 配置 / git 损坏)
            return Err(AppError::Other(format!(
                "git log --no-walk 退出码 {}(批 {} 条 sha): {}",
                out.status,
                chunk.len(),
                out.stderr.trim()
            )));
        }
        let partial = parse_log_richen(&out.stdout);
        richen_map.extend(partial);
    }

    // sort:committed_at desc(注:richen_map 用 ISO-8601 字符串排序,与时间序一致)。
    let mut entries: Vec<NoteListEntry> = Vec::with_capacity(reachable_pairs.len());
    for (sha, oid) in &reachable_pairs {
        let Some((short, date, subject)) = richen_map.get(sha) else {
            return Err(AppError::Other(format!(
                "git log --no-walk 输出缺失 sha {} —— 预筛已认定 reachable,可能仓库被并发修改",
                sha
            )));
        };
        entries.push(NoteListEntry {
            commit_sha: sha.clone(),
            short_sha: short.clone(),
            note_oid: oid.clone(),
            committed_at: date.clone(),
            subject: subject.clone(),
        });
    }
    entries.sort_by(|a, b| b.committed_at.cmp(&a.committed_at));
    Ok(NotesListPayload {
        entries,
        unreachable_shas,
    })
}

/// 用 `git cat-file --batch-check` 一次性判 sha 是否 reachable(本地存在 commit object)。
/// 命令行不传 sha(避免 8191 上限),通过 stdin 喂"每行一个 sha"。
/// stdout 格式:`<sha> <type> <size>` 或 `<sha> missing`。返回 reachable 的 sha 集合。
async fn partition_reachable(
    git: &Path,
    repo: &Path,
    shas: &[&str],
) -> Result<std::collections::HashSet<String>> {
    let mut stdin_buf = String::with_capacity(shas.len() * 41);
    for sha in shas {
        stdin_buf.push_str(sha);
        stdin_buf.push('\n');
    }
    let out = run_capture_with_stdin(
        git,
        &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        Some(repo),
        &stdin_buf,
        GIT_TIMEOUT,
    )
    .await?;
    if out.status != 0 {
        return Err(AppError::Other(format!(
            "git cat-file --batch-check 退出码 {}: {}",
            out.status,
            out.stderr.trim()
        )));
    }
    let mut reachable = std::collections::HashSet::with_capacity(shas.len());
    for line in out.stdout.lines() {
        // missing 行形如 "<input> missing",commit 行形如 "<sha> commit"
        let mut parts = line.split_whitespace();
        let Some(sha) = parts.next() else { continue };
        let Some(kind) = parts.next() else { continue };
        if kind == "commit" {
            reachable.insert(sha.to_string());
        }
        // "missing" / 其它 object 类型(tag / tree / blob)都视为 unreachable —— ai notes 应指向 commit
    }
    Ok(reachable)
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_LOG: &str = r#"src/main.rs
  abcd1234abcd1234 1-10,15-20
  h_31dce776f88375 11-14
src/lib.rs
  s_abcdef0123456::t_1234567890abcd 1-50
---
{
  "schema_version": "authorship/3.0.0",
  "git_ai_version": "1.4.7",
  "base_commit_sha": "7734793b756b3921c88db5375a8c156e9532447b",
  "prompts": {
    "abcd1234abcd1234": {
      "agent_id": {
        "tool": "cursor",
        "id": "session-1",
        "model": "claude-3-sonnet"
      },
      "human_author": "Alice <alice@example.com>",
      "messages": [
        {"type":"user","text":"add error handling"},
        {"type":"assistant","text":"done"}
      ],
      "total_additions": 16,
      "total_deletions": 0,
      "accepted_lines": 16,
      "overriden_lines": 0
    }
  },
  "humans": {
    "h_31dce776f88375": { "author": "Alice Smith <alice@example.com>" }
  },
  "sessions": {
    "s_abcdef0123456": {
      "agent_id": {
        "tool": "claude",
        "id": "conv_abc",
        "model": "claude-sonnet-4-5"
      },
      "human_author": "dev@example.com"
    }
  }
}
"#;

    #[test]
    fn parse_notes_list_two_columns_keeps_order() {
        let s = "abc123 sha-1\ndef456 sha-2\n";
        let v = parse_notes_list(s);
        assert_eq!(
            v,
            vec![
                ("sha-1".into(), "abc123".into()),
                ("sha-2".into(), "def456".into()),
            ]
        );
    }

    #[test]
    fn parse_notes_list_skips_empty_and_malformed() {
        let s = "  \nlone-token\nvalid-oid valid-sha\n";
        let v = parse_notes_list(s);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].0, "valid-sha");
        assert_eq!(v[0].1, "valid-oid");
    }

    #[test]
    fn parse_log_happy_path() {
        let log = parse_authorship_log(SAMPLE_LOG).unwrap();
        assert_eq!(log.attestations.len(), 2);
        assert_eq!(log.attestations[0].file_path, "src/main.rs");
        assert_eq!(log.attestations[0].entries.len(), 2);
        assert_eq!(log.attestations[0].entries[0].hash, "abcd1234abcd1234");
        assert_eq!(log.attestations[0].entries[0].line_ranges, "1-10,15-20");
        assert_eq!(log.attestations[0].entries[1].hash, "h_31dce776f88375");
        assert_eq!(log.attestations[1].file_path, "src/lib.rs");
        assert_eq!(
            log.attestations[1].entries[0].hash,
            "s_abcdef0123456::t_1234567890abcd"
        );
        assert_eq!(log.metadata.schema_version, "authorship/3.0.0");
        assert_eq!(log.metadata.git_ai_version.as_deref(), Some("1.4.7"));
        assert_eq!(log.metadata.prompts.len(), 1);
        assert_eq!(log.metadata.humans.len(), 1);
        assert_eq!(log.metadata.sessions.len(), 1);
    }

    #[test]
    fn parse_log_missing_divider_fails() {
        let s = r#"src/main.rs
  abcd1234abcd1234 1-10
{"schema_version":"authorship/3.0.0","base_commit_sha":"x","prompts":{}}
"#;
        let err = parse_authorship_log(s).unwrap_err();
        assert!(err.to_string().contains("divider"));
    }

    #[test]
    fn parse_log_metadata_section_empty_fails() {
        let s = "src/main.rs\n  abcd1234abcd1234 1-10\n---\n   \n";
        let err = parse_authorship_log(s).unwrap_err();
        assert!(err.to_string().contains("metadata"));
    }

    #[test]
    fn parse_log_metadata_truncated_json_fails() {
        let s = r#"src/main.rs
  abcd1234abcd1234 1-10
---
{"schema_version":"authorship/3.0.0","base_commit_sha":"x"
"#;
        let err = parse_authorship_log(s).unwrap_err();
        // serde_json::Error 经 AppError::Json 透传
        assert!(
            err.to_string().to_lowercase().contains("json")
                || err.to_string().to_lowercase().contains("eof")
        );
    }

    #[test]
    fn parse_log_schema_version_missing_fails() {
        // metadata 没有 schema_version 字段 → fail
        let s = r#"src/main.rs
  abcd1234abcd1234 1-10
---
{
  "base_commit_sha": "x",
  "prompts": {
    "abcd1234abcd1234": {
      "agent_id": {"tool":"cursor","id":"s","model":"m"},
      "messages": [],
      "total_additions":1,"total_deletions":0,"accepted_lines":1,"overriden_lines":0
    }
  }
}
"#;
        let err = parse_authorship_log(s).unwrap_err();
        assert!(err.to_string().contains("schema_version"));
    }

    #[test]
    fn parse_log_quoted_file_path_stripped() {
        let s = r#""src/my file.rs"
  abcd1234abcd1234 1-2
---
{
  "schema_version": "authorship/3.0.0",
  "base_commit_sha": "x",
  "prompts": {
    "abcd1234abcd1234": {
      "agent_id": {"tool":"cursor","id":"s","model":"m"},
      "messages": [],
      "total_additions":0,"total_deletions":0,"accepted_lines":0,"overriden_lines":0
    }
  }
}
"#;
        let log = parse_authorship_log(s).unwrap();
        assert_eq!(log.attestations[0].file_path, "src/my file.rs");
    }

    #[test]
    fn parse_log_overriden_lines_typo_preserved_in_roundtrip() {
        // 反序列化 overriden_lines(单 r) 字段必须命中,值保留
        let log = parse_authorship_log(SAMPLE_LOG).unwrap();
        let prompt = log.metadata.prompts.get("abcd1234abcd1234").unwrap();
        assert_eq!(prompt.overriden_lines, 0);
        assert_eq!(prompt.accepted_lines, 16);
        // 序列化再回读 —— 字段名也是 overriden_lines
        let json = serde_json::to_string(&prompt).unwrap();
        assert!(json.contains("\"overriden_lines\""));
        assert!(!json.contains("\"overridden_lines\""));
    }

    #[test]
    fn parse_log_divider_inside_json_string_does_not_split_early() {
        // metadata 内含 "---" 字符串值,divider 只在第一处整行 === "---" 切
        let s = r#"src/x.rs
  abcd1234abcd1234 1
---
{
  "schema_version": "authorship/3.0.0",
  "base_commit_sha": "---",
  "prompts": {
    "abcd1234abcd1234": {
      "agent_id": {"tool":"cursor","id":"s","model":"---"},
      "messages": [],
      "total_additions":0,"total_deletions":0,"accepted_lines":0,"overriden_lines":0
    }
  }
}
"#;
        let log = parse_authorship_log(s).unwrap();
        assert_eq!(log.metadata.base_commit_sha, "---");
        assert_eq!(
            log.metadata
                .prompts
                .get("abcd1234abcd1234")
                .unwrap()
                .agent_id
                .model,
            "---"
        );
    }

    #[test]
    fn parse_log_session_compound_hash_preserved() {
        let log = parse_authorship_log(SAMPLE_LOG).unwrap();
        let entry = &log.attestations[1].entries[0];
        assert_eq!(entry.hash, "s_abcdef0123456::t_1234567890abcd");
        // session_key 取 split("::").next() —— 在 UI 层 lookup 时用
        let session_key = entry.hash.split("::").next().unwrap();
        assert_eq!(session_key, "s_abcdef0123456");
        assert!(log.metadata.sessions.contains_key(session_key));
    }

    #[test]
    fn parse_log_crlf_handled() {
        // git 子进程输出本来是 LF,但保险测一遍 CRLF 不破解析
        let s = SAMPLE_LOG.replace('\n', "\r\n");
        let log = parse_authorship_log(&s).unwrap();
        assert_eq!(log.metadata.schema_version, "authorship/3.0.0");
        assert_eq!(log.attestations.len(), 2);
    }

    #[test]
    fn parse_log_entry_without_file_fails() {
        let s = "  abcd1234abcd1234 1-10\n---\n{}\n";
        let err = parse_authorship_log(s).unwrap_err();
        assert!(err.to_string().contains("file path"));
    }

    #[test]
    fn is_missing_notes_ref_strict() {
        assert!(is_missing_notes_ref(""));
        assert!(is_missing_notes_ref("error: refs/notes/ai does not exist."));
        assert!(is_missing_notes_ref("refs/notes/ai not found"));
        // 真错绝不能吞:
        assert!(!is_missing_notes_ref(
            "fatal: not a git repository (or any parent up to mount point /)"
        ));
        assert!(!is_missing_notes_ref("fatal: permission denied"));
        assert!(!is_missing_notes_ref("error: object 0123 does not exist"));
    }

    #[test]
    fn parse_log_richen_decodes_iso_subject() {
        let stdout = format!(
            "{S1}{F}{H1}{F}{D1}{F}{Sub1}{R}{S2}{F}{H2}{F}{D2}{F}{Sub2}{R}",
            F = FIELD_SEP,
            R = RECORD_SEP,
            S1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            H1 = "aaaaaaa",
            D1 = "2026-05-12T10:00:00+08:00",
            Sub1 = "feat: subject one",
            S2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            H2 = "bbbbbbb",
            D2 = "2026-05-11T18:30:00+08:00",
            Sub2 = "fix: subject two",
        );
        let map = parse_log_richen(&stdout);
        assert_eq!(map.len(), 2);
        let (short, date, subject) = map.get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        assert_eq!(short, "aaaaaaa");
        assert_eq!(date, "2026-05-12T10:00:00+08:00");
        assert_eq!(subject, "feat: subject one");
    }
}
