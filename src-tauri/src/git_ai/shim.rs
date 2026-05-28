//! 校验 git 代理 shim:用户在 PATH 中第一个 `git` 是否指向 `~/.git-ai/bin/git[.exe]`。
//!
//! Windows: `where git` 输出全部命中,按行;第一行应为 shim。
//! Unix:   `which git` 仅返回第一个;直接比对。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::paths::git_ai_bin_dir;
use crate::proc::run_capture;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShimStatus {
    /// 系统中按搜索顺序返回的所有 git 路径(Unix 一般只有 1 个)。
    pub resolved_paths: Vec<String>,
    /// 第一个候选是否就是 git-ai 的 shim。
    pub first_is_shim: bool,
    /// 期望的 shim 绝对路径。
    pub expected_shim: String,
    /// 综合结论(true ⇔ first_is_shim)。
    pub ok: bool,
}

/// 一次性探测;遇到 `where/which` 不存在或退出非 0,resolved_paths 返回空。
pub async fn check() -> Result<ShimStatus> {
    let expected = expected_shim_path();

    let (program, args): (&str, Vec<&str>) = if cfg!(windows) {
        ("where", vec!["git"])
    } else {
        ("which", vec!["-a", "git"])
    };

    let program_path = match which::which(program) {
        Ok(p) => p,
        Err(_) => {
            return Ok(ShimStatus {
                resolved_paths: vec![],
                first_is_shim: false,
                expected_shim: expected.display().to_string(),
                ok: false,
            });
        }
    };

    let out = run_capture(&program_path, &args, None).await?;
    let resolved: Vec<String> = out
        .stdout
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let first_is_shim = resolved
        .first()
        .map(|p| path_eq(p, &expected))
        .unwrap_or(false);

    Ok(ShimStatus {
        resolved_paths: resolved,
        first_is_shim,
        expected_shim: expected.display().to_string(),
        ok: first_is_shim,
    })
}

fn expected_shim_path() -> PathBuf {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    git_ai_bin_dir().join(name)
}

/// Windows 大小写不敏感比较;两边都规整化为大写小斜杠。
fn path_eq(a: &str, b: &Path) -> bool {
    let norm = |s: &str| s.replace('/', "\\").to_ascii_lowercase();
    norm(a) == norm(&b.display().to_string())
}
