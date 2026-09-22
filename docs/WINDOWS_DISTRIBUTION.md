# CourseStow — for D2L Brightspace: Windows distribution foundation

This document records CourseStow's Windows distribution, desktop, and installer lifecycle contracts. The default per-user application location is `%LOCALAPPDATA%\Programs\CourseStow\`; private runtime data remains separate at `%LOCALAPPDATA%\CourseStow\`.

CourseStow is published by **aryanramz** at `https://github.com/aryanramz/coursestow`. CourseStow is an unofficial third-party utility for D2L Brightspace. It is not affiliated with or endorsed by D2L Corporation.

## Storage contract

Application files are treated as immutable. Code, bundled defaults, dependencies, and launchers may be installed under `Program Files` in a later milestone. Runtime commands do not create configuration, session, state, lock, mirror, or log files in that directory.

Per-user private runtime data uses:

```text
%LOCALAPPDATA%\CourseStow\
  config.json                 User configuration
  BrowserProfile\             Chromium cookies and session data
  state\                      Sync, course, publish, lock, and migration state
  logs\                       Reserved application/installer log root
```

The mirror is separate and user-selectable through `outputDir`. A blank value resolves to the current user's `Documents\CourseStow`. Relative paths in the new per-user config resolve from `%LOCALAPPDATA%\CourseStow`; absolute paths are recommended for clarity.

`COURSESTOW_DATA_DIR` can override the normal per-user data root for controlled testing or managed deployments. A non-empty `COURSESTOW_MIRROR_DIR` is authoritative for the effective mirror path: it overrides `outputDir` without rewriting the saved configuration. The former `BRIGHTSPACE_SYNC_DATA_DIR` and `BRIGHTSPACE_SYNC_MIRROR_DIR` names remain accepted as lower-priority compatibility aliases. When no mirror override is present, the configured `outputDir` and existing legacy path-preservation behavior apply normally. None of these variables is required for a normal install.

## Configuration schema and persistence

Per-user configuration declares `"configVersion": 1`. A configuration without `configVersion` is schema v0 and is migrated through an ordered migration table to v1. Each migration advances exactly one supported schema boundary so later releases can add v1 → v2, v2 → v3, and subsequent steps without replacing the migration model.

The v0 → v1 migration retains all known and unknown keys, adds `configVersion`, and removes only settings with an explicit deprecation path such as `profileDir` after its browser-profile migration completes. If a configuration declares a version newer than the application supports, startup stops with a clear upgrade-required error and leaves that file unchanged.

Critical JSON is persisted through same-directory unique temporary files. CourseStow writes and flushes the complete temporary file, closes it, and then replaces the destination by rename. An ordinary write or replacement failure removes the temporary file when possible and leaves the previous valid destination intact. This atomic path is used for `config.json`, `state\runtime-migrations.json`, and the small global, course, and Drive runtime-state files. Ordinary mirror content retains its existing content-aware writer so unchanged mirror files keep their timestamps.

## Initialization serialization

First-run creation and migration are serialized by `state\.coursestow-init.lock`, which is separate from the normal sync/publish lock. `loadAppConfig()` holds the initialization lock while creating or versioning config, migrating the legacy profile and runtime state, and updating the migration log, then releases it in guaranteed cleanup before normal sync or publish work proceeds.

A competing process waits for up to 30 seconds and polls every 100 ms by default. A same-host lock whose PID is still running is never removed based on age. A same-host lock with a dead PID is recoverable immediately; malformed or foreign-host locks become recoverable only after one hour. If the bounded wait expires, startup fails with the lock owner and start time instead of stealing the active lock. Because initialization is released before any later operation acquires another lock, the initialization and sync/publish locks do not form a lock-order cycle.

## Backward compatibility

Before normal initialization, a default Windows installation checks the former `%LOCALAPPDATA%\Brightspace Sync` private runtime root. If it contains meaningful data and `%LOCALAPPDATA%\CourseStow` does not, the complete config, BrowserProfile, state, and logs tree is copied to a uniquely named staging directory and promoted atomically only after the copy is complete. The old root is never deleted, the selected mirror path is preserved, and the actual school mirror is not moved. A completion marker makes retries idempotent. If both roots contain meaningful independent data, migration stops with a deterministic manual-review conflict rather than merging or overwriting either root. Explicit data-directory overrides do not trigger this automatic product-root migration.

On first run, if the per-user configuration does not yet exist, the runtime looks for a legacy `config.json` beside the application. It copies that config to the new location and converts a relative `outputDir` to the equivalent absolute path.

The legacy `profileDir` setting is used as a migration source and then removed from the new config. The runtime owns the current browser-profile location so application updates cannot redirect the session back into `Program Files`. Profile migration copies into `BrowserProfile.migrating` first and atomically renames it only after the complete copy succeeds. An interrupted staging copy is discarded and recopied on retry, while the legacy source remains unchanged.

When the new destinations are absent, the runtime also copies recognized legacy data:

- `.brightspace-profile` or a repo-relative configured profile to `BrowserProfile`
- `_system/state.json` or legacy `_sync_state.json` to `state\state.json`
- `_system/drive_publish_state.json` to `state\drive_publish_state.json`
- per-course `_sync_state.json` data into `state\courses\<course-id>.json` as each course is next synchronized

Migration does not overwrite an existing destination and does not delete the legacy source. Repeated startup is idempotent. Applied actions are recorded in `state\runtime-migrations.json`.

Legacy per-course `_sync_state.json` files remain in the local mirror for rollback but are excluded from Google Drive publishing.

## Launcher contract

`src/launcher.mjs` is the stable command dispatcher. It resolves entry points from its own installed application path, not the caller's working directory. Supported commands are `quick`, `full`, `publish`, `scheduled`, `setup-login`, `refresh-login`, `doctor`, and the machine-readable `status --json` and `settings` desktop contracts.

The `.cmd`, PowerShell, and npm entry points all delegate through this launcher. Scheduled sync resolves the child sync entry through the same application-root abstraction. Runtime wrappers fail with a reinstall/setup message if packaged dependencies are missing; they never attempt to modify the installed application tree.

## Google Drive choice

New configs set `drivePublish.enabled` to `false` and leave `destination` blank. Publishing runs only after the user explicitly enables it and selects a Google Drive for desktop folder. An explicit choice from a legacy config is preserved during migration.

## Portable packaged-runtime contract

`npm run build:windows-bundle` creates the intermediate x64 application bundle under `dist\CourseStow`. It is a portable packaging proof, not the public installer or a `Setup.exe`.

The bundle contains a private, checksum-verified Node.js 24.20.0 x64 runtime at `runtime\node.exe`. Node 24 is used because Node 20 reached end of life in March 2026; Node 24 remains supported LTS. The packaged `CourseStow.cmd` resolves both the private runtime and `app\src\launcher.mjs` relative to its own location, so it does not use `node` from `PATH` or depend on the caller's working directory. End users do not need Node.js, npm, Git, or a source checkout, and the launcher does not require PowerShell execution-policy changes.

The packaged application tree contains only runtime source, the generic example configuration, application/runtime licenses, and locked production dependencies. Playwright's JavaScript runtime is installed with lifecycle scripts and browser downloads disabled. Browser binaries are not bundled: Microsoft Edge, Google Chrome, and Brave are officially tested; Vivaldi, Opera, Opera GX, and Chromium use best-effort fixed-location discovery, and users may select another compatible Chromium executable.

The package layout is:

```text
dist\CourseStow\
  CourseStow.exe
  CourseStow.exe.config
  CourseStow Credential Helper.exe
  CourseStow Credential Helper.exe.config
  CourseStow.cmd
  bundle-manifest.json
  runtime\
    node.exe
    NODE_LICENSE.txt
  app\
    package.json
    config.example.json
    LICENSE
    src\
    node_modules\
```

Application files remain immutable at runtime. Configuration, browser session, state, locks, and logs continue to use `%LOCALAPPDATA%\CourseStow`, subject to the `COURSESTOW_DATA_DIR` override. The mirror remains separate and user-selectable, including through `COURSESTOW_MIRROR_DIR`.

## Windows desktop control panel (Milestone 2B.1)

The control panel targets **.NET Framework 4.8 WinForms**. Microsoft's [.NET Framework system requirements](https://learn.microsoft.com/en-us/dotnet/framework/get-started/system-requirements) list supported Windows 10 and Windows 11 releases with .NET Framework 4.8 or 4.8.1, so this produces a small native desktop executable without adding a separate modern .NET Desktop Runtime prerequisite. A modern framework-dependent WinForms build would require that separate runtime, while a modern self-contained build would materially increase the application and installer footprint; see Microsoft's [.NET deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/). .NET Framework WinForms also supports the Windows interoperability needed by later Credential Manager and Task Scheduler milestones.

The GUI is intentionally a thin Windows shell. C# owns controls, user interaction, hidden process launching, safe bounded result display, Explorer folder opening, and a non-sensitive control-panel activity log. The existing Node application remains authoritative for configuration and migration, runtime and mirror paths, locking, status, and synchronization.

The versioned status command is:

```text
runtime\node.exe app\src\launcher.mjs status --json
```

Its schema version 1 response contains only GUI-safe state:

```json
{
  "schemaVersion": 1,
  "appVersion": "3.0.0",
  "status": "ready",
  "configExists": true,
  "configured": false,
  "baseUrlConfigured": false,
  "mirrorDir": "<Node-resolved path>",
  "logsDir": "<Node-resolved path>",
  "dataDir": "<Node-resolved path>",
  "profileExists": true,
  "lastSync": null,
  "activeOperation": null
}
```

It never returns configuration contents, URLs, cookies, credentials, tokens, or browser-session data. Calling status performs the same serialized runtime initialization as other Node commands, so the GUI does not reproduce configuration or path logic in C#.

Quick Sync and Full Sync invoke `quick` and `full` through the packaged `runtime\node.exe` and `app\src\launcher.mjs`. Standard output, standard error, and the exit code are captured with no console window. The UI displays only a concise bounded outcome, disables both sync buttons while a GUI operation is active, and relies on the existing Node sync lock for cross-process protection. After a run, it refreshes the structured status to obtain the authoritative last-successful-sync timestamp.

The open control panel refreshes backend status approximately every five seconds and when activated, skipping rather than overlapping an in-progress status request. Quick and Full also perform an immediate status preflight before launch. Desktop status uses the sync lock's shared read-only inspection API, so live, dead-PID, foreign, malformed, and aged locks follow the same stale classification as normal lock acquisition without status acquiring or deleting the lock.

Failed GUI syncs append a bounded entry to the Node-resolved `logs\backend-failures.log`. Only the timestamp, operation, exit code, and sanitized standard-error tail are retained. URLs, credential-like fields, authorization/cookie values, and recognized key/token formats are redacted; standard output is never written to this log or shown in the main window.

Open Mirror and View Logs use the paths from the status response. C# does not derive `%LOCALAPPDATA%` or the mirror location. Missing directories are reported without silently creating them.

## First-run setup and Settings (Milestone 2B.2)

When `status --json` reports `configured: false`, the control panel automatically opens the shared **Set up CourseStow** form. Cancelling leaves the per-user configuration unconfigured and keeps Quick Sync and Full Sync disabled. The primary fresh-install action is **Save & Sign In**. A successful save refreshes status, runs the existing locked **Refresh Login** path, waits for normal SSO/MFA completion, and starts exactly one ordinary Full Sync only after authentication succeeds. A cancelled or failed sign-in preserves valid settings and does not start Full Sync. A failed initial Full Sync preserves both configuration and the authenticated BrowserProfile so the user can retry from the control panel. The Settings button opens the same form with current values, while an already configured or preserved runtime never reruns first-run orchestration merely because the application was reinstalled.

The GUI obtains settings from:

```text
runtime\node.exe app\src\launcher.mjs settings --json
```

Schema version 1 exposes only `configured`, `baseUrl`, the effective `mirrorDir`, `mirrorOverrideActive`, optional Drive `enabled`/`destination` fields, browser availability/display/source/validation metadata, import eligibility, and non-secret authentication availability/enabled flags. It never exposes usernames, passwords, credentials, cookies, tokens, browser-session data, profile contents, or unrelated configuration. Saves use `settings save --json`; browser probes and imports likewise use bounded versioned JSON through standard input. User paths and settings never appear in command-line arguments, environment variables, or logs. Node performs HTTPS URL normalization and validation, validates absolute paths and protected-path separation, merges the supported fields into the existing schema, preserves unexposed settings, and atomically replaces `config.json` under the existing initialization lock.

The browser section keeps the existing `browserExecutablePath` config key. A blank value means automatic detection; a non-empty absolute path means explicit manual selection and takes priority. Automatic discovery checks only fixed per-user and machine installation locations and never recursively scans user directories. Each candidate must pass a bounded headless Playwright Chromium probe against a local `data:` page using a unique temporary profile. The probe never uses the authenticated BrowserProfile, reaches Brightspace, retains cookies, or leaves temporary data. Missing-browser recovery offers **Retry**, **Choose browser executable**, **Use automatic**, the fixed trusted Microsoft Edge download page, and **Cancel**. It never downloads or silently installs a browser.

Eligible fresh installations can choose **Import settings from an existing CourseStow setup** and explicitly select a CourseStow or supported pre-rename Brightspace Sync source-checkout directory. CourseStow performs no disk-wide search and guesses no personal path. The importer rejects reparse-point roots/entries, validates compatible config, strips plaintext credential-like fields, stages the entire supported import, and promotes it under the existing locks with rollback on failure. Only config, BrowserProfile (including the historical `.brightspace-profile` layout), and allowlisted continuity state are imported. School mirror and Drive contents remain referenced at their existing paths and are never copied or moved; source code, `.git`, `node_modules`, build output, logs, arbitrary files, and plaintext credentials are ignored. The source is never modified or deleted, and meaningful installed runtime data can never be overwritten by this path.

Fresh setup suggests `CourseStow` under the actual Windows Documents known folder returned by `.NET`, so redirected OneDrive or policy-controlled Documents locations are respected. The user may edit or browse to any suitable absolute school-folder location. Private runtime data remains under the Node-resolved data directory and is never placed inside or moved with the mirror.

Changing a non-empty existing mirror requires an explicit choice:

- **Move existing mirror** asks Node to relocate the course files. Empty destinations are allowed; non-empty destinations are rejected instead of overwritten. Same-volume moves use a filesystem rename, while cross-volume moves stage a complete copy before promotion. The config switches only after the move succeeds, and handled failures roll the filesystem back and retain the old configured path.
- **Use new location** updates `outputDir` and deliberately leaves the old mirror untouched.
- **Cancel** makes no configuration change.

If the old mirror is absent or effectively empty, an ordinary save is sufficient. A `COURSESTOW_MIRROR_DIR` environment override remains authoritative: Settings shows the effective path read-only, rejects a misleading different path, and does not rewrite the saved `outputDir`.

Google Drive publishing remains off by default. Enabling **Publish mirror to Google Drive** requires a separate absolute filesystem destination, intended for a Google Drive for desktop folder. Disabling publishing permits an empty destination. This feature uses the existing `drivePublish.enabled` and `drivePublish.destination` keys; it does not add Google OAuth or publish private runtime data.

For development, build the native executable with:

```powershell
npm run build:windows-control-panel
```

The primary integration path is the portable bundle:

```powershell
npm run build:windows-bundle
npm run windows-bundle-selftest
& '.\dist\CourseStow\CourseStow.exe'
```

The standalone build output can target an already-built bundle by setting `COURSESTOW_DEV_BUNDLE_ROOT` to the absolute `dist\CourseStow` directory before launching it. Normal packaged launches leave this development override unset and locate the private Node runtime relative to the GUI executable.

## Secure institutional authentication (Milestone 2B.3)

Persistent Chromium-session login remains the generic default. CourseStow never implements a generic password-field search or automatic form filler. Institution-specific automatic sign-in is opt-in and is available only through an explicit adapter; the initial adapter supports the exact Brightspace host `mycourses.stonybrook.edu` and retrieves credentials only after the browser reaches the exact HTTPS SSO origin `https://sso.cc.stonybrook.edu`. HTTP, lookalike, and unexpected hosts stop automatic filling without retrieving a credential.

The Settings form shows **Automatically sign me in when my session expires**, Username, and Password only for the supported Stony Brook site. The password is stored as a Windows Generic Credential under the canonical target `CourseStow:institution:stony-brook`; the former `Brightspace Sync:institution:stony-brook` target remains a read-compatible migration source and is removed after a successful canonical write or deletion. It is never written to `config.json`, the mirror, Drive, state, logs, command arguments, environment variables, or desktop JSON responses. Existing passwords are never displayed. A blank password preserves the saved password only when the username is unchanged; entering a password replaces it. Disabling automatic sign-in or choosing **Remove saved sign-in** deletes the saved credential when Settings is saved. `config.json` stores only the non-secret `auth.automaticLoginEnabled` flag.

The bundled `CourseStow Credential Helper.exe` is a narrowly scoped .NET Framework helper around Windows Credential Manager. The packaged Node process launches it without a console and exchanges a bounded, versioned request through a randomly named local named pipe. Credentials are not placed in process arguments, standard streams, environment variables, or temporary files. Helper failures return a fixed non-secret diagnostic.

Normal sync first tests the persistent profile. A valid session continues without opening Credential Manager. The persistent sync browser is always headed so a human login or MFA challenge can be restored reliably; the existing background/headless preference starts that real window minimized, as does automatic institutional sign-in. Ordinary foreground mode is not minimized. When Stony Brook automatic sign-in is enabled, the adapter clicks only the exact recognized institutional SAML handoff on the trusted Brightspace origin. After the browser reaches the exact trusted SSO origin, Node requests the credential, fills only the adapter's exact selectors, submits once, and clears its short-lived credential object. Duo and other human challenges are never bypassed; the minimized browser is restored only when human action is required, and the same session continues after approval.

**Refresh Login** now runs `refresh-login` through the private packaged Node runtime. It acquires the existing operation lock, opens the same persistent browser profile visibly, navigates to the safe normalized Brightspace URL, waits for manual SSO/MFA completion, verifies the authenticated Brightspace state, closes cleanly, and refreshes control-panel status. The backend subprocess remains hidden; only the interactive browser is shown.

This first adapter intentionally depends on the currently recognized Stony Brook Brightspace login control and SSO page structure. Authenticated state requires both the trusted configured Brightspace origin and Brightspace UI evidence. Unexpected authentication states or handoff destinations fail closed and direct the user to Refresh Login. Future adapter changes must be reviewed against the live institutional flow without weakening exact-origin validation. Credential Manager protects credentials for the signed-in Windows account; it is not intended to defend against malicious code already running as that same user.

## Windows background scheduling (Milestone 2B.4)

Automatic sync is off by default and remains an explicit user choice in the shared first-run/Settings form. The existing config schema now retains:

```json
{
  "schedule": {
    "enabled": false,
    "intervalHours": 6,
    "fullIntervalDays": 7
  }
}
```

The UI accepts a recurrence from 1–24 hours and a Full Sync interval from 1–30 days. A legacy `schedule` object containing only `fullIntervalDays` remains valid in memory with scheduling disabled and the six-hour default; reading it does not rewrite the config, and unknown schedule keys are preserved on save.

When enabled, CourseStow owns exactly one task under `\CourseStow`. Its name is `Scheduled Sync - <current-user-SID>`, derived from the stable Windows security identifier rather than the renameable account name. Each Windows account therefore addresses only its own managed task. It is registered for that same SID with **interactive-token** logon and least privilege, so it runs only while that user is signed in and stores no Windows password. The task does not wake the computer, runs on battery, starts when a missed trigger becomes available, and ignores a second trigger while an instance is already active. Its action contains only the canonical installed `CourseStow.exe` path and the fixed argument `--scheduled-run`; SID, URL, mirror, Drive, credential, and other settings never appear in the action arguments.

Settings also checks only the current SID's exact former `\Brightspace Sync\Scheduled Sync - <Windows SID>` task. On the next successful scheduling reconciliation it creates or updates the canonical CourseStow task as requested and removes that exact legacy task. Snapshot/rollback covers both identities; tasks for other SIDs and unrelated tasks are never touched.

`--scheduled-run` is handled before the control-panel mutex or WinForms startup. The WinExe launches the private packaged Node runtime and fixed `scheduled` launcher command without a console, waits for completion, and returns its exit code. Node chooses Full when no successful Full Sync is recorded or the configured Full interval has elapsed; otherwise it chooses Quick. Malformed status is treated conservatively as requiring Full. The existing Node operation lock remains the final concurrency authority, and a scheduled overlap returns a distinct safe status rather than starting a second crawler.

The sync browser remains headed so login or MFA can be completed, but a scheduled launch starts minimized. A valid persistent session completes without user interaction. An authentication failure returns a dedicated non-secret result, records only `refresh-login-required`, and creates a private state latch. Later scheduled triggers stop before launching a browser or reading a credential until successful Refresh Login, a successful manual Quick/Full Sync, or an intentional authentication/credential update clears the latch. The latch contains no account, URL, credential, token, cookie, or form data and never enters the mirror or Drive.

Settings treats an enabled schedule, cadence change, or disable operation as one coordinated Task Scheduler/config transaction. It snapshots the current user's exact managed task, applies the requested registration first, then saves config through the existing Node transaction. A required task-registration failure leaves config unchanged; a config failure restores the exact prior task definition. Credential and scheduling changes use the same rollback path, and any incomplete rollback is surfaced as requiring manual review. When config is already disabled, Task Scheduler unavailability does not block unrelated URL, mirror, Drive, or authentication saves. A stale task is safe because the Node scheduled entry point checks `schedule.enabled` before syncing; Settings shows a nonfatal review warning and reconciles the stale task once Task Scheduler becomes available again.

Opening Settings compares the current user's task with the current binary path, cadence, interactive-token logon, least privilege, battery/wake policy, fixed action, and indefinite lifetime policy. `ExecutionTimeLimit` is `PT0S`, repetition has no finite duration, and the trigger has no `EndBoundary`, leaving CourseStow's own operation/authentication timeouts and lock lifecycle authoritative. A finite or otherwise altered task is repaired on the next successful Save. Disabling removes only the current SID's exact managed task and leaves other users' and unrelated Task Scheduler entries untouched.

Scheduled outcomes append to the private Node-resolved `logs\scheduled.log`. The file is bounded to 64 KiB and contains only timestamp, selected mode, exit code, and a fixed high-level category, including `refresh-login-required`. It never contains crawler output, page content, URLs, usernames, credentials, tokens, cookies, or raw errors.

Automated tests use a mock Task Scheduler service to prove idempotent create/update/delete, exact-definition rollback, combined credential rollback, reconciliation, and partial-failure reporting without altering a developer or hosted runner's real task library. The packaged Windows test exercises the actual `CourseStow.exe --scheduled-run` → private Node path with isolated external data and no configured site, proving the no-UI/no-console entry point without contacting Brightspace. A real disposable Task Scheduler registration test is intentionally not part of routine CI because it would mutate host-level scheduled-task state.

## Windows installer build foundation (Milestone 2C.1)

The installer consumes the already-verified portable bundle at `dist\CourseStow`; it does not compile raw application source. The supported chain is:

```text
npm run build:windows-bundle
    -> dist\CourseStow\
npm run build:windows-installer
    -> dist\installer\CourseStow-<version>-Setup.exe
    -> dist\installer\CourseStow-<version>-Setup.exe.sha256
```

The application and installer version both come from `package.json`. The build validates that the portable manifest and packaged application agree with that version before invoking Inno Setup. The SHA-256 sidecar uses lowercase hexadecimal, two spaces, and the setup filename.

Local installer builds require **Inno Setup 7.1.0 x64 exactly**. Install that compiler separately and either let the build locate a normal Inno Setup 7 installation or set `ISCC_PATH` to its `ISCC.exe`. The normal local build never downloads or installs developer tooling. From a Windows source checkout:

```powershell
npm ci --ignore-scripts
npm run build:windows-bundle
$env:ISCC_PATH = 'C:\path\to\Inno Setup 7\ISCC.exe' # optional
npm run build:windows-installer
```

CI obtains the immutable official `innosetup-7.1.0-x64.exe` release asset, verifies its pinned SHA-256 and valid Authenticode signature, installs it into runner-temporary storage, and uses the same installer build entry point. Ordinary branch and pull-request CI uploads the result only as the short-lived `coursestow-installer-development` artifact; it is not an official GitHub Release.

The generated setup is English-only, per-user, and requires no elevation. It installs to the fixed `%LOCALAPPDATA%\Programs\CourseStow\` location and keeps the existing private `%LOCALAPPDATA%\CourseStow\` runtime data separate. It creates exactly one direct Start Menu application shortcut, offers an optional desktop shortcut that is off by default, and offers to launch CourseStow on completion. Application settings, login, mirror, Drive, and scheduling remain in the application's existing first-run experience rather than the installer wizard.

The supported baseline is Windows 10 version 22H2 (build 19045) or later on x64 hardware, including Windows 11 x64. The setup blocks 32-bit Windows and ARM64. It requires .NET Framework 4.8 or newer; when missing, it stops and offers to open Microsoft's official download page rather than installing .NET silently. The portable bundle supplies the private Node runtime and Playwright library but no Chromium browser.

2C.1 installers are intentionally unsigned development/test artifacts. Code signing, release publication, update checks, and clean-VM qualification remain later milestones. Users should not be instructed to weaken Windows Defender or SmartScreen.

## Windows installer lifecycle management (Milestone 2C.2)

The permanent per-user App ID identifies fresh install, upgrade, and same-version repair. Installed and incoming versions are parsed and compared numerically. A newer incoming version upgrades in place, the same version repairs the managed payload, and an older incoming version is blocked without a force-downgrade path. The current reviewed release-candidate version is `3.0.0`.

Install, upgrade, repair, and uninstall run a hidden CourseStow-owned preflight before application files are changed. The incoming install payload supplies the trusted preflight copy for setup; uninstall uses the installed executable. Preflight checks the canonical and legacy control-panel mutexes, the credential-helper activity mutex, and the Node status contract's authoritative active-operation result. That preserves the existing live/dead-PID and stale foreign/malformed lock semantics. Busy state presents Retry/Cancel and never force-kills CourseStow, Node, credential helper, or browser processes.

The hidden maintenance entry points are:

```text
CourseStow.exe --installer-preflight
CourseStow.exe --installer-reconcile-schedule
CourseStow.exe --installer-remove-schedule
CourseStow.exe --installer-remove-credential
CourseStow.exe --installer-remove-private-data
```

They run before the ordinary GUI/single-instance path, display no control panel, never launch Brightspace or a browser, and accept no user data on the command line. Exit `0` means success, `10` means busy/retry later, `11` means preflight inspection failed, and `12` means a maintenance operation failed.

Before replacement, setup moves the existing installer-managed payload into an application-local rollback directory while leaving Inno's active uninstall metadata in place. Failure before completion restores the previous payload where practical; a rollback failure preserves the recovery material and records a generic failure. A completed install removes the rollback directory, so obsolete managed payload files and arbitrary application-directory files are not carried into a successful repair. `%LOCALAPPDATA%\CourseStow`, credentials, the school mirror, and the Drive destination are never part of payload staging or rollback.

After successful payload replacement, CourseStow reads its existing application-owned settings and reconciles only `\CourseStow\Scheduled Sync - <current-user-SID>` and the supported exact legacy identity. An enabled configured schedule is recreated against the current fixed executable with its saved cadence and existing indefinite-run/security policy. Disabled or unconfigured scheduling removes the exact managed task and creates nothing. Reconciliation failure is a repairable warning and does not delete private data or invalidate an otherwise installed payload.

Upgrade and repair preserve configuration, state, logs, browser profile/session, saved Windows credentials, selected mirror, Drive copy, and schedule preferences. Reinstall after a prior default uninstall naturally reuses preserved `%LOCALAPPDATA%\CourseStow` data; first-run setup appears only if the application still considers that configuration incomplete. The desktop shortcut remains off by default on fresh install, while Inno's previous-task selection preserves the choice across upgrade/repair and recreates a previously selected missing shortcut. The Finish-page **Launch CourseStow** choice remains checked by default.

Default uninstall removes the managed application payload, Start Menu/optional Desktop shortcuts, uninstall registration, and the exact current-user scheduled task. It preserves private app data, browser session, credentials, school mirror, and Drive copy. The explicitly unchecked **Also remove CourseStow settings and private app data** option additionally removes only the canonical/legacy CourseStow credential and `%LOCALAPPDATA%\CourseStow`. Reparse points inside that private root are removed as links and are never traversed; the school mirror and Drive destination are never inferred or deletion targets.

Lifecycle troubleshooting records are created only for failures or repairable maintenance warnings under `%LOCALAPPDATA%\CourseStow\logs\installer`. Entries contain fixed operational fields such as version, operation, stage, result, and generic category. They contain no config, URL, username, credential, cookie, token, profile/course/mirror/Drive content, environment dump, or private command line. There is no telemetry.

## Update checking and official release pipeline (Milestone 2C.3)

The normal control-panel window performs one asynchronous update check after startup. It does not run from scheduled/headless mode, delay the rest of the UI, open a browser, download an installer, or install anything. Automatic network attempts are limited to once per 24 hours, including failed attempts, and automatic failures remain silent. **Check for Updates** bypasses that throttle, retries one transient failure, and reports a concise result in the window. When a newer stable version exists, the window shows a non-blocking notice and a **View Release** link; opening the trusted GitHub release page remains an explicit user action.

The checker sends an unauthenticated five-second HTTPS GET to the public GitHub latest-release endpoint with a versioned CourseStow user agent. Only exact stable tags of the form `vMAJOR.MINOR.PATCH` are accepted; draft, prerelease, malformed, credential-bearing, or extended tags are rejected. The UI never trusts a URL supplied by the API: it constructs `https://github.com/aryanramz/coursestow/releases/tag/v<version>` locally from the validated version.

Update state is separate from application configuration and lives at the Node-resolved private data path `state\update-check.json`. Its allowlisted schema contains only a schema version, last-attempt timestamp, optional ETag, latest validated version, and locally constructed release URL. The cache is written atomically, corrupt cache is ignored safely, and a `304 Not Modified` response is used only when the cached release metadata is still valid. No token, credential, cookie, browser state, mirror content, Drive content, machine identity, environment dump, response body, or raw error is persisted.

The official `.github/workflows/release.yml` workflow runs only for pushed tags matching `v*.*.*`; it has no branch, pull-request, scheduled, or manual trigger. Its validation script then enforces the stricter stable-tag grammar and exact equality with `package.json`. All application, security, dependency, installer, update-check, and release-contract gates must pass before the Windows job builds the existing verified portable bundle and Inno Setup installer. The installer and conventional `.sha256` sidecar are revalidated before publication. All jobs default to read-only repository contents; only the final dependent publication job receives `contents: write`.

Safe maintainer procedure for a future release:

1. Update and review `package.json` through the normal milestone process; do not tag a version whose source and tests are not approved.
2. Ensure permanent-branch CI is green and the intended commit is checked out.
3. Create and push one exact stable tag, such as `v3.0.0`, whose numeric portion exactly matches `package.json`.
4. Monitor the **Official Release** workflow. It refuses malformed/mismatched tags and an existing same-tag release, and publishes only after every prerequisite job succeeds.
5. Confirm the published release is stable (not draft/prerelease) and contains exactly `CourseStow-<version>-Setup.exe` and `CourseStow-<version>-Setup.exe.sha256`. Verify the sidecar before distributing the installer.

Milestone 2C.3 added the mechanism without publishing a release. Milestone 2C.4 advances the authoritative package version to `3.0.0`, but creates no tag or GitHub Release. Artifacts remain unsigned, so Windows may display **Unknown Publisher**; users must not be instructed to weaken SmartScreen or other Windows protections. Clean-Windows-VM qualification remains Milestone 2D.

## Windows v3 finalization (Milestone 2C.4)

`package.json` is the single version source and is now `3.0.0`. Generated compilation attributes produce `3.0.0.0` AssemblyVersion/FileVersion and `3.0.0` informational version for both Windows executables. The same value drives `bundle-manifest.json`, packaged `app\package.json`, installer ProductVersion/Installed Apps metadata, update-check User-Agent, setup filename `CourseStow-3.0.0-Setup.exe`, checksum filename `CourseStow-3.0.0-Setup.exe.sha256`, and strict release-tag validation.

The fixed per-user install remains `%LOCALAPPDATA%\Programs\CourseStow`, private data remains `%LOCALAPPDATA%\CourseStow`, and mirror/Drive locations remain separate user choices. The installer requires Windows 10 22H2 build 19045+ or Windows 11 x64 and .NET Framework 4.8+, requires no administrator access, bundles private Node.js but no browser, and retains App ID `7E264BC7-FCBE-4BF2-9A24-E342C533A770`. Default uninstall preserves private data, credentials, browser session, school mirror, and Drive copy; there is no telemetry.

Version 3.0.0 is a reviewed release-candidate state only. This milestone performs no final product rename or icon design, creates no tag/release, adds no code signing, and does not claim clean-VM qualification. Those remain explicit later gates.

## Deferred / Later Improvements

The items below are **non-blocking**. They are not required for the reviewed Windows v3 release-candidate implementation, and they do not prevent the distribution foundation from being considered complete.

### Accepted current tradeoffs

- **Browser-profile recovery:** In the rare case where an unverified `BrowserProfile` is moved to `.incomplete`, its replacement migration fails, and the legacy source later becomes unavailable, the backup is not automatically promoted. This is acceptable because legacy data is preserved and normal retries are safe.
- **PID reuse:** A reused PID on the same host could conservatively make an initialization or sync lock appear active until timeout. This fails safe instead of risking theft of an active lock.
- **Foreign or malformed initialization locks:** These intentionally remain protected for the configured stale period, currently one hour, before recovery.
- **Atomic-write directory durability:** Atomic JSON writes flush and sync the temporary file itself. Node does not provide a portable Windows mechanism for syncing the parent directory.
- **Orphaned atomic temporary files:** A hard crash can leave uniquely named `.tmp-*` files. They neither replace nor corrupt the real destination.

### Future enhancement tasks

- Add more defensive browser-profile recovery that can restore or promote `.incomplete` when the replacement and subsequent legacy-source retry are unavailable.
- Consider making the foreign or malformed initialization-lock stale period configurable, and add maintenance cleanup for stale orphan `.tmp-*` files.
- Consider both per-user/no-admin and per-machine installation. Do not hard-code a `Program Files`-only installation unless that decision is made explicitly later.
- Consider crash-recovery journaling for the very small interruption windows during a same-volume rename or a staged cross-volume mirror relocation. Handled filesystem/configuration failures already roll back and retain the old configuration.

### Installer and release-phase work

The following work remains intentionally deferred to later milestones:

- clean Windows VM installation testing
- legacy upgrade testing
- repair testing
- uninstall testing
- code signing

Future installer metadata must use product name `CourseStow`, publisher `aryanramz`, default install directory `%LOCALAPPDATA%\Programs\CourseStow\`, main executable `CourseStow.exe`, credential helper `CourseStow Credential Helper.exe`, and setup filename `CourseStow-<version>-Setup.exe`. The permanent Inno Setup App ID remains `7E264BC7-FCBE-4BF2-9A24-E342C533A770`; it must not change during the rename.

Additional institution adapters and changes required by future SSO page revisions remain later enhancements. Clean-VM install, upgrade, repair, and uninstall qualification; signing; final naming; and public release remain later gates.

No installer artifact should be published until the applicable install, upgrade, repair, and uninstall flows pass end-to-end testing.
