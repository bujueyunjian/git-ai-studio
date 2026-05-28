pub mod auth;
pub mod blame;
pub mod branches;
pub mod checkpoints;
pub mod diagnostic;
pub mod diff;
pub mod history;
pub mod hooks;
pub mod ignore;
pub mod install;
pub mod logs;
pub mod notes;
pub mod people;
pub mod repo;
pub mod settings;
pub mod show;
pub mod stats;

use crate::git_ai;

/// 联调用:`invoke("ping")` 返回 "pong"。
#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}

/// 返回 (是否找到, 路径或错误描述)。
#[tauri::command]
pub fn resolve_git_ai_path() -> (bool, String) {
    match git_ai::binary::resolve() {
        Ok(p) => (true, p.display().to_string()),
        Err(e) => (false, e.to_string()),
    }
}
