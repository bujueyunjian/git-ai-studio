# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version bumps are manual — see [CONTRIBUTING.md](CONTRIBUTING.md#releasing-a-new-version-maintainer-only) and [ADR-008](docs/adr/0008-conventional-commits-release-tool.md).

## [Unreleased]

### Added

- Initial open-source release: a local desktop dashboard for AI code authorship, built on top of the [`git-ai`](https://github.com/git-ai-project/git-ai) CLI.
- Views: Dashboard, Commits (per-commit stats), People (per-author), Blame (line-level), git notes, Checkpoints.
- Official `git ai install-hooks` integration for Claude Code / Cursor / Codex / OpenCode.
- Bilingual UI (Simplified Chinese / English) via i18next, with an in-app language switcher.
- macOS (universal `.dmg`), Linux (`.AppImage` + `.deb`, x86_64 + ARM64), and Windows (`.msi`) builds.
- OS-native notifications (via `tauri-plugin-notification`) for low AI-share and daemon-health alerts — opt-in, no webhook, no cloud.
- `refs/notes/ai` fetch/push sync through the upstream CLI.

### Changed

- UI restyled to a Linear-inspired minimal aesthetic on Tailwind v4 + shadcn/ui.

### Removed

- Self-hosted hook server (Windows scheduled task + VBS shim + Node HTTP server). Hooks now go exclusively through the official `git ai install-hooks`.
- Feishu webhook push (replaced by OS-native notifications).

[Unreleased]: https://github.com/git-ai-project/git-ai-studio/commits/main
