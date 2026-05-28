//! GitHub Releases 元数据拉取 + ETag 条件 GET 缓存。
//!
//! 数据源:`https://api.github.com/repos/git-ai-project/git-ai/releases`
//! 缓存:`~/.git-ai-studio/cache/releases.json` + `releases.etag`
//!
//! 失败语义:网络错误 / 非 2xx(304 除外)/ 限流 / 解析失败 → 全部 `Err` 抛给前端。
//! 不做"静默回退到旧缓存"的降级 —— 让用户清楚知道失败了。

use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::paths::studio_data_dir;

const RELEASES_URL: &str =
    "https://api.github.com/repos/git-ai-project/git-ai/releases?per_page=30";
const USER_AGENT: &str = "git-ai-studio/0.1";
const CACHE_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseSummary {
    pub tag: String,
    pub name: String,
    pub published_at: String,
    pub is_prerelease: bool,
    pub body: String,
    pub assets: Vec<ReleaseAsset>,
    /// 是否为最新非 prerelease(由调用方计算)
    pub is_latest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleasesPayload {
    pub releases: Vec<ReleaseSummary>,
    pub fetched_at_unix_ms: i64,
    /// true = 本次响应是 304 命中本地 ETag 缓存,数据来自缓存;false = 本次拉到全新数据。
    /// 这只是"如何拿到的"事实陈述,UI 不应据此切错误态。
    pub from_etag_cache: bool,
    pub rate_limit: Option<RateLimitInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitInfo {
    pub remaining: u32,
    pub reset_unix: i64,
}

fn cache_dir() -> std::path::PathBuf {
    studio_data_dir().join("cache")
}
fn cache_json_path() -> std::path::PathBuf {
    cache_dir().join("releases.json")
}
fn cache_etag_path() -> std::path::PathBuf {
    cache_dir().join("releases.etag")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_cache() -> Option<ReleasesPayload> {
    let json = fs::read_to_string(cache_json_path()).ok()?;
    serde_json::from_str(&json).ok()
}

fn write_cache(p: &ReleasesPayload, etag: Option<&str>) -> std::io::Result<()> {
    fs::create_dir_all(cache_dir())?;
    fs::write(
        cache_json_path(),
        serde_json::to_string_pretty(p).unwrap_or_default(),
    )?;
    if let Some(e) = etag {
        fs::write(cache_etag_path(), e)?;
    }
    Ok(())
}

fn read_etag() -> Option<String> {
    fs::read_to_string(cache_etag_path()).ok()
}

/// 列所有 release。
///
/// - `force=false`:命中本地缓存 + 30 min TTL 内 → 直接返回缓存,不发请求。
/// - 其它情况:发请求,带 ETag。
/// - 304 命中:复用缓存的 releases 列表 + 刷新 TTL + 标 `from_etag_cache=true`。
/// - 200 命中:解析并落地缓存。
/// - 其它情况(网络错误 / 4xx / 5xx / 限流 / 解析失败):**抛错**,不悄悄回退。
pub async fn list(force: bool) -> Result<ReleasesPayload> {
    if !force {
        if let Some(cached) = read_cache() {
            let age_ms = now_ms() - cached.fetched_at_unix_ms;
            if age_ms >= 0 && (age_ms as u64) < CACHE_TTL.as_millis() as u64 {
                return Ok(cached);
            }
        }
    }

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Other(format!("http client: {e}")))?;

    let mut req = client
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json");
    if let Some(etag) = read_etag() {
        req = req.header("If-None-Match", etag);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Other(format!("拉取 releases 失败: {e}")))?;

    let status = resp.status();
    let etag_hdr = resp
        .headers()
        .get("ETag")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let rate_limit = parse_rate_limit(resp.headers());

    // 304:HTTP 标准的"未变化"。允许复用缓存 + 刷新 TTL。
    if status.as_u16() == 304 {
        let mut cached = read_cache()
            .ok_or_else(|| AppError::Other("收到 304 但本地缓存丢失,请刷新重试".into()))?;
        cached.fetched_at_unix_ms = now_ms();
        cached.from_etag_cache = true;
        cached.rate_limit = rate_limit;
        let _ = write_cache(&cached, etag_hdr.as_deref());
        return Ok(cached);
    }

    if !status.is_success() {
        return Err(AppError::Other(format!(
            "GitHub API 返回 HTTP {} —— {}",
            status.as_u16(),
            describe_status(status.as_u16())
        )));
    }

    let raw_releases: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| AppError::Other(format!("解析 releases JSON 失败: {e}")))?;
    let mut releases: Vec<ReleaseSummary> =
        raw_releases.into_iter().filter_map(parse_release).collect();
    if let Some(idx) = releases.iter().position(|r| !r.is_prerelease) {
        releases[idx].is_latest = true;
    }

    let payload = ReleasesPayload {
        releases,
        fetched_at_unix_ms: now_ms(),
        from_etag_cache: false,
        rate_limit,
    };
    let _ = write_cache(&payload, etag_hdr.as_deref());
    Ok(payload)
}

fn describe_status(code: u16) -> &'static str {
    match code {
        401 => "未授权(未登录或 Token 失效)",
        403 => "禁止访问或被限流(rate-limit 已耗尽)",
        404 => "仓库不存在",
        429 => "限流",
        500..=599 => "GitHub 服务端错误",
        _ => "未知错误",
    }
}

fn parse_release(v: serde_json::Value) -> Option<ReleaseSummary> {
    let tag = v.get("tag_name")?.as_str()?.to_string();
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or(&tag)
        .to_string();
    let published_at = v
        .get("published_at")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let is_prerelease = v
        .get("prerelease")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let body = v
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let assets = v
        .get("assets")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    Some(ReleaseAsset {
                        name: a.get("name")?.as_str()?.to_string(),
                        size: a.get("size")?.as_u64()?,
                        browser_download_url: a.get("browser_download_url")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(ReleaseSummary {
        tag,
        name,
        published_at,
        is_prerelease,
        body,
        assets,
        is_latest: false,
    })
}

fn parse_rate_limit(headers: &reqwest::header::HeaderMap) -> Option<RateLimitInfo> {
    let remaining = headers
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u32>().ok())?;
    let reset_unix = headers
        .get("x-ratelimit-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())?;
    Some(RateLimitInfo {
        remaining,
        reset_unix,
    })
}
