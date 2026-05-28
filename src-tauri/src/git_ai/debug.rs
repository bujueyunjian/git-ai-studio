//! 解析 `git-ai debug report` 文本输出为结构化 6 段。
//!
//! 原始格式(见 `Git-ai 问题分析步骤.md` 第 1 步):
//! ```text
//! Generated (UTC): ...
//!
//! == Versions ==
//! Git AI version: 0.x.x
//! ...
//!
//! == Platform ==
//! OS family: unix
//! ...
//! ```

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugReportSection {
    pub name: String,
    pub raw: String,
    pub entries: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugReport {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_ai_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    pub sections: Vec<DebugReportSection>,
    pub raw: String,
}

impl DebugReport {
    pub fn empty() -> Self {
        Self {
            ok: false,
            git_ai_version: None,
            generated_at: None,
            sections: vec![],
            raw: String::new(),
        }
    }
}

/// 把 `git-ai debug report` 的 stdout 解析为结构化 DebugReport。
/// 解析失败时仍返回 ok=true + 至少一个 "Raw" section,不丢内容。
pub fn parse_debug_report(raw: &str) -> DebugReport {
    let header_re = Regex::new(r"^==\s*(.+?)\s*==\s*$").expect("regex compile");
    let mut sections: Vec<DebugReportSection> = Vec::new();
    let mut cur_name: Option<String> = None;
    let mut cur_body = String::new();
    let mut generated_at: Option<String> = None;

    for line in raw.lines() {
        if generated_at.is_none() {
            if let Some(rest) = line.strip_prefix("Generated (UTC):") {
                generated_at = Some(rest.trim().to_string());
                continue;
            }
        }
        if let Some(c) = header_re.captures(line) {
            if let Some(name) = cur_name.take() {
                sections.push(finalize_section(name, std::mem::take(&mut cur_body)));
            }
            cur_name = Some(c[1].to_string());
        } else if cur_name.is_some() {
            cur_body.push_str(line);
            cur_body.push('\n');
        }
    }
    if let Some(name) = cur_name.take() {
        sections.push(finalize_section(name, cur_body));
    }

    let git_ai_version = sections
        .iter()
        .find(|s| s.name.eq_ignore_ascii_case("Versions"))
        .and_then(|s| {
            s.entries
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("Git AI version"))
                .map(|(_, v)| v.clone())
        });

    DebugReport {
        ok: true,
        git_ai_version,
        generated_at,
        sections,
        raw: raw.to_string(),
    }
}

fn finalize_section(name: String, body: String) -> DebugReportSection {
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for line in body.lines() {
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim();
            // 跳过纯命令注释行(以 `#` 开头的描述)
            if !key.is_empty() && !key.starts_with('#') {
                let entry_key = key.to_string();
                if !map.contains_key(&entry_key) {
                    order.push(entry_key.clone());
                }
                map.insert(entry_key, v.trim().to_string());
            }
        }
    }
    let entries: Vec<(String, String)> = order
        .into_iter()
        .filter_map(|k| map.get(&k).map(|v| (k.clone(), v.clone())))
        .collect();
    DebugReportSection {
        name,
        raw: body,
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"Generated (UTC): 2026-04-29T10:30:00+00:00

== Versions ==
Git AI version: 1.3.4
Git AI binary: C:\Users\u\.git-ai\bin\git-ai.exe
Git binary path: C:\Program Files\Git\cmd\git.exe
Git version: git version 2.45.0.windows.1

== Platform ==
OS family: windows
OS: windows

== Git AI Login ==
Credential backend: keyring
Status: logged in
"#;

    #[test]
    fn parses_three_sections() {
        let r = parse_debug_report(SAMPLE);
        assert_eq!(r.sections.len(), 3);
        assert_eq!(r.sections[0].name, "Versions");
        assert_eq!(r.git_ai_version.as_deref(), Some("1.3.4"));
        assert_eq!(r.generated_at.as_deref(), Some("2026-04-29T10:30:00+00:00"));
    }

    #[test]
    fn empty_input_yields_no_sections() {
        let r = parse_debug_report("");
        assert_eq!(r.sections.len(), 0);
        assert!(r.git_ai_version.is_none());
    }

    #[test]
    fn missing_section_header_drops_preamble() {
        let r = parse_debug_report("just garbage\nno headers\n");
        assert_eq!(r.sections.len(), 0);
    }

    #[test]
    fn handles_colon_in_values() {
        let r = parse_debug_report(
            "== Versions ==\nGit binary path: C:\\Program Files\\Git\\cmd\\git.exe\n",
        );
        assert_eq!(
            r.sections[0].entries[0].1,
            "C:\\Program Files\\Git\\cmd\\git.exe"
        );
    }
}
