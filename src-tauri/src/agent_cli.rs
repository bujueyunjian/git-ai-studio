//! Claude Code / Codex 这两个外部 AI 编码 CLI 的 npm 安装·卸载·版本探测。
//!
//! 与 `git_ai::binary`(git-ai 自身,走官方 install 脚本 + 固定 ~/.git-ai/bin 路径)和
//! `agents`(探测 agent 的 hook 配置,不碰二进制)都正交:本模块只负责"用 npm 装/卸这两个
//! CLI 本体 + 读它们的版本"。
//!
//! # 为什么只有这两个
//! 6 个被探测 hook 的 agent 里,只有 Claude Code(`@anthropic-ai/claude-code`)和
//! Codex(`@openai/codex`)有官方 npm 发布的独立 CLI;Cursor/Gemini 是 IDE/内置,
//! OpenCode/Pi 是 TS 插件,没有"npm 装 CLI"这回事。所以安装目标集合 != agent 集合,
//! 刻意用独立枚举而非复用 `AgentKind`。
//!
//! # 失败语义(对齐 CLAUDE.md"响亮失败")
//! - npm 不在 PATH → [`resolve_npm`] 返回 Err,命令层弹红 toast,绝不静默兜底。
//! - 全局安装权限不足(EACCES / Program Files 前缀)→ 让 npm 自身的非 0 退出码 +
//!   stderr 原样流式回传,不替用户 sudo、不猜路径。

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::commands::install::extract_version;
use crate::commands::install::InstalledVersion;

/// 可被本应用代装的外部 AI 编码 CLI。前端以 `"ClaudeCode"` / `"Codex"` 字符串传入。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentCli {
    ClaudeCode,
    Codex,
}

impl AgentCli {
    /// npm 包名(`npm install -g <package>` 的对象)。
    pub fn package_name(self) -> &'static str {
        match self {
            AgentCli::ClaudeCode => "@anthropic-ai/claude-code",
            AgentCli::Codex => "@openai/codex",
        }
    }

    /// 安装后落到 PATH 上的可执行名(用于 `<bin> --version` 探测)。
    pub fn bin_name(self) -> &'static str {
        match self {
            AgentCli::ClaudeCode => "claude",
            AgentCli::Codex => "codex",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            AgentCli::ClaudeCode => "Claude Code",
            AgentCli::Codex => "Codex",
        }
    }
}

/// 解析 `npm` 可执行文件。
///
/// Windows 上 npm 实为 `npm.cmd` shim,`which::which("npm")` 会解析到它;直接
/// `spawn("npm")` 找不到。Rust `Command` 自 BatBadBut 修复后支持以路径直接拉起
/// `.cmd`(内部经 cmd.exe + 转义),故拿到此路径交给 `proc::run_streaming` 即可。
pub fn resolve_npm() -> Result<PathBuf, String> {
    which::which("npm")
        .map_err(|_| "未找到 npm,请先安装 Node.js(https://nodejs.org)后重试".to_string())
}

/// 探测某个 CLI 是否已安装及其版本。未装返回 `installed=false`(预期空态,非错误)。
pub async fn detect(agent: AgentCli) -> InstalledVersion {
    let bin = match which::which(agent.bin_name()) {
        Ok(p) => p,
        Err(_) => {
            return InstalledVersion {
                installed: false,
                version: None,
                binary_path: None,
            };
        }
    };
    let version = match crate::proc::run_capture_with_timeout(
        &bin,
        &["--version"],
        None,
        Duration::from_secs(5),
    )
    .await
    {
        Ok(c) if c.status == 0 => extract_version(&c.stdout).or_else(|| extract_version(&c.stderr)),
        _ => None,
    };
    InstalledVersion {
        installed: true,
        version,
        binary_path: Some(bin.display().to_string()),
    }
}

/// 构造 `npm install -g <pkg>[@<version>]` 的参数。
///
/// `version` 为 None / 空 / `"latest"` 时不拼版本后缀(npm 默认即装 latest);否则
/// `<pkg>@<version>`。版本字符串原样透传给 npm,由 npm 校验合法性(非法版本 → npm
/// 非 0 退出,响亮失败)。
pub fn build_install_args(agent: AgentCli, version: Option<&str>) -> Vec<String> {
    let pkg = agent.package_name();
    let spec = match version.map(str::trim) {
        Some(v) if !v.is_empty() && v != "latest" => format!("{pkg}@{v}"),
        _ => pkg.to_string(),
    };
    vec!["install".into(), "-g".into(), spec]
}

/// 构造 `npm uninstall -g <pkg>`。只卸 npm 全局包,不动 `~/.claude` / `~/.codex` 等
/// 用户配置目录(对比 git-ai 卸载会删 ~/.git-ai —— 那是 git-ai 专属,这里绝不照搬)。
pub fn build_uninstall_args(agent: AgentCli) -> Vec<String> {
    vec![
        "uninstall".into(),
        "-g".into(),
        agent.package_name().to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_and_bin_names_match_user_commands() {
        assert_eq!(
            AgentCli::ClaudeCode.package_name(),
            "@anthropic-ai/claude-code"
        );
        assert_eq!(AgentCli::Codex.package_name(), "@openai/codex");
        assert_eq!(AgentCli::ClaudeCode.bin_name(), "claude");
        assert_eq!(AgentCli::Codex.bin_name(), "codex");
    }

    #[test]
    fn install_args_latest_has_no_version_suffix() {
        for v in [None, Some(""), Some("  "), Some("latest")] {
            let args = build_install_args(AgentCli::ClaudeCode, v);
            assert_eq!(
                args,
                vec!["install", "-g", "@anthropic-ai/claude-code"],
                "version={v:?} 应等同 latest,不拼后缀"
            );
        }
    }

    #[test]
    fn install_args_pinned_version_appends_at_suffix() {
        let args = build_install_args(AgentCli::Codex, Some("0.137.0"));
        assert_eq!(args, vec!["install", "-g", "@openai/codex@0.137.0"]);
    }

    #[test]
    fn install_args_trims_whitespace_around_version() {
        let args = build_install_args(AgentCli::ClaudeCode, Some("  2.1.165 "));
        assert_eq!(
            args,
            vec!["install", "-g", "@anthropic-ai/claude-code@2.1.165"]
        );
    }

    #[test]
    fn uninstall_args_never_touch_config_dirs() {
        let args = build_uninstall_args(AgentCli::ClaudeCode);
        assert_eq!(args, vec!["uninstall", "-g", "@anthropic-ai/claude-code"]);
        // 防退化:卸载参数里不得出现任何用户配置目录路径
        assert!(args
            .iter()
            .all(|a| !a.contains(".claude") && !a.contains(".codex")));
    }

    #[test]
    fn agent_cli_serde_roundtrip_matches_frontend_strings() {
        assert_eq!(
            serde_json::to_string(&AgentCli::ClaudeCode).unwrap(),
            "\"ClaudeCode\""
        );
        assert_eq!(
            serde_json::to_string(&AgentCli::Codex).unwrap(),
            "\"Codex\""
        );
        let parsed: AgentCli = serde_json::from_str("\"Codex\"").unwrap();
        assert_eq!(parsed, AgentCli::Codex);
    }
}
