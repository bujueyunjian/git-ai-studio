//! Hooks 模式的统一模型 + 状态枚举。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HooksMode {
    /// 官方:`git-ai install-hooks` 写入 `{ "type": "command", "command": ".../git-ai checkpoint claude ..." }`
    Official,
    /// 都没配
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HooksStatus {
    pub mode: HooksMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsBackup {
    pub path: String,
    pub at_unix_ms: i64,
    pub size: u64,
}
