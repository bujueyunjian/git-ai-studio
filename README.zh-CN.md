<div align="center">

# git-ai-studio

**看清每一行代码，是 AI 写的还是你写的。**

为开发者打造的本地 AI 代码归因 dashboard —— 支持 macOS / Linux / Windows，免费、开源、零数据上传。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)
![Status](https://img.shields.io/badge/status-pre--alpha-orange)
[English](README.md)

</div>

---

## 这是什么

git-ai-studio 把你本机 git 历史中的 AI 归因数据,变成一个随手可看的桌面 dashboard。它读取 [`git-ai`](https://github.com/git-ai-project/git-ai) CLI 写到 `refs/notes/ai` 的归因 —— 每一次 Claude Code / Cursor / Codex / OpenCode 编辑都精确到行 —— 并用三个直观界面呈现:今天的 AI 占比、agent 昨晚改过哪些文件、`git blame` 中每一行按生成它的模型上色。

在此之前你要么相信厂商自己 IDE 内的 dashboard(只能看到自己工具的击键数),要么自己从 `git log` 拼 Excel。**git-ai-studio 给你看的是真正合入 `main` 的代码,全部在你本机解析 —— 唯一会发出的,是启动时向 GitHub 的一次版本号检查(无遥测、无账号、无 crash reporter)。**

完整的产品定位与 FAQ 见 [`docs/product/PR-FAQ.zh-CN.md`](docs/product/PR-FAQ.zh-CN.md)。

## 为什么是现在

- [Stack Overflow 2025 调查](https://survey.stackoverflow.co/2025/ai/)(n=49k):**51% 的专业开发者每天使用 AI 编程工具**
- [Sonar State of Code 2026](https://www.sonarsource.com/state-of-code-developer-survey-report.pdf):**生产代码中 AI 撰写占比 26.9%**,环比上季度 22% 持续上升
- 大多数团队同时用多个 agent(Claude Code + Cursor + Codex 是常见组合)—— 厂商专属 dashboard 只能看到自己工具的击键数
- `git-ai` 发布了 `refs/notes/ai` 的稳定 v3 spec,首次有了厂商无关的统一数据源

## 功能

- **Dashboard** —— 仓库整体 AI 占比、hook 覆盖率、近期 commit 概览
- **Stats** —— commit 详情 + 按 tool/model 维度拆分(Claude Sonnet / Cursor / Codex …)
- **People** —— 按作者 + 滑动窗口聚合 AI 贡献
- **Blame** —— 单文件逐行查看:谁写的、哪个模型、由哪段 prompt 生成
- **Checkpoints / Notes** —— 查看 AI agent 写入 `refs/notes/ai` 的原始 payload
- **Hooks / Diagnostic** —— 一键安装 `git-ai` 官方 hook;一屏诊断环境

所有解析在本机完成。无账号、无 telemetry、无 crash reporter —— 仅在启动时向 GitHub 做一次版本号检查(可通过 `plugins.updater.active=false` 关闭)。

## 快速开始

> Pre-alpha 阶段。发布二进制还未推出。当前从源码构建:

```bash
# 环境要求: Node 20+ / pnpm 9+ / Rust 1.80+ / 已装 git-ai CLI
pnpm install
pnpm tauri:dev
```

发布后通过 GitHub Releases 安装:

- **macOS**: 下载 `.dmg`,拖到 Applications
- **Linux**: 下载 `.AppImage`(通用)或 `.deb`(Debian / Ubuntu)
- **Windows**: 下载 `.msi` —— v1.0 未签名,需手动绕过 SmartScreen(代码签名计划在 v1.1)

打开后选一个有 `refs/notes/ai` 的仓库即可。如果仓库还没有 notes,按应用内 Hooks 引导为你的 agent 装上 `git-ai` 官方 hook,下一次 AI 辅助 commit 就会出现在 Dashboard。

## 当前状态

**Pre-alpha**。PR-FAQ 已锁定,重构进行中,首个公开 release(v0.1)进度见 [issues](../../issues)。v1.0 前必须完成 3 件事:

1. 3 个真实用户访谈,验证"日打开"假设(见 [PR-FAQ](docs/product/PR-FAQ.zh-CN.md))
2. 4 周本地 opt-in 使用计数器试用 readout(5 个朋友)
3. [`docs/adr/`](docs/adr/) 下的架构决定被 maintainer 接受

## 与 `usegitai.com` 的关系

git-ai-studio 是**独立的开源项目,与 Git AI 商业团队无 affiliate 关系**。我们只消费开源的 `git-ai` CLI 和公开的 `refs/notes/ai` 标准。[Git AI Teams / Cloud](https://usegitai.com) 是面向 VP Engineering 销售的组织级 SaaS dashboard;本项目是单开发者本机桌面客户端 —— 不同 surface、不同 buyer。如果上游发布官方桌面 GUI,我们会重新评估 scope(可能合并或日落)。完整说明见 [FAQ #6](docs/product/PR-FAQ.zh-CN.md)。

## 隐私

100% 本地解析。无账号、无 telemetry、无 crash reporter。唯一的自动外网调用,是启动约 1 秒后向 GitHub 做的一次版本号检查 —— 不发代码、不发仓库数据、不发个人信息,只发版本号,这样你就不会悄无声息地错过安全修复;若有新版可一键安装(经 minisign 验签)。这次检查可通过构建时设 `plugins.updater.active=false` 彻底关闭。其余外网调用都是你主动触发的:从 GitHub Releases 安装/升级 `git-ai`、把 `refs/notes/ai` 推到你自己的远端。完整理由见 [ADR-010](docs/adr/0010-in-app-auto-update.md)。

## 文档

- [`docs/product/PR-FAQ.zh-CN.md`](docs/product/PR-FAQ.zh-CN.md) —— 产品定位与 FAQ
- [`docs/adr/`](docs/adr/) —— 架构决定记录
- [`CLAUDE.md`](CLAUDE.md) —— 代码库约定(给 AI 编程助手和人类贡献者)

## 贡献

PR 欢迎 —— 见 `CONTRIBUTING.md`(随 v0.1 一起发布)。非平凡改动请先开 issue 对齐 scope。

## 许可

[MIT](LICENSE)。© 2026 git-ai-studio contributors.

## 致谢

- [`git-ai`](https://github.com/git-ai-project/git-ai) —— 真正干活的 CLI,本项目是它的可视化层
- [Tauri](https://tauri.app/) —— Rust + webview 壳,让一个隐私友好的小体积桌面应用成为可能
- Radix UI、Tailwind CSS、TanStack Query、CodeMirror、recharts、sonner 等团队 —— 项目的每个依赖都是开源馈赠
