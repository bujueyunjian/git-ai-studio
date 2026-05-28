# ADR-001 · Router selection

**Status**: Proposed (awaiting review)
**Date**: 2026-05-27

## Context

`git-ai-studio` ships a roughly 50-line hand-rolled hash router in `src/router.tsx`. It owns
the entire navigation surface: a fixed enum of routes (`dashboard`, `commits`, `commit/:sha`,
`stats`, `people`, `blame`, `hooks`, `settings`, `checkpoints`), `window.location.hash`
parsing, `hashchange` subscription, and a typed `navigate()` helper. There is no nested
routing, no SSR, no server loaders, no code-splitting boundary, and no plan for any of these
in the product roadmap (the app is a single-window Tauri shell pointed at a local git repo).

We periodically get asked "should we move to a real router?" — the question is whether the
ergonomic and ecosystem gains of an off-the-shelf router justify the added dependency,
build-time machinery (in TanStack Router's case), and migration cost for a navigation model
that is genuinely small and stable.

For desktop Tauri apps specifically there is no canonical answer: GitButler ships Svelte and
its own routing; Spacedrive's frontend is React + a hand-rolled router stack; `cc-switch`
(the sibling project we cross-reference) currently uses no router at all and switches views
via local state plus `react-i18next` for labels.

## Options considered

### Option A · Keep the hand-rolled hash router

- Source: `src/router.tsx`, ~50 LOC, zero external deps.
- Pros:
  - Zero bundle cost, zero new concepts in onboarding.
  - Hash routing is the friction-free choice inside a `tauri://localhost` webview — no need
    to configure Tauri's asset protocol to fall back to `index.html` on deep links.
  - Type-safety is already 100%: the route union is a TS literal, `navigate()` takes that
    union, so we get the same compile-time guarantees TanStack Router advertises, without
    the codegen.
- Cons:
  - No nested layouts, loaders, or pending UI primitives — we'd have to roll those if the
    product ever needs them.
  - No idiomatic primitive contributors recognize (`<Link>`, `useParams`, etc.).
- Who does this (or equivalent in-house solution): `cc-switch`
  ([deepwiki](https://deepwiki.com/farion1231/cc-switch)) ships no router at all; many small
  Tauri shells follow the same pattern.

### Option B · React Router v7 (library mode)

- Source: `react-router` v7.15.0 (2026-05-05), v7.14.2 latest patch as of 2026-05-27,
  ~20KB min ([npm](https://www.npmjs.com/package/react-router?activeTab=versions),
  [release notes](https://github.com/remix-run/react-router/releases)).
- Pros:
  - The most widely understood routing primitives in the React ecosystem; every contributor
    will recognize `<Routes>` / `<Route>` / `useNavigate`.
  - Smaller bundle than TanStack Router (~20KB vs ~45KB minified per the
    [pkgpulse comparison](https://www.pkgpulse.com/blog/tanstack-router-vs-react-router-v7-2026)).
  - Library mode works fine inside Tauri's webview; we don't need any framework features.
- Cons:
  - In library mode you lose almost all of v7's headline features (loaders, typed params,
    file-based routes); you basically get v6 with a new package name.
  - Params and search params are **not** type-safe by default — you type them yourself
    ([pkgpulse](https://www.pkgpulse.com/blog/tanstack-router-vs-react-router-v7-2026)).
  - Pays bundle weight for primitives we already have in 50 lines.
- Who uses it: documented as the default option in the `tauri-ui` starter
  ([agmmnn/tauri-ui](https://github.com/agmmnn/tauri-ui)); broadly the React ecosystem's
  default routing library.

### Option C · TanStack Router (library mode)

- Source: `@tanstack/react-router` 1.170.8 (released 2026-05-24),
  [npm](https://www.npmjs.com/package/@tanstack/react-router), actively maintained with
  weekly releases ([GitHub releases](https://github.com/TanStack/router/releases)).
- Pros:
  - End-to-end type safety: route params, search params, loader data fully typed without
    casts ([pkgpulse comparison](https://www.pkgpulse.com/blog/tanstack-router-vs-react-router-v7-2026)).
  - First-class search-param state management, which is genuinely useful for things like
    `?range=30d&author=...` filters on Stats / People.
  - Active development; the docs and DX have caught up to React Router's reach.
- Cons:
  - ~45KB minified — more than 2x React Router — and adds a Vite plugin for code-gen.
  - The advanced features (loaders, route trees, devtools) are sized for SPAs with deep
    nested data; our navigation graph is essentially flat with seven leaves.
  - Adds a build-time codegen step that maintainers have to learn and CI has to run.
- Who uses it: TanStack Router is the recommended template option in
  [`tauri-ui`](https://github.com/agmmnn/tauri-ui) and has growing adoption in greenfield
  React apps. No major Tauri desktop app in our reference set (GitButler, Spacedrive,
  Hoppscotch, AppFlowy) uses it; they either ship a non-React framework or have a custom
  routing layer.

## Decision

**Chosen**: **Option A — keep the hand-rolled hash router**.

**Reasoning**:

1. **Right-sized.** The router is 50 lines, has the type-safety TanStack Router charges
   45KB for, and has been stable through every feature release so far. None of the candidate
   features (nested layouts, loaders, file-based routing, SSR) are on the product roadmap
   for a single-window Tauri shell.
2. **No deprecation risk.** The thing we ship is plain `useState` + `hashchange`; both are
   web platform primitives. React Router and TanStack Router are both healthy, but every
   external router carries some non-zero churn risk (React Router v6 → v7 was a major
   upheaval for many teams; TanStack Router is on a weekly release cadence).
3. **Bundle discipline.** Tauri's selling point is small binaries. Spending 20–45KB of
   JS on something we already do correctly violates the "don't add tech for tech's sake"
   principle.
4. **Peer evidence.** The closest sibling project, `cc-switch`
   ([deepwiki](https://deepwiki.com/farion1231/cc-switch)), ships no router either. The
   precedent for "don't introduce a router in a small Tauri shell" is well-established.

**Re-evaluate when** any of the following becomes true: (a) we ship deep links from outside
the app, (b) we need nested layouts with independent suspense boundaries, (c) we add
URL-driven filter state to more than two pages and end up reinventing search-param parsing
— at that point TanStack Router (Option C) becomes the preferred swap because its type
safety beats React Router's library mode.

## Consequences

### Positive

- Zero new dependency, zero migration work.
- Routing surface stays auditable in one ~50-line file.
- Onboarding stays "read this one file."

### Negative

- New contributors who expect `<Link>` / `useParams` will need to learn `navigate()` and
  the route enum.
- If we ever need code-splitting per route, we'll be implementing it manually with
  `React.lazy` instead of getting it for free from the router.

### Neutral / TODO

- Add a one-paragraph comment to `src/router.tsx` linking to this ADR so the "why no
  React Router?" question is answered in-source.
- Add a test that asserts the route union covers every entry rendered in the side nav,
  so we can't silently ship a dead link.

## References

- TanStack Router vs React Router v7 deep-dive, 2026:
  <https://www.pkgpulse.com/blog/tanstack-router-vs-react-router-v7-2026>
- React Router 7.15.0 release notes:
  <https://github.com/remix-run/react-router/releases>
- React Router npm versions (7.14.2 latest stable as of 2026-05-27):
  <https://www.npmjs.com/package/react-router?activeTab=versions>
- TanStack Router npm (1.170.8):
  <https://www.npmjs.com/package/@tanstack/react-router>
- `tauri-ui` starter that offers Vite / Next.js / React Router / Astro / TanStack Start:
  <https://github.com/agmmnn/tauri-ui>
- `cc-switch` stack overview (no router):
  <https://deepwiki.com/farion1231/cc-switch>
- GitButler (Svelte, not React):
  <https://github.com/gitbutlerapp/gitbutler>
- Awesome Tauri (production app list):
  <https://github.com/tauri-apps/awesome-tauri>
