# Architecture Decision Records

This directory tracks the architectural decisions for `git-ai-studio`. Each ADR follows the
Michael Nygard format (Context / Options / Decision / Consequences) and cites the real
production precedents that informed the call.

## Index

| #   | Title                                                    | Status                     | Date       |
| --- | -------------------------------------------------------- | -------------------------- | ---------- |
| 001 | [Router selection](./0001-router-selection.md)            | Proposed (awaiting review) | 2026-05-27 |
| 002 | [Adopt the shadcn/ui CLI](./0002-shadcn-ui-cli.md)        | Proposed (awaiting review) | 2026-05-27 |
| 003 | [Tailwind CSS v3 vs v4](./0003-tailwind-v3-vs-v4.md)      | Proposed (awaiting review) | 2026-05-27 |
| 004 | [Runtime validation for Tauri IPC](./0004-runtime-validation.md) | Proposed (awaiting review) | 2026-05-27 |
| 005 | [Micro-animation library](./0005-micro-animation-library.md) | **Accepted (amended → `tw-animate-css`)** | 2026-05-28 |
| 006 | [Auto-update strategy](./0006-auto-update-strategy.md) | **Superseded by [010](./0010-in-app-auto-update.md)** | 2026-05-27 |
| 007 | [Bundle formats and signing strategy](./0007-bundle-targets-and-signing.md) | Proposed (awaiting review) | 2026-05-27 |
| 008 | [Conventional Commits and release-automation tool](./0008-conventional-commits-release-tool.md) | **Accepted (Option D)** | 2026-05-27 |
| 009 | [CI configuration strategy](./0009-ci-configuration.md) | Proposed (awaiting review) | 2026-05-27 |
| 010 | [In-app auto-update](./0010-in-app-auto-update.md) | **Accepted (supersedes 006)** | 2026-05-29 |

## Guiding principles

These ADRs were written under the constraints that ship with this project:

1. **Mature first.** Prefer boring, battle-tested libraries over the newest thing on Hacker News.
2. **No deprecated paths.** Anything flagged "deprecated" by its maintainer is rejected outright,
   even if it still works today.
3. **No tech for tech's sake.** A 50-line hand-rolled helper beats a 50KB dependency when the
   helper covers everything the product actually needs.
4. **Bundle weight matters.** This is a desktop app that ships with the binary; users do not
   re-download on every visit, but slow startup is still a UX tax.
5. **Cross-platform.** macOS + Linux + Windows must all stay first-class.
6. **OSS / MIT only.** No license traps.

Where an ADR cites a peer project (e.g. `cc-switch`, `GitButler`, `Spacedrive`,
`Hoppscotch`), the URL is included so the reasoning is auditable.
