import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { getDesktopSettings } from './desktop-settings.mjs';
import { importSourceCheckout } from './source-import.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';

async function makeRuntime(root, name) {
  const appRoot = path.join(root, name, 'Application');
  const userHome = path.join(root, name, 'User');
  await fs.mkdir(appRoot, { recursive: true });
  await fs.writeFile(path.join(appRoot, 'config.example.json'), JSON.stringify({
    configVersion: 1,
    baseUrl: 'https://your-school.brightspace.com',
    outputDir: '',
    browserExecutablePath: '',
    drivePublish: { enabled: false, destination: '' },
    schedule: { enabled: false, intervalHours: 6, fullIntervalDays: 7 }
  }, null, 2));
  return {
    appRoot,
    env: { USERPROFILE: userHome, LOCALAPPDATA: path.join(userHome, 'AppData', 'Local') },
    platform: 'win32',
    homeDir: userHome
  };
}

async function makeSource(root, name, profileName = 'BrowserProfile') {
  const source = path.join(root, name);
  const mirror = path.join(root, `${name} School Mirror`);
  const drive = path.join(root, `${name} Drive Copy`);
  await fs.mkdir(path.join(source, profileName), { recursive: true });
  await fs.mkdir(path.join(source, 'state', 'courses'), { recursive: true });
  await fs.mkdir(path.join(source, '.git'), { recursive: true });
  await fs.mkdir(path.join(source, 'node_modules', 'fixture'), { recursive: true });
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.mkdir(mirror, { recursive: true });
  await fs.mkdir(drive, { recursive: true });
  await fs.writeFile(path.join(source, profileName, 'Cookies'), 'synthetic-session-fixture');
  await fs.writeFile(path.join(source, 'state', 'state.json'), JSON.stringify({ lastSuccessfulSync: '2026-01-01T00:00:00.000Z' }));
  await fs.writeFile(path.join(source, 'state', 'courses', '100.json'), JSON.stringify({ title: 'Synthetic Course' }));
  await fs.writeFile(path.join(source, 'state', 'unrelated-private.json'), JSON.stringify({ ignored: true }));
  await fs.writeFile(path.join(source, '.git', 'config'), 'ignored git data');
  await fs.writeFile(path.join(source, 'node_modules', 'fixture', 'index.js'), 'ignored dependency');
  await fs.writeFile(path.join(source, 'src', 'index.mjs'), 'ignored source');
  await fs.writeFile(path.join(mirror, 'course.txt'), 'mirror stays external');
  await fs.writeFile(path.join(drive, 'course.txt'), 'drive stays external');
  await fs.writeFile(path.join(source, 'config.json'), JSON.stringify({
    configVersion: 1,
    baseUrl: 'https://example.test/path?temporary=discarded#fragment',
    outputDir: mirror,
    browserExecutablePath: '',
    drivePublish: { enabled: true, destination: drive },
    auth: {
      automaticLoginEnabled: true,
      autoSubmitSavedBrowserCredentials: true,
      password: 'ExampleSecret123',
      token: 'fake-token-value'
    },
    unknownSafeSetting: { retained: true },
    client_secret: 'fake-client-secret'
  }, null, 2));
  return { source, mirror, drive };
}

function browserFixture() {
  return {
    engine: 'chromium', available: true, displayName: 'Synthetic Chromium',
    executablePath: '', source: 'automatic', configuredManually: false,
    supportLevel: 'official', validationStatus: 'compatible'
  };
}

function hasError(response, code) {
  return response.errors?.some(error => error.code === code);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'coursemirror-source-import-'));
try {
  const runtime = await makeRuntime(temp, 'Successful');
  const paths = resolveRuntimePaths(runtime);
  const fresh = await getDesktopSettings({ runtime, browserInspector: async () => browserFixture() });
  assert.equal(fresh.mayImportLegacySetup, true, 'fresh generated runtime must offer explicit import');
  const source = await makeSource(temp, 'Existing CourseMirror');
  const sourceConfigBefore = await fs.readFile(path.join(source.source, 'config.json'), 'utf8');
  const imported = await importSourceCheckout({ schemaVersion: 1, sourceDir: source.source }, { runtime });
  assert.equal(imported.ok, true, 'valid CourseMirror setup must import');

  const importedConfigText = await fs.readFile(paths.configFile, 'utf8');
  const importedConfig = JSON.parse(importedConfigText);
  assert.equal(importedConfig.configVersion, 1, 'imported config must commit in the current schema');
  assert.equal(importedConfig.baseUrl, 'https://example.test/path', 'import must normalize safe URL and remove query/fragment');
  assert.equal(importedConfig.outputDir, source.mirror, 'school mirror must remain referenced rather than copied');
  assert.equal(importedConfig.drivePublish.destination, source.drive, 'Drive destination must remain referenced rather than copied');
  assert.equal(importedConfig.auth.automaticLoginEnabled, false, 'plaintext-source credentials must never enable automatic login');
  assert.equal(importedConfig.unknownSafeSetting.retained, true, 'safe compatible configuration must survive import');
  assert.equal(importedConfigText.includes('ExampleSecret123'), false);
  assert.equal(importedConfigText.includes('fake-token-value'), false);
  assert.equal(importedConfigText.includes('fake-client-secret'), false);
  assert.equal(await fs.readFile(path.join(paths.profileDir, 'Cookies'), 'utf8'), 'synthetic-session-fixture');
  assert.equal(JSON.parse(await fs.readFile(path.join(paths.stateDir, 'state.json'), 'utf8')).lastSuccessfulSync, '2026-01-01T00:00:00.000Z');
  await fs.access(path.join(paths.stateDir, 'courses', '100.json'));
  await assert.rejects(fs.access(path.join(paths.stateDir, 'unrelated-private.json')));
  await assert.rejects(fs.access(path.join(paths.dataDir, '.git')));
  await assert.rejects(fs.access(path.join(paths.dataDir, 'node_modules')));
  await assert.rejects(fs.access(path.join(paths.dataDir, 'src')));
  assert.equal(await fs.readFile(path.join(source.source, 'config.json'), 'utf8'), sourceConfigBefore, 'source checkout must remain untouched');
  assert.equal(await fs.readFile(path.join(source.mirror, 'course.txt'), 'utf8'), 'mirror stays external');
  assert.equal(await fs.readFile(path.join(source.drive, 'course.txt'), 'utf8'), 'drive stays external');
  const repeated = await importSourceCheckout({ schemaVersion: 1, sourceDir: source.source }, { runtime });
  assert.equal(hasError(repeated, 'target-not-empty'), true, 'meaningful installed runtime must not be overwritten');

  const legacyRuntime = await makeRuntime(temp, 'Legacy Profile');
  await getDesktopSettings({ runtime: legacyRuntime, browserInspector: async () => browserFixture() });
  const legacySource = await makeSource(temp, 'Pre-Rename Brightspace Sync', '.brightspace-profile');
  const legacyImported = await importSourceCheckout({ schemaVersion: 1, sourceDir: legacySource.source }, { runtime: legacyRuntime });
  assert.equal(legacyImported.ok, true, 'supported pre-rename checkout layout must import');
  assert.equal(await fs.readFile(path.join(resolveRuntimePaths(legacyRuntime).profileDir, 'Cookies'), 'utf8'), 'synthetic-session-fixture');

  const invalidRuntime = await makeRuntime(temp, 'Invalid');
  await getDesktopSettings({ runtime: invalidRuntime, browserInspector: async () => browserFixture() });
  const invalidDir = path.join(temp, 'Not A Setup');
  await fs.mkdir(invalidDir);
  const invalid = await importSourceCheckout({ schemaVersion: 1, sourceDir: invalidDir }, { runtime: invalidRuntime });
  assert.equal(invalid.ok, false, 'arbitrary directory must be rejected');

  const rollbackRuntime = await makeRuntime(temp, 'Rollback');
  await getDesktopSettings({ runtime: rollbackRuntime, browserInspector: async () => browserFixture() });
  const rollbackPaths = resolveRuntimePaths(rollbackRuntime);
  const originalConfig = await fs.readFile(rollbackPaths.configFile, 'utf8');
  const rollbackSource = await makeSource(temp, 'Rollback Source');
  const failingIo = {
    ...fs,
    async rename(from, to) {
      if (from.includes('CourseMirror.importing-') && path.normalize(to) === path.normalize(rollbackPaths.profileDir)) {
        const error = new Error('Synthetic promotion failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.rename(from, to);
    }
  };
  const failed = await importSourceCheckout({ schemaVersion: 1, sourceDir: rollbackSource.source }, { runtime: rollbackRuntime, io: failingIo });
  assert.equal(failed.ok, false, 'failed promotion must return a recoverable error');
  assert.equal(await fs.readFile(rollbackPaths.configFile, 'utf8'), originalConfig, 'failed import must restore prior config exactly');
  assert.equal((await fs.readdir(rollbackPaths.profileDir)).length, 0, 'failed import must not leave a partial BrowserProfile');
  assert.equal(await fs.readFile(path.join(rollbackSource.source, 'BrowserProfile', 'Cookies'), 'utf8'), 'synthetic-session-fixture', 'failed import must leave the source profile untouched');
  assert.equal(await fs.readFile(path.join(rollbackSource.source, 'state', 'state.json'), 'utf8').then(JSON.parse).then(value => value.lastSuccessfulSync), '2026-01-01T00:00:00.000Z', 'failed import must leave source state untouched');

  const ancestorAliasRuntime = await makeRuntime(temp, 'Ancestor Alias');
  await getDesktopSettings({ runtime: ancestorAliasRuntime, browserInspector: async () => browserFixture() });
  const physicalParent = path.join(temp, 'Alias Physical Parent');
  await fs.mkdir(physicalParent);
  const ancestorAliasSource = await makeSource(physicalParent, 'Existing Through Alias');
  const ancestorAliasParent = path.join(temp, 'Alias Parent Link');
  let ancestorAliasSupported = true;
  try { await fs.symlink(physicalParent, ancestorAliasParent, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) ancestorAliasSupported = false; else throw error; }
  if (ancestorAliasSupported) {
    const throughAncestorAlias = path.join(ancestorAliasParent, path.basename(ancestorAliasSource.source));
    const importedThroughAncestorAlias = await importSourceCheckout(
      { schemaVersion: 1, sourceDir: throughAncestorAlias },
      { runtime: ancestorAliasRuntime }
    );
    assert.equal(importedThroughAncestorAlias.ok, true, 'a harmless alias in an ancestor must not invalidate an ordinary selected source directory');
  }

  const aliasRuntime = await makeRuntime(temp, 'Alias');
  await getDesktopSettings({ runtime: aliasRuntime, browserInspector: async () => browserFixture() });
  const aliasSource = await makeSource(temp, 'Alias Source');
  const aliasPath = path.join(temp, 'Alias Link');
  let aliasSupported = true;
  try { await fs.symlink(aliasSource.source, aliasPath, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) aliasSupported = false; else throw error; }
  if (aliasSupported) {
    const unsafe = await importSourceCheckout({ schemaVersion: 1, sourceDir: aliasPath }, { runtime: aliasRuntime });
    assert.equal(unsafe.ok, false, 'reparse-point source root must be rejected');
  }

  const aliasNote = ancestorAliasSupported && aliasSupported ? '' : ' (one or more reparse fixtures unavailable)';
  console.log(`Source-checkout import transaction self-test: PASS${aliasNote}`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
