import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, exists, writeJsonAtomic } from './utils.mjs';

const TERM_DIR_RE = /^\d{4}-(?:Winter|Spring|Summer|Fall)$/i;
const PUBLISH_STATE_SCHEMA = 1;

function normalizeRel(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function sourceFingerprint(stat) {
  return {
    size: Number(stat.size || 0),
    mtimeMs: Math.round(Number(stat.mtimeMs || 0))
  };
}

function sameFingerprint(a, b) {
  return Boolean(a && b && Number(a.size) === Number(b.size) && Math.round(Number(a.mtimeMs)) === Math.round(Number(b.mtimeMs)));
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function retry(operation, attempts = 4, delayMs = 700) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  throw lastError;
}

async function collectFiles(root) {
  const files = [];
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = path.join(root, relDir);
    let entries = [];
    try { entries = await fs.readdir(absDir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const rel = normalizeRel(path.join(relDir, entry.name));
      const abs = path.join(root, rel);
      if (entry.isDirectory()) stack.push(rel);
      else if (entry.isFile() && !/^_sync_state\.json$/i.test(entry.name)) {
        const stat = await fs.stat(abs);
        files.push({ rel, abs, stat, fingerprint: sourceFingerprint(stat) });
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

async function publishRoots(config) {
  const roots = [];
  const entries = await fs.readdir(config.outputDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '_school' || TERM_DIR_RE.test(entry.name) || entry.name === 'Unclassified') roots.push(entry.name);
  }
  roots.sort();
  return roots;
}

async function removeEmptyDirs(root) {
  async function walk(dir, isRoot = false) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) if (entry.isDirectory()) await walk(path.join(dir, entry.name), false);
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
    if (!isRoot && entries.length === 0) {
      try { await fs.rmdir(dir); return true; } catch {}
    }
    return false;
  }
  if (await exists(root)) await walk(root, true);
}

export function resolveDrivePublishConfig(config) {
  const raw = config.drivePublish || {};
  const destination = raw.destination || '';
  const mountWait = Number(raw.mountWaitMs ?? 60_000);
  return {
    enabled: raw.enabled ?? false,
    destination,
    deleteRemoved: raw.deleteRemoved ?? true,
    verifyDestinationOnFull: raw.verifyDestinationOnFull ?? true,
    retryAttempts: Number(raw.retryAttempts ?? 4),
    retryDelayMs: Number(raw.retryDelayMs ?? 700),
    mountWaitMs: Number.isFinite(mountWait) ? Math.max(0, Math.min(300_000, mountWait)) : 60_000
  };
}

export async function publishMirrorToDrive(config, mode = 'manual') {
  const settings = resolveDrivePublishConfig(config);
  if (!settings.enabled) return { enabled: false, skipped: true, reason: 'disabled' };
  if (!settings.destination) return { enabled: true, skipped: true, reason: 'destination-not-configured' };

  const destination = path.resolve(settings.destination);
  const driveRoot = path.parse(destination).root;
  const mountDeadline = Date.now() + settings.mountWaitMs;
  while (!(await exists(driveRoot))) {
    if (Date.now() >= mountDeadline) {
      return { enabled: true, skipped: true, reason: 'drive-not-mounted', destination };
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(3_000, mountDeadline - Date.now())));
  }

  await ensureDir(destination);
  const stateDir = config.stateDir || config.systemDir || path.join(config.outputDir, '_system');
  await ensureDir(stateDir);
  const stateFile = path.join(stateDir, 'drive_publish_state.json');
  const oldState = await readJson(stateFile, { schemaVersion: PUBLISH_STATE_SCHEMA, destination: null, files: {} });
  const destinationChanged = path.resolve(oldState.destination || '') !== destination;
  const oldFiles = destinationChanged ? {} : (oldState.files || {});

  const roots = await publishRoots(config);
  const current = new Map();
  for (const rootName of roots) {
    const rootPath = path.join(config.outputDir, rootName);
    for (const file of await collectFiles(rootPath)) {
      const rel = normalizeRel(path.join(rootName, file.rel));
      current.set(rel, { ...file, rel });
    }
  }

  const started = Date.now();
  const stats = { scanned: current.size, copied: 0, deleted: 0, unchanged: 0, failed: 0, verifiedMissing: 0 };
  const nextFiles = {};
  const errors = [];
  const fullVerify = (mode === 'full' || mode === 'manual') && settings.verifyDestinationOnFull;

  for (const [rel, file] of current) {
    const prior = oldFiles[rel];
    const dest = path.join(destination, ...rel.split('/'));
    let needsCopy = !sameFingerprint(prior, file.fingerprint);

    if (!needsCopy && fullVerify) {
      try { await fs.access(dest); }
      catch { needsCopy = true; stats.verifiedMissing += 1; }
    }

    if (!needsCopy) {
      stats.unchanged += 1;
      nextFiles[rel] = prior;
      continue;
    }

    try {
      await ensureDir(path.dirname(dest));
      await retry(async () => {
        await fs.copyFile(file.abs, dest);
        try { await fs.utimes(dest, file.stat.atime, file.stat.mtime); } catch {}
      }, settings.retryAttempts, settings.retryDelayMs);
      stats.copied += 1;
      nextFiles[rel] = { ...file.fingerprint, publishedAt: new Date().toISOString() };
    } catch (error) {
      stats.failed += 1;
      errors.push({ rel, action: 'copy', error: error.message });
      if (prior) nextFiles[rel] = prior;
    }
  }

  if (settings.deleteRemoved && !destinationChanged) {
    for (const rel of Object.keys(oldFiles)) {
      if (current.has(rel)) continue;
      const dest = path.join(destination, ...rel.split('/'));
      try {
        if (await exists(dest)) {
          await retry(() => fs.unlink(dest), settings.retryAttempts, settings.retryDelayMs);
          stats.deleted += 1;
        }
      } catch (error) {
        stats.failed += 1;
        errors.push({ rel, action: 'delete', error: error.message });
        nextFiles[rel] = oldFiles[rel];
      }
    }
    await removeEmptyDirs(destination);
  }

  const completedAt = new Date().toISOString();
  const state = {
    schemaVersion: PUBLISH_STATE_SCHEMA,
    destination,
    lastAttemptAt: completedAt,
    lastSuccessfulPublishAt: stats.failed === 0 ? completedAt : (oldState.lastSuccessfulPublishAt || null),
    lastMode: mode,
    roots,
    summary: stats,
    files: nextFiles,
    errors
  };
  await writeJsonAtomic(stateFile, state);

  return {
    enabled: true,
    skipped: false,
    destination,
    durationSeconds: Math.round((Date.now() - started) / 100) / 10,
    ...stats,
    errors
  };
}
