//! `~/.claude/settings.json` 的合并语义。
//!
//! - 保留 hooks 段之外的所有字段(permissions / theme / mcpServers 等)。
//! - 在 PreToolUse / PostToolUse 中:
//!   - 仅识别"git-ai owned"条目(含 `checkpoint claude`)
//!   - 同 matcher 下若已有 git-ai owned 条目 → in-place 替换;无 → 在头部追加
//!   - 其它 hook 条目(cc-switch / 用户写的)**不动**

use std::fs;

use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::paths::claude_settings_json;

use super::backups;
use super::model::HooksMode;

#[derive(Debug, Clone)]
pub struct MergeReport {
    pub changed: bool,
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
}

const MATCHER: &str = "Write|Edit|MultiEdit";

/// 把当前 settings.json 合并到目标模式。
/// `command_path` 仅在 mode=Official 时使用 — 通常是 git-ai 二进制的绝对路径。
pub fn merge_to_mode(mode: HooksMode, command_path: Option<&str>) -> Result<MergeReport> {
    let path = claude_settings_json();
    let raw = if path.exists() {
        fs::read_to_string(&path).map_err(AppError::Io)?
    } else {
        "{}".to_string()
    };
    let mut v: Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::Other(format!("settings.json JSON 解析失败: {e}")))?;
    if !v.is_object() {
        return Err(AppError::Other(
            "settings.json 根不是对象,拒绝写入".to_string(),
        ));
    }

    let mut report = MergeReport {
        changed: false,
        added: vec![],
        updated: vec![],
        removed: vec![],
    };

    // 写入前先备份
    if path.exists() {
        let _ = backups::backup_claude_settings()?;
    }

    // 确保 hooks / PreToolUse / PostToolUse 存在
    let hooks = v
        .as_object_mut()
        .unwrap()
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        return Err(AppError::Other(
            "settings.json 的 hooks 字段不是对象".to_string(),
        ));
    }

    for stage in ["PreToolUse", "PostToolUse"] {
        let stage_arr = hooks
            .as_object_mut()
            .unwrap()
            .entry(stage.to_string())
            .or_insert_with(|| json!([]));
        if !stage_arr.is_array() {
            return Err(AppError::Other(format!(
                "settings.json hooks.{stage} 不是数组"
            )));
        }
        let arr = stage_arr.as_array_mut().unwrap();
        match mode {
            HooksMode::Official => write_official(arr, stage, command_path, &mut report)?,
            HooksMode::None => remove_git_ai_owned(arr, stage, &mut report),
        }
    }

    // 原子写
    let tmp = with_extension(&path, "json.tmp");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(AppError::Io)?;
    }
    fs::write(
        &tmp,
        serde_json::to_string_pretty(&v).map_err(AppError::Json)?,
    )
    .map_err(AppError::Io)?;
    fs::rename(&tmp, &path).map_err(AppError::Io)?;
    Ok(report)
}

fn write_official(
    arr: &mut Vec<Value>,
    stage: &str,
    command_path: Option<&str>,
    report: &mut MergeReport,
) -> Result<()> {
    let cmd_path = command_path
        .ok_or_else(|| AppError::Other("Official 模式需要提供 git-ai 命令路径".to_string()))?;
    let command = format!("{cmd_path} checkpoint claude --hook-input stdin");
    let new_block = json!({
        "matcher": MATCHER,
        "hooks": [{ "type": "command", "command": command }]
    });
    upsert_git_ai_owned(arr, stage, new_block, report);
    Ok(())
}

fn upsert_git_ai_owned(
    arr: &mut Vec<Value>,
    stage: &str,
    new_block: Value,
    report: &mut MergeReport,
) {
    // 遍历找出含 git-ai owned hook 的 matcher block(若有)
    let mut idx_found: Option<usize> = None;
    for (i, block) in arr.iter().enumerate() {
        let inner = block.get("hooks").and_then(|v| v.as_array());
        let Some(inner) = inner else { continue };
        if inner.iter().any(is_git_ai_owned) {
            idx_found = Some(i);
            break;
        }
    }
    match idx_found {
        Some(i) => {
            if arr[i] != new_block {
                arr[i] = new_block;
                report.changed = true;
                report.updated.push(stage.into());
            }
        }
        None => {
            arr.insert(0, new_block);
            report.changed = true;
            report.added.push(stage.into());
        }
    }
}

fn remove_git_ai_owned(arr: &mut Vec<Value>, stage: &str, report: &mut MergeReport) {
    let before = arr.len();
    arr.retain(|block| {
        let inner = block.get("hooks").and_then(|v| v.as_array());
        match inner {
            Some(inner) => !inner.iter().any(is_git_ai_owned),
            None => true,
        }
    });
    if arr.len() != before {
        report.changed = true;
        report.removed.push(stage.into());
    }
}

/// 判定 hook 是否由 git-ai 拥有(可被我们 update / 删除)。
fn is_git_ai_owned(h: &Value) -> bool {
    let cmd = h.get("command").and_then(|v| v.as_str()).unwrap_or("");
    cmd.contains("checkpoint claude")
}

fn with_extension(p: &std::path::Path, ext: &str) -> std::path::PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".");
    s.push(ext);
    std::path::PathBuf::from(s)
}

/// 给 UI 看的诊断:当前 settings.json 是 Official / None。
pub fn detect_mode() -> HooksMode {
    let path = claude_settings_json();
    let Ok(raw) = fs::read_to_string(&path) else {
        return HooksMode::None;
    };
    let Ok(v): std::result::Result<Value, _> = serde_json::from_str(&raw) else {
        return HooksMode::None;
    };
    for stage in ["PreToolUse", "PostToolUse"] {
        let arr = v
            .pointer(&format!("/hooks/{stage}"))
            .and_then(|v| v.as_array());
        let Some(arr) = arr else { continue };
        for block in arr {
            let inner = block.get("hooks").and_then(|v| v.as_array());
            let Some(inner) = inner else { continue };
            for h in inner {
                if is_git_ai_owned(h) {
                    return HooksMode::Official;
                }
            }
        }
    }
    HooksMode::None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn setup() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("GIT_AI_STUDIO_TEST_HOME", tmp.path());
        // 同时初始化 ~/.claude 目录,放空 settings.json
        let claude_dir = tmp.path().join(".claude");
        fs::create_dir_all(&claude_dir).unwrap();
        tmp
    }

    #[test]
    #[serial]
    fn detect_none_on_empty_settings() {
        let _g = setup();
        assert_eq!(detect_mode(), HooksMode::None);
    }

    #[test]
    #[serial]
    fn merge_to_official_inserts_when_empty() {
        let _g = setup();
        let rep = merge_to_mode(HooksMode::Official, Some("/home/u/.git-ai/bin/git-ai")).unwrap();
        assert!(rep.changed);
        assert_eq!(rep.added.len(), 2);
        assert_eq!(detect_mode(), HooksMode::Official);
    }

    #[test]
    #[serial]
    fn merge_preserves_unrelated_hooks() {
        let _g = setup();
        // 先放一份用户自己写的 hook
        let p = claude_settings_json();
        fs::write(
            &p,
            r#"{ "permissions": {"deny": ["x"]}, "hooks": { "PostToolUse": [
                { "matcher": "X", "hooks": [{ "type": "command", "command": "echo user-hook" }] }
            ]}}"#,
        )
        .unwrap();
        let _ = merge_to_mode(HooksMode::Official, Some("/home/u/.git-ai/bin/git-ai")).unwrap();
        let raw = fs::read_to_string(&p).unwrap();
        assert!(
            raw.contains("\"echo user-hook\""),
            "user hook 被吃掉了: {raw}"
        );
        assert!(raw.contains("checkpoint claude"));
        assert!(raw.contains("permissions"));
    }

    #[test]
    #[serial]
    fn none_mode_strips_git_ai_owned_only() {
        let _g = setup();
        let p = claude_settings_json();
        fs::write(
            &p,
            r#"{"hooks": {
                "PostToolUse": [
                  { "matcher": "X", "hooks": [{ "type": "command", "command": "/g/git-ai checkpoint claude" }] },
                  { "matcher": "Y", "hooks": [{ "type": "command", "command": "echo user" }] }
                ]
            }}"#,
        )
        .unwrap();
        let _ = merge_to_mode(HooksMode::None, None).unwrap();
        let raw = fs::read_to_string(&p).unwrap();
        assert!(!raw.contains("checkpoint claude"));
        assert!(raw.contains("echo user"));
    }
}
