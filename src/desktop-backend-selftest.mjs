import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DESKTOP_STATUS_SCHEMA_VERSION, getDesktopStatus } from './desktop-backend.mjs';
import { getDesktopSettings } from './desktop-settings.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_KEYS = [
  'activeOperation', 'appVersion', 'attention', 'baseUrlConfigured', 'configExists',
  'configured', 'dataDir', 'lastSync', 'logsDir', 'mirrorDir',
  'profileExists', 'schemaVersion', 'status'
].sort();
const FORBIDDEN_KEYS = new Set([
  'auth', 'baseurl', 'browserexecutablepath', 'cookie', 'cookies', 'credential',
  'credentials', 'password', 'profiledir', 'secret', 'session', 'token'
]);

function isOutside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

function assertNoSensitiveFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(FORBIDDEN_KEYS.has(key.toLowerCase()), false, `status must not expose sensitive field ${key}`);
    assertNoSensitiveFields(child);
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'coursestow-desktop-backend-'));
try {
  const dataDir = path.join(temp, 'User Data');
  const mirrorDir = path.join(temp, 'Chosen Mirror');
  const runtime = {
    appRoot: ROOT,
    env: {
      ...process.env,
      COURSESTOW_DATA_DIR: dataDir,
      COURSESTOW_MIRROR_DIR: mirrorDir
    }
  };
  const paths = resolveRuntimePaths(runtime);
  const first = await getDesktopStatus({ runtime });
  assert.deepEqual(Object.keys(first).sort(), EXPECTED_KEYS);
  assert.equal(first.schemaVersion, DESKTOP_STATUS_SCHEMA_VERSION);
  assert.equal(first.status, 'ready');
  assert.equal(first.configExists, true);
  assert.equal(first.configured, false);
  assert.equal(first.baseUrlConfigured, false);
  assert.equal(first.mirrorDir, mirrorDir);
  assert.equal(first.logsDir, paths.logsDir);
  assert.equal(first.dataDir, paths.dataDir);
  assert.equal(first.profileExists, true);
  assert.equal(first.lastSync, null);
  assert.equal(first.activeOperation, null);
  assert.equal(first.attention, null);
  for (const externalPath of [first.mirrorDir, first.logsDir, first.dataDir]) {
    assert.equal(isOutside(ROOT, externalPath), true, `${externalPath} must be outside the application tree`);
  }
  assertNoSensitiveFields(first);

  const completedAt = '2026-09-03T12:34:56.000Z';
  await fs.writeFile(path.join(paths.stateDir, 'state.json'), JSON.stringify({
    lastSuccessfulSync: completedAt,
    sensitiveIgnoredValue: 'not-returned'
  }));
  await fs.writeFile(path.join(paths.lockDir, '.coursestow.lock'), JSON.stringify({
    mode: 'quick',
    token: 'not-returned',
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString()
  }));
  const running = await getDesktopStatus({ runtime });
  assert.equal(running.status, 'running');
  assert.equal(running.activeOperation, 'Quick Sync');
  assert.equal(running.lastSync, completedAt);
  assertNoSensitiveFields(running);
  await fs.rm(path.join(paths.lockDir, '.coursestow.lock'), { force: true });

  await fs.writeFile(path.join(paths.lockDir, '.coursestow.lock'), JSON.stringify({
    mode: 'full',
    pid: 2147483647,
    hostname: os.hostname(),
    startedAt: new Date().toISOString()
  }));
  const deadSameHost = await getDesktopStatus({ runtime });
  assert.equal(deadSameHost.status, 'ready');
  assert.equal(deadSameHost.activeOperation, null);

  await fs.writeFile(path.join(paths.lockDir, '.coursestow.lock'), 'malformed lock');
  const conservativelyRunning = await getDesktopStatus({ runtime });
  assert.equal(conservativelyRunning.status, 'running');
  assert.equal(conservativelyRunning.activeOperation, 'CourseStow operation');
  const oldTime = new Date('2000-01-01T00:00:00.000Z');
  await fs.utimes(path.join(paths.lockDir, '.coursestow.lock'), oldTime, oldTime);
  const expiredMalformed = await getDesktopStatus({ runtime });
  assert.equal(expiredMalformed.status, 'ready');
  assert.equal(expiredMalformed.activeOperation, null);
  await fs.rm(path.join(paths.lockDir, '.coursestow.lock'), { force: true });

  const conflictHome = path.join(temp, 'Conflict Home');
  const conflictLocal = path.join(conflictHome, 'AppData', 'Local');
  const conflictOld = path.join(conflictLocal, 'Brightspace Sync');
  const conflictNew = path.join(conflictLocal, 'CourseStow');
  await fs.mkdir(conflictOld, { recursive: true });
  await fs.mkdir(conflictNew, { recursive: true });
  await fs.writeFile(path.join(conflictOld, 'config.json'), '{"old":true}');
  await fs.writeFile(path.join(conflictNew, 'config.json'), '{"new":true}');
  const conflictStatus = await getDesktopStatus({
    runtime: {
      appRoot: ROOT,
      env: { LOCALAPPDATA: conflictLocal, USERPROFILE: conflictHome },
      platform: 'win32',
      homeDir: conflictHome
    }
  });
  assert.equal(conflictStatus.status, 'error');
  assert.equal(conflictStatus.configured, false);
  assert.match(conflictStatus.attention, /manual review is required/i);
  assert.match(conflictStatus.attention, /Brightspace Sync/);
  assert.match(conflictStatus.attention, /CourseStow/);

  const launched = await run(process.execPath, [path.join(ROOT, 'src', 'launcher.mjs'), 'status', '--json'], {
    cwd: temp,
    env: runtime.env
  });
  assert.equal(launched.code, 0, launched.stderr);
  assert.equal(launched.signal, null);
  assert.equal(launched.stderr, '');
  const response = JSON.parse(launched.stdout.trim());
  assert.equal(response.schemaVersion, DESKTOP_STATUS_SCHEMA_VERSION);
  assert.equal(response.mirrorDir, mirrorDir);
  assert.equal(response.dataDir, dataDir);
  assertNoSensitiveFields(response);

  const unsafeDataDir = path.join(temp, 'Unsafe URL Data');
  const unsafeRuntime = {
    appRoot: ROOT,
    env: {
      ...process.env,
      COURSESTOW_DATA_DIR: unsafeDataDir,
      COURSESTOW_MIRROR_DIR: path.join(temp, 'Unsafe URL Mirror')
    }
  };
  const unsafePaths = resolveRuntimePaths(unsafeRuntime);
  await getDesktopStatus({ runtime: unsafeRuntime });
  const unsafeRaw = JSON.parse(await fs.readFile(unsafePaths.configFile, 'utf8'));
  const unsafeMarkers = ['RuntimeUserInfoSecret123', 'RuntimeQuerySecret123', 'RuntimeFragmentSecret123'];
  unsafeRaw.baseUrl = `https://legacy-user:${unsafeMarkers[0]}@example.test/course?token=${unsafeMarkers[1]}#${unsafeMarkers[2]}`;
  const unsafeBytes = `${JSON.stringify(unsafeRaw, null, 2)}\n`;
  await fs.writeFile(unsafePaths.configFile, unsafeBytes);

  const unsafeStatus = await getDesktopStatus({ runtime: unsafeRuntime });
  const unsafeSettings = await getDesktopSettings({ runtime: unsafeRuntime });
  assert.equal(unsafeStatus.configured, false);
  assert.equal(unsafeStatus.baseUrlConfigured, false);
  assert.equal(unsafeSettings.configured, false);
  assert.equal(unsafeSettings.baseUrl, '');
  assert.equal(await fs.readFile(unsafePaths.configFile, 'utf8'), unsafeBytes, 'status/settings inspection must not rewrite an unsafe legacy URL');

  let emitted = `${JSON.stringify(unsafeStatus)}\n${JSON.stringify(unsafeSettings)}`;
  for (const command of ['quick', 'full']) {
    const unsafeSync = await run(process.execPath, [path.join(ROOT, 'src', 'launcher.mjs'), command], {
      cwd: temp,
      env: unsafeRuntime.env
    });
    assert.notEqual(unsafeSync.code, 0, `${command} sync must reject an unsafe legacy URL`);
    assert.match(`${unsafeSync.stdout}\n${unsafeSync.stderr}`, /baseUrl is missing/i, 'unsafe URL must fail before browser navigation');
    emitted += `\n${unsafeSync.stdout}\n${unsafeSync.stderr}`;
  }
  let logText = '';
  for (const name of await fs.readdir(unsafePaths.logsDir)) {
    const file = path.join(unsafePaths.logsDir, name);
    if ((await fs.stat(file)).isFile()) logText += await fs.readFile(file, 'utf8');
  }
  for (const marker of unsafeMarkers) {
    assert.equal(emitted.includes(marker), false, `unsafe URL marker escaped through status, settings, or sync output: ${marker}`);
    assert.equal(logText.includes(marker), false, `unsafe URL marker escaped into runtime logs: ${marker}`);
  }
  assert.equal(await fs.readFile(unsafePaths.configFile, 'utf8'), unsafeBytes, 'rejected sync must not rewrite an unsafe legacy URL');

  console.log('Desktop backend contract self-test: PASS');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
