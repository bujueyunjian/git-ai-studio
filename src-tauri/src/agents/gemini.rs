//! Gemini: `~/.gemini/settings.json`
//!
//! # 权威 schema 来源
//! 上游 `git-ai/src/mdm/agents/gemini.rs:18-66`:
//! - 配置路径:`~/.gemini/settings.json`
//! - hooks 结构:`hooks.BeforeTool` / `hooks.AfterTool` 是 matcher block 数组,
//!   每个 block 有 `matcher`(如 `"*"`)+ `hooks` 数组,每个 hook 有 `command`
//! - hook 命令:`<git-ai> checkpoint gemini --hook-input stdin`
//!
//! # 与 Claude 的区别
//! Claude 用 `PreToolUse` / `PostToolUse`,Gemini 用 `BeforeTool` / `AfterTool`;
//! 命中子串是 `checkpoint gemini`(非 `checkpoint claude`)。

use async_trait::async_trait;
use serde_json::Value;
use std::path::PathBuf;

use crate::paths::gemini_settings_json;

use super::{AgentHookStatus, AgentKind, AgentProbe, HookType};

pub struct GeminiProbe;

#[async_trait]
impl AgentProbe for GeminiProbe {
    fn kind(&self) -> AgentKind {
        AgentKind::Gemini
    }
    fn config_path(&self) -> PathBuf {
        gemini_settings_json()
    }
    async fn probe(&self) -> AgentHookStatus {
        let path = self.config_path();
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => return missing(path),
        };
        let json: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                return AgentHookStatus {
                    agent: AgentKind::Gemini,
                    detected: true,
                    configured: false,
                    config_path: Some(path.display().to_string()),
                    hook_type: None,
                    raw_excerpt: None,
                    issues: vec![format!("settings.json 解析失败: {e}")],
                };
            }
        };
        parse_value(json, path)
    }
}

fn missing(path: PathBuf) -> AgentHookStatus {
    AgentHookStatus {
        agent: AgentKind::Gemini,
        detected: false,
        configured: false,
        config_path: Some(path.display().to_string()),
        hook_type: None,
        raw_excerpt: None,
        issues: vec!["未检测到 ~/.gemini/settings.json (Gemini 未配置)".into()],
    }
}

fn parse_value(json: Value, path: PathBuf) -> AgentHookStatus {
    let mut issues = Vec::new();
    let mut excerpt: Option<String> = None;
    let mut configured = false;

    let hooks = json.get("hooks");
    if hooks.is_none() {
        issues.push("settings.json 缺少 hooks 段".into());
    }

    // 上游把 git-ai 命令写进 BeforeTool / AfterTool 的 matcher block;两段都扫,任一命中即 configured。
    for which in ["BeforeTool", "AfterTool"] {
        let Some(arr) = hooks.and_then(|h| h.get(which)).and_then(|v| v.as_array()) else {
            continue;
        };
        for block in arr {
            let Some(inner) = block.get("hooks").and_then(|v| v.as_array()) else {
                continue;
            };
            for hook in inner {
                let command = hook.get("command").and_then(|v| v.as_str()).unwrap_or("");
                if is_git_ai_gemini_hook(command) {
                    configured = true;
                    if excerpt.is_none() {
                        excerpt = Some(format!("command: {command}"));
                    }
                }
            }
        }
    }

    if !configured {
        issues.push("hooks 段中未找到 'git-ai checkpoint gemini' 配置".into());
    }

    AgentHookStatus {
        agent: AgentKind::Gemini,
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

/// 判断 hook 命令是否真的执行 git-ai checkpoint gemini。严格化口径同 [`super::claude`]:
/// 拒绝 shell 短路 / 注释 / 多命令,且首 token 必须是 git-ai 可执行。
fn is_git_ai_gemini_hook(s: &str) -> bool {
    let trimmed = s.trim();
    if trimmed.contains(';')
        || trimmed.contains("&&")
        || trimmed.contains("||")
        || trimmed.contains('#')
    {
        return false;
    }
    if trimmed.contains("checkpoint gemini") {
        if let Some(first) = trimmed.split_whitespace().next() {
            let lower = first.to_ascii_lowercase();
            if lower.ends_with("git-ai") || lower.ends_with("git-ai.exe") {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn before_tool_command_hook_is_configured() {
        let v = json!({
            "hooks": {
                "BeforeTool": [{ "matcher": "*", "hooks": [
                    { "type": "command", "command": "/home/u/.git-ai/bin/git-ai checkpoint gemini --hook-input stdin" }
                ]}]
            }
        });
        let s = parse_value(v, PathBuf::from("x"));
        assert!(s.configured);
        assert_eq!(s.hook_type, Some(HookType::Command));
    }

    #[test]
    fn after_tool_only_still_configured() {
        let v = json!({
            "hooks": {
                "AfterTool": [{ "matcher": "*", "hooks": [
                    { "type": "command", "command": "/x/git-ai checkpoint gemini --hook-input stdin" }
                ]}]
            }
        });
        assert!(parse_value(v, PathBuf::from("x")).configured);
    }

    #[test]
    fn empty_hooks_reports_unconfigured() {
        let v = json!({ "hooks": {} });
        let s = parse_value(v, PathBuf::from("x"));
        assert!(!s.configured);
        assert!(!s.issues.is_empty());
    }

    #[test]
    fn shell_short_circuit_is_rejected() {
        assert!(!is_git_ai_gemini_hook(
            "echo skip; git-ai checkpoint gemini"
        ));
        assert!(!is_git_ai_gemini_hook("true && git-ai checkpoint gemini"));
        assert!(is_git_ai_gemini_hook(
            "/home/u/.git-ai/bin/git-ai checkpoint gemini --hook-input stdin"
        ));
        // 不能把 claude 的命令误判成 gemini 已配置
        assert!(!is_git_ai_gemini_hook(
            "/x/git-ai checkpoint claude --hook-input stdin"
        ));
    }
}
