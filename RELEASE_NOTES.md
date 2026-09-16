# v3.0.0 — Windows release candidate (not yet published)

CourseMirror 3.0.0 completes the reviewed Windows desktop, installer, setup, scheduling, authentication, update-checking, and packaging work. No `v3.0.0` tag or GitHub Release exists yet; final naming and clean-VM qualification remain separate gates.

## User-facing changes since v2.4.1

- Added a normal per-user Windows installer for Windows 10 22H2+ and Windows 11 x64. It needs no administrator elevation and bundles a private Node.js runtime, so end users do not need Node.js, npm, or Git.
- Added the native CourseMirror control panel with Quick Sync, Full Sync, Open Mirror, Settings, Refresh Login, logs, status polling, sanitized diagnostics, and update notices.
- Added shared first-run and Settings UI for the Brightspace URL, mirror folder, optional Google Drive publishing, optional supported automatic login, browser selection, and optional Windows scheduling.
- Completed **Save & Sign In**: successful first-run settings launch the existing visible SSO/MFA flow, followed by exactly one initial Full Sync only after authentication succeeds.
- Kept the persistent browser session private under `%LOCALAPPDATA%\CourseMirror\BrowserProfile`; MFA is never bypassed. Supported Stony Brook automatic login is opt-in and stores its password only in Windows Credential Manager.
- Added official compatibility-tested support for Microsoft Edge, Google Chrome, and Brave. Vivaldi, Opera, Opera GX, and Chromium use best-effort discovery, and users can select another Chromium executable for an isolated Playwright compatibility probe.
- Added missing-browser recovery with Retry, manual executable selection, automatic-detection reset, and a fixed trusted Microsoft Edge download link. CourseMirror never bundles or silently installs a browser.
- Added explicit transactional import from a user-selected CourseMirror or supported pre-rename Brightspace Sync source checkout. It imports only compatible configuration, BrowserProfile session data, and allowlisted continuity state; mirrors, Drive copies, source, Git data, dependencies, and plaintext credentials are not copied.
- Added optional current-user Task Scheduler integration with safe create/update/disable rollback and Quick/Full cadence selection.
- Added installer upgrade, repair, downgrade blocking, active-operation preflight, scheduled-task reconciliation, and privacy-preserving uninstall behavior. Default uninstall preserves private data, credentials, mirror, and Drive output.
- Added asynchronous public GitHub Releases update checking. It does not download or execute installers and sends no telemetry.
- Added a tag-driven future release pipeline that verifies the versioned installer and SHA-256 sidecar before publication. The expected files are `CourseMirror-3.0.0-Setup.exe` and `CourseMirror-3.0.0-Setup.exe.sha256`.
- Retained strict private-data/application separation, read-focused network protections, sanitized failure-only logs, and no analytics, telemetry, crash-reporting service, or browser extension.

## Known release-candidate limitation

The Windows binaries and installer are unsigned and may display **Unknown Publisher**. Users should keep Windows security protections enabled. Code signing and clean disposable-VM install/upgrade/repair/uninstall qualification remain later release gates.

---

# v2.4.1

Security, privacy, dependency-reproducibility, and Windows portability hardening.

## Highlights

- Removed the standalone Playwright `storageState` cookie/session export. Session persistence now stays inside the dedicated Chromium profile.
- Automatically removes the legacy `_brightspace-auth-state.json` plaintext session backup created by v2.4.0.
- Added a post-authentication network write guard that blocks `PUT`, `PATCH`, `DELETE`, same-origin form/document POSTs, and POST actions that look state-changing while preserving read-like Brightspace RPC/XHR traffic.
- Added regression tests for the write guard.
- Replaced Brave-only browser lookup with shared Windows detection for Brave, Google Chrome, and Microsoft Edge, while preserving manual `browserExecutablePath` support.
- Added a Windows environment doctor and a GitHub-hosted `windows-latest` browser smoke test that launches an installed Chromium browser through Playwright with a temporary persistent profile.
- Pinned Playwright to 1.55.1, patching the high-severity SSL-certificate verification advisory affecting versions below 1.55.1, and committed `package-lock.json` for reproducible installs.
- Added a high-severity runtime dependency audit gate to CI.
- Switched CI/setup/first-run launcher dependency installation to `npm ci`.
- Expanded current-tree privacy scanning to cover common secret formats, institution-email patterns, student-ID-like fields, personal Windows paths, unsafe public defaults, and accidental standalone auth-state exports.
- Added a full-Git-history security test that verifies sensitive runtime paths were never committed and scans reachable commits for common credential/academic-PII patterns.
- Updated README and `SECURITY.md` to state the actual support/security contract: Windows desktop only, read-focused rather than mathematically read-only, and institution-specific Brightspace/SSO compatibility still requires real-world validation.

## Validation

Release validation requires all Linux Node.js 20/22 functional/security jobs, the dependency vulnerability audit, the full-history security scan, and the `windows-latest` browser smoke job to pass before merge/release.

No mirror migration is required. Existing `config.json`, `.brightspace-profile/`, and `BrightspaceMirror/` remain local. The only security cleanup is automatic removal of the legacy plaintext `_brightspace-auth-state.json` backup if it exists.

---

# v2.4.0

Deadline-change intelligence for cross-course deadline tracking.

## Highlights

- Compares normalized deadlines against the previous sync before the upcoming index is overwritten.
- Detects due-date and due-time changes with structured `before` and `after` values.
- Detects newly dated assignments, quizzes, and calendar-backed work.
- Detects deadline removal only when the item itself still exists, avoiding false positives when an item disappears entirely.
- Adds a dedicated **Deadline changes** section to `sync-digest.md`.
- Adds structured `deadlineChanges` entries and counts to `sync-digest.json`.
- Applies deadline intelligence to school-wide and active-term digests.
- Adds regression coverage for moved, added, removed, disappeared-item, and first-run baseline cases.
- Preserves clean unchanged Quick Sync behavior with zero deadline-change false positives.

## Validation

The deadline-intelligence self-test passes. A live unchanged Quick Sync produced 0 added, 0 updated, 33 upcoming deadlines, 0 deadline changes, 0 digest entries, and a successful incremental Google Drive publish.

No migration is required for existing installs. Existing `config.json`, `.brightspace-profile/`, and `BrightspaceMirror/` remain local and are not replaced by release files.

# v2.3.0

This release improves cross-course retrieval and eliminates recurring false-positive asset-index changes during unchanged Quick Sync runs.

## Highlights

- Added normalized cross-course upcoming-deadlines indexes in `_school/upcoming.json` and `_school/upcoming.md`.
- Added compact cross-course sync digests in `_school/sync-digest.json` and `_school/sync-digest.md`.
- Added term-scoped copies of both indexes under `_school/<term>/`.
- Added normalized deadline extraction for assignments, quizzes, and calendar events with duplicate suppression and chronological sorting.
- Separated student-facing changes from technical mirror changes in the sync digest.
- Fixed noisy `assets.json` rewrites caused by ordinary Brightspace navigation/UI links being treated as assets.
- Canonicalized and deterministically sorted asset-index entries for stable incremental comparisons.
- Added synthetic regression tests for school indexes and asset-index stability and wired both into CI.
- Expanded the synthetic sample mirror and README to document the new index outputs.
- Finalized runtime and launcher version labels for the stable release line.

## Validation

A repeated unchanged Quick Sync now reports zero Brightspace changes while preserving the normalized upcoming-deadline index. Google Drive publishing continues to run incrementally after index generation.

No migration is required for an existing local install. Existing `config.json`, `.brightspace-profile/`, and `BrightspaceMirror/` remain local and are not replaced by the release files.

---

# v2.2.0

Initial public release focused on portability, privacy, and safe authenticated Brightspace synchronization.

## Highlights

- Persistent browser-session reuse with normal SSO/MFA when required.
- Dynamic Brightspace course discovery.
- Quick and Full synchronization modes.
- Term-scoped historical archives and change detection.
- Student-visible assignments, quizzes, grades, announcements, calendar, discussions, and course content.
- Selective asset downloading with configurable size limits.
- Optional incremental Google Drive for desktop publishing.
- Shared process locking and smart scheduled synchronization.
- Public-release security hardening and CI checks.
- MIT License.

## Changes from v2.1

- Replaced the institution-specific URL in `config.example.json` with a generic Brightspace placeholder.
- Removed a hardcoded institution org-unit ID from course discovery.
- Generalized institution-specific comments and course-folder normalization wording.
- Added Winter-term cleanup support to the course-name canonicalizer.
- Disabled Google Drive publishing by default for new public installs.
- Disabled saved-browser-credential auto-submit by default for new public installs; manual SSO/MFA remains the reliable fallback.
- Expanded `.gitignore` and the security self-test.
- Rewrote the README for public installation, limitations, privacy, and architecture.
- Added `SECURITY.md` and an MIT `LICENSE`.

No migration is required for an existing local install. Existing `config.json`, `.brightspace-profile/`, and `BrightspaceMirror/` remain local and are not replaced by the release files.
