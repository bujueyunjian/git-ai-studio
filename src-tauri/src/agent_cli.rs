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

use std::path::{Path, PathBuf};
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

/// 解析 `npm` 可执行文件,走 `env_path` 的真实 PATH 镜像(绕开 GUI 被截断的进程 PATH,
/// 且运行期"重新检测"刷新镜像后立即生效),镜像查不到再扫固定安装目录兜底。
///
/// Windows 上 npm 实为 `npm.cmd` shim,`which_in` 会解析到它;直接 `spawn("npm")` 找不到。
/// Rust `Command` 自 BatBadBut 修复后支持以路径直接拉起 `.cmd`(内部经 cmd.exe + 转义),
/// 故拿到此路径交给 `proc::run_streaming` 即可。
pub fn resolve_npm() -> Result<PathBuf, String> {
    crate::env_path::which_in_real_path("npm")
        .or_else(|| which_in_known_dirs("npm"))
        .ok_or_else(|| "未找到 npm,请先安装 Node.js(https://nodejs.org)后重试".to_string())
}

/// claude/codex/npm 的常见安装目录(二级解析)。PATH 镜像有两类已知盲区:启动时继承 PATH
/// 能命中 npm 则跳过登录 shell 探测(env_path::ensure_patched 的性能早退),以及登录 shell
/// 探测本身失败(fish 默认 shell、rc 超时/非零退出)——此时二进制实际躺在这些约定位置却查
/// 不到。对齐 cc-switch 的固定路径策略(cc-switch misc.rs::build_tool_search_paths),
/// 只列与 claude/codex/npm 相关的安装器落点;只返回真实存在的目录。
fn known_install_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    #[cfg(not(windows))]
    {
        if let Some(home) = dirs::home_dir() {
            // Claude Code 官方原生安装脚本落点
            dirs.push(home.join(".local/bin"));
            // npm 自定义全局 prefix 的常见约定
            dirs.push(home.join(".npm-global/bin"));
            dirs.push(home.join(".volta/bin"));
            dirs.push(home.join(".bun/bin"));
            dirs.extend(nvm_version_bins(&home));
        }
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    #[cfg(windows)]
    {
        // npm 默认全局 prefix
        if let Ok(appdata) = std::env::var("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Volta").join("bin"));
        }
        // nvm-windows 的 active node 软链目录
        if let Ok(symlink) = std::env::var("NVM_SYMLINK") {
            dirs.push(PathBuf::from(symlink));
        }
        dirs.push(PathBuf::from(r"C:\Program Files\nodejs"));
    }
    dirs.retain(|d| d.is_dir());
    dirs
}

/// 枚举 nvm 已装 node 版本的 bin 目录,路径倒序让新版本排前(node 主版本现为两位数,
/// 字典序即可;不存在 nvm 时返回空)。
#[cfg(not(windows))]
fn nvm_version_bins(home: &Path) -> Vec<PathBuf> {
    let base = home.join(".nvm/versions/node");
    let Ok(entries) = std::fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut bins: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("bin")).collect();
    bins.sort();
    bins.reverse();
    bins
}

/// 在固定安装目录里解析可执行文件。复用 `which::which_in`:Windows 下自动按 PATHEXT
/// 尝试 `.cmd`/`.exe`,unix 下校验可执行位,与 PATH 镜像解析行为完全一致。
fn which_in_known_dirs(bin: &str) -> Option<PathBuf> {
    which_in_dirs(bin, known_install_dirs())
}

/// `which_in_known_dirs` 的可测核心:在给定目录列表中解析可执行文件。
fn which_in_dirs(bin: &str, dirs: Vec<PathBuf>) -> Option<PathBuf> {
    if dirs.is_empty() {
        return None;
    }
    let joined = std::env::join_paths(dirs).ok()?;
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    which::which_in(bin, Some(joined), cwd).ok()
}

/// 若 `bin` 所在目录不在真实 PATH 镜像里(固定目录二级解析命中),把它拼到镜像最前——
/// npm 与 npm 装的 claude/codex 都是 `#!/usr/bin/env node` 脚本,node 通常与之同目录
/// (nvm/volta/自定义 prefix 均如此),不拼则因找不到 node 而失败。
/// 目录已在镜像里(一级解析命中)则保持镜像原序:前置会把低优先目录提到最前,可能让
/// shebang 解析到旧 node(如 /usr/local/bin 残留 node16 遮蔽镜像里靠前的 nvm node22)。
pub(crate) fn path_with_bin_dir(bin: &Path) -> String {
    let real = crate::env_path::real_path();
    let Some(dir) = bin.parent() else {
        return real;
    };
    if std::env::split_paths(&real).any(|p| p == dir) {
        return real;
    }
    let merged = std::env::join_paths(
        std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&real)),
    );
    match merged {
        Ok(s) => s.to_string_lossy().into_owned(),
        Err(_) => real,
    }
}

/// 探测某个 CLI 是否已安装及其版本。未装返回 `installed=false`(预期空态,非错误)。
/// 解析两级:先查真实 PATH 镜像,查不到再扫固定安装目录(对齐 cc-switch 的探测策略)。
pub async fn detect(agent: AgentCli) -> InstalledVersion {
    let bin = match crate::env_path::which_in_real_path(agent.bin_name())
        .or_else(|| which_in_known_dirs(agent.bin_name()))
    {
        Some(p) => p,
        None => {
            return InstalledVersion {
                installed: false,
                version: None,
                binary_path: None,
            };
        }
    };
    // 注入真实 PATH + 命中目录:`claude`/`codex` 是 `#!/usr/bin/env node` 脚本,shebang
    // 需 node 在 PATH;二级解析命中的目录可能不在镜像里,node 往往与二进制同目录。
    let version = match crate::proc::run_capture_with_env_timeout(
        &bin,
        &["--version"],
        None,
        &[("PATH".into(), path_with_bin_dir(&bin))],
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

    #[cfg(not(windows))]
    #[test]
    fn which_in_dirs_finds_executable_and_skips_non_executable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("claude");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();

        let found = which_in_dirs("claude", vec![dir.path().to_path_buf()]);
        assert_eq!(found.as_deref(), Some(exe.as_path()));

        // 无可执行位的同名文件不应命中(which 校验 +x)
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            which_in_dirs("claude", vec![dir.path().to_path_buf()]),
            None
        );
        // 空目录列表直接 None
        assert_eq!(which_in_dirs("claude", Vec::new()), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn nvm_version_bins_orders_newer_first_and_empty_without_nvm() {
        let home = tempfile::tempdir().unwrap();
        assert!(nvm_version_bins(home.path()).is_empty());

        let base = home.path().join(".nvm/versions/node");
        std::fs::create_dir_all(base.join("v18.20.0/bin")).unwrap();
        std::fs::create_dir_all(base.join("v22.11.0/bin")).unwrap();
        let bins = nvm_version_bins(home.path());
        assert_eq!(
            bins,
            vec![base.join("v22.11.0/bin"), base.join("v18.20.0/bin")]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn path_with_bin_dir_prepends_parent_dir() {
        let merged = path_with_bin_dir(Path::new("/custom/tools/bin/claude"));
        let first = std::env::split_paths(&merged).next();
        assert_eq!(first, Some(PathBuf::from("/custom/tools/bin")));
    }

    #[cfg(not(windows))]
    #[test]
    fn path_with_bin_dir_keeps_mirror_order_when_dir_already_present() {
        // 一级解析命中(目录已在镜像里)须保持镜像原序,防止前置遮蔽靠前的 node
        let real = crate::env_path::real_path();
        let Some(existing) = std::env::split_paths(&real).last() else {
            return; // 测试环境 PATH 为空则无从断言
        };
        assert_eq!(path_with_bin_dir(&existing.join("claude")), real);
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
