# ADR-002 · Adopt the shadcn/ui CLI

**Status**: Proposed (awaiting review)
**Date**: 2026-05-27

## Context

The current UI stack is "half-shadcn": we ship a handful of Radix UI primitives (Dialog,
Popover, Tooltip, etc.) hand-wired with Tailwind utility classes and a `cn()` helper. We
do not use the `shadcn` CLI. Every new component is copy-pasted from the public shadcn
registry by hand, then trimmed.

This worked while the design surface was small, but it has three growing costs:

1. **Inconsistency.** Spacing, focus rings, and dark-mode tokens drift between
   components because each one is hand-rolled.
2. **Upgrade tax.** When Radix UI ships a new version, we have to remember which of our
   bespoke wrappers consume it; the official shadcn CLI's `shadcn diff` and `shadcn apply`
   commands handle this automatically.
3. **Contributor onboarding.** Asking new contributors to copy-paste from a website and
   "adjust to our style" is a worse experience than `pnpm dlx shadcn@latest add button`.

The sibling project `cc-switch` already uses the shadcn CLI in production
([deepwiki](https://deepwiki.com/farion1231/cc-switch)), and the shadcn project itself
shipped CLI v4 in March 2026 with explicit Tauri-friendly primitives (offline registry
support, design-system presets).

## Options considered

### Option A · Adopt the shadcn/ui CLI officially

- Source: `shadcn` 4.8.0, published 2026-05-22, weekly releases
  ([npm](https://www.npmjs.com/package/shadcn?activeTab=versions)). CLI v4 landed
  March 2026 ([changelog](https://ui.shadcn.com/docs/changelog/2026-03-cli-v4)).
- Pros:
  - Full Tailwind v4 + React 19 compatibility ([shadcn docs](https://ui.shadcn.com/docs/tailwind-v4)).
  - Components live in our source tree (not as a dependency) — same "you own the code"
    model we already follow, just with a CLI that automates the copy step.
  - February 2026 release unified Radix UI into a single `radix-ui` package
    ([changelog](https://ui.shadcn.com/docs/changelog/2026-02-radix-ui)), which simplifies
    our dependency graph.
  - `shadcn diff` and `shadcn apply` give us a real upgrade path instead of re-copying.
  - Presets engine (March 2026) lets us pin our color palette and radius once.
- Cons:
  - One more tool in the contributor toolbox (`pnpm dlx shadcn@latest …`).
  - The "AI Agent Skills" feature added in CLI v4 is irrelevant to us and adds surface area.
- Who uses it: `cc-switch` ([deepwiki](https://deepwiki.com/farion1231/cc-switch)), the
  `tauri-ui` starter ([agmmnn/tauri-ui](https://github.com/agmmnn/tauri-ui)), and the
  `tauri-app-template` reference repo
  ([kitlib/tauri-app-template](https://github.com/kitlib/tauri-app-template)) all ship
  shadcn/ui as the default component layer.

### Option B · Keep manually copying from the shadcn registry

- Pros:
  - Zero process change.
  - Maximum control — we already trim every component to taste.
- Cons:
  - Drift between components keeps growing.
  - No automated way to pick up upstream fixes (e.g. recent a11y improvements to
    `Popover` and `Select` shipped in shadcn's April / May 2026 releases —
    [changelog](https://ui.shadcn.com/docs/changelog)).
  - Contributors keep re-deriving the same wrappers.
- Who uses it: in 2025 this was viable; in 2026 the CLI has matured enough that
  no major reference project I can find still recommends it.

### Option C · Build a fully bespoke component library on Radix primitives

- Pros:
  - Maximum stylistic ownership.
  - No CLI in the toolchain at all.
- Cons:
  - Massive ongoing cost for what is fundamentally undifferentiated UI work — buttons,
    dialogs, and tooltips should not be where we spend engineering time.
  - Cuts us off from the shadcn ecosystem (blocks, theme presets, community fixes).
  - Violates "no tech for tech's sake" in the opposite direction — reinventing tech we
    can adopt with one CLI command.
- Who uses it: a handful of design-system-heavy products (e.g. Linear, Vercel) — none of
  which look like our use case.

## Decision

**Chosen**: **Option A — adopt the shadcn/ui CLI officially**.

**Reasoning**:

1. **We're already 80% there.** We ship Radix + Tailwind + a `cn()` helper. The shadcn CLI
   is the missing 20% (a real upgrade story, presets, registry-aware codegen). The cost of
   adoption is essentially "run `init` once and re-import the existing components."
2. **Peer parity.** The closest peer project (`cc-switch`) made the same call and benefits
   from it; we should not gratuitously diverge.
3. **Maturity gate passed.** shadcn CLI v4 is two months old and is already on patch 4.8.x
   with weekly releases. The unified `radix-ui` package (February 2026) eliminated the
   prior "many small radix packages" problem.
4. **Reversible.** Components live in our repo. If shadcn goes off the rails we keep
   everything we have and just stop running the CLI — there is no runtime dependency to
   pry out.

## Consequences

### Positive

- New components arrive consistently via `pnpm dlx shadcn@latest add <name>`.
- Upgrades become a `shadcn diff` review instead of a manual re-derive.
- Theme tokens consolidate behind a preset, fixing dark-mode drift.
- Contributor docs shrink to one command.

### Negative

- Contributors must have a modern Node available for `pnpm dlx` (already true).
- We adopt the CLI's opinions about file layout (`components/ui/*`); existing component
  paths need a one-time migration.

### Neutral / TODO

- Run `pnpm dlx shadcn@latest init` in a follow-up PR; commit the generated
  `components.json` and the consolidated `radix-ui` dep change in a single commit so the
  diff is auditable.
- Migrate existing hand-rolled wrappers to the CLI-generated equivalents in batches per
  page, not in a single mega-PR.
- Document the preset (colors / radius) in `docs/design.md` once chosen.

## References

- shadcn npm versions (4.8.0 as of 2026-05-22):
  <https://www.npmjs.com/package/shadcn?activeTab=versions>
- CLI v4 announcement (March 2026):
  <https://ui.shadcn.com/docs/changelog/2026-03-cli-v4>
- Unified Radix UI package (February 2026):
  <https://ui.shadcn.com/docs/changelog/2026-02-radix-ui>
- shadcn Tailwind v4 compatibility:
  <https://ui.shadcn.com/docs/tailwind-v4>
- shadcn changelog:
  <https://ui.shadcn.com/docs/changelog>
- `cc-switch` deepwiki (confirms shadcn + Tailwind + Radix stack):
  <https://deepwiki.com/farion1231/cc-switch>
- `tauri-ui` starter:
  <https://github.com/agmmnn/tauri-ui>
- `tauri-app-template` reference:
  <https://github.com/kitlib/tauri-app-template>
