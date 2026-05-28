pub mod auth;
pub mod binary;
pub mod blame;
pub mod daemon;
pub mod debug;
pub mod ignore;
pub mod notes;
pub mod notes_ai;
pub mod shim;
pub mod show;
pub mod stats;

/// `refs/notes/ai` 是 git-ai 上游约定的 authorship notes 命名空间(`git_ai_standard_v3.0.0.md` §1.1)。
/// notes.rs(P5 探测) 与 notes_ai.rs(P7 viewer) 共用此常量与 `is_missing_notes_ref` 判定,
/// 保证未来上游若改 namespace 只需在此一处同步(评审 P7 #41)。
pub(crate) const NOTES_REF: &str = "refs/notes/ai";

/// 仅当 stderr 命中以下精确串才算"`refs/notes/ai` 不存在"的合法初始态。
/// 其余 stderr(包括"not a git repository" / "permission denied")应一律 fail-fast,
/// 否则会把真错误吞成"空数据" UI(评审 A:no-fallback 硬约束)。
pub(crate) fn is_missing_notes_ref(stderr: &str) -> bool {
    let s = stderr.trim();
    s.is_empty()
        || s.contains("refs/notes/ai") && (s.contains("does not exist") || s.contains("not found"))
}
