use once_cell::sync::Lazy;
use std::path::PathBuf;

/// 用户主目录。优先读 `GIT_AI_STUDIO_TEST_HOME`(便于测试隔离),否则走 dirs::home_dir。
pub fn home_dir() -> PathBuf {
    if let Ok(p) = std::env::var("GIT_AI_STUDIO_TEST_HOME") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    dirs::home_dir().unwrap_or_else(|| {
        log::warn!("home_dir 回退到 '.'");
        PathBuf::from(".")
    })
}

/// `~/.git-ai`
pub fn git_ai_dir() -> PathBuf {
    home_dir().join(".git-ai")
}

/// `~/.git-ai/bin`
pub fn git_ai_bin_dir() -> PathBuf {
    git_ai_dir().join("bin")
}

/// `~/.git-ai/internal/daemon`(上游 daemon.lock / daemon.pid.json 所在目录)
pub fn git_ai_internal_daemon_dir() -> PathBuf {
    git_ai_dir().join("internal").join("daemon")
}

/// `~/.git-ai/internal/daemon/daemon.lock` —— 上游 `DaemonLock::acquire` 抢的文件锁。
pub fn git_ai_daemon_lock_path() -> PathBuf {
    git_ai_internal_daemon_dir().join("daemon.lock")
}

/// `~/.git-ai/internal/daemon/daemon.pid.json` —— 上游 `write_pid_metadata` 写入的 PID 元信息。
pub fn git_ai_daemon_pid_meta_path() -> PathBuf {
    git_ai_internal_daemon_dir().join("daemon.pid.json")
}

/// `~/.git-ai/config.json` — git-ai 自身的运行时配置(`disable_auto_updates` 等)
pub fn git_ai_config_json() -> PathBuf {
    git_ai_dir().join("config.json")
}

/// `~/.claude`
pub fn claude_dir() -> PathBuf {
    home_dir().join(".claude")
}

/// `~/.claude/settings.json`
pub fn claude_settings_json() -> PathBuf {
    claude_dir().join("settings.json")
}

/// `~/.gemini/settings.json`(上游 `GeminiInstaller::settings_path` 真源 git-ai/src/mdm/agents/gemini.rs:18-20)
pub fn gemini_settings_json() -> PathBuf {
    home_dir().join(".gemini").join("settings.json")
}

/// `~/.cursor/hooks.json`
pub fn cursor_hooks_json() -> PathBuf {
    home_dir().join(".cursor").join("hooks.json")
}

/// 本应用自己的数据目录 `~/.git-ai-studio`
pub fn studio_data_dir() -> PathBuf {
    home_dir().join(".git-ai-studio")
}

/// settings.json 修改前的带时间戳备份目录
pub fn studio_backups_dir() -> PathBuf {
    studio_data_dir().join("backups")
}

/// 本应用 SQLite 文件路径(`~/.git-ai-studio/studio.sqlite`)。
pub fn studio_sqlite_path() -> PathBuf {
    studio_data_dir().join("studio.sqlite")
}

/// 平台对应的 git-ai 可执行文件名
pub static GIT_AI_EXE_NAME: Lazy<&'static str> = Lazy::new(|| {
    if cfg!(windows) {
        "git-ai.exe"
    } else {
        "git-ai"
    }
});
