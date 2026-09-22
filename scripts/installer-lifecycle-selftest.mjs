import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'dist', 'CourseStow');
const CONTROL_PANEL = path.join(BUNDLE, 'CourseStow.exe');
const EXPECTED_BASE = '3.0.0';
const EXPECTED_APP_ID = '7E264BC7-FCBE-4BF2-9A24-E342C533A770';

const read = relative => fs.readFile(path.join(ROOT, relative), 'utf8');
const packageJson = JSON.parse(await read('package.json'));
const installer = await read('installer/windows/CourseStow.iss');
const product = await read('installer/windows/includes/Product.iss');
const program = await read('desktop/CourseStow.ControlPanel/Program.cs');
const maintenance = await read('desktop/CourseStow.ControlPanel/InstallerMaintenance.cs');
const maintenanceSelfTest = await read('desktop/CourseStow.ControlPanel/InstallerMaintenanceSelfTest.cs');
const helper = await read('desktop/CourseStow.CredentialHelper/Program.cs');
const identity = await read('desktop/Shared/CourseStowProcessIdentity.cs');
const workflow = await read('.github/workflows/ci.yml');

assert.equal(packageJson.version, EXPECTED_BASE, 'Windows v3 lifecycle tests must use version 3.0.0');
assert.equal(packageJson.scripts['installer-lifecycle-selftest'], 'node scripts/installer-lifecycle-selftest.mjs');
assert.match(product, new RegExp(`ProductAppId "\\{\\{${EXPECTED_APP_ID.replaceAll('-', '\\-')}\\}"`));
assert.match(product, new RegExp(`ProductUninstallKey ".*\\{${EXPECTED_APP_ID.replaceAll('-', '\\-')}\\}_is1"`));

const maintenanceDispatch = program.indexOf('InstallerMaintenanceCommand.TryRun');
const scheduledDispatch = program.indexOf('IsScheduledRun(args)');
const guiMutexDispatch = program.indexOf('new Mutex(true, MutexName');
assert(maintenanceDispatch >= 0 && maintenanceDispatch < scheduledDispatch && maintenanceDispatch < guiMutexDispatch,
  'installer maintenance must dispatch before scheduled and normal GUI paths');

for (const command of [
  '--installer-preflight',
  '--installer-reconcile-schedule',
  '--installer-remove-schedule',
  '--installer-remove-credential',
  '--installer-remove-private-data'
]) assert.match(maintenance, new RegExp(command.replaceAll('-', '\\-')));

assert.match(identity, /Local\\CourseStow\.ControlPanel/);
assert.match(identity, /Local\\BrightspaceSync\.ControlPanel/);
assert.match(identity, /Local\\CourseStow\.CredentialHelper/);
assert.match(identity, /Local\\CourseStow\.InstallerLifecycle/);
assert.match(helper, /CourseStowProcessIdentity\.CredentialHelperMutexName/);
assert.match(helper, /CourseStowProcessIdentity\.InstallerLifecycleMutexName/);
assert.match(helper, /new Mutex\(true,/);
assert.match(maintenance, /GetStatusAsync\(\)/, 'preflight must delegate sync-lock status to the authoritative backend');
assert.doesNotMatch(maintenance, /\.coursestow\.lock|pidIsRunning|staleAfter/i, 'C# must not duplicate Node lock classification');
assert.match(maintenance, /InstallerMaintenanceExitCode\.Busy/);
assert.match(maintenance, /InstallerMaintenanceExitCode\.InspectionFailure/);

assert.match(installer, /StrToVersion\('\{#AppVersion\}'/);
assert.match(installer, /ComparePackedVersion\(IncomingPacked, InstalledPacked\)/);
assert.match(installer, /Result := 'fresh-install'/);
assert.match(installer, /Result := 'repair'/);
assert.match(installer, /Result := 'upgrade'/);
assert.match(installer, /Result := 'downgrade'/);
assert.match(installer, /A newer version of CourseStow is already installed/);
assert.doesNotMatch(installer, /force.?downgrade/i);

assert.match(installer, /^UsePreviousTasks=yes$/m);
assert.match(installer, /^Name: "desktopicon";.+Flags: unchecked$/m);
assert.match(installer, /StageExistingPayload/);
assert.match(installer, /RestorePayloadBackup/);
assert.match(installer, /DeleteManagedPayloadExceptUninstaller/);
assert.match(installer, /ExtractTemporaryFiles\('\{app\}\\\*'\)/);
assert.match(installer, /--installer-preflight/);
assert.match(installer, /^SetupMutex=Local\\CourseStow\.InstallerLifecycle$/m);
assert.match(program, /CourseStowProcessIdentity\.InstallerLifecycleMutexName/);
assert.match(installer, /MB_RETRYCANCEL/);
assert.match(installer, /CourseStow is currently running/);
assert.doesNotMatch(installer, /taskkill|TerminateProcess|Stop-Process|kill\s*\(/i);

assert.match(installer, /--installer-reconcile-schedule/);
assert.match(installer, /--installer-remove-schedule/);
assert.match(maintenance, /settings\.configured && settings\.schedule\.enabled/);
assert.match(maintenance, /new WindowsTaskSchedulerService\(\)/);
assert.match(maintenance, /new CompatibleCredentialStore\(new WindowsCredentialStore\(\)\)/);
assert.match(maintenance, /FileAttributes\.ReparsePoint/);
assert.match(maintenanceSelfTest, /ExternalTarget/);
assert.match(maintenanceSelfTest, /Cleanup followed a reparse point outside the private root/);

assert.match(installer, /Also remove CourseStow settings and private app data/);
assert.match(installer, /RemovePrivateDataCheck\.Checked := False/);
assert.match(installer, /RemovePrivateDataRequested := RemovePrivateDataCheck\.Checked/);
assert.match(installer, /if RemovePrivateDataRequested then/);
assert.doesNotMatch(installer, /if \(RemovePrivateDataCheck <> nil\) and RemovePrivateDataCheck\.Checked then/);
assert.match(installer, /settings, browser session, saved credentials, local school mirror, and Google Drive copy will be preserved/);
assert.doesNotMatch(installer, /\[UninstallDelete\]/i, 'uninstall must not use broad declarative private-data deletion');
assert.doesNotMatch(installer, /config\.json/i, 'installer must not parse or rewrite application config');
assert.doesNotMatch(installer, /Brightspace URL|username|course name|mirror content|environment dump/i,
  'lifecycle logging must not name sensitive data fields');
assert.match(installer, /logs\\installer/);
assert.match(installer, /result=failed/);
assert.doesNotMatch(installer, /result=success/);
assert.match(workflow, /npm run installer-lifecycle-selftest/);

const uninstallStep = installer.slice(
  installer.indexOf('procedure CurUninstallStepChanged'),
  installer.indexOf('procedure DeinitializeUninstall')
);
const scheduleRemoval = uninstallStep.indexOf("'--installer-remove-schedule'");
const scheduleFailureLog = uninstallStep.indexOf("WriteLifecycleFailureLog('uninstall', 'schedule-remove', 'schedule-remove-failed')");
const scheduleFailureAbort = uninstallStep.indexOf('RaiseException(', scheduleFailureLog);
const privateDataDecision = uninstallStep.indexOf('if RemovePrivateDataRequested then');
const credentialRemoval = uninstallStep.indexOf("'--installer-remove-credential'");
const privateDataRemoval = uninstallStep.indexOf("'--installer-remove-private-data'");
assert(scheduleRemoval >= 0 && scheduleFailureLog > scheduleRemoval,
  'managed schedule removal must run before uninstall can progress');
assert(scheduleFailureAbort > scheduleFailureLog && scheduleFailureAbort < privateDataDecision,
  'schedule-removal failure must abort before any private-data decision');
assert(privateDataDecision < credentialRemoval && credentialRemoval < privateDataRemoval,
  'credential/private-data cleanup must remain unreachable after schedule-removal abort');
assert.match(uninstallStep, /scheduled sync task, so uninstall was stopped/);
assert.match(uninstallStep, /No CourseStow application or private data was removed/);
assert.doesNotMatch(uninstallStep, /scheduling could not be removed\. Reinstalling and uninstalling again can repair it/,
  'task-removal failure cannot remain a warning-only path');

function run(command, args, { cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

if (process.platform === 'win32') {
  let bundleExists = false;
  try { bundleExists = (await fs.stat(CONTROL_PANEL)).isFile(); } catch {}
  if (bundleExists) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'coursestow-installer-lifecycle-'));
    try {
      const outputFile = path.join(temp, 'maintenance-self-test.json');
      let result = await run(CONTROL_PANEL, ['--installer-lifecycle-self-test', outputFile], { cwd: BUNDLE });
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.stdout, '', 'maintenance self-test must not emit stdout');
      assert.equal(result.stderr, '', 'maintenance self-test must not emit stderr');
      const selfTest = JSON.parse(await fs.readFile(outputFile, 'utf8'));
      assert.equal(selfTest.schemaVersion, 1);
      for (const [key, value] of Object.entries(selfTest)) {
        if (key !== 'schemaVersion' && key !== 'preflightExitCodes') assert.equal(value, true, `${key} was not proven`);
      }
      assert.deepEqual(selfTest.preflightExitCodes, { safe: 0, busy: 10, inspectionFailure: 11, operationFailure: 12 });

      const dataDir = path.join(temp, 'runtime data');
      const mirrorDir = path.join(temp, 'school mirror');
      const stateDir = path.join(dataDir, 'state');
      const lockFile = path.join(stateDir, '.coursestow.lock');
      await fs.mkdir(stateDir, { recursive: true });
      const env = {
        ...process.env,
        COURSESTOW_DATA_DIR: dataDir,
        COURSESTOW_MIRROR_DIR: mirrorDir,
        COURSESTOW_DEV_BUNDLE_ROOT: BUNDLE
      };

      result = await run(CONTROL_PANEL, ['--installer-preflight'], { cwd: temp, env });
      assert.equal(result.code, 0, 'idle packaged maintenance preflight must succeed');
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');

      await fs.writeFile(lockFile, JSON.stringify({
        schemaVersion: 1,
        token: 'synthetic-live-lock',
        pid: process.pid,
        mode: 'scheduled',
        hostname: os.hostname(),
        startedAt: new Date().toISOString()
      }));
      result = await run(CONTROL_PANEL, ['--installer-preflight'], { cwd: temp, env });
      assert.equal(result.code, 10, 'live same-host sync lock must report busy');

      await fs.writeFile(lockFile, JSON.stringify({
        schemaVersion: 1,
        token: 'synthetic-dead-lock',
        pid: 2147483647,
        mode: 'scheduled',
        hostname: os.hostname(),
        startedAt: new Date().toISOString()
      }));
      result = await run(CONTROL_PANEL, ['--installer-preflight'], { cwd: temp, env });
      assert.equal(result.code, 0, 'dead same-host lock must be safely stale');

      await fs.writeFile(lockFile, '{malformed');
      result = await run(CONTROL_PANEL, ['--installer-preflight'], { cwd: temp, env });
      assert.equal(result.code, 10, 'fresh malformed lock must conservatively report busy');

      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await fs.utimes(lockFile, old, old);
      result = await run(CONTROL_PANEL, ['--installer-preflight'], { cwd: temp, env });
      assert.equal(result.code, 0, 'old malformed lock must age out through existing Node semantics');

      await fs.rm(lockFile, { force: true });
      result = await run(CONTROL_PANEL, ['--installer-preflight'], {
        cwd: temp,
        env: { ...env, COURSESTOW_DEV_BUNDLE_ROOT: path.join(temp, 'missing bundle') }
      });
      assert.equal(result.code, 11, 'backend inspection failure must have a distinct exit code');
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}

console.log(`Windows installer lifecycle self-test: PASS (${process.platform === 'win32' && await fs.stat(CONTROL_PANEL).then(() => true, () => false) ? 'static and packaged command checks' : 'portable static checks'})`);
