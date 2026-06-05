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
/// 3. `env_path` 真实 PATH 镜像(`which_in_real_path`,修正 GUI 被截断的进程 PATH)
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

    // 走 env_path 真实 PATH 镜像而非裸 which::which:GUI 启动 PATH 被截断时仍能解析,
    // 且运行期"重新检测/刷新环境"更新镜像后,未缓存的 resolve 能就地命中(见 env_path)。
    match crate::env_path::which_in_real_path("git-ai") {
        Some(p) => Ok(cache(p)),
        None => Err(AppError::GitAiNotFound),
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
