//! 修正 GUI 进程的 PATH。
//!
//! 从 Finder/Dock(macOS)、资源管理器(Windows)启动的应用,只继承一份"最小 PATH":
//! - macOS:launchd 给的 `/usr/bin:/bin:/usr/sbin:/sbin` + `/etc/paths`,**不会 source**
//!   `~/.zshrc`/`~/.zprofile`。于是 nvm(`~/.nvm/...`)、Apple Silicon 的 Homebrew
//!   (`/opt/homebrew/bin`)、fnm、volta 装的 node/npm/claude/codex 全部不在 PATH 里,
//!   `which` 怎么查都查不到。这也是"`tauri:dev` 能测到、打包后从 Finder 起就测不到"的根因
//!   ——dev 从终端起,继承了终端 PATH。
//! - Windows:进程拿的是启动那一刻的 PATH 快照;若 Node 在 App 启动后才装、或开机自启
//!   早于 PATH 生效,进程内 PATH 是旧的,"重新检测"按钮读的还是同一份进程 PATH,无效。
//!
//! # 实现:进程内 PATH 镜像,运行期不改全局环境
//! 启动 [`ensure_patched`] 从**权威来源**(unix 登录 shell / Windows 注册表)探测真实 PATH
//! 写入镜像 [`REAL_PATH`],并**仅此一次**、在 tokio 多线程起来前、单线程下 `set_var` 到进程
//! 环境(让未走镜像的 `which::which` / 子进程也受益)。运行期 [`refresh`](用户点"重新检测")
//! **只更新镜像、不再 `set_var`**,从而避免与并发 getenv 的数据竞争(Rust 2024 已将 set_var
//! 标 unsafe;启动那一次单线程调用是安全的)。探测/安装路径统一通过 [`real_path`] 读镜像:
//! [`which_in_real_path`] 解析可执行文件,子进程 spawn 时显式注入 `PATH` env。
//!
//! 这不是 CLAUDE.md 禁止的"掩盖失败的 fallback":它修正的是被 OS 截断的环境;探测失败时
//! [`refresh`] 返回 Err,由命令层翻成红 toast 响亮上报,不静默粉饰。

use std::path::PathBuf;
use std::sync::{Once, RwLock};
use std::time::Duration;

use once_cell::sync::Lazy;

/// 进程内"真实 PATH"镜像。初始化为继承的进程 PATH;[`ensure_patched`]/[`refresh`] 更新它。
static REAL_PATH: Lazy<RwLock<String>> =
    Lazy::new(|| RwLock::new(std::env::var("PATH").unwrap_or_default()));

static PATCHED: Once = Once::new();

/// Windows PATH 分隔符(注册表系统/用户 PATH 合并用)。
#[cfg(windows)]
const SEP: &str = ";";

/// 启动时调一次(幂等)。探测真实 PATH 写入镜像,并在多线程起来前 `set_var` 一次到进程环境。
pub fn ensure_patched() {
    PATCHED.call_once(|| {
        // 继承的 PATH 已能解析 npm → 环境完好(终端启动 / 配置良好的桌面环境),跳过昂贵的
        // 登录 shell fork(约 100-500ms)。GUI 启动缺 PATH 时 which 失败,照常往下探测。
        if which::which("npm").is_ok() {
            return;
        }
        let current = std::env::var("PATH").unwrap_or_default();
        let Some(authoritative) = detect_authoritative_path() else {
            log::warn!("启动时无法解析登录环境真实 PATH,沿用继承的 PATH");
            return;
        };
        let merged = merge_paths(&current, &authoritative);
        if merged != current {
            if let Ok(mut g) = REAL_PATH.write() {
                *g = merged.clone();
            }
            // 启动早期、tokio 多线程起来前、单线程:set_var 安全。让未走 real_path() 的
            // which::which / 子进程 spawn(git/git-ai 等)也继承修正后的 PATH。
            std::env::set_var("PATH", merged);
        }
    });
}

/// 运行期重读真实 PATH 并更新镜像。供前端"重新检测"调用,使运行期才装的 Node 不重启即可识别
/// (Windows 重读注册表 live PATH,绕开进程旧快照)。**不**碰全局环境 → 无并发数据竞争。
/// 探测失败(shell 超时/异常、注册表读不到)返回 Err,由命令层翻成红 toast(响亮失败)。
pub fn refresh() -> Result<(), String> {
    let authoritative = detect_authoritative_path().ok_or_else(|| {
        "无法读取登录环境的真实 PATH(shell 超时或配置异常),请检查 shell 启动脚本".to_string()
    })?;
    let merged = merge_paths(&real_path(), &authoritative);
    if let Ok(mut g) = REAL_PATH.write() {
        *g = merged;
    }
    Ok(())
}

/// 读进程内真实 PATH 镜像。
pub fn real_path() -> String {
    REAL_PATH
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| std::env::var("PATH").unwrap_or_default())
}

/// 用真实 PATH 镜像解析可执行文件(替代裸 `which::which`)。运行期 [`refresh`] 更新镜像后
/// 立即生效,无需依赖全局 `set_var`。
pub fn which_in_real_path(bin: &str) -> Option<PathBuf> {
    // cwd 仅影响含路径分隔的相对名;"npm"/"claude" 等纯名走 PATH,cwd 实际无关,兜底即可。
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    which::which_in(bin, Some(real_path()), cwd).ok()
}

/// 合并两份 PATH:`authoritative`(登录环境里 active 的 node 版本)在前,再追加 `current`
/// 里独有的条目;去重、保序、滤空。用标准库 [`std::env::split_paths`]/[`std::env::join_paths`]
/// 切分回拼,正确处理 Windows 带引号、内含分隔符的条目(自研字符串 split 做不到)。纯函数,可单测。
fn merge_paths(current: &str, authoritative: &str) -> String {
    use std::collections::HashSet;
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut out: Vec<PathBuf> = Vec::new();
    for p in std::env::split_paths(authoritative).chain(std::env::split_paths(current)) {
        if p.as_os_str().is_empty() {
            continue;
        }
        if seen.insert(p.clone()) {
            out.push(p);
        }
    }
    // 经 split_paths 切出的条目本就不含未引用分隔符,join_paths 不会失败;万一失败(病态输入)
    // 则保持 current 不变,不破坏现有 PATH。
    std::env::join_paths(&out)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|_| current.to_string())
}

/// 判断 shell 可执行名是否 POSIX 兼容(支持 `-ilc` + POSIX `printf` 语法)。纯函数,可单测。
#[cfg(not(windows))]
fn is_posix_shell(name: &str) -> bool {
    matches!(name, "sh" | "bash" | "zsh" | "dash" | "ksh" | "ash")
}

/// 选一个用于探测 PATH 的 POSIX shell:`$SHELL` 若是 POSIX 兼容则用它;否则(fish/csh/tcsh/
/// nu 等非 POSIX shell,`-ilc` + `printf "$PATH"` 语义不同会拿到错误输出)回退到首个可用的
/// POSIX shell。回退 shell 不 source 用户的非 POSIX rc,但仍能拿到 `/etc/profile` + 登录
/// profile,比直接放弃强(对齐 shell-env 的回退策略)。
#[cfg(not(windows))]
fn posix_shell() -> Option<String> {
    use std::path::Path;
    if let Ok(shell) = std::env::var("SHELL") {
        if Path::new(&shell)
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(is_posix_shell)
        {
            return Some(shell);
        }
    }
    ["/bin/zsh", "/bin/bash", "/bin/sh"]
        .into_iter()
        .find(|p| Path::new(p).exists())
        .map(String::from)
}

/// unix:跑用户登录 shell 拿真实 PATH。
///
/// `-i` 交互(确保只写在 `~/.zshrc`/`~/.bashrc` 而非 `~/.zprofile` 的 nvm/fnm 也被 source)、
/// `-l` 登录、`-c` 执行——`-ilc` 是 fix-path-env / shell-env / VS Code 的业界惯例。用哨兵
/// 包裹 `$PATH`,规避 rc 向 stdout 打印的杂讯(MOTD/echo)。stdin 断开 + `DISABLE_AUTO_UPDATE`
/// 防交互 shell 等输入/自动更新而挂起;3s 超时到点 kill 子进程,避免孤儿 shell 累积。
#[cfg(not(windows))]
fn detect_authoritative_path() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let shell = posix_shell()?;
    let mut child = Command::new(&shell)
        .args(["-ilc", "printf '__GAS_PATH__%s__GAS_END__' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("DISABLE_AUTO_UPDATE", "true")
        .current_dir(dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")))
        .spawn()
        .ok()?;

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if start.elapsed() >= Duration::from_secs(3) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    // printf 输出仅几百字节,远小于管道缓冲,子进程不会因未读 stdout 而阻塞;故结束后再读。
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    extract_sentinel(&out)
}

/// 从 `__GAS_PATH__...__GAS_END__` 之间抠出 PATH。纯函数,可单测。
#[cfg(not(windows))]
fn extract_sentinel(s: &str) -> Option<String> {
    let inner = s
        .split_once("__GAS_PATH__")?
        .1
        .split_once("__GAS_END__")?
        .0
        .trim();
    (!inner.is_empty()).then(|| inner.to_string())
}

/// windows:从注册表读 live PATH(系统级 + 用户级合并),绕开进程的旧 PATH 快照。
#[cfg(windows)]
fn detect_authoritative_path() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let mut parts: Vec<String> = Vec::new();
    if let Ok(sys) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
    {
        if let Ok(p) = sys.get_value::<String, _>("Path") {
            parts.push(expand_env(&p));
        }
    }
    if let Ok(usr) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Environment") {
        if let Ok(p) = usr.get_value::<String, _>("Path") {
            parts.push(expand_env(&p));
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(SEP))
    }
}

/// 展开 `%VAR%`:注册表 Path 多为 `REG_EXPAND_SZ`,winreg 取出的是未展开原串,需手动
/// 展开(常见 `%APPDATA%\npm`、nvm-windows 的 `%NVM_SYMLINK%`、`%SystemRoot%` 等)。
/// 未匹配到环境变量的 `%...%` 原样保留(与 Win32 ExpandEnvironmentStrings 行为一致)。纯函数,可单测。
#[cfg(windows)]
fn expand_env(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn merge_puts_authoritative_first_then_unique_current() {
        let merged = merge_paths("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin");
        let got: Vec<_> = std::env::split_paths(&merged).collect();
        assert_eq!(
            got,
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
            ]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn merge_dedups_and_drops_empty_entries() {
        let merged = merge_paths("/bin::/usr/bin:/bin", "/usr/bin:");
        let got: Vec<_> = std::env::split_paths(&merged).collect();
        assert_eq!(got, vec![PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
    }

    #[cfg(not(windows))]
    #[test]
    fn merge_empty_authoritative_keeps_current() {
        let merged = merge_paths("/usr/bin:/bin", "");
        let got: Vec<_> = std::env::split_paths(&merged).collect();
        assert_eq!(got, vec![PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
    }

    #[cfg(not(windows))]
    #[test]
    fn is_posix_shell_classifies_known_and_unknown() {
        for ok in ["sh", "bash", "zsh", "dash", "ksh", "ash"] {
            assert!(is_posix_shell(ok), "{ok} 应判为 POSIX");
        }
        for no in ["fish", "tcsh", "csh", "nu", "elvish", "pwsh"] {
            assert!(!is_posix_shell(no), "{no} 应判为非 POSIX");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn extract_sentinel_pulls_path_out_of_noisy_stdout() {
        let stdout = "welcome MOTD\n__GAS_PATH__/opt/homebrew/bin:/usr/bin__GAS_END__\n";
        assert_eq!(
            extract_sentinel(stdout).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn extract_sentinel_none_when_marker_missing_or_empty() {
        assert_eq!(extract_sentinel("no markers here"), None);
        assert_eq!(extract_sentinel("__GAS_PATH____GAS_END__"), None);
    }

    #[cfg(windows)]
    #[test]
    fn expand_env_substitutes_known_and_preserves_unknown() {
        std::env::set_var("GAS_TEST_VAR", r"C:\node");
        assert_eq!(expand_env(r"%GAS_TEST_VAR%\npm"), r"C:\node\npm");
        assert_eq!(
            expand_env(r"%GAS_DEFINITELY_MISSING%\x"),
            r"%GAS_DEFINITELY_MISSING%\x"
        );
        assert_eq!(expand_env(r"C:\plain\path"), r"C:\plain\path");
    }
}
