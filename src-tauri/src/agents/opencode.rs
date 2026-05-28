//! OpenCode:`~/.config/opencode/plugins/git-ai.ts`
//!
//! # 权威 schema 来源
//! 上游 `git-ai/src/mdm/agents/opencode.rs:16-29`:
//! - plugin 路径(全局):`~/.config/opencode/plugins/git-ai.ts`
//! - 内容是 TypeScript 插件,引用 `@opencode-ai/plugin`
//! - 安装时把 `__GIT_AI_BINARY_PATH__` 占位符替换为真实 git-ai 路径
//!
//! # 检测条件(由 [`probe_ts_plugin`] 实现)
//! - 文件存在
//! - 含 `GIT_AI_BIN` 常量
//! - 占位符已替换(`__GIT_AI_BINARY_PATH__` 不再出现)

use async_trait::async_trait;
use std::path::PathBuf;

use crate::paths::home_dir;

use super::{probe_ts_plugin, AgentHookStatus, AgentKind, AgentProbe};

pub struct OpenCodeProbe;

#[async_trait]
impl AgentProbe for OpenCodeProbe {
    fn kind(&self) -> AgentKind {
        AgentKind::OpenCode
    }
    fn config_path(&self) -> PathBuf {
        home_dir()
            .join(".config")
            .join("opencode")
            .join("plugins")
            .join("git-ai.ts")
    }
    async fn probe(&self) -> AgentHookStatus {
        probe_ts_plugin(
            AgentKind::OpenCode,
            self.config_path(),
            "未检测到 ~/.config/opencode/plugins/git-ai.ts (OpenCode 未配置 git-ai 插件)",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 用 tempdir 隔离每个测试 — 直接传 path 给 helper,不走 env(并行测试无 race)
    fn tmp_plugin_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "git-ai-studio-opencode-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("git-ai.ts")
    }

    #[test]
    fn missing_file_reports_undetected() {
        let p = tmp_plugin_path();
        // 不写文件:probe_ts_plugin 应返 detected=false
        let s = probe_ts_plugin(AgentKind::OpenCode, p, "missing");
        assert!(!s.detected);
        assert!(!s.configured);
    }

    #[test]
    fn placeholder_present_means_not_configured() {
        let p = tmp_plugin_path();
        fs::write(&p, r#"const GIT_AI_BIN = "__GIT_AI_BINARY_PATH__";"#).unwrap();
        let s = probe_ts_plugin(AgentKind::OpenCode, p, "missing");
        assert!(s.detected);
        assert!(!s.configured, "占位符未替换不能算 configured");
        assert!(s.issues.iter().any(|i| i.contains("占位符")));
    }

    #[test]
    fn real_path_substituted_means_configured() {
        let p = tmp_plugin_path();
        fs::write(&p, r#"const GIT_AI_BIN = "/home/u/.git-ai/bin/git-ai";"#).unwrap();
        let s = probe_ts_plugin(AgentKind::OpenCode, p, "missing");
        assert!(s.detected);
        assert!(s.configured);
        assert!(s.raw_excerpt.is_some());
    }
}
