import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CURRENT_CONFIG_VERSION, loadAppConfig } from './config.mjs';
import { acquireInitializationLock, INIT_LOCK_FILE_NAME } from './init-lock.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { writeJsonAtomic } from './utils.mjs';

async function makeRuntime(tmp, name) {
  const appRoot = path.join(tmp, name, 'Application');
  const userHome = path.join(tmp, name, 'User');
  const localAppData = path.join(userHome, 'AppData', 'Local');
  await fs.mkdir(appRoot, { recursive: true });
  await fs.writeFile(path.join(appRoot, 'config.example.json'), JSON.stringify({
    configVersion: CURRENT_CONFIG_VERSION,
    baseUrl: 'https://your-school.brightspace.com',
    outputDir: '',
    drivePublish: { enabled: false, destination: '' }
  }, null, 2));
  return {
    appRoot,
    env: { LOCALAPPDATA: localAppData, USERPROFILE: userHome },
    platform: 'win32',
    homeDir: userHome
  };
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coursestow-runtime-foundation-'));
try {
  const atomicDir = path.join(tmp, 'Atomic');
  const atomicFile = path.join(atomicDir, 'config.json');
  await fs.mkdir(atomicDir, { recursive: true });
  await fs.writeFile(atomicFile, '{"stable":true}\n');
  await assert.rejects(writeJsonAtomic(atomicFile, { replacement: true }, {
    replace: async () => { throw new Error('simulated atomic replace failure'); }
  }), /simulated atomic replace failure/);
  assert.deepEqual(JSON.parse(await fs.readFile(atomicFile, 'utf8')), { stable: true });
  assert.equal((await fs.readdir(atomicDir)).some(name => name.includes('.tmp-')), false, 'failed atomic writes must clean temporary files');
  assert.equal(await writeJsonAtomic(atomicFile, { replacement: true }), 'updated');
  assert.deepEqual(JSON.parse(await fs.readFile(atomicFile, 'utf8')), { replacement: true });

  const concurrentRuntime = await makeRuntime(tmp, 'Concurrent');
  const [concurrentA, concurrentB] = await Promise.all([
    loadAppConfig({ runtime: concurrentRuntime, initializationLock: { waitMs: 2_000, pollMs: 10 } }),
    loadAppConfig({ runtime: concurrentRuntime, initializationLock: { waitMs: 2_000, pollMs: 10 } })
  ]);
  assert.equal(concurrentA.config.configVersion, CURRENT_CONFIG_VERSION);
  assert.equal(concurrentB.config.configVersion, CURRENT_CONFIG_VERSION);
  const createActions = [...concurrentA.migrations, ...concurrentB.migrations]
    .filter(action => action.action === 'create-user-config');
  assert.equal(createActions.length, 1, 'simultaneous initialization must create the user config exactly once');
  const concurrentPaths = resolveRuntimePaths(concurrentRuntime);
  const freshRaw = JSON.parse(await fs.readFile(concurrentPaths.configFile, 'utf8'));
  assert.equal(freshRaw.configVersion, CURRENT_CONFIG_VERSION);
  assert.equal(freshRaw.baseUrl, '');
  await assert.rejects(fs.access(path.join(concurrentPaths.stateDir, INIT_LOCK_FILE_NAME)), 'initialization lock must be released');
  const repeated = await loadAppConfig({ runtime: concurrentRuntime });
  assert.equal(repeated.migrations.length, 0, 'repeated normal loads must be idempotent');

  const legacyRuntime = await makeRuntime(tmp, 'Legacy');
  const legacyPaths = resolveRuntimePaths(legacyRuntime);
  const legacyProfile = path.join(legacyRuntime.appRoot, 'LegacyProfile');
  await fs.mkdir(legacyProfile, { recursive: true });
  await fs.writeFile(path.join(legacyProfile, 'Cookies'), 'legacy-session');
  await fs.mkdir(legacyPaths.dataDir, { recursive: true });
  const legacyConfig = {
    baseUrl: 'https://example.brightspace.com',
    outputDir: './ChosenMirror',
    profileDir: legacyProfile,
    browserExecutablePath: './Browser/browser.exe',
    auth: { autoSubmitSavedBrowserCredentials: false, manualLoginTimeoutMs: 123456 },
    activeTerms: ['2026-Fall'],
    includeUpcomingTermDays: 33,
    currentTerm: 'Fall 2026',
    assetPolicy: { downloadDocuments: false, maxDownloadBytes: 1234, customAssetChoice: 'preserve' },
    drivePublish: { enabled: true, destination: './DriveMirror', deleteRemoved: false },
    schedule: { fullIntervalDays: 11, customScheduleChoice: true },
    unknownFutureFriendlyKey: { nested: ['preserve-me'] }
  };
  await fs.writeFile(legacyPaths.configFile, JSON.stringify(legacyConfig, null, 2));
  const migrated = await loadAppConfig({ runtime: legacyRuntime });
  const migratedRaw = JSON.parse(await fs.readFile(legacyPaths.configFile, 'utf8'));
  assert.equal(migratedRaw.configVersion, CURRENT_CONFIG_VERSION);
  assert.equal(Object.hasOwn(migratedRaw, 'profileDir'), false);
  for (const key of Object.keys(legacyConfig).filter(key => key !== 'profileDir')) {
    assert.deepEqual(migratedRaw[key], legacyConfig[key], `legacy choice ${key} must be preserved`);
  }
  assert.equal(migrated.config.outputDir, path.join(legacyPaths.dataDir, 'ChosenMirror'));
  assert.equal(await fs.readFile(path.join(migrated.config.profileDir, 'Cookies'), 'utf8'), 'legacy-session');
  assert.equal(await fs.readFile(path.join(legacyProfile, 'Cookies'), 'utf8'), 'legacy-session');
  assert.ok(migrated.migrations.some(action => action.action === 'migrate-config-version' && action.fromVersion === 0 && action.toVersion === 1));
  assert.equal((await loadAppConfig({ runtime: legacyRuntime })).migrations.length, 0);

  const unsafeUrlRuntime = await makeRuntime(tmp, 'Unsafe Legacy URL');
  const unsafeUrlPaths = resolveRuntimePaths(unsafeUrlRuntime);
  await fs.mkdir(unsafeUrlPaths.dataDir, { recursive: true });
  const unsafeUrlMarker = 'RuntimeUserInfoSecret123';
  const unsafeUrlRaw = {
    configVersion: CURRENT_CONFIG_VERSION,
    baseUrl: `https://legacy-user:${unsafeUrlMarker}@example.test/course?token=RuntimeQuerySecret123#RuntimeFragmentSecret123`,
    outputDir: ''
  };
  const unsafeUrlBytes = `${JSON.stringify(unsafeUrlRaw, null, 2)}\n`;
  await fs.writeFile(unsafeUrlPaths.configFile, unsafeUrlBytes);
  const unsafeUrlLoaded = await loadAppConfig({ runtime: unsafeUrlRuntime });
  assert.equal(unsafeUrlLoaded.config.baseUrl, '', 'runtime config must treat a legacy URL containing userinfo as unconfigured');
  assert.equal(await fs.readFile(unsafeUrlPaths.configFile, 'utf8'), unsafeUrlBytes, 'runtime URL normalization must not rewrite legacy config');

  const queryUrlRuntime = await makeRuntime(tmp, 'Legacy Query URL');
  const queryUrlPaths = resolveRuntimePaths(queryUrlRuntime);
  await fs.mkdir(queryUrlPaths.dataDir, { recursive: true });
  const queryUrlRaw = {
    configVersion: CURRENT_CONFIG_VERSION,
    baseUrl: 'https://example.test/course?token=RuntimeQuerySecret123#RuntimeFragmentSecret123',
    outputDir: ''
  };
  const queryUrlBytes = `${JSON.stringify(queryUrlRaw, null, 2)}\n`;
  await fs.writeFile(queryUrlPaths.configFile, queryUrlBytes);
  const queryUrlLoaded = await loadAppConfig({ runtime: queryUrlRuntime });
  assert.equal(queryUrlLoaded.config.baseUrl, 'https://example.test/course', 'runtime config must remove URL query strings and fragments in memory');
  assert.equal(await fs.readFile(queryUrlPaths.configFile, 'utf8'), queryUrlBytes, 'safe in-memory URL normalization must not rewrite config');

  const futureRuntime = await makeRuntime(tmp, 'Future');
  const futurePaths = resolveRuntimePaths(futureRuntime);
  await fs.mkdir(futurePaths.dataDir, { recursive: true });
  const futureConfig = { configVersion: CURRENT_CONFIG_VERSION + 1, baseUrl: 'https://future.invalid', unknown: true };
  await fs.writeFile(futurePaths.configFile, JSON.stringify(futureConfig, null, 2));
  await assert.rejects(loadAppConfig({ runtime: futureRuntime }), /newer than this application supports/);
  assert.deepEqual(JSON.parse(await fs.readFile(futurePaths.configFile, 'utf8')), futureConfig);
  await assert.rejects(fs.access(path.join(futurePaths.stateDir, INIT_LOCK_FILE_NAME)), 'future-version rejection must release the initialization lock');

  const invalidRuntime = await makeRuntime(tmp, 'Invalid Version');
  const invalidPaths = resolveRuntimePaths(invalidRuntime);
  await fs.mkdir(invalidPaths.dataDir, { recursive: true });
  const invalidConfig = { configVersion: '1', baseUrl: 'https://invalid-version.example' };
  await fs.writeFile(invalidPaths.configFile, JSON.stringify(invalidConfig, null, 2));
  await assert.rejects(loadAppConfig({ runtime: invalidRuntime }), /Invalid configVersion/);
  assert.deepEqual(JSON.parse(await fs.readFile(invalidPaths.configFile, 'utf8')), invalidConfig);
  await assert.rejects(fs.access(path.join(invalidPaths.stateDir, INIT_LOCK_FILE_NAME)), 'invalid-version rejection must release the initialization lock');

  const staleRuntime = await makeRuntime(tmp, 'Stale Lock');
  const stalePaths = resolveRuntimePaths(staleRuntime);
  await fs.mkdir(stalePaths.stateDir, { recursive: true });
  await fs.writeFile(path.join(stalePaths.stateDir, INIT_LOCK_FILE_NAME), JSON.stringify({
    schemaVersion: 1,
    token: 'stale-token',
    pid: 99999999,
    mode: 'initialization',
    hostname: os.hostname(),
    startedAt: '2000-01-01T00:00:00.000Z'
  }));
  const recovered = await loadAppConfig({ runtime: staleRuntime, initializationLock: { waitMs: 500, pollMs: 10 } });
  assert.equal(recovered.config.configVersion, CURRENT_CONFIG_VERSION);
  await assert.rejects(fs.access(path.join(stalePaths.stateDir, INIT_LOCK_FILE_NAME)), 'stale initialization lock must be replaced and released');

  const activeRuntime = await makeRuntime(tmp, 'Active Lock');
  const activePaths = resolveRuntimePaths(activeRuntime);
  const held = await acquireInitializationLock(activePaths, { waitMs: 0 });
  assert.equal(held.acquired, true);
  await assert.rejects(loadAppConfig({
    runtime: activeRuntime,
    initializationLock: { waitMs: 100, pollMs: 10 }
  }), /Timed out after 100ms waiting for CourseStow initialization/);
  const activePayload = JSON.parse(await fs.readFile(held.lockFile, 'utf8'));
  assert.equal(activePayload.token, held.payload.token, 'an active initialization lock must not be stolen');
  await held.release();
  assert.equal((await loadAppConfig({ runtime: activeRuntime })).config.configVersion, CURRENT_CONFIG_VERSION);

  console.log('Runtime foundation self-test: PASS');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
