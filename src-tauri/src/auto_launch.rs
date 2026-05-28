//! 应用本体「开机自启」开关。
//!
//! # 真源
//! 开机自启状态的唯一真源是操作系统登录项,不在 app config 里另存一份 —— 避免两处
//! 状态漂移。前端每次读 [`is_auto_launch_enabled`] 即可拿到当前真实状态。
//!
//! # 平台机制
//! - **Windows**:登录触发的计划任务(`schtasks /SC ONLOGON`)。刻意**不**走注册表
//!   `HKCU\...\CurrentVersion\Run` —— 该路径是企业 EDR(如奇安信天擎)重点监控的
//!   「Run 启动项劫持」行为,会被拦截。
//! - **macOS / Linux**:`auto-launch` crate(AppleScript login item / XDG autostart),
//!   这两个平台无注册表告警问题。

use crate::error::AppError;

/// Windows:登录自启用计划任务。直接拉起应用 exe。启用 = 任务存在;
/// 禁用 = 删除任务,语义与注册表项「存在/不存在」一致,前端无需关心计划任务的
/// enabled/disabled 细分态。
#[cfg(target_os = "windows")]
mod imp {
    use crate::error::{AppError, Result};
    use crate::proc::run_capture;

    const TASK_NAME: &str = "GitAiStudioAutoStart";

    fn schtasks() -> Result<std::path::PathBuf> {
        which::which("schtasks").map_err(|_| AppError::Other("找不到 schtasks.exe".into()))
    }

    fn exe_path() -> Result<String> {
        let p = std::env::current_exe()
            .map_err(|e| AppError::Other(format!("无法获取应用可执行文件路径: {e}")))?;
        Ok(p.to_string_lossy().into_owned())
    }

    pub async fn enable() -> Result<()> {
        let schtasks = schtasks()?;
        // 先删后建:应用升级或换安装目录后,exe 路径会变,重建以写入最新路径。
        let _ = run_capture(&schtasks, &["/Delete", "/TN", TASK_NAME, "/F"], None).await;
        let tr = format!("\"{}\"", exe_path()?);
        let args = [
            "/Create", "/TN", TASK_NAME, "/TR", &tr, "/SC", "ONLOGON", "/RL", "LIMITED", "/F",
        ];
        let out = run_capture(&schtasks, &args, None).await?;
        if out.status != 0 {
            return Err(AppError::Other(format!(
                "schtasks /Create 失败 (退出码 {}): {}",
                out.status,
                out.stderr.trim()
            )));
        }
        log::info!("已启用开机自启(计划任务 {TASK_NAME})");
        Ok(())
    }

    pub async fn disable() -> Result<()> {
        if !is_enabled().await? {
            return Ok(());
        }
        let schtasks = schtasks()?;
        let out = run_capture(&schtasks, &["/Delete", "/TN", TASK_NAME, "/F"], None).await?;
        if out.status != 0 {
            return Err(AppError::Other(format!(
                "schtasks /Delete 失败: {}",
                out.stderr.trim()
            )));
        }
        log::info!("已禁用开机自启(删除计划任务 {TASK_NAME})");
        Ok(())
    }

    pub async fn is_enabled() -> Result<bool> {
        let schtasks = schtasks()?;
        let out = run_capture(&schtasks, &["/Query", "/TN", TASK_NAME], None).await?;
        Ok(out.status == 0)
    }
}

/// macOS / Linux:沿用 `auto-launch` crate,跨平台差异由 `AutoLaunchBuilder` 抹平。
#[cfg(not(target_os = "windows"))]
mod imp {
    use crate::error::{AppError, Result};
    use auto_launch::{AutoLaunch, AutoLaunchBuilder};

    /// 注册登录项时使用的应用名(对应 login item / autostart 条目名)。
    const APP_NAME: &str = "Git AI Studio";

    /// 把 `/path/to/Git AI Studio.app/Contents/MacOS/Git AI Studio` 还原为
    /// `/path/to/Git AI Studio.app`。macOS 必须用 .app bundle 路径注册 login item,
    /// 否则 AppleScript 会拉起终端而非应用本体。
    #[cfg(target_os = "macos")]
    fn macos_app_bundle_path(exe_path: &std::path::Path) -> Option<std::path::PathBuf> {
        let s = exe_path.to_string_lossy();
        s.find(".app/Contents/MacOS/")
            .map(|pos| std::path::PathBuf::from(&s[..pos + 4]))
    }

    fn handle() -> Result<AutoLaunch> {
        let exe_path = std::env::current_exe()
            .map_err(|e| AppError::Other(format!("无法获取应用可执行文件路径: {e}")))?;

        #[cfg(target_os = "macos")]
        let app_path = macos_app_bundle_path(&exe_path).unwrap_or(exe_path);
        #[cfg(not(target_os = "macos"))]
        let app_path = exe_path;

        AutoLaunchBuilder::new()
            .set_app_name(APP_NAME)
            .set_app_path(&app_path.to_string_lossy())
            .build()
            .map_err(|e| AppError::Other(format!("创建开机自启句柄失败: {e}")))
    }

    pub async fn enable() -> Result<()> {
        handle()?
            .enable()
            .map_err(|e| AppError::Other(format!("启用开机自启失败: {e}")))?;
        log::info!("已启用开机自启");
        Ok(())
    }

    pub async fn disable() -> Result<()> {
        handle()?
            .disable()
            .map_err(|e| AppError::Other(format!("禁用开机自启失败: {e}")))?;
        log::info!("已禁用开机自启");
        Ok(())
    }

    pub async fn is_enabled() -> Result<bool> {
        handle()?
            .is_enabled()
            .map_err(|e| AppError::Other(format!("查询开机自启状态失败: {e}")))
    }
}

/// 启用开机自启(注册登录项)。
pub async fn enable_auto_launch() -> Result<(), AppError> {
    imp::enable().await
}

/// 禁用开机自启(移除登录项)。
pub async fn disable_auto_launch() -> Result<(), AppError> {
    imp::disable().await
}

/// 查询当前是否已注册开机自启。
pub async fn is_auto_launch_enabled() -> Result<bool, AppError> {
    imp::is_enabled().await
}
