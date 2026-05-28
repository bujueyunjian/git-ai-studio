//! Codex (OpenAI):`~/.codex/config.toml` 内嵌 `[[hooks.*]]` 段(git-ai 1.4.9+ 主路径)。
//! Legacy:`~/.codex/hooks.json`(git-ai 1.4.8-,1.4.9 仍可识别但 install-hooks 会清理)。
//!
//! # 权威 schema 来源
//! 上游 `git-ai/src/mdm/agents/codex.rs:14, 164-208, 233-318`:
//! - `[features].hooks = true`(legacy: `[features].codex_hooks = true`)
//! - `[[hooks.<Event>]]` 三段:`PreToolUse / PostToolUse / Stop`
//!   - matcher 缺省或 `"*"`(catch-all)
//!   - 内含 `hooks = [{ type = "command", command = "<bin> checkpoint codex --hook-input stdin" }]`
//! - `[hooks.state."<config_path>:<event_snake>:<group>:<handler>"]` 用 SHA-256 trust 绕开 TUI 审批
//!
//! 命令字面 = `<git-ai bin> checkpoint codex --hook-input stdin`,反伪造校验对齐 Claude probe:
//! 命令首 token 必须是 git-ai 可执行,且字符串不含 shell 短路 / 注释符。

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::path::PathBuf;
use toml::Value as TomlValue;

use crate::paths::home_dir;

use super::{AgentHookStatus, AgentKind, AgentProbe, HookType};

const CODEX_HOOK_EVENTS: [&str; 3] = ["PreToolUse", "PostToolUse", "Stop"];

pub struct CodexProbe;

#[async_trait]
impl AgentProbe for CodexProbe {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }
    fn config_path(&self) -> PathBuf {
        home_dir().join(".codex").join("config.toml")
    }
    async fn probe(&self) -> AgentHookStatus {
        let toml_path = home_dir().join(".codex").join("config.toml");
        let json_path = home_dir().join(".codex").join("hooks.json");

        // 主路径:config.toml
        if toml_path.exists() {
            return match std::fs::read_to_string(&toml_path) {
                Ok(raw) => match toml::from_str::<TomlValue>(&raw) {
                    Ok(v) => probe_toml(v, toml_path, &json_path),
                    Err(e) => toml_parse_error(
                        toml_path,
                        &json_path,
                        format!("config.toml 解析失败: {e}"),
                    ),
                },
                Err(e) => {
                    toml_parse_error(toml_path, &json_path, format!("读 config.toml 失败: {e}"))
                }
            };
        }

        // 主路径不存在 -> 仅有 legacy hooks.json 时回退
        if json_path.exists() {
            return probe_legacy_json(json_path);
        }

        missing(toml_path)
    }
}

fn missing(toml_path: PathBuf) -> AgentHookStatus {
    AgentHookStatus {
        agent: AgentKind::Codex,
        detected: false,
        configured: false,
        config_path: Some(toml_path.display().to_string()),
        hook_type: None,
        raw_excerpt: None,
        issues: vec![
            "未检测到 ~/.codex/config.toml 或 ~/.codex/hooks.json(Codex 未配置 hooks)".into(),
        ],
    }
}

/// config.toml 解析层错误:文件存在但读/解析失败。仍尝试 legacy hooks.json 兜底诊断信息。
fn toml_parse_error(
    toml_path: PathBuf,
    json_path: &std::path::Path,
    msg: String,
) -> AgentHookStatus {
    if json_path.exists() {
        let mut s = probe_legacy_json(json_path.to_path_buf());
        s.issues.insert(0, msg);
        return s;
    }
    AgentHookStatus {
        agent: AgentKind::Codex,
        detected: true,
        configured: false,
        config_path: Some(toml_path.display().to_string()),
        hook_type: None,
        raw_excerpt: None,
        issues: vec![msg],
    }
}

/// 解析 config.toml,按 git-ai 1.4.9 `config_has_inline_hooks` + `config_hooks_feature_enabled` 等价规则判断。
fn probe_toml(
    toml_v: TomlValue,
    toml_path: PathBuf,
    legacy_json_path: &std::path::Path,
) -> AgentHookStatus {
    let mut issues = Vec::new();
    let mut excerpt: Option<String> = None;

    let feature_enabled = is_hooks_feature_enabled(&toml_v);
    let mut configured_events: u8 = 0;

    for which in CODEX_HOOK_EVENTS {
        if event_has_git_ai_hook(&toml_v, which, &mut excerpt) {
            configured_events += 1;
        } else {
            issues.push(format!(
                "[[hooks.{which}]] 中未找到 catch-all matcher + git-ai checkpoint codex 命令"
            ));
        }
    }

    if !feature_enabled {
        issues.push(
            "[features].hooks = true 未启用(或 legacy [features].codex_hooks = true 缺失)".into(),
        );
    }

    if legacy_json_path.exists() {
        issues.push(
            "检测到残留的 ~/.codex/hooks.json(legacy 格式),重跑 git-ai install-hooks 会清理".into(),
        );
    }

    let configured = configured_events == 3 && feature_enabled;

    AgentHookStatus {
        agent: AgentKind::Codex,
        detected: true,
        configured,
        config_path: Some(toml_path.display().to_string()),
        hook_type: if configured {
            Some(HookType::Command)
        } else {
            None
        },
        raw_excerpt: excerpt,
        issues,
    }
}

fn event_has_git_ai_hook(toml_v: &TomlValue, event: &str, excerpt: &mut Option<String>) -> bool {
    let Some(blocks) = toml_v
        .get("hooks")
        .and_then(|h| h.get(event))
        .and_then(|v| v.as_array())
    else {
        return false;
    };
    for block in blocks {
        // matcher 缺省 / "*" 都算 catch-all (上游 codex.rs:185-190)
        let matcher_ok = block.get("matcher").is_none()
            || block.get("matcher").and_then(|v| v.as_str()) == Some("*");
        if !matcher_ok {
            continue;
        }
        let Some(hooks_arr) = block.get("hooks").and_then(|v| v.as_array()) else {
            continue;
        };
        for h in hooks_arr {
            let cmd = h.get("command").and_then(|v| v.as_str()).unwrap_or("");
            if is_git_ai_codex_hook(cmd) {
                if excerpt.is_none() {
                    *excerpt = Some(format!("[[hooks.{event}]] command: {cmd}"));
                }
                return true;
            }
        }
    }
    false
}

fn is_hooks_feature_enabled(toml_v: &TomlValue) -> bool {
    let features = toml_v.get("features");
    let new_flag = features
        .and_then(|v| v.get("hooks"))
        .and_then(|v| v.as_bool())
        == Some(true);
    let legacy_flag = features
        .and_then(|v| v.get("codex_hooks"))
        .and_then(|v| v.as_bool())
        == Some(true);
    new_flag || legacy_flag
}

/// Legacy:~/.codex/hooks.json(git-ai 1.4.8-)。
/// 检测到则标 configured=true,但 issues 明确提示用户迁移到 config.toml。
fn probe_legacy_json(json_path: PathBuf) -> AgentHookStatus {
    let raw = match std::fs::read_to_string(&json_path) {
        Ok(s) => s,
        Err(e) => {
            return AgentHookStatus {
                agent: AgentKind::Codex,
                detected: true,
                configured: false,
                config_path: Some(json_path.display().to_string()),
                hook_type: None,
                raw_excerpt: None,
                issues: vec![format!("读 legacy hooks.json 失败: {e}")],
            };
        }
    };
    let json: JsonValue = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            return AgentHookStatus {
                agent: AgentKind::Codex,
                detected: true,
                configured: false,
                config_path: Some(json_path.display().to_string()),
                hook_type: None,
                raw_excerpt: None,
                issues: vec![format!("legacy hooks.json 解析失败: {e}")],
            };
        }
    };

    let mut issues = vec![
        "使用 legacy ~/.codex/hooks.json 格式,git-ai 1.4.9+ 已迁到 ~/.codex/config.toml,建议重跑 install-hooks".into(),
    ];
    let mut excerpt: Option<String> = None;
    let hooks = json.get("hooks");
    let mut configured_events: u8 = 0;

    for which in CODEX_HOOK_EVENTS {
        let arr = hooks.and_then(|h| h.get(which)).and_then(|v| v.as_array());
        let Some(arr) = arr else {
            issues.push(format!("legacy hooks.{which} 缺失"));
            continue;
        };
        let mut event_configured = false;
        for matcher_block in arr {
            let Some(inner) = matcher_block.get("hooks").and_then(|v| v.as_array()) else {
                continue;
            };
            for hook in inner {
                let command = hook.get("command").and_then(|v| v.as_str()).unwrap_or("");
                if is_git_ai_codex_hook(command) {
                    event_configured = true;
                    if excerpt.is_none() {
                        excerpt = Some(format!("legacy command: {command}"));
                    }
                    break;
                }
            }
            if event_configured {
                break;
            }
        }
        if event_configured {
            configured_events += 1;
        }
    }

    let configured = configured_events == 3;
    AgentHookStatus {
        agent: AgentKind::Codex,
        detected: true,
        configured,
        config_path: Some(json_path.display().to_string()),
        hook_type: if configured {
            Some(HookType::Command)
        } else {
            None
        },
        raw_excerpt: excerpt,
        issues,
    }
}

/// 反伪造:首 token 是 git-ai 可执行 + 含 `checkpoint codex` + 不含 shell 短路 / 注释符。
fn is_git_ai_codex_hook(s: &str) -> bool {
    let trimmed = s.trim();
    if trimmed.contains(';')
        || trimmed.contains("&&")
        || trimmed.contains("||")
        || trimmed.contains('#')
    {
        return false;
    }
    if !trimmed.contains("checkpoint codex") {
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

    fn fake_toml_path() -> PathBuf {
        PathBuf::from("config.toml")
    }
    fn fake_json_path() -> PathBuf {
        // tests 用不存在的路径,触发 legacy_json_path.exists() == false 分支
        PathBuf::from("/nonexistent/.codex/hooks.json")
    }

    #[test]
    fn official_codex_hook_in_config_toml_is_configured() {
        let raw = r#"
[features]
hooks = true

[[hooks.PreToolUse]]
hooks = [{ type = "command", command = "/home/u/.git-ai/bin/git-ai checkpoint codex --hook-input stdin" }]

[[hooks.PostToolUse]]
hooks = [{ type = "command", command = "/home/u/.git-ai/bin/git-ai checkpoint codex --hook-input stdin" }]

[[hooks.Stop]]
hooks = [{ type = "command", command = "/home/u/.git-ai/bin/git-ai checkpoint codex --hook-input stdin" }]
"#;
        let v: TomlValue = toml::from_str(raw).unwrap();
        let s = probe_toml(v, fake_toml_path(), &fake_json_path());
        assert!(s.configured);
        assert_eq!(s.hook_type, Some(HookType::Command));
    }

    #[test]
    fn legacy_codex_hooks_feature_flag_also_accepted() {
        let raw = r#"
[features]
codex_hooks = true

[[hooks.PreToolUse]]
hooks = [{ type = "command", command = "/h/g/git-ai checkpoint codex --hook-input stdin" }]

[[hooks.PostToolUse]]
hooks = [{ type = "command", command = "/h/g/git-ai checkpoint codex --hook-input stdin" }]

[[hooks.Stop]]
hooks = [{ type = "command", command = "/h/g/git-ai checkpoint codex --hook-input stdin" }]
"#;
        let v: TomlValue = toml::from_str(raw).unwrap();
        let s = probe_toml(v, fake_toml_path(), &fake_json_path());
        assert!(s.configured);
    }

    #[test]
    fn missing_features_hooks_flag_unconfigured() {
        let raw = r#"
[[hooks.PreToolUse]]
hooks = [{ type = "command", command = "/h/g/git-ai checkpoint codex --hook-input stdin" }]

[[hooks.PostToolUse]]
hooks = [{ type = "command", command = "/h/g/git-ai checkpoint codex --hook-input stdin" }]

[[hooks.Stop]]
hooks = [{ type = "command", command = "/h/g/git-ai checkpoint codex --hook-input stdin" }]
"#;
        let v: TomlValue = toml::from_str(raw).unwrap();
        let s = probe_toml(v, fake_toml_path(), &fake_json_path());
        assert!(!s.configured);
        assert!(s.issues.iter().any(|i| i.contains("[features].hooks")));
    }

    #[test]
    fn missing_one_event_unconfigured() {
        let raw = r#"
[features]
hooks = true

[[hooks.PreToolUse]]
hooks = [{ type = "command", command = "/h/g/git-ai checkpoint codex --hook-input stdin" }]

[[hooks.PostToolUse]]
hooks = [{ type = "command", command = "/h/g/git-ai checkpoint codex --hook-input stdin" }]
"#;
        let v: TomlValue = toml::from_str(raw).unwrap();
        let s = probe_toml(v, fake_toml_path(), &fake_json_path());
        assert!(!s.configured);
        assert!(s.issues.iter().any(|i| i.contains("Stop")));
    }

    #[test]
    fn empty_hooks_table_reports_unconfigured() {
        let raw = r#"
[features]
hooks = true
"#;
        let v: TomlValue = toml::from_str(raw).unwrap();
        let s = probe_toml(v, fake_toml_path(), &fake_json_path());
        assert!(!s.configured);
    }

    #[test]
    fn non_catchall_matcher_is_rejected() {
        // matcher = "Edit" 不是 catch-all,该事件不配
        let raw = r#"
[features]
hooks = true

[[hooks.PreToolUse]]
matcher = "Edit"
hooks = [{ type = "command", command = "/h/g/git-ai checkpoint codex --hook-input stdin" }]

[[hooks.PostToolUse]]
hooks = [{ type = "command", command = "/h/g/git-ai checkpoint codex --hook-input stdin" }]

[[hooks.Stop]]
hooks = [{ type = "command", command = "/h/g/git-ai checkpoint codex --hook-input stdin" }]
"#;
        let v: TomlValue = toml::from_str(raw).unwrap();
        let s = probe_toml(v, fake_toml_path(), &fake_json_path());
        assert!(!s.configured);
    }

    #[test]
    fn shell_short_circuit_is_rejected() {
        assert!(!is_git_ai_codex_hook(
            "echo skip; git-ai checkpoint codex --hook-input stdin"
        ));
        assert!(!is_git_ai_codex_hook(
            "true && git-ai checkpoint codex --hook-input stdin"
        ));
    }

    #[test]
    fn wrong_subcommand_rejected() {
        assert!(!is_git_ai_codex_hook(
            "/u/.git-ai/bin/git-ai checkpoint claude --hook-input stdin"
        ));
    }

    #[test]
    fn first_token_must_be_git_ai_binary() {
        assert!(is_git_ai_codex_hook(
            "/home/u/.git-ai/bin/git-ai checkpoint codex --hook-input stdin"
        ));
        let win = r"C:\Users\u\.git-ai\bin\git-ai.exe checkpoint codex --hook-input stdin";
        assert!(is_git_ai_codex_hook(win));
        assert!(!is_git_ai_codex_hook(
            "echo 'checkpoint codex' && touch /tmp/x"
        ));
    }
}
