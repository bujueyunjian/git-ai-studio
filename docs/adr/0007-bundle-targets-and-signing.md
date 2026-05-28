# ADR-007 · Bundle formats and signing strategy

**Status**: Proposed (awaiting review)
**Date**: 2026-05-27

## Context

`git-ai-studio` is launching simultaneously on **macOS, Linux, and Windows**. We need to
pick concrete bundle targets for each OS and decide what to do about code signing —
which is non-trivial: an Apple Developer Program seat is $99/yr per individual and a
Windows EV code-signing cert is $200–600/yr from a CA. v1.0 ships before either is in
place, so we need a "no signing yet" story that doesn't strand non-technical users.

Tauri 2 supports the following bundle targets:
`"deb"`, `"rpm"`, `"appimage"`, `"nsis"`, `"msi"`, `"app"`, `"dmg"`, or `"all"`
([Tauri config docs](https://v2.tauri.app/reference/config/)).

Reference data points:

- **`cc-switch`** ships `.dmg` (universal), `.msi` + portable `.zip` (Windows), and
  AppImage + `.deb` + `.rpm` (Linux x86_64 + ARM64). macOS is signed and notarized.
  ([release.yml](https://github.com/farion1231/cc-switch/blob/main/.github/workflows/release.yml))
- **Spacedrive** ships `.dmg + .app` (macOS), `.nsis` (Windows), and `.deb` (Linux).
  No AppImage, no RPM — they explicitly target modern Ubuntu/Debian.
  ([release.yml](https://github.com/spacedriveapp/spacedrive/blob/main/.github/workflows/release.yml))
- **GitButler** matrix has 5 platforms: macOS arm64 + macOS x86_64 (separate, not
  universal), Linux x86_64, Linux ARM64, Windows x86_64. macOS is signed + notarized.
  ([publish.yaml](https://github.com/gitbutlerapp/gitbutler/blob/master/.github/workflows/publish.yaml))

Cost / friction reality check on signing:

- macOS unsigned `.dmg` triggers Gatekeeper. Users have to right-click → Open or
  `xattr -dr com.apple.quarantine /Applications/Git\ AI\ Studio.app`. Acceptable for
  developer audiences, painful for everyone else.
- Windows unsigned `.msi` triggers SmartScreen ("Windows protected your PC"). User
  clicks "More info → Run anyway." Acceptable for developer audiences.
- Linux has no equivalent gatekeeping — AppImage and `.deb` are unsigned by convention
  and users don't see a friction popup.

PR-FAQ already accepts v1.0 ships unsigned with a clear README workaround; v1.1 adds
Apple Developer signing + notarization. Windows EV cert is deferred to demand-pull
(only if SmartScreen friction generates user complaints).

## Options considered

### Option A · Match cc-switch (all formats, every platform) — universal macOS

- Bundle targets:
  - macOS: `["app", "dmg"]` via `--target universal-apple-darwin` (single binary works
    on Apple Silicon + Intel).
  - Windows: `["msi", "nsis"]` (MSI is primary, NSIS as alternate for users who prefer it).
  - Linux: `["appimage", "deb", "rpm"]` (matches cc-switch's coverage).
- Pros:
  - Widest format coverage; no user is left without an installer for their distro.
  - Matches the closest peer project so we benefit from its proven CI.
  - Universal macOS binary means **one** download URL on the website regardless of
    arch — better DX for non-technical users.
- Cons:
  - RPM is non-trivial to maintain (Fedora/RHEL test surface we don't have hardware for).
  - Universal macOS doubles the macOS binary size (~30MB → ~60MB) because both arch
    slices are concatenated ([Tauri macOS bundle docs](https://v2.tauri.app/distribute/macos-application-bundle/)).
  - Five formats per release = five things to QA on every tag.

### Option B · Match Spacedrive (focused; no AppImage, no RPM, no portable)

- Bundle targets:
  - macOS: `["app", "dmg"]` via `--target universal-apple-darwin`.
  - Windows: `["nsis"]` only (NSIS, no MSI).
  - Linux: `["deb"]` only (modern Ubuntu/Debian target audience).
- Pros:
  - Smallest QA surface; each format is well-supported.
  - Spacedrive ships this in production at ~30k stars — battle-tested coverage choice.
  - No AppImage means no embedded WebKitGTK runtime → Linux binary is ~4MB instead of
    ~76MB ([Tauri Linux bundle reference](https://v2.tauri.app/distribute/linux-bundle/)).
- Cons:
  - Hard NOPE for users on Fedora/Arch/openSUSE/old Ubuntu — they have no installer
    path and would need to build from source.
  - MSI is the more "enterprise-friendly" Windows format; some IT departments push back
    on NSIS installers. We lose that audience.

### Option C · Recommended hybrid — cover the long tail without RPM

- Bundle targets:
  - **macOS**: `["app", "dmg"]` via `--target universal-apple-darwin` (Option A's macOS).
  - **Windows**: `["msi"]` primary; NSIS opt-in via release-time flag (not in default
    bundle config). Rationale: MSI is enterprise-friendlier and Tauri's MSI output
    works for both per-user and per-machine installs. NSIS can be added later if
    user feedback demands a portable Windows option.
  - **Linux**: `["appimage", "deb"]`. AppImage covers Fedora/Arch/openSUSE/old-Ubuntu
    via embedded WebKitGTK; `.deb` covers modern Ubuntu/Debian with a tiny binary.
    **No RPM** because we lack the test infrastructure to validate it.
- Pros:
  - One installer path for every reasonable target (modern Apple Silicon, Intel Mac,
    modern Linux, every-Linux-since-2018, modern Windows).
  - Excludes only RPM-distro users from a "double-click installer" — they get the
    AppImage instead, which works on every Linux without distro-specific deps.
  - Smaller QA surface than Option A (4 formats vs 5).
  - Universal macOS binary keeps the website download UX simple.
- Cons:
  - Linux ARM64 is a separate matrix entry (different runner: `ubuntu-22.04-arm`),
    same as cc-switch and GitButler — adds 1 CI job.
  - No native RPM means Fedora users have to use AppImage (mildly second-class).

### v1.0 signing strategy — defer; README workaround

- **macOS**: ship unsigned `.dmg` + `.app`. README documents the
  `xattr -dr com.apple.quarantine` workaround prominently. Apple Developer ID
  ($99/yr) added in v1.1.
- **Windows**: ship unsigned `.msi`. README documents the SmartScreen "More info →
  Run anyway" path. EV cert ($200–600/yr) deferred until user demand justifies it
  (most small OSS Tauri/Electron apps never get an EV cert; reputational trust
  on GitHub takes the place).
- **Linux**: AppImage and `.deb` are unsigned by ecosystem convention; no action
  needed.
- **Tauri updater minisign**: this is **separate** from OS code signing and is
  required by the updater plugin regardless. The minisign keypair is free to
  generate and lives in GitHub Secrets — see ADR-006.

## Decision

**Chosen**: **Option C — hybrid coverage (AppImage + deb on Linux, MSI on Windows,
universal DMG on macOS); v1.0 ships unsigned with README workarounds; v1.1 adds
Apple Developer notarization.**

**Reasoning**:

1. **No user left without an installer.** Every supported platform has a double-click
   path, including Fedora users via AppImage. RPM is the only sacrifice and it's a
   format whose primary audience (Fedora/RHEL) overwhelmingly accepts AppImage as a
   substitute.
2. **QA surface is finite.** 4 formats (DMG, MSI, AppImage, deb) is the floor we can
   actually run smoke tests on at every tag without owning Fedora hardware.
3. **Peer precedent for both halves.** macOS bundle choice copies cc-switch;
   Linux/Windows choice sits between cc-switch (more inclusive, with RPM) and
   Spacedrive (more focused, deb-only). We pick the inclusive Linux baseline so
   we don't exclude Fedora/Arch from day one.
4. **Signing deferral is honest, not lazy.** A $99/yr Apple seat for an unfunded OSS
   side project is not free; we ship a v1.0 → v1.1 path explicitly so users know
   when the friction goes away.

**Re-evaluate when**: (a) user feedback shows Windows SmartScreen is causing high
abandonment → buy an EV cert; (b) we find a Fedora maintainer who'll co-sign RPM
QA → add RPM target; (c) a `tauri-plugin-flatpak` becomes production-ready → ship
Flatpak as an additional Linux path; (d) total bundle volume crosses the
GitHub Releases 2GB per-asset / unlimited-total limit → revisit per-arch splitting.

### Required `src-tauri/tauri.conf.json` snippet

```jsonc
{
  "bundle": {
    "active": true,
    "targets": ["app", "dmg", "msi", "appimage", "deb"],
    "createUpdaterArtifacts": true,
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "macOS": {
      "minimumSystemVersion": "12.0"
    },
    "linux": {
      "deb": {
        "depends": []
      }
    },
    "windows": {
      "wix": {
        "language": ["en-US", "zh-CN"]
      }
    }
  }
}
```

> Note: Tauri's bundler honours per-OS targets — listing `msi` on a macOS runner is a
> no-op (only the OS-relevant targets emit). Same for `dmg` on Linux. The list above is
> the full superset; each runner produces only the subset it can build.

### Required `.github/workflows/release.yml` matrix

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write

concurrency:
  group: release-${{ github.ref_name }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          # macOS universal binary (arm64 + x86_64 in one .app / .dmg)
          - os: macos-14
            target: universal-apple-darwin
            args: '--target universal-apple-darwin --bundles app,dmg'
          # Linux x86_64
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
            args: '--bundles appimage,deb'
          # Linux ARM64 — separate runner (Tauri does not support Linux cross-compile)
          - os: ubuntu-22.04-arm
            target: aarch64-unknown-linux-gnu
            args: '--bundles appimage,deb'
          # Windows x86_64
          - os: windows-2022
            target: x86_64-pc-windows-msvc
            args: '--bundles msi'

    steps:
      - uses: actions/checkout@v6

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with: { node-version: '20' }

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Add macOS targets
        if: matrix.target == 'universal-apple-darwin'
        run: rustup target add aarch64-apple-darwin x86_64-apple-darwin

      - name: Install Linux system deps
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends \
            build-essential pkg-config curl wget file patchelf \
            libssl-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev
          sudo apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev \
            || sudo apt-get install -y --no-install-recommends libwebkit2gtk-4.0-dev
          sudo apt-get install -y --no-install-recommends libsoup-3.0-dev \
            || sudo apt-get install -y --no-install-recommends libsoup2.4-dev

      - name: Setup pnpm
        uses: pnpm/action-setup@v6
        with: { version: 10.12.3, run_install: false }

      - name: Cache pnpm + cargo
        uses: actions/cache@v5
        with:
          path: |
            ~/.local/share/pnpm/store
            ~/.cargo/registry
            ~/.cargo/git
            src-tauri/target
          key: ${{ runner.os }}-${{ runner.arch }}-bundle-${{ hashFiles('**/pnpm-lock.yaml', 'src-tauri/Cargo.lock') }}

      - run: pnpm install --frozen-lockfile

      - name: Build Tauri bundle
        env:
          # Tauri updater signing (ADR-006). v1.0: minisign only, no OS signing yet.
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        run: pnpm tauri build ${{ matrix.args }}

      - name: Stage artifacts
        shell: bash
        run: |
          mkdir -p release-assets
          find src-tauri/target -type f \
            \( -name '*.dmg' -o -name '*.app.tar.gz' -o -name '*.app.tar.gz.sig' \
               -o -name '*.msi' -o -name '*.msi.sig' \
               -o -name '*.AppImage' -o -name '*.AppImage.sig' \
               -o -name '*.deb' \) \
            -exec cp {} release-assets/ \;
          ls -la release-assets/

      - uses: actions/upload-artifact@v7
        with:
          name: release-assets-${{ matrix.os }}-${{ runner.arch }}
          path: release-assets/*
          if-no-files-found: error

  publish:
    needs: build
    runs-on: ubuntu-22.04
    permissions: { contents: write }
    steps:
      - uses: actions/download-artifact@v8
        with:
          pattern: release-assets-*
          path: release-assets
          merge-multiple: true

      - uses: softprops/action-gh-release@v3
        with:
          tag_name: ${{ github.ref_name }}
          name: Git AI Studio ${{ github.ref_name }}
          files: release-assets/*
          body_path: .github/release-notes/${{ github.ref_name }}.md
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

> The `latest.json` assembly job (for the updater) is **omitted** here; see ADR-006 for
> the `assemble-latest-json` pattern lifted from `cc-switch`. Add it as a third job
> downstream of `publish` once the minisign keys are in place.

### v1.1 signing addendum (defer)

When the Apple Developer Program seat is purchased, lift these steps verbatim from
`cc-switch`'s `release.yml`:

1. "Import Apple signing certificate" step (creates a temporary keychain, imports
   the `.p12`, resolves the "Developer ID Application" identity dynamically).
2. Wrap the macOS `pnpm tauri build` in a 3-attempt retry loop (notarization is
   flaky and Apple's submit endpoint times out under load).
3. After build, run `xcrun stapler staple` on the `.app` and a separate
   `xcrun notarytool submit --wait` on the `.dmg`.
4. Add `codesign --verify --deep --strict --verbose=2` + `spctl -a -t exec -vv`
   verification gates so a failed signature breaks the release before publish.

Source: [cc-switch release.yml](https://github.com/farion1231/cc-switch/blob/main/.github/workflows/release.yml)
lines covering "Import Apple signing certificate" through "Verify macOS code signing
and notarization."

Windows EV cert (deferred indefinitely): if and when it's purchased, add
`WINDOWS_CERTIFICATE` + `WINDOWS_CERTIFICATE_PASSWORD` to the Tauri build env per
[Tauri Windows code-signing docs](https://v2.tauri.app/distribute/sign/windows/).

## Consequences

### Positive

- Every reasonable platform has a double-click installer; Fedora/Arch users get
  AppImage instead of "build from source."
- Universal macOS binary means a single download URL on the website (Apple Silicon
  + Intel served by one asset) — cleaner UX than per-arch links.
- QA surface is bounded (4 formats, 4 CI jobs).
- v1.0 → v1.1 signing path is concrete and lifted from a known-good pipeline
  (cc-switch), so the future work is execution, not design.

### Negative

- macOS unsigned `.dmg` triggers Gatekeeper in v1.0; non-technical Mac users
  who haven't read the README will hit a confusing dialog. README placement
  matters.
- Windows unsigned `.msi` triggers SmartScreen; same risk profile.
- Linux ARM64 needs a dedicated `ubuntu-22.04-arm` runner; if GitHub deprecates
  that image, we need to find a replacement (self-hosted ARM runner).
- Universal macOS binary is ~2x the size of a single-arch build. Acceptable for
  one-time downloads.

### Neutral / TODO

- README must include a clearly-titled "Unsigned build · how to install" section
  for both macOS and Windows in v1.0. Draft text:
  > **macOS**: After downloading, run
  > `xattr -dr com.apple.quarantine /Applications/Git\ AI\ Studio.app` in Terminal,
  > or right-click the `.app` and choose Open the first time.
  > **Windows**: SmartScreen will show "Windows protected your PC." Click
  > "More info" → "Run anyway."
- Add a CI smoke step that runs the built binary headlessly (`--version` flag)
  on each platform before upload — catches the "wrong rust target / wrong libc"
  class of breakage before users do.
- Add a section to `CONTRIBUTING.md` documenting which platform owns which bundle
  format so a single maintainer doesn't have to test all 4 on every PR.

## References

- Tauri 2 bundle target reference: <https://v2.tauri.app/reference/config/>
- Tauri 2 macOS Application Bundle (universal binary): <https://v2.tauri.app/distribute/macos-application-bundle/>
- Tauri 2 Linux Bundle (AppImage / deb size trade-off): <https://v2.tauri.app/distribute/linux-bundle/>
- Tauri 2 macOS code signing: <https://v2.tauri.app/distribute/sign/macos/>
- Tauri 2 Windows code signing: <https://v2.tauri.app/distribute/sign/windows/>
- `cc-switch` `release.yml` (universal macOS, MSI, AppImage+deb+rpm; Apple-signed):
  <https://github.com/farion1231/cc-switch/blob/main/.github/workflows/release.yml>
- Spacedrive `release.yml` (dmg+app, nsis, deb-only):
  <https://github.com/spacedriveapp/spacedrive/blob/main/.github/workflows/release.yml>
- GitButler `publish.yaml` (5-platform matrix, signed macOS):
  <https://github.com/gitbutlerapp/gitbutler/blob/master/.github/workflows/publish.yaml>
- tauri-action latest version v0.6.2 (2026-03-14):
  <https://github.com/tauri-apps/tauri-action/releases>
- Apple Developer Program pricing ($99/yr individual): <https://developer.apple.com/programs/>
