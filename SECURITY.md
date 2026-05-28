# Security Policy

## Supported versions

git-ai-studio is pre-release. Security fixes target the latest tag and `main`. There is no long-term-support branch yet.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, use one of:

- GitHub's private vulnerability reporting: the repository's **Security** tab → **Report a vulnerability**.
- Email the maintainers (address listed in `MAINTAINERS.md` once published).

We aim to acknowledge a report within 72 hours and to agree on a disclosure timeline with the reporter.

## What's in scope

git-ai-studio runs entirely on the user's machine. It:

- reads local git objects and `refs/notes/ai`,
- shells out to the `git-ai` CLI and `git` as subprocesses,
- optionally runs `git push refs/notes/ai` to a remote the user configures,
- downloads release binaries from GitHub Releases when the user clicks install/upgrade.

Relevant concern areas: subprocess invocation and argument handling, local file read/write paths, the optional notes push, and update-artifact verification (minisign). The app performs **no** telemetry, crash reporting, or background network calls.

## What's out of scope

- Vulnerabilities in the upstream [`git-ai`](https://github.com/git-ai-project/git-ai) CLI itself — please report those to the upstream project.
- Issues that require a pre-compromised local machine (an attacker who already has code execution as the user).
