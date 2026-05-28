# ADR-009 · CI configuration strategy

**Status**: Proposed (awaiting review)
**Date**: 2026-05-27

## Context

CI for `git-ai-studio` must cover:

- **Frontend gates**: TypeScript typecheck, ESLint (`--max-warnings=0` aware of the
  existing baseline), Prettier `format:check`, Vitest unit + contract tests.
- **Rust gates**: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
- **Cross-platform sanity**: at minimum, the Rust crate must compile on macOS, Linux,
  and Windows — a clippy lint or an `#[cfg(target_os)]` typo only surfaces on the
  affected platform.
- **Speed**: PR-checks should land in **under 8 minutes** wall-clock; longer than that
  and contributors stop iterating in CI.
- **Cost**: GitHub Actions free tier for public repos is unlimited, but Mac runners
  are still ~10x slower-to-warm than Linux and pulling them into every PR is wasteful.

This is the dev-experience CI, **not** the release build pipeline (which is ADR-007's
`release.yml`, triggered on tags only). The two workflows are intentionally separate
so a flaky release-asset upload can't block PRs.

Reference data from peers:

- **`cc-switch` `ci.yml`** ([source](https://github.com/farion1231/cc-switch/blob/main/.github/workflows/ci.yml))
  — two parallel jobs, **Linux only**: a frontend job (`ubuntu-latest`,
  pnpm typecheck + format:check + test:unit) and a backend job (`ubuntu-22.04`,
  cargo fmt + clippy + test). Total wall-clock: ~5 minutes warm cache.
  Trade-off: no macOS / Windows coverage on PRs — relies on the release pipeline to
  catch cross-platform breakage at tag time.
- **GitButler** ships ~12 workflows total; the `push.yaml` runs a multi-platform
  matrix with separate jobs for e2e, web tests, version-compatibility smoke tests,
  and zizmor (Actions security analysis). Industrial-grade but proportionate to a
  30k-star app; overkill for our v1.0 surface.
- **Spacedrive `ci.yml`** runs per-platform smoke builds on every PR, which is
  thorough but expensive — minutes-per-PR ranges 12–20+.

## Options considered

### Option A · Copy `cc-switch` `ci.yml` verbatim (Linux-only, two parallel jobs)

- Source: [cc-switch ci.yml](https://github.com/farion1231/cc-switch/blob/main/.github/workflows/ci.yml)
  (~100 lines, proven in production for a sibling Tauri project we already
  cross-reference).
- Pros:
  - Cheapest, fastest (~5 min warm cache, 1 Linux runner total).
  - Already battle-tested by the cc-switch maintainer.
  - Caches `pnpm store` and `cargo registry + target` for warm runs.
- Cons:
  - **No macOS / Windows coverage on PRs.** A Windows-only `apply_no_window_*`
    regression (see CLAUDE.md note on `CREATE_NO_WINDOW`) wouldn't be caught
    until release tag time, which is too late.
  - Doesn't cover the `pnpm check` aggregate gate that the project's
    CLAUDE.md establishes as the local pre-flight (`typecheck + lint +
    format:check + rs:fmt + rs:clippy`).

### Option B · GitButler-style industrial matrix

- Source: [GitButler push.yaml + lite.yml](https://github.com/gitbutlerapp/gitbutler/tree/master/.github/workflows)
  (~12 workflows; ~700+ lines total).
- Pros:
  - Maximum coverage; catches every platform issue at PR time.
  - Includes e2e tests, security scanning, version-compatibility smoke tests.
- Cons:
  - Massive YAML maintenance burden for a v1.0 app.
  - Mac + Windows runners pulled in for every PR → typical wall-clock 15–25 min
    even with caching.
  - Most of the workflows (e2e container, zizmor, mobile build) don't apply to
    our project shape.

### Option C · Minimal hand-rolled (one job, no matrix)

- Source: bespoke — a single `ubuntu-latest` job that runs `pnpm check`
  (typecheck + lint + format + rs:fmt + rs:clippy) then `pnpm test` and
  `cargo test`.
- Pros:
  - Smallest possible YAML (~40 lines).
  - Mirrors the local `pnpm check` workflow 1-for-1 → "if it passes locally,
    it passes in CI" guarantee.
- Cons:
  - No macOS / Windows coverage → same blind spot as Option A.
  - Squashing everything into one job means a Rust failure blocks the lint
    failure being reported — frontend + backend feedback in serial, not parallel.
  - No caching of pnpm/cargo by default → cold-cache runs hit ~10 min for
    `cargo build` alone.

### Option D · Recommended hybrid — parallel Linux jobs (PR-fast) + matrix smoke on `main`

- **PR path**: 2 parallel jobs on `ubuntu-22.04` (frontend + backend, lifted from
  cc-switch's structure but expanded to the project's full `pnpm check` gate).
  Wall-clock target: ≤6 min warm.
- **Push-to-`main` path**: an additional matrix job that runs `cargo check` and
  `cargo test` on macOS + Windows. Doesn't run the full bundle (that's ADR-007's
  release job); just compiles + tests to catch platform-specific Rust regressions.
  Wall-clock cost: ~10 min added, but only on `main` pushes (post-merge), not on
  every PR push.
- Pros:
  - PR feedback stays under 6 minutes (no Mac/Windows pulled in).
  - Cross-platform Rust regressions still get caught before the next release tag.
  - Mirrors the project's local `pnpm check` gate exactly.
  - Caches pnpm store + cargo registry/target separately per runner (key by
    `runner.os`, restore-keys for partial hits).
- Cons:
  - A platform-specific regression introduced in a PR isn't caught until **after**
    that PR merges to `main`. Mitigation: `main` matrix job emails the merger on
    failure; revert is one click away on GitHub.
  - Two workflow files instead of one.

## Decision

**Chosen**: **Option D — parallel Linux jobs on PRs + cross-platform Rust smoke
matrix on push-to-`main`**.

**Reasoning**:

1. **PR feedback latency is the user-facing CI metric.** Six minutes is fast
   enough to keep contributors in the loop; 15+ minutes is not. Mac + Windows
   runners on every PR push is the single biggest contributor to slow CI in
   peer projects.
2. **Cross-platform Rust still gets covered.** The platform-specific risk is
   almost entirely in `src-tauri/src/` (CLAUDE.md flags `apply_no_window_*`,
   `schtasks`, `auto-launch` paths as Windows-/Linux-only). A post-merge matrix
   smoke catches those before they reach a release tag.
3. **Peer-validated baseline.** The PR-side workflow is structurally cc-switch's
   `ci.yml`, just expanded to call the project's full `pnpm check` aggregate.
   The matrix-on-`main` addition is what cc-switch lacks; we add it because our
   `src-tauri/` has more Windows-specific surface than cc-switch does.
4. **Two files, not twelve.** Stays well below GitButler-level YAML mass while
   covering the same risks for our v1.0 scope.

**Re-evaluate when**: (a) a cross-platform regression actually ships to a release
because the `main`-only matrix caught it too late → promote the matrix to PR-time;
(b) CI minutes become a cost issue (only relevant for private repos; we're public,
so unlimited); (c) we add an integration-test layer that actually exercises Tauri
IPC → at that point add a `tauri-driver`-based smoke job.

### Required `.github/workflows/ci.yml` (PR-fast path)

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  frontend:
    name: Frontend (typecheck · lint · format · vitest)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: '20'

      - name: Setup pnpm
        uses: pnpm/action-setup@v6
        with:
          version: 10.12.3
          run_install: false

      - name: Resolve pnpm store path
        id: pnpm-store
        shell: bash
        run: echo "path=$(pnpm store path --silent)" >> $GITHUB_OUTPUT

      - name: Cache pnpm store
        uses: actions/cache@v5
        with:
          path: ${{ steps.pnpm-store.outputs.path }}
          key: ${{ runner.os }}-pnpm-store-${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: ${{ runner.os }}-pnpm-store-

      - run: pnpm install --frozen-lockfile

      - name: TypeScript typecheck
        run: pnpm typecheck

      - name: ESLint (max-warnings=0; baseline-aware)
        run: pnpm lint

      - name: Prettier format check
        run: pnpm format:check

      - name: Vitest (unit + contract)
        run: pnpm test

  backend:
    name: Backend (fmt · clippy · cargo test)
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v6

      - name: Setup Rust toolchain
        uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy

      - name: Install Linux system deps for Tauri
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends \
            build-essential pkg-config libssl-dev \
            libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev
          sudo apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev \
            || sudo apt-get install -y --no-install-recommends libwebkit2gtk-4.0-dev
          sudo apt-get install -y --no-install-recommends libsoup-3.0-dev \
            || sudo apt-get install -y --no-install-recommends libsoup2.4-dev

      - name: Cache cargo registry + target
        uses: actions/cache@v5
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            src-tauri/target
          key: ${{ runner.os }}-cargo-${{ hashFiles('src-tauri/Cargo.lock') }}
          restore-keys: ${{ runner.os }}-cargo-

      - name: Frontend dist placeholder (so tauri::generate_context macro is happy)
        run: mkdir -p dist

      - name: cargo fmt --check
        run: cargo fmt --check --manifest-path src-tauri/Cargo.toml

      - name: cargo clippy -- -D warnings
        run: cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

      - name: cargo test
        run: cargo test --manifest-path src-tauri/Cargo.toml
```

### Required `.github/workflows/ci-cross-platform.yml` (push-to-`main` smoke)

```yaml
name: CI (cross-platform smoke)

on:
  push:
    branches: [main]

concurrency:
  group: ci-cross-${{ github.ref }}
  cancel-in-progress: true

jobs:
  rust-smoke:
    name: Rust smoke (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14   # Apple Silicon
          - os: windows-2022

    steps:
      - uses: actions/checkout@v6

      - name: Setup Rust toolchain
        uses: dtolnay/rust-toolchain@stable

      - name: Cache cargo registry + target
        uses: actions/cache@v5
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            src-tauri/target
          key: ${{ runner.os }}-cargo-smoke-${{ hashFiles('src-tauri/Cargo.lock') }}
          restore-keys: ${{ runner.os }}-cargo-smoke-

      - name: Frontend dist placeholder
        shell: bash
        run: mkdir -p dist

      - name: cargo check (catches platform-specific compile errors)
        run: cargo check --manifest-path src-tauri/Cargo.toml --all-targets

      - name: cargo test (catches platform-specific test failures)
        run: cargo test --manifest-path src-tauri/Cargo.toml
```

> Why not include `clippy` on the matrix? Clippy lints are platform-agnostic in
> 95%+ of cases; running it 3x triples the wall-clock for marginal value. We
> rely on the PR-side Linux clippy run for lint coverage, and the matrix for
> compile/runtime platform divergence.
>
> Why not `cargo build --release`? Release builds are 5–10x slower than `cargo
> check`/`cargo test` and don't provide additional correctness signal (LLO is
> compile-mode-agnostic). The full release build happens on tag in ADR-007.

### Conventions

- **Concurrency cancellation** (`cancel-in-progress: true`) on PR refs so
  successive pushes don't burn runners on stale commits.
- **Cache keys include `runner.os`** so macOS / Windows / Linux don't poison
  each other's caches.
- **`restore-keys`** without the full hash so partial cache hits speed up
  cold runs after dependency bumps.
- **`fail-fast: false`** on the matrix so a Windows failure doesn't hide a
  separate macOS failure.

## Consequences

### Positive

- PR feedback under 6 minutes warm; mirrors the local `pnpm check` gate 1-for-1
  so contributors don't get surprises in CI.
- Cross-platform Rust compile / test failures caught within minutes of the merge
  commit landing on `main`, before they reach a release tag.
- Two workflows, ~150 lines total — readable and modifiable without a CI
  specialist.
- No release-grade work (bundling, signing, notarization) on the hot PR path —
  those live in ADR-007's `release.yml` and only run on tag pushes.

### Negative

- The window between "PR merges" and "matrix smoke confirms cross-platform OK"
  is ~10 minutes. A maintainer needs to actually look at the cross-platform
  result, not assume the PR-side green checkmark covered everything.
- macOS / Windows runner queue times occasionally spike (GitHub-side capacity
  issue, not ours); on-`main` smoke can lag by 15+ minutes during peak load.
  Acceptable because nothing blocks on it.

### Neutral / TODO

- Set up a GitHub branch protection rule on `main` that requires both PR-side
  jobs (`Frontend` and `Backend`) green before merge. **Do not** make
  `rust-smoke` (cross-platform) required — it runs after merge by design.
- Add a "if `rust-smoke` fails on `main`" Slack/Discord/email notification so a
  cross-platform regression doesn't sit unnoticed.
- If the project grows e2e tests (e.g. via `tauri-driver` or Playwright against
  a built `.app`), add a third workflow file `ci-e2e.yml` triggered nightly
  rather than per-PR — e2e is too slow for PR-blocking.
- Consider `rust-cache` action from `Swatinem/rust-cache` v2 for finer-grained
  cargo cache invalidation if the basic `actions/cache` proves too coarse.

## References

- `cc-switch` `ci.yml` (Linux-only, 2 parallel jobs — the structural baseline):
  <https://github.com/farion1231/cc-switch/blob/main/.github/workflows/ci.yml>
- `cc-switch` `release.yml` (the full multi-platform pipeline we partition out
  into ADR-007 instead of inlining into CI):
  <https://github.com/farion1231/cc-switch/blob/main/.github/workflows/release.yml>
- GitButler workflow set (12 files — example of "too much" for our scope):
  <https://github.com/gitbutlerapp/gitbutler/tree/master/.github/workflows>
- Spacedrive `ci.yml` (per-platform smoke on every PR — example of "more
  thorough but slower"):
  <https://github.com/spacedriveapp/spacedrive/blob/main/.github/workflows/ci.yml>
- Tauri 2 GitHub pipelines guide:
  <https://v2.tauri.app/distribute/pipelines/github/>
- `tauri-action` v0.6.2 (used by ADR-007's release pipeline, mentioned here for
  cross-reference): <https://github.com/tauri-apps/tauri-action>
- `dtolnay/rust-toolchain` action (used in CI snippets):
  <https://github.com/dtolnay/rust-toolchain>
- `pnpm/action-setup` v6 (matches cc-switch's pnpm version pin):
  <https://github.com/pnpm/action-setup>
- `Swatinem/rust-cache` (alternative cache action — listed for future
  reference): <https://github.com/Swatinem/rust-cache>
