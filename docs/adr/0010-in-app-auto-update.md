# ADR-010 · In-app auto-update (launch check + one-click install)

**Status**: Accepted
**Supersedes**: [ADR-006](./0006-auto-update-strategy.md)
**Date**: 2026-05-29

## Context

ADR-006 chose **Option A — `tauri-plugin-updater` enabled, user-triggered check only**: the
plugin shipped in the binary, but `check()` was only ever called from a "Check for updates"
button on the Settings page. That decision was bounded by the PR-FAQ v2 lock "zero
auto-update ping" — the app must not contact any server at launch, on a schedule, or in the
background.

The product owner has reversed that lock. The observed problem with "user-triggered only":
the long tail of users never opens Settings, never clicks the button, and therefore never
learns a new version exists. The reminder-banner mitigation in ADR-006 was always a partial,
not complete, fix — and a banner that nudges you to click a button you'll still never click
does not move update velocity. In practice "no ping" translated to exactly the failure mode
ADR-006's Context #2 warned against: "users stay on old versions and silently miss security
fixes."

The owner has accepted that a single, narrow, honest version check at launch is a better
trade than zero pings. The honesty constraint is explicit: the check sends **only a version
number** to GitHub — no code, no repository data, no personal data, no telemetry — and it
must be disclosed loudly everywhere the old "zero ping" promise lived (PR-FAQ, both READMEs,
CLAUDE.md). This ADR records that reversal; the full-document sync is part of the same change
set.

## Options considered

These are the same three options ADR-006 weighed; only the product constraint changed, so the
technical menu is unchanged. What changed is which one the constraint now selects.

### Option A · `tauri-plugin-updater` enabled, user-triggered check only

The ADR-006 choice. `check()` fires only from a Settings button; no startup hook, no timer.
Honours "no auto-update ping" literally, but — as above — fails to reach the long-tail user
who never opens Settings. Rejected now because the product reason that made it attractive
(the zero-ping lock) has been withdrawn, and its core weakness (no update velocity for
non-Settings users) is precisely the problem we're solving.

### Option B · No in-app update mechanism; README points to GitHub Releases

The truest interpretation of "zero ping" — no update code in the binary at all. Rejected for
the same reasons ADR-006 rejected it, now more strongly: almost nobody enables GitHub release
notifications, it forces a multi-step manual download/mount/drag flow per platform, and it
ships no cryptographic signature verification. With the zero-ping lock gone, Option B's only
remaining advantage (literal zero network) no longer outweighs its UX and update-velocity
costs.

### Option C · `tauri-plugin-updater` with startup check + one-click install (cc-switch default)

**Chosen.** This is the option ADR-006 marked **PASS** purely because it "directly conflicts
with the PR-FAQ 'no auto-update ping' lock" — a product veto, never a technical one. ADR-006
explicitly noted it was "listed for completeness so future readers know we considered the
obvious thing and rejected it for a product reason, not a technical one." The product reason
is now reversed, so the obvious thing is back on the table and wins:

- About one second after launch, the app calls `check()` once against a static `latest.json`
  on GitHub Releases and compares version numbers.
- If a newer version exists, the UI surfaces it on the About page and as a TopBar badge.
- The user installs in one click via `downloadAndInstall`, then the app relaunches
  (`tauri-plugin-process`).
- Every artifact is minisign-signed in release CI; the binary verifies the signature before
  installing, so a compromised GitHub Releases page cannot push a tampered binary without the
  minisign private key.
- A build-time escape hatch — `plugins.updater.active=false` — fully disables the plugin for
  forks/builds that want literal zero network.

## Decision

**Chosen**: **Option C — `tauri-plugin-updater` with launch check + one-click install** (the
cc-switch default).

**Reasoning**:

1. **It solves the actual problem.** The launch check is the only mechanism that reaches the
   long-tail user who never opens Settings. With the zero-ping lock withdrawn, this is the
   whole point of having an updater at all.
2. **Narrow and honest.** A single version-number request is the minimum that delivers update
   velocity. It carries no code, no repository data, no personal data, no telemetry, and the
   disclosure is mirrored across PR-FAQ / both READMEs / CLAUDE.md in this same change set.
3. **Cryptographic verification, unchanged.** Minisign over the artifact is meaningfully
   stronger than "GitHub Releases over TLS"; that property is inherited intact from ADR-006.
4. **Proven peer precedent (cc-switch).** The sibling project `cc-switch` ships exactly this
   pattern:
   - **Launch check (~1s delay):** `src/contexts/UpdateContext.tsx:122-130` — a top-level
     `useEffect` arms a `setTimeout(..., 1000)` that calls `checkUpdate()`, so the check runs
     about a second after launch rather than blocking startup.
   - **Updater config:** `tauri.conf.json` declares `plugins.updater` with a `pubkey` and an
     `endpoints` array pointing at `releases/latest/download/latest.json`, plus
     `bundle.createUpdaterArtifacts: true`.
   - **`latest.json` from CI:** the `assemble-latest-json` job in
     [`.github/workflows/release.yml`](https://github.com/farion1231/cc-switch/blob/main/.github/workflows/release.yml)
     (`assemble-latest-json` / `Assemble latest.json` step) generates and uploads `latest.json`
     to the release. We lift this job pattern unchanged.

**Re-evaluate when**: (a) a regulator/audit asks us to prove zero outbound traffic — point
them at the documented `plugins.updater.active=false` build switch; (b) we add a Linux package
manager (Flatpak, Homebrew Cask) that already handles updates — at which point the in-app
updater degrades to a "managed install, updates come from your package manager" message for
those install paths.

### Required `tauri.conf.json` snippet

```jsonc
{
  "bundle": {
    "createUpdaterArtifacts": true
    // ...
  },
  "plugins": {
    "updater": {
      "active": true,
      "pubkey": "<minisign-public-key-base64>",
      "endpoints": [
        "https://github.com/<org>/git-ai-studio/releases/latest/download/latest.json"
      ]
    }
  }
}
```

### Required app behaviour

- **MUST** call `check()` once at launch, deferred by ~1s (mirrors
  `cc-switch` `UpdateContext.tsx:122-130`) so it does not block startup.
- **MUST** surface an available update on the About page and as a TopBar badge.
- **MUST** verify the minisign signature before `downloadAndInstall`, then relaunch via
  `tauri-plugin-process`.
- **MUST** honour `plugins.updater.active=false` as a full build-time disable.

## Consequences

### Positive

- Update velocity reaches the long-tail user: a new version is visible the next time the app
  launches, without the user having to go looking.
- Cryptographic update verification end-to-end (minisign); a compromised GitHub Releases page
  cannot push a tampered binary without the private key.
- One-click install instead of the per-platform download/mount/drag/unmount flow.
- The CI `latest.json` pipeline is proven (lifted from `cc-switch`'s `assemble-latest-json`).

### Negative

- **Breaks the "zero auto-update ping" promise** that ADR-006, the PR-FAQ, and both READMEs
  made. This requires a full-document sync so the disclosure is honest and consistent — done
  in this change set (PR-FAQ.md / PR-FAQ.zh-CN.md / README.md / README.zh-CN.md / CLAUDE.md).
- **macOS Gatekeeper risk:** v1.0 `.app` is not yet notarized, so the post-update relaunch may
  be blocked by Gatekeeper on macOS. Listed as a known risk; resolved by notarization
  (tracked alongside code-signing for v1.1).
- The `pubkey` field is mandatory once `createUpdaterArtifacts` is true. Losing the private
  key means we can never ship a verifiable update again under that pubkey — CI must back up
  `TAURI_SIGNING_PRIVATE_KEY` somewhere other than the GitHub Secret alone.

### Neutral / TODO

- Document the launch-check invariant in `CLAUDE.md` (done) so future contributors understand
  the single automatic network call is intentional, not a regression.
- Privacy-maximalist users / forks set `plugins.updater.active=false` to fully disable the
  plugin and restore literal zero network.

## References

- ADR-006 (superseded): [`0006-auto-update-strategy.md`](./0006-auto-update-strategy.md)
- `cc-switch` launch-check call-site (~1s `setTimeout` → `checkUpdate()`):
  `src/contexts/UpdateContext.tsx:122-130`
- `cc-switch` `assemble-latest-json` CI job:
  <https://github.com/farion1231/cc-switch/blob/main/.github/workflows/release.yml>
- Tauri v2 updater plugin docs:
  <https://v2.tauri.app/plugin/updater/>
- Tauri updater signature format (minisign / Ed25519):
  <https://v2.tauri.app/plugin/updater/#signing-updates>
- Tauri process plugin (relaunch after install):
  <https://v2.tauri.app/plugin/process/>
