# Contributing to git-ai-studio

Thanks for being interested in contributing — this project is small and every PR matters.

This guide tells you (a) how to get a working dev environment, (b) the conventions we follow, and (c) what we expect in a PR. Please skim it once before your first contribution.

For the *why* behind the project's positioning, read [`docs/product/PR-FAQ.md`](docs/product/PR-FAQ.md) first. For architecture trade-offs, read [`docs/adr/`](docs/adr/). For day-to-day code conventions, read [`CLAUDE.md`](CLAUDE.md) — it's written for AI coding assistants but applies equally to humans.

---

## Quick start

Requirements:

- **Node** 20+ and **pnpm** 9+ (we pin to pnpm `10.12.3` in CI)
- **Rust** 1.80+ with `rustfmt` and `clippy` components
- The **`git-ai`** CLI installed locally ([install instructions upstream](https://github.com/git-ai-project/git-ai))
- Platform-specific build deps:
  - **macOS**: Xcode CLT
  - **Linux**: `build-essential pkg-config libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libsoup-3.0-dev`
  - **Windows**: Visual Studio Build Tools with C++ workload + WebView2 runtime

```bash
# Clone, install deps, run dev (Vite + Tauri dev shell)
git clone https://github.com/<owner>/git-ai-studio.git
cd git-ai-studio
pnpm install
pnpm tauri:dev
```

`pnpm dev` runs only the frontend in a browser (no Tauri shell) — useful for quick UI iteration.

---

## Before you push

We run `pnpm check` as the local pre-flight. It's the same set of gates CI runs:

```bash
pnpm check    # typecheck + lint + format:check + rs:fmt + rs:clippy
pnpm test     # vitest (frontend unit + contract)
pnpm rs:test  # cargo test (Rust unit + contract)
```

If `pnpm check` passes locally, the PR-side CI will pass too — that's the contract. Frontend ESLint baseline is `--max-warnings=0`; the standard is **don't add new warnings**, not "the codebase is currently warning-free".

---

## Commit conventions

We use **[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)** for commit subjects. This is non-negotiable — the changelog and (eventually) release automation depend on it.

| Prefix     | When to use                                           |
| ---------- | ----------------------------------------------------- |
| `feat:`    | A user-visible new feature                            |
| `fix:`     | A bug fix                                             |
| `docs:`    | README / docs / ADR / comment-only changes            |
| `refactor:`| Code restructuring with no behavior change            |
| `perf:`    | Performance improvement                               |
| `test:`    | Adding or fixing tests                                |
| `build:`   | Build system, deps, CI config                         |
| `chore:`   | Internal housekeeping that doesn't fit above          |

Subject line: imperative mood, no trailing period, ≤ 72 chars. Body (optional): wrap at 72, explain the *why*, not the *what*.

Example:

```
feat: render OpenCode hooks in agent status grid

Previously filtered out by `not_yet_supported` flag which is
deprecated; OpenCode now reports full status like the other agents.
```

---

## Branch and PR flow

1. **Fork** the repository and create a branch named after the change: `feat/dashboard-density`, `fix/blame-empty-file`, etc. — avoid generic names like `patch-1`.
2. **For non-trivial changes, open an issue first** so we can align on scope before you spend significant time. "Non-trivial" = touches multiple files, changes a public API, or adds a dependency.
3. **Keep PRs focused.** One logical change per PR. If you're tempted to add "while I'm here" cleanup, save it for a second PR.
4. **Update tests.** A behavior change without a test (or an updated test) is incomplete. Contract tests in `src/__tests__/*.contract.test.ts` exist specifically to lock the `api.ts` ↔ Rust serde boundary — touch the boundary, update the contract.
5. **Update docs** in the same PR. Any change that affects user-visible behavior should update the corresponding doc (README, ADR, in-app copy in `src/lib/copy.ts`, or `docs/`).
6. **Self-review.** Read your own diff once before requesting review — most "I missed that" comments could have been caught in 5 minutes of self-review.

The PR template will prompt you for a summary, related issue, and a test plan. Fill it in honestly.

---

## Code style

- **Comments must be in Chinese** (existing convention — see [`CLAUDE.md`](CLAUDE.md)). Code identifiers stay in English. Comments should explain *why*, not *what*; if the code is self-explanatory, no comment is needed.
- **No "fallback" / compat shims** for failed subprocess calls or bad JSON. Fail loudly with a typed `Err(String)` and let the user-facing toast surface a useful message. See [`CLAUDE.md`](CLAUDE.md) for the `classify_*_error()` pattern.
- **Frontend**: TypeScript strict mode, functional React components, hooks for state, `@tanstack/react-query` for server state, `sonner` for toasts. No `any` unless justified in a comment.
- **Rust**: idiomatic with `thiserror` for typed errors, `anyhow` for command-level error propagation, `tokio` for async, `rusqlite` for storage. Inline `#[cfg(test)]` modules for unit tests.

---

## Architectural changes

If your change crosses a layer boundary (new Tauri command, new database table, new external dependency, new platform-specific code path), write a short **ADR** (Architecture Decision Record) in `docs/adr/` *before* opening the PR.

Format: copy any existing `docs/adr/000X-*.md` as a template. Sections required: **Context**, **Options considered**, **Decision**, **Consequences**. Cite at least one peer project that informed your reasoning.

If your change touches `refs/notes/ai` semantics or any `git-ai` CLI integration, the upstream [`git-ai`](https://github.com/git-ai-project/git-ai) repo is the authority. Cross-reference the specific upstream file and line in your code comment (we use the convention `git-ai/<rel-path>:<line>`).

---

## Releasing a new version (maintainer only)

We deliberately do **not** use `release-please` / `semantic-release` / `changesets`. Version bumps and `CHANGELOG.md` are written by hand — see [ADR-008](docs/adr/0008-conventional-commits-release-tool.md) for the why (peer projects GitButler and `cc-switch` ship the same way, and at our cadence the automation isn't worth one more dependency).

The 5-step release flow:

1. **Decide the version**. Read the Conventional Commits since the last tag (`git log v<prev>..HEAD --oneline`). If you see any `feat:` → bump minor; only `fix:` / `docs:` / `chore:` → bump patch. Breaking changes (`feat!:` or `BREAKING CHANGE:` footer) → bump major (or minor while pre-1.0).
2. **Bump the version in three files** to the same value:
   - `package.json` — top-level `"version"`
   - `src-tauri/Cargo.toml` — `[package].version` (and re-run `cargo update -p git-ai-studio` to refresh `Cargo.lock`)
   - `src-tauri/tauri.conf.json` — top-level `"version"`
3. **Write the `CHANGELOG.md` entry**. Group bullets under `### Added` / `### Changed` / `### Fixed` / `### Removed`. Link relevant PRs. Keep it user-facing — implementation detail commits don't need to appear.
4. **Commit and tag**:
   ```bash
   git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md
   git commit -m "chore: release v0.2.0"
   git tag v0.2.0
   git push origin main --tags
   ```
5. **`release.yml` takes over**. Pushing the tag triggers the workflow defined in [ADR-007](docs/adr/0007-bundle-targets-and-signing.md): it builds macOS universal `.dmg`, Linux `.deb`+`.AppImage` (x86_64 + ARM64), Windows `.msi`, and a draft GitHub Release. Watch the Actions tab; once green, edit the release notes if needed and publish.

If the three version numbers drift apart, `cargo check` will warn and `tauri build` will use whichever it reads first — keep them in lockstep. (We re-evaluate the automation choice if this becomes a real friction point — see ADR-008's re-evaluate criteria.)

---

## What we'll typically push back on

These aren't bans — they're things we'll question in review:

- **New top-level dependencies** without a one-paragraph justification. Bundle weight matters for a desktop app.
- **Refactors bundled with feature work.** Split them.
- **"Why not?" justifications** (e.g. "Why not add telemetry?"). The default answer is no; the burden is on the proposer.
- **Inventing instead of upstream-ing.** If `git-ai` should grow a feature, file an issue upstream first; we'd rather wait than fork the spec.

---

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).

---

Questions about how to contribute? Open a `question` issue — we'd rather answer one upfront than have you guess.

简体中文版本见 [`CONTRIBUTING.zh-CN.md`](CONTRIBUTING.zh-CN.md)。
