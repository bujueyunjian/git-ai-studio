//! "按人 + 时间范围"指标视图(P12)。
//!
//! # 总体流程
//! 几乎是 [`crate::commands::history`] 的简化版:
//! 1. 取仓库 path 与 git-ai 二进制(任一不存在 → degraded)
//! 2. `repo::commits::list_recent(max=500)` + `filter_by_range`
//! 3. 一次性拉 git notes oid map + `.git-ai-ignore` hash 算失效维度
//! 4. `stats_cache::batch_get` 一次 SQL,split 出 hit / miss
//! 5. miss 列表用 `buffer_unordered(3)` 并发跑 `git-ai stats <sha> --json`,写回 cache
//! 6. 按 `author_email.to_lowercase()` 分组累加得到 [`PersonRow`] 列表
//!
//! # 与 history.rs 的差异
//! - **不**调 `git-ai stats <start>..<end>`(没有 hook 覆盖率卡)
//! - **不**按本地日期分桶(People 视图只看人,日期序列在 Dashboard)
//! - 分组 key = `author_email.to_lowercase()`;不引 git mailmap
//!
//! # 跨锁约束
//! 与 history.rs 同:db 操作走 `spawn_blocking`,不在持有 db 锁时再去 `current_repo.read()`。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use chrono::Local;
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::history::{
    filter_by_range, is_window_truncated, split_hits_and_misses, TimeRange,
};
use crate::db::stats_cache;
use crate::error::AppError;
use crate::git_ai;
use crate::repo::commits;
use crate::state::AppState;

/// 与 history.rs 保持一致的并发上限(Windows CreateProcess 冷启动重)。
const STATS_CONCURRENCY: usize = 3;
/// 单次最多拉的 commit 上限(防 list_recent 返回过多)。
const MAX_COMMITS_HARD_CAP: u32 = 500;

/// 单个 commit 的轻量记录,仅供前端在 People 行展开时跳转 Stats 用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PersonCommitRef {
    pub sha: String,
    pub short: String,
    pub authored_at: String,
    pub subject: String,
    pub is_merge: bool,
    pub ai_additions: u64,
    pub human_additions: u64,
    pub unknown_additions: u64,
}

/// 一个 identity(author_email.lowercase())的聚合行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PersonRow {
    /// `author_email.to_lowercase()`;identity 主键。
    pub identity_key: String,
    /// 显示名:取该 identity 下最近一次 commit 的 `%an`(`commits` 按 list_recent 已倒序)。
    pub author_name: String,
    /// 原样邮箱(未 lowercase,做大小写显示对齐)。
    pub author_email: String,
    pub commits: u32,
    pub human_additions: u64,
    pub unknown_additions: u64,
    pub ai_additions: u64,
    /// `human + unknown + ai`(三桶并列,与上游 stats.rs:114 一致)。
    pub total_additions: u64,
    /// 该 identity 涉及的 commit 列表(已按 authored_at 倒序,与 list_recent 顺序一致)。
    pub commit_refs: Vec<PersonCommitRef>,
}

/// 全窗口总计,放在表头总览卡上展示。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PeopleTotals {
    pub commits: u32,
    pub human_additions: u64,
    pub unknown_additions: u64,
    pub ai_additions: u64,
    pub total_additions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PeopleBreakdownPayload {
    pub range: TimeRange,
    pub range_start_unix_ms: i64,
    pub range_end_unix_ms: i64,
    /// 按 identity_key 排序稳定;前端可在此基础上再做 UI 排序。
    pub rows: Vec<PersonRow>,
    pub grand_total: PeopleTotals,
    /// git-ai stats 子进程失败的 commit sha 列表。前端必须显式提示用户,不让 0 桶兜底。
    pub failed_shas: Vec<String>,
    /// `list_recent(500)` 取到刚好 500 条 ⇒ 可能漏算更老 commit。前端提示一致。
    pub truncated: bool,
    pub cache_hits: u32,
    pub took_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum PeopleBreakdownResult {
    Ok { payload: PeopleBreakdownPayload },
    Degraded { reason: DegradedReason },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DegradedReason {
    RepoMissing,
    GitAiMissing,
}

#[tauri::command]
pub async fn get_people_breakdown(
    range: TimeRange,
    state: State<'_, AppState>,
) -> Result<PeopleBreakdownResult, String> {
    let started = Instant::now();
    let now = Local::now();
    let (range_start, range_end) = crate::commands::history::time_range_bounds(&range, now);
    let range_start_unix_ms = range_start.timestamp_millis();
    let range_end_unix_ms = range_end.timestamp_millis();

    // 1. 取仓库 path(clone 出锁,后续不再持锁)
    let repo_path: String = {
        let g = state
            .current_repo
            .read()
            .map_err(|_| "current_repo 锁中毒".to_string())?;
        match g.as_ref() {
            Some(r) => r.path.clone(),
            None => {
                return Ok(PeopleBreakdownResult::Degraded {
                    reason: DegradedReason::RepoMissing,
                });
            }
        }
    };
    let repo_path_buf = PathBuf::from(&repo_path);

    // 2. git-ai 二进制
    let git_ai_bin = match git_ai::binary::resolve() {
        Ok(p) => p,
        Err(_) => {
            return Ok(PeopleBreakdownResult::Degraded {
                reason: DegradedReason::GitAiMissing,
            });
        }
    };

    // 3. list_recent + window filter
    let recent = commits::list_recent(&repo_path_buf, MAX_COMMITS_HARD_CAP)
        .await
        .map_err(|e| e.to_string())?;
    // 截断只在 500 cap 可能挡住窗口内更老 commit 时才报(与 history.rs 同口径,修复"选一天也误报")。
    let truncated = is_window_truncated(&recent, MAX_COMMITS_HARD_CAP as usize, range_start);
    let window = filter_by_range(&recent, &range, now);

    if window.is_empty() {
        return Ok(PeopleBreakdownResult::Ok {
            payload: PeopleBreakdownPayload {
                range,
                range_start_unix_ms,
                range_end_unix_ms,
                rows: vec![],
                grand_total: PeopleTotals::default(),
                failed_shas: vec![],
                truncated,
                cache_hits: 0,
                took_ms: started.elapsed().as_millis() as u64,
            },
        });
    }

    // 4. 一次性拉全量 git notes oid map
    let oid_map = git_ai::notes::read_all_notes_oids(&repo_path_buf)
        .await
        .map_err(|e| e.to_string())?;

    // 4.5. 算 `.git-ai-ignore` 当前 hash(失效模型第二维度,与 history.rs 同源)
    let current_ignore_hash =
        git_ai::ignore::compute_ignore_hash(&repo_path_buf).map_err(|e| e.to_string())?;

    // 5. batch_get cache(单次 SQL 读所有窗口 sha)
    let shas: Vec<String> = window.iter().map(|c| c.sha.clone()).collect();
    let cached_map = {
        let conn_arc = state.db.clone();
        let repo_clone = repo_path.clone();
        let shas_clone = shas.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn_arc
                .lock()
                .map_err(|_| AppError::Other("db 锁中毒".into()))?;
            stats_cache::batch_get(&conn, &repo_clone, &shas_clone)
        })
        .await
        .map_err(|e| format!("spawn_blocking 失败: {e}"))?
        .map_err(|e| e.to_string())?
    };

    // 6. split hit / miss(失效模型与 history.rs 完全共享)
    let (mut hits, miss_shas) =
        split_hits_and_misses(&shas, &oid_map, &current_ignore_hash, &cached_map);

    // 7. miss 并发跑 git-ai stats <sha> --json
    let miss_results: Vec<(String, Result<git_ai::stats::AiStats, AppError>)> =
        stream::iter(miss_shas.clone())
            .map(|sha| {
                let bin = git_ai_bin.clone();
                let rp = repo_path_buf.clone();
                async move {
                    let stats = git_ai::stats::run_stats(&bin, &rp, Some(&sha)).await;
                    (sha, stats)
                }
            })
            .buffer_unordered(STATS_CONCURRENCY)
            .collect()
            .await;

    // 把成功项写入内存 hits,失败收集到 failed_shas(no-fallback:0 桶不兜底)
    let mut put_buf: Vec<(String, String, git_ai::stats::AiStats)> = Vec::new();
    let mut failed_shas: Vec<String> = Vec::new();
    for (sha, res) in miss_results {
        match res {
            Ok(stats) => {
                let oid = oid_map.get(&sha).cloned().unwrap_or_default();
                hits.insert(sha.clone(), stats.clone());
                put_buf.push((sha, oid, stats));
            }
            Err(e) => {
                log::warn!("git-ai stats {} 失败: {}", sha, e);
                failed_shas.push(sha);
            }
        }
    }
    let cache_hits = (shas.len() - miss_shas.len()) as u32;

    // 8. 批量写回 cache(单事务)
    if !put_buf.is_empty() {
        let conn_arc = state.db.clone();
        let repo_clone = repo_path.clone();
        let ignore_hash_clone = current_ignore_hash.clone();
        tokio::task::spawn_blocking(move || -> Result<(), AppError> {
            let mut conn = conn_arc
                .lock()
                .map_err(|_| AppError::Other("db 锁中毒".into()))?;
            let tx = conn
                .transaction()
                .map_err(|e| AppError::Other(format!("tx begin: {e}")))?;
            for (sha, oid, stats) in &put_buf {
                stats_cache::put(&tx, &repo_clone, sha, oid, &ignore_hash_clone, stats)?;
            }
            tx.commit()
                .map_err(|e| AppError::Other(format!("tx commit: {e}")))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("spawn_blocking 写 cache 失败: {e}"))?
        .map_err(|e| e.to_string())?;
    }

    // 9. 按 author_email.to_lowercase() 分组累加
    //    failed_shas 内的 commit 在 hits 中不存在 → 跳过(不让 0 桶兜底污染数字)
    let rows = aggregate_rows(&window, &hits, &failed_shas);
    let grand_total = grand_total_of(&rows);

    Ok(PeopleBreakdownResult::Ok {
        payload: PeopleBreakdownPayload {
            range,
            range_start_unix_ms,
            range_end_unix_ms,
            rows,
            grand_total,
            failed_shas,
            truncated,
            cache_hits,
            took_ms: started.elapsed().as_millis() as u64,
        },
    })
}

/// 把窗口内 commit 按 `author_email.to_lowercase()` 聚合为 [`PersonRow`] 列表。
///
/// # 决策
/// - identity_key = `author_email.to_lowercase()`(不引 mailmap)
/// - `author_name / author_email` 取该 identity 下**最近一次 commit**(list_recent 已倒序,所以
///   遍历时第一条非空就是最新)
/// - failed_shas 内的 commit 跳过 stats 累加,但仍计入 commit_refs 与 commits 数 —
///   评审一致性:前端 banner 提示"X 条数据采集失败",total/AI 行数自然偏低,不被 0 桶兜底污染
/// - 行内 commit_refs 保留 list_recent 顺序(authored_at 倒序)
/// - 输出顺序:identity_key 字典序(稳定);前端可在此基础上再做交互式排序
pub fn aggregate_rows(
    window: &[commits::CommitBrief],
    hits: &std::collections::HashMap<String, git_ai::stats::AiStats>,
    failed_shas: &[String],
) -> Vec<PersonRow> {
    // BTreeMap 保证 identity_key 字典序输出,前端排序稳定锚点
    let mut by_identity: BTreeMap<String, PersonRow> = BTreeMap::new();
    let failed: std::collections::HashSet<&str> = failed_shas.iter().map(|s| s.as_str()).collect();

    for c in window {
        let key = c.author_email.to_lowercase();
        let row = by_identity.entry(key.clone()).or_insert_with(|| PersonRow {
            identity_key: key.clone(),
            // 第一次见到此 identity 时记录展示名(list_recent 倒序,第一条即最新)
            author_name: c.author_name.clone(),
            author_email: c.author_email.clone(),
            commits: 0,
            human_additions: 0,
            unknown_additions: 0,
            ai_additions: 0,
            total_additions: 0,
            commit_refs: Vec::new(),
        });

        row.commits = row.commits.saturating_add(1);

        // failed_shas 内 commit:计 commits 数 + commit_refs(0 占位),但不累加 stats
        let is_failed = failed.contains(c.sha.as_str());
        let stats = if is_failed { None } else { hits.get(&c.sha) };

        if let Some(s) = stats {
            row.human_additions = row.human_additions.saturating_add(s.human_additions);
            row.unknown_additions = row.unknown_additions.saturating_add(s.unknown_additions);
            row.ai_additions = row.ai_additions.saturating_add(s.ai_additions);
        }

        row.commit_refs.push(PersonCommitRef {
            sha: c.sha.clone(),
            short: c.short.clone(),
            authored_at: c.authored_at.clone(),
            subject: c.subject.clone(),
            is_merge: c.is_merge,
            ai_additions: stats.map(|s| s.ai_additions).unwrap_or(0),
            human_additions: stats.map(|s| s.human_additions).unwrap_or(0),
            unknown_additions: stats.map(|s| s.unknown_additions).unwrap_or(0),
        });
    }

    // 收尾计算 total_additions(human + unknown + ai,3 桶并列)
    let mut rows: Vec<PersonRow> = by_identity.into_values().collect();
    for r in &mut rows {
        r.total_additions = r
            .human_additions
            .saturating_add(r.unknown_additions)
            .saturating_add(r.ai_additions);
    }
    rows
}

/// 整窗汇总:对所有 row 再求一次和。给前端总览卡用。
pub fn grand_total_of(rows: &[PersonRow]) -> PeopleTotals {
    let mut t = PeopleTotals::default();
    for r in rows {
        t.commits = t.commits.saturating_add(r.commits);
        t.human_additions = t.human_additions.saturating_add(r.human_additions);
        t.unknown_additions = t.unknown_additions.saturating_add(r.unknown_additions);
        t.ai_additions = t.ai_additions.saturating_add(r.ai_additions);
    }
    t.total_additions = t
        .human_additions
        .saturating_add(t.unknown_additions)
        .saturating_add(t.ai_additions);
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_ai::stats::AiStats;
    use std::collections::HashMap;

    fn brief(
        sha: &str,
        authored: &str,
        author_name: &str,
        author_email: &str,
    ) -> commits::CommitBrief {
        commits::CommitBrief {
            sha: sha.to_string(),
            short: sha.chars().take(7).collect(),
            authored_at: authored.to_string(),
            author_name: author_name.to_string(),
            author_email: author_email.to_string(),
            subject: format!("commit {sha}"),
            parents: vec![],
            is_merge: false,
        }
    }

    fn stat(human: u64, unknown: u64, ai: u64) -> AiStats {
        AiStats {
            human_additions: human,
            unknown_additions: unknown,
            ai_additions: ai,
            ai_accepted: ai,
            ..Default::default()
        }
    }

    #[test]
    fn groups_by_lowercased_email() {
        // 同一邮箱大小写不同 → 必须聚合到同一行
        let window = vec![
            brief(
                "a1",
                "2026-05-12T10:00:00+08:00",
                "Alice",
                "Alice@Example.com",
            ),
            brief(
                "a2",
                "2026-05-11T10:00:00+08:00",
                "alice",
                "alice@example.com",
            ),
            brief("b1", "2026-05-10T10:00:00+08:00", "Bob", "bob@example.com"),
        ];
        let mut hits = HashMap::new();
        hits.insert("a1".to_string(), stat(10, 0, 20));
        hits.insert("a2".to_string(), stat(5, 0, 5));
        hits.insert("b1".to_string(), stat(100, 0, 0));

        let rows = aggregate_rows(&window, &hits, &[]);
        // alice 邮箱大小写差异 → 同一行
        assert_eq!(rows.len(), 2);
        let alice = rows
            .iter()
            .find(|r| r.identity_key == "alice@example.com")
            .expect("alice row");
        assert_eq!(alice.commits, 2);
        assert_eq!(alice.ai_additions, 25);
        assert_eq!(alice.human_additions, 15);
        // 展示名取最新一次 commit(list_recent 倒序的第一条) → "Alice"
        assert_eq!(alice.author_name, "Alice");
        assert_eq!(alice.author_email, "Alice@Example.com");
        // total = human + unknown + ai
        assert_eq!(alice.total_additions, 40);

        let bob = rows
            .iter()
            .find(|r| r.identity_key == "bob@example.com")
            .unwrap();
        assert_eq!(bob.commits, 1);
        assert_eq!(bob.total_additions, 100);
    }

    #[test]
    fn failed_shas_count_commits_but_not_stats() {
        // 评审 A no-fallback:子进程失败 commit 不被 0 桶兜底污染指标
        let window = vec![
            brief(
                "a1",
                "2026-05-12T10:00:00+08:00",
                "Alice",
                "alice@example.com",
            ),
            brief(
                "a2-failed",
                "2026-05-11T10:00:00+08:00",
                "Alice",
                "alice@example.com",
            ),
        ];
        let mut hits = HashMap::new();
        hits.insert("a1".to_string(), stat(10, 0, 20));
        // a2-failed 不在 hits

        let rows = aggregate_rows(&window, &hits, &["a2-failed".to_string()]);
        assert_eq!(rows.len(), 1);
        let alice = &rows[0];
        // commits 计数为 2(含失败的),便于"分母"一致
        assert_eq!(alice.commits, 2);
        // stats 只算成功的 a1
        assert_eq!(alice.ai_additions, 20);
        assert_eq!(alice.human_additions, 10);
        assert_eq!(alice.total_additions, 30);
        // commit_refs 仍含 2 条(便于前端跳转 / banner 对照)
        assert_eq!(alice.commit_refs.len(), 2);
    }

    #[test]
    fn empty_window_yields_empty_rows() {
        let rows = aggregate_rows(&[], &HashMap::new(), &[]);
        assert!(rows.is_empty());
        let g = grand_total_of(&rows);
        assert_eq!(g.commits, 0);
        assert_eq!(g.total_additions, 0);
    }

    #[test]
    fn grand_total_sums_all_rows() {
        let window = vec![
            brief(
                "a1",
                "2026-05-12T10:00:00+08:00",
                "Alice",
                "alice@example.com",
            ),
            brief("b1", "2026-05-11T10:00:00+08:00", "Bob", "bob@example.com"),
        ];
        let mut hits = HashMap::new();
        hits.insert("a1".to_string(), stat(10, 5, 20));
        hits.insert("b1".to_string(), stat(100, 0, 30));

        let rows = aggregate_rows(&window, &hits, &[]);
        let g = grand_total_of(&rows);
        assert_eq!(g.commits, 2);
        assert_eq!(g.human_additions, 110);
        assert_eq!(g.unknown_additions, 5);
        assert_eq!(g.ai_additions, 50);
        assert_eq!(g.total_additions, 165);
    }

    #[test]
    fn rows_sorted_by_identity_key() {
        // BTreeMap 保证字典序输出(稳定锚点,前端可在此基础上做交互排序)
        let window = vec![
            brief(
                "c1",
                "2026-05-12T10:00:00+08:00",
                "Charlie",
                "charlie@example.com",
            ),
            brief(
                "a1",
                "2026-05-11T10:00:00+08:00",
                "Alice",
                "alice@example.com",
            ),
            brief("b1", "2026-05-10T10:00:00+08:00", "Bob", "bob@example.com"),
        ];
        let hits = HashMap::new();
        let rows = aggregate_rows(&window, &hits, &[]);
        let keys: Vec<&str> = rows.iter().map(|r| r.identity_key.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                "alice@example.com",
                "bob@example.com",
                "charlie@example.com"
            ]
        );
    }
}
