# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and human contributors when working with code in this repository.

## 项目定位

`git-ai-studio` 是 Tauri v2 桌面应用(前端 React 19 + TypeScript,后端 Rust),作为**外部 `git-ai` CLI 的本地客户端**:环境诊断、git-ai 安装/升级、官方 hook 配置、本地 AI 代码归因可视化(Dashboard / Stats / People / Blame / Checkpoints / Notes)、应用与诊断日志(Logs:应用日志 + `git-ai debug` 诊断)。

- **所有解析在本机完成,零数据上传,零 telemetry,零 crash reporter**;唯一的自动外网调用是启动约 1s 向 GitHub 查 `latest.json` 的版本检查(仅版本号,见 ADR-010,产品定位 lock 在 `docs/product/PR-FAQ.md`)
- **三平台齐发**:macOS + Linux + Windows
- **双语 UI**:中文 + 英文(i18next)
- **MIT 开源**,GitHub repo 是唯一发布渠道

## 重要文档(动手前先扫一眼)

- [`docs/product/PR-FAQ.md`](docs/product/PR-FAQ.md) —— 产品定位、FAQ、风险。任何砍/留决策的最终依据
- [`docs/adr/`](docs/adr/) —— 10 个 ADR 锁定的架构决定(router 自研 / shadcn / Tailwind v4 / 不加 zod / CSS 动画 / updater 策略 / 三平台打包 / Conventional Commits / CI matrix / 应用内自更新)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) —— 贡献流程 / commit 规范 / PR 模板
- [`README.md`](README.md) / [`README.zh-CN.md`](README.zh-CN.md) —— 对外门面

## 常用命令

- `pnpm dev` —— 仅前端 Vite。`pnpm tauri:dev` —— 完整应用(Rust + webview)
- `pnpm build` —— `tsc && vite build`(前端)。`pnpm tauri build` —— 默认按 `tauri.conf.json` 的 `bundle.targets` 出当前 OS 能出的所有目标(macOS: app/dmg;Linux: appimage/deb;Windows: msi)
- `pnpm test` —— vitest 全量。单文件:`pnpm vitest run src/__tests__/foo.test.ts`。按名:`pnpm vitest run -t "子串"`
- `pnpm typecheck` / `pnpm lint`(eslint,`--max-warnings=0`)/ `pnpm format:check`
- Rust:`pnpm rs:test`(或 `cargo test --manifest-path src-tauri/Cargo.toml <过滤词>`)、`pnpm rs:clippy`、`pnpm rs:fmt`
- `pnpm check` —— typecheck + lint + format:check + rs:fmt + rs:clippy 全量门禁(CI 跑这一行)

注意:前端 lint 基线带几条存量警告;判定标准是**不新增**警告,而非期望 `pnpm lint` 全绿。

## 架构

**前后端边界。** 每个 Tauri command 都在 `src/lib/api.ts` 用统一的 `call<T>()` 封装;UI 不直接调 `invoke`。command 在 `src-tauri/src/lib.rs` 的 `invoke_handler!` 注册,实现在 `src-tauri/src/commands/*`。共享 TS 类型在 `src/lib/types.ts`,UI 文案在 `src/i18n/locales/{zh-CN,en}.json`(i18next),组件内用 `useTranslation()` 取键。数据请求用 `@tanstack/react-query`;路由是自研 hash router(`src/router.tsx`,见 ADR-001);toast 用 `sonner`。

**git-ai 是外部 CLI,不是链接库。** 后端把 `git-ai stats|status|blame-analysis|...` 作为子进程执行(`src-tauri/src/proc.rs`),所有调用都带 `--json`,再用 `serde` 反序列化(`src-tauri/src/git_ai/*`)。**git-ai 上游源码是 schema/指标/阈值的唯一权威**:https://github.com/git-ai-project/git-ai 。代码注释里引用上游用 `git-ai/<rel-path>:<line>` 写法。不得用二手项目反推 git-ai 语义;可联网查官方文档,但源码是最终权威。

**跨平台子进程与开机自启。** Windows 下任何在 `proc.rs` **之外**起的子进程必须打 `CREATE_NO_WINDOW`:std Command 用 `crate::proc::apply_no_window_std`,tokio Command 用 `apply_no_window_tokio`,否则 release 下会闪黑色控制台窗口。开机自启用 `auto-launch` crate(`src-tauri/src/auto_launch.rs`):macOS = LaunchAgent / Linux = XDG `~/.config/autostart/*.desktop` / Windows = `schtasks /SC ONLOGON`。**hook 一律走上游 `git ai install-hooks`**(自研 hook-server 已删,不要回退)。

**stats 缓存与失效。** 单 commit 的 `git-ai stats` 结果缓存在 SQLite(`src-tauri/src/db` 的 `stats_cache`),失效模型两维:该 commit 的 git-notes OID + `.git-ai-ignore` 哈希。`commands/history.rs` 是聚合的权威路径,`commands/people.rs` 是它的有意简化版;Dashboard / People / History 共用同一份缓存与失效逻辑。

**范围聚合(hook 覆盖率)解耦 + 缓存。** hook 覆盖率走 `git-ai stats <oldest^>..<newest> --json`(上游对整段做逐行 blame,大/长历史仓库固有 50s+,无缓存),曾内联在 `get_history` 里且失败 `return Err` 拖垮整页。现已摘成**独立命令 `get_range_summary`**(`commands/history.rs`,窗口推导与 get_history 共用 `derive_range_window`),用独立的 `RANGE_STATS_TIMEOUT`(180s,`git_ai/stats.rs`,单 commit 仍 15s),前端 Dashboard 用**独立 react-query** 驱动覆盖率卡(loading/error/重试只影响该卡,主体即时渲染)。结果缓存在 `range_summary_cache` 表(`db/stats_cache.rs` 的 `mod range`),失效键 = (start_sha, end_sha) + `refs/notes/ai` ref OID(`git_ai/notes.rs::read_notes_ref_oid`)+ `.git-ai-ignore` 哈希;`clear_stats_cache` 同时清两张表。

**degraded 与 error 二分。** 预期内的空态(未选仓库、git-ai 未装、无 HEAD 等)返回 `Ok(Degraded { reason })`,前端渲染空态卡;真实失败返回 `Err(String)` → 红 toast。新增 command 时保持这个划分。

**禁止 fallback / 兼容代码。** 失败就响亮地失败。绝不用零桶默认值或静默兜底掩盖失败的子进程(HTTP 304、空的初始文件这类标准/初始态不算 "fallback")。坏 JSON 必须报错,不得 default。**失败不要藏在 payload 子字段**;命令级故障统一 `Err(String)`,字符串用 `classify_*_error()` 翻译为"原因 + 建议",前端 `call<T>` 弹红 toast。

**后台监控(opt-in 推送)。** 两个 watcher 挂在 App 顶层:`LowAiShareWatcher`(15min 聚合)、`DaemonWatcher`(30s 探测 + 连续 2 次同 issue 才推)。各自有独立总开关(`notifications.low_ai_share.enabled` / `notifications.daemon_unhealthy_alert`),关 → useQuery `enabled=false` 完全不查;**全部 `refetchIntervalInBackground: true`** —— Studio 的典型用法是"开机自启 + 关闭=最小化到托盘",窗口隐藏后 watcher 必须继续轮询。推送出口走可配置 webhook(用户自填 URL,Slack / Discord / Feishu 等通用兼容),用户没配 = 默认全关。

**daemon 健康探测。** `git_ai/daemon.rs::detect_daemon_health` 有 **300ms 重读防抖**:首次 pid.json 失活后等 300ms 再读一次,规避 daemon 重启窗口期(旧 PID 已死 / 新 daemon 启动但 pid.json 还没写完)。`repair_daemon_lock` 遇到 `before = Idle | Running` 视为"已自愈",返 `Ok(no-op)` 而非 `Err`,让 UI 展示"虚惊一场"而不是"修复失败"推送。前端 `DaemonWatcher` 还要求"连续 2 次同一 issueKey"才推 webhook,与后端防抖叠加。

**设置持久化。** `AppSettings` 持久化到 `~/.git-ai-studio/config.json`,带就地迁移路径;patch API(`commands/settings.rs`)刻意扁平,而存储结构是嵌套的。OS 集成态(如开机自启)实时读 OS,不在 config 里另存一份。

**应用内自更新(默认开)。** `tauri-plugin-updater` + `tauri-plugin-process`,启动约 1s 自动查 GitHub `latest.json`(仅版本号),有新版在关于页 / TopBar Badge 提示,一键 `downloadAndInstall` + relaunch;minisign 验签;关:`plugins.updater.active=false`。见 ADR-010(supersedes ADR-006)。

## 约定

- **代码注释必须中文,禁止无用注释。** 见名知义的代码不加废话注释;注释只说"是什么 / 为什么这样",不解释"不包含什么 / 已删除什么"。确定已过时且未被使用的功能/代码直接删除,不保留
- **双语 UI(i18next)。** 文案不能硬编码在组件;所有面向用户的字符串走 `src/i18n/locales/{zh-CN,en}.json`,组件用 `useTranslation()` 取键。新增字符串必须同时给 zh-CN + en 两版,en 版要"自然 + 准确技术词",不要直译
- **回答必须基于事实,禁止欺骗性/迎合性回答。** 不确定就查上游源码 / 联网查官方文档 / 问用户
- **Conventional Commits 不可商量**(`feat:` / `fix:` / `docs:` / `refactor:` / `perf:` / `test:` / `build:` / `chore:`)。详见 `CONTRIBUTING.md`
- **架构性改动写 ADR**。`docs/adr/000X-*.md`,Michael Nygard 风格(Context / Options / Decision / Consequences),至少 cite 1 个 peer project 作 evidence
- 前端 `src/__tests__/*.contract.test.ts` 是契约测试,断言 `api.ts` ↔ Rust 类型对齐;纯逻辑模块有独立单测。Rust 模块单测内联(`#[cfg(test)]`),含对齐上游 JSON fixture 的纯解析函数测试
- CodeMirror(`src/components/BlameCodeView.tsx`)在 flex 容器里高、宽都要显式钉死(`className="h-full w-full"` + theme `"&"` 的 width/height);`@uiw/react-codemirror` 的 props 单独到不了 wrapper

## 与上游 `usegitai.com` 的关系

`git-ai-studio` 是**独立 OSS 项目,未与 Git AI 商业团队 affiliate**。我们只消费开源的 `git-ai` CLI 和公开的 `refs/notes/ai` 标准 —— 没有私有 API,没有 license key,没有共享基础设施。

- Git AI Teams / Cloud(usegitai.com)= 组织级 SaaS dashboard,卖给 VP Engineering,云端/自托管,per-seat 计费
- git-ai-studio = 单开发者本机桌面客户端,无账号,无云,看自己的仓库

**如果上游发布官方桌面 GUI,我们会重新评估 scope(可能合并或日落)**。这一段写在 `docs/product/PR-FAQ.md` FAQ #6,不要在代码里写实现层假设它不会发生。
