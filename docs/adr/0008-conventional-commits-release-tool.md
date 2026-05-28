# ADR-008 · Conventional Commits and release-automation tool

**Status**: Accepted (Option D, 2026-05-27 — maintainer override of Option B recommendation)
**Date**: 2026-05-27

## Decision summary (TL;DR)

- **Commit style**: Conventional Commits — required, enforced in `CONTRIBUTING.md`
- **Release tooling**: **Manual** (Option D). At each release, the maintainer manually
  bumps the version in `package.json`, `Cargo.toml`, and `tauri.conf.json`; writes a
  `CHANGELOG.md` entry; pushes a `vX.Y.Z` tag; ADR-007's `release.yml` does the rest.
- **No `release-please-config.json`, no release-PR bot, no `semantic-release`** at v0.x.
- **Re-evaluate** if (a) we ship a version-number mismatch bug in production, or
  (b) release cadence climbs above ~monthly and the manual bump becomes real friction.

**Why this overrides the analysis below**: the analysis's own peer evidence pointed
to Option D — GitButler (30k★, same Tauri-app shape) and `cc-switch` (sibling
project) both ship purely manual versioning. release-please is a Google + Node-world
convention that is not the Tauri-desktop norm. At v0.x with a small release cadence,
"one fewer dependency, one fewer point of failure" beats automation-for-its-own-sake.

The full Option-by-Option analysis is preserved below for the historical record and
for future re-evaluation.

---

## Context

`git-ai-studio` is a single-binary desktop app (not a published library, not an npm
package, not a Cargo crate published to crates.io). The "release" we ship is a tagged
GitHub Release with platform binaries from ADR-007's `release.yml`. There is no
crates.io publish, no npm publish.

What we still need from a release tool:

1. **CHANGELOG generation** — users browsing GitHub Releases should see what changed,
   not just "v1.2.3."
2. **Version bumping** — `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml` (and `Cargo.lock`) all carry a version. Bumping them
   manually in three places per release is exactly the kind of thing that goes wrong.
3. **Tag creation** — git tag → CI trigger → release artifacts.
4. **Conventional Commits enforcement** — gives the tool a deterministic input and
   gives reviewers a predictable commit log.

Existing precedent in the reference Tauri-desktop set:

- **`cc-switch`** — manual version bump + manual tag + handwritten release notes
  (4 languages, in `release.yml`'s body field).
- **GitButler** — manual versioning via a custom `scripts/next.sh` shell script
  driven by a `workflow_dispatch` input (`patch` / `minor` / `major`). No
  semantic-release / release-please / changesets present. Notable: a 30k-star
  Tauri project still does this by hand.
- **Spacedrive** — manual tag-based triggering (`push: tags: ['v*']`); no automated
  version-bump tooling visible.

So the "everyone fancy uses release-please" hypothesis isn't borne out by peer
data — production Tauri apps tend to do it by hand or with a custom script.
That doesn't mean we should; it means automation is genuinely optional here, and
the bar for "is this tool worth the YAML" is honest.

## Options considered

### Option A · Conventional Commits + `changesets`

- Source: `@changesets/cli` v2.x, 11.9k stars, latest release `@changesets/changelog-github@0.7.0`
  on 2026-05-05 ([GitHub](https://github.com/changesets/changesets)). Built and
  maintained by the Atlassian/Thinkmill ecosystem; primary users are
  monorepos like pnpm itself, Astro, Remix, Sentry, Chakra UI.
- Behaviour: each PR adds a `.changeset/*.md` file describing the change and a bump
  type. CI accumulates changesets, then a "Version Packages" PR collapses them into
  a version bump + CHANGELOG entry.
- Pros:
  - Most "human-in-the-loop" — the changeset author writes the user-facing summary,
    so CHANGELOG quality is high.
  - Excellent monorepo support; if we ever split the Rust core into a separate
    crate, changesets handles independent versioning.
- Cons:
  - **TypeScript-only — does not touch `Cargo.toml` or `tauri.conf.json`**
    ([changesets repo confirms 99.9% TS, no Rust support](https://github.com/changesets/changesets)).
    We'd still need a custom script for the Rust-side version bump.
  - The "extra file per PR" workflow is overkill for a single-binary desktop app
    with one version number.
  - No native Tauri/Rust project in our reference set uses it.

### Option B · Conventional Commits + `release-please` (Google)

- Source: `googleapis/release-please` 6.9k stars, latest **v17.6.1 on 2026-05-26**
  ([GitHub](https://github.com/googleapis/release-please)). Language-agnostic with
  built-in "rust" strategy that updates `Cargo.toml` versions.
- Behaviour: every push to `main` triggers a GitHub Action; the Action parses
  Conventional Commits since the last release tag, opens (or updates) a
  "release-please" PR with a CHANGELOG diff + version bumps. When merged, it
  creates the git tag + GitHub Release — which in turn fires our `release.yml`
  from ADR-007.
- Pros:
  - **Native Rust support** — the `rust` strategy edits `Cargo.toml`. Handles
    `tauri.conf.json` via the `generic` strategy or a custom updater plugin.
  - Used by every Google open-source project (Puppeteer, Angular, googleapis SDKs)
    and a growing number of Rust projects → maintainership risk is low.
  - "Release PR" model means a maintainer always gets one click to approve a
    release; no surprise auto-publishes.
  - Native GitHub Action (`googleapis/release-please-action`) — no Node script
    in CI to maintain.
- Cons:
  - The Cargo.toml editor "strips all TOML comments" on first version bump
    ([release-please issue #704](https://github.com/googleapis/release-please/issues/704))
    — a one-time annoyance we can pre-empt by removing comments from the version
    block.
  - Requires `.release-please-manifest.json` + `release-please-config.json` — two
    extra config files in the repo root.
  - CHANGELOG quality is bounded by commit-message quality; sloppy commits =
    sloppy changelog.

### Option C · Conventional Commits + `semantic-release`

- Source: `semantic-release/semantic-release` 23.7k stars, latest **v25.0.3 on
  2026-01-30** ([GitHub](https://github.com/semantic-release/semantic-release)).
- Behaviour: every push to `main` that contains a `feat:` or `fix:` commit is
  **immediately** published with a new version — no human-in-the-loop PR.
- Pros:
  - Most automated; truly hands-off.
  - Largest ecosystem (23k stars).
- Cons:
  - **No native Rust/Cargo support** — would require a custom plugin we'd have to
    write and maintain ([repo confirms JS/Node focus](https://github.com/semantic-release/semantic-release)).
  - "Auto-publish on every merge" is the wrong default for a desktop app — we
    want to batch features into intentional releases (e.g. "v1.2 = i18n
    overhaul"), not ship a v1.0.43 every Tuesday.
  - The hands-off model means a typo in a `feat:` subject becomes a public
    release note immediately; less forgiving than release-please's PR review.

### Option C′ · `release-plz` (Rust-native, mentioned for completeness)

- Source: `release-plz/release-plz` 1.4k stars, latest **v0.3.158 on 2026-05-10**
  ([GitHub](https://github.com/release-plz/release-plz)).
- Behaviour: inspired by release-please but optimized for publishing **Rust crates
  to crates.io** — compares local `Cargo.toml` versions against the cargo registry
  to decide what to publish, runs `cargo-semver-checks`, opens a release PR.
- Why **not** chosen here: we ship a **desktop binary**, not a published crate.
  release-plz's killer feature (auto-publish to crates.io with semver-checks) is
  irrelevant — we never invoke `cargo publish`. release-please covers our needs
  (Cargo.toml bump + changelog + tag) without dragging in the crates.io
  publishing pipeline. Reconsider only if we later extract a public crate from
  this repo.

### Option D · Conventional Commits + handwritten CHANGELOG

- Source: zero — pure git + text editor.
- Pros:
  - Zero new tooling in CI.
  - cc-switch and GitButler (a 30k-star Tauri app) both essentially do this.
  - Maintainer has full editorial control over the release narrative.
- Cons:
  - Version bumps happen in three files per release; rebase conflicts are common
    when two PRs both touch the version block.
  - CHANGELOG quality entirely depends on whether the maintainer remembers to
    update it before tagging.
  - For an OSS project that wants outside contributors, "the release process is
    in the maintainer's head" is a bus factor of 1.

## Decision

**Chosen**: **Option B — Conventional Commits + `release-please` (with native
`rust` + `generic` extra-files strategies for `tauri.conf.json`).**

**Reasoning**:

1. **Multi-file version sync is the actual pain.** Three files
   (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) have to
   stay in lockstep on every release. release-please does this in one PR;
   anything else (handwritten or changesets) requires custom glue.
2. **PR-review gate preserves editorial control.** Unlike semantic-release's
   "auto-publish on merge," release-please opens a PR a maintainer must merge.
   We keep the "intentional release" property GitButler gets from its
   `workflow_dispatch` flow, but without writing the `next.sh` script ourselves.
3. **CHANGELOG quality is automatic enough.** Conventional Commits + the
   `release-please` group/scope syntax produces a structured CHANGELOG that's
   good enough for v1.x; we can hand-edit the release-please PR before merging
   if a particular release deserves a polished narrative.
4. **Bus factor.** When a contributor wants to ship a release, the process is
   "merge the release-please PR" — discoverable from GitHub UI, not tribal
   knowledge.
5. **Maturity / maintainership.** 6.9k stars, v17.6.1 in May 2026, maintained
   by Google — comfortably above the "is this actually maintained?" bar that
   ADR-001's guiding principles require.

**Re-evaluate when**: (a) we add a published Cargo crate (e.g. spin out
`git-ai-studio-core`) — at that point `release-plz` becomes attractive because
its `cargo publish` integration is the missing piece; (b) we move to a monorepo
with multiple independently-versioned packages — at that point `changesets`'
per-package versioning is the right primitive; (c) release-please falls behind
on maintenance (e.g. no release in 6 months) — fall back to handwritten
CHANGELOG + a single custom version-bump script, matching cc-switch.

### Required commit format (enforced by lint-staged + commitlint)

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

`type` ∈ {`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`}. Breaking changes: `feat!:` or
`BREAKING CHANGE:` footer.

### Required `release-please-config.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "rust",
  "packages": {
    ".": {
      "release-type": "rust",
      "package-name": "git-ai-studio",
      "changelog-path": "CHANGELOG.md",
      "include-component-in-tag": false,
      "extra-files": [
        { "type": "json", "path": "package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "src-tauri/tauri.conf.json", "jsonpath": "$.version" }
      ]
    }
  },
  "bootstrap-sha": "<commit-sha-of-v1.0.0-tag>"
}
```

### Required `.release-please-manifest.json`

```json
{
  ".": "1.0.0"
}
```

### Required `.github/workflows/release-please.yml`

```yaml
name: release-please

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

When the release-please PR is merged, it creates `v1.x.y` tag → triggers
ADR-007's `release.yml` → builds + uploads platform binaries to the Release.

## Consequences

### Positive

- One PR per release, with a generated CHANGELOG diff a maintainer reviews and
  merges. Editorial control preserved without manual file-juggling.
- `package.json`, `Cargo.toml`, `tauri.conf.json` always agree on the version
  number — no more "v1.2.0 in tauri.conf.json, v1.1.9 in Cargo.toml" mismatch bugs.
- Conventional Commits enforcement (via commitlint) gives reviewers a predictable
  commit history, which is also good for `git blame` archeology.
- Release-trigger pipeline is two-stage and decoupled: release-please owns the
  version-bump tag, ADR-007's `release.yml` owns the binary build. Either can
  be debugged without touching the other.

### Negative

- Three new config files in the repo root (`release-please-config.json`,
  `.release-please-manifest.json`, `release-please.yml`).
- Contributors must learn Conventional Commits format; expect the first 1–2 PRs
  per new contributor to need a "please reword as `fix: ...`" comment.
- release-please will strip TOML comments from `Cargo.toml`'s `[package]` block
  on first run ([known issue #704](https://github.com/googleapis/release-please/issues/704)).
  Pre-empt by removing comments from that block before adoption.
- We depend on Google maintaining release-please. Mitigation: the tool's input
  is plain Conventional Commits and its output is a normal git tag; we can swap
  to handwritten CHANGELOG with one PR if it ever goes unmaintained.

### Neutral / TODO

- Set up `commitlint` + `husky` (or `lefthook`, since the project already uses
  Rust) so non-Conventional Commits are blocked locally before push.
- Add a `CONTRIBUTING.md` section explaining the Conventional Commits format
  with concrete `git-ai-studio` examples (e.g.
  `feat(blame): add 30-day filter to Blame view`).
- For the v1.0.0 release specifically, write the CHANGELOG by hand — there's no
  Conventional Commits history before adoption. Set `bootstrap-sha` in the
  config to the v1.0.0 tag commit so release-please starts fresh from v1.1.0.

## References

- release-please repo (6.9k stars, v17.6.1 on 2026-05-26):
  <https://github.com/googleapis/release-please>
- release-please-action (GitHub Action wrapper):
  <https://github.com/googleapis/release-please-action>
- release-please Rust strategy reference (Cargo.toml editor):
  <https://github.com/googleapis/release-please/blob/main/docs/customizing.md#rust>
- release-please known issue: strips TOML comments on first run:
  <https://github.com/googleapis/release-please/issues/704>
- Changesets repo (11.9k stars, TypeScript-only, monorepo-focused):
  <https://github.com/changesets/changesets>
- semantic-release repo (23.7k stars, no native Rust support):
  <https://github.com/semantic-release/semantic-release>
- release-plz repo (Rust-native, 1.4k stars, v0.3.158 on 2026-05-10 — relevant
  only if we publish to crates.io): <https://github.com/release-plz/release-plz>
- Conventional Commits spec: <https://www.conventionalcommits.org/>
- `cc-switch` (manual versioning, peer comparison):
  <https://github.com/farion1231/cc-switch>
- GitButler `publish.yaml` (custom `scripts/next.sh`, peer comparison):
  <https://github.com/gitbutlerapp/gitbutler/blob/master/.github/workflows/publish.yaml>
- The Ultimate Guide to NPM Release Automation (semantic-release vs release-please
  vs changesets, 2026): <https://oleksiipopov.com/blog/npm-release-automation/>
