# ADR-004 · Runtime validation for Tauri IPC

**Status**: Proposed (awaiting review)
**Date**: 2026-05-27

## Context

All Tauri commands are routed through a single `call<T>()` wrapper in `src/lib/api.ts`.
Today, the only thing enforcing the IPC contract is:

1. TypeScript types in `src/lib/types.ts` (compile-time only).
2. A handful of `*.contract.test.ts` files that assert the TS types match the Rust
   `serde` shapes (also compile-time, via test-time codegen comparison).

There is no runtime validation on the data crossing the IPC boundary. In practice this
has been fine: the Rust side controls serialization via `serde`, and a bug there fails
loudly with a JSON deserialize error. But two failure modes are not caught today:

1. **Drift.** A Rust struct field gets renamed; the TS type is updated; a test passes; a
   third surface (e.g. a payload manually `JSON.parse`d from a notification) silently
   reads `undefined`.
2. **Foreign payloads.** Anything that originates outside our Rust code — git-notes
   contents, files we read from disk, schtasks output — could in principle return malformed
   JSON, and we currently coerce via `as T` instead of validating.

The question is whether to add a runtime schema validator (zod / valibot) at the IPC
boundary, or to keep relying on the compile-time discipline plus serde-side errors.

## Options considered

### Option A · Do not add a runtime validator; rely on serde + contract tests

- Pros:
  - Zero bundle cost (vs ~17KB for zod or ~2KB for valibot).
  - The Rust side is already authoritative — if a payload is wrong, the bug is on the
    Rust side, and serde will already fail there or here.
  - Contract tests catch drift at PR time.
- Cons:
  - Drift caught only if a contract test exists for that exact command.
  - No defense in depth against foreign payloads (git-notes JSON, etc.).
  - No automated error messages for users when a payload is malformed — they get the
    raw "expected X, got Y" deserialize error in a toast.
- Who does this: most Tauri apps in the awesome-tauri list
  ([awesome-tauri](https://github.com/tauri-apps/awesome-tauri)) ship without runtime
  IPC validation. It is the default.

### Option B · Add zod at the IPC boundary

- Source: `zod` v4 (mature, industry-standard since ~2022).
  - **Bundle**: full `zod` ships at ~16.57 KB gzipped for a typical schema; the
    `zod/v4-mini` export tree-shakes down to ~6.88 KB
    ([benchmark](https://www.pkgpulse.com/guides/valibot-vs-zod-v4-typescript-validator-2026)).
- Pros:
  - Industry standard — every contributor has seen `z.object({ ... })`.
  - Excellent error messages out of the box; `ZodError.issues` is human-readable.
  - `tauri-typegen` can generate zod schemas directly from Rust `#[tauri::command]`
    signatures ([tauri-typegen README](https://github.com/thwbh/tauri-typegen)) — closes
    the drift loop automatically.
  - Native TS type inference via `z.infer<typeof schema>` keeps a single source of truth.
- Cons:
  - Bundle weight. ~17KB gzipped is real for a desktop app that values startup.
  - The full `zod` API is large; teams accumulate cruft if not disciplined.
- Who uses it: `cc-switch` uses zod (`react-hook-form + zod` per
  [deepwiki](https://deepwiki.com/farion1231/cc-switch)). It is the de facto default for
  TypeScript schema validation in 2026.

### Option C · Add valibot at the IPC boundary

- Source: `valibot` v1.3.1, ([npm](https://www.npmjs.com/package/valibot)).
  - **Bundle**: ~1.91 KB gzipped for a typical schema; roughly 10x smaller than zod, 3.5x
    smaller than `zod/v4-mini`
    ([benchmark](https://www.pkgpulse.com/guides/valibot-vs-zod-v4-typescript-validator-2026)).
- Pros:
  - Modular architecture — you only ship what you use; ideal for bundle-conscious apps.
  - Same TS-first inference story as zod.
  - Active development; growth from 300k to 4.5M monthly downloads in the year before v1
    ([Valibot v1 RC post](https://valibot.dev/blog/valibot-v1-rc-is-available/)).
- Cons:
  - Smaller community than zod; fewer SO answers, fewer integrations.
  - API is function-composition style (`pipe(string(), email())`) instead of method
    chaining — slightly higher onboarding cost for contributors who know zod.
  - `tauri-typegen` codegen for valibot is not first-class today (zod is the supported
    target, [tauri-typegen README](https://github.com/thwbh/tauri-typegen)).
- Who uses it: growing adoption in bundle-sensitive contexts (edge functions, embedded
  webviews); no headline Tauri reference project we could cite is on valibot yet.

## Decision

**Chosen**: **Option A — do not add a runtime validator at this time**, with a documented
trigger to revisit.

**Reasoning**:

1. **No live bug.** We have shipped this app to production without a runtime validator
   and have not seen a payload-shape bug escape the Rust side. Adding 2–17 KB of
   validator code to prevent a class of bugs we have not observed violates the "no tech
   for tech's sake" principle.
2. **Serde is the real validator.** The Rust side is the only producer of IPC payloads
   we ship. If a Rust struct field changes shape, serde fails on serialize. There is no
   foreign-source IPC payload in the app today (git-notes JSON is read on the Rust side
   via serde, not on the TS side).
3. **Cheaper alternative covers the drift case.** Strengthening the existing contract
   tests — auto-generating expected TS shapes from Rust via `tauri-typegen` in a CI
   step, without runtime cost — closes the drift loop at compile time. This is the
   right next investment, not a runtime validator.
4. **If we ever do add one, it should be valibot.** Bundle weight matters for a desktop
   app, valibot is ~10x smaller than zod, the API is composable enough for an
   IPC-boundary use case (we don't need zod's rich validator ecosystem), and the
   peer-project argument for zod (`cc-switch` uses it for `react-hook-form`) doesn't
   apply to us — we have no form library use case today.

**Re-evaluate when** any of these become true: (a) we start ingesting payloads from a
non-Rust source (e.g. a websocket server, an external `git-ai` daemon JSON stream we don't
control), (b) we add complex client-side forms that need validation, (c) a real payload
drift bug ships to a user.

## Consequences

### Positive

- No bundle weight added.
- No new concept in `src/lib/api.ts`.
- Failure surface stays Rust-authoritative.

### Negative

- Drift between Rust and TS types is only caught if a contract test covers that command.
- Foreign payloads (if we ever add any) remain unvalidated until this ADR is revisited.

### Neutral / TODO

- Add a CI step that runs `tauri-typegen` and fails if the generated TS does not match
  `src/lib/types.ts` — this is the highest-ROI defense-in-depth move and costs zero
  runtime bytes ([tauri-typegen](https://github.com/thwbh/tauri-typegen)).
- Document in `CONTRIBUTING.md` that every new `#[tauri::command]` requires a matching
  entry in `src/lib/types.ts` and a contract test.
- Pre-pick valibot (not zod) as the future runtime validator if this ADR is reopened —
  rationale captured above.

## References

- Zod v4 vs Valibot bundle benchmark 2026:
  <https://www.pkgpulse.com/guides/valibot-vs-zod-v4-typescript-validator-2026>
- Independent benchmark write-up:
  <https://dev.to/whoffagents/zod-v4-vs-valibot-runtime-validation-in-2026-i-benchmarked-both-3jnc>
- `tauri-typegen` (auto-generates TS + optional zod from Tauri commands):
  <https://github.com/thwbh/tauri-typegen>
- `tauri-safe-invoke` (wrapper that adds zod validation around `invoke`):
  <https://www.npmjs.com/package/tauri-safe-invoke>
- Valibot v1 RC announcement (download growth):
  <https://valibot.dev/blog/valibot-v1-rc-is-available/>
- Valibot npm (v1.3.1):
  <https://www.npmjs.com/package/valibot>
- `cc-switch` (uses zod for forms):
  <https://deepwiki.com/farion1231/cc-switch>
