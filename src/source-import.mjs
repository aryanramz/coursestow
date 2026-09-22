import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { CURRENT_CONFIG_VERSION, withUserConfigTransaction } from './config.mjs';
import { normalizeBrightspaceBaseUrl } from './brightspace-url.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { acquireSyncLock } from './sync-lock.mjs';

export const SOURCE_IMPORT_SCHEMA_VERSION = 1;
const IMPORTABLE_STATE_NAMES = new Set(['state.json', 'drive_publish_state.json', 'courses']);
const SENSITIVE_KEY = /(password|passwd|token|secret|cookie|authorization|credential|api[-_]?key)/i;
const SAFE_CREDENTIAL_NAMED_KEYS = new Set(['autoSubmitSavedBrowserCredentials']);

async function exists(value, io = fs) {
  try { await io.lstat(value); return true; } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function directoryHasEntries(directory, io = fs) {
  try { return (await io.readdir(directory)).length > 0; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function rawConfigIsMeaningful(raw) {
  return Boolean(
    String(raw?.baseUrl || '').trim()
    || String(raw?.outputDir || '').trim()
    || String(raw?.browserExecutablePath || '').trim()
    || raw?.drivePublish?.enabled === true
    || String(raw?.drivePublish?.destination || '').trim()
    || raw?.auth?.automaticLoginEnabled === true
    || raw?.schedule?.enabled === true
  );
}

export async function installedRuntimeHasMeaningfulData({ raw, paths }, io = fs) {
  if (rawConfigIsMeaningful(raw)) return true;
  if (await directoryHasEntries(paths.profileDir, io)) return true;
  try {
    const entries = await io.readdir(paths.stateDir, { withFileTypes: true });
    return entries.some(entry => IMPORTABLE_STATE_NAMES.has(entry.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function validateRoot(sourceRoot, io) {
  const requested = path.resolve(String(sourceRoot || '').trim());
  const entry = await io.lstat(requested).catch(() => null);
  if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('Choose an existing ordinary CourseStow setup folder.');
  }
  // A Windows DOS 8.3 spelling can differ from realpath() without the selected
  // directory itself being a reparse point. lstat() rejects an actual selected
  // symlink/junction; use the physical root from here on so known child paths
  // cannot escape through a harmless filesystem alias in an ancestor.
  return io.realpath(requested);
}

async function assertTreeContainsNoLinks(root, io) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await io.readdir(current, { withFileTypes: true })) {
      const value = path.join(current, entry.name);
      const stat = await io.lstat(value);
      if (stat.isSymbolicLink()) throw new Error('The selected setup contains a filesystem link and cannot be imported safely.');
      if (stat.isDirectory()) pending.push(value);
      else if (!stat.isFile()) throw new Error('The selected setup contains an unsupported filesystem entry.');
    }
  }
}

function stripSensitiveFields(value) {
  if (Array.isArray(value)) return value.map(stripSensitiveFields);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && !SAFE_CREDENTIAL_NAMED_KEYS.has(key)) continue;
    result[key] = stripSensitiveFields(item);
  }
  return result;
}

function normalizeImportedConfig(raw, sourceRoot) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The selected setup configuration is invalid.');
  const version = Object.hasOwn(raw, 'configVersion') ? raw.configVersion : 0;
  if (!Number.isInteger(version) || version < 0 || version > CURRENT_CONFIG_VERSION) {
    throw new Error('The selected setup configuration version is not supported.');
  }
  const result = stripSensitiveFields(raw);
  result.configVersion = CURRENT_CONFIG_VERSION;
  result.baseUrl = normalizeBrightspaceBaseUrl(raw.baseUrl) || '';
  const absolute = value => {
    const text = String(value || '').trim();
    if (!text) return '';
    return path.isAbsolute(text) ? path.normalize(text) : path.resolve(sourceRoot, text);
  };
  result.outputDir = absolute(raw.outputDir);
  result.browserExecutablePath = absolute(raw.browserExecutablePath);
  if (result.drivePublish) {
    result.drivePublish = {
      ...result.drivePublish,
      destination: absolute(raw.drivePublish?.destination)
    };
  }
  result.auth = {
    autoSubmitSavedBrowserCredentials: raw.auth?.autoSubmitSavedBrowserCredentials === true,
    automaticLoginEnabled: false,
    manualLoginTimeoutMs: Number(raw.auth?.manualLoginTimeoutMs || 10 * 60 * 1000)
  };
  delete result.profileDir;
  return result;
}

async function readImportSource(sourceRoot, io) {
  const root = await validateRoot(sourceRoot, io);
  const configFile = path.join(root, 'config.json');
  const configEntry = await io.lstat(configFile).catch(() => null);
  if (!configEntry || !configEntry.isFile() || configEntry.isSymbolicLink()) {
    throw new Error('The selected folder does not contain a supported CourseStow configuration.');
  }
  let raw;
  try { raw = JSON.parse(await io.readFile(configFile, 'utf8')); }
  catch { throw new Error('The selected setup configuration is not valid JSON.'); }

  const profileCandidates = [path.join(root, 'BrowserProfile'), path.join(root, '.brightspace-profile')];
  let profileDir = '';
  for (const candidate of profileCandidates) {
    const entry = await io.lstat(candidate).catch(() => null);
    if (!entry) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('The selected browser profile is not an ordinary directory.');
    await assertTreeContainsNoLinks(candidate, io);
    profileDir = candidate;
    break;
  }

  const stateDir = path.join(root, 'state');
  const stateEntries = [];
  const stateEntry = await io.lstat(stateDir).catch(() => null);
  if (stateEntry) {
    if (!stateEntry.isDirectory() || stateEntry.isSymbolicLink()) throw new Error('The selected state folder is not an ordinary directory.');
    for (const name of IMPORTABLE_STATE_NAMES) {
      const value = path.join(stateDir, name);
      const entry = await io.lstat(value).catch(() => null);
      if (!entry) continue;
      if (entry.isSymbolicLink()) throw new Error('The selected state contains a filesystem link.');
      if (entry.isDirectory()) await assertTreeContainsNoLinks(value, io);
      else if (!entry.isFile()) throw new Error('The selected state contains an unsupported filesystem entry.');
      stateEntries.push({ name, value, directory: entry.isDirectory() });
    }
  }

  return { root, config: normalizeImportedConfig(raw, root), profileDir, stateEntries };
}

async function stageImport(source, paths, io) {
  const staging = path.join(path.dirname(paths.dataDir), `CourseStow.importing-${process.pid}-${randomUUID()}`);
  await io.mkdir(staging, { recursive: false });
  try {
    await io.writeFile(path.join(staging, 'config.json'), `${JSON.stringify(source.config, null, 2)}\n`, 'utf8');
    if (source.profileDir) {
      await io.cp(source.profileDir, path.join(staging, 'BrowserProfile'), {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true
      });
    }
    if (source.stateEntries.length) {
      const stateDir = path.join(staging, 'state');
      await io.mkdir(stateDir);
      for (const entry of source.stateEntries) {
        const destination = path.join(stateDir, entry.name);
        if (entry.directory) await io.cp(entry.value, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
        else await io.copyFile(entry.value, destination);
      }
    }
    return staging;
  } catch (error) {
    await io.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function promoteImport(staging, paths, io) {
  const backup = path.join(path.dirname(paths.dataDir), `CourseStow.import-backup-${process.pid}-${randomUUID()}`);
  const promoted = [];
  const backedUp = [];
  await io.mkdir(backup);
  const items = [
    [path.join(staging, 'config.json'), paths.configFile, 'config.json'],
    [path.join(staging, 'BrowserProfile'), paths.profileDir, 'BrowserProfile']
  ];
  const stagedState = path.join(staging, 'state');
  if (await exists(stagedState, io)) {
    for (const name of await io.readdir(stagedState)) {
      items.push([path.join(stagedState, name), path.join(paths.stateDir, name), path.join('state', name)]);
    }
  }

  try {
    for (const [source, destination, relative] of items) {
      if (!await exists(source, io)) continue;
      const backupPath = path.join(backup, relative);
      await io.mkdir(path.dirname(backupPath), { recursive: true });
      if (await exists(destination, io)) {
        await io.rename(destination, backupPath);
        backedUp.push([backupPath, destination]);
      }
      await io.mkdir(path.dirname(destination), { recursive: true });
      await io.rename(source, destination);
      promoted.push(destination);
    }
  } catch {
    let rollbackFailed = false;
    for (const destination of promoted.reverse()) {
      await io.rm(destination, { recursive: true, force: true }).catch(() => { rollbackFailed = true; });
    }
    for (const [backupPath, destination] of backedUp.reverse()) {
      await io.rename(backupPath, destination).catch(() => { rollbackFailed = true; });
    }
    if (rollbackFailed) {
      const error = new Error('Source import did not complete and automatic rollback requires manual recovery.');
      error.code = 'source-import-rollback-failed';
      throw error;
    }
    throw new Error('Source import did not complete. The installed data was restored.');
  } finally {
    await io.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  await io.rm(backup, { recursive: true, force: true }).catch(() => {});
}

function failure(code, message) {
  return { schemaVersion: SOURCE_IMPORT_SCHEMA_VERSION, ok: false, errors: [{ code, message }] };
}

export async function importSourceCheckout(request, { runtime = {}, io = fs } = {}) {
  if (request?.schemaVersion !== SOURCE_IMPORT_SCHEMA_VERSION) return failure('unsupported-schema', 'The import request version is not supported.');
  const sourceRoot = String(request?.sourceDir || '').trim();
  if (!sourceRoot || !path.isAbsolute(sourceRoot)) return failure('invalid-source', 'Choose an absolute existing CourseStow setup folder.');

  const paths = resolveRuntimePaths(runtime);
  const syncLock = await acquireSyncLock(paths.lockDir, { mode: 'settings' });
  if (!syncLock.acquired) return failure('operation-active', 'Another CourseStow operation is running. Try again when it finishes.');
  try {
    return await withUserConfigTransaction({
      runtime,
      async execute(loaded) {
        if (await installedRuntimeHasMeaningfulData(loaded, io)) {
          return failure('target-not-empty', 'Import is available only before meaningful CourseStow data has been configured.');
        }
        let staging = '';
        try {
          const source = await readImportSource(sourceRoot, io);
          staging = await stageImport(source, loaded.paths, io);
          await promoteImport(staging, loaded.paths, io);
          return { schemaVersion: SOURCE_IMPORT_SCHEMA_VERSION, ok: true, imported: true };
        } catch (error) {
          if (staging) await io.rm(staging, { recursive: true, force: true }).catch(() => {});
          return failure(error?.code || 'invalid-source', error?.message || 'The selected setup could not be imported safely.');
        }
      }
    });
  } finally {
    await syncLock.release();
  }
}
