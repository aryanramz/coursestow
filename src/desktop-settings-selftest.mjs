import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CURRENT_CONFIG_VERSION, loadAppConfig } from './config.mjs';
import { canonicalFilesystemPath, getDesktopSettings, saveDesktopSettings } from './desktop-settings.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { acquireSyncLock } from './sync-lock.mjs';
import { hasAuthAttention, setAuthAttention } from './auth-attention.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function makeRuntime(root, name, extraEnv = {}) {
  const appRoot = path.join(root, name, 'Application');
  const userHome = path.join(root, name, 'User');
  await fs.mkdir(appRoot, { recursive: true });
  await fs.writeFile(path.join(appRoot, 'config.example.json'), JSON.stringify({
    configVersion: CURRENT_CONFIG_VERSION,
    baseUrl: 'https://your-school.brightspace.com',
    outputDir: '',
    drivePublish: {
      enabled: false,
      destination: '',
      deleteRemoved: true,
      verifyDestinationOnFull: true,
      retryAttempts: 4,
      retryDelayMs: 700
    },
    schedule: { enabled: false, intervalHours: 6, fullIntervalDays: 7 }
  }, null, 2));
  return {
    appRoot,
    env: {
      USERPROFILE: userHome,
      LOCALAPPDATA: path.join(userHome, 'AppData', 'Local'),
      ...extraEnv
    },
    platform: 'win32',
    homeDir: userHome
  };
}

function request(baseUrl, mirrorDir, {
  driveEnabled = false,
  driveDestination = '',
  mirrorAction = '',
  automaticLoginEnabled = false,
  authenticationRetryRequested = false,
  scheduleEnabled = false,
  intervalHours = 6,
  fullIntervalDays = 7,
  browserPath
} = {}) {
  return {
    schemaVersion: 1,
    baseUrl,
    mirrorDir,
    drive: { enabled: driveEnabled, destination: driveDestination },
    authentication: { automaticLoginEnabled, retryRequested: authenticationRetryRequested },
    schedule: { enabled: scheduleEnabled, intervalHours, fullIntervalDays },
    ...(browserPath !== undefined ? { browser: { executablePath: browserPath } } : {}),
    ...(mirrorAction ? { mirrorAction } : {})
  };
}

async function rawConfig(runtime) {
  return JSON.parse(await fs.readFile(resolveRuntimePaths(runtime).configFile, 'utf8'));
}

async function assertNoAtomicTemps(runtime) {
  const paths = resolveRuntimePaths(runtime);
  const names = await fs.readdir(paths.dataDir);
  assert.equal(names.some(name => name.includes('.tmp-')), false, 'settings persistence must not leave atomic temporary files');
}

async function allFileText(root) {
  const pending = [root];
  const text = [];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const value = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(value);
      else if (entry.isFile()) text.push(await fs.readFile(value, 'utf8'));
    }
  }
  return text.join('\n');
}

function errorCode(response, code) {
  return response.errors?.some(error => error.code === code);
}

function allKeys(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [key.toLowerCase(), ...allKeys(child)]);
}

async function physicalPath(value) {
  return (await canonicalFilesystemPath(value)).physicalPath;
}

async function assertSamePhysicalPath(actual, expected, message) {
  assert.equal(await physicalPath(actual), await physicalPath(expected), message);
}

async function createDirectoryAlias(target, alias) {
  try {
    await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return false;
    throw error;
  }
}

async function windowsShortPath(value) {
  if (process.platform !== 'win32') return null;
  const command = `for %I in ("${value.replaceAll('"', '""')}") do @echo %~sI`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], {
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolve(stdout.trim().replace(/^"(.*)"$/, '$1') || null)
      : reject(new Error(`Could not resolve DOS short path: ${stderr.trim()}`)));
  });
}

async function spawnSettingsSave(dataDir, userHome, payload) {
  const args = [path.join(ROOT, 'src', 'launcher.mjs'), 'settings', 'save', '--json'];
  for (const value of [payload.baseUrl, payload.mirrorDir, payload.drive?.destination]) {
    if (value) assert.equal(args.some(argument => argument.includes(value)), false, 'settings values must not appear in process arguments');
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        USERPROFILE: userHome,
        LOCALAPPDATA: path.join(userHome, 'AppData', 'Local'),
        COURSEMIRROR_DATA_DIR: dataDir
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr, args }));
    child.stdin.end(JSON.stringify(payload));
  });
  return result;
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'coursemirror-desktop-settings-'));
try {
  const basicRuntime = await makeRuntime(temp, 'Basic');
  const basicPaths = resolveRuntimePaths(basicRuntime);
  const initial = await getDesktopSettings({ runtime: basicRuntime });
  assert.deepEqual(Object.keys(initial).sort(), ['authentication', 'baseUrl', 'browser', 'configured', 'drive', 'mayImportLegacySetup', 'maySuggestFirstRunMirror', 'mirrorDir', 'mirrorOverrideActive', 'schedule', 'schemaVersion']);
  assert.deepEqual(Object.keys(initial.drive).sort(), ['destination', 'enabled']);
  assert.deepEqual(Object.keys(initial.authentication).sort(), ['automaticLoginEnabled', 'institution', 'supported']);
  assert.deepEqual(Object.keys(initial.schedule).sort(), ['enabled', 'fullIntervalDays', 'intervalHours']);
  assert.equal(initial.schemaVersion, 1);
  assert.equal(initial.configured, false);
  assert.equal(initial.baseUrl, '');
  assert.equal(initial.drive.enabled, false);
  assert.equal(initial.drive.destination, '');
  assert.equal(initial.mayImportLegacySetup, true);
  assert.equal(initial.browser.engine, 'chromium');
  assert.deepEqual(initial.authentication, { supported: false, institution: '', automaticLoginEnabled: false });

  const manualBrowserPath = path.join(temp, 'Synthetic Browser', 'browser.exe');
  await fs.mkdir(path.dirname(manualBrowserPath), { recursive: true });
  await fs.writeFile(manualBrowserPath, 'synthetic executable');
  const compatibleInspector = async executablePath => ({
    engine: 'chromium',
    available: true,
    displayName: executablePath ? 'Custom Chromium browser' : 'Microsoft Edge',
    executablePath: executablePath || path.join(temp, 'Synthetic Edge', 'msedge.exe'),
    source: executablePath ? 'configured' : 'automatic',
    configuredManually: Boolean(executablePath),
    supportLevel: executablePath ? 'custom' : 'official',
    validationStatus: 'compatible'
  });
  const manualBrowserSave = await saveDesktopSettings(request('https://example.test', initial.mirrorDir, {
    browserPath: manualBrowserPath
  }), { runtime: basicRuntime, browserInspector: compatibleInspector });
  assert.equal(manualBrowserSave.ok, true, 'compatible manual browser path must save');
  assert.equal((await rawConfig(basicRuntime)).browserExecutablePath, manualBrowserPath, 'manual browser path must round-trip through config');
  const rejectedBrowser = await saveDesktopSettings(request('https://example.test', initial.mirrorDir, {
    browserPath: path.join(temp, 'Not A Browser.exe')
  }), {
    runtime: basicRuntime,
    browserInspector: async executablePath => ({
      engine: 'chromium', available: false, displayName: 'Custom Chromium browser', executablePath,
      source: 'configured', configuredManually: true, supportLevel: 'custom', validationStatus: 'incompatible'
    })
  });
  assert.equal(errorCode(rejectedBrowser, 'browser-unavailable'), true, 'incompatible manual executable must be rejected');
  assert.equal((await rawConfig(basicRuntime)).browserExecutablePath, manualBrowserPath, 'rejected browser must not alter config');
  const automaticBrowserSave = await saveDesktopSettings(request('https://example.test', initial.mirrorDir, {
    browserPath: ''
  }), { runtime: basicRuntime, browserInspector: compatibleInspector });
  assert.equal(automaticBrowserSave.ok, true, 'reset to validated automatic detection must save');
  assert.equal((await rawConfig(basicRuntime)).browserExecutablePath, '', 'automatic detection reset must clear manual path');
  assert.deepEqual(initial.schedule, { enabled: false, intervalHours: 6, fullIntervalDays: 7 });
  assert.equal(initial.mirrorOverrideActive, false);
  assert.equal(initial.maySuggestFirstRunMirror, true, 'a genuinely fresh generated mirror may use the Windows known-folder suggestion');

  const scheduleRuntime = await makeRuntime(temp, 'Schedule Compatibility');
  const schedulePaths = resolveRuntimePaths(scheduleRuntime);
  await getDesktopSettings({ runtime: scheduleRuntime });
  const legacyScheduleRaw = await rawConfig(scheduleRuntime);
  legacyScheduleRaw.schedule = { fullIntervalDays: 12, retainedScheduleChoice: 'preserve-me' };
  const legacyScheduleBytes = `${JSON.stringify(legacyScheduleRaw, null, 2)}\n`;
  await fs.writeFile(schedulePaths.configFile, legacyScheduleBytes);
  const legacyScheduleSettings = await getDesktopSettings({ runtime: scheduleRuntime });
  assert.deepEqual(legacyScheduleSettings.schedule, { enabled: false, intervalHours: 6, fullIntervalDays: 12 });
  assert.equal(await fs.readFile(schedulePaths.configFile, 'utf8'), legacyScheduleBytes, 'legacy schedule reads must not rewrite config');

  const invalidSchedule = await saveDesktopSettings(request('https://example.test', legacyScheduleSettings.mirrorDir, {
    scheduleEnabled: true, intervalHours: 25, fullIntervalDays: 0
  }), { runtime: scheduleRuntime });
  assert.equal(errorCode(invalidSchedule, 'invalid-range'), true);
  assert.equal(await fs.readFile(schedulePaths.configFile, 'utf8'), legacyScheduleBytes, 'invalid schedule must not change config');

  const validSchedule = await saveDesktopSettings(request('https://example.test', legacyScheduleSettings.mirrorDir, {
    scheduleEnabled: true, intervalHours: 4, fullIntervalDays: 9
  }), { runtime: scheduleRuntime });
  assert.equal(validSchedule.ok, true);
  assert.deepEqual(validSchedule.settings.schedule, { enabled: true, intervalHours: 4, fullIntervalDays: 9 });
  const validScheduleRaw = await rawConfig(scheduleRuntime);
  assert.deepEqual(validScheduleRaw.schedule, {
    fullIntervalDays: 9,
    retainedScheduleChoice: 'preserve-me',
    enabled: true,
    intervalHours: 4
  });

  const genericAutomatic = await saveDesktopSettings(request('https://example.test', initial.mirrorDir, {
    automaticLoginEnabled: true
  }), { runtime: basicRuntime });
  assert.equal(errorCode(genericAutomatic, 'unsupported-institution'), true, 'generic institutions must not enable automatic credential sign-in');

  const stonyBrookRuntime = await makeRuntime(temp, 'Stony Brook Authentication');
  const stonyBrookInitial = await getDesktopSettings({ runtime: stonyBrookRuntime });
  const stonyBrookSaved = await saveDesktopSettings(request('https://mycourses.stonybrook.edu', stonyBrookInitial.mirrorDir, {
    automaticLoginEnabled: true
  }), { runtime: stonyBrookRuntime });
  assert.equal(stonyBrookSaved.ok, true);
  assert.deepEqual(stonyBrookSaved.settings.authentication, {
    supported: true,
    institution: 'stony-brook',
    automaticLoginEnabled: true
  });
  const stonyBrookRaw = await rawConfig(stonyBrookRuntime);
  assert.equal(stonyBrookRaw.auth.automaticLoginEnabled, true);
  assert.deepEqual(Object.keys(stonyBrookRaw.auth).filter(key => key.toLowerCase().includes('user') || key.toLowerCase().includes('pass')), []);
  assert.equal(JSON.stringify(stonyBrookSaved).toLowerCase().includes('password'), false, 'settings response must never expose a password field');
  assert.equal(JSON.stringify(stonyBrookSaved).toLowerCase().includes('username'), false, 'settings response must never expose a username field');

  const stonyBrookPaths = resolveRuntimePaths(stonyBrookRuntime);
  await setAuthAttention(stonyBrookPaths.stateDir);
  const credentialRetrySaved = await saveDesktopSettings(request(
    'https://mycourses.stonybrook.edu',
    stonyBrookSaved.settings.mirrorDir,
    { automaticLoginEnabled: true, authenticationRetryRequested: true }
  ), { runtime: stonyBrookRuntime });
  assert.equal(credentialRetrySaved.ok, true);
  assert.equal(await hasAuthAttention(stonyBrookPaths.stateDir), false, 'intentional credential/authentication update must clear auth attention');
  assert.equal(Object.hasOwn((await rawConfig(stonyBrookRuntime)).auth, 'retryRequested'), false, 'retry signal must never be persisted');

  const unsafeReadCases = [
    {
      value: 'https://legacy-user:UserInfoSecret123@example.test/course',
      expected: '',
      configured: false,
      markers: ['legacy-user', 'UserInfoSecret123']
    },
    {
      value: 'https://example.test/course?token=QuerySecret123',
      expected: 'https://example.test/course',
      configured: true,
      markers: ['QuerySecret123']
    },
    {
      value: 'https://example.test/course#FragmentSecret123',
      expected: 'https://example.test/course',
      configured: true,
      markers: ['FragmentSecret123']
    },
    {
      value: 'http://example.test/course?token=HttpSecret123',
      expected: '',
      configured: false,
      markers: ['HttpSecret123']
    },
    {
      value: 'not-a-url-MalformedSecret123',
      expected: '',
      configured: false,
      markers: ['MalformedSecret123']
    }
  ];
  for (const [index, unsafeCase] of unsafeReadCases.entries()) {
    const unsafeRuntime = await makeRuntime(temp, `Unsafe Read ${index}`);
    const unsafePaths = resolveRuntimePaths(unsafeRuntime);
    await getDesktopSettings({ runtime: unsafeRuntime });
    const unsafeRaw = await rawConfig(unsafeRuntime);
    unsafeRaw.baseUrl = unsafeCase.value;
    const unsafeBytes = `${JSON.stringify(unsafeRaw, null, 2)}\n`;
    await fs.writeFile(unsafePaths.configFile, unsafeBytes);

    const safeRead = await getDesktopSettings({ runtime: unsafeRuntime });
    const safeJson = JSON.stringify(safeRead);
    assert.equal(safeRead.baseUrl, unsafeCase.expected);
    assert.equal(safeRead.configured, unsafeCase.configured);
    for (const marker of unsafeCase.markers) {
      assert.equal(safeJson.includes(marker), false, `settings JSON must not expose legacy URL marker: ${marker}`);
    }
    assert.equal(await fs.readFile(unsafePaths.configFile, 'utf8'), unsafeBytes, 'reading unsafe legacy settings must not rewrite config');
  }

  const missingUrlCustomRuntime = await makeRuntime(temp, 'Missing URL Custom Mirror');
  const missingUrlCustomPaths = resolveRuntimePaths(missingUrlCustomRuntime);
  await getDesktopSettings({ runtime: missingUrlCustomRuntime });
  const missingUrlCustomRaw = await rawConfig(missingUrlCustomRuntime);
  const missingUrlCustomMirror = path.join(temp, 'Missing URL Custom Mirror', 'Existing School Files');
  missingUrlCustomRaw.baseUrl = '';
  missingUrlCustomRaw.outputDir = missingUrlCustomMirror;
  await fs.writeFile(missingUrlCustomPaths.configFile, `${JSON.stringify(missingUrlCustomRaw, null, 2)}\n`);
  const missingUrlCustom = await getDesktopSettings({ runtime: missingUrlCustomRuntime });
  assert.equal(missingUrlCustom.configured, false);
  assert.equal(missingUrlCustom.mirrorDir, missingUrlCustomMirror);
  assert.equal(missingUrlCustom.maySuggestFirstRunMirror, false, 'a custom mirror must be preserved while repairing a missing URL');

  const meaningfulDefaultRuntime = await makeRuntime(temp, 'Meaningful Generated Mirror');
  const meaningfulDefaultPaths = resolveRuntimePaths(meaningfulDefaultRuntime);
  await getDesktopSettings({ runtime: meaningfulDefaultRuntime });
  await fs.mkdir(meaningfulDefaultPaths.defaultMirrorDir, { recursive: true });
  await fs.writeFile(path.join(meaningfulDefaultPaths.defaultMirrorDir, 'existing-course.txt'), 'preserve me');
  const meaningfulDefault = await getDesktopSettings({ runtime: meaningfulDefaultRuntime });
  assert.equal(meaningfulDefault.configured, false);
  assert.equal(meaningfulDefault.mirrorDir, meaningfulDefaultPaths.defaultMirrorDir);
  assert.equal(meaningfulDefault.maySuggestFirstRunMirror, false, 'a generated default containing files must not be replaced by a UI suggestion');

  const initialBytes = await fs.readFile(basicPaths.configFile, 'utf8');
  for (const invalid of ['', 'not a url', 'http://example.test', 'javascript:alert(1)', 'file:///tmp/example', 'data:text/plain,test']) {
    const response = await saveDesktopSettings(request(invalid, path.join(temp, 'Invalid Mirror')), { runtime: basicRuntime });
    assert.equal(response.ok, false, `invalid URL must be rejected: ${invalid}`);
  }
  assert.equal(await fs.readFile(basicPaths.configFile, 'utf8'), initialBytes, 'invalid settings must not change configuration');

  const missingDrive = await saveDesktopSettings(request('https://example.test', path.join(temp, 'Drive Required'), { driveEnabled: true }), { runtime: basicRuntime });
  assert.equal(errorCode(missingDrive, 'required'), true, 'enabled Drive publishing requires a destination');
  const overlappingDrivePath = path.join(temp, 'Overlapping Drive');
  const overlappingDrive = await saveDesktopSettings(request('https://example.test', overlappingDrivePath, {
    driveEnabled: true,
    driveDestination: path.join(overlappingDrivePath, 'Published')
  }), { runtime: basicRuntime });
  assert.equal(errorCode(overlappingDrive, 'protected-path'), true, 'Drive destination must remain separate from the mirror');
  const validMirror = path.join(temp, 'Configured Mirror');
  const validMirrorPhysical = await physicalPath(validMirror);
  const saved = await saveDesktopSettings(request('https://Example.Test/course/?ticket=discarded#fragment', validMirror), { runtime: basicRuntime });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.configured, true);
  assert.equal(saved.settings.baseUrl, 'https://example.test/course');
  assert.equal(saved.settings.mirrorDir, validMirrorPhysical);
  assert.equal(saved.settings.drive.enabled, false);
  assert.equal(saved.settings.drive.destination, '');
  const savedRaw = await rawConfig(basicRuntime);
  assert.equal(savedRaw.configVersion, CURRENT_CONFIG_VERSION);
  assert.equal(savedRaw.baseUrl, 'https://example.test/course');
  assert.equal(savedRaw.outputDir, validMirrorPhysical);
  assert.equal(savedRaw.drivePublish.enabled, false);
  assert.equal(savedRaw.drivePublish.destination, '');
  assert.equal(savedRaw.drivePublish.deleteRemoved, true, 'unexposed Drive settings must be preserved');
  assert.equal((await loadAppConfig({ runtime: basicRuntime })).config.baseUrl, 'https://example.test/course');
  await assertNoAtomicTemps(basicRuntime);

  const ignoredSecretValues = ['FakePasswordValue', 'FakeTokenValue', 'FakeClientSecretValue'];
  const requestWithUnknownSensitiveFields = {
    ...request('https://example.test/course', validMirror),
    password: ignoredSecretValues[0],
    token: ignoredSecretValues[1],
    drive: {
      enabled: false,
      destination: '',
      client_secret: ignoredSecretValues[2]
    }
  };
  assert.equal((await saveDesktopSettings(requestWithUnknownSensitiveFields, { runtime: basicRuntime })).ok, true);
  const runtimeText = await allFileText(basicPaths.dataDir);
  for (const value of ignoredSecretValues) {
    assert.equal(runtimeText.includes(value), false, 'unknown sensitive request values must not be written to config, state, or logs');
  }

  const unchangedBefore = await fs.readFile(basicPaths.configFile, 'utf8');
  const unchanged = await saveDesktopSettings(request(saved.settings.baseUrl, validMirror), { runtime: basicRuntime });
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.mirrorMoved, false);
  assert.equal(await fs.readFile(basicPaths.configFile, 'utf8'), unchangedBefore, 'unchanged mirror settings must be a normal idempotent save');

  const cancelSnapshot = await fs.readFile(basicPaths.configFile, 'utf8');
  await getDesktopSettings({ runtime: basicRuntime });
  assert.equal(await fs.readFile(basicPaths.configFile, 'utf8'), cancelSnapshot, 'loading then cancelling settings must make no change');

  const heldSyncLock = await acquireSyncLock(basicPaths.lockDir, { mode: 'full' });
  assert.equal(heldSyncLock.acquired, true);
  try {
    const blocked = await saveDesktopSettings(request('https://blocked.example.test', validMirror), { runtime: basicRuntime });
    assert.equal(errorCode(blocked, 'operation-active'), true, 'settings save must respect an active sync lock');
    assert.equal((await rawConfig(basicRuntime)).baseUrl, 'https://example.test/course');
  } finally {
    await heldSyncLock.release();
  }

  const driveRuntime = await makeRuntime(temp, 'Drive');
  const driveMirror = path.join(temp, 'Drive', 'Mirror');
  const driveDestination = path.join(temp, 'Drive', 'Google Drive Destination');
  const driveMirrorPhysical = await physicalPath(driveMirror);
  const driveDestinationPhysical = await physicalPath(driveDestination);
  const driveSaved = await saveDesktopSettings(request('https://example.test', driveMirror, {
    driveEnabled: true,
    driveDestination
  }), { runtime: driveRuntime });
  assert.equal(driveSaved.ok, true);
  assert.equal(driveSaved.settings.drive.enabled, true);
  assert.equal(driveSaved.settings.drive.destination, driveDestinationPhysical);
  assert.equal(driveSaved.settings.mirrorDir, driveMirrorPhysical);
  assert.equal((await rawConfig(driveRuntime)).drivePublish.destination, driveDestinationPhysical);
  const driveDisabled = await saveDesktopSettings(request('https://example.test', driveMirror), { runtime: driveRuntime });
  assert.equal(driveDisabled.ok, true, 'disabled Drive publishing must permit an empty destination');
  assert.equal(driveDisabled.settings.drive.enabled, false);
  assert.equal(driveDisabled.settings.drive.destination, '');

  const useNewRuntime = await makeRuntime(temp, 'Use New');
  const useOld = path.join(temp, 'Use New', 'Old Mirror');
  const useNew = path.join(temp, 'Use New', 'New Mirror');
  const useOldPhysical = await physicalPath(useOld);
  const useNewPhysical = await physicalPath(useNew);
  assert.equal((await saveDesktopSettings(request('https://example.test', useOld), { runtime: useNewRuntime })).ok, true);
  await fs.mkdir(path.join(useOld, 'Course'), { recursive: true });
  await fs.writeFile(path.join(useOld, 'Course', 'lesson.txt'), 'keep at old location');
  const needsChoice = await saveDesktopSettings(request('https://example.test', useNew), { runtime: useNewRuntime });
  assert.equal(errorCode(needsChoice, 'mirror-relocation-choice-required'), true);
  assert.deepEqual(needsChoice.relocation, { required: true, oldMirrorDir: useOldPhysical, newMirrorDir: useNewPhysical });
  assert.equal((await rawConfig(useNewRuntime)).outputDir, useOldPhysical);
  const useNewResult = await saveDesktopSettings(request('https://example.test', useNew, { mirrorAction: 'use-new' }), { runtime: useNewRuntime });
  assert.equal(useNewResult.ok, true);
  assert.equal(useNewResult.mirrorMoved, false);
  assert.equal(await fs.readFile(path.join(useOld, 'Course', 'lesson.txt'), 'utf8'), 'keep at old location');
  assert.equal((await rawConfig(useNewRuntime)).outputDir, useNewPhysical);

  const moveRuntime = await makeRuntime(temp, 'Move');
  const movePaths = resolveRuntimePaths(moveRuntime);
  const moveOld = path.join(temp, 'Move', 'Old Mirror');
  const moveNew = path.join(temp, 'Move', 'New Mirror');
  const moveNewPhysical = await physicalPath(moveNew);
  assert.equal((await saveDesktopSettings(request('https://example.test', moveOld), { runtime: moveRuntime })).ok, true);
  await fs.mkdir(path.join(moveOld, 'Course'), { recursive: true });
  await fs.writeFile(path.join(moveOld, 'Course', 'lesson.txt'), 'move me');
  await fs.writeFile(path.join(movePaths.profileDir, 'profile-sentinel'), 'private profile');
  await fs.writeFile(path.join(movePaths.stateDir, 'state-sentinel'), 'private state');
  await fs.writeFile(path.join(movePaths.logsDir, 'log-sentinel'), 'private log');
  const moved = await saveDesktopSettings(request('https://example.test', moveNew, { mirrorAction: 'move' }), { runtime: moveRuntime });
  assert.equal(moved.ok, true);
  assert.equal(moved.mirrorMoved, true);
  assert.equal(await fs.readFile(path.join(moveNew, 'Course', 'lesson.txt'), 'utf8'), 'move me');
  await assert.rejects(fs.access(moveOld));
  assert.equal(await fs.readFile(path.join(movePaths.profileDir, 'profile-sentinel'), 'utf8'), 'private profile');
  assert.equal(await fs.readFile(path.join(movePaths.stateDir, 'state-sentinel'), 'utf8'), 'private state');
  assert.equal(await fs.readFile(path.join(movePaths.logsDir, 'log-sentinel'), 'utf8'), 'private log');
  assert.equal((await rawConfig(moveRuntime)).outputDir, moveNewPhysical);

  const copyRuntime = await makeRuntime(temp, 'Copy Move');
  const copyOld = path.join(temp, 'Copy Move', 'Old Mirror');
  const copyNew = path.join(temp, 'Copy Move', 'New Mirror');
  await saveDesktopSettings(request('https://example.test', copyOld), { runtime: copyRuntime });
  await fs.mkdir(copyOld, { recursive: true });
  await fs.writeFile(path.join(copyOld, 'course.txt'), 'cross-volume-safe copy');
  const copied = await saveDesktopSettings(request('https://example.test', copyNew, { mirrorAction: 'move' }), { runtime: copyRuntime, forceCopy: true });
  assert.equal(copied.ok, true);
  assert.equal(await fs.readFile(path.join(copyNew, 'course.txt'), 'utf8'), 'cross-volume-safe copy');
  await assert.rejects(fs.access(copyOld));

  const failedRuntime = await makeRuntime(temp, 'Failed Move');
  const failedOld = path.join(temp, 'Failed Move', 'Old Mirror');
  const failedNew = path.join(temp, 'Failed Move', 'New Mirror');
  await saveDesktopSettings(request('https://old.example.test', failedOld), { runtime: failedRuntime });
  await fs.mkdir(failedOld, { recursive: true });
  await fs.writeFile(path.join(failedOld, 'course.txt'), 'still here');
  const failedOldPhysical = await physicalPath(failedOld);
  const realRename = fs.rename.bind(fs);
  const failed = await saveDesktopSettings(request('https://new.example.test', failedNew, { mirrorAction: 'move' }), {
    runtime: failedRuntime,
    fileSystem: {
      rename: async (source, destination) => {
        if (source === failedOldPhysical && destination === path.resolve(failedNew)) throw new Error('synthetic move failure');
        return realRename(source, destination);
      }
    }
  });
  assert.equal(errorCode(failed, 'mirror-move-failed'), true);
  assert.equal((await rawConfig(failedRuntime)).baseUrl, 'https://old.example.test');
  assert.equal((await rawConfig(failedRuntime)).outputDir, failedOldPhysical);
  assert.equal(await fs.readFile(path.join(failedOld, 'course.txt'), 'utf8'), 'still here');
  await assert.rejects(fs.access(failedNew));

  const inspectFailureBefore = await fs.readFile(resolveRuntimePaths(failedRuntime).configFile, 'utf8');
  const realReaddir = fs.readdir.bind(fs);
  const inspectFailure = await saveDesktopSettings(request('https://new.example.test', failedNew), {
    runtime: failedRuntime,
    fileSystem: {
      readdir: async (directory, options) => {
        if (directory === failedOldPhysical) throw Object.assign(new Error('synthetic access denial'), { code: 'EACCES' });
        return realReaddir(directory, options);
      }
    }
  });
  assert.equal(errorCode(inspectFailure, 'mirror-inspection-failed'), true);
  assert.equal(await fs.readFile(resolveRuntimePaths(failedRuntime).configFile, 'utf8'), inspectFailureBefore);

  const writeFailureRuntime = await makeRuntime(temp, 'Write Failure');
  const writeFailureOld = path.join(temp, 'Write Failure', 'Old Mirror');
  const writeFailureNew = path.join(temp, 'Write Failure', 'New Mirror');
  await saveDesktopSettings(request('https://old.example.test', writeFailureOld), { runtime: writeFailureRuntime });
  await fs.mkdir(writeFailureOld, { recursive: true });
  await fs.writeFile(path.join(writeFailureOld, 'course.txt'), 'restore after config failure');
  const writeFailureOldPhysical = await physicalPath(writeFailureOld);
  const writeFailure = await saveDesktopSettings(request('https://new.example.test', writeFailureNew, { mirrorAction: 'move' }), {
    runtime: writeFailureRuntime,
    forceCopy: true,
    writeConfig: async () => { throw new Error('synthetic atomic config failure'); }
  });
  assert.equal(errorCode(writeFailure, 'settings-save-failed'), true);
  assert.equal((await rawConfig(writeFailureRuntime)).baseUrl, 'https://old.example.test');
  assert.equal((await rawConfig(writeFailureRuntime)).outputDir, writeFailureOldPhysical);
  assert.equal(await fs.readFile(path.join(writeFailureOld, 'course.txt'), 'utf8'), 'restore after config failure');
  await assert.rejects(fs.access(writeFailureNew));

  const collisionRuntime = await makeRuntime(temp, 'Collision');
  const collisionOld = path.join(temp, 'Collision', 'Old Mirror');
  const collisionNew = path.join(temp, 'Collision', 'New Mirror');
  await saveDesktopSettings(request('https://example.test', collisionOld), { runtime: collisionRuntime });
  await fs.mkdir(collisionOld, { recursive: true });
  await fs.writeFile(path.join(collisionOld, 'old.txt'), 'old');
  const collisionOldPhysical = await physicalPath(collisionOld);
  await fs.mkdir(collisionNew, { recursive: true });
  await fs.writeFile(path.join(collisionNew, 'unrelated.txt'), 'do not overwrite');
  const collision = await saveDesktopSettings(request('https://example.test', collisionNew, { mirrorAction: 'move' }), { runtime: collisionRuntime });
  assert.equal(errorCode(collision, 'destination-collision'), true);
  assert.equal((await rawConfig(collisionRuntime)).outputDir, collisionOldPhysical);
  assert.equal(await fs.readFile(path.join(collisionNew, 'unrelated.txt'), 'utf8'), 'do not overwrite');

  const fileRuntime = await makeRuntime(temp, 'Existing Files');
  const mirrorFile = path.join(temp, 'Existing Files', 'mirror-file.txt');
  const driveFile = path.join(temp, 'Existing Files', 'drive-file.txt');
  await fs.writeFile(mirrorFile, 'not a directory');
  await fs.writeFile(driveFile, 'not a directory');
  const mirrorFileResult = await saveDesktopSettings(request('https://example.test', mirrorFile), { runtime: fileRuntime });
  assert.equal(errorCode(mirrorFileResult, 'directory-required'), true, 'an existing mirror file must be rejected');
  const driveFileResult = await saveDesktopSettings(request('https://example.test', path.join(temp, 'Existing Files', 'Mirror'), {
    driveEnabled: true,
    driveDestination: driveFile
  }), { runtime: fileRuntime });
  assert.equal(errorCode(driveFileResult, 'directory-required'), true, 'an existing Drive destination file must be rejected');

  const dotPrefixRuntime = await makeRuntime(temp, 'Dot Prefix Children');
  const dotPrefixPaths = resolveRuntimePaths(dotPrefixRuntime);
  const ordinaryMirror = path.join(temp, 'Dot Prefix Children', 'Ordinary Mirror');
  const ordinaryDrive = path.join(temp, 'Dot Prefix Children', 'Ordinary Drive');
  for (const protectedChild of [
    path.join(dotPrefixPaths.appRoot, '..mirror'),
    path.join(dotPrefixPaths.dataDir, '..data')
  ]) {
    const mirrorChild = await saveDesktopSettings(request('https://example.test', protectedChild), { runtime: dotPrefixRuntime });
    assert.equal(errorCode(mirrorChild, 'protected-path'), true, `${protectedChild} must remain a protected child mirror path`);

    const driveChild = await saveDesktopSettings(request('https://example.test', ordinaryMirror, {
      driveEnabled: true,
      driveDestination: protectedChild
    }), { runtime: dotPrefixRuntime });
    assert.equal(errorCode(driveChild, 'protected-path'), true, `${protectedChild} must remain a protected child Drive path`);
  }

  const driveInsideMirror = await saveDesktopSettings(request('https://example.test', ordinaryMirror, {
    driveEnabled: true,
    driveDestination: path.join(ordinaryMirror, '..mirror')
  }), { runtime: dotPrefixRuntime });
  assert.equal(errorCode(driveInsideMirror, 'protected-path'), true, 'a ..mirror Drive child must not bypass mirror overlap protection');

  const mirrorInsideDrive = await saveDesktopSettings(request('https://example.test', path.join(ordinaryDrive, '..data'), {
    driveEnabled: true,
    driveDestination: ordinaryDrive
  }), { runtime: dotPrefixRuntime });
  assert.equal(errorCode(mirrorInsideDrive, 'protected-path'), true, 'a ..data mirror child must not bypass Drive overlap protection');

  const aliasRuntime = await makeRuntime(temp, 'Canonical Aliases');
  const aliasPaths = resolveRuntimePaths(aliasRuntime);
  const actualMirror = path.join(temp, 'Canonical Aliases', 'Long Mirror Directory');
  const mirrorAlias = path.join(temp, 'Canonical Aliases', 'Mirror Alias');
  await saveDesktopSettings(request('https://example.test', actualMirror), { runtime: aliasRuntime });
  await fs.mkdir(actualMirror, { recursive: true });
  await fs.writeFile(path.join(actualMirror, 'course.txt'), 'alias-safe');

  const longMirror = await fs.realpath(actualMirror);
  const shortMirror = await windowsShortPath(longMirror);
  let shortAliasTested = false;
  if (shortMirror && shortMirror.toLowerCase() !== longMirror.toLowerCase()) {
    shortAliasTested = true;
    const shortAliasSave = await saveDesktopSettings(request('https://example.test', shortMirror), { runtime: aliasRuntime });
    assert.equal(shortAliasSave.ok, true, `DOS 8.3 alias must resolve to the unchanged physical mirror: ${JSON.stringify(shortAliasSave)}`);
    assert.equal(shortAliasSave.mirrorMoved, false);
    await assertSamePhysicalPath((await rawConfig(aliasRuntime)).outputDir, longMirror);
  }

  const aliasesSupported = await createDirectoryAlias(actualMirror, mirrorAlias);
  if (aliasesSupported) {
    const aliasSave = await saveDesktopSettings(request('https://example.test', mirrorAlias), { runtime: aliasRuntime });
    assert.equal(aliasSave.ok, true, 'filesystem alias must resolve to the unchanged physical mirror');
    assert.equal(aliasSave.mirrorMoved, false);
    await assertSamePhysicalPath(aliasSave.settings.mirrorDir, actualMirror);

    const dataAlias = path.join(temp, 'Canonical Aliases', 'Private Data Alias');
    assert.equal(await createDirectoryAlias(aliasPaths.dataDir, dataAlias), true);
    const protectedAlias = await saveDesktopSettings(request('https://example.test', path.join(dataAlias, 'Nested Mirror')), { runtime: aliasRuntime });
    assert.equal(errorCode(protectedAlias, 'protected-path'), true, 'nonexistent mirror tail below a private-data alias must be rejected');

    const appAlias = path.join(temp, 'Canonical Aliases', 'Application Alias');
    assert.equal(await createDirectoryAlias(aliasPaths.appRoot, appAlias), true);
    const protectedAppAlias = await saveDesktopSettings(request('https://example.test', path.join(appAlias, 'Nested Mirror')), { runtime: aliasRuntime });
    assert.equal(errorCode(protectedAppAlias, 'protected-path'), true, 'nonexistent mirror tail below an application alias must be rejected');

    const driveAlias = await saveDesktopSettings(request('https://example.test', actualMirror, {
      driveEnabled: true,
      driveDestination: path.join(mirrorAlias, 'Published')
    }), { runtime: aliasRuntime });
    assert.equal(errorCode(driveAlias, 'protected-path'), true, 'Drive alias resolving inside the mirror must be rejected');

    const destinationTarget = path.join(temp, 'Canonical Aliases', 'Empty Destination Target');
    const destinationAlias = path.join(temp, 'Canonical Aliases', 'Empty Destination Alias');
    await fs.mkdir(destinationTarget, { recursive: true });
    assert.equal(await createDirectoryAlias(destinationTarget, destinationAlias), true);
    const reparseDestination = await saveDesktopSettings(request('https://example.test', destinationAlias, { mirrorAction: 'move' }), { runtime: aliasRuntime });
    assert.equal(errorCode(reparseDestination, 'destination-reparse-point'), true, 'an empty reparse-point destination must not be removed or overwritten');
    assert.equal((await fs.lstat(destinationAlias)).isSymbolicLink(), true);
    assert.equal((await fs.stat(destinationTarget)).isDirectory(), true);
    assert.equal(await fs.readFile(path.join(actualMirror, 'course.txt'), 'utf8'), 'alias-safe');
  }

  const sourceAliasRuntime = await makeRuntime(temp, 'Source Reparse');
  const sourceAliasPaths = resolveRuntimePaths(sourceAliasRuntime);
  await getDesktopSettings({ runtime: sourceAliasRuntime });
  const sourceTarget = path.join(temp, 'Source Reparse', 'Physical Mirror');
  const sourceAlias = path.join(temp, 'Source Reparse', 'Configured Mirror Alias');
  const sourceNew = path.join(temp, 'Source Reparse', 'New Mirror');
  await fs.mkdir(sourceTarget, { recursive: true });
  await fs.writeFile(path.join(sourceTarget, 'course.txt'), 'do not move through alias');
  const sourceAliasSupported = await createDirectoryAlias(sourceTarget, sourceAlias);
  if (sourceAliasSupported) {
    const sourceRaw = await rawConfig(sourceAliasRuntime);
    sourceRaw.baseUrl = 'https://example.test';
    sourceRaw.outputDir = sourceAlias;
    const sourceRawBytes = `${JSON.stringify(sourceRaw, null, 2)}\n`;
    await fs.writeFile(sourceAliasPaths.configFile, sourceRawBytes);

    const sourceMove = await saveDesktopSettings(request('https://example.test', sourceNew, { mirrorAction: 'move' }), { runtime: sourceAliasRuntime });
    assert.equal(errorCode(sourceMove, 'source-reparse-point'), true, 'automatic move must reject a configured source reached through a reparse point');
    assert.equal(await fs.readFile(sourceAliasPaths.configFile, 'utf8'), sourceRawBytes);
    assert.equal((await fs.lstat(sourceAlias)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(path.join(sourceTarget, 'course.txt'), 'utf8'), 'do not move through alias');
    await assert.rejects(fs.access(sourceNew));

    const sourceUseNew = await saveDesktopSettings(request('https://example.test', sourceNew, { mirrorAction: 'use-new' }), { runtime: sourceAliasRuntime });
    assert.equal(sourceUseNew.ok, true, 'use-new must remain available for a reparse-point source');
    assert.equal(sourceUseNew.mirrorMoved, false);
    assert.equal((await fs.lstat(sourceAlias)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(path.join(sourceTarget, 'course.txt'), 'utf8'), 'do not move through alias');
    assert.equal((await rawConfig(sourceAliasRuntime)).outputDir, await physicalPath(sourceNew));
  }

  const exdevRuntime = await makeRuntime(temp, 'EXDEV Fallback');
  const exdevOld = path.join(temp, 'EXDEV Fallback', 'Old Mirror');
  const exdevNew = path.join(temp, 'EXDEV Fallback', 'New Mirror');
  await saveDesktopSettings(request('https://example.test', exdevOld), { runtime: exdevRuntime });
  await fs.mkdir(exdevOld, { recursive: true });
  await fs.writeFile(path.join(exdevOld, 'course.txt'), 'EXDEV fallback data');
  const exdevOldPhysical = await physicalPath(exdevOld);
  const exdevNewRequested = path.resolve(exdevNew);
  const realCopy = fs.cp.bind(fs);
  let exdevInjected = false;
  let exdevCopied = false;
  const exdevResult = await saveDesktopSettings(request('https://example.test', exdevNew, { mirrorAction: 'move' }), {
    runtime: exdevRuntime,
    fileSystem: {
      rename: async (source, destination) => {
        if (!exdevInjected && source === exdevOldPhysical && destination === exdevNewRequested) {
          exdevInjected = true;
          throw Object.assign(new Error('synthetic cross-device rename'), { code: 'EXDEV' });
        }
        return realRename(source, destination);
      },
      cp: async (...args) => {
        exdevCopied = true;
        return realCopy(...args);
      }
    }
  });
  assert.equal(exdevResult.ok, true);
  assert.equal(exdevResult.mirrorMoved, true);
  assert.equal(exdevInjected, true);
  assert.equal(exdevCopied, true, 'EXDEV must fall back to the staged-copy strategy');
  assert.equal(await fs.readFile(path.join(exdevNew, 'course.txt'), 'utf8'), 'EXDEV fallback data');
  await assert.rejects(fs.access(exdevOld));

  const rollbackRuntime = await makeRuntime(temp, 'Rollback Failure');
  const rollbackOld = path.join(temp, 'Rollback Failure', 'Old Mirror');
  const rollbackNew = path.join(temp, 'Rollback Failure', 'New Mirror');
  await saveDesktopSettings(request('https://old.example.test', rollbackOld), { runtime: rollbackRuntime });
  await fs.mkdir(rollbackOld, { recursive: true });
  await fs.writeFile(path.join(rollbackOld, 'course.txt'), 'recoverable rollback data');
  const rollbackOldPhysical = await physicalPath(rollbackOld);
  const rollbackNewPhysical = await physicalPath(rollbackNew);
  const rollbackFailure = await saveDesktopSettings(request('https://new.example.test', rollbackNew, { mirrorAction: 'move' }), {
    runtime: rollbackRuntime,
    forceCopy: true,
    fileSystem: {
      rename: async (source, destination) => {
        if (source.startsWith(`${rollbackOldPhysical}.moving-`) && destination === rollbackOldPhysical) {
          throw Object.assign(new Error('synthetic rollback failure'), { code: 'EACCES' });
        }
        return realRename(source, destination);
      }
    },
    writeConfig: async () => { throw new Error('synthetic config failure before commit'); }
  });
  assert.equal(errorCode(rollbackFailure, 'mirror-rollback-failed'), true, 'rollback failure must be surfaced');
  assert.deepEqual(rollbackFailure.recovery, {
    required: true,
    oldMirrorDir: rollbackOldPhysical,
    newMirrorDir: rollbackNewPhysical,
    configRetainedOldLocation: true
  });
  assert.equal((await rawConfig(rollbackRuntime)).outputDir, rollbackOldPhysical);
  assert.equal(await fs.readFile(path.join(rollbackNew, 'course.txt'), 'utf8'), 'recoverable rollback data');
  assert.equal((await fs.readdir(path.dirname(rollbackOld))).some(name => name.startsWith(`${path.basename(rollbackOldPhysical)}.moving-`)), true,
    'failed rollback must preserve its recoverable backup');

  const committedRuntime = await makeRuntime(temp, 'Committed Cleanup');
  const committedOld = path.join(temp, 'Committed Cleanup', 'Old Mirror');
  const committedNew = path.join(temp, 'Committed Cleanup', 'New Mirror');
  await saveDesktopSettings(request('https://old.example.test', committedOld), { runtime: committedRuntime });
  await fs.mkdir(committedOld, { recursive: true });
  await fs.writeFile(path.join(committedOld, 'course.txt'), 'committed data');
  const committedOldPhysical = await physicalPath(committedOld);
  const committedNewPhysical = await physicalPath(committedNew);
  const realRemove = fs.rm.bind(fs);
  let cleanupFailureInjected = false;
  const committed = await saveDesktopSettings(request('https://new.example.test', committedNew, { mirrorAction: 'move' }), {
    runtime: committedRuntime,
    forceCopy: true,
    fileSystem: {
      rm: async (value, options) => {
        if (value.startsWith(`${committedOldPhysical}.moving-`)) {
          cleanupFailureInjected = true;
          throw Object.assign(new Error('synthetic post-commit cleanup failure'), { code: 'EACCES' });
        }
        return realRemove(value, options);
      }
    }
  });
  assert.equal(committed.ok, true, 'post-commit backup cleanup failure must be nonfatal');
  assert.equal(cleanupFailureInjected, true);
  assert.equal((await rawConfig(committedRuntime)).outputDir, committedNewPhysical);
  assert.equal(await fs.readFile(path.join(committedNew, 'course.txt'), 'utf8'), 'committed data');
  await assert.rejects(fs.access(committedOld));
  assert.equal((await fs.readdir(path.dirname(committedOld))).some(name => name.startsWith(`${path.basename(committedOldPhysical)}.moving-`)), true,
    'best-effort cleanup failure may retain a backup but must not roll committed files back');

  const overrideRoot = path.join(temp, 'Override', 'Environment Mirror');
  const overrideAlias = path.join(temp, 'Override', 'Environment Mirror Alias');
  const overrideRuntime = await makeRuntime(temp, 'Override');
  await fs.mkdir(overrideRoot, { recursive: true });
  const overrideAliasSupported = await createDirectoryAlias(overrideRoot, overrideAlias);
  overrideRuntime.env.COURSEMIRROR_MIRROR_DIR = overrideAliasSupported ? overrideAlias : overrideRoot;
  const overridePaths = resolveRuntimePaths(overrideRuntime);
  const overrideSettings = await getDesktopSettings({ runtime: overrideRuntime });
  assert.equal(overrideSettings.mirrorOverrideActive, true);
  assert.equal(overrideSettings.maySuggestFirstRunMirror, false, 'an environment-controlled mirror must never be replaced by a first-run suggestion');
  await assertSamePhysicalPath(overrideSettings.mirrorDir, overrideRoot);
  const misleading = await saveDesktopSettings(request('https://example.test', path.join(temp, 'Override', 'Different')), { runtime: overrideRuntime });
  assert.equal(errorCode(misleading, 'environment-override-active'), true);
  const matching = await saveDesktopSettings(request('https://configured.example.test', overrideRoot), { runtime: overrideRuntime });
  assert.equal(matching.ok, true);
  await assertSamePhysicalPath(matching.settings.mirrorDir, overrideRoot);
  assert.equal((await rawConfig(overrideRuntime)).outputDir, '', 'environment override must not rewrite persisted outputDir');
  await assertSamePhysicalPath((await loadAppConfig({ runtime: overrideRuntime })).config.outputDir, overrideRoot);
  assert.equal(overridePaths.mirrorDirOverride, overrideAliasSupported ? overrideAlias : overrideRoot);

  const cliData = path.join(temp, 'CLI Data With Spaces');
  const cliHome = path.join(temp, 'CLI User With Spaces');
  const cliMirror = path.join(temp, 'CLI Mirror With Spaces');
  const cliPayload = request('https://cli.example.test', cliMirror);
  const cli = await spawnSettingsSave(cliData, cliHome, cliPayload);
  assert.equal(cli.code, 0, cli.stderr);
  const cliResponse = JSON.parse(cli.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(cliResponse.ok, true);
  await assertSamePhysicalPath(cliResponse.settings.mirrorDir, cliMirror);
  assert.deepEqual(cli.args.slice(-3), ['settings', 'save', '--json']);
  const cliRaw = JSON.parse(await fs.readFile(path.join(cliData, 'config.json'), 'utf8'));
  assert.equal(cliRaw.baseUrl, 'https://cli.example.test');
  await assertSamePhysicalPath(cliRaw.outputDir, cliMirror);

  const configKeys = allKeys([savedRaw, await rawConfig(moveRuntime), cliRaw]);
  for (const forbiddenKey of ['password', 'passwd', 'token', 'cookie', 'authorization', 'credential', 'client_secret']) {
    assert.equal(configKeys.includes(forbiddenKey), false, `settings config introduced forbidden key: ${forbiddenKey}`);
  }

  console.log(`Canonical alias coverage: filesystem alias ${aliasesSupported ? 'PASS' : 'SKIPPED (unsupported)'}; source reparse ${sourceAliasSupported ? 'PASS' : 'SKIPPED (unsupported)'}; DOS 8.3 alias ${shortAliasTested ? 'PASS' : 'SKIPPED (unavailable)'}`);
  console.log('Desktop settings self-test: PASS');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
