//! Claude Code: `~/.claude/settings.json`
//!
//! 期望结构(见 `Git-ai 问题分析步骤.md` 第 2 步):
//! ```json
//! { "hooks": {
//!     "PreToolUse": [
//!       { "matcher": "*",
//!         "hooks": [{ "type": "command", "command": ".../git-ai checkpoint claude --hook-input stdin" }] } ],
//!     "PostToolUse": [ ... 同上 ... ] } }
//! ```

use async_trait::async_trait;
use serde_json::Value;
use std::path::PathBuf;

use crate::paths::claude_settings_json;

use super::{AgentHookStatus, AgentKind, AgentProbe, HookType};

pub struct ClaudeProbe;

#[async_trait]
impl AgentProbe for ClaudeProbe {
    fn kind(&self) -> AgentKind {
        AgentKind::Claude
    }
    fn config_path(&self) -> PathBuf {
        claude_settings_json()
    }
    async fn probe(&self) -> AgentHookStatus {
        let path = self.config_path();
        let detected = path.exists();
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => return missing(path),
        };
        let json: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                return AgentHookStatus {
                    agent: AgentKind::Claude,
                    detected,
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
        agent: AgentKind::Claude,
        detected: false,
        configured: false,
        config_path: Some(path.display().to_string()),
        hook_type: None,
        raw_excerpt: None,
        issues: vec!["未检测到 ~/.claude/settings.json (Claude Code 未配置)".into()],
    }
}

fn parse_value(json: Value, path: PathBuf) -> AgentHookStatus {
    let mut issues = Vec::new();
    let mut hook_type: Option<HookType> = None;
    let mut excerpt: Option<String> = None;
    let mut configured = false;

    let hooks = json.get("hooks");
    if hooks.is_none() {
        issues.push("settings.json 缺少 hooks 段".into());
    }

    for which in ["PreToolUse", "PostToolUse"] {
        let arr = hooks.and_then(|h| h.get(which)).and_then(|v| v.as_array());
        let Some(arr) = arr else {
            issues.push(format!("缺少 hooks.{which} 配置"));
            continue;
        };
        for matcher_block in arr {
            let inner = matcher_block.get("hooks").and_then(|v| v.as_array());
            let Some(inner) = inner else { continue };
            for hook in inner {
                let ty = hook.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let command = hook.get("command").and_then(|v| v.as_str()).unwrap_or("");
                let url = hook.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let target_str = if !command.is_empty() { command } else { url };
                let matches = is_git_ai_claude_hook(target_str);
                if matches {
                    configured = true;
                    hook_type = Some(match ty {
                        "command" => HookType::Command,
                        "http" => HookType::Http,
                        _ => HookType::Unknown,
                    });
                    if excerpt.is_none() {
                        excerpt = Some(format!("{ty}: {target_str}"));
                    }
                }
            }
        }
    }

    if !configured {
        issues.push("hooks 段中未找到 'git-ai checkpoint claude' 配置".into());
    }

    AgentHookStatus {
        agent: AgentKind::Claude,
        detected: true,
        configured,
        config_path: Some(path.display().to_string()),
        hook_type,
        raw_excerpt: excerpt,
        issues,
    }
}

/// 判断 hook 字符串是否真的会执行 git-ai checkpoint claude。
/// 严格化:
/// - 不能含 shell 短路/链式符号(`;` / `&&` / `||`),避免 "echo skip; git-ai checkpoint claude" 这种伪配置;
/// - 不能含 `#` 注释符;
/// - 必须严格匹配 "git-ai checkpoint claude" 且首 token 是 git-ai 可执行。
fn is_git_ai_claude_hook(s: &str) -> bool {
    let trimmed = s.trim();
    // shell 短路 / 注释 / 多命令 → 不可信
    if trimmed.contains(';')
        || trimmed.contains("&&")
        || trimmed.contains("||")
        || trimmed.contains('#')
    {
        return false;
    }
    // 官方 command 模式:必须有 "checkpoint claude" 子串(允许 Win 上是 ...\git-ai.exe checkpoint claude)
    if trimmed.contains("checkpoint claude") {
        // 必须以 git-ai 可执行作为第一个 token
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
    fn official_command_hook_is_configured() {
        let v = json!({
            "hooks": {
                "PreToolUse": [{ "matcher": "*", "hooks": [
                    { "type": "command", "command": "/home/u/.git-ai/bin/git-ai checkpoint claude --hook-input stdin" }
                ]}],
                "PostToolUse": [{ "matcher": "*", "hooks": [
                    { "type": "command", "command": "/home/u/.git-ai/bin/git-ai checkpoint claude --hook-input stdin" }
                ]}]
            }
        });
        let s = parse_value(v, PathBuf::from("x"));
        assert!(s.configured);
        assert_eq!(s.hook_type, Some(HookType::Command));
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
        assert!(!is_git_ai_claude_hook(
            "echo skip; git-ai checkpoint claude"
        ));
        assert!(!is_git_ai_claude_hook("true && git-ai checkpoint claude"));
        assert!(!is_git_ai_claude_hook("false || git-ai checkpoint claude"));
        assert!(!is_git_ai_claude_hook("# git-ai checkpoint claude"));
    }

    #[test]
    fn first_token_must_be_git_ai_binary() {
        assert!(is_git_ai_claude_hook(
            "/home/u/.git-ai/bin/git-ai checkpoint claude --hook-input stdin"
        ));
        // 用 raw string 避免反斜杠转义陷阱
        let win = r"C:\Users\u\.git-ai\bin\git-ai.exe checkpoint claude --hook-input stdin";
        let first = win.split_whitespace().next().unwrap();
        let lower = first.to_ascii_lowercase();
        assert!(
            lower.ends_with("git-ai.exe"),
            "first={first:?} lower={lower:?}"
        );
        assert!(is_git_ai_claude_hook(win), "win path should be accepted");
        assert!(!is_git_ai_claude_hook(
            "echo 'git-ai checkpoint claude' > /tmp/x"
        ));
    }
}
