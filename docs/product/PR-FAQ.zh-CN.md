# git-ai-studio · PR-FAQ

> English: [PR-FAQ.md](PR-FAQ.md)
>
> 定位文档,采用 Amazon Working Backwards 风格。设想我们在 6 个月后发布 v1.0 —— 它会让目标用户感到兴奋吗?
>
> 这份文档是定位之锚。所有 README 标题 / 砍留决策 / 对外定位都以它为准。Headline 给中英双版;其余正文英文为主,因为这是 OSS 国际语境(本文为完整中文译本)。
>
> **Version**: 2

---

## Press Release(假设 6 个月后发布)

### Headline

**ZH**: 看清每一行代码,是 AI 写的还是你写的。

**EN**: See exactly which lines your AI wrote.

(英文 9 个词。没有 "next-gen"、没有 "empower"、没有 "revolutionary"。是一句主张,不是一张宣传单。)

### 第一段

今天我们发布 git-ai-studio 1.0 —— 一款面向 macOS、Linux、Windows 的免费桌面应用,它把你本机的 git 历史变成一幅人类 vs AI 归属的实时画像。它读取由 [`git-ai`](https://github.com/git-ai-project/git-ai) CLI 写入的 `refs/notes/ai` —— 该 CLI 由 [usegitai.com](https://usegitai.com) 背后的团队维护 —— 因此每一次 Claude Code、Cursor、Codex 或 OpenCode 的编辑都已经精确到行地落在磁盘上,我们把它渲染成一个你想看时随手就能打开的 dashboard:今天的 AI 占比、某个 agent 昨晚改过哪些文件、以及一份 `git blame` —— 其中每一行都按写下它的模型上色。在此之前,你要么相信厂商 dashboard 在自家 IDE 里统计的击键数,要么自己从 `git log` 拼 Excel。git-ai-studio 给你看的是真正合入 `main` 的代码,全部在你本机解析。它唯一会发出的,是启动时向 GitHub 做的一次版本检查 —— 只发版本号,不含代码、仓库数据、个人信息、遥测 —— 这样你就不会悄无声息地错过安全修复。

### Why now(为什么是现在)

2026 年有三件事在 2024 年还不成立。(1) [Stack Overflow 2025(n=49k)显示 51% 的专业开发者每天使用 AI 编程工具](https://survey.stackoverflow.co/2025/ai/);[Sonar 的 State of Code 2026 测得 AI 撰写代码占生产代码的 26.9%,较上一季度的 22% 持续上升](https://www.sonarsource.com/state-of-code-developer-survey-report.pdf)。(2) 如今大多数团队同时运行*不止一个* agent(Claude Code + Cursor + Codex 是常见组合),这从定义上就让厂商专属 dashboard 失效 —— 每家厂商只能看到自己工具的击键数。(3) `git-ai` 发布了 `refs/notes/ai` 的稳定 v3 spec,第一次给了我们一个厂商无关的统一底座。在 (3) 出现之前,每个 dashboard 都得自己发明一套归属格式;现在有一个统一标准可读了。

### Imagined customer reaction(设想的用户反应)_(为假设,需在 v1.0 之前访谈 3 名以上目标用户加以验证)_

一位带着 30–50 人团队、已经铺开 2 个以上 AI 编程 agent 的 tech lead,想知道每个 agent 每周在每个仓库里到底产出了多少代码。他们会在周一早晨或 sprint 规划之前打开它 —— 不一定每天看。成功的标准是 "它告诉了我一些我本来都不知道该去问的事"。

验证交付物:`validation/customer-interviews-v1.md`(3 场真实访谈)是 v1.0 发布的阻塞项。

### Spokesperson Quote(代言引述)

> "厂商 dashboard 衡量的是它们的工具在自家 IDE 里做了什么。git-ai-studio 衡量的是什么活到了 `main` —— 跨越每一个 agent,就在你的笔记本上,无需注册任何账号。" —— git-ai-studio 维护者

### How to Get Started(3 分钟以内上手)

1. 从 Releases 下载 `.dmg`(macOS)、`.AppImage` / `.deb`(Linux),或 `.msi`(Windows)。Windows 的 v1.0 构建未签名,用户需手动绕过 SmartScreen。代码签名计划在 v1.1 完成。
2. 打开应用。它会检测 `git-ai` 是否已安装;一键即可安装或升级。
3. 把它指向任意一个 git 仓库。Dashboard 会立刻基于已有的 `refs/notes/ai` 渲染;如果仓库还没有 notes,按应用内引导为你的 AI agent 安装 hook,然后开始写代码 —— 下一次 commit 就会实时出现。

---

## FAQ

### 1. 我已经在用 `git-ai` CLI 了。为什么还要装一个 GUI?

CLI 回答的是点对点的问题:"commit `abc123` 的 AI 占比是多少?" GUI 回答的是你本来不知道该去问的问题:这周哪个文件漂移到了 90% AI、哪位作者的 PR 是 AI 重度的、你正盯着的 `git blame` 里那个函数是哪个模型写的。这就像 `du -sh` 和磁盘占用可视化工具之间的差别。GUI 里的一切也都能通过 `git ai <subcommand> --json` 拿到;GUI 只是让 "瞥一眼" 这件事变得廉价。

### 2. 它和 GitHub Copilot metrics、Cursor analytics、DX 或 Jellyfish 有什么不同?

那些是组织级的 SaaS dashboard,衡量的是单一厂商 IDE 内部发生的事 —— 击键数、建议采纳率、席位使用量。它们看不到 agent 写了、又被人类改写过的代码,也无法在一张图里比较 Claude vs Cursor vs Codex,因为每一个都活在各自的孤岛里。git-ai-studio 衡量的是真正合入 `main` 的代码,归属到产出它的那个 agent,就在开发者自己的机器上。没有厂商锁定、没有管理员 onboarding、没有按席位计费 —— 它是 "什么落地了" 的 agent 无关视角,而非 "建议了什么"。

### 3. 它会把我的代码上传到哪里吗?

不会。解析 100% 在本机完成。没有账号、没有 telemetry、没有 crash reporter。应用直接从磁盘读取你的 git objects 和 notes,在本地 webview 里渲染。只有一次自动外网调用:启动约 1 秒后,应用向 GitHub 拉取一次 `latest.json` 来比对版本号 —— 只发版本号,不含代码、仓库数据、个人信息、遥测。若有新版,关于页和 TopBar Badge 会提示,你可一键安装(产物经 minisign 验签)。其余外网调用都是你主动触发的:从 GitHub Releases 安装/升级 `git-ai`,以及可选的 `git push refs/notes/ai` 到你自己的远端。这次版本检查可通过构建时设 `plugins.updater.active=false` 彻底关闭。完整理由见 [ADR-010](../adr/0010-in-app-auto-update.md)。

### 4. 从零到第一个有用界面的 onboarding 是怎样的?

安装应用,在里面点 "Install git-ai",打开任意一个有历史 commit 的仓库 —— Dashboard 会立刻通过回放 agent hook 已经写下的 notes,渲染出历史 AI 占比。对于还没有 notes 的仓库,按应用内的 Hooks 引导为你的 agent(Claude Code / Cursor / Codex / OpenCode)配置;你下一次 AI 辅助的 commit 会在数秒内出现在 Dashboard 上。目标总耗时:已有仓库 3 分钟以内,全新配置 5 分钟以内。

### 5. 支持哪些 AI agent?

`git-ai` 支持什么,就支持什么 —— 这是约定。截至撰写本文:Claude Code、Cursor、Codex、OpenCode,以及任何调用 post-edit hook 的 agent。Studio 不直接和 agent 对话;它通过 `git-ai` 的 hook 读取它们产出的 `refs/notes/ai`。如果明天有新 agent 发布,且 `git-ai` 为它加了 hook,Studio 不需要发布新版本就能免费支持。

### 6. 和 usegitai.com / Git AI Teams 是什么关系?

git-ai-studio 是一个**独立的开源项目,与 Git AI 商业团队无 affiliate 关系**。我们只消费开源的 [`git-ai` CLI](https://github.com/git-ai-project/git-ai) 和公开的 `refs/notes/ai` 标准 —— 没有私有 API、没有 license key、没有共享基础设施。

[Git AI Teams / Cloud](https://usegitai.com) 是一个**组织级 SaaS dashboard**,面向整个工程组织提供 SDLC 可观测性,卖给 VP of Engineering,按席位计费,部署在云上(或自托管的企业版)。git-ai-studio 是一个**单开发者本机桌面客户端**,跑在你的笔记本上,没有账号,只给你看你自己的仓库。不同的 surface(团队 SaaS vs 个人桌面)、不同的部署(云 vs 仅本地)、不同的 buyer(VP Eng vs 个人开发者)。两者可以共存于同一份 `refs/notes/ai` 底座之上,就像 CLI 和 GUI 共存于同一个 git database 之上一样。

**如果上游发布官方桌面 GUI,我们会重新评估 scope —— 包括本项目可能的合并或日落。**我们宁愿把这一点大声说出来,也不假装这个问题不存在。
