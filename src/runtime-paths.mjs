import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIRECTORY_NAME = 'CourseStow';
export const LEGACY_APP_DIRECTORY_NAME = 'Brightspace Sync';

export function applicationRoot(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..');
}

export const APP_ROOT = applicationRoot();

function absoluteOverride(value, fallbackRoot) {
  if (!value) return null;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(fallbackRoot, value);
}

export function resolveRuntimePaths({
  appRoot = APP_ROOT,
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir()
} = {}) {
  const normalizedAppRoot = path.resolve(appRoot);
  const userHome = env.USERPROFILE || homeDir;
  const platformDataRoot = platform === 'win32'
    ? (env.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local'))
    : (env.XDG_CONFIG_HOME || path.join(userHome, '.config'));
  const dataDirOverride = absoluteOverride(env.COURSESTOW_DATA_DIR || env.BRIGHTSPACE_SYNC_DATA_DIR, userHome);
  const dataDir = dataDirOverride
    || path.join(platformDataRoot, APP_DIRECTORY_NAME);
  const mirrorDirOverride = absoluteOverride(env.COURSESTOW_MIRROR_DIR || env.BRIGHTSPACE_SYNC_MIRROR_DIR, userHome);
  const defaultMirrorDir = path.join(userHome, 'Documents', APP_DIRECTORY_NAME);

  return {
    appRoot: normalizedAppRoot,
    bundledConfigFile: path.join(normalizedAppRoot, 'config.example.json'),
    legacyConfigFile: path.join(normalizedAppRoot, 'config.json'),
    dataDir,
    legacyDataDir: platform === 'win32' && !dataDirOverride
      ? path.join(platformDataRoot, LEGACY_APP_DIRECTORY_NAME)
      : null,
    dataDirOverrideActive: Boolean(dataDirOverride),
    configFile: path.join(dataDir, 'config.json'),
    profileDir: path.join(dataDir, 'BrowserProfile'),
    stateDir: path.join(dataDir, 'state'),
    logsDir: path.join(dataDir, 'logs'),
    lockDir: path.join(dataDir, 'state'),
    initializationLockFile: path.join(dataDir, 'state', '.coursestow-init.lock'),
    migrationLogFile: path.join(dataDir, 'state', 'runtime-migrations.json'),
    mirrorDirOverride,
    defaultMirrorDir
  };
}

export function applicationEntry(relativePath, paths = resolveRuntimePaths()) {
  return path.join(paths.appRoot, ...String(relativePath).split(/[\\/]+/));
}

export function resolveConfiguredPath(value, { relativeTo, fallback }) {
  if (!value) return path.resolve(fallback);
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(relativeTo, value);
}
