//! Pi: `~/.pi/agent/extensions/git-ai.ts`
//!
//! # 权威 schema 来源
//! 上游 `git-ai/src/mdm/agents/pi.rs:15-25,149-160`:
//! - extension 路径(全局):`~/.pi/agent/extensions/git-ai.ts`
//! - 内容是 TypeScript 扩展,含 `const GIT_AI_BIN = '...'`,hook 命令
//!   `['checkpoint', 'pi', '--hook-input', 'stdin']`
//! - 安装时把 `__GIT_AI_BINARY_PATH__` 占位符替换为真实 git-ai 路径(与 OpenCode 同款机制)
//!
//! # 检测条件(由 [`super::probe_ts_plugin`] 实现,与 OpenCode 完全同款)
//! - 文件存在 + 含 `GIT_AI_BIN` 常量 + 占位符已替换

use async_trait::async_trait;
use std::path::PathBuf;

use crate::paths::home_dir;

use super::{probe_ts_plugin, AgentHookStatus, AgentKind, AgentProbe};

pub struct PiProbe;

#[async_trait]
impl AgentProbe for PiProbe {
    fn kind(&self) -> AgentKind {
        AgentKind::Pi
    }
    fn config_path(&self) -> PathBuf {
        home_dir()
            .join(".pi")
            .join("agent")
            .join("extensions")
            .join("git-ai.ts")
    }
    async fn probe(&self) -> AgentHookStatus {
        probe_ts_plugin(
            AgentKind::Pi,
            self.config_path(),
            "未检测到 ~/.pi/agent/extensions/git-ai.ts (Pi 未配置 git-ai 扩展)",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_path_points_at_pi_extension() {
        let p = PiProbe.config_path();
        assert!(p.ends_with("git-ai.ts"));
        assert!(p.to_string_lossy().contains(".pi"));
        assert!(p.to_string_lossy().contains("extensions"));
    }
}
