//! 下载官方 install.ps1 / install.sh 到本地临时目录,再用 powershell / bash 执行。
//! 不走 `irm | iex` / `curl | bash`,避免失败无法重试与日志缺失。

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::{AppError, Result};
use crate::paths::studio_data_dir;

const INSTALL_PS1_URL: &str = "https://usegitai.com/install.ps1";
const INSTALL_SH_URL: &str = "https://usegitai.com/install.sh";
const USER_AGENT: &str = "git-ai-studio/0.1";

fn installers_dir() -> PathBuf {
    studio_data_dir().join("installers")
}

/// 下载 install 脚本到本地。返回脚本绝对路径。
pub async fn download_install_script() -> Result<PathBuf> {
    let (url, name) = if cfg!(windows) {
        (INSTALL_PS1_URL, "install.ps1")
    } else {
        (INSTALL_SH_URL, "install.sh")
    };
    let dir = installers_dir();
    std::fs::create_dir_all(&dir).map_err(AppError::Io)?;
    let target = dir.join(name);

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Other(format!("http client: {e}")))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("下载脚本失败: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "下载脚本失败: HTTP {}",
            resp.status().as_u16()
        )));
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| AppError::Other(format!("读取脚本响应体失败: {e}")))?;
    std::fs::write(&target, &body).map_err(AppError::Io)?;
    Ok(target)
}

/// 返回 (program, args, env)。env 是要追加的环境变量,在已继承的进程 env 之上叠加。
///
/// # 版本固定(上游真源)
/// `version` 传入应为 GitHub release tag(如 `"v1.4.7"`)。注入 env `GIT_AI_RELEASE_TAG`:
/// - `git-ai/install.ps1:417` `$env:GIT_AI_RELEASE_TAG` → `$releaseTag`
/// - `git-ai/install.sh:266` `${GIT_AI_RELEASE_TAG:-}` → `RELEASE_TAG`
///
/// 两脚本都把 `"latest"` 当成"等同于未传 → 走最新",所以传 `version=None` 与传
/// `Some("latest")` 行为一致。我们只在显式选了非 latest 版本时注入 env。
pub fn build_install_invocation(
    script: &Path,
    version: Option<&str>,
) -> (PathBuf, Vec<String>, Vec<(String, String)>) {
    let mut env: Vec<(String, String)> = Vec::new();
    if let Some(v) = version {
        if v != "latest" {
            env.push(("GIT_AI_RELEASE_TAG".into(), v.to_string()));
        }
    }

    if cfg!(windows) {
        // powershell -NoProfile -ExecutionPolicy Bypass -File <abs>
        let prog = which::which("powershell")
            .or_else(|_| which::which("pwsh"))
            .unwrap_or_else(|_| PathBuf::from("powershell"));
        let args = vec![
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(), // ExecutionPolicy 的值,不带前导短横线
            "-File".into(),
            script.display().to_string(),
        ];
        (prog, args, env)
    } else {
        let prog = which::which("bash").unwrap_or_else(|_| PathBuf::from("bash"));
        let args = vec![script.display().to_string()];
        (prog, args, env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invocation_without_version_has_no_release_tag_env() {
        let (_, _, env) = build_install_invocation(Path::new("/tmp/install.sh"), None);
        assert!(
            env.iter().all(|(k, _)| k != "GIT_AI_RELEASE_TAG"),
            "传 None 不应注入 GIT_AI_RELEASE_TAG,实际 env: {env:?}"
        );
    }

    #[test]
    fn invocation_with_explicit_version_injects_upstream_env_name() {
        let (_, _, env) = build_install_invocation(Path::new("/tmp/install.sh"), Some("v1.4.7"));
        let tag_envs: Vec<_> = env
            .iter()
            .filter(|(k, _)| k == "GIT_AI_RELEASE_TAG")
            .collect();
        assert_eq!(
            tag_envs.len(),
            1,
            "只应注入 1 个 GIT_AI_RELEASE_TAG,实际 env: {env:?}"
        );
        assert_eq!(tag_envs[0].1, "v1.4.7");
    }

    #[test]
    fn invocation_with_version_does_not_inject_deprecated_env_names() {
        // 防退化:历史上曾臆测过 `GIT_AI_VERSION` / `INSTALL_GIT_AI_VERSION`,均非上游真名。
        // 上游真源:install.ps1:417 / install.sh:266 只识别 GIT_AI_RELEASE_TAG。
        let (_, _, env) = build_install_invocation(Path::new("/tmp/install.sh"), Some("v1.4.7"));
        for (k, _) in &env {
            assert_ne!(k, "GIT_AI_VERSION", "GIT_AI_VERSION 不是上游 env 名,禁用");
            assert_ne!(
                k, "INSTALL_GIT_AI_VERSION",
                "INSTALL_GIT_AI_VERSION 不是上游 env 名,禁用"
            );
        }
    }

    #[test]
    fn invocation_with_latest_string_skips_env() {
        // 上游:install.ps1:417 `$env:GIT_AI_RELEASE_TAG -ne 'latest'` 才用该值,
        // 不传 / 传 "latest" 都等价于走最新。我们前置去掉 latest,避免无意义 env。
        let (_, _, env) = build_install_invocation(Path::new("/tmp/install.sh"), Some("latest"));
        assert!(
            env.iter().all(|(k, _)| k != "GIT_AI_RELEASE_TAG"),
            "version=latest 应等同 None,不注入 GIT_AI_RELEASE_TAG,实际 env: {env:?}"
        );
    }
}
