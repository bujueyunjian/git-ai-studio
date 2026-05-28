//! `git-ai whoami` / `git-ai logout` 包装(P11-D)。
//!
//! # 上游真源
//! - `git-ai/src/commands/whoami.rs:5-99`(handle_whoami,stdout 文本格式)
//! - `git-ai/src/commands/logout.rs:4-25`
//! - `git-ai/src/auth/state.rs:5-23`(AuthState 4 态 + AuthStatus schema)
//!
//! # CLI 形态
//! `git-ai whoami` 输出**多行 `Key: Value` 文本**,**不是 JSON**。本模块按行解析。
//! Auth state 字面值固定 4 种:
//! - `"logged out"`
//! - `"logged in"`
//! - `"credentials expired (refresh token expired)"`
//! - `"error (<msg>)"`
//!
//! `<unavailable>` 字面值识别为 `None`,与 git-ai 的占位符语义一致。
//!
//! Orgs 段:
//! ```text
//! Organizations:
//!   - <slug> (<name>) [<id>] role=<role>
//!   - <slug> (<name>) [<id>] role=<role>
//! ```
//! 或 `Organizations: <none>` 表示空集。
//!
//! # No-fallback
//! - 解析失败 → fail-fast(`AppError::Other`),不静默给 None
//! - "logged out" 但 git-ai 用 api_key 时上游 exit 1 而 stdout 仍含可解析内容,
//!   本模块以 stdout 内容为准(不让 exit 码决定可否解析)。

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::proc::run_capture_with_timeout;

const WHOAMI_TIMEOUT: Duration = Duration::from_secs(10);
const LOGOUT_TIMEOUT: Duration = Duration::from_secs(10);

/// `<unavailable>` 字面值识别为 None。
const UNAVAILABLE_LITERAL: &str = "<unavailable>";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthState {
    LoggedOut,
    LoggedIn,
    RefreshExpired,
    /// 上游传 `Error(String)`,字面值类似 `"error (some details)"`。
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct OrgEntry {
    pub org_id: Option<String>,
    pub org_slug: Option<String>,
    pub org_name: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct WhoamiPayload {
    pub api_base_url: String,
    pub backend: String,
    /// 仅当用户用 GIT_AI_API_KEY env 而非 OAuth 时存在(已脱敏:`xxxx...yyyy`)。
    pub api_key_masked: Option<String>,
    pub state: AuthState,
    /// 上游用人话格式(如 `2026-05-13 14:00:00 UTC`),原样透传给 UI。
    pub access_token_expires_at: Option<String>,
    pub refresh_token_expires_at: Option<String>,
    pub user_id: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub personal_org_id: Option<String>,
    pub orgs: Vec<OrgEntry>,
}

/// 调 `git-ai whoami`,解析 stdout 文本为结构化 [`WhoamiPayload`]。
pub async fn run_whoami(git_ai: &Path) -> Result<WhoamiPayload> {
    let out = run_capture_with_timeout(git_ai, &["whoami"], None, WHOAMI_TIMEOUT).await?;
    // 注意:上游 whoami 在 logged_out / refresh_expired / error 且无 api_key 时 exit 1,
    // 但 stdout 仍含完整可解析内容。所以这里**不**用 exit 码判定成功 — 解析成功即可。
    parse_whoami(&out.stdout)
}

/// 调 `git-ai logout`,失败透传 stderr。
pub async fn run_logout(git_ai: &Path) -> Result<()> {
    let out = run_capture_with_timeout(git_ai, &["logout"], None, LOGOUT_TIMEOUT).await?;
    if out.status != 0 {
        return Err(AppError::GitAiFailed {
            code: out.status,
            stderr: out.stderr.trim().to_string(),
        });
    }
    Ok(())
}

/// 把 `<unavailable>` 与 `<none>` 与空串归一为 None。
fn to_optional(value: &str) -> Option<String> {
    let v = value.trim();
    if v.is_empty() || v == UNAVAILABLE_LITERAL || v == "<none>" {
        None
    } else {
        Some(v.to_string())
    }
}

/// 解析单行 `Key: Value` → (key, value);失败返 None。
fn split_kv(line: &str) -> Option<(&str, &str)> {
    let (k, v) = line.split_once(':')?;
    Some((k.trim(), v.trim()))
}

/// 解析 `Auth state: <label>` 中的 label 部分。
fn parse_state_label(label: &str) -> Result<AuthState> {
    let s = label.trim();
    if s == "logged out" {
        return Ok(AuthState::LoggedOut);
    }
    if s == "logged in" {
        return Ok(AuthState::LoggedIn);
    }
    if s == "credentials expired (refresh token expired)" {
        return Ok(AuthState::RefreshExpired);
    }
    // 上游格式:"error (<msg>)" — 抽出括号内文本作为 message
    if let Some(rest) = s.strip_prefix("error (") {
        if let Some(msg) = rest.strip_suffix(')') {
            return Ok(AuthState::Error {
                message: msg.to_string(),
            });
        }
    }
    Err(AppError::Other(format!(
        "无法识别 Auth state 字面: '{s}'(上游 schema 漂移?)"
    )))
}

/// 解析 Orgs 缩进行:`  - <slug> (<name>) [<id>] role=<role>` 形态。
/// 任一占位符 `<unknown-id>` / `<unknown-slug>` / `<unknown-name>` / `<unknown-role>` 视为 None。
fn parse_org_line(line: &str) -> Option<OrgEntry> {
    let s = line.trim().strip_prefix("- ")?;
    // 期望格式:`<slug> (<name>) [<id>] role=<role>`
    // 用从左到右的渐进切分,容忍 slug / name 内含括号(罕见但要 robust)。
    // 先尝试找最后一个 ' role=' — 之前部分是 `<slug> (<name>) [<id>]`
    let (head, role_raw) = s.rsplit_once(" role=")?;
    let role = unwrap_unknown(role_raw, "<unknown-role>");

    // 然后从 head 切出 `<id>`:最后一对 `[ ... ]`
    let (rest, id_raw) = head.rsplit_once('[')?;
    let id_raw = id_raw.strip_suffix(']')?;
    let org_id = unwrap_unknown(id_raw, "<unknown-id>");

    // 剩下应是 `<slug> (<name>) `,trim 尾空格,然后切 ` (` 与 `)`
    let rest = rest.trim_end();
    let (slug_raw, name_paren) = rest.rsplit_once(" (")?;
    let name_raw = name_paren.strip_suffix(')')?;
    let org_slug = unwrap_unknown(slug_raw.trim(), "<unknown-slug>");
    let org_name = unwrap_unknown(name_raw.trim(), "<unknown-name>");

    Some(OrgEntry {
        org_id,
        org_slug,
        org_name,
        role,
    })
}

fn unwrap_unknown(raw: &str, placeholder: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed == placeholder || trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 把 git-ai whoami stdout 文本解析为 [`WhoamiPayload`]。
///
/// 容忍未来上游加新字段(忽略未识别行),但 `API Base URL` / `Credential backend` / `Auth state`
/// 三个必有字段缺失时 fail-fast(说明上游 schema 彻底变了)。
pub fn parse_whoami(stdout: &str) -> Result<WhoamiPayload> {
    let mut api_base_url: Option<String> = None;
    let mut backend: Option<String> = None;
    let mut api_key_masked: Option<String> = None;
    let mut state: Option<AuthState> = None;
    let mut access_token_expires_at: Option<String> = None;
    let mut refresh_token_expires_at: Option<String> = None;
    let mut user_id: Option<String> = None;
    let mut email: Option<String> = None;
    let mut name: Option<String> = None;
    let mut personal_org_id: Option<String> = None;
    let mut orgs: Vec<OrgEntry> = Vec::new();
    let mut in_orgs_section = false;

    for raw_line in stdout.lines() {
        // Orgs 段:已进入 + 缩进开头 `  - ...`
        if in_orgs_section && raw_line.starts_with("  - ") {
            if let Some(entry) = parse_org_line(raw_line) {
                orgs.push(entry);
            }
            continue;
        }
        // 离开 orgs 段(遇到非缩进行)
        if in_orgs_section && !raw_line.starts_with("  ") {
            in_orgs_section = false;
        }
        let Some((key, value)) = split_kv(raw_line) else {
            continue;
        };
        match key {
            "API Base URL" => api_base_url = Some(value.to_string()),
            "Credential backend" => backend = Some(value.to_string()),
            "API key" => api_key_masked = to_optional(value),
            "Auth state" => state = Some(parse_state_label(value)?),
            "Access token expires at" => access_token_expires_at = to_optional(value),
            "Refresh token expires at" => refresh_token_expires_at = to_optional(value),
            "User ID" => user_id = to_optional(value),
            "Email" => email = to_optional(value),
            "Name" => name = to_optional(value),
            "Personal org ID" => personal_org_id = to_optional(value),
            "Organizations" => {
                // `Organizations: <none>` → 空集;`Organizations:`(value 空) → 接下来是缩进段
                if value == "<none>" {
                    // 空集,不进 section
                } else if value.is_empty() {
                    in_orgs_section = true;
                }
                // 其它非预期值忽略
            }
            _ => {} // 未识别行静默跳过(forward-compat)
        }
    }

    Ok(WhoamiPayload {
        api_base_url: api_base_url
            .ok_or_else(|| AppError::Other("whoami 缺失 'API Base URL' 行".into()))?,
        backend: backend
            .ok_or_else(|| AppError::Other("whoami 缺失 'Credential backend' 行".into()))?,
        api_key_masked,
        state: state.ok_or_else(|| AppError::Other("whoami 缺失 'Auth state' 行".into()))?,
        access_token_expires_at,
        refresh_token_expires_at,
        user_id,
        email,
        name,
        personal_org_id,
        orgs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_logged_out() {
        let stdout = "\
API Base URL: https://api.usegitai.com
Credential backend: keyring
Auth state: logged out
User ID: <unavailable>
Email: <unavailable>
Name: <unavailable>
Personal org ID: <unavailable>
Organizations: <none>
";
        let p = parse_whoami(stdout).unwrap();
        assert_eq!(p.api_base_url, "https://api.usegitai.com");
        assert_eq!(p.backend, "keyring");
        assert_eq!(p.state, AuthState::LoggedOut);
        assert_eq!(p.email, None);
        assert_eq!(p.orgs.len(), 0);
        assert!(p.api_key_masked.is_none());
    }

    #[test]
    fn parses_logged_in_with_orgs() {
        let stdout = "\
API Base URL: https://api.usegitai.com
Credential backend: keyring
Auth state: logged in
Access token expires at: 2026-05-13 14:00:00 UTC
Refresh token expires at: 2026-06-13 14:00:00 UTC
User ID: u_abc123
Email: alice@example.com
Name: Alice
Personal org ID: o_personal
Organizations:
  - acme (Acme Inc) [o_acme] role=admin
  - widgets (Widget Co) [o_widgets] role=member
";
        let p = parse_whoami(stdout).unwrap();
        assert_eq!(p.state, AuthState::LoggedIn);
        assert_eq!(p.email.as_deref(), Some("alice@example.com"));
        assert_eq!(p.name.as_deref(), Some("Alice"));
        assert_eq!(p.user_id.as_deref(), Some("u_abc123"));
        assert_eq!(
            p.access_token_expires_at.as_deref(),
            Some("2026-05-13 14:00:00 UTC")
        );
        assert_eq!(p.orgs.len(), 2);
        assert_eq!(p.orgs[0].org_slug.as_deref(), Some("acme"));
        assert_eq!(p.orgs[0].org_name.as_deref(), Some("Acme Inc"));
        assert_eq!(p.orgs[0].org_id.as_deref(), Some("o_acme"));
        assert_eq!(p.orgs[0].role.as_deref(), Some("admin"));
        assert_eq!(p.orgs[1].org_slug.as_deref(), Some("widgets"));
    }

    #[test]
    fn parses_api_key_mode() {
        let stdout = "\
API Base URL: https://api.usegitai.com
Credential backend: env
API key: abcd...wxyz
Auth state: logged in
User ID: <unavailable>
Email: <unavailable>
Name: <unavailable>
Personal org ID: <unavailable>
Organizations: <none>
";
        let p = parse_whoami(stdout).unwrap();
        assert_eq!(p.api_key_masked.as_deref(), Some("abcd...wxyz"));
        assert_eq!(p.state, AuthState::LoggedIn);
    }

    #[test]
    fn parses_refresh_expired_state() {
        let stdout = "\
API Base URL: https://api.usegitai.com
Credential backend: keyring
Auth state: credentials expired (refresh token expired)
User ID: u_abc
Email: alice@example.com
Name: <unavailable>
Personal org ID: <unavailable>
Organizations: <none>
";
        let p = parse_whoami(stdout).unwrap();
        assert_eq!(p.state, AuthState::RefreshExpired);
        assert_eq!(p.email.as_deref(), Some("alice@example.com"));
    }

    #[test]
    fn parses_error_state_with_message() {
        let stdout = "\
API Base URL: https://api.usegitai.com
Credential backend: keyring
Auth state: error (network unreachable)
User ID: <unavailable>
Email: <unavailable>
Name: <unavailable>
Personal org ID: <unavailable>
Organizations: <none>
";
        let p = parse_whoami(stdout).unwrap();
        match p.state {
            AuthState::Error { message } => assert_eq!(message, "network unreachable"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn fails_when_required_field_missing() {
        // 缺 API Base URL
        let stdout = "Credential backend: keyring\nAuth state: logged out\n";
        let err = parse_whoami(stdout).unwrap_err();
        assert!(err.to_string().contains("API Base URL"));
    }

    #[test]
    fn fails_on_unknown_auth_state_label() {
        // no-fallback:未知 Auth state 字面值直接报错,不静默 fallback
        let stdout = "\
API Base URL: https://api.usegitai.com
Credential backend: keyring
Auth state: somehow_logged_in
";
        let err = parse_whoami(stdout).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("auth state"));
    }

    #[test]
    fn orgs_with_unknown_placeholders_resolve_to_none() {
        let stdout = "\
API Base URL: x
Credential backend: y
Auth state: logged in
Organizations:
  - <unknown-slug> (<unknown-name>) [<unknown-id>] role=<unknown-role>
";
        let p = parse_whoami(stdout).unwrap();
        assert_eq!(p.orgs.len(), 1);
        assert!(p.orgs[0].org_slug.is_none());
        assert!(p.orgs[0].org_name.is_none());
        assert!(p.orgs[0].org_id.is_none());
        assert!(p.orgs[0].role.is_none());
    }

    #[test]
    fn unknown_lines_ignored_for_forward_compat() {
        // 模拟上游加了新字段 — 旧 studio 不应炸,只是忽略
        let stdout = "\
API Base URL: x
Credential backend: y
Auth state: logged out
Future Field: future_value
User ID: <unavailable>
Email: <unavailable>
Name: <unavailable>
Personal org ID: <unavailable>
Organizations: <none>
";
        let p = parse_whoami(stdout).unwrap();
        assert_eq!(p.api_base_url, "x");
    }
}
