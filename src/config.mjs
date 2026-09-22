import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, exists, writeJsonAtomic } from './utils.mjs';
import { resolveConfiguredPath, resolveRuntimePaths } from './runtime-paths.mjs';
import { acquireInitializationLock, initializationLockError } from './init-lock.mjs';
import { normalizeBrightspaceBaseUrl } from './brightspace-url.mjs';
import { normalizeScheduleConfig } from './schedule-config.mjs';
import { migrateLegacyProductRuntime } from './product-migration.mjs';

export const CURRENT_CONFIG_VERSION = 1;

const CONFIG_MIGRATIONS = new Map([
  [0, raw => ({ ...raw, configVersion: 1 })]
]);

async function readConfigJson(file, label) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Could not read ${label} at ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} at ${file}: ${error.message}`);
  }
}

async function copyJsonIfMissing(source, target) {
  if (!(await exists(source)) || await exists(target)) return false;
  const value = await readConfigJson(source, 'legacy runtime state');
  await writeJsonAtomic(target, value);
  return true;
}

export async function copyDirectoryTransactionalIfMissing(source, target, {
  copy = (from, to) => fs.cp(from, to, { recursive: true, errorOnExist: true, force: false }),
  replaceUnverifiedTarget = false
} = {}) {
  const staging = `${target}.migrating`;
  const backup = `${target}.incomplete`;
  const sourceExists = await exists(source);
  if (await exists(target)) {
    if (replaceUnverifiedTarget && sourceExists) {
      await fs.rm(staging, { recursive: true, force: true });
      await fs.rm(backup, { recursive: true, force: true });
      await fs.rename(target, backup);
    } else {
      await fs.rm(staging, { recursive: true, force: true });
      await fs.rm(backup, { recursive: true, force: true });
      return false;
    }
  }
  if (!sourceExists) {
    await fs.rm(staging, { recursive: true, force: true });
    return false;
  }
  await ensureDir(path.dirname(target));
  await fs.rm(staging, { recursive: true, force: true });

  try {
    await copy(source, staging);
    await fs.rename(staging, target);
    await fs.rm(backup, { recursive: true, force: true });
    return true;
  } catch (error) {
    // A concurrent successful migration wins. The staging directory is safe to
    // discard because transactional copies never write into the final target.
    if (await exists(target)) {
      await fs.rm(staging, { recursive: true, force: true });
      await fs.rm(backup, { recursive: true, force: true });
      return false;
    }
    // Keep an incomplete staging directory for diagnosis. The next attempt
    // removes it before starting a fresh copy.
    throw error;
  }
}

function adaptLegacyConfig(raw, paths) {
  const next = { ...raw };
  if (next.outputDir) {
    next.outputDir = resolveConfiguredPath(next.outputDir, {
      relativeTo: paths.appRoot,
      fallback: paths.defaultMirrorDir
    });
  }
  if (next.browserExecutablePath && !path.isAbsolute(next.browserExecutablePath)) {
    next.browserExecutablePath = path.resolve(paths.appRoot, next.browserExecutablePath);
  }
  if (next.drivePublish?.destination && !path.isAbsolute(next.drivePublish.destination)) {
    next.drivePublish = {
      ...next.drivePublish,
      destination: path.resolve(paths.appRoot, next.drivePublish.destination)
    };
  }
  next.drivePublish = {
    ...(next.drivePublish || {}),
    enabled: next.drivePublish?.enabled ?? false
  };
  return next;
}

async function recordRuntimeMigrations(paths, actions) {
  if (!actions.length) return;
  const prior = await exists(paths.migrationLogFile)
    ? await readConfigJson(paths.migrationLogFile, 'runtime migration log')
    : { migrations: [] };
  const migrations = Array.isArray(prior?.migrations) ? prior.migrations : [];
  migrations.push({ at: new Date().toISOString(), actions });
  await writeJsonAtomic(paths.migrationLogFile, { migrations: migrations.slice(-50) });
}

function parsedConfigVersion(raw, file) {
  if (!Object.hasOwn(raw, 'configVersion')) return 0;
  const version = raw.configVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error(`Invalid configVersion in ${file}: expected a non-negative integer, received ${JSON.stringify(raw.configVersion)}.`);
  }
  if (version > CURRENT_CONFIG_VERSION) {
    throw new Error(
      `Configuration version ${version} in ${file} is newer than this application supports (${CURRENT_CONFIG_VERSION}). Upgrade CourseStow before using this configuration.`
    );
  }
  return version;
}

async function migrateConfigToCurrent(raw, paths, actions) {
  let next = raw;
  let version = parsedConfigVersion(next, paths.configFile);
  while (version < CURRENT_CONFIG_VERSION) {
    const migration = CONFIG_MIGRATIONS.get(version);
    if (!migration) throw new Error(`No configuration migration is available from version ${version}.`);
    const fromVersion = version;
    next = migration(next);
    version = parsedConfigVersion(next, paths.configFile);
    if (version <= fromVersion) throw new Error(`Configuration migration from version ${fromVersion} did not advance the schema version.`);
    actions.push({ action: 'migrate-config-version', fromVersion, toVersion: version, file: paths.configFile });
  }
  if (next !== raw) await writeJsonAtomic(paths.configFile, next);
  return next;
}

async function prepareUserConfig(paths, actions) {
  await ensureDir(paths.dataDir);
  await ensureDir(paths.stateDir);
  await ensureDir(paths.logsDir);

  if (await exists(paths.configFile)) return readConfigJson(paths.configFile, 'user configuration');

  if (await exists(paths.legacyConfigFile)) {
    const legacy = await readConfigJson(paths.legacyConfigFile, 'legacy configuration');
    parsedConfigVersion(legacy, paths.legacyConfigFile);
    const migrated = adaptLegacyConfig(legacy, paths);
    await writeJsonAtomic(paths.configFile, migrated);
    actions.push({ action: 'copy-legacy-config', from: paths.legacyConfigFile, to: paths.configFile });
    return migrated;
  }

  const example = await readConfigJson(paths.bundledConfigFile, 'bundled example configuration');
  const initial = { ...example, configVersion: CURRENT_CONFIG_VERSION, baseUrl: '' };
  delete initial.profileDir;
  initial.drivePublish = {
    ...(initial.drivePublish || {}),
    enabled: false
  };
  await writeJsonAtomic(paths.configFile, initial);
  actions.push({ action: 'create-user-config', from: paths.bundledConfigFile, to: paths.configFile });
  return initial;
}

async function migrateLegacyProfile(raw, paths, actions) {
  const replaceUnverifiedTarget = Boolean(raw.profileDir);
  const configuredLegacyProfile = raw.profileDir
    ? resolveConfiguredPath(raw.profileDir, { relativeTo: paths.appRoot, fallback: path.join(paths.appRoot, '.brightspace-profile') })
    : null;
  const candidates = [configuredLegacyProfile, path.join(paths.appRoot, '.brightspace-profile')]
    .filter((value, index, all) => value && all.indexOf(value) === index);

  for (const source of candidates) {
    if (await copyDirectoryTransactionalIfMissing(source, paths.profileDir, { replaceUnverifiedTarget })) {
      actions.push({ action: 'copy-legacy-browser-profile', from: source, to: paths.profileDir });
      break;
    }
  }
  await ensureDir(paths.profileDir);
}

async function removeDeprecatedProfileSetting(raw, paths, actions) {
  if (!Object.hasOwn(raw, 'profileDir')) return raw;
  const next = { ...raw };
  delete next.profileDir;
  await writeJsonAtomic(paths.configFile, next);
  actions.push({ action: 'remove-deprecated-profile-setting', file: paths.configFile });
  return next;
}

async function migrateLegacyState(outputDir, paths, actions) {
  const candidates = [
    [path.join(outputDir, '_system', 'state.json'), path.join(paths.stateDir, 'state.json')],
    [path.join(outputDir, '_system', 'drive_publish_state.json'), path.join(paths.stateDir, 'drive_publish_state.json')],
    [path.join(outputDir, '_sync_state.json'), path.join(paths.stateDir, 'state.json')]
  ];
  for (const [source, target] of candidates) {
    if (await copyJsonIfMissing(source, target)) {
      actions.push({ action: 'copy-legacy-runtime-state', from: source, to: target });
    }
  }
}

export async function loadAppConfigUnderLock({ mode, paths, initialActions = [] }) {
  const actions = [...initialActions];
  let raw = await prepareUserConfig(paths, actions);
  raw = await migrateConfigToCurrent(raw, paths, actions);

  // profileDir was part of pre-installer config. It is used only as a migration
  // source; current versions always keep the authenticated profile in user data.
  await migrateLegacyProfile(raw, paths, actions);
  raw = await removeDeprecatedProfileSetting(raw, paths, actions);

  const outputDir = paths.mirrorDirOverride || resolveConfiguredPath(raw.outputDir, {
    relativeTo: paths.dataDir,
    fallback: paths.defaultMirrorDir
  });
  await migrateLegacyState(outputDir, paths, actions);
  await recordRuntimeMigrations(paths, actions);

  const config = {
    ...raw,
    syncMode: mode,
    incrementalSync: raw.incrementalSync ?? true,
    captureNetwork: raw.captureNetwork ?? false,
    writeChangeLog: raw.writeChangeLog ?? true,
    writeUpdateDiagnostics: raw.writeUpdateDiagnostics ?? true,
    activeTerms: Array.isArray(raw.activeTerms) ? raw.activeTerms : [],
    includeUpcomingTermDays: Number(raw.includeUpcomingTermDays ?? 21),
    quickSections: Array.isArray(raw.quickSections) ? raw.quickSections : ['assignments', 'quizzes', 'grades', 'calendar', 'announcements'],
    quickDetailSections: Array.isArray(raw.quickDetailSections) ? raw.quickDetailSections : ['announcements'],
    quickAssetDownloadSections: Array.isArray(raw.quickAssetDownloadSections) ? raw.quickAssetDownloadSections : ['announcements'],
    dynamicWaitMs: mode === 'quick' ? Number(raw.quickDynamicWaitMs ?? 1200) : Number(raw.dynamicWaitMs ?? 2200),
    auth: {
      autoSubmitSavedBrowserCredentials: raw.auth?.autoSubmitSavedBrowserCredentials ?? true,
      automaticLoginEnabled: raw.auth?.automaticLoginEnabled === true,
      manualLoginTimeoutMs: Number(raw.auth?.manualLoginTimeoutMs ?? 10 * 60 * 1000)
    },
    schedule: normalizeScheduleConfig(raw.schedule),
    drivePublish: {
      enabled: raw.drivePublish?.enabled ?? false,
      destination: raw.drivePublish?.destination
        ? resolveConfiguredPath(raw.drivePublish.destination, { relativeTo: paths.dataDir, fallback: '' })
        : '',
      deleteRemoved: raw.drivePublish?.deleteRemoved ?? true,
      verifyDestinationOnFull: raw.drivePublish?.verifyDestinationOnFull ?? true,
      retryAttempts: Number(raw.drivePublish?.retryAttempts ?? 4),
      retryDelayMs: Number(raw.drivePublish?.retryDelayMs ?? 700)
    },
    assetPolicy: {
      downloadDocuments: true,
      downloadImages: true,
      downloadTranscripts: true,
      downloadArchives: true,
      downloadVideo: false,
      downloadAudio: false,
      maxDownloadBytes: 25 * 1024 * 1024,
      indexExternalAssets: true,
      ...(raw.assetPolicy || {})
    },
    // Runtime consumers only receive a safe, normalized URL. The raw value is
    // deliberately left untouched so read-only inspection does not rewrite a
    // legacy configuration.
    baseUrl: normalizeBrightspaceBaseUrl(raw.baseUrl),
    browserExecutablePath: raw.browserExecutablePath
      ? resolveConfiguredPath(raw.browserExecutablePath, { relativeTo: paths.dataDir, fallback: '' })
      : '',
    outputDir,
    profileDir: paths.profileDir,
    stateDir: paths.stateDir,
    logsDir: paths.logsDir,
    configFile: paths.configFile,
    appRoot: paths.appRoot
  };

  return { config, paths, migrations: actions };
}

export async function loadAppConfig({ mode = 'full', runtime = {}, initializationLock = {} } = {}) {
  const paths = resolveRuntimePaths(runtime);
  const productMigration = await migrateLegacyProductRuntime(paths);
  const lock = await acquireInitializationLock(paths, initializationLock);
  if (!lock.acquired) throw initializationLockError(lock);
  try {
    return await loadAppConfigUnderLock({
      mode,
      paths,
      initialActions: productMigration.action ? [productMigration.action] : []
    });
  } finally {
    await lock.release();
  }
}

export async function withUserConfigTransaction({ mode = 'full', runtime = {}, initializationLock = {}, writeConfig = writeJsonAtomic, execute }) {
  if (typeof execute !== 'function') throw new Error('A configuration transaction callback is required.');
  const paths = resolveRuntimePaths(runtime);
  const productMigration = await migrateLegacyProductRuntime(paths);
  const lock = await acquireInitializationLock(paths, initializationLock);
  if (!lock.acquired) throw initializationLockError(lock);
  try {
    const loaded = await loadAppConfigUnderLock({
      mode,
      paths,
      initialActions: productMigration.action ? [productMigration.action] : []
    });
    const raw = await readConfigJson(paths.configFile, 'user configuration');
    return await execute({
      ...loaded,
      raw,
      async write(next) {
        parsedConfigVersion(next, paths.configFile);
        return writeConfig(paths.configFile, next);
      }
    });
  } finally {
    await lock.release();
  }
}
