//! `~/.claude/settings.json` 的备份管理。
//!
//! 每次写入前先拷贝到 `~/.git-ai-studio/backups/claude-settings-<unix_ms>.json`,
//! 失败抛错(不静默继续)。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AppError, Result};
use crate::paths::{claude_settings_json, studio_backups_dir};

use super::model::SettingsBackup;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把当前 `~/.claude/settings.json` 备份到 backups 目录,返回备份文件绝对路径。
/// 源文件不存在时返回 Ok(None)(没有要备份的内容,不算错误)。
pub fn backup_claude_settings() -> Result<Option<PathBuf>> {
    let src = claude_settings_json();
    if !src.exists() {
        return Ok(None);
    }
    let dir = studio_backups_dir();
    fs::create_dir_all(&dir).map_err(AppError::Io)?;
    let ts = now_ms();
    let tgt = dir.join(format!("claude-settings-{ts}.json"));
    fs::copy(&src, &tgt).map_err(AppError::Io)?;
    Ok(Some(tgt))
}

/// 列出 backups 目录下的所有 claude-settings 备份(按时间倒序)。
pub fn list_backups() -> Result<Vec<SettingsBackup>> {
    let dir = studio_backups_dir();
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out: Vec<SettingsBackup> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(AppError::Io)? {
        let entry = entry.map_err(AppError::Io)?;
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if !name.starts_with("claude-settings-") || !name.ends_with(".json") {
            continue;
        }
        let ts: i64 = name
            .trim_start_matches("claude-settings-")
            .trim_end_matches(".json")
            .parse()
            .unwrap_or(0);
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(SettingsBackup {
            path: p.display().to_string(),
            at_unix_ms: ts,
            size,
        });
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.at_unix_ms));
    Ok(out)
}

/// 从备份还原到 `~/.claude/settings.json`(还原前还会再备份一次当前文件)。
/// `path` 必须位于 `studio_backups_dir()` 内 — 防路径穿越。
pub fn restore_from_backup(path: &str) -> Result<()> {
    let p = PathBuf::from(path);
    let dir = studio_backups_dir();
    let canonical = dunce::canonicalize(&p).map_err(AppError::Io)?;
    let dir_canonical = dunce::canonicalize(&dir).unwrap_or(dir);
    if !canonical.starts_with(&dir_canonical) {
        return Err(AppError::Other(format!(
            "拒绝从备份目录之外恢复: {}",
            canonical.display()
        )));
    }
    let _ = backup_claude_settings()?; // 先把当前再备一份
    let tgt = claude_settings_json();
    if let Some(parent) = tgt.parent() {
        fs::create_dir_all(parent).map_err(AppError::Io)?;
    }
    fs::copy(&canonical, &tgt).map_err(AppError::Io)?;
    Ok(())
}
