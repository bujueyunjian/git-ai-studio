# ADR-006 · Auto-update strategy

**Status**: Proposed (awaiting review) · Superseded by [ADR-010](./0010-in-app-auto-update.md)
**Date**: 2026-05-27

## Context

The PR-FAQ v2 locks two product constraints that bound this decision:

1. **Zero telemetry, zero crash reporter, zero auto-update ping.** The app must not contact
   any server at launch, on a schedule, or in the background. The only network calls allowed
   are user-initiated: the `git-ai` CLI install/upgrade (GitHub Releases) and the user-
   configured `git push refs/notes/ai`.
2. **Users still need to learn that a new version exists.** "No ping" must not translate to
   "users stay on v1.0.0 forever and silently miss security fixes."

These two pull in opposite directions. The standard Tauri/Electron pattern (background ping
on app start, banner appears if a newer version exists) is explicitly off the table.

Confirmation from the upstream docs: the Tauri v2 updater plugin does **not** ping
automatically. The plugin only exposes a `check()` function — the host app decides when to
call it ([Tauri docs](https://v2.tauri.app/plugin/updater/)). That means "use the plugin" and
"no startup ping" are compatible as long as we never call `check()` from app startup or any
background timer.

The sibling project `cc-switch` enables the updater with an endpoint pointing at
`releases/latest/download/latest.json` and (based on its `tauri.conf.json`) does check on
launch — which is the typical Tauri pattern, but not what PR-FAQ asks for.

## Options considered

### Option A · `tauri-plugin-updater` enabled, user-triggered check only

- Source: `@tauri-apps/plugin-updater` v2.x, part of the Tauri 2 plugins workspace; bundled
  by the official Tauri team ([repo](https://github.com/tauri-apps/plugins-workspace)).
  `tauri-cli` v2.11.2 (2026), used by every Tauri 2 desktop app shipping in production.
- Behaviour:
  - `tauri.conf.json` declares `bundle.createUpdaterArtifacts: true` + `plugins.updater`
    with a `pubkey` and an `endpoints` array pointing at a static `latest.json` on GitHub
    Releases.
  - `check()` is **only** invoked from a "Check for updates" button in the Settings page.
    No `useEffect(() => check(), [])`, no `setInterval`, no startup hook.
  - Release CI signs every artifact with minisign; the public key lives in
    `tauri.conf.json` so the binary verifies signatures before installing
    ([signature format docs](https://v2.tauri.app/plugin/updater/)).
- Pros:
  - Honours "no auto-update ping" literally — zero network calls happen unless the user
    clicks the button.
  - Users still get one-click install when they ask for it; no manual download / unmount /
    drag-to-Applications dance.
  - Signature verification is cryptographic, not "trust the GitHub Releases TLS chain."
  - We can ship the same `latest.json` cc-switch already publishes from CI (matches
    its `assemble-latest-json` job), so the release pipeline pattern is proven.
- Cons:
  - Users who never open Settings will never learn about new versions. We mitigate by:
    (1) showing the current version in the bottom-left status strip, (2) a once-per-week
    in-app reminder banner that says "you haven't checked for updates in N days" — the
    banner itself does **not** trigger a network call, it just nudges the user to click.
  - The release workflow now has to maintain a `latest.json` and the minisign keypair —
    extra moving parts in CI.
- Who uses this exact "user-triggered only" pattern: documented as the supported pattern
  in the official Tauri docs (the `check()` API is presented as something the app calls;
  startup-on-launch is one option among several, not the default). The `cc-switch`
  release pipeline already produces `latest.json` we can mirror.

### Option B · No in-app update mechanism; README points to GitHub Releases

- Source: no dependency. Users click "Watch → Custom → Releases" on GitHub.
- Pros:
  - Truest interpretation of "zero auto-update ping" — there is literally no update code
    in the binary.
  - Simpler release CI (no `latest.json`, no minisign key management).
  - Matches what many small Rust CLIs do (e.g. `rg`, `fd`, `bat` — though those have
    Homebrew / package-manager update paths Desktop users won't have on Windows / Linux
    AppImage).
- Cons:
  - In practice, almost nobody enables GitHub release notifications. Effective update
    velocity for typical users drops to "whenever they re-discover the project."
  - Forces users into a 5-step manual flow per platform (download DMG, mount, drag-to-
    Applications, unmount, eject) — friction that selects against non-developer users.
  - No signature verification — users have to trust the GitHub TLS chain end-to-end with
    no second factor.
- Who uses this: privacy-maximalist CLIs (`ripgrep`, `fd`). No desktop Tauri/Electron app
  in our reference set ships this way; even strongly privacy-leaning apps (Spacedrive,
  Signal Desktop) ship an in-app update mechanism with cryptographic verification.

### Option C · `tauri-plugin-updater` with startup ping (cc-switch default)

- **PASS** — directly conflicts with PR-FAQ "no auto-update ping" lock. Listed for
  completeness so future readers know we considered the obvious thing and rejected it
  for a product reason, not a technical one.

## Decision

**Chosen**: **Option A — `tauri-plugin-updater` enabled, user-triggered check only**.

**Reasoning**:

1. **Compatible with PR-FAQ.** The Tauri docs confirm the plugin only checks when the app
   calls `check()`. By restricting that call to a Settings-page button, we honour "no
   startup ping" while keeping the cryptographic-signature install path.
2. **Cryptographic verification matters.** Minisign over the artifact is meaningfully
   stronger than "GitHub Releases over TLS." Option B throws that away.
3. **Lower friction than manual download.** "Click → confirm → app restarts on new
   version" beats "open browser → find releases page → pick the right asset for your
   arch → download → mount → drag → unmount" by enough that the marginal benefit of
   Option B (one less plugin) doesn't justify the UX cost.
4. **Peer precedent.** The release pipeline that produces `latest.json` is proven in
   `cc-switch` ([release.yml](https://github.com/farion1231/cc-switch/blob/main/.github/workflows/release.yml));
   we lift the `assemble-latest-json` job pattern unchanged, just change the trigger
   semantics on the consumer side.

**Re-evaluate when**: (a) a regulator/audit asks us to prove zero outbound traffic — at
that point we'd add a settings toggle that fully disables the updater plugin (`active:
false`) for users who want to be paranoid; (b) we add a Linux package manager (Flatpak,
Homebrew Cask) that already handles updates — at which point the in-app updater is
redundant for those install paths and can degrade to a "you are using a managed install,
updates come from your package manager" message.

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

- **MUST NOT** call `check()` from any of: `main.tsx`, top-level `App.tsx`,
  `useEffect(..., [])`, `setInterval`, `setTimeout`, watcher hooks.
- **MUST** call `check()` only from the explicit "Check for updates" button click handler
  in the Settings page.
- **MAY** display a non-network reminder banner ("last checked: N days ago") driven from
  `localStorage` — this is local state, not a ping.

## Consequences

### Positive

- PR-FAQ "no auto-update ping" honoured literally and verifiably (single call-site of
  `check()` makes audit trivial — grep for `check(` in `src/`).
- Cryptographic update verification end-to-end; even a compromised GitHub Releases page
  can't push a tampered binary without the minisign private key.
- Update install path is one click instead of a multi-step manual flow.

### Negative

- Two extra CI maintenance burdens: `latest.json` generation (lifted from `cc-switch`)
  and minisign keypair custody.
- "Long-tail" users who never open Settings may stay on old versions; the reminder
  banner is a partial, not complete, mitigation.
- The `pubkey` field is mandatory once `createUpdaterArtifacts` is true. Losing the
  private key means we can never ship a verifiable update again under that pubkey —
  CI must back up `TAURI_SIGNING_PRIVATE_KEY` somewhere other than the GitHub Secret
  alone (e.g. printed-paper backup or a second secret vault).

### Neutral / TODO

- Document the "no startup ping" invariant in `CLAUDE.md` so future contributors don't
  accidentally regress it. Add an ESLint rule or CI grep that fails the build if
  `check(` appears in any file under `src/` other than `Settings.tsx`.
- Add a section to the README explaining the update model and how a paranoid user can
  set `plugins.updater.active = false` in a fork/build to fully disable.
- Decide the cadence: "weekly reminder" or "monthly reminder"? Pick one before v1.0
  based on intended release cadence (likely weekly during early releases, monthly once
  stable).

## References

- Tauri v2 updater plugin docs (confirms `check()` is host-invoked, not automatic):
  <https://v2.tauri.app/plugin/updater/>
- Tauri plugins-workspace repo (source of `tauri-plugin-updater`):
  <https://github.com/tauri-apps/plugins-workspace>
- `cc-switch` `latest.json` assembly pattern that we lift:
  <https://github.com/farion1231/cc-switch/blob/main/.github/workflows/release.yml>
- Tauri updater signature format (minisign / Ed25519):
  <https://v2.tauri.app/plugin/updater/#signing-updates>
- Spacedrive uses `includeUpdaterJson: true` in its tauri-action invocation (proof the
  pattern works in privacy-leaning production apps):
  <https://github.com/spacedriveapp/spacedrive/blob/main/.github/workflows/release.yml>
- Tauri auto-update community walkthrough, 2026:
  <https://thatgurjot.com/til/tauri-auto-updater/>
