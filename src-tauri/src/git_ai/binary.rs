use crate::error::{AppError, Result};
use crate::paths::{git_ai_bin_dir, GIT_AI_EXE_NAME};
use std::path::PathBuf;
use std::sync::RwLock;

use once_cell::sync::Lazy;

/// 路径缓存:首次解析后复用。Install / Uninstall 后必须调 [`invalidate_cache`] 失效。
static CACHED: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// 按优先级解析 `git-ai` 可执行文件路径:
/// 1. 环境变量 `GIT_AI_PATH`
/// 2. `~/.git-ai/bin/git-ai[.exe]`
/// 3. 系统 `PATH`(`which::which`)
pub fn resolve() -> Result<PathBuf> {
    if let Some(p) = CACHED.read().ok().and_then(|g| g.clone()) {
        return Ok(p);
    }

    if let Ok(env_path) = std::env::var("GIT_AI_PATH") {
        let p = PathBuf::from(env_path);
        if p.is_file() {
            return Ok(cache(p));
        }
    }

    let local = git_ai_bin_dir().join(*GIT_AI_EXE_NAME);
    if local.is_file() {
        return Ok(cache(local));
    }

    match which::which("git-ai") {
        Ok(p) => Ok(cache(p)),
        Err(_) => Err(AppError::GitAiNotFound),
    }
}

fn cache(p: PathBuf) -> PathBuf {
    if let Ok(mut g) = CACHED.write() {
        *g = Some(p.clone());
    }
    p
}

/// 安装 / 卸载 / 改 `GIT_AI_PATH` 后必须调用,让下次 [`resolve`] 重新探测。
pub fn invalidate_cache() {
    if let Ok(mut g) = CACHED.write() {
        *g = None;
    }
}
