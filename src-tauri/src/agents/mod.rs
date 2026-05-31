//! 4 个 AI 编码 Agent 的 hook 配置探测,全部完整实现:
//!
//! | Agent    | 配置路径                                                 | 检测方式             |
//! | -------- | -------------------------------------------------------- | -------------------- |
//! | Claude   | `~/.claude/settings.json`                                | JSON hooks 段        |
//! | Cursor   | `~/.cursor/hooks.json`                                   | JSON hooks 数组      |
//! | Codex    | `~/.codex/config.toml`(legacy: `~/.codex/hooks.json`)    | TOML `[[hooks.*]]`,fallback JSON |
//! | OpenCode | `~/.config/opencode/plugins/git-ai.ts`                   | TS plugin 占位符替换 |
//! | Gemini   | `~/.gemini/settings.json`                                | JSON hooks 段(BeforeTool/AfterTool) |
//! | Pi       | `~/.pi/agent/extensions/git-ai.ts`                       | TS extension 占位符替换 |

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod gemini;
pub mod opencode;
pub mod pi;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentKind {
    Claude,
    Cursor,
    Codex,
    OpenCode,
    Gemini,
    Pi,
}

impl AgentKind {
    pub fn display_name(self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude Code",
            AgentKind::Cursor => "Cursor",
            AgentKind::Codex => "Codex",
            AgentKind::OpenCode => "OpenCode",
            AgentKind::Gemini => "Gemini",
            AgentKind::Pi => "Pi",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookType {
    Command,
    Http,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHookStatus {
    pub agent: AgentKind,
    /// 配置文件存在
    pub detected: bool,
    /// hook 字符串包含 `git-ai checkpoint <agent>`
    pub configured: bool,
    pub config_path: Option<String>,
    pub hook_type: Option<HookType>,
    /// 抠出的关键 hook 行,UI 用作 tooltip
    pub raw_excerpt: Option<String>,
    /// 可读的异常清单
    pub issues: Vec<String>,
}

#[async_trait]
pub trait AgentProbe: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn config_path(&self) -> PathBuf;
    async fn probe(&self) -> AgentHookStatus;
}

pub fn all_probes() -> Vec<Arc<dyn AgentProbe>> {
    vec![
        Arc::new(claude::ClaudeProbe),
        Arc::new(cursor::CursorProbe),
        Arc::new(codex::CodexProbe),
        Arc::new(opencode::OpenCodeProbe),
        Arc::new(gemini::GeminiProbe),
        Arc::new(pi::PiProbe),
    ]
}

/// 公用:TS plugin/extension 风格的探测(目前仅 OpenCode 使用)。
///
/// # 检测条件
/// - plugin/extension 文件存在
/// - 内容含 `GIT_AI_BIN` 常量声明
/// - 该常量值已被替换为真实路径(不再是 `__GIT_AI_BINARY_PATH__` 占位符)
///
/// # 上游真源
/// - OpenCode plugin: `git-ai/src/mdm/agents/opencode.rs:25-29`
///   (`OPENCODE_PLUGIN_CONTENT.replace("__GIT_AI_BINARY_PATH__", &path_str)`)
pub(crate) fn probe_ts_plugin(
    kind: AgentKind,
    plugin_path: PathBuf,
    not_found_msg: &str,
) -> AgentHookStatus {
    let raw = match std::fs::read_to_string(&plugin_path) {
        Ok(s) => s,
        Err(_) => {
            return AgentHookStatus {
                agent: kind,
                detected: false,
                configured: false,
                config_path: Some(plugin_path.display().to_string()),
                hook_type: None,
                raw_excerpt: None,
                issues: vec![not_found_msg.to_string()],
            };
        }
    };
    let has_const = raw.contains("GIT_AI_BIN");
    let still_placeholder = raw.contains("__GIT_AI_BINARY_PATH__");
    let configured = has_const && !still_placeholder;
    let mut issues = Vec::new();
    if !has_const {
        issues.push("plugin/extension 文件缺少 GIT_AI_BIN 常量,可能不是 git-ai 安装版本".into());
    }
    if still_placeholder {
        issues.push(
            "GIT_AI_BIN 仍是 __GIT_AI_BINARY_PATH__ 占位符,git-ai install-hooks 未替换路径".into(),
        );
    }
    // 抠出 GIT_AI_BIN 的赋值行作为 excerpt(便于用户人眼校验)
    let excerpt = raw
        .lines()
        .find(|l| l.contains("GIT_AI_BIN") && l.contains('='))
        .map(|l| l.trim().to_string());
    AgentHookStatus {
        agent: kind,
        detected: true,
        configured,
        config_path: Some(plugin_path.display().to_string()),
        hook_type: if configured {
            Some(HookType::Command)
        } else {
            None
        },
        raw_excerpt: excerpt,
        issues,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 注册回归:all_probes 必须覆盖全部 6 个 AgentKind,且每个都给出非空 config_path。
    /// 防止以后新增 AgentKind 却忘记在 all_probes 里注册(Diagnostic 页会少一个 agent)。
    #[test]
    fn all_probes_covers_all_six_agent_kinds() {
        let probes = all_probes();
        assert_eq!(probes.len(), 6, "应注册 6 个 agent 探测");
        for kind in [
            AgentKind::Claude,
            AgentKind::Cursor,
            AgentKind::Codex,
            AgentKind::OpenCode,
            AgentKind::Gemini,
            AgentKind::Pi,
        ] {
            let p = probes
                .iter()
                .find(|p| p.kind() == kind)
                .unwrap_or_else(|| panic!("缺少 {kind:?} 探测注册"));
            assert!(
                !p.config_path().as_os_str().is_empty(),
                "{kind:?} config_path 不应为空"
            );
        }
    }
}
