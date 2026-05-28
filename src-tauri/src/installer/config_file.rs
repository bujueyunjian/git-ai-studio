//! `~/.git-ai/config.json` 的"合并而非覆盖"读写。
//! git-ai 自己写这个文件,我们只动几个字段并保留其它键。
//! 修改前会先备份到 `~/.git-ai-studio/backups/git-ai-config-<ts>.json`。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::paths::{git_ai_config_json, studio_backups_dir};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GitAiConfigPatch {
    pub disable_auto_updates: Option<bool>,
    pub update_channel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitAiConfig {
    pub disable_auto_updates: bool,
    pub update_channel: String,
    /// 保留其它字段供前端展示
    #[serde(flatten)]
    pub other: serde_json::Map<String, Value>,
}

impl Default for GitAiConfig {
    fn default() -> Self {
        Self {
            disable_auto_updates: false,
            update_channel: "stable".to_string(),
            other: serde_json::Map::new(),
        }
    }
}

pub fn read() -> Result<GitAiConfig> {
    let path = git_ai_config_json();
    if !path.exists() {
        return Ok(GitAiConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(AppError::Io)?;
    let v: Value = serde_json::from_str(&raw).map_err(AppError::Json)?;
    let obj = v
        .as_object()
        .ok_or_else(|| AppError::Other(format!("{} 不是 JSON 对象", path.display())))?;
    let disable_auto_updates = obj
        .get("disable_auto_updates")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let update_channel = obj
        .get("update_channel")
        .and_then(|x| x.as_str())
        .unwrap_or("stable")
        .to_string();
    let mut other = obj.clone();
    other.remove("disable_auto_updates");
    other.remove("update_channel");
    Ok(GitAiConfig {
        disable_auto_updates,
        update_channel,
        other,
    })
}

pub fn write(patch: &GitAiConfigPatch) -> Result<GitAiConfig> {
    let path = git_ai_config_json();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(AppError::Io)?;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());

    // 备份原文件
    if path.exists() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup_dir = studio_backups_dir();
        let _ = fs::create_dir_all(&backup_dir);
        let backup = backup_dir.join(format!("git-ai-config-{ts}.json"));
        let _ = fs::write(&backup, &raw);
    }

    let mut v: Value =
        serde_json::from_str(&raw).unwrap_or_else(|_| Value::Object(Default::default()));
    let obj = v
        .as_object_mut()
        .ok_or_else(|| AppError::Other("已存在的 config.json 不是 JSON 对象".to_string()))?;

    if let Some(b) = patch.disable_auto_updates {
        obj.insert("disable_auto_updates".into(), Value::Bool(b));
    }
    if let Some(c) = &patch.update_channel {
        obj.insert("update_channel".into(), Value::String(c.clone()));
    }

    // 原子写
    let tmp = with_extension(&path, "json.tmp");
    fs::write(
        &tmp,
        serde_json::to_string_pretty(&v).map_err(AppError::Json)?,
    )
    .map_err(AppError::Io)?;
    fs::rename(&tmp, &path).map_err(AppError::Io)?;

    read()
}

fn with_extension(p: &std::path::Path, ext: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".");
    s.push(ext);
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use tempfile::TempDir;

    // 全局 env 在多线程下相互污染,用 serial 强制串行。
    fn setup_isolated_home() -> TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("GIT_AI_STUDIO_TEST_HOME", tmp.path());
        tmp
    }

    #[test]
    #[serial]
    fn read_returns_default_when_file_missing() {
        let _g = setup_isolated_home();
        let c = read().unwrap();
        assert!(!c.disable_auto_updates);
        assert_eq!(c.update_channel, "stable");
    }

    #[test]
    #[serial]
    fn write_then_read_round_trip() {
        let _g = setup_isolated_home();
        // 先写一份带额外字段的原始 config
        let p = git_ai_config_json();
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(
            &p,
            r#"{"existing_token": "secret", "update_channel": "stable"}"#,
        )
        .unwrap();

        let updated = write(&GitAiConfigPatch {
            disable_auto_updates: Some(true),
            update_channel: Some("none".into()),
        })
        .unwrap();
        assert!(updated.disable_auto_updates);
        assert_eq!(updated.update_channel, "none");
        // 关键:other 里仍能拿到原来的 existing_token
        assert_eq!(
            updated.other.get("existing_token").and_then(|v| v.as_str()),
            Some("secret")
        );
    }
}
