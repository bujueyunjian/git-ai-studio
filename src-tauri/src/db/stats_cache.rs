//! `commit_stats_cache` 表的 DAO。
//!
//! # 失效策略(两维度)
//! `git-ai stats <sha> --json` 输出受两类外部状态影响,任一变都要重跑:
//!
//! 1. **notes_oid** —— `git notes --ref=ai list <sha>` 的 blob OID。
//!    上游 `git-ai/src/authorship/stats.rs:388` 调 `get_authorship`。
//!    `git ai checkpoint` 补打 / `git ai rewrite-authorship` 重写会让 OID 变化。
//!    commit 无 ai notes 时为空串 `""`(空串相等也算命中)。
//!
//! 2. **ignore_hash** —— 仓库根 `.git-ai-ignore` 的 SHA-256(P10 #29)。
//!    上游 `git-ai/src/authorship/ignore.rs:230-243` 的
//!    `effective_ignore_patterns` 会读取该文件并合入 ignore 列表;
//!    `git-ai stats` 内部据此过滤文件,改动直接影响 additions/deletions。
//!    Studio 不传 CLI `--ignore`,因此只需 hash 这一文件。
//!    文件不存在 → `""`(与"上游加载到空 patterns"一致)。
//!
//! 查询时若 `(notes_oid, ignore_hash)` 与当前不一致,**视为 miss**(由调用方重跑 git-ai 并 `put`)。
//! 比 24h TTL 精确零浪费。

use std::collections::HashMap;

use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::git_ai::stats::{AiStats, RangeAuthorshipStats};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedStats {
    pub stats: AiStats,
    pub notes_oid: String,
    /// `.git-ai-ignore` 内容的 SHA-256 hex(空字符串表示该 repo 当时无此文件)。
    /// 见 `crate::git_ai::ignore::compute_ignore_hash`。
    pub ignore_hash: String,
    pub fetched_at_unix_ms: i64,
}

/// 单 sha 查询。**调用方必须在命中后比对 `notes_oid` 与 `ignore_hash` 是否与当前一致**,任一不一致视为 miss。
pub fn get(conn: &Connection, repo: &str, sha: &str) -> Result<Option<CachedStats>> {
    let mut stmt = conn
        .prepare(
            "SELECT notes_oid, ignore_hash, fetched_at, payload FROM commit_stats_cache \
             WHERE repo_path = ?1 AND commit_sha = ?2",
        )
        .map_err(|e| AppError::Other(format!("prepare get: {e}")))?;
    let row = stmt.query_row(params![repo, sha], |r| {
        let oid: String = r.get(0)?;
        let ignore_hash: String = r.get(1)?;
        let fetched_at: i64 = r.get(2)?;
        let payload: String = r.get(3)?;
        Ok((oid, ignore_hash, fetched_at, payload))
    });
    match row {
        Ok((oid, ignore_hash, fetched_at, payload)) => {
            let stats: AiStats = serde_json::from_str(&payload).map_err(AppError::Json)?;
            Ok(Some(CachedStats {
                stats,
                notes_oid: oid,
                ignore_hash,
                fetched_at_unix_ms: fetched_at,
            }))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(AppError::Other(format!("get: {e}"))),
    }
}

/// 批量查询。返回 `sha → CachedStats` map(SQL 一次 `IN (...)` 拉取)。
///
/// 调用方拿到 map 后,对每个 sha:
/// 1. 没在 map 里 → miss,跑 git-ai
/// 2. 在 map 里且 `notes_oid == 当前 oid` && `ignore_hash == 当前 hash` → 命中
/// 3. 在 map 里但任一不匹配 → 视为 miss,重跑 git-ai 并 put 覆盖
pub fn batch_get(
    conn: &Connection,
    repo: &str,
    shas: &[String],
) -> Result<HashMap<String, CachedStats>> {
    if shas.is_empty() {
        return Ok(HashMap::new());
    }
    // SQLite 默认 SQLITE_MAX_VARIABLE_NUMBER ≥ 999(新版 32766),P5 上限 500 commit 远小于此。
    let placeholders = std::iter::repeat_n("?", shas.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT commit_sha, notes_oid, ignore_hash, fetched_at, payload FROM commit_stats_cache \
         WHERE repo_path = ? AND commit_sha IN ({})",
        placeholders
    );
    let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(1 + shas.len());
    bound.push(&repo);
    for s in shas {
        bound.push(s);
    }
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| AppError::Other(format!("prepare batch_get: {e}")))?;
    let rows = stmt
        .query_map(params_from_iter(bound.iter().copied()), |r| {
            let sha: String = r.get(0)?;
            let oid: String = r.get(1)?;
            let ignore_hash: String = r.get(2)?;
            let fetched_at: i64 = r.get(3)?;
            let payload: String = r.get(4)?;
            Ok((sha, oid, ignore_hash, fetched_at, payload))
        })
        .map_err(|e| AppError::Other(format!("query batch_get: {e}")))?;
    let mut out = HashMap::with_capacity(shas.len());
    for row in rows {
        let (sha, oid, ignore_hash, fetched_at, payload) =
            row.map_err(|e| AppError::Other(format!("row: {e}")))?;
        let stats: AiStats = serde_json::from_str(&payload).map_err(AppError::Json)?;
        out.insert(
            sha,
            CachedStats {
                stats,
                notes_oid: oid,
                ignore_hash,
                fetched_at_unix_ms: fetched_at,
            },
        );
    }
    Ok(out)
}

pub fn put(
    conn: &Connection,
    repo: &str,
    sha: &str,
    notes_oid: &str,
    ignore_hash: &str,
    stats: &AiStats,
) -> Result<()> {
    let payload = serde_json::to_string(stats).map_err(AppError::Json)?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR REPLACE INTO commit_stats_cache \
         (repo_path, commit_sha, notes_oid, ignore_hash, fetched_at, payload) \
         VALUES (?, ?, ?, ?, ?, ?)",
        params![repo, sha, notes_oid, ignore_hash, now_ms, payload],
    )
    .map_err(|e| AppError::Other(format!("put: {e}")))?;
    Ok(())
}

pub fn clear_repo(conn: &Connection, repo: &str) -> Result<usize> {
    let affected = conn
        .execute(
            "DELETE FROM commit_stats_cache WHERE repo_path = ?",
            params![repo],
        )
        .map_err(|e| AppError::Other(format!("clear_repo: {e}")))?;
    Ok(affected)
}

pub fn clear_all(conn: &Connection) -> Result<usize> {
    let affected = conn
        .execute("DELETE FROM commit_stats_cache", [])
        .map_err(|e| AppError::Other(format!("clear_all: {e}")))?;
    Ok(affected)
}

pub fn count_for_repo(conn: &Connection, repo: &str) -> Result<u64> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM commit_stats_cache WHERE repo_path = ?",
            params![repo],
            |r| r.get(0),
        )
        .map_err(|e| AppError::Other(format!("count: {e}")))?;
    Ok(count.max(0) as u64)
}

/// `range_summary_cache` 表的 DAO —— `git-ai stats <start>..<end> --json` 的范围聚合缓存。
///
/// # 与 per-commit 缓存的区别
/// 单 commit stats 用 (notes_oid, ignore_hash) 两维精确失效;range 聚合是仓库级粗粒度,
/// 用 (notes_ref_oid, ignore_hash) 失效:`refs/notes/ai` 整棵树任意变动都让全部 range 缓存
/// 重算(见 `git_ai::notes::read_notes_ref_oid`)。比 per-commit 更保守,但 range 本就粗粒度。
///
/// # 缓存键
/// - 定位:`(repo_path, start_sha, end_sha)` —— start 即窗口最旧 commit 的 `^`(或空树 hash),
///   end 即窗口最新 commit,与 `get_history` 的窗口推导逻辑共享(`history.rs::derive_range_window`)。
/// - 失效维度:`(notes_ref_oid, ignore_hash)` —— 命中后比对,任一不一致视为 miss。
pub mod range {
    use super::*;

    /// 一条 range 缓存行(已通过键定位,失效判定交调用方比对 `notes_ref_oid`/`ignore_hash`)。
    #[derive(Debug, Clone)]
    pub struct CachedRangeSummary {
        pub summary: RangeAuthorshipStats,
        pub notes_ref_oid: String,
        pub ignore_hash: String,
    }

    /// 按 `(repo, start_sha, end_sha)` 查 range 缓存。返回行后,**调用方必须**比对
    /// `notes_ref_oid` 与 `ignore_hash` 是否与当前一致,任一不一致视为 miss。
    pub fn get(
        conn: &Connection,
        repo: &str,
        start_sha: &str,
        end_sha: &str,
    ) -> Result<Option<CachedRangeSummary>> {
        let mut stmt = conn
            .prepare(
                "SELECT notes_ref_oid, ignore_hash, payload FROM range_summary_cache \
                 WHERE repo_path = ?1 AND start_sha = ?2 AND end_sha = ?3",
            )
            .map_err(|e| AppError::Other(format!("prepare range get: {e}")))?;
        let row = stmt.query_row(params![repo, start_sha, end_sha], |r| {
            let notes_ref_oid: String = r.get(0)?;
            let ignore_hash: String = r.get(1)?;
            let payload: String = r.get(2)?;
            Ok((notes_ref_oid, ignore_hash, payload))
        });
        match row {
            Ok((notes_ref_oid, ignore_hash, payload)) => {
                let summary: RangeAuthorshipStats =
                    serde_json::from_str(&payload).map_err(AppError::Json)?;
                Ok(Some(CachedRangeSummary {
                    summary,
                    notes_ref_oid,
                    ignore_hash,
                }))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(AppError::Other(format!("range get: {e}"))),
        }
    }

    /// 写入 / 覆盖一条 range 缓存(同键 INSERT OR REPLACE)。
    pub fn put(
        conn: &Connection,
        repo: &str,
        start_sha: &str,
        end_sha: &str,
        notes_ref_oid: &str,
        ignore_hash: &str,
        summary: &RangeAuthorshipStats,
    ) -> Result<()> {
        let payload = serde_json::to_string(summary).map_err(AppError::Json)?;
        let now_ms = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT OR REPLACE INTO range_summary_cache \
             (repo_path, start_sha, end_sha, notes_ref_oid, ignore_hash, fetched_at, payload) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                repo,
                start_sha,
                end_sha,
                notes_ref_oid,
                ignore_hash,
                now_ms,
                payload
            ],
        )
        .map_err(|e| AppError::Other(format!("range put: {e}")))?;
        Ok(())
    }

    pub fn clear_repo(conn: &Connection, repo: &str) -> Result<usize> {
        conn.execute(
            "DELETE FROM range_summary_cache WHERE repo_path = ?",
            params![repo],
        )
        .map_err(|e| AppError::Other(format!("range clear_repo: {e}")))
    }

    pub fn clear_all(conn: &Connection) -> Result<usize> {
        conn.execute("DELETE FROM range_summary_cache", [])
            .map_err(|e| AppError::Other(format!("range clear_all: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory_for_test;

    fn sample() -> AiStats {
        AiStats {
            human_additions: 10,
            ai_additions: 5,
            ai_accepted: 5,
            git_diff_added_lines: 15,
            ..Default::default()
        }
    }

    #[test]
    fn round_trip_get_put() {
        let db = open_in_memory_for_test().unwrap();
        let conn = db.lock().unwrap();
        put(&conn, "D:\\repo\\a", "abc123", "oid-1", "ih-1", &sample()).unwrap();
        let got = get(&conn, "D:\\repo\\a", "abc123").unwrap().unwrap();
        assert_eq!(got.stats.ai_additions, 5);
        assert_eq!(got.notes_oid, "oid-1");
        assert_eq!(got.ignore_hash, "ih-1");
        assert!(got.fetched_at_unix_ms > 0);
    }

    #[test]
    fn get_returns_none_when_absent() {
        let db = open_in_memory_for_test().unwrap();
        let conn = db.lock().unwrap();
        assert!(get(&conn, "D:\\repo\\a", "absent").unwrap().is_none());
    }

    #[test]
    fn put_replaces_on_conflict() {
        let db = open_in_memory_for_test().unwrap();
        let conn = db.lock().unwrap();
        put(&conn, "D:\\repo\\a", "abc", "oid-1", "ih-1", &sample()).unwrap();
        let mut s2 = sample();
        s2.ai_additions = 99;
        put(&conn, "D:\\repo\\a", "abc", "oid-2", "ih-2", &s2).unwrap();
        let got = get(&conn, "D:\\repo\\a", "abc").unwrap().unwrap();
        assert_eq!(got.stats.ai_additions, 99);
        assert_eq!(got.notes_oid, "oid-2");
        assert_eq!(got.ignore_hash, "ih-2");
    }

    #[test]
    fn batch_get_partial_hits() {
        let db = open_in_memory_for_test().unwrap();
        let conn = db.lock().unwrap();
        put(&conn, "D:\\repo\\a", "sha1", "o1", "ih", &sample()).unwrap();
        put(&conn, "D:\\repo\\a", "sha2", "o2", "ih", &sample()).unwrap();
        let map = batch_get(
            &conn,
            "D:\\repo\\a",
            &["sha1".into(), "sha2".into(), "sha3".into()],
        )
        .unwrap();
        assert_eq!(map.len(), 2);
        assert!(map.contains_key("sha1"));
        assert!(map.contains_key("sha2"));
        assert!(!map.contains_key("sha3"));
        // ignore_hash 字段也回读
        assert_eq!(map.get("sha1").unwrap().ignore_hash, "ih");
    }

    #[test]
    fn batch_get_empty_input_skips_sql() {
        let db = open_in_memory_for_test().unwrap();
        let conn = db.lock().unwrap();
        let map = batch_get(&conn, "D:\\repo\\a", &[]).unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn repo_isolation() {
        let db = open_in_memory_for_test().unwrap();
        let conn = db.lock().unwrap();
        put(&conn, "D:\\repo\\a", "sha1", "o", "", &sample()).unwrap();
        put(&conn, "D:\\repo\\b", "sha1", "o", "", &sample()).unwrap();
        assert!(get(&conn, "D:\\repo\\a", "sha1").unwrap().is_some());
        assert!(get(&conn, "D:\\repo\\b", "sha1").unwrap().is_some());
        let n = clear_repo(&conn, "D:\\repo\\a").unwrap();
        assert_eq!(n, 1);
        assert!(get(&conn, "D:\\repo\\a", "sha1").unwrap().is_none());
        assert!(get(&conn, "D:\\repo\\b", "sha1").unwrap().is_some());
    }

    #[test]
    fn count_and_clear_all() {
        let db = open_in_memory_for_test().unwrap();
        let conn = db.lock().unwrap();
        put(&conn, "D:\\repo\\a", "sha1", "o", "", &sample()).unwrap();
        put(&conn, "D:\\repo\\a", "sha2", "o", "", &sample()).unwrap();
        put(&conn, "D:\\repo\\b", "sha1", "o", "", &sample()).unwrap();
        assert_eq!(count_for_repo(&conn, "D:\\repo\\a").unwrap(), 2);
        let n = clear_all(&conn).unwrap();
        assert_eq!(n, 3);
        assert_eq!(count_for_repo(&conn, "D:\\repo\\a").unwrap(), 0);
    }

    #[test]
    fn empty_ignore_hash_round_trips() {
        // 空串 ignore_hash 对应"该 repo 无 .git-ai-ignore",必须能正常写入和回读。
        let db = open_in_memory_for_test().unwrap();
        let conn = db.lock().unwrap();
        put(&conn, "D:\\repo\\a", "sha1", "oid", "", &sample()).unwrap();
        let got = get(&conn, "D:\\repo\\a", "sha1").unwrap().unwrap();
        assert_eq!(got.ignore_hash, "");
    }

    // ===== range_summary_cache(range 聚合缓存)=====

    mod range_cache {
        use super::*;
        use crate::db::stats_cache::range;
        use crate::git_ai::stats::RangeAuthorshipStats;

        fn sample_summary(commits_with: u64, total: u64) -> RangeAuthorshipStats {
            let mut s = RangeAuthorshipStats::default();
            s.authorship_stats.total_commits = total;
            s.authorship_stats.commits_with_authorship = commits_with;
            s
        }

        #[test]
        fn round_trip_get_put() {
            let db = open_in_memory_for_test().unwrap();
            let conn = db.lock().unwrap();
            range::put(
                &conn,
                "D:\\repo\\a",
                "start1",
                "end1",
                "ref-oid-1",
                "ih-1",
                &sample_summary(9, 12),
            )
            .unwrap();
            let got = range::get(&conn, "D:\\repo\\a", "start1", "end1")
                .unwrap()
                .unwrap();
            assert_eq!(got.summary.authorship_stats.commits_with_authorship, 9);
            assert_eq!(got.summary.authorship_stats.total_commits, 12);
            assert_eq!(got.notes_ref_oid, "ref-oid-1");
            assert_eq!(got.ignore_hash, "ih-1");
        }

        #[test]
        fn get_returns_none_when_absent() {
            let db = open_in_memory_for_test().unwrap();
            let conn = db.lock().unwrap();
            assert!(range::get(&conn, "D:\\repo\\a", "s", "e")
                .unwrap()
                .is_none());
        }

        #[test]
        fn put_replaces_on_same_key() {
            // 同 (repo, start, end) 第二次 put 覆盖,失效维度也一并更新。
            let db = open_in_memory_for_test().unwrap();
            let conn = db.lock().unwrap();
            range::put(&conn, "r", "s", "e", "ref-1", "ih-1", &sample_summary(1, 2)).unwrap();
            range::put(&conn, "r", "s", "e", "ref-2", "ih-2", &sample_summary(5, 6)).unwrap();
            let got = range::get(&conn, "r", "s", "e").unwrap().unwrap();
            assert_eq!(got.summary.authorship_stats.commits_with_authorship, 5);
            assert_eq!(got.notes_ref_oid, "ref-2");
            assert_eq!(got.ignore_hash, "ih-2");
        }

        #[test]
        fn distinct_windows_isolated() {
            // 同仓库不同窗口 (start,end) 互不覆盖。
            let db = open_in_memory_for_test().unwrap();
            let conn = db.lock().unwrap();
            range::put(&conn, "r", "s1", "e1", "ref", "", &sample_summary(1, 1)).unwrap();
            range::put(&conn, "r", "s2", "e2", "ref", "", &sample_summary(2, 2)).unwrap();
            assert_eq!(
                range::get(&conn, "r", "s1", "e1")
                    .unwrap()
                    .unwrap()
                    .summary
                    .authorship_stats
                    .total_commits,
                1
            );
            assert_eq!(
                range::get(&conn, "r", "s2", "e2")
                    .unwrap()
                    .unwrap()
                    .summary
                    .authorship_stats
                    .total_commits,
                2
            );
        }

        #[test]
        fn clear_repo_and_all() {
            let db = open_in_memory_for_test().unwrap();
            let conn = db.lock().unwrap();
            range::put(&conn, "r-a", "s", "e", "ref", "", &sample_summary(1, 1)).unwrap();
            range::put(&conn, "r-b", "s", "e", "ref", "", &sample_summary(1, 1)).unwrap();
            assert_eq!(range::clear_repo(&conn, "r-a").unwrap(), 1);
            assert!(range::get(&conn, "r-a", "s", "e").unwrap().is_none());
            assert!(range::get(&conn, "r-b", "s", "e").unwrap().is_some());
            assert_eq!(range::clear_all(&conn).unwrap(), 1);
            assert!(range::get(&conn, "r-b", "s", "e").unwrap().is_none());
        }
    }
}
