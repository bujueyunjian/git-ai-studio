# ADR-0013 · 行级归因(Blame)并入提交归因(Stats)

**Status**: Accepted
**Date**: 2026-05-31

## Context

产品早期有两个并列的顶级导航入口:

- **提交归因(Stats)** —— commit 浏览器:左栏 commit 列表(搜索 + 只看我),右栏选中 commit 的聚合详情(范围指标、`tool::model` 分布、改动文件清单、`git-ai show` 原文、未提交工作树视图)。点改动文件 → **模态弹窗** `BlameDialog` 看该文件逐行归因。
- **Blame 行级** —— 行级归因页:同样是 commit 列表 → 改动文件,但点文件后在**主区常驻**渲染整文件逐行 blame,并支持行范围深链 `#/blame/<file>/L<a>-<b>?sha=<commit>`、锚定任意老 commit、逐一专用的 blame 硬故障空态。

[ADR-0001](0001-router-selection.md) 之后,Blame 页经历过一次重构:旧版「全仓文件树」入口无人用,改为 commit 驱动。改完后两页的**骨架完全同构** —— 同一份 `list_recent_commits_with_stats` 数据、同一组共享组件(`CommitAttributionList` / `ChangedFilesPanel` / `BlameCodeView` / `BlamePromptDetails`),差异收敛到「逐行视图是弹窗(Stats)还是常驻主区(Blame)」这一点。Stats 里的 `BlameDialog` 实际上是一份「缩水版 Blame 页」,两处 `lineAuthors` 派生逐字节重复。

经一轮多视角评审(`pantheon-nexus`,Jobs / Musk / Linus / Bezos / Jensen)收敛:六个顶级入口里,Blame 是唯一「本质是 Stats 的下钻动作、却占一格平级导航」的项;用户每次在入口处都要付一道「该点哪个」的认知税,而答案永远是「先看 commit 再下钻到行」。

## Options

1. **保留两页独立**:维持现状,仅下沉重复的 `lineAuthors`。认知税不消除,两套近亲 UI 长期维护。
2. **合并为带 view-mode 的单页**:Stats 详情区加「commit 视图 / blame 视图」顶层开关。会让详情区长出 `blame-mode vs stats-mode` 状态机 —— Linus lens 明确反对(把两类意图搅成 `if(mode)` 怪物)。
3. **吸收 + 砍(本决策)**:把 Blame 的真零件(行范围深链、`?sha` 锚定、blame 硬故障空态)吸收进 Stats,删掉 Blame 独立页与 `#/blame` 路由;逐行视图**只保留弹窗**这一种形态,深链只是「用 URL 驱动开一次弹窗」。

## Decision

采用 **Option 3**,并锁死以下不变量(评审里五个视角独立收敛出的验收线):

1. **弹窗是唯一逐行形态。** 深链 `#/stats/<sha>?file=<路径>&L=<a>-<b>` 只做一件事:URL 驱动 `BlameDialog` 打开(`<sha>` path 段→commit、`?file`→openFile、`?L`→范围),关弹窗即清 query。深链与点击共用同一条弹窗代码路径,**零 mode 分支**。不引入常驻整文件主区。
2. **URL 方案走 query 段,不动 commit-in-params。** Stats 仍是 `#/stats/<sha>`;文件 / 行范围放进独立 query key(`?file=` / `?L=`)。`URLSearchParams` 自动编解码文件路径里的 `/` 与空格,天然规避了旧 `blameUrl.ts` 用 `L` 前缀防御的「文件名末段像 `12-34`」歧义 —— 旧方案整块删除,复杂度净减。
3. **响亮失败,不静默退化。** 深链命中 `commit_not_found` / `file_not_in_head` / `file_too_large` 等硬故障时,弹窗用 `FileDegradedCard` 逐一专用空态 + CTA 呈现(从 Blame 的 `FileDegraded` 抽出),不塌缩成一句泛化文案。
4. **保住唯一真实的行范围深链调用方**:`NoteDetail` attestation 点 `line_ranges` → `#/stats/<sha>?file=&L=`;`Checkpoints` / `NoteDetail` 文件级跳转改指 Stats。
5. **消除唯一真重复**:`lineAuthors` / `aiLines` 派生下沉为纯函数 `deriveBlameLines`(`lib/blameLines.ts`,带单测)。

同时把提交归因顶部指标看板改用与作者归因(People)一致的 `MetricCard` 卡片布局(抽 `components/MetricCard.tsx` 共用),「AI 行 / 总行」拆成两张独立卡,根治大数字换行。

**Peer evidence.** 主流工具都把「逐行 blame」当作 commit / 文件视图的下钻态,而非平级导航:GitHub 的 blame 是从文件视图进入的一个 view(`/blame/<ref>/<path>`),不在仓库顶级 tab;VS Code GitLens 把 inline blame + commit 详情统一在同一面板内下钻,不另开「Blame 页」。本决策与之一致 —— 逐行归因只有一个家,从 commit 下钻抵达。

## Consequences

**正面**

- 顶级导航 6 → 5,消除「看 commit 还是看行」的入口认知税。
- 逐行归因只有一个实现入口(弹窗),不再维护两套近亲 UI;`lineAuthors` 不再重复。
- `blameUrl.ts`(L 前缀 path 方案)整体删除,深链编码复杂度净减。
- 这是**双向门**:纯前端 + 路由 + 测试改动,无后端改动,可一键 `git revert`。

**负面 / 代价**

- 失去「整文件常驻沉浸阅读」「Header 手输行范围」「翻 100 条窗口外老 commit 逐行考古」三类低频探索式用法 —— 单开发者本机 MVP 下评估为可接受的脂肪(Bezos / Musk lens)。
- 外部若存过 `#/blame/...` 深链(浏览器书签),失效不自动重写;生产代码内唯一深链调用方已随本次重定向。
- 契约测试 `router_query` / `notes_blame_link` 同步改写为新深链口径;`parseLineRanges`(上游 `format_line_ranges` 真源)与 `BlamePayload` schema 测试不受影响。

**未做(响亮声明)**

- 深链带 `?L=` 时仅把范围传后端做范围查询(与原 Blame 页同口径),**不在 CodeMirror 里高亮 / 滚动到该行** —— 原 Blame 页也未做,本次未新增,不伪装成已实现。
- 「commit 不在最近 100 条」时左栏 / 详情仍回退首项(预存行为);但逐行弹窗用 URL 的 `sha` 直查,内容正确或专用空态报错,不会静默展示 HEAD 的文件内容。
