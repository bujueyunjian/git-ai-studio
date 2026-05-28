# 贡献指南

感谢你愿意参与 —— 项目还小，每个 PR 都重要。

这份文档说明 (a) 如何起本地开发环境,(b) 我们遵循的约定,(c) 一个合格 PR 需要什么。第一次贡献前请通读一次。

项目的"为什么"在 [`docs/product/PR-FAQ.zh-CN.md`](docs/product/PR-FAQ.zh-CN.md);架构权衡在 [`docs/adr/`](docs/adr/);日常代码约定在 [`CLAUDE.md`](CLAUDE.md)(给 AI 编程助手写的,人类同样适用)。

---

## 快速开始

环境要求:

- **Node** 20+ 与 **pnpm** 9+ (CI 锁定 pnpm `10.12.3`)
- **Rust** 1.80+ 含 `rustfmt` 和 `clippy` 组件
- 本地装好 **`git-ai`** CLI([上游安装指引](https://github.com/git-ai-project/git-ai))
- 平台相关编译依赖:
  - **macOS**: Xcode Command Line Tools
  - **Linux**: `build-essential pkg-config libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libsoup-3.0-dev`
  - **Windows**: Visual Studio Build Tools + C++ workload + WebView2 runtime

```bash
git clone https://github.com/<owner>/git-ai-studio.git
cd git-ai-studio
pnpm install
pnpm tauri:dev
```

`pnpm dev` 只起前端 Vite(不带 Tauri 壳),适合快速 UI 迭代。

---

## 推送之前

`pnpm check` 是本地预检,等同 CI PR-side 跑的 gate:

```bash
pnpm check    # typecheck + lint + format:check + rs:fmt + rs:clippy
pnpm test     # vitest(前端单元 + 契约测试)
pnpm rs:test  # cargo test(Rust 单元 + 契约测试)
```

本地 `pnpm check` 过 → PR-side CI 必过,这是承诺。前端 ESLint 基线 `--max-warnings=0` —— 判定标准是**不新增警告**,不是"全仓库无警告"。

---

## Commit 规范

我们用 **[Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)** —— 不可商量,changelog 和(未来的)发布自动化都依赖它。

| 前缀        | 何时用                                          |
| ---------- | ----------------------------------------------- |
| `feat:`    | 用户可见的新功能                                  |
| `fix:`     | bug 修复                                         |
| `docs:`    | README / docs / ADR / 仅注释改动                  |
| `refactor:`| 不改行为的代码重构                                |
| `perf:`    | 性能提升                                          |
| `test:`    | 添加或修复测试                                    |
| `build:`   | 构建系统 / 依赖 / CI 配置                         |
| `chore:`   | 不属上述的内部杂事                                |

subject 行:祈使语气,不带句末标点,≤ 72 字符。body(可选):每行 72 折行,解释**为什么**而不是**做了什么**。

示例:

```
feat: render OpenCode hooks in agent status grid

Previously filtered out by `not_yet_supported` flag which is
deprecated; OpenCode now reports full status like the other agents.
```

---

## 分支与 PR 流程

1. **fork** 仓库,branch 名按改动语义起:`feat/dashboard-density` / `fix/blame-empty-file` 等 —— 不要 `patch-1` 这种通用名
2. **非平凡改动先开 issue** 对齐 scope 再动手。"非平凡" = 涉及多文件 / 改公开 API / 新增依赖
3. **PR 聚焦**。一个 PR 一个逻辑改动;"顺手清理"留下一个 PR
4. **更新测试**。改了行为不更新测试 = 不完整。`src/__tests__/*.contract.test.ts` 专门锁定 `api.ts` ↔ Rust serde 边界 —— 改边界必更新契约测试
5. **同 PR 更新文档**。任何用户可见行为的改动都要更新对应文档(README / ADR / `src/lib/copy.ts` 中应用内文案 / `docs/`)
6. **自审**。点 review 前自己读一遍 diff —— 大部分"我漏看了"评论自审 5 分钟就能 catch

PR 模板会引导你填 summary / 关联 issue / 测试方案。诚实填。

---

## 代码风格

- **注释必须中文**(沿用约定,见 [`CLAUDE.md`](CLAUDE.md))。代码标识符仍是英文。注释解释**为什么**而不是**是什么**;见名知义的代码不加注释
- **禁止 fallback / 兼容代码** 处理失败子进程或坏 JSON。失败要响亮地用 `Err(String)` 抛出,前端 toast 给可操作的信息。`classify_*_error()` 模式见 [`CLAUDE.md`](CLAUDE.md)
- **前端**: TypeScript strict、函数组件、hook 管状态、`@tanstack/react-query` 管服务端状态、`sonner` toast。除非有注释解释,不用 `any`
- **Rust**: 习惯式风格,`thiserror` 标错误类型,`anyhow` 在命令层传播,`tokio` 异步,`rusqlite` 存储。`#[cfg(test)]` 内联单测

---

## 架构性改动

如果你的改动跨越层级边界(新增 Tauri command / 新增数据表 / 新增外部依赖 / 新增平台分支),先在 `docs/adr/` 写一份**ADR**(Architecture Decision Record)再开 PR。

格式:抄 `docs/adr/000X-*.md` 任一现有 ADR。必备段落: **Context** / **Options considered** / **Decision** / **Consequences**,至少引用 1 个同类生产项目作 peer evidence。

如果你的改动涉及 `refs/notes/ai` 语义或任何 `git-ai` CLI 集成,上游 [`git-ai`](https://github.com/git-ai-project/git-ai) 是权威。在代码注释里精确引用上游文件:行号(我们用 `git-ai/<rel-path>:<line>` 写法)。

---

## 发版流程(仅 maintainer)

我们刻意**不**用 `release-please` / `semantic-release` / `changesets`,版本号和 `CHANGELOG.md` 手写。理由见 [ADR-008](docs/adr/0008-conventional-commits-release-tool.md):peer 项目 GitButler 和 `cc-switch` 也是手写,我们这点发版频率不值得多一个依赖。

5 步发版:

1. **定版本号**。读上次 tag 以来的 Conventional Commits(`git log v<prev>..HEAD --oneline`)。有 `feat:` → minor;只有 `fix:` / `docs:` / `chore:` → patch;breaking change(`feat!:` 或 `BREAKING CHANGE:` footer)→ major(pre-1.0 期间可降为 minor)
2. **改 3 个文件同步版本号**:
   - `package.json` 顶层 `"version"`
   - `src-tauri/Cargo.toml` `[package].version`(并跑 `cargo update -p git-ai-studio` 刷新 `Cargo.lock`)
   - `src-tauri/tauri.conf.json` 顶层 `"version"`
3. **写 `CHANGELOG.md`**。按 `### Added` / `### Changed` / `### Fixed` / `### Removed` 分组列改动,关联 PR 链接。是给用户看的 —— 实现细节 commit 不必每条都列
4. **commit 并打 tag**:
   ```bash
   git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md
   git commit -m "chore: release v0.2.0"
   git tag v0.2.0
   git push origin main --tags
   ```
5. **`release.yml` 接管**。push tag 触发 [ADR-007](docs/adr/0007-bundle-targets-and-signing.md) 定义的 workflow:macOS universal `.dmg` / Linux `.deb` + `.AppImage`(x86_64 + ARM64) / Windows `.msi` 全平台打包 + 草稿 GitHub Release。盯 Actions tab,绿了就编辑 release notes,publish

如果 3 个版本号 drift 不一致,`cargo check` 会警告,`tauri build` 会用最先读到的版本号 —— 必须 lockstep 同步。(如果版本号 mismatch 真出过坑,按 ADR-008 的 re-evaluate criteria 重新考虑自动化方案)

---

## review 时我们通常会回问的事

不是 ban,只是 review 时会问一句:

- **新增顶层依赖**没有一段理由说明。桌面应用 bundle 体积重要
- **重构和功能改动混在一个 PR**。拆分
- **"为什么不"式辩护**(如 "为什么不加 telemetry?")。默认答案是不,举证责任在提出者
- **自造而不上游推动**。如果某功能应该由 `git-ai` 提供,先去上游开 issue;宁可等也不要 fork spec

---

## 许可

提交 PR 即同意你的贡献按项目的 [MIT 许可](LICENSE) 发布。

---

不确定怎么贡献?开一个 `question` issue —— 我们宁可早回答一个问题,也不希望你猜。

English version: [`CONTRIBUTING.md`](CONTRIBUTING.md)。
