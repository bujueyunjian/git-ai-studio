# ADR-014 · Single-instance guard (one process, focus the running window)

**Status**: Accepted
**Date**: 2026-06-07

## Context

Tauri v2 allows unlimited instances by default — `tauri-plugin-single-instance` is opt-in,
and this app never registered it. Nothing else in the stack blocks a second process either:
the SQLite database opens in WAL mode (multiple processes can connect to the same file), and
`AppSettings` reads/writes `~/.git-ai-studio/config.json` with plain `std::fs::read_to_string`
/ `std::fs::write` (no file lock). So every double-click, `open -n`, or "auto-launch at login
+ manual launch" overlap starts a fresh, fully-functional second process.

The user-visible damage compounds:

- **Two tray icons.** `TrayIconBuilder::with_id("git-ai-studio-tray")` de-dupes only within a
  process; two processes register two icons (`src-tauri/src/lib.rs`).
- **Two desktop pets.** The `pet` window is declared statically in `tauri.conf.json`
  (label `pet`, `visible:false`) and shown per-process by `pet::restore_on_startup` reading the
  shared `pet.enabled`. N processes → N pet windows. This directly threatens the ADR-011
  "形象即数据" invariant by putting two ink blobs on screen. See [ADR-011](./0011-desktop-companion-ink-pet.md).
- **Lost-update races on `config.json`.** Two processes read-modify-write the same file with no
  lock; the later writer silently clobbers the earlier one.
- **Duplicated background work.** `LowAiShareWatcher` / `DaemonWatcher` / `repo_notes_watcher`
  run once per process, so webhook pushes and `git-ai install-hooks` repairs can fire twice;
  the per-process debounce state does not coordinate across processes.

"关闭=最小化到托盘" amplifies it: a user who thinks the app is closed (it is hidden, not
exited) launches it again and now genuinely has two processes, two trays, two pets.

The right fix is "second launch focuses the running instance" — the platform-standard desktop
behaviour. The only real decision is *how* to enforce single-instance across macOS / Linux /
Windows.

## Options considered

### Option A · Do nothing (status quo)

Reject. The failures above are real and user-reported. There is no product reason to allow
multiple instances of a single-developer, single-machine viewer; ADR-011's pet invariant
actively requires exactly one.

### Option B · Hand-rolled lock (lockfile / Unix socket / named mutex) + custom focus IPC

A lockfile or platform mutex to detect a prior instance, plus a custom IPC channel to tell the
running instance to focus. Reject: this re-implements, badly, what a maintained plugin already
does well across three platforms — stale-lock cleanup after a crash, the macOS/Linux Unix
socket vs Windows named mutex split, the Linux D-Bus name path, and the "connect to the live
instance vs reclaim an abandoned socket" distinction. It is exactly the kind of 50-line helper
that *looks* cheap and then leaks edge cases per platform. Violates the ADR README "mature
first / no tech for tech's sake" principles.

### Option C · `tauri-plugin-single-instance` + focus the main window in the callback (cc-switch default)

**Chosen.** Register the plugin first in the Tauri builder chain. When a second process starts,
the plugin detects the running instance over platform-level IPC (Unix socket on macOS/Linux,
named mutex on Windows, D-Bus name on Linux), hands off `argv`/`cwd`, and the second process
exits. The running instance's callback reuses the existing `restore_main_window` helper
(`get_webview_window("main")` → `show` + `unminimize` + `set_focus`).

## Decision

**Chosen**: **Option C — `tauri-plugin-single-instance`, callback focuses the main window**
(the cc-switch default).

**Reasoning**:

1. **It is the standard, maintained mechanism.** The plugin already handles the three-platform
   IPC, stale-resource cleanup, and the "live instance vs abandoned socket" logic that Option B
   would hand-roll.
2. **Zero new app code.** The callback reuses `restore_main_window` (`src-tauri/src/lib.rs`),
   the same helper the tray "show" item and tray left-click already call. One line of glue.
3. **Proven peer precedent (cc-switch).** The sibling project `cc-switch` ships exactly this
   pattern in the same stack:
   - **Dependency, desktop-gated:** `tauri-plugin-single-instance = "2"` under
     `[target.'cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))'.dependencies]`
     (`cc-switch` `src-tauri/Cargo.toml:84`).
   - **Registered first, callback focuses the window:** `builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| { … }))`
     whose body ends with `get_webview_window("main")` → `unminimize` + `show` + `set_focus`
     (`cc-switch` `src-tauri/src/lib.rs:211`). We adopt the same shape, minus cc-switch's
     deep-link argv parsing (this app has no deep-link scheme).
4. **Safe alongside the ADR-010 in-app updater.** A historical Tauri bug *did* make
   single-instance reject the post-update relaunch ([tauri#12310](https://github.com/tauri-apps/tauri/issues/12310),
   fixed by [PR#12313](https://github.com/tauri-apps/tauri/pull/12313)) — but only on the
   main-thread `restart()` shortcut that skipped `RunEvent::Exit`. The
   `tauri-plugin-process::relaunch()` path this app uses goes through the full `Exit` flow, which
   releases the single-instance socket/mutex/name *before* spawning the new process, and the fix
   shipped in Tauri 2.4.0. This repo pins Tauri 2.11.1 + single-instance 2.4.2, both well past
   it; cc-switch runs both plugins together in production with no special handling.

### Required app behaviour

- **MUST** register `tauri_plugin_single_instance::init(...)` **first**, before any other plugin
  or window initialisation, so the guard fires before the rest of startup commits.
- **MUST** gate the dependency and the registration on the same
  `cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))` so they stay in
  lock-step.
- **MUST** focus the existing window in the callback by reusing `restore_main_window`, not by
  creating a window.

## Consequences

### Positive

- One process, always: one tray icon, one pet window (ADR-011 invariant preserved), one writer
  to `config.json`, one set of background watchers — no duplicate webhook pushes or hook
  repairs.
- "Second launch" becomes "focus the running window", the behaviour users already expect from
  every other desktop app, including when the window was hidden to the tray.

### Negative

- **The second process does some throwaway work before it is rejected.** The guard fires inside
  `.run()`, but `env_path::ensure_patched()` and `db::open()` run *before* the builder. On a
  GUI launch with a truncated PATH, `ensure_patched` forks a login shell to recover the real
  PATH (typically 100–500 ms, up to a 3 s timeout in the worst case), so a rapid second launch
  can take up to ~3 s before the existing window is focused. This is **not** hidden: it is a
  known, documented cost. `ensure_patched`'s one-time `set_var` must run single-threaded before
  the tokio runtime starts, so it cannot be safely moved after the guard. Accepted as-is; if it
  ever bites in practice, the fix is to make the second process detect a peer *before*
  `ensure_patched` (a cheap pre-check), not to relax the PATH logic.
- **Linux gains a `zbus` (D-Bus) dependency** transitively via the plugin. Acceptable: it is the
  standard Linux single-instance transport and is already pulled in by the broader Tauri stack.

### Neutral

- The guard keys on the bundle identifier, so it stops *the same app* from running twice. It
  does not (and should not) stop two differently-pathed copies of the binary — that is a
  deliberate developer escape hatch, not a regression.

## References

- This change set: `src-tauri/Cargo.toml` (desktop-gated dependency), `src-tauri/src/lib.rs`
  (register-first + `restore_main_window` callback).
- Related: [ADR-011 — Desktop companion (Ink pet)](./0011-desktop-companion-ink-pet.md) (the
  one-pet invariant this guard protects); [ADR-010 — In-app auto-update](./0010-in-app-auto-update.md)
  (the updater this guard must coexist with).
- `cc-switch` dependency: `src-tauri/Cargo.toml:84`
  (<https://github.com/farion1231/cc-switch/blob/main/src-tauri/Cargo.toml>)
- `cc-switch` register-first + focus-window callback: `src-tauri/src/lib.rs:211`
  (<https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/lib.rs>)
- Tauri single-instance plugin docs: <https://v2.tauri.app/plugin/single-instance/>
- Single-instance × updater-relaunch fix: [tauri#12310](https://github.com/tauri-apps/tauri/issues/12310)
  / [PR#12313](https://github.com/tauri-apps/tauri/pull/12313) (shipped in Tauri 2.4.0)
