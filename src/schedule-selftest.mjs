import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeScheduleConfig, validateScheduleRequest } from './schedule-config.mjs';
import { buildSyncBrowserLaunchOptions } from './browser-launch-options.mjs';
import { acquireSyncLock } from './sync-lock.mjs';
import {
  AUTH_ATTENTION_EXIT_CODE,
  authAttentionFile,
  clearAuthAttention,
  hasAuthAttention
} from './auth-attention.mjs';
import {
  SCHEDULED_LOG_MAX_BYTES,
  appendScheduledLog,
  chooseScheduledMode,
  runScheduled
} from './scheduled.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coursestow-schedule-selftest-'));
try {
  assert.deepEqual(normalizeScheduleConfig(undefined), {
    enabled: false, intervalHours: 6, fullIntervalDays: 7
  });
  assert.deepEqual(normalizeScheduleConfig({ fullIntervalDays: 11, retained: true }), {
    enabled: false, intervalHours: 6, fullIntervalDays: 11
  });
  assert.equal(normalizeScheduleConfig({ enabled: true, intervalHours: 0, fullIntervalDays: 31 }).intervalHours, 6);
  const validation = validateScheduleRequest(
    { enabled: true, intervalHours: 25, fullIntervalDays: 0 },
    (field, code, message) => ({ field, code, message })
  );
  assert.deepEqual(validation.errors.map(error => error.field), ['schedule.intervalHours', 'schedule.fullIntervalDays']);

  const now = Date.parse('2026-09-11T12:00:00.000Z');
  assert.equal(chooseScheduledMode(null, 7, now), 'full');
  assert.equal(chooseScheduledMode('malformed', 7, now), 'full');
  assert.equal(chooseScheduledMode('2026-09-10T12:00:00.000Z', 7, now), 'quick');
  assert.equal(chooseScheduledMode('2026-09-01T12:00:00.000Z', 7, now), 'full');
  const scheduledBrowser = buildSyncBrowserLaunchOptions({ baseUrl: 'https://example.test', auth: {} }, 'browser.exe', { scheduledRun: true });
  assert.equal(scheduledBrowser.headless, false, 'scheduled browser must remain headed for login and MFA');
  assert.equal(scheduledBrowser.args.includes('--start-minimized'), true, 'scheduled browser must start minimized');

  const dataDir = path.join(root, 'User Data');
  const mirrorDir = path.join(root, 'School Mirror');
  const stateDir = path.join(dataDir, 'state');
  const logsDir = path.join(dataDir, 'logs');
  const appRoot = path.join(root, 'Application Files');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(mirrorDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, 'state.json'), JSON.stringify({
    sync: { lastFullSync: '2026-09-10T12:00:00.000Z' }
  }));

  let spawnCall = null;
  const fakeSpawn = (file, args, options) => {
    spawnCall = { file, args, options };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  const loadConfig = async () => ({
    config: {
      baseUrl: 'https://example.test', outputDir: mirrorDir, stateDir,
      schedule: { enabled: true, intervalHours: 6, fullIntervalDays: 7 }
    },
    paths: { appRoot, logsDir }
  });
  const result = await runScheduled({ loadConfig, spawnProcess: fakeSpawn, now: () => now });
  assert.equal(result, 0);
  assert.equal(spawnCall.file, process.execPath);
  assert.deepEqual(spawnCall.args, [path.join(appRoot, 'src', 'index.mjs'), '--mode=quick', '--scheduled-run']);
  assert.equal(spawnCall.options.cwd, appRoot);
  assert.equal(spawnCall.options.stdio, 'ignore');
  assert.equal(spawnCall.options.windowsHide, true);

  const failedExit = await runScheduled({
    loadConfig,
    spawnProcess: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 17, null));
      return child;
    },
    now: () => now + 1
  });
  assert.equal(failedExit, 17);
  const failedLogEntry = JSON.parse((await fs.readFile(path.join(logsDir, 'scheduled.log'), 'utf8')).trim().split(/\r?\n/).at(-1));
  assert.deepEqual(failedLogEntry, {
    timestamp: new Date(now + 1).toISOString(), mode: 'quick', exitCode: 17, category: 'sync-failed'
  });

  const syntheticAuthMarker = 'synthetic-auth-value-must-not-be-logged';
  let authLaunches = 0;
  let credentialReads = 0;
  const authRequired = await runScheduled({
    loadConfig,
    spawnProcess: () => {
      authLaunches += 1;
      credentialReads += 1;
      const child = new EventEmitter();
      child.standardError = `password=${syntheticAuthMarker}`;
      queueMicrotask(() => child.emit('exit', AUTH_ATTENTION_EXIT_CODE, null));
      return child;
    },
    now: () => now + 2
  });
  assert.equal(authRequired, AUTH_ATTENTION_EXIT_CODE);
  assert.equal(await hasAuthAttention(stateDir), true, 'authentication failure must set the private attention latch');
  assert.deepEqual(JSON.parse(await fs.readFile(authAttentionFile(stateDir), 'utf8')), {
    schemaVersion: 1,
    required: true
  });
  const suppressedRetry = await runScheduled({
    loadConfig,
    spawnProcess: () => { throw new Error('latched scheduled run must not launch'); },
    now: () => now + 3
  });
  assert.equal(suppressedRetry, AUTH_ATTENTION_EXIT_CODE);
  assert.equal(authLaunches, 1, 'latched scheduled run launched a second crawler/browser');
  assert.equal(credentialReads, 1, 'latched scheduled run caused a second credential read/submission');
  const authLog = await fs.readFile(path.join(logsDir, 'scheduled.log'), 'utf8');
  const authEntries = authLog.trim().split(/\r?\n/).slice(-2).map(line => JSON.parse(line));
  assert.deepEqual(authEntries.map(entry => entry.category), [
    'refresh-login-required',
    'refresh-login-required'
  ]);
  assert.equal(authLog.includes(syntheticAuthMarker), false);
  await clearAuthAttention(stateDir);
  assert.equal(await hasAuthAttention(stateDir), false);

  let disabledLaunches = 0;
  const disabled = await runScheduled({
    loadConfig: async () => ({
      config: { baseUrl: 'https://example.test', schedule: { enabled: false } },
      paths: { appRoot, logsDir }
    }),
    spawnProcess: () => { disabledLaunches += 1; },
    now: () => now
  });
  assert.equal(disabled, 0);
  assert.equal(disabledLaunches, 0);

  const overlapData = path.join(root, 'Overlap Data');
  const overlapState = path.join(overlapData, 'state');
  const overlapMirror = path.join(root, 'Overlap Mirror');
  await fs.mkdir(overlapState, { recursive: true });
  const example = JSON.parse(await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8'));
  await fs.writeFile(path.join(overlapData, 'config.json'), `${JSON.stringify({
    ...example,
    baseUrl: 'https://example.test',
    outputDir: overlapMirror,
    schedule: { enabled: true, intervalHours: 6, fullIntervalDays: 7 }
  }, null, 2)}\n`);
  const heldLock = await acquireSyncLock(overlapState, { mode: 'full' });
  assert.equal(heldLock.acquired, true);
  try {
    const overlap = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.mjs'), '--mode=quick', '--scheduled-run'], {
        cwd: ROOT,
        env: {
          ...process.env,
          COURSESTOW_DATA_DIR: overlapData,
          COURSESTOW_MIRROR_DIR: overlapMirror
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => resolve({ code, stderr }));
    });
    assert.equal(overlap.code, 3, overlap.stderr);
  } finally {
    await heldLock.release();
  }

  const unsafeMarker = 'fake-scheduled-secret-marker';
  await appendScheduledLog(logsDir, {
    timestamp: new Date(now).toISOString(), mode: 'full', exitCode: 1,
    category: `sync-failed-${unsafeMarker}`,
    stderr: `password=${unsafeMarker}`,
    url: `https://example.test/?token=${unsafeMarker}`
  });
  assert.equal((await fs.readFile(path.join(logsDir, 'scheduled.log'), 'utf8')).includes(unsafeMarker), false);
  for (let index = 0; index < 1400; index += 1) {
    await appendScheduledLog(logsDir, {
      timestamp: new Date(now + index).toISOString(), mode: 'quick', exitCode: 0, category: 'completed'
    });
  }
  const scheduledLog = await fs.readFile(path.join(logsDir, 'scheduled.log'), 'utf8');
  assert(!scheduledLog.includes(unsafeMarker));
  assert(Buffer.byteLength(scheduledLog) <= SCHEDULED_LOG_MAX_BYTES);
  const logLines = scheduledLog.trim().split(/\r?\n/);
  for (const line of logLines) JSON.parse(line);
  const latest = JSON.parse(logLines.at(-1));
  assert.deepEqual(Object.keys(latest), ['timestamp', 'mode', 'exitCode', 'category']);

  console.log('Scheduled sync self-test passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
