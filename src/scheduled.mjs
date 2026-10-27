import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exists } from './utils.mjs';
import { loadAppConfig } from './config.mjs';
import { applicationEntry, resolveRuntimePaths } from './runtime-paths.mjs';
import {
  AUTH_ATTENTION_EXIT_CODE,
  hasAuthAttention,
  setAuthAttention
} from './auth-attention.mjs';

export const SCHEDULED_LOG_MAX_BYTES = 64 * 1024;
const SCHEDULED_CATEGORIES = new Set([
  'completed', 'sync-failed', 'operation-active', 'launch-failed',
  'configuration-error', 'configuration-required', 'disabled',
  'refresh-login-required', 'publish-incomplete'
]);

export async function lastFullSync(outputDir, stateDir, io = fs) {
  const files = [
    path.join(stateDir, 'state.json'),
    path.join(outputDir, '_school', 'current.json'),
    path.join(outputDir, '_system', 'state.json')
  ];

  for (const file of files) {
    if (!(await exists(file))) continue;
    try {
      const data = JSON.parse(await io.readFile(file, 'utf8'));
      const value = data?.sync?.lastFullSync ?? data?.lastFullSync;
      if (value && Number.isFinite(Date.parse(value))) return value;
    } catch {
      // An unreadable or malformed status file is not trusted as evidence that
      // a Full Sync has completed.
    }
  }
  return null;
}

export function chooseScheduledMode(lastFull, fullIntervalDays, now = Date.now()) {
  if (!lastFull) return 'full';
  const parsed = Date.parse(lastFull);
  if (!Number.isFinite(parsed)) return 'full';
  const dueMs = fullIntervalDays * 24 * 60 * 60 * 1000;
  return now - parsed >= dueMs ? 'full' : 'quick';
}

function boundedLog(value, maximumBytes) {
  const lines = value.split(/(?<=\n)/);
  while (lines.length > 1 && Buffer.byteLength(lines.join(''), 'utf8') > maximumBytes) lines.shift();
  const joined = lines.join('');
  return Buffer.byteLength(joined, 'utf8') <= maximumBytes ? joined : '';
}

export async function appendScheduledLog(logsDir, entry, { io = fs, maximumBytes = SCHEDULED_LOG_MAX_BYTES } = {}) {
  await io.mkdir(logsDir, { recursive: true });
  const destination = path.join(logsDir, 'scheduled.log');
  let existing = '';
  try { existing = await io.readFile(destination, 'utf8'); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const safeEntry = {
    timestamp: String(entry.timestamp),
    mode: ['quick', 'full'].includes(entry.mode) ? entry.mode : null,
    exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : 1,
    category: SCHEDULED_CATEGORIES.has(entry.category) ? entry.category : 'sync-failed'
  };
  const next = boundedLog(`${existing}${JSON.stringify(safeEntry)}\n`, maximumBytes);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await io.writeFile(temporary, next, { encoding: 'utf8', flag: 'wx' });
    await io.rename(temporary, destination);
  } catch (error) {
    await io.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(signal ? 1 : (exitCode ?? 1)));
  });
}

export async function runScheduled({
  loadConfig = loadAppConfig,
  spawnProcess = spawn,
  now = () => Date.now(),
  runtime = {},
  log = appendScheduledLog,
  attentionIsSet = hasAuthAttention,
  setAttention = setAuthAttention
} = {}) {
  const fallbackPaths = resolveRuntimePaths(runtime);
  let loaded;
  try {
    loaded = await loadConfig({ mode: 'full', runtime });
  } catch {
    await log(fallbackPaths.logsDir, {
      timestamp: new Date(now()).toISOString(), mode: null, exitCode: 1, category: 'configuration-error'
    }).catch(() => {});
    return 1;
  }

  const { config, paths } = loaded;
  const attentionStateDir = config.stateDir || paths.stateDir;
  if (!config.schedule?.enabled) {
    await log(paths.logsDir, {
      timestamp: new Date(now()).toISOString(), mode: null, exitCode: 0, category: 'disabled'
    }).catch(() => {});
    return 0;
  }
  if (!config.baseUrl) {
    await log(paths.logsDir, {
      timestamp: new Date(now()).toISOString(), mode: null, exitCode: 2, category: 'configuration-required'
    }).catch(() => {});
    return 2;
  }
  if (await attentionIsSet(attentionStateDir)) {
    await log(paths.logsDir, {
      timestamp: new Date(now()).toISOString(), mode: null,
      exitCode: AUTH_ATTENTION_EXIT_CODE, category: 'refresh-login-required'
    }).catch(() => {});
    return AUTH_ATTENTION_EXIT_CODE;
  }

  const lastFull = await lastFullSync(config.outputDir, config.stateDir);
  const mode = chooseScheduledMode(lastFull, config.schedule.fullIntervalDays, now());
  let exitCode = 1;
  let category = 'launch-failed';
  try {
    const child = spawnProcess(process.execPath, [
      applicationEntry('src/index.mjs', paths),
      `--mode=${mode}`,
      '--scheduled-run'
    ], {
      cwd: paths.appRoot,
      stdio: 'ignore',
      windowsHide: true
    });
    exitCode = await waitForChild(child);
    if (exitCode === AUTH_ATTENTION_EXIT_CODE) {
      category = 'refresh-login-required';
      await setAttention(attentionStateDir).catch(() => {});
    } else {
      category = exitCode === 0 ? 'completed'
        : (exitCode === 3 ? 'operation-active'
          : (exitCode === 2 ? 'publish-incomplete' : 'sync-failed'));
    }
  } catch {
    exitCode = 1;
  }
  await log(paths.logsDir, {
    timestamp: new Date(now()).toISOString(), mode, exitCode, category
  }).catch(() => {});
  return exitCode;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) process.exitCode = await runScheduled();
