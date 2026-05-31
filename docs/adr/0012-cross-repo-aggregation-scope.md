# ADR-012 · Cross-repo aggregation scope

**Status**: Accepted
**Date**: 2026-05-30

## Context

Until now every analysis page (Dashboard / Stats / People) was bound to a single
"current repo": to see AI attribution across several projects you had to switch
repos one at a time and hold the comparison in your head. Users asked for a
day/week/month roll-up **across all of their repos at once**.

This is attractive but dangerous, because "aggregate across repos" sits one short
step away from things this product has explicitly promised **not** to be. The
product lock in [`docs/product/PR-FAQ.md`](../product/PR-FAQ.md) (FAQ #6) draws a
hard line between `git-ai-studio` (a single-developer, local, no-account desktop
client that looks at _your own_ repos) and Git AI Teams / Cloud (an org-level SaaS
dashboard sold per-seat). The moment "aggregate" starts meaning "aggregate across
people / across machines / push to a server / rank developers," we have rebuilt
the very thing we said we are not.

So the real decision is not "should we aggregate" — it is **how far does
aggregate reach, and what stays impossible by construction.**

Two existing invariants constrain the design:

- **No new network egress.** The only automatic outbound call is the ~1s GitHub
  `latest.json` version check (ADR-010). Aggregation must add **zero** new egress.
- **Loud failure, no fallback.** A repo whose `git-ai stats` fails must be shown
  as "not included," never silently folded in as a zero bucket
  (`src-tauri/src/commands/history.rs`, the "失败三分" rule).

## Options

**Option A — Auto-discover and aggregate every git repo on disk.**
Walk the filesystem, find every `.git`, aggregate them all. Zero-config "it just
works." Rejected: a filesystem walk is a surveillance-shaped behaviour, surfaces
repos the user never meant this tool to touch (client work, forks, vendored
code), and has no honest answer to "which repos am I actually looking at?" It also
makes the blast radius of a slow/huge repo unbounded and implicit.

**Option B — Aggregate the "recent repos" MRU list.**
Reuse the repo switcher's recent list as the aggregate set. Cheaper than A, but
the set is a side effect of _navigation_, not _intent_ — opening a repo once to
glance at it silently enrolls it into every future aggregate. The user cannot
reason about what is in the number.

**Option C — Explicit, user-checked repo set; aggregate only that.**
The user ticks repos into an `aggregate_repos` set on the Repo page. Dashboard
aggregates exactly that set, nothing more. Everything else (Stats / People / pet)
stays single-repo on the orthogonal `current_repo` focus. The set is intent, is
inspectable, and is the only thing that ever feeds a cross-repo number.

**Option D — Aggregate across people too (per-author org view / weekly team report).**
Rejected on sight: this is Git AI Teams' job and crosses the PR-FAQ #6 line. We
aggregate _repos_, never _people across machines_.

## Decision

**Adopt Option C, and make the boundaries structural rather than cultural.**

1. **The aggregation object is the machine-local, user-checked repo set.**
   `AppSettings.aggregate_repos` (M1) is an explicit list the user maintains on the
   Repo page. Dashboard's default view aggregates exactly the _valid_ entries of
   that set (`get_aggregate_history`, M2/M4). There is no auto-discovery and no
   implicit enrollment.

2. **Orthogonal to single-repo focus — not a replacement.** `current_repo`
   (single-repo drill-down: Stats, People, Blame, the Ink pet, LowAiShareWatcher)
   and `aggregate_repos` (cross-repo Dashboard) coexist. Clicking a commit or repo
   in the aggregate Dashboard sets `current_repo` and drills in. This keeps every
   single-repo consumer untouched and avoids a "dead-end" where the aggregate view
   has no way down to a specific commit.

3. **Cross-repo, never cross-person, never cloud.** Aggregation sums attribution
   **buckets** (human / unknown / ai additions) over the selected repos. It reads
   the same local `refs/notes/ai` and the same local SQLite cache. It adds **no**
   new network egress, **no** account, **no** shared infrastructure, and produces
   **no** per-author ranking or team report.

4. **Failure stays honest, per repo.** The payload carries `failed_repos`
   (whole-repo collection failure, with a human reason), `failed_shas` (single
   commit failure, keyed by `(repo_path, sha)` because a sha is not globally unique
   across repos), and `truncated_repos` (hit the 500-commit cap). The UI must
   surface each; a failed repo is **never** counted as zero. This is the
   no-fallback rule extended to the multi-repo case.

5. **Bounded blast radius.** Repos are walked sequentially with a per-repo inner
   `buffer_unordered(8)` (no nested fan-out, no deadlock), each repo capped at 500
   commits, results merged and **globally sorted by `authored_at` desc** so the
   "recent commits" view is correct across repos (M4). The cross-repo cache is
   keyed by the sorted repo set (`reposKey`) so re-ordering the checkboxes does not
   invalidate it.

### Peer evidence

- **VS Code multi-root workspaces** — the workspace is an _explicit_ set of folders
  the user adds, never an auto-discovered one; tooling operates on exactly that set.
  This is the direct precedent for "aggregate the checked set, not the disk."
  <https://code.visualstudio.com/docs/editor/multi-root-workspaces>
- **Spacedrive** — a local-first file explorer that indexes only user-added
  "locations," never the whole filesystem, and keeps the index on-device.
  Precedent for explicit opt-in + local-only.
  <https://github.com/spacedriveapp/spacedrive>
- **GitButler** — local-first git client: per-machine, no server round-trip for the
  core experience. Precedent that serious multi-repo git tooling can stay
  account-free and local.
  <https://github.com/gitbutlerapp/gitbutler>

## Non-goals (explicit, locked)

These are **out of scope by construction**, not "not yet built." Anything here
would cross the PR-FAQ #6 line into Git AI Teams' territory:

- **No cross-machine aggregation.** We aggregate repos on _this_ machine only.
- **No cross-remote / server-side aggregation.** No pulling other people's repos,
  no querying a remote for attribution.
- **No organization / team view.** No "all repos in org X," no shared dashboard.
- **No per-author team report / leaderboard / ranking.** People is per-repo and
  self-first by design; aggregation does not turn it into a who-did-what scoreboard
  across the company.
- **No new network egress.** Aggregation introduces no outbound calls beyond the
  pre-existing version check.
- **No cloud, no account, no shared infrastructure.**

## Consequences

**Positive.**

- The cross-repo number is always explainable: it is exactly the checked set,
  inspectable on the Repo page, with failures listed rather than hidden.
- Single-repo features are untouched: the orthogonal model means LowAiShare, the
  Ink pet, Blame, and per-commit drill-down keep their single-repo semantics.
- The product boundary is now enforced by data shape (repos in, no people/cloud
  out), not just by documentation — harder to erode by accident.

**Negative / costs.**

- Two history paths exist (`get_history` single-repo, `get_aggregate_history`
  cross-repo) sharing the `resolve_window_stats` helper. Slightly more surface to
  keep aligned; mitigated by the contract tests
  (`src/__tests__/aggregate.contract.test.ts`).
- Cross-repo over many/large repos is inherently slower (sequential repos, 500-cap
  each). Accepted: it is bounded, cached by repo set, and failures degrade per repo
  rather than failing the whole view.
- The user must opt in (tick repos) before the Dashboard shows anything; an empty
  set renders a "select repos" empty state rather than auto-filling. Accepted as
  the honest cost of "no implicit enrollment."

**Self-scope default ("only me"), landed.** Dashboard and People both default to an
`只看我 / 全部` (only-me / everyone) toggle defaulting to **only-me**, the honest
default for a single-developer tool and a structural reinforcement of the
"self-first, no leaderboard" boundary above. Mechanism differs by page because the
data shape does:

- **Dashboard (cross-repo)** filters in the backend (`get_aggregate_history(range,
  only_mine)`): each repo's _own_ effective `git config user.email` is resolved
  (`commands/repo.rs::read_git_user_email`, inside the repo dir so local→global
  inheritance is automatic) and only that author's commits are summed. A repo with
  no configured `user.email` cannot answer "who is me," so under only-me it is
  surfaced in `failed_repos` — **never** silently folded in as all-authors (the
  no-fallback rule).
- **People (single-repo)** filters client-side by `identity_key` (the row data
  already carries `author_email`), so the toggle is instant with no refetch; the
  overview totals are recomputed from the displayed rows
  (`peopleTable::sumRowsToTotals`) to stay self-consistent.

**Follow-ups (future, still inside the boundary).**

- People cross-repo (self + mailmap) is deferred to a later version; this ADR
  covers Dashboard aggregation only. When it lands it must obey every Non-goal here
  (still self-first, still no leaderboard).
