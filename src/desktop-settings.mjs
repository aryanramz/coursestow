import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { withUserConfigTransaction } from './config.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { acquireSyncLock } from './sync-lock.mjs';
import { normalizeBrightspaceBaseUrl } from './brightspace-url.mjs';
import { institutionAdapterForBaseUrl } from './auth-adapters.mjs';
import { normalizeScheduleConfig, validateScheduleRequest } from './schedule-config.mjs';
import { clearAuthAttention } from './auth-attention.mjs';
import { discoverChromiumBrowserCandidate, inspectChromiumBrowser } from './browser.mjs';
import { installedRuntimeHasMeaningfulData } from './source-import.mjs';

export const DESKTOP_SETTINGS_SCHEMA_VERSION = 1;

function normalizedPath(value) {
  return path.normalize(path.resolve(String(value || '').trim()));
}

function comparableCanonicalPath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameCanonicalPath(left, right) {
  return comparableCanonicalPath(left) === comparableCanonicalPath(right);
}

function insideOrSameCanonical(parent, candidate) {
  const relative = path.relative(parent, candidate);
  const comparable = process.platform === 'win32' ? relative.toLowerCase() : relative;
  const parentTraversal = `..${path.sep}`;
  return comparable === '' || (
    comparable !== '..'
    && !comparable.startsWith(parentTraversal)
    && !path.isAbsolute(relative)
  );
}

function canonicalPathsOverlap(left, right) {
  return insideOrSameCanonical(left, right) || insideOrSameCanonical(right, left);
}

function validationError(field, code, message) {
  return { field, code, message };
}

function isMissingPathError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

async function lstatIfExists(io, value) {
  try {
    return await io.lstat(value);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function pathReachedThroughReparsePoint(value, io) {
  const normalized = normalizedPath(value);
  const root = path.parse(normalized).root;
  const segments = normalized.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const entry = await lstatIfExists(io, current);
    if (!entry) return false;
    if (entry.isSymbolicLink()) return true;
  }
  return false;
}

export async function canonicalFilesystemPath(value, io = fs) {
  const requestedPath = normalizedPath(value);
  const directEntry = await lstatIfExists(io, requestedPath);
  if (directEntry) {
    const [physicalPath, stat, reachedThroughReparsePoint] = await Promise.all([
      io.realpath(requestedPath),
      io.stat(requestedPath),
      pathReachedThroughReparsePoint(requestedPath, io)
    ]);
    return {
      requestedPath,
      physicalPath: normalizedPath(physicalPath),
      exists: true,
      isDirectory: stat.isDirectory(),
      isReparsePoint: directEntry.isSymbolicLink(),
      reachedThroughReparsePoint
    };
  }

  const unresolved = [path.basename(requestedPath)];
  let ancestor = path.dirname(requestedPath);
  while (true) {
    const entry = await lstatIfExists(io, ancestor);
    if (entry) {
      const [physicalAncestor, stat] = await Promise.all([
        io.realpath(ancestor),
        io.stat(ancestor)
      ]);
      if (!stat.isDirectory()) {
        const error = new Error('A parent component of the selected path is not a directory.');
        error.code = 'ENOTDIR';
        throw error;
      }
      return {
        requestedPath,
        physicalPath: normalizedPath(path.join(physicalAncestor, ...unresolved)),
        exists: false,
        isDirectory: null,
        isReparsePoint: false,
        reachedThroughReparsePoint: await pathReachedThroughReparsePoint(ancestor, io)
      };
    }

    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('No existing filesystem ancestor could be resolved.');
    unresolved.unshift(path.basename(ancestor));
    ancestor = parent;
  }
}

export function normalizeBrightspaceUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw validationError('baseUrl', 'required', 'Enter your Brightspace URL.');
  const normalized = normalizeBrightspaceBaseUrl(raw);
  if (normalized) return normalized;
  let parsed;
  try { parsed = new URL(raw); } catch {
    throw validationError('baseUrl', 'invalid-url', 'Enter a valid absolute Brightspace URL.');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw validationError('baseUrl', 'https-required', 'Brightspace URL must use HTTPS and contain a hostname.');
  }
  throw validationError('baseUrl', 'invalid-url', 'Enter a safe Brightspace HTTPS URL without embedded credentials.');
}

async function maySuggestFirstRunMirror({ config, paths, raw }, io) {
  if (paths.mirrorDirOverride || String(raw?.outputDir || '').trim()) return false;
  try {
    const [effectiveMirror, generatedDefault] = await Promise.all([
      canonicalFilesystemPath(config.outputDir, io),
      canonicalFilesystemPath(paths.defaultMirrorDir, io)
    ]);
    if (!sameCanonicalPath(effectiveMirror.physicalPath, generatedDefault.physicalPath)) return false;
    if (!effectiveMirror.exists) return true;
    if (!effectiveMirror.isDirectory || effectiveMirror.reachedThroughReparsePoint) return false;
    return !(await directoryHasMeaningfulContents(effectiveMirror.physicalPath, io));
  } catch {
    return false;
  }
}

async function safeSettings({ config, paths, raw }, io = fs, browserInspector = discoverChromiumBrowserCandidate) {
  const baseUrl = normalizeBrightspaceBaseUrl(config.baseUrl);
  const adapter = institutionAdapterForBaseUrl(baseUrl);
  const browser = await browserInspector(config.browserExecutablePath || '');
  return {
    schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
    configured: Boolean(baseUrl),
    baseUrl,
    mirrorDir: config.outputDir,
    mirrorOverrideActive: Boolean(paths.mirrorDirOverride),
    maySuggestFirstRunMirror: await maySuggestFirstRunMirror({ config, paths, raw }, io),
    mayImportLegacySetup: !(await installedRuntimeHasMeaningfulData({ config, paths, raw }, io)),
    browser,
    authentication: {
      supported: Boolean(adapter),
      institution: adapter?.id || '',
      automaticLoginEnabled: Boolean(adapter && config.auth?.automaticLoginEnabled)
    },
    schedule: normalizeScheduleConfig(config.schedule),
    drive: {
      enabled: Boolean(config.drivePublish.enabled),
      destination: config.drivePublish.destination || ''
    }
  };
}

export async function getDesktopSettings({ runtime = {}, browserInspector = discoverChromiumBrowserCandidate } = {}) {
  return withUserConfigTransaction({
    mode: 'full',
    runtime,
    execute: loaded => safeSettings(loaded, fs, browserInspector)
  });
}

async function existsWith(io, value) {
  return Boolean(await lstatIfExists(io, value));
}

async function directoryHasMeaningfulContents(directory, io) {
  if (!(await existsWith(io, directory))) return false;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    const entries = await io.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      else return true;
    }
  }
  return false;
}

function moveError(code, message, recovery = null) {
  const error = new Error(message);
  error.code = code;
  if (recovery) error.recovery = recovery;
  return error;
}

function recoveryDetails(source, destination) {
  return {
    required: true,
    oldMirrorDir: source,
    newMirrorDir: destination,
    configRetainedOldLocation: true
  };
}

async function inspectMoveDestination(directory, io) {
  const entry = await lstatIfExists(io, directory);
  if (!entry) return { exists: false };
  if (entry.isSymbolicLink()) {
    throw moveError('destination-reparse-point', 'The selected destination is a filesystem link or junction and will not be removed or overwritten.');
  }
  const stat = await io.stat(directory);
  if (!stat.isDirectory() || (await io.readdir(directory)).length !== 0) {
    throw moveError('destination-collision', 'The selected mirror folder contains files and will not be overwritten.');
  }
  return { exists: true };
}

async function restoreEmptyDestination(destination, existed, io) {
  if (existed) await io.mkdir(destination, { recursive: true });
}

async function stagedCopyMove(source, destination, { io, destinationExisted }) {
  const token = randomUUID();
  const staging = `${destination}.moving-${token}`;
  const backup = `${source}.moving-${token}`;
  let promoted = false;
  let sourceBackedUp = false;
  try {
    await io.cp(source, staging, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await io.rename(staging, destination);
    promoted = true;
    await io.rename(source, backup);
    sourceBackedUp = true;
  } catch (error) {
    try {
      if (sourceBackedUp) await io.rename(backup, source);
      if (promoted) await io.rm(destination, { recursive: true, force: true });
      await io.rm(staging, { recursive: true, force: true });
      await restoreEmptyDestination(destination, destinationExisted, io);
    } catch {
      throw moveError(
        'mirror-rollback-failed',
        'The mirror move did not complete and automatic rollback also failed. Recoverable files were preserved for manual recovery.',
        recoveryDetails(source, destination)
      );
    }
    throw moveError('mirror-move-failed', `Could not move the existing mirror: ${error.message}`);
  }

  return {
    moved: true,
    async commit() {
      await io.rm(backup, { recursive: true, force: true }).catch(() => {});
    },
    async rollback() {
      if (await existsWith(io, backup)) await io.rename(backup, source);
      if (await existsWith(io, destination)) await io.rm(destination, { recursive: true, force: true });
      await restoreEmptyDestination(destination, destinationExisted, io);
    }
  };
}

async function prepareMirrorMove(source, destination, { io, forceCopy = false }) {
  const sourceEntry = await lstatIfExists(io, source);
  if (!sourceEntry) return { moved: false, async commit() {}, async rollback() {} };
  if (!(await io.stat(source)).isDirectory()) {
    throw moveError('mirror-move-failed', 'The existing mirror is not a directory.');
  }

  const destinationState = await inspectMoveDestination(destination, io);
  if (destinationState.exists) await io.rmdir(destination);
  await io.mkdir(path.dirname(destination), { recursive: true });

  if (!forceCopy) {
    try {
      await io.rename(source, destination);
      return {
        moved: true,
        async commit() {},
        async rollback() {
          if (await existsWith(io, destination)) await io.rename(destination, source);
          await restoreEmptyDestination(destination, destinationState.exists, io);
        }
      };
    } catch (error) {
      if (error?.code !== 'EXDEV') {
        try {
          await restoreEmptyDestination(destination, destinationState.exists, io);
        } catch {
          throw moveError(
            'mirror-rollback-failed',
            'The mirror move did not complete and the original empty destination could not be restored.',
            recoveryDetails(source, destination)
          );
        }
        throw moveError('mirror-move-failed', `Could not move the existing mirror: ${error.message}`);
      }
    }
  }

  return stagedCopyMove(source, destination, {
    io,
    destinationExisted: destinationState.exists
  });
}

async function canonicalPathForField(value, field, io, errors) {
  try {
    const info = await canonicalFilesystemPath(value, io);
    if (info.exists && !info.isDirectory) {
      errors.push(validationError(field, 'directory-required', 'The selected path is an existing file, not a directory.'));
      return null;
    }
    return info;
  } catch {
    errors.push(validationError(field, 'path-unavailable', 'The selected path could not be resolved safely.'));
    return null;
  }
}

async function validateRequest(request, loaded, io, browserInspector) {
  const errors = [];
  if (request?.schemaVersion !== DESKTOP_SETTINGS_SCHEMA_VERSION) {
    errors.push(validationError('schemaVersion', 'unsupported-schema', 'The settings request version is not supported.'));
  }

  let baseUrl = '';
  try { baseUrl = normalizeBrightspaceUrl(request?.baseUrl); }
  catch (error) { errors.push(error); }

  const mirrorValue = String(request?.mirrorDir || '').trim();
  if (!mirrorValue) errors.push(validationError('mirrorDir', 'required', 'Choose a mirror folder.'));
  else if (!path.isAbsolute(mirrorValue)) errors.push(validationError('mirrorDir', 'absolute-path-required', 'Mirror folder must be an absolute path.'));

  const driveEnabled = request?.drive?.enabled === true;
  const driveValue = String(request?.drive?.destination || '').trim();
  if (driveEnabled && !driveValue) errors.push(validationError('drive.destination', 'required', 'Choose a Google Drive destination.'));
  else if (driveValue && !path.isAbsolute(driveValue)) errors.push(validationError('drive.destination', 'absolute-path-required', 'Google Drive destination must be an absolute path.'));

  const mirrorAction = request?.mirrorAction || '';
  if (mirrorAction && !['move', 'use-new'].includes(mirrorAction)) {
    errors.push(validationError('mirrorAction', 'invalid-choice', 'Choose whether to move the existing mirror or use the new folder.'));
  }

  const adapter = institutionAdapterForBaseUrl(baseUrl);
  const automaticLoginEnabled = request?.authentication?.automaticLoginEnabled === true;
  if (automaticLoginEnabled && !adapter) {
    errors.push(validationError('authentication.automaticLoginEnabled', 'unsupported-institution', 'Automatic sign-in is not available for this Brightspace site.'));
  }
  const requestedSchedule = request?.schedule == null
    ? { errors: [], schedule: normalizeScheduleConfig(loaded.config.schedule) }
    : validateScheduleRequest(request.schedule, validationError);
  errors.push(...requestedSchedule.errors);

  const browserRequested = request?.browser != null;
  const browserValue = browserRequested
    ? String(request.browser?.executablePath || '').trim()
    : String(loaded.raw.browserExecutablePath || '').trim();
  if (browserValue && !path.isAbsolute(browserValue)) {
    errors.push(validationError('browser.executablePath', 'absolute-path-required', 'Browser executable must be an absolute path.'));
  }
  let browser = null;
  if (browserRequested && (!browserValue || path.isAbsolute(browserValue))) {
    browser = await browserInspector(browserValue);
    if (!browser?.available) {
      errors.push(validationError(
        'browser.executablePath',
        'browser-unavailable',
        browserValue
          ? 'The selected file is not a compatible Chromium browser.'
          : 'No compatible Chromium browser was found. Retry detection, choose a browser executable, or install Microsoft Edge.'
      ));
    }
  }

  const [appRoot, dataDir, existingMirror] = await Promise.all([
    canonicalFilesystemPath(loaded.paths.appRoot, io),
    canonicalFilesystemPath(loaded.paths.dataDir, io),
    canonicalPathForField(loaded.config.outputDir, 'mirrorDir', io, errors)
  ]);
  const requestedMirror = mirrorValue && path.isAbsolute(mirrorValue)
    ? await canonicalPathForField(mirrorValue, 'mirrorDir', io, errors)
    : null;
  const driveDestination = driveValue && path.isAbsolute(driveValue)
    ? await canonicalPathForField(driveValue, 'drive.destination', io, errors)
    : null;

  if (requestedMirror && (
    canonicalPathsOverlap(requestedMirror.physicalPath, dataDir.physicalPath)
    || canonicalPathsOverlap(requestedMirror.physicalPath, appRoot.physicalPath)
  )) {
    errors.push(validationError('mirrorDir', 'protected-path', 'Mirror folder cannot contain application or private runtime data.'));
  }
  if (driveDestination && (
    canonicalPathsOverlap(driveDestination.physicalPath, dataDir.physicalPath)
    || canonicalPathsOverlap(driveDestination.physicalPath, appRoot.physicalPath)
    || (requestedMirror && canonicalPathsOverlap(driveDestination.physicalPath, requestedMirror.physicalPath))
    || (existingMirror && canonicalPathsOverlap(driveDestination.physicalPath, existingMirror.physicalPath))
  )) {
    errors.push(validationError('drive.destination', 'protected-path', 'Google Drive destination must be separate from the mirror and private runtime data.'));
  }
  if (loaded.paths.mirrorDirOverride && requestedMirror && existingMirror
    && !sameCanonicalPath(requestedMirror.physicalPath, existingMirror.physicalPath)) {
    errors.push(validationError('mirrorDir', 'environment-override-active', 'The mirror folder is controlled by COURSEMIRROR_MIRROR_DIR.'));
  }

  return {
    errors,
    baseUrl,
    mirrorDir: requestedMirror?.physicalPath || '',
    requestedMirrorPath: requestedMirror?.requestedPath || '',
    existingMirrorDir: existingMirror?.physicalPath || '',
    existingMirrorReachedThroughReparsePoint: Boolean(existingMirror?.reachedThroughReparsePoint),
    driveEnabled,
    driveDestination: driveDestination?.physicalPath || '',
    mirrorAction,
    automaticLoginEnabled,
    authenticationRetryRequested: request?.authentication?.retryRequested === true,
    schedule: requestedSchedule.schedule,
    browserRequested,
    browserExecutablePath: browserRequested ? browserValue : loaded.raw.browserExecutablePath || '',
    browser,
    appRoot: appRoot.physicalPath,
    dataDir: dataDir.physicalPath
  };
}

function settingsFailure(code, message, field = 'mirrorDir', recovery = null) {
  return {
    schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
    ok: false,
    errors: [validationError(field, code, message)],
    ...(recovery ? { recovery } : {})
  };
}

export async function saveDesktopSettings(request, {
  runtime = {},
  fileSystem = {},
  forceCopy = false,
  writeConfig,
  browserInspector = inspectChromiumBrowser
} = {}) {
  const io = { ...fs, ...fileSystem };
  const paths = resolveRuntimePaths(runtime);
  const syncLock = await acquireSyncLock(paths.lockDir, { mode: 'settings' });
  if (!syncLock.acquired) {
    return settingsFailure('operation-active', 'Another CourseMirror operation is running. Try again when it finishes.', 'operation');
  }

  try {
    return await withUserConfigTransaction({
      runtime,
      ...(writeConfig ? { writeConfig } : {}),
      async execute(loaded) {
        const normalized = await validateRequest(request, loaded, io, browserInspector);
        if (normalized.errors.length) {
          return { schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION, ok: false, errors: normalized.errors };
        }

        const oldMirror = normalized.existingMirrorDir;
        const mirrorChanged = !loaded.paths.mirrorDirOverride
          && !sameCanonicalPath(oldMirror, normalized.mirrorDir);
        let meaningful = false;
        try {
          meaningful = mirrorChanged && await directoryHasMeaningfulContents(oldMirror, io);
        } catch {
          return settingsFailure('mirror-inspection-failed', 'The existing mirror could not be inspected, so no settings were changed.');
        }

        if (meaningful && (
          canonicalPathsOverlap(oldMirror, normalized.mirrorDir)
          || canonicalPathsOverlap(oldMirror, normalized.dataDir)
          || canonicalPathsOverlap(oldMirror, normalized.appRoot)
        )) {
          return settingsFailure('unsafe-mirror-move', 'The existing mirror overlaps the application, private data, or selected destination and cannot be moved safely.');
        }
        if (meaningful && !normalized.mirrorAction) {
          return {
            schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
            ok: false,
            errors: [validationError('mirrorAction', 'mirror-relocation-choice-required', 'Choose what to do with the existing mirror files.')],
            relocation: { required: true, oldMirrorDir: oldMirror, newMirrorDir: normalized.mirrorDir }
          };
        }

        const moveRequested = meaningful && normalized.mirrorAction === 'move';
        if (moveRequested && normalized.existingMirrorReachedThroughReparsePoint) {
          return settingsFailure(
            'source-reparse-point',
            'The current mirror is reached through a filesystem link or junction and cannot be moved automatically. Choose “Use new location” to leave it untouched.'
          );
        }
        let movement = { moved: false, async commit() {}, async rollback() {} };
        if (moveRequested) {
          try {
            movement = await prepareMirrorMove(oldMirror, normalized.requestedMirrorPath, { io, forceCopy });
          } catch (error) {
            if (error?.code === 'mirror-rollback-failed') {
              return settingsFailure(error.code, error.message, 'mirrorDir', error.recovery || recoveryDetails(oldMirror, normalized.mirrorDir));
            }
            const code = ['destination-collision', 'destination-reparse-point', 'mirror-move-failed'].includes(error?.code)
              ? error.code
              : 'mirror-move-failed';
            return settingsFailure(code, error?.message || 'Could not move the existing mirror.');
          }
        }

        const persistedMirror = loaded.paths.mirrorDirOverride ? loaded.raw.outputDir : normalized.mirrorDir;
        const next = {
          ...loaded.raw,
          configVersion: loaded.raw.configVersion,
          baseUrl: normalized.baseUrl,
          outputDir: persistedMirror,
          browserExecutablePath: normalized.browserExecutablePath,
          drivePublish: {
            ...(loaded.raw.drivePublish || {}),
            enabled: normalized.driveEnabled,
            destination: normalized.driveDestination
          },
          auth: {
            ...(loaded.raw.auth || {}),
            automaticLoginEnabled: normalized.automaticLoginEnabled
          },
          schedule: {
            ...(loaded.raw.schedule || {}),
            ...normalized.schedule
          }
        };

        try {
          await loaded.write(next);
        } catch {
          try {
            await movement.rollback();
          } catch {
            return settingsFailure(
              'mirror-rollback-failed',
              'Settings were not saved, and automatic mirror rollback did not complete. Recoverable files were preserved for manual recovery.',
              'mirrorDir',
              recoveryDetails(oldMirror, normalized.mirrorDir)
            );
          }
          return settingsFailure('settings-save-failed', 'Could not save settings.', 'settings');
        }

        // The atomic config write is the commit boundary. Nothing below this
        // point may roll the filesystem movement back.
        if (normalized.authenticationRetryRequested
          || normalized.automaticLoginEnabled !== Boolean(loaded.config.auth?.automaticLoginEnabled)) {
          await clearAuthAttention(paths.stateDir).catch(() => {});
        }
        await movement.commit().catch(() => {});
        const committedConfig = {
          ...loaded.config,
          baseUrl: normalized.baseUrl,
          outputDir: loaded.paths.mirrorDirOverride ? loaded.config.outputDir : normalized.mirrorDir,
          browserExecutablePath: normalized.browserExecutablePath,
          drivePublish: {
            ...loaded.config.drivePublish,
            enabled: normalized.driveEnabled,
            destination: normalized.driveDestination
          },
          auth: {
            ...loaded.config.auth,
            automaticLoginEnabled: normalized.automaticLoginEnabled
          },
          schedule: normalized.schedule
        };
        return {
          schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
          ok: true,
          settings: await safeSettings(
            { config: committedConfig, paths: loaded.paths, raw: next },
            io,
            normalized.browserRequested ? browserInspector : discoverChromiumBrowserCandidate
          ),
          mirrorMoved: movement.moved
        };
      }
    });
  } finally {
    await syncLock.release();
  }
}
