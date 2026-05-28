//! Cursor: `~/.cursor/hooks.json`
//!
//! 期望结构(见 `Git-ai 问题分析步骤.md` 附录 D):顶层是数组或对象,
//! 包含一项,其中 `command` / `script` 字段值是 `git-ai checkpoint cursor ...`。

use async_trait::async_trait;
use serde_json::Value;
use std::path::PathBuf;

use crate::paths::cursor_hooks_json;

use super::{AgentHookStatus, AgentKind, AgentProbe, HookType};

pub struct CursorProbe;

#[async_trait]
impl AgentProbe for CursorProbe {
    fn kind(&self) -> AgentKind {
        AgentKind::Cursor
    }
    fn config_path(&self) -> PathBuf {
        cursor_hooks_json()
    }
    async fn probe(&self) -> AgentHookStatus {
        let path = self.config_path();
        if !path.exists() {
            return AgentHookStatus {
                agent: AgentKind::Cursor,
                detected: false,
                configured: false,
                config_path: Some(path.display().to_string()),
                hook_type: None,
                raw_excerpt: None,
                issues: vec!["未检测到 ~/.cursor/hooks.json (Cursor 未安装或未配置)".into()],
            };
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                return AgentHookStatus {
                    agent: AgentKind::Cursor,
                    detected: true,
                    configured: false,
                    config_path: Some(path.display().to_string()),
                    hook_type: None,
                    raw_excerpt: None,
                    issues: vec![format!("hooks.json 读取失败: {e}")],
                };
            }
        };
        let json: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                return AgentHookStatus {
                    agent: AgentKind::Cursor,
                    detected: true,
                    configured: false,
                    config_path: Some(path.display().to_string()),
                    hook_type: None,
                    raw_excerpt: None,
                    issues: vec![format!("hooks.json 解析失败: {e}")],
                };
            }
        };
        parse_value(json, path)
    }
}

/// 只在 `command` / `script` / `cmd` / `exec` 这类执行命令字段值里匹配,
/// 防止 description / example / docs 等纯文档字段含字符串误判 configured。
const EXEC_KEYS: &[&str] = &["command", "script", "cmd", "exec", "run"];

fn parse_value(json: Value, path: PathBuf) -> AgentHookStatus {
    let mut configured = false;
    let mut excerpt: Option<String> = None;

    fn check_str_at_exec_key(v: &Value, hit: &mut bool, ex: &mut Option<String>) {
        match v {
            Value::Object(o) => {
                for (k, child) in o {
                    if EXEC_KEYS.contains(&k.to_lowercase().as_str()) {
                        if let Some(s) = child.as_str() {
                            if is_git_ai_cursor_hook(s) {
                                *hit = true;
                                if ex.is_none() {
                                    *ex = Some(s.to_string());
                                }
                            }
                        }
                    } else {
                        check_str_at_exec_key(child, hit, ex);
                    }
                }
            }
            Value::Array(a) => {
                for child in a {
                    check_str_at_exec_key(child, hit, ex);
                }
            }
            _ => {}
        }
    }
    check_str_at_exec_key(&json, &mut configured, &mut excerpt);

    let issues = if configured {
        vec![]
    } else {
        vec!["hooks.json 的 command/script 字段中未找到 'git-ai checkpoint cursor' 入口".into()]
    };

    AgentHookStatus {
        agent: AgentKind::Cursor,
        detected: true,
        configured,
        config_path: Some(path.display().to_string()),
        hook_type: if configured {
            Some(HookType::Command)
        } else {
            None
        },
        raw_excerpt: excerpt,
        issues,
    }
}

/// 与 claude 相同的严格化匹配:不允许 shell 短路 / 注释,且首 token 必须是 git-ai。
fn is_git_ai_cursor_hook(s: &str) -> bool {
    let trimmed = s.trim();
    if trimmed.contains(';')
        || trimmed.contains("&&")
        || trimmed.contains("||")
        || trimmed.contains('#')
    {
        return false;
    }
    if !trimmed.contains("checkpoint cursor") {
        return false;
    }
    if let Some(first) = trimmed.split_whitespace().next() {
        let lower = first.to_ascii_lowercase();
        if lower.ends_with("git-ai") || lower.ends_with("git-ai.exe") {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn command_field_is_picked_up() {
        let v = json!([{
            "name": "git-ai",
            "events": ["edit"],
            "command": "/home/u/.git-ai/bin/git-ai checkpoint cursor --hook-input stdin"
        }]);
        let s = parse_value(v, PathBuf::from("x"));
        assert!(s.configured);
        assert!(s.raw_excerpt.unwrap().contains("checkpoint cursor"));
    }

    #[test]
    fn description_field_does_not_count() {
        let v = json!([{
            "name": "noop",
            "description": "this used to be git-ai checkpoint cursor",
            "command": "echo nothing"
        }]);
        let s = parse_value(v, PathBuf::from("x"));
        assert!(!s.configured);
    }

    #[test]
    fn shell_short_circuit_rejected() {
        assert!(!is_git_ai_cursor_hook("true && git-ai checkpoint cursor"));
        assert!(!is_git_ai_cursor_hook("# git-ai checkpoint cursor"));
    }

    #[test]
    fn missing_target_is_unconfigured() {
        let v = json!([{ "command": "other-tool --bla" }]);
        let s = parse_value(v, PathBuf::from("x"));
        assert!(!s.configured);
    }
}
