//! P8 Checkpoints 视图后端:读 `.git/ai/working_logs/<base_commit_sha>/checkpoints.jsonl`。
//!
//! # 权威依据
//! - Schema:`git-ai/src/authorship/working_log.rs:8-167`(Checkpoint / WorkingLogEntry /
//!   CheckpointKind / AgentId / KnownHumanMetadata / CheckpointLineStats)
//! - 行级归因:`git-ai/src/authorship/attribution_tracker.rs:25-65`(Attribution / LineAttribution)
//! - 文件布局:`git-ai/src/git/repo_storage.rs:33-145, 225-485`
//!   - 目录:`<workdir>/.git/ai/working_logs/<base_commit_sha>/`
//!   - 文件:`checkpoints.jsonl`(每行一条 Checkpoint JSON)
//!   - 同目录还有 `INITIAL` 文件 + `blobs/` 子目录(P8 不读)
//!   - 归档:`old-<sha>/`(7 天保留,P8 不展示)
//! - worktree storage:主 worktree 用 `<git_common_dir>/ai`;linked worktree 用
//!   `<git_common_dir>/ai/worktrees/<relative_worktree_path>`(上游 repository.rs:2056-2080)
//! - `<base_commit_sha>` = **HEAD sha 本身**(不是 parent),依据 `checkpoint_agent/orchestrator.rs:124-126`
//!   + `daemon.rs:1414-1417`(检查点写入时取的就是当前 HEAD;post_commit.rs 用 parent 是另一个时间点)
//!
//! # CheckpointKind 序列化形式
//! **PascalCase**(`"AiAgent" / "Human" / "AiTab" / "KnownHuman"`),依据 `working_log.rs:48-54`
//! 的 enum 无 `#[serde(rename_all)]` 标注 + 单测 `:307` 字面用 `"kind": "AiAgent"`。
//! `to_str() / from_str()` 是 CLI 文本输出,与 JSON serde 无关。
//!
//! # 4 条解析规则(必须完整镜像 `repo_storage.rs:410-485`)
//! 1. `checkpoints.jsonl` 文件不存在 → `Ok(vec![])`(初始态)
//! 2. 空行 → 跳过
//! 3. `api_version != "checkpoint/1.0.0"` → 静默跳过 + log::debug
//! 4. 行级 JSON 解析失败 → fail-fast(AppError,**带行号**)
//!
//! # P8 范围
//! - **只读**:不实现 `append_checkpoint` / `prune_old_char_attributions`(写盘走 git-ai CLI)
//! - **不迁移** 7-char author_id(viewer 透传,UI 未解析 hash 直接显示原值)

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

pub const CHECKPOINT_API_VERSION: &str = "checkpoint/1.0.0";

// ============================================================================
// Schema 镜像(对齐 working_log.rs + attribution_tracker.rs)
// ============================================================================

/// `working_log.rs:42-46`。与 P6 Blame / P7 Notes 的 AgentId 字段相同但独立类型,关注点分离。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentId {
    pub tool: String,
    pub id: String,
    pub model: String,
}

/// `working_log.rs:49-54`。**PascalCase serde**(详见模块顶部 doc)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CheckpointKind {
    Human,
    AiAgent,
    AiTab,
    KnownHuman,
}

/// `working_log.rs:98-102`。仅 `kind == KnownHuman` 时有值。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownHumanMetadata {
    pub editor: String,
    pub editor_version: String,
    pub extension_version: String,
}

/// `working_log.rs:105-116`。`additions` 是原始添加行;`additions_sloc` 是**去掉纯空白行后**的行数
/// (上游 `git-ai/src/daemon/checkpoint.rs:1028-1058` `compute_file_line_stats` 仅按
/// `!line.trim().is_empty()` 过滤,变量名 `non_whitespace_lines` —— **不剔除注释行**)。
/// 上游所有字段 `#[serde(default)]`,我们一致。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CheckpointLineStats {
    pub additions: u32,
    pub deletions: u32,
    pub additions_sloc: u32,
    pub deletions_sloc: u32,
}

/// `attribution_tracker.rs:26-35`。char 级归因,P8 viewer 不直接展示(默认 prune 仅最新 checkpoint 有)。
/// `ts: u128` 在 ms-since-epoch 实际取值 ~41 bit,远小于 JS Number 53 bit 安全位 → 直接 JSON number,
/// 无需 BigInt(评审 A 验证)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attribution {
    pub start: usize,
    pub end: usize,
    pub author_id: String,
    pub ts: u128,
}

/// `attribution_tracker.rs:39-50`。行级归因(1-indexed inclusive)。
/// `overrode` 为 None 时不序列化(spec 中默认 None)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineAttribution {
    pub start_line: u32,
    pub end_line: u32,
    pub author_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrode: Option<String>,
}

/// `working_log.rs:11-22`。`blob_sha / attributions / line_attributions` 均 `#[serde(default)]`,
/// `file` 必填。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkingLogEntry {
    pub file: String,
    #[serde(default)]
    pub blob_sha: String,
    #[serde(default)]
    pub attributions: Vec<Attribution>,
    #[serde(default)]
    pub line_attributions: Vec<LineAttribution>,
}

/// `working_log.rs:118-139`。12 字段:4 必填 + 8 可选/默认。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    /// 缺失时默认 `Human`(对齐上游 `serde_default`)。
    #[serde(default = "default_human_kind")]
    pub kind: CheckpointKind,
    pub diff: String,
    pub author: String,
    pub entries: Vec<WorkingLogEntry>,
    pub timestamp: u64,
    /// `kind=Human/KnownHuman` 时通常 None;serde 对 Option 字段缺失天然视为 None,无需 `#[serde(default)]`。
    pub agent_id: Option<AgentId>,
    #[serde(default)]
    pub agent_metadata: Option<HashMap<String, String>>,
    #[serde(default)]
    pub line_stats: CheckpointLineStats,
    #[serde(default)]
    pub api_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_ai_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub known_human_metadata: Option<KnownHumanMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
}

fn default_human_kind() -> CheckpointKind {
    CheckpointKind::Human
}

// ============================================================================
// 路径与读取层
// ============================================================================

/// 镜像上游 `Repository::worktree_storage_ai_dir` 的 storage 目录计算。
pub fn worktree_storage_ai_dir(git_dir: &Path, git_common_dir: &Path) -> PathBuf {
    if git_dir == git_common_dir {
        return git_common_dir.join("ai");
    }

    let worktrees_root = git_common_dir.join("worktrees");
    if let Ok(relative_worktree_path) = git_dir.strip_prefix(&worktrees_root) {
        if !relative_worktree_path.as_os_str().is_empty() {
            return git_common_dir
                .join("ai")
                .join("worktrees")
                .join(relative_worktree_path);
        }
    }

    let canonical_git_dir = git_dir
        .canonicalize()
        .unwrap_or_else(|_| git_dir.to_path_buf());
    let canonical_common_dir = git_common_dir
        .canonicalize()
        .unwrap_or_else(|_| git_common_dir.to_path_buf());

    if canonical_git_dir == canonical_common_dir {
        return git_common_dir.join("ai");
    }

    let canonical_worktrees_root = canonical_common_dir.join("worktrees");
    if let Ok(relative_worktree_path) = canonical_git_dir.strip_prefix(&canonical_worktrees_root) {
        if !relative_worktree_path.as_os_str().is_empty() {
            return git_common_dir
                .join("ai")
                .join("worktrees")
                .join(relative_worktree_path);
        }
    }

    let fallback_name = git_dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "default".to_string());
    git_common_dir
        .join("ai")
        .join("worktrees")
        .join(fallback_name)
}

/// 计算 `<ai_dir>/working_logs/<sha>/checkpoints.jsonl` 文件路径。
pub fn checkpoints_path_in_ai_dir(ai_dir: &Path, base_commit_sha: &str) -> PathBuf {
    ai_dir
        .join("working_logs")
        .join(base_commit_sha)
        .join("checkpoints.jsonl")
}

/// 计算 `.git/ai/working_logs/<sha>/checkpoints.jsonl` 文件路径。
pub fn checkpoints_path(repo_workdir: &Path, base_commit_sha: &str) -> PathBuf {
    checkpoints_path_in_ai_dir(&repo_workdir.join(".git").join("ai"), base_commit_sha)
}

/// 目录探测结果。命令层据此区分 degraded(目录不存在) vs 初始态(文件不存在 / 空)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkingLogPresence {
    /// `.git/ai/working_logs/<sha>/` 目录不存在 → degraded(git-ai 未在此 HEAD 跑过 checkpoint)
    DirMissing,
    /// 目录存在但 `checkpoints.jsonl` 不存在 → 初始态(返回 Ok([]))
    FileMissing,
    /// 文件存在
    FileExists,
}

pub fn probe_presence(repo_workdir: &Path, base_commit_sha: &str) -> WorkingLogPresence {
    probe_presence_in_ai_dir(&repo_workdir.join(".git").join("ai"), base_commit_sha)
}

pub fn probe_presence_in_ai_dir(ai_dir: &Path, base_commit_sha: &str) -> WorkingLogPresence {
    let dir = ai_dir.join("working_logs").join(base_commit_sha);
    if !dir.exists() {
        return WorkingLogPresence::DirMissing;
    }
    let file = dir.join("checkpoints.jsonl");
    if !file.exists() {
        return WorkingLogPresence::FileMissing;
    }
    WorkingLogPresence::FileExists
}

/// 解析 jsonl 文本(纯函数,可单测)。
///
/// 遵循 4 条规则(见模块顶部):
/// - 空行跳过
/// - api_version != "checkpoint/1.0.0" 静默跳过 + debug log
/// - JSON 解析失败 → AppError 带行号
///
/// 调用方负责文件不存在时返回空 Vec(走 `read_checkpoints`)。
pub fn parse_jsonl(content: &str) -> Result<Vec<Checkpoint>> {
    let mut out = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let checkpoint: Checkpoint = serde_json::from_str(line).map_err(|e| {
            AppError::Other(format!(
                "checkpoints.jsonl 第 {} 行解析失败: {}",
                idx + 1,
                e
            ))
        })?;
        if checkpoint.api_version != CHECKPOINT_API_VERSION {
            log::debug!(
                "跳过不兼容的 checkpoint api_version: {}(第 {} 行)",
                checkpoint.api_version,
                idx + 1
            );
            continue;
        }
        out.push(checkpoint);
    }
    Ok(out)
}

/// 轻量统计一段 `checkpoints.jsonl` 内容里的**有效 checkpoint 行数**(供 Repo 列表行的 badge)。
///
/// 口径与 [`parse_jsonl`] 对齐:跳空行 + 跳 `api_version != "checkpoint/1.0.0"` 的行。两点差异是
/// 为"仓库发现热路径上的计数"做的取舍,且都不影响计数准确性:
/// 1. 只探测 `api_version` 一个字段(不反序列化整条 Checkpoint),避免 materialize 大 diff 串;
/// 2. 对坏 JSON 行**宽容跳过**(`parse_jsonl` 会严格报错 —— 那是 Checkpoints 页的权威路径;
///    badge 不应因某行损坏就让整个仓库发现失败)。
pub fn count_valid_lines(content: &str) -> u32 {
    #[derive(serde::Deserialize)]
    struct ApiVersionProbe {
        #[serde(default)]
        api_version: String,
    }
    let mut n: u32 = 0;
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(p) = serde_json::from_str::<ApiVersionProbe>(line) {
            if p.api_version == CHECKPOINT_API_VERSION {
                n = n.saturating_add(1);
            }
        }
    }
    n
}

/// 读 + 解析。文件不存在 / 目录不存在都返回 `Ok(vec![])`(初始态);
/// 调用方应先用 `probe_presence` 区分 DirMissing(走 degraded) vs FileMissing/FileExists。
pub async fn read_checkpoints(
    repo_workdir: &Path,
    base_commit_sha: &str,
) -> Result<Vec<Checkpoint>> {
    read_checkpoints_in_ai_dir(&repo_workdir.join(".git").join("ai"), base_commit_sha).await
}

pub async fn read_checkpoints_in_ai_dir(
    ai_dir: &Path,
    base_commit_sha: &str,
) -> Result<Vec<Checkpoint>> {
    let path = checkpoints_path_in_ai_dir(ai_dir, base_commit_sha);
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(e)),
    };
    let mut checkpoints = parse_jsonl(&content)?;
    // timestamp desc 排序(working_log.rs:148-151 写入时是 append-only 增序,我们反转)
    checkpoints.sort_by_key(|c| std::cmp::Reverse(c.timestamp));
    Ok(checkpoints)
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn ai_agent_line(ts: u64) -> String {
        // 注意:agent_id 必须存在(可为 null),字段必填上游严格
        format!(
            r#"{{"kind":"AiAgent","diff":"","author":"claude","entries":[],"timestamp":{ts},"agent_id":{{"tool":"claude","id":"sess-1","model":"opus"}},"line_stats":{{"additions":3,"deletions":0,"additions_sloc":2,"deletions_sloc":0}},"api_version":"checkpoint/1.0.0"}}"#
        )
    }

    #[test]
    fn parse_pascalcase_kind_from_jsonl() {
        // 关键事实锁:CheckpointKind 在 jsonl 里是 PascalCase,不是 snake_case
        let line = ai_agent_line(1_000_000);
        let v = parse_jsonl(&line).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].kind, CheckpointKind::AiAgent);

        // 反向:序列化也必须是 "AiAgent" 字面
        let json = serde_json::to_string(&v[0]).unwrap();
        assert!(json.contains(r#""kind":"AiAgent""#));
        assert!(!json.contains(r#""kind":"ai_agent""#));
    }

    #[test]
    fn parse_all_four_kinds_roundtrip() {
        for (label, kind) in [
            ("Human", CheckpointKind::Human),
            ("AiAgent", CheckpointKind::AiAgent),
            ("AiTab", CheckpointKind::AiTab),
            ("KnownHuman", CheckpointKind::KnownHuman),
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{}\"", label));
            let back: CheckpointKind = serde_json::from_str(&json).unwrap();
            assert_eq!(back, kind);
        }
    }

    #[test]
    fn parse_skips_empty_lines() {
        let content = format!("\n{}\n\n{}\n", ai_agent_line(1), ai_agent_line(2));
        let v = parse_jsonl(&content).unwrap();
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn parse_skips_incompatible_api_version() {
        let incompatible = r#"{"kind":"AiAgent","diff":"","author":"x","entries":[],"timestamp":1,"agent_id":null,"api_version":"checkpoint/2.0.0"}"#;
        let compatible = ai_agent_line(10);
        let content = format!("{}\n{}\n", incompatible, compatible);
        let v = parse_jsonl(&content).unwrap();
        // 不兼容版本被静默跳过,只留兼容那条
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].timestamp, 10);
    }

    #[test]
    fn parse_skips_when_api_version_is_default_empty() {
        // api_version 字段缺失 → serde_default 空字符串 → 不匹配 → 跳过(对齐上游行为)
        let no_api = r#"{"kind":"AiAgent","diff":"","author":"x","entries":[],"timestamp":1,"agent_id":null}"#;
        let v = parse_jsonl(no_api).unwrap();
        assert!(v.is_empty());
    }

    #[test]
    fn parse_fails_with_line_number_on_invalid_json() {
        let bad = format!("{}\n{{not json", ai_agent_line(1));
        let err = parse_jsonl(&bad).unwrap_err();
        assert!(err.to_string().contains("第 2 行"));
    }

    #[test]
    fn count_valid_lines_skips_empty_incompatible_and_bad_json() {
        // 口径与 parse_jsonl 对齐(跳空行 + 跳不兼容 api_version),但对坏 JSON 行宽容跳过而非报错。
        let incompatible = r#"{"kind":"AiAgent","diff":"","author":"x","entries":[],"timestamp":1,"agent_id":null,"api_version":"checkpoint/2.0.0"}"#;
        let content = format!(
            "\n{}\n{}\n{{not json\n{}\n",
            ai_agent_line(1),
            incompatible,
            ai_agent_line(2)
        );
        // 仅两条 ai_agent_line 计数;空行 / 不兼容版本 / 坏 JSON 各跳过(不 panic、不报错)
        assert_eq!(count_valid_lines(&content), 2);
        assert_eq!(count_valid_lines(""), 0);
    }

    #[test]
    fn parse_accepts_agent_id_missing_as_none() {
        // serde 对 Option<T> 字段缺失天然视为 None;无需显式标注。
        let no_agent_id = r#"{"kind":"AiAgent","diff":"","author":"x","entries":[],"timestamp":1,"api_version":"checkpoint/1.0.0"}"#;
        let v = parse_jsonl(no_agent_id).unwrap();
        assert_eq!(v.len(), 1);
        assert!(v[0].agent_id.is_none());
    }

    #[test]
    fn parse_accepts_agent_id_null() {
        // agent_id: null 合法(Option<AgentId> 字段必须出现,值可 null)
        let with_null = r#"{"kind":"Human","diff":"","author":"alice","entries":[],"timestamp":1,"agent_id":null,"api_version":"checkpoint/1.0.0"}"#;
        let v = parse_jsonl(with_null).unwrap();
        assert_eq!(v.len(), 1);
        assert!(v[0].agent_id.is_none());
    }

    #[test]
    fn parse_default_kind_is_human() {
        // kind 字段缺失 → 默认 Human(对齐上游 :91-93 serde_default)
        let no_kind = r#"{"diff":"","author":"x","entries":[],"timestamp":1,"agent_id":null,"api_version":"checkpoint/1.0.0"}"#;
        let v = parse_jsonl(no_kind).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].kind, CheckpointKind::Human);
    }

    #[test]
    fn parse_known_human_metadata_roundtrip() {
        let json = r#"{"kind":"KnownHuman","diff":"","author":"alice","entries":[],"timestamp":1,"agent_id":null,"api_version":"checkpoint/1.0.0","known_human_metadata":{"editor":"vscode","editor_version":"1.85.0","extension_version":"0.4.1"}}"#;
        let v = parse_jsonl(json).unwrap();
        let meta = v[0].known_human_metadata.as_ref().unwrap();
        assert_eq!(meta.editor, "vscode");
        assert_eq!(meta.editor_version, "1.85.0");
    }

    #[test]
    fn parse_trace_id_optional() {
        let with_trace = r#"{"kind":"AiAgent","diff":"","author":"x","entries":[],"timestamp":1,"agent_id":{"tool":"claude","id":"s","model":"m"},"api_version":"checkpoint/1.0.0","trace_id":"t_abcdef01234567"}"#;
        let v = parse_jsonl(with_trace).unwrap();
        assert_eq!(v[0].trace_id.as_deref(), Some("t_abcdef01234567"));

        // 缺失 trace_id 时为 None
        let v2 = parse_jsonl(&ai_agent_line(5)).unwrap();
        assert!(v2[0].trace_id.is_none());
    }

    #[test]
    fn parse_line_attribution_with_overrode() {
        let json = r#"{"kind":"AiAgent","diff":"","author":"x","entries":[{"file":"src/foo.rs","blob_sha":"abc","line_attributions":[{"start_line":1,"end_line":5,"author_id":"prompt-1","overrode":"prompt-0"}]}],"timestamp":1,"agent_id":{"tool":"claude","id":"s","model":"m"},"api_version":"checkpoint/1.0.0"}"#;
        let v = parse_jsonl(json).unwrap();
        let la = &v[0].entries[0].line_attributions[0];
        assert_eq!(la.start_line, 1);
        assert_eq!(la.end_line, 5);
        assert_eq!(la.author_id, "prompt-1");
        assert_eq!(la.overrode.as_deref(), Some("prompt-0"));
    }

    #[test]
    fn parse_empty_string_yields_empty_vec() {
        assert!(parse_jsonl("").unwrap().is_empty());
        assert!(parse_jsonl("\n\n   \n").unwrap().is_empty());
    }

    #[test]
    fn checkpoints_path_layout() {
        let workdir = Path::new("D:/repo");
        let p = checkpoints_path(workdir, "abc123");
        let expected = workdir
            .join(".git")
            .join("ai")
            .join("working_logs")
            .join("abc123")
            .join("checkpoints.jsonl");
        assert_eq!(p, expected);
    }

    #[test]
    fn linked_worktree_storage_ai_dir_layout() {
        let common = Path::new("D:/repo/.git");
        let git_dir = common.join("worktrees").join("feature-a");
        let ai = worktree_storage_ai_dir(&git_dir, common);
        assert_eq!(ai, common.join("ai").join("worktrees").join("feature-a"));
    }

    #[test]
    fn main_worktree_storage_ai_dir_layout() {
        let common = Path::new("D:/repo/.git");
        assert_eq!(worktree_storage_ai_dir(common, common), common.join("ai"));
    }

    #[test]
    fn probe_presence_dir_missing() {
        // 不存在的路径 → DirMissing
        let p = probe_presence(Path::new("D:/nonexistent-repo-xyz"), "abc");
        assert_eq!(p, WorkingLogPresence::DirMissing);
    }
}
