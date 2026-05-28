//! Blame 模块 Tauri 命令层(P6/P10)。
//!
//! 暴露 6 个命令(3 旧 + 3 新):
//! - `get_blame(file, ranges?)` → 旧入口,等价 `get_blame_at_ref(None, file, ranges)`
//! - `list_files_at_head(sha?)` → 旧入口,等价 `list_files_at_ref(sha)`
//! - `read_file_at_head(sha?, file)` → 旧入口,等价 `read_file_at_ref(sha, file)`
//! - `get_blame_at_ref(ref?, file, ranges?)` → ref 维度 blame
//! - `list_files_at_ref(ref?)` → ref 维度文件树
//! - `read_file_at_ref(ref?, file)` → ref 维度文件内容
//!
//! # ref 语义
//! - `None` → HEAD(等价旧命令)
//! - `Some(s)` → 任意 commit-ish:本地分支名 / 完整或简短 sha / tag。**不接受 remote-tracking
//!   ref**(如 `origin/main`),原因:UI 只列本地分支 + 手贴 sha 两路。
//! - 校验走 `git rev-parse --verify <ref>^{commit}`:`^{commit}` 强制只解 commit 类对象,
//!   防止 tag/tree/blob 被误当 commit 用。失败 → degraded `RefNotFound { ref }`。
//!
//! # 错误归类
//! - **不**用 stderr 文本匹配
//! - 显式预检 ref / file 存在,避免 git-ai 子进程跑完才发现路径错
//! - 所有 git 子进程经 `proc::run_capture_with_timeout`
//!
//! # 文件 size / binary
//! - 限额 512 KB;binary 探测前 8000 byte 含 NUL
//! - 路径走 `normalize_path` 归一为 POSIX

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::git_ai::{self, blame::BlamePayload};
use crate::proc::run_capture_with_timeout;
use crate::state::AppState;

const FILE_MAX_SIZE_BYTES: u64 = 512 * 1024;
const BINARY_PROBE_BYTES: usize = 8000;
const GIT_TIMEOUT: Duration = Duration::from_secs(15);
/// 大仓库 truncate 上限。超过则返回 `truncated: true + total`,UI 提示用户搜索过滤。
const LIST_FILES_MAX: usize = 50_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlameDegradedReason {
    RepoMissing,
    GitAiMissing,
    NoHead,
    CommitNotFound {
        sha: String,
    },
    FileNotInHead {
        file: String,
    },
    FileTooLarge {
        size: u64,
        limit: u64,
    },
    FileBinary,
    /// 用户手贴 ref(分支名 / sha / tag)在仓库内不存在或不是 commit 对象。
    /// 与 CommitNotFound 区别:CommitNotFound 用于"用户期望是 sha 但 git 找不到"的语义;
    /// RefNotFound 把 ref 原文回带,前端 toast / 输入框报错都用得上。
    RefNotFound {
        #[serde(rename = "ref")]
        ref_: String,
    },
    // 删除 NoAiAuthorship:它不是"拿不到数据"的硬故障,而是"AI 维度空"的正常态。
    // 用 degraded 表达会把 hunks(commit 维度全行作者)一起丢,
    // 导致前端连"全人类 git blame 视图"都展不出。
    // 改为始终 Ok { payload },payload.lines 为空 → 前端 banner 提示 + 仍渲染作者列。
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BlameResult {
    Ok { payload: BlamePayload },
    Degraded { reason: BlameDegradedReason },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ReadFileResult {
    Ok { text: String, size: u64 },
    Degraded { reason: BlameDegradedReason },
}

/// `list_files_at_*` 输出:大仓库时截断 + 透出真实 total。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct FilesListPayload {
    pub files: Vec<String>,
    pub truncated: bool,
    pub total: usize,
}

// ===== ref-aware 命令(新)=====

/// 校验 `ref` 是否解析得到合法 commit。Some(()) = 校验通过;Err(stderr_msg) = git 子进程异常。
///
/// 用 `^{commit}` 后缀强制 peel 到 commit 对象 —— annotated tag 也能透传过去。
/// 单纯 `rev-parse --verify <ref>` 在 tag/tree 上也会成功,语义会和后续 `git show <ref>:<file>`
/// 不一致(tree 上 show 行为不同),故必须 peel。
async fn verify_ref_is_commit(
    git: &std::path::Path,
    repo: &std::path::Path,
    r: &str,
) -> Result<bool, String> {
    let spec = format!("{r}^{{commit}}");
    let out = run_capture_with_timeout(
        git,
        &["rev-parse", "--verify", "--quiet", &spec],
        Some(repo),
        GIT_TIMEOUT,
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(out.status == 0)
}

#[tauri::command]
pub async fn get_blame_at_ref(
    #[allow(non_snake_case)] r#ref: Option<String>,
    file: String,
    ranges: Option<Vec<[u32; 2]>>,
    state: State<'_, AppState>,
) -> Result<BlameResult, String> {
    let Some(repo_path_str) = take_repo_path_str(&state)? else {
        return Ok(BlameResult::Degraded {
            reason: BlameDegradedReason::RepoMissing,
        });
    };
    let repo_path = PathBuf::from(&repo_path_str);
    let git_ai_bin = match git_ai::binary::resolve() {
        Ok(p) => p,
        Err(_) => {
            return Ok(BlameResult::Degraded {
                reason: BlameDegradedReason::GitAiMissing,
            })
        }
    };
    let git = which::which("git").map_err(|_| "未找到 git 二进制".to_string())?;

    // ref 归一:None / Some("") / Some("HEAD") 都视为 HEAD,避免传 "" 给 git
    let ref_input = r#ref.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let newest_commit: &str = ref_input.unwrap_or("HEAD");

    // 1) ref 校验:None 跳过(HEAD 让上游 git-ai 自己处理空仓);Some 必须解出 commit
    if let Some(r) = ref_input {
        if !verify_ref_is_commit(&git, &repo_path, r).await? {
            return Ok(BlameResult::Degraded {
                reason: BlameDegradedReason::RefNotFound {
                    ref_: r.to_string(),
                },
            });
        }
    }

    let file_posix = normalize_path(&file);
    let ranges_tuple: Option<Vec<(u32, u32)>> = ranges.map(|v| {
        v.into_iter()
            .map(|[a, b]| (a, b))
            .filter(|(a, b)| *a > 0 && b >= a)
            .collect()
    });
    let ranges_ref = ranges_tuple.as_deref().filter(|s| !s.is_empty());

    // 2) 预检文件在该 ref 下存在,避免 git-ai 子进程跑完才发现路径错
    let spec = format!("{newest_commit}:{file_posix}");
    let exists = run_capture_with_timeout(
        &git,
        &["cat-file", "-e", &spec],
        Some(&repo_path),
        GIT_TIMEOUT,
    )
    .await
    .map_err(|e| e.to_string())?;
    if exists.status != 0 {
        return Ok(BlameResult::Degraded {
            reason: BlameDegradedReason::FileNotInHead { file: file_posix },
        });
    }

    let payload = match git_ai::blame::run_blame_analysis(
        &git_ai_bin,
        &repo_path,
        &file_posix,
        ranges_ref,
        newest_commit,
    )
    .await
    {
        Ok(p) => p,
        Err(e) => return Err(e.to_string()),
    };

    Ok(BlameResult::Ok { payload })
}

#[tauri::command]
pub async fn list_files_at_ref(
    #[allow(non_snake_case)] r#ref: Option<String>,
    state: State<'_, AppState>,
) -> Result<FilesListPayload, String> {
    let Some(repo_path_str) = take_repo_path_str(&state)? else {
        return Ok(FilesListPayload {
            files: vec![],
            truncated: false,
            total: 0,
        });
    };
    let repo_path = PathBuf::from(&repo_path_str);
    let git = which::which("git").map_err(|_| "未找到 git 二进制".to_string())?;

    let ref_input = r#ref.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let target: &str = ref_input.unwrap_or("HEAD");

    // Some(ref) 显式校验:文件树拉空与 ref 不存在不能混淆,前端要能区分"分支 OK 但是空树"和"ref 无效"
    if let Some(r) = ref_input {
        if !verify_ref_is_commit(&git, &repo_path, r).await? {
            // list_files 没有 BlameResult 这层 enum,Err 透传给前端
            // (UI 切 ref 前会先调 get_blame_at_ref 校验,此处 Err 仅作兜底)
            return Err(format!("ref 不存在或不是 commit: {r}"));
        }
    }

    let out = run_capture_with_timeout(
        &git,
        &["ls-tree", "-r", "--name-only", target],
        Some(&repo_path),
        GIT_TIMEOUT,
    )
    .await
    .map_err(|e| e.to_string())?;
    if out.status != 0 {
        // HEAD 空仓:返回空,不算错(空仓 UI 文件树自己空态)
        return Ok(FilesListPayload {
            files: vec![],
            truncated: false,
            total: 0,
        });
    }
    let all: Vec<String> = out
        .stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|s| s.to_string())
        .collect();
    let total = all.len();
    let (files, truncated) = if total > LIST_FILES_MAX {
        (all.into_iter().take(LIST_FILES_MAX).collect(), true)
    } else {
        (all, false)
    };
    Ok(FilesListPayload {
        files,
        truncated,
        total,
    })
}

#[tauri::command]
pub async fn read_file_at_ref(
    #[allow(non_snake_case)] r#ref: Option<String>,
    file: String,
    state: State<'_, AppState>,
) -> Result<ReadFileResult, String> {
    let Some(repo_path_str) = take_repo_path_str(&state)? else {
        return Ok(ReadFileResult::Degraded {
            reason: BlameDegradedReason::RepoMissing,
        });
    };
    let repo_path = PathBuf::from(&repo_path_str);
    let git = which::which("git").map_err(|_| "未找到 git 二进制".to_string())?;

    let ref_input = r#ref.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let target: &str = ref_input.unwrap_or("HEAD");
    let file_posix = normalize_path(&file);
    let spec = format!("{target}:{file_posix}");

    // 1) Some(ref) 显式校验:用 RefNotFound 表达,与 CommitNotFound 解耦(后者历史语义偏向 HEAD 缺失)
    if let Some(r) = ref_input {
        if !verify_ref_is_commit(&git, &repo_path, r).await? {
            return Ok(ReadFileResult::Degraded {
                reason: BlameDegradedReason::RefNotFound {
                    ref_: r.to_string(),
                },
            });
        }
    }

    // 2) 预检 file 是否存在
    let exists = run_capture_with_timeout(
        &git,
        &["cat-file", "-e", &spec],
        Some(&repo_path),
        GIT_TIMEOUT,
    )
    .await
    .map_err(|e| e.to_string())?;
    if exists.status != 0 {
        return Ok(ReadFileResult::Degraded {
            reason: BlameDegradedReason::FileNotInHead { file: file_posix },
        });
    }

    // 3) 拿 size
    let size_out = run_capture_with_timeout(
        &git,
        &["cat-file", "-s", &spec],
        Some(&repo_path),
        GIT_TIMEOUT,
    )
    .await
    .map_err(|e| e.to_string())?;
    if size_out.status != 0 {
        return Err(format!(
            "git cat-file -s 退出码 {}: {}",
            size_out.status,
            size_out.stderr.trim()
        ));
    }
    let size: u64 = size_out
        .stdout
        .trim()
        .parse()
        .map_err(|e| format!("git cat-file -s 输出非整数: {e}"))?;
    if size > FILE_MAX_SIZE_BYTES {
        return Ok(ReadFileResult::Degraded {
            reason: BlameDegradedReason::FileTooLarge {
                size,
                limit: FILE_MAX_SIZE_BYTES,
            },
        });
    }

    // 4) 读内容
    let out = run_capture_with_timeout(&git, &["show", &spec], Some(&repo_path), GIT_TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;
    if out.status != 0 {
        return Err(format!(
            "git show 退出码 {}: {}",
            out.status,
            out.stderr.trim()
        ));
    }

    // 5) binary 检测
    if is_likely_binary(out.stdout.as_bytes()) {
        return Ok(ReadFileResult::Degraded {
            reason: BlameDegradedReason::FileBinary,
        });
    }

    Ok(ReadFileResult::Ok {
        text: out.stdout,
        size,
    })
}

// ===== 旧入口:转调 ref 版本传 None(HEAD)=====
// 保留是为了不破坏既有 invoke 调用点 + 前端旧 wrapper。新代码请用 *_at_ref。

#[tauri::command]
pub async fn get_blame(
    file: String,
    ranges: Option<Vec<[u32; 2]>>,
    state: State<'_, AppState>,
) -> Result<BlameResult, String> {
    get_blame_at_ref(None, file, ranges, state).await
}

#[tauri::command]
pub async fn list_files_at_head(
    sha: Option<String>,
    state: State<'_, AppState>,
) -> Result<FilesListPayload, String> {
    list_files_at_ref(sha, state).await
}

#[tauri::command]
pub async fn read_file_at_head(
    sha: Option<String>,
    file: String,
    state: State<'_, AppState>,
) -> Result<ReadFileResult, String> {
    read_file_at_ref(sha, file, state).await
}

// ===== helper =====

fn take_repo_path_str(state: &State<'_, AppState>) -> Result<Option<String>, String> {
    let g = state
        .current_repo
        .read()
        .map_err(|_| "current_repo 锁中毒".to_string())?;
    Ok(g.as_ref().map(|r| r.path.clone()))
}

/// 把所有反斜杠归一为正斜杠。git ls-tree 在 Windows 上也输出 `/`,
/// 但前端可能拼出 `src\foo.rs`,这里统一防御。
pub fn normalize_path(p: &str) -> String {
    p.replace('\\', "/")
}

pub fn is_likely_binary(bytes: &[u8]) -> bool {
    let probe = &bytes[..bytes.len().min(BINARY_PROBE_BYTES)];
    probe.contains(&0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_windows_path() {
        assert_eq!(normalize_path("src\\foo.rs"), "src/foo.rs");
        assert_eq!(normalize_path("a\\b\\c"), "a/b/c");
        assert_eq!(normalize_path("already/posix"), "already/posix");
        assert_eq!(normalize_path(""), "");
    }

    #[test]
    fn binary_detection_finds_null_byte() {
        let mut buf = vec![b'a'; 100];
        assert!(!is_likely_binary(&buf));
        buf[50] = 0;
        assert!(is_likely_binary(&buf));
    }

    #[test]
    fn binary_detection_only_probes_prefix() {
        // \0 在 BINARY_PROBE_BYTES 之后不会被检测到 —— 已知 trade-off
        let mut buf = vec![b'a'; BINARY_PROBE_BYTES + 100];
        buf[BINARY_PROBE_BYTES + 50] = 0;
        assert!(!is_likely_binary(&buf), "超出探测窗口的 NUL 不算 binary");
    }

    #[test]
    fn binary_detection_empty_safe() {
        assert!(!is_likely_binary(&[]));
    }

    #[test]
    fn size_limit_is_512kb() {
        assert_eq!(FILE_MAX_SIZE_BYTES, 524_288);
    }

    #[test]
    fn list_files_max_50000() {
        assert_eq!(LIST_FILES_MAX, 50_000);
    }

    /// RefNotFound 与 CommitNotFound 的 serde tag 区分:UI 据此分发文案。
    /// 防止重构时手滑改了字段名导致前端 reason.kind 匹配失败。
    #[test]
    fn ref_not_found_serializes_distinctly() {
        let r = BlameDegradedReason::RefNotFound {
            ref_: "feat/x".into(),
        };
        let s = serde_json::to_string(&r).unwrap();
        // tag = "ref_not_found",ref 字段经 serde rename 输出为 "ref"
        assert!(
            s.contains("\"kind\":\"ref_not_found\""),
            "kind 必须是 ref_not_found,实际: {s}"
        );
        assert!(s.contains("\"ref\":\"feat/x\""), "ref 字段必须保留: {s}");
    }

    /// degraded 反序列化往返:模拟前端 -> 后端的 reason 解析,确保前后端字段名一致。
    #[test]
    fn ref_not_found_roundtrip() {
        let json = r#"{"kind":"ref_not_found","ref":"abc1234"}"#;
        let r: BlameDegradedReason = serde_json::from_str(json).unwrap();
        match r {
            BlameDegradedReason::RefNotFound { ref_ } => assert_eq!(ref_, "abc1234"),
            other => panic!("解析 RefNotFound 失败,得到: {other:?}"),
        }
    }

    /// 边界:空字符串 / 空白 ref 不应被视为合法 ref —— 由上层 trim+filter 归一为 HEAD,
    /// 这里只校验 `verify_ref_is_commit` 自身被调用前的预处理点。
    /// 该测试通过断言"None 与 Some("") 走同一 HEAD 路径"反映 ref_input filter 行为。
    #[test]
    fn ref_input_blank_is_filtered_to_none() {
        // 模拟 commands 内部的 ref 归一逻辑(None / "" / "   " → None,其余 trim 后返回)
        fn normalize(s: Option<&str>) -> Option<&str> {
            s.map(str::trim).filter(|s| !s.is_empty())
        }
        assert_eq!(normalize(None), None);
        assert_eq!(normalize(Some("")), None);
        assert_eq!(normalize(Some("   ")), None);
        assert_eq!(normalize(Some("HEAD")), Some("HEAD"));
        assert_eq!(normalize(Some("main")), Some("main"));
        assert_eq!(normalize(Some(" abc123 ")), Some("abc123"));
    }
}
