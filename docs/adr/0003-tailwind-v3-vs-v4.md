# ADR-003 · Tailwind CSS v3 vs v4

**Status**: Proposed (awaiting review)
**Date**: 2026-05-27

## Context

We currently ship `tailwindcss ^3.4.19` with a JS-based `tailwind.config.ts`, PostCSS, and
a small set of custom tokens. Tailwind v4.0 GA'd on 2025-01-22 and is now at v4.2
(February 2026 release line). The upgrade touches three things at once: a Rust-based engine
(Oxide), a CSS-native `@theme` configuration system, and a class-name canonicalization pass
that renames a handful of utilities (most notably `bg-gradient-to-*` → `bg-linear-to-*`).

This decision is closely coupled with ADR-002 (shadcn/ui CLI adoption). shadcn/ui v4 is
the first release that targets Tailwind v4 by default — running `shadcn@latest init` in a
v4 project gives us a different starting layout than in a v3 project, so we want to pick a
target before doing the migration.

## Options considered

### Option A · Upgrade to Tailwind v4

- Source: `tailwindcss` v4.0 GA 2025-01-22, v4.2 February 2026
  ([upgrade guide](https://tailwindcss.com/docs/upgrade-guide), [migration overview](https://www.digitalapplied.com/blog/tailwind-css-v4-2026-migration-best-practices)).
- Pros:
  - 5–10x faster cold builds; full rebuilds drop from ~3.5s to <100ms, incremental
    rebuilds measured in single-digit ms
    ([benchmarks](https://www.digitalapplied.com/blog/tailwind-css-v4-2026-migration-best-practices)).
    For a dev loop that runs `vite` + `tauri dev` simultaneously this is meaningful.
  - CSS-native `@theme` directive removes a layer of JS indirection; tokens live with
    the styles.
  - shadcn/ui v4 expects v4 — every primitive ships with `data-slot` attributes that
    Tailwind v4's CSS engine consumes natively
    ([shadcn Tailwind v4 page](https://ui.shadcn.com/docs/tailwind-v4)).
  - Automated migration via `npx @tailwindcss/upgrade` handles ~90% of mechanical
    rewrites ([migration guide](https://www.digitalapplied.com/blog/tailwind-css-v4-2026-migration-best-practices)).
- Cons:
  - Tailwind v4 targets modern browsers only — uses bleeding-edge CSS features like
    `@property`, `color-mix()`, and cascade layers
    ([shadcn doc](https://ui.shadcn.com/docs/tailwind-v4)). Inside a Tauri webview this
    is fine (Tauri uses the system WebView — WebView2 / WebKit / WKWebView — which all
    support these features on supported OS versions). Worth verifying on our minimum OS
    targets.
  - Breaking renames touch every gradient utility we have (`bg-gradient-to-r` →
    `bg-linear-to-r`, etc.).
  - Some PostCSS plugins lose compatibility; our pipeline is small so this is contained.
- Who uses it: shadcn/ui itself defaults to v4 for new projects since the February 2026
  release ([changelog](https://ui.shadcn.com/docs/changelog)); the broader ecosystem
  has adopted it widely enough that Tailwind themselves consider it production-ready
  ([upgrade guide](https://tailwindcss.com/docs/upgrade-guide)).

### Option B · Stay on Tailwind v3.4.x

- Source: `tailwindcss` 3.4.x (we're on 3.4.19).
- Pros:
  - Zero migration work.
  - JS config file is what most existing contributors know.
  - `cc-switch` is currently on 3.4 too ([deepwiki](https://deepwiki.com/farion1231/cc-switch)),
    so staying matches the only peer we cross-reference.
- Cons:
  - Locks us out of shadcn/ui v4's default workflow — we'd have to keep telling the CLI
    to scaffold v3-flavored components.
  - v3 is in maintenance mode; no new features, only critical fixes.
  - We keep paying the slower build cost forever.
  - **Deprecation trajectory.** v3 is not marked deprecated today, but with v4 GA more
    than a year old, the writing is on the wall.
- Who uses it: any project that has not yet migrated. Many production codebases are
  here today simply because they haven't done the work; that's not a vote for v3.

## Decision

**Chosen**: **Option A — upgrade to Tailwind v4**, sequenced **immediately after ADR-002
(shadcn CLI adoption)**.

**Reasoning**:

1. **Coupling with ADR-002.** Doing shadcn adoption on v3 and then upgrading to v4 is two
   migrations; doing them in one ordered pair is one. shadcn v4 expects Tailwind v4.
2. **Build-loop ROI.** A 5–10x improvement in Vite/Tailwind cold-build time is felt every
   single day; this is the rare "framework upgrade pays back this quarter" case.
3. **No deprecated path.** Staying on v3 is the slow lane to a forced future migration on
   someone else's timeline.
4. **Webview compatibility risk is contained.** Tauri's WebView2 (Win) / WKWebView (macOS)
   / WebKitGTK (Linux) all support the modern CSS that v4 emits on every OS version we
   currently target. We'll verify with a smoke test on Windows 10 (oldest WebView2), macOS
   13, and Ubuntu 22.04 before merging.
5. **Reversible at low cost.** If the smoke tests fail, the codemod is one-way but
   `git revert` is not — we'll do the upgrade on a branch and dogfood for a week before
   shipping.

**Order of operations**:

1. ADR-002 lands first: run `shadcn init` on the current v3 setup.
2. Run `pnpm dlx @tailwindcss/upgrade` on a feature branch.
3. Hand-fix the ~10% the codemod misses (almost all gradient utilities).
4. Smoke-test on all three OS targets before merge.

## Consequences

### Positive

- Significantly faster dev loop.
- Aligned with shadcn/ui v4's defaults.
- One source of truth for design tokens via `@theme`.

### Negative

- One-time migration cost (estimate: 1–2 days including OS smoke tests).
- Slightly stricter browser-version floor; documented in `README.md` system requirements.
- Hand-rolled `tailwind.config.ts` becomes a small CSS `@theme` block; reviewers need
  to know where tokens moved to.

### Neutral / TODO

- Add a CI job that runs the production build on each OS to catch webview-specific CSS
  regressions before users do.
- Document the minimum supported WebView2 / WKWebView versions in `README.md`.
- Delete `postcss.config.js` if v4's setup removes the need (it usually does).

## References

- Tailwind official upgrade guide:
  <https://tailwindcss.com/docs/upgrade-guide>
- Tailwind v4 2026 migration best-practices write-up:
  <https://www.digitalapplied.com/blog/tailwind-css-v4-2026-migration-best-practices>
- DEV.to community migration guide (2026):
  <https://dev.to/pockit_tools/tailwind-css-v4-migration-guide-everything-that-changed-and-how-to-upgrade-2026-5d4>
- shadcn/ui Tailwind v4 compatibility page:
  <https://ui.shadcn.com/docs/tailwind-v4>
- shadcn/ui changelog (v4 default for new projects):
  <https://ui.shadcn.com/docs/changelog>
- `cc-switch` (currently on Tailwind 3.4):
  <https://deepwiki.com/farion1231/cc-switch>
