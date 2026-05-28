//! 应用本地 SQLite 数据库(`~/.git-ai-studio/studio.sqlite`)。
//!
//! 目前只承载一张表:`commit_stats_cache`(P5)。后续表(prompts 索引、历史 metrics 等)按
//! `user_version` PRAGMA 增量 migration,保持极简自写 match,无第三方 migrate 库。
//!
//! # 并发与线程模型
//! - 单 `Connection` 用 `Arc<Mutex<Connection>>` 持有(rusqlite 的 Connection !Send,但 Mutex 包后可跨 task)
//! - 所有 SQL 调用必须从 `tokio::task::spawn_blocking` 里发起,避免阻塞 tokio 调度器
//! - 调用方约定:**绝不**在持有 `db.lock()` 期间再去 acquire 其他锁(尤其 `AppState.current_repo`),
//!   先把需要的字符串 clone 出 RwLock 再走 db
//!
//! # No-fallback
//! - 打开 SQLite 失败 / migration 失败 → `AppError::Other`,UI 弹 toast 红;不静默退化到内存

pub mod stats_cache;

use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::error::{AppError, Result};
use crate::paths::studio_sqlite_path;

/// 应用持有的 db 句柄。
pub type Db = Arc<Mutex<Connection>>;

/// 当前 schema 版本。每次新增表 / 改列 +1,并在 [`migrate`] 加分支。
///
/// - v1:`commit_stats_cache`(notes_oid 失效)
/// - v2:`commit_stats_cache.ignore_hash` 列(`.git-ai-ignore` 失效,P10 #29)
/// - v3:`range_summary_cache` 表(range 聚合缓存,notes_ref_oid + ignore_hash 失效)
pub const SCHEMA_VERSION: i64 = 3;

/// 打开并初始化数据库(WAL + migration)。
pub fn open() -> Result<Db> {
    let path = studio_sqlite_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::Io)?;
    }
    let conn = Connection::open(&path)
        .map_err(|e| AppError::Other(format!("打开 SQLite 失败 {}: {e}", path.display())))?;
    init_pragmas(&conn)?;
    migrate(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

fn init_pragmas(conn: &Connection) -> Result<()> {
    // WAL 模式:并发读写性能好,且崩溃恢复更稳。
    // 内存数据库不支持 WAL,失败时忽略。
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| AppError::Other(format!("设置 synchronous=NORMAL 失败: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| AppError::Other(format!("启用 foreign_keys 失败: {e}")))?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<()> {
    let cur: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| AppError::Other(format!("读 user_version 失败: {e}")))?;
    if cur < 1 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS commit_stats_cache (
              repo_path  TEXT    NOT NULL,
              commit_sha TEXT    NOT NULL,
              notes_oid  TEXT    NOT NULL,
              fetched_at INTEGER NOT NULL,
              payload    TEXT    NOT NULL,
              PRIMARY KEY (repo_path, commit_sha)
            );
            CREATE INDEX IF NOT EXISTS idx_csc_repo ON commit_stats_cache(repo_path);
            PRAGMA user_version = 1;
            "#,
        )
        .map_err(|e| AppError::Other(format!("migration v1 失败: {e}")))?;
    }
    if cur < 2 {
        // P10 #29:`.git-ai-ignore` 改动也要让 cache 失效。新列默认 "" 等价"无 ignore",
        // 用户首次写入 `.git-ai-ignore` 时,旧行的 `ignore_hash=""` 与当前 hash 必然不匹配 → 自然 miss 重跑。
        conn.execute_batch(
            r#"
            ALTER TABLE commit_stats_cache ADD COLUMN ignore_hash TEXT NOT NULL DEFAULT '';
            PRAGMA user_version = 2;
            "#,
        )
        .map_err(|e| AppError::Other(format!("migration v2 失败: {e}")))?;
    }
    if cur < 3 {
        // range 聚合缓存:`git-ai stats <start>..<end> --json` 固有耗时长且无 per-commit 缓存,
        // 单独建表存其 RangeAuthorshipStats。失效键见 `stats_cache::range` 文档:
        // (repo_path, start_sha, end_sha) 定位窗口,(notes_ref_oid, ignore_hash) 判失效。
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS range_summary_cache (
              repo_path     TEXT    NOT NULL,
              start_sha     TEXT    NOT NULL,
              end_sha       TEXT    NOT NULL,
              notes_ref_oid TEXT    NOT NULL,
              ignore_hash   TEXT    NOT NULL,
              fetched_at    INTEGER NOT NULL,
              payload       TEXT    NOT NULL,
              PRIMARY KEY (repo_path, start_sha, end_sha)
            );
            CREATE INDEX IF NOT EXISTS idx_rsc_repo ON range_summary_cache(repo_path);
            PRAGMA user_version = 3;
            "#,
        )
        .map_err(|e| AppError::Other(format!("migration v3 失败: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
pub fn open_in_memory_for_test() -> Result<Db> {
    let conn =
        Connection::open_in_memory().map_err(|e| AppError::Other(format!("内存 db 失败: {e}")))?;
    // 内存库不支持 WAL,init_pragmas 内已 ignore journal_mode 错误。
    init_pragmas(&conn)?;
    migrate(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_memory_then_query_version() {
        let db = open_in_memory_for_test().unwrap();
        let conn = db.lock().unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
    }

    #[test]
    fn table_exists_after_migrate() {
        let db = open_in_memory_for_test().unwrap();
        let conn = db.lock().unwrap();
        let name: String = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='commit_stats_cache'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "commit_stats_cache");
    }

    #[test]
    fn range_summary_cache_table_exists_after_migrate() {
        let db = open_in_memory_for_test().unwrap();
        let conn = db.lock().unwrap();
        let name: String = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='range_summary_cache'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "range_summary_cache");
    }
}
