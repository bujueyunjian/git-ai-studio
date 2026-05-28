//! P9 Logs 命令层。3 个**只读**命令(无写盘 / 无锁互斥):
//!
//! - `read_log_file(kind, max_bytes?)`     读尾部 N 字节 + 元数据
//! - `run_git_ai_debug_report(app, job_id)` 流式回传 `git-ai debug`(无子参数)
//! - `open_log_dir(kind)`                   在资源管理器打开指定日志文件的父目录
//!
//! # 设计要点
//! - **不传 `GIT_AI_DEBUG=1` env**:上游 `daemon.rs:8452` 真源证明该 env 仅影响 daemon 进程
//!   启动时 tracing-subscriber 的 EnvFilter level,对一次性 CLI(`git-ai debug`)无作用。
//!   传它属于误导。
//! - **`debug` 是无子参数命令**:上游 `git-ai debug --help` 明确 `Usage: git-ai debug`,
//!   早期注释 / 文档里写过 `git-ai debug report` 是历史臆造,真跑会报
//!   `unknown debug argument(s): report` → exit 1。这里保留命令名 run_git_ai_debug_report
//!   以维持前端 API 契约稳定。
//! - **UTF-8 lossy 边界保护**:从大文件尾部 seek 读取时首字节可能落在 multi-byte 中间;
//!   `String::from_utf8_lossy` 会插 U+FFFD,我们更进一步 strip 到下一个 `\n` 让头部干净。
//! - **硬上限 `LOG_HARD_CAP_BYTES`**:即便调用方传巨大 max_bytes,实际读取量被夹断,防 OOM。
//! - **path 探测兼容**:Tab C 应用日志用 productName(`Git AI Studio.log`,
//!   tauri-plugin-log-2.8.0/src/lib.rs:633-635 真源)+ fallback 到 bundle identifier
//!   (`com.git-ai.studio.log`)兼容老版本 / 旧文件名。
//! - **App log dir 解析**:用 `app.path().app_log_dir()` 而非自拼路径,跨平台真源。

use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::git_ai;
use crate::proc::run_streaming;

const LOG_TAIL_BYTES_DEFAULT: u64 = 256 * 1024;
const LOG_HARD_CAP_BYTES: u64 = 4 * 1024 * 1024;
const DEBUG_REPORT_TIMEOUT_SECS: u64 = 15;

// ============================================================================
// LogKind / LogFilePayload
// ============================================================================

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LogKind {
    /// `app_log_dir()/{productName|identifier}.log`
    App,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct LogFilePayload {
    pub path: String,
    pub exists: bool,
    pub size: u64,
    pub mtime_unix_ms: Option<i64>,
    /// `true` 表示 `size > read_bytes`,内容是尾部截断后的。
    pub truncated_head: bool,
    /// UTF-8 lossy 后的尾部内容;空文件 / 不存在时为空串。
    pub content: String,
}

// ============================================================================
// Commands
// ============================================================================

#[tauri::command]
pub async fn read_log_file(
    app: AppHandle,
    kind: LogKind,
    max_bytes: Option<u64>,
) -> Result<LogFilePayload, String> {
    let path = resolve_log_path(&app, kind).map_err(|e| e.to_string())?;
    let max = max_bytes
        .unwrap_or(LOG_TAIL_BYTES_DEFAULT)
        .min(LOG_HARD_CAP_BYTES);
    read_tail(&path, max).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_git_ai_debug_report(app: AppHandle, job_id: String) -> Result<i32, String> {
    let bin = git_ai::binary::resolve()
        .map_err(|_| "git-ai 二进制未找到,请先在 Install 页安装".to_string())?;
    let topic = format!("logs://debug/{job_id}");
    run_streaming(
        &app,
        &bin,
        &["debug"],
        None,
        &[],
        &topic,
        Duration::from_secs(DEBUG_REPORT_TIMEOUT_SECS),
    )
    .await
    .map_err(|e| e.to_string())
}

/// 打开日志文件所在的父目录。比前端正则切 path 安全,因为 `Path::parent()` 是
/// 跨平台真源(Windows root `C:\file.log` → `C:\`,POSIX root `/file.log` → `/`)。
/// 父目录不存在时 Err(no-fallback)。
#[tauri::command]
pub async fn open_log_dir(app: AppHandle, kind: LogKind) -> Result<(), String> {
    let path = resolve_log_path(&app, kind).map_err(|e| e.to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法解析父目录: {} 没有 parent 段", path.display()))?;
    if !parent.exists() {
        return Err(format!("父目录不存在: {}", parent.display()));
    }
    open_in_explorer_native(parent).map_err(|e| format!("打开文件夹失败: {e}"))
}

// ============================================================================
// 私有 helpers
// ============================================================================

/// 把 LogKind 映射到具体文件路径。App 走 `app.path().app_log_dir()`,失败回错。
fn resolve_log_path(app: &AppHandle, kind: LogKind) -> Result<PathBuf, String> {
    Ok(match kind {
        LogKind::App => resolve_app_log_path(app)?,
    })
}

/// App log 路径解析:优先 `<app_log_dir>/Git AI Studio.log`(productName),
/// 文件不存在时 fallback 到 `<app_log_dir>/com.git-ai.studio.log`(bundle id)。
/// 两个都不存在时返回 productName 路径让 read_tail 报 exists=false。
fn resolve_app_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("无法解析 app_log_dir: {e}"))?;
    let primary = dir.join("Git AI Studio.log");
    if primary.exists() {
        return Ok(primary);
    }
    let fallback = dir.join("com.git-ai.studio.log");
    if fallback.exists() {
        return Ok(fallback);
    }
    Ok(primary)
}

async fn read_tail(path: &Path, max_bytes: u64) -> Result<LogFilePayload, String> {
    let path_str = path.display().to_string();

    let meta = match tokio::fs::metadata(path).await {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LogFilePayload {
                path: path_str,
                exists: false,
                size: 0,
                mtime_unix_ms: None,
                truncated_head: false,
                content: String::new(),
            });
        }
        Err(e) => return Err(format!("读取元数据失败: {e}")),
    };

    let size = meta.len();
    let mtime_unix_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);

    if size == 0 {
        return Ok(LogFilePayload {
            path: path_str,
            exists: true,
            size: 0,
            mtime_unix_ms,
            truncated_head: false,
            content: String::new(),
        });
    }

    let read_bytes = size.min(max_bytes);
    let truncated_head = size > read_bytes;
    let seek_from = size - read_bytes;

    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("打开文件失败: {e}"))?;
    if seek_from > 0 {
        f.seek(std::io::SeekFrom::Start(seek_from))
            .await
            .map_err(|e| format!("seek 失败: {e}"))?;
    }
    let mut buf = Vec::with_capacity(read_bytes as usize);
    f.take(read_bytes)
        .read_to_end(&mut buf)
        .await
        .map_err(|e| format!("读取失败: {e}"))?;

    // UTF-8 lossy + 截断头部到下一个换行(仅当 truncated_head 时,避免完整文件被截首行)
    let content = if truncated_head {
        strip_to_next_newline(buf)
    } else {
        String::from_utf8_lossy(&buf).into_owned()
    };

    Ok(LogFilePayload {
        path: path_str,
        exists: true,
        size,
        mtime_unix_ms,
        truncated_head,
        content,
    })
}

/// 把首个换行符之前的字节丢掉,避免 multi-byte 边界被切坏 + 用户看到半截行。
/// 若无换行符(异常单行超大日志),保留整段 lossy。
fn strip_to_next_newline(buf: Vec<u8>) -> String {
    match buf.iter().position(|&b| b == b'\n') {
        Some(idx) if idx + 1 < buf.len() => String::from_utf8_lossy(&buf[idx + 1..]).into_owned(),
        _ => String::from_utf8_lossy(&buf).into_owned(),
    }
}

#[cfg(windows)]
fn open_in_explorer_native(p: &Path) -> std::io::Result<()> {
    let mut cmd = std::process::Command::new("explorer");
    cmd.arg(p);
    crate::proc::apply_no_window_std(&mut cmd);
    cmd.spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_in_explorer_native(p: &Path) -> std::io::Result<()> {
    std::process::Command::new("open").arg(p).spawn()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_in_explorer_native(p: &Path) -> std::io::Result<()> {
    std::process::Command::new("xdg-open").arg(p).spawn()?;
    Ok(())
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "git-ai-studio-logs-test-{}-{}",
            name,
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("f.log")
    }

    #[tokio::test]
    async fn read_tail_missing_file_returns_exists_false() {
        let p = tmp_path("missing").parent().unwrap().join("no.log");
        let payload = read_tail(&p, 1024).await.unwrap();
        assert!(!payload.exists);
        assert_eq!(payload.size, 0);
        assert!(payload.content.is_empty());
        assert!(!payload.truncated_head);
    }

    #[tokio::test]
    async fn read_tail_returns_full_when_small() {
        let p = tmp_path("small");
        std::fs::write(&p, b"line1\nline2\n").unwrap();
        let payload = read_tail(&p, 1024).await.unwrap();
        assert!(payload.exists);
        assert_eq!(payload.size, 12);
        assert!(!payload.truncated_head);
        assert_eq!(payload.content, "line1\nline2\n");
    }

    #[tokio::test]
    async fn read_tail_truncates_and_strips_to_next_newline() {
        let p = tmp_path("trunc");
        // 100 行 "row-NN\n",每行 7 字节,共 700 字节
        let mut f = std::fs::File::create(&p).unwrap();
        for i in 0..100 {
            writeln!(f, "row-{i:02}").unwrap();
        }
        drop(f);

        // 只取最后 50 字节 — 必定切在某一行中间,strip 后应丢掉首个不完整行
        let payload = read_tail(&p, 50).await.unwrap();
        assert!(payload.truncated_head);
        assert_eq!(payload.size, 700);
        // strip_to_next_newline 后内容首字符不是 '-' / 数字这种中间字符
        assert!(
            payload.content.starts_with("row-"),
            "内容应从完整行开始,实得 {:?}",
            payload.content
        );
        // 末尾必须以换行符结束(文件就是这样)
        assert!(payload.content.ends_with('\n'));
    }

    #[tokio::test]
    async fn read_tail_empty_file_returns_exists_true_size_zero() {
        let p = tmp_path("empty");
        std::fs::File::create(&p).unwrap();
        let payload = read_tail(&p, 1024).await.unwrap();
        assert!(payload.exists);
        assert_eq!(payload.size, 0);
        assert!(!payload.truncated_head);
        assert!(payload.content.is_empty());
    }

    #[tokio::test]
    #[allow(clippy::assertions_on_constants)]
    async fn read_tail_respects_hard_cap() {
        // 这里直接断言 LOG_HARD_CAP_BYTES 常量被 read_log_file 入口 min() 夹断;
        // read_tail 本身只接受 max_bytes 参数,不做夹断 — 是入口的责任。
        // 该测试只防止常量被人误改成超大值。
        assert!(LOG_HARD_CAP_BYTES >= 1024 * 1024);
        assert!(LOG_HARD_CAP_BYTES <= 64 * 1024 * 1024);
        assert!(LOG_TAIL_BYTES_DEFAULT > 0 && LOG_TAIL_BYTES_DEFAULT <= LOG_HARD_CAP_BYTES);
    }

    #[test]
    fn strip_to_next_newline_no_newline_keeps_all() {
        let buf = b"abcdefg".to_vec();
        let s = strip_to_next_newline(buf);
        assert_eq!(s, "abcdefg");
    }

    #[test]
    fn strip_to_next_newline_drops_partial_first_line() {
        let buf = b"-part\nfull\n".to_vec();
        let s = strip_to_next_newline(buf);
        assert_eq!(s, "full\n");
    }

    #[test]
    fn strip_to_next_newline_lossy_handles_invalid_utf8() {
        // 0xFF 是无效 UTF-8 起始字节;首行被 strip 后剩 "ok\n"
        let buf = vec![0xFF, b'\n', b'o', b'k', b'\n'];
        let s = strip_to_next_newline(buf);
        assert_eq!(s, "ok\n");
    }

    #[test]
    fn log_kind_serde_is_internally_tagged_snake_case() {
        let payload = serde_json::to_string(&LogKind::App).unwrap();
        assert_eq!(payload, r#"{"kind":"app"}"#);
    }

    #[test]
    fn log_file_payload_field_names_match_frontend_contract() {
        let p = LogFilePayload {
            path: "/tmp/x.log".into(),
            exists: true,
            size: 10,
            mtime_unix_ms: Some(1700000000000),
            truncated_head: true,
            content: "abc".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains(r#""path":"/tmp/x.log""#));
        assert!(s.contains(r#""exists":true"#));
        assert!(s.contains(r#""size":10"#));
        assert!(s.contains(r#""mtime_unix_ms":1700000000000"#));
        assert!(s.contains(r#""truncated_head":true"#));
        assert!(s.contains(r#""content":"abc""#));
    }
}
