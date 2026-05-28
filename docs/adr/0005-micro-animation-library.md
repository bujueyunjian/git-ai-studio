# ADR-005 · Micro-animation library

**Status**: Proposed (awaiting review)
**Date**: 2026-05-27

## Context

We have no animation library today. The Dashboard polish task (number-tickers, chart
fade-in, route transitions, success toasts) is going to need either (a) a library, (b)
CSS transitions hand-rolled in Tailwind, or (c) Radix's built-in animation primitives
plus `tailwindcss-animate`.

The animation surface we actually need is small:

- Number "count up" on dashboard cards.
- Fade/slide-in for chart panels on first paint.
- Spring on the "active" indicator in the side nav.
- Subtle hover/press feedback on action buttons.
- Potential layout animation when ranges change on Stats.

We are explicitly **not** building rich gesture, scroll-linked, or timeline-based
animations. This is a desktop dashboard, not a marketing site.

## Options considered

### Option A · Motion (formerly Framer Motion)

- Source: `motion` package, latest is v12.x as of 2026-05.
  - GitHub: ~29.6k stars
    ([motiondivision/motion](https://github.com/motiondivision/motion)).
  - npm: ~1.7M weekly downloads on the new `motion` package, with the legacy
    `framer-motion` package still at multi-million weekly
    ([npm trends](https://npmtrends.com/motion), [motion npm](https://www.npmjs.com/package/motion)).
  - Renamed from `framer-motion` to `motion` in 2025 when it became an independent
    project ([fireup.pro coverage](https://fireup.pro/news/framer-motion-becomes-independent-introducing-motion));
    the React import path is now `motion/react`.
- Pros:
  - Industry standard for React animation; every contributor recognizes `<motion.div>`.
  - Tree-shakable; you can import only what you use.
  - `LayoutGroup` / `AnimatePresence` solve route-transition and chart-mount cases out
    of the box.
  - Active maintenance, v12 is current.
- Cons:
  - Even the slim `m` API path adds meaningful bundle (~30 KB gzipped for typical
    use); not catastrophic, but real.
  - The legacy package name (`framer-motion`) is now **deprecated** in favor of `motion`
    — projects that still import from `framer-motion` are on borrowed time. Any new
    install must use `motion/react`.
- Who uses it: ubiquitous — Vercel, Linear's marketing site, countless OSS dashboards.
  Most React component libraries (including shadcn/ui's animated blocks) document
  motion-based examples.

### Option B · Pure CSS transitions + `tailwindcss-animate`

- Source: `tailwindcss-animate` is the Tailwind plugin shipped by shadcn/ui by default.
  Tailwind v4 ships first-class animation utilities natively.
- Pros:
  - Zero JS runtime cost — animation runs on the compositor.
  - Tailwind v4 has built-in `transition`, `animate`, `data-state` selectors that map
    directly onto Radix's `data-state="open" | "closed"` attributes.
  - No deps to upgrade, no library churn.
- Cons:
  - Layout transitions (FLIP) are not feasible without a library.
  - Number tickers require a small custom hook (raf + interpolation) — doable but
    re-implementing motion's `animate()`.
  - No physics-based springs — easings are CSS curves.
- Who uses it: shadcn/ui itself, by default — every primitive's open/close animation
  is pure CSS / `data-state` ([shadcn docs](https://ui.shadcn.com/docs/changelog)).

### Option C · Radix UI's built-in animations only

- Pros:
  - Already present (Radix is a dep).
  - Covers exactly the open/close cases for Dialog, Popover, Tooltip — which is most of
    what we have today.
- Cons:
  - Only covers Radix primitives. Doesn't help with chart fade-in, number tickers, or
    nav indicators.
  - Not really a standalone solution — needs Option B alongside it for everything
    non-Radix.

## Decision

**Chosen**: **Option B — pure CSS transitions + `tailwindcss-animate`** as the default,
with a documented carve-out to add **Option A (Motion)** *only* if and when we need real
layout (FLIP) animations.

**Reasoning**:

1. **Right-sized for the surface area.** Number tickers, chart fade-in, and hover
   feedback are all doable in <30 lines of CSS + a tiny `useCountUp` hook (~20 LOC). We
   don't need motion's full feature set.
2. **Zero runtime cost.** A desktop app where startup time is felt should not be paying
   30 KB gzipped for animations that the platform compositor can do natively.
3. **Aligned with shadcn/ui defaults.** Per ADR-002 we're adopting the shadcn CLI;
   shadcn's own animations are pure CSS via `data-state` selectors. Using the same
   approach for our non-Radix UI keeps the codebase coherent.
4. **No deprecated lock-in.** `framer-motion` (the old name) is on the way out; any
   adoption today must use the new `motion` package. By deferring, we also avoid the
   risk of churn if Motion changes its API in v13.
5. **Reversible.** If we ever need layout animations (e.g. a draggable Kanban-style
   refactor of People), we add Motion at that point — it composes cleanly with CSS for
   everything else.

**Re-evaluate when**: (a) we ship a feature that needs FLIP-style layout transitions,
(b) we need physics-based gestures (drag, momentum), (c) the count-up / fade-in code we
hand-roll grows past ~100 LOC across the codebase.

## Consequences

### Positive

- No runtime dep added.
- Coherent with shadcn/ui's defaults (also CSS-based).
- Animations run on the compositor — no JS-thread cost.

### Negative

- We hand-write a small `useCountUp` hook (one file, ~20 LOC) for number tickers.
- Future layout-animation features will require revisiting this ADR.

### Neutral / TODO

- Confirm `tailwindcss-animate` (or its v4 equivalent) is in the dep tree after the
  Tailwind v4 + shadcn migration in ADR-002 / ADR-003.
- Create a thin `src/lib/animations.ts` with the count-up hook + a couple of CSS
  variable helpers, so animation logic doesn't get sprinkled across components.
- Document the "no motion library" rule in `CONTRIBUTING.md` so contributors don't
  reflexively add it.

## References

- Motion (formerly Framer Motion) repo:
  <https://github.com/motiondivision/motion>
- Motion on npm:
  <https://www.npmjs.com/package/motion>
- npm trends comparing motion vs framer-motion:
  <https://npmtrends.com/motion>
- Coverage of the framer-motion → motion rename / independence:
  <https://fireup.pro/news/framer-motion-becomes-independent-introducing-motion>
- React animation library landscape 2026:
  <https://blog.logrocket.com/best-react-animation-libraries/>
- shadcn/ui changelog (CSS-based animations via `data-state`):
  <https://ui.shadcn.com/docs/changelog>
