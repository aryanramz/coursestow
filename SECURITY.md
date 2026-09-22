# Security and release checklist

CourseStow operates inside an authenticated student session. Treat local browser state and mirrored course data as sensitive.

## Never commit

- `%LOCALAPPDATA%\CourseStow\` or copies of its contents
- the retained legacy `%LOCALAPPDATA%\Brightspace Sync\` runtime root after product-name migration
- `.brightspace-profile/`
- `BrightspaceMirror/`
- `config.json`
- `.env` or `.env.*`
- copied browser cookies, storage-state exports, or SSO tokens
- diagnostic bundles that have not been manually reviewed and redacted

## Authentication model

The crawler reuses a dedicated persistent Chromium profile. Microsoft Edge, Google Chrome, and Brave are the officially tested Windows browser families. Vivaldi, Opera, Opera GX, and Chromium use best-effort fixed-location discovery; another compatible Chromium executable can be selected manually.

Every user-selected executable is validated through Playwright's Chromium engine with a bounded headless `data:`-page probe. The probe uses a unique temporary profile, never the authenticated BrowserProfile, contacts no Brightspace site, closes the browser, and removes its temporary data. CourseStow does not broadly scan the filesystem, bundle a browser, download a Playwright browser, install extensions, or install a browser automatically.

Passwords are not required in `config.json` or environment variables. Browser password-manager assistance is optional and best-effort; normal SSO/MFA remains the supported fallback.

CourseStow does not export Playwright `storageState` to a separate plaintext JSON file. Session persistence stays inside the dedicated Chromium profile at `%LOCALAPPDATA%\CourseStow\BrowserProfile`. If the legacy `_brightspace-auth-state.json` file from v2.4.0 exists, the crawler removes it automatically. The browser profile itself remains sensitive and should be protected like any authenticated browser profile.

Configuration, session data, runtime state, locks, and the reserved log location are outside the application directory under `%LOCALAPPDATA%\CourseStow`. The mirror remains in a location selected by the user. Product-name and repo-relative migrations copy rather than delete legacy private data so rollback remains possible. If both old and new product runtime roots contain meaningful data, CourseStow stops for manual review instead of merging them. Users should remove a legacy copy manually only after they are satisfied with the migration.

The first-run source-checkout importer runs only after the user explicitly selects a directory and only when the installed runtime has no meaningful configured data. It rejects reparse-point sources, stages data before promotion, rolls back failed promotion, and leaves the source untouched. Only compatible config, BrowserProfile, and allowlisted continuity state are eligible; mirrors, Drive output, source code, Git metadata, dependencies, arbitrary files, logs, and plaintext credential fields are excluded.

CourseStow has no telemetry, analytics, crash-reporting service, elevation helper, Windows service, or force-kill path. Update checks are unauthenticated requests to the public GitHub Releases endpoint and persist only allowlisted version/cache metadata.

## Read-focused write protection

Authentication must be allowed to complete normally, so the network guard is installed only after Brightspace authentication succeeds.

After authentication the guard:

- blocks `PUT`, `PATCH`, and `DELETE`
- blocks same-origin form/document `POST` requests
- blocks POST targets or bodies that look state-changing, such as submit/save/delete/upload/update actions
- allows read-like Brightspace POST/RPC/XHR traffic that does not match those write indicators
- does not interfere with cross-origin SSO/session-refresh POSTs

This substantially reduces the risk of accidental state changes, but it is not a proof that the application is mathematically read-only. Simply visiting LMS pages can update server-side metadata such as viewed state or last-visited timestamps.

## Repository privacy checks

Before publishing a release:

1. Run `git status --ignored` and confirm the browser profile, mirror, and local config are ignored.
2. Run `git ls-files` and confirm none of those sensitive paths are tracked.
3. Run `npm run security-selftest` to scan the current working tree for known credential formats, institution-email patterns, student-ID-like fields, personal Windows profile paths, and unsafe public defaults.
4. Run `npm run history-security-selftest` from a full Git checkout to verify the sensitive runtime paths were never committed and scan every reachable commit for common secret/academic-PII patterns.
5. If sensitive material was ever committed, removing it in a later commit is **not enough**. Rewrite Git history before publishing and rotate any exposed credentials/tokens.

GitHub Actions performs both the current-tree security check and a full-history check before release-quality changes are merged.

## Dependency and portability controls

- Runtime dependencies are pinned and committed in `package-lock.json`.
- CI and setup use `npm ci` for reproducible installs.
- Runtime commands never install dependencies or create configuration beside the application files.
- `npm run runtime-paths-selftest` verifies read-only-capable application/runtime separation, legacy migration, idempotency, and Drive opt-in defaults.
- Linux CI runs syntax and functional/security self-tests on Node.js 20, 22, and the distributed Node.js 24.20.0 runtime.
- A `windows-latest` CI job runs the environment doctor and launches an installed Chromium browser through Playwright using a temporary persistent profile.
- Windows packaging tests verify version 3.0.0 across both EXEs, the portable manifest, packaged package metadata, installer ProductVersion, installer filename, and SHA-256 sidecar.

The Windows browser smoke test validates packaging/browser compatibility on a clean hosted Windows environment. It does not replace real testing against every institution's Brightspace and SSO deployment.

The 3.0.0 release-candidate installer is unsigned and may display **Unknown Publisher**. Do not disable Defender, SmartScreen, or other Windows security controls. Code signing and clean disposable-VM qualification remain release gates.

## Reporting security issues

Do not include real credentials, cookies, SSO tokens, grades, private student information, or copyrighted course files in a public GitHub issue. Use a minimal redacted reproduction.
