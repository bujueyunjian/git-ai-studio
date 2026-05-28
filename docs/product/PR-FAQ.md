# git-ai-studio · PR-FAQ

> 中文: [PR-FAQ.zh-CN.md](PR-FAQ.zh-CN.md)
>
> Positioning document, Amazon Working Backwards style. Imagine we're releasing v1.0 in 6 months. Would this excite the target user?
>
> 定位文档。所有 README 标题 / 砍留决策 / 对外定位都以此为锚。Headline 给中英双版；其余正文英文为主，因为这是 OSS 国际语境。
>
> **Version**: 2

---

## Press Release (assume launch in 6 months)

### Headline

**EN**: See exactly which lines your AI wrote.

**ZH**: 看清每一行代码，是 AI 写的还是你写的。

(9 English words. No "next-gen", no "empower", no "revolutionary". A claim, not a brochure.)

### First Paragraph

Today we're releasing git-ai-studio 1.0, a free desktop app for macOS, Linux, and Windows that turns your local git history into a live picture of human-versus-AI authorship. It reads the `refs/notes/ai` written by the [`git-ai`](https://github.com/git-ai-project/git-ai) CLI — maintained by the team behind [usegitai.com](https://usegitai.com) — so every Claude Code, Cursor, Codex, or OpenCode edit is already on disk, line for line, and we render it as a dashboard you can open when you want to know: today's AI share, which files an agent touched last night, and a `git blame` where each row is tinted by the model that wrote it. Until now you either trusted vendor dashboards that count keystrokes inside their own IDE, or you wrote spreadsheets from `git log`. git-ai-studio shows you what actually landed in `main`, parsed entirely on your machine. The only thing it sends is a single version check to GitHub at launch — a version number, no code, no repository data, no personal data, no telemetry — so you don't silently miss security fixes.

### Why now

Three things are true in 2026 that weren't in 2024. (1) [Stack Overflow 2025 (n=49k) shows 51% of professional developers use AI coding tools daily](https://survey.stackoverflow.co/2025/ai/); [Sonar's State of Code 2026 measures AI-authored code at 26.9% of production code, up from 22% the prior quarter](https://www.sonarsource.com/state-of-code-developer-survey-report.pdf). (2) Most teams now run *more than one* agent (Claude Code + Cursor + Codex is a common stack), which breaks vendor-specific dashboards by definition — each vendor only sees its own keystrokes. (3) `git-ai` shipped a stable v3 spec for `refs/notes/ai`, giving us a vendor-neutral substrate for the first time. Until (3) existed, every dashboard had to invent its own attribution format; now there's one to read from.

### Imagined customer reaction *(hypothetical, to be validated by interviewing 3+ target users before v1.0)*

A tech lead at a 30–50 person team that has rolled out 2+ AI coding agents wants to know how much code each agent is shipping per repo per week. They'd open this on Monday mornings or before sprint planning — not necessarily daily. The win condition is "this told me something I would not have known to ask".

Validation deliverable: `validation/customer-interviews-v1.md` (3 real interviews) is a v1.0 launch blocker.

### Spokesperson Quote

> "Vendor dashboards measure what their tool did inside their IDE. git-ai-studio measures what survived to `main` — across every agent, on your laptop, with no account to create." — git-ai-studio maintainer

### How to Get Started (under 3 minutes)

1. Download the `.dmg` (macOS), `.AppImage` / `.deb` (Linux), or `.msi` (Windows) from Releases. Windows v1.0 builds are unsigned; users bypass SmartScreen manually. Code-signing is tracked for v1.1.
2. Open the app. It will detect whether `git-ai` is installed; one click installs or upgrades it.
3. Point it at any git repository. The Dashboard renders immediately from existing `refs/notes/ai`; if the repo has no notes yet, install the hooks for your AI agent from the in-app guide and start coding — the next commit shows up live.

---

## FAQ

### 1. I'm already running the `git-ai` CLI. Why install a GUI?

The CLI answers point questions: "what's the AI share of commit `abc123`?" The GUI answers questions you didn't know to ask: which file drifted to 90% AI this week, which author's PRs are AI-heavy, which model wrote the function you're staring at in `git blame`. It's the difference between `du -sh` and a disk-usage visualizer. Everything in the GUI is also available as `git ai <subcommand> --json`; the GUI just makes the glance cheap.

### 2. How is this different from GitHub Copilot metrics, Cursor analytics, DX, or Jellyfish?

Those are organization-level SaaS dashboards measuring what happens inside one vendor's IDE — keystrokes, suggestion accept rates, seat usage. They cannot see code that an agent wrote and a human then rewrote, and they cannot compare Claude vs Cursor vs Codex in one chart because each lives in its own silo. git-ai-studio measures what actually shipped to `main`, attributed to whichever agent produced it, on the developer's own machine. No vendor lock-in, no admin onboarding, no per-seat pricing — it's the agent-agnostic view of "what landed", not "what was suggested".

### 3. Does it upload my code anywhere?

No. Parsing is 100% local. There is no account, no telemetry, no crash reporter. The app reads your git objects and notes directly from disk and renders them in a local webview. There is exactly one automatic network call: about one second after launch the app asks GitHub once for the latest `latest.json` to compare version numbers — it sends a version check only, no code, no repository data, no personal data, no telemetry. If a newer version exists you'll see it on the About page and a TopBar badge, and you can install it in one click (artifacts are minisign-verified). Every other outbound call is one you explicitly trigger: `git-ai` install/upgrade from GitHub Releases, and optional `git push refs/notes/ai` to your own remote. The version check can be turned off entirely by building with `plugins.updater.active=false`. See [ADR-010](../adr/0010-in-app-auto-update.md) for the full rationale.

### 4. What's onboarding from zero to first useful screen?

Install the app, click "Install git-ai" inside it, open any repo with existing commits — Dashboard renders the historical AI share immediately by replaying notes that the agent hooks have already written. For repos with no notes yet, follow the in-app Hooks guide for your agent (Claude Code / Cursor / Codex / OpenCode); your next AI-assisted commit appears on the Dashboard within seconds. Target total time: under 3 minutes for an existing repo, under 5 for a fresh setup.

### 5. Which AI agents are supported?

Whatever `git-ai` supports — that's the contract. As of this writing: Claude Code, Cursor, Codex, OpenCode, and any agent that calls a post-edit hook. The Studio doesn't talk to agents directly; it reads the `refs/notes/ai` they produce via `git-ai`'s hooks. If a new agent ships tomorrow and `git-ai` adds a hook for it, the Studio gets it for free with no release.

### 6. What's the relationship to usegitai.com / Git AI Teams?

git-ai-studio is an **independent open-source project, not affiliated with the Git AI commercial team**. We consume only the open-source [`git-ai` CLI](https://github.com/git-ai-project/git-ai) and the public `refs/notes/ai` standard — no private APIs, no license keys, no shared infrastructure.

[Git AI Teams / Cloud](https://usegitai.com) is an **organization-level SaaS dashboard** for SDLC observability across an engineering org, sold to VPs of Engineering with per-seat pricing and a cloud (or self-hosted enterprise) deployment. git-ai-studio is a **single-developer local desktop client** that runs on your laptop, has no account, and shows you your own repos. Different surface (team SaaS vs personal desktop), different deployment (cloud vs local-only), different buyer (VP Eng vs individual developer). The two can coexist on the same `refs/notes/ai` substrate the same way a CLI and a GUI coexist on the same git database.

**If upstream releases an official desktop GUI, we will reassess scope — including potential merge or sunset of this project.** We'd rather say that out loud than pretend the question doesn't exist.
