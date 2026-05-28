use tauri::State;

use crate::proc::apply_no_window_std;
use crate::repo;
use crate::state::{AppSettings, AppState, RepoEntry};

/// 路径规范化:统一 Windows 正反斜杠、解析符号链接、去掉尾随分隔符。
fn normalize(input: &str) -> std::path::PathBuf {
    let p = std::path::PathBuf::from(input);
    dunce::canonicalize(&p).unwrap_or(p)
}

#[tauri::command]
pub async fn discover_repos(
    roots: Vec<String>,
    max_depth: Option<u32>,
) -> Result<Vec<RepoEntry>, String> {
    let normalized: Vec<String> = roots
        .into_iter()
        .map(|r| normalize(&r).display().to_string())
        .collect();
    let entries =
        tokio::task::spawn_blocking(move || repo::discover::scan_roots(&normalized, max_depth))
            .await
            .map_err(|e| format!("scan failed: {e}"))?;
    Ok(entries)
}

#[tauri::command]
pub async fn select_repo(
    app: tauri::AppHandle,
    path: String,
    state: State<'_, AppState>,
) -> Result<RepoEntry, String> {
    let normalized = normalize(&path);
    if !normalized.is_dir() {
        return Err(format!("目录不存在: {path}"));
    }
    let normalized_str = normalized.display().to_string();
    let scanned = repo::discover::scan_roots(std::slice::from_ref(&normalized_str), Some(1));
    let mut entry = scanned
        .into_iter()
        .find(|e| {
            // 两边都已 canonicalize,直接比较;退化情况下大小写不敏感
            e.path.eq_ignore_ascii_case(&normalized_str)
                || normalize(&e.path).display().to_string() == normalized_str
        })
        .ok_or_else(|| format!("不是一个 git 仓库(未发现 .git): {path}"))?;

    // 选中后立刻同步查一次 dirty,失败保持 None
    entry.dirty = tokio::task::spawn_blocking({
        let p = std::path::PathBuf::from(&entry.path);
        move || repo::head::detect_dirty(&p)
    })
    .await
    .ok()
    .flatten();

    if let Ok(mut g) = state.current_repo.write() {
        *g = Some(entry.clone());
    }
    if let Ok(mut g) = state.diag_cache.write() {
        *g = None;
    }
    // 切仓库后,前一仓库的 commit 列表必须作废,否则前端会看到旧仓库的 sha。
    if let Ok(mut g) = state.commits_cache.write() {
        *g = None;
    }
    let mut settings = AppSettings::load();
    settings.last_repo = Some(entry.path.clone());
    settings.recent_repos.retain(|p| p != &entry.path);
    settings.recent_repos.insert(0, entry.path.clone());
    settings.recent_repos.truncate(5);
    let _ = settings.save();

    // 切仓后重启 refs/notes/ai watcher 指向新仓库(若用户开了实时低 AI 提醒)。
    // realtime_enabled 默认 true,需要同时开了低 AI 总开关才会真正启动。
    let realtime_active = settings.notifications.low_ai_share.enabled
        && settings
            .notifications
            .low_ai_share
            .realtime_enabled
            .unwrap_or(true);
    crate::repo_notes_watcher::apply_state(&app, &state, Some(&entry.path), realtime_active);

    Ok(entry)
}

#[tauri::command]
pub async fn current_repo(state: State<'_, AppState>) -> Result<Option<RepoEntry>, String> {
    Ok(state.current_repo.read().ok().and_then(|g| g.clone()))
}

#[tauri::command]
pub async fn current_git_user_email(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let repo_path: String = {
        let g = state
            .current_repo
            .read()
            .map_err(|_| "current_repo 锁中毒".to_string())?;
        match g.as_ref() {
            Some(r) => r.path.clone(),
            None => return Ok(None),
        }
    };
    let git_exe = match which::which("git") {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    let repo = std::path::PathBuf::from(repo_path);
    let out = match crate::proc::run_capture_with_timeout(
        &git_exe,
        &["config", "--get", "user.email"],
        Some(&repo),
        std::time::Duration::from_secs(5),
    )
    .await
    {
        Ok(out) => out,
        Err(_) => return Ok(None),
    };
    if out.status != 0 {
        return Ok(None);
    }
    let email = out.stdout.trim().to_lowercase();
    Ok((!email.is_empty()).then_some(email))
}

#[tauri::command]
pub async fn detect_dirty(path: String) -> Result<Option<bool>, String> {
    let p = std::path::PathBuf::from(&path);
    tokio::task::spawn_blocking(move || repo::head::detect_dirty(&p))
        .await
        .map_err(|e| format!("dirty 探测失败: {e}"))
}

#[tauri::command]
pub async fn list_recent_repos() -> Result<Vec<String>, String> {
    Ok(AppSettings::load().recent_repos)
}

#[tauri::command]
pub async fn list_scan_roots() -> Result<Vec<String>, String> {
    Ok(AppSettings::load().scan_roots)
}

#[tauri::command]
pub async fn set_scan_roots(roots: Vec<String>) -> Result<(), String> {
    let mut settings = AppSettings::load();
    settings.scan_roots = roots;
    settings.save().map_err(|e| format!("写配置失败: {e}"))
}

#[tauri::command]
pub async fn restore_last_repo(state: State<'_, AppState>) -> Result<Option<RepoEntry>, String> {
    let settings = AppSettings::load();
    let Some(last) = settings.last_repo else {
        return Ok(None);
    };
    let normalized = normalize(&last);
    if !normalized.is_dir() {
        return Ok(None);
    }
    let normalized_str = normalized.display().to_string();
    let scanned = repo::discover::scan_roots(std::slice::from_ref(&normalized_str), Some(1));
    let mut entry = match scanned.into_iter().find(|e| {
        e.path.eq_ignore_ascii_case(&normalized_str)
            || normalize(&e.path).display().to_string() == normalized_str
    }) {
        Some(e) => e,
        None => return Ok(None),
    };
    entry.dirty = tokio::task::spawn_blocking({
        let p = std::path::PathBuf::from(&entry.path);
        move || repo::head::detect_dirty(&p)
    })
    .await
    .ok()
    .flatten();
    if let Ok(mut g) = state.current_repo.write() {
        *g = Some(entry.clone());
    }
    Ok(Some(entry))
}

#[tauri::command]
pub async fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg(&path);
        apply_no_window_std(&mut cmd);
        cmd.spawn().map_err(|e| format!("打开文件夹失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        cmd.arg(&path);
        apply_no_window_std(&mut cmd);
        cmd.spawn().map_err(|e| format!("打开文件夹失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(&path);
        apply_no_window_std(&mut cmd);
        cmd.spawn().map_err(|e| format!("打开文件夹失败: {e}"))?;
    }
    Ok(())
}
