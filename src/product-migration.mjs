import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

export const PRODUCT_RUNTIME_MIGRATION_MARKER = 'product-identity-migration.json';
const LEGACY_PRODUCT_NAME = 'Brightspace Sync';
const CURRENT_PRODUCT_NAME = 'CourseStow';

export class ProductRuntimeMigrationConflictError extends Error {
  constructor(legacyDataDir, dataDir) {
    super(`CourseStow found existing private data in both ${legacyDataDir} and ${dataDir}. Automatic migration stopped; manual review is required.`);
    this.name = 'ProductRuntimeMigrationConflictError';
    this.code = 'product-runtime-migration-conflict';
    this.legacyDataDir = legacyDataDir;
    this.dataDir = dataDir;
  }
}

async function directoryHasMeaningfulData(directory, io = fs) {
  let entries;
  try {
    entries = await io.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(`${CURRENT_PRODUCT_NAME}.migrating-`)) continue;
    if (!entry.isDirectory()) return true;
    if (await directoryHasMeaningfulData(path.join(directory, entry.name), io)) return true;
  }
  return false;
}

async function pathExists(value, io = fs) {
  try {
    await io.access(value);
    return true;
  } catch {
    return false;
  }
}

async function hasCompletedMarker(dataDir, io = fs) {
  try {
    const raw = JSON.parse(await io.readFile(path.join(dataDir, 'state', PRODUCT_RUNTIME_MIGRATION_MARKER), 'utf8'));
    return raw?.schemaVersion === 1
      && raw?.fromProduct === LEGACY_PRODUCT_NAME
      && raw?.toProduct === CURRENT_PRODUCT_NAME;
  } catch {
    return false;
  }
}

async function normalizeCopiedConfig(stagingDir, legacyDataDir, io = fs) {
  const configFile = path.join(stagingDir, 'config.json');
  let raw;
  try {
    raw = JSON.parse(await io.readFile(configFile, 'utf8'));
  } catch {
    return;
  }
  let changed = false;
  const absoluteLegacyPath = value => {
    if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value)) return value;
    changed = true;
    return path.resolve(legacyDataDir, value);
  };
  raw.outputDir = absoluteLegacyPath(raw.outputDir);
  raw.browserExecutablePath = absoluteLegacyPath(raw.browserExecutablePath);
  if (raw.drivePublish?.destination) {
    raw.drivePublish = {
      ...raw.drivePublish,
      destination: absoluteLegacyPath(raw.drivePublish.destination)
    };
  }
  if (changed) await io.writeFile(configFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

async function removeEmptyTree(directory, io = fs) {
  let entries;
  try {
    entries = await io.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Destination data directory became non-empty during migration.');
    await removeEmptyTree(path.join(directory, entry.name), io);
  }
  await io.rmdir(directory);
}

export async function migrateLegacyProductRuntime(paths, {
  io = fs,
  copy = (source, destination) => io.cp(source, destination, { recursive: true, errorOnExist: true, force: false }),
  now = () => new Date()
} = {}) {
  const legacyDataDir = paths.legacyDataDir;
  const dataDir = paths.dataDir;
  if (!legacyDataDir || path.resolve(legacyDataDir) === path.resolve(dataDir)) return { migrated: false, reason: 'not-applicable' };
  if (!(await pathExists(legacyDataDir, io)) || !(await directoryHasMeaningfulData(legacyDataDir, io))) {
    return { migrated: false, reason: 'legacy-empty' };
  }
  if (await hasCompletedMarker(dataDir, io)) return { migrated: false, reason: 'already-migrated' };
  if (await pathExists(dataDir, io) && await directoryHasMeaningfulData(dataDir, io)) {
    throw new ProductRuntimeMigrationConflictError(legacyDataDir, dataDir);
  }

  const parent = path.dirname(dataDir);
  const staging = path.join(parent, `${CURRENT_PRODUCT_NAME}.migrating-${process.pid}-${randomUUID()}`);
  await io.mkdir(parent, { recursive: true });
  try {
    await copy(legacyDataDir, staging);
    await normalizeCopiedConfig(staging, legacyDataDir, io);
    const markerDir = path.join(staging, 'state');
    await io.mkdir(markerDir, { recursive: true });
    await io.writeFile(path.join(markerDir, PRODUCT_RUNTIME_MIGRATION_MARKER), `${JSON.stringify({
      schemaVersion: 1,
      fromProduct: LEGACY_PRODUCT_NAME,
      toProduct: CURRENT_PRODUCT_NAME,
      completedAt: now().toISOString()
    }, null, 2)}\n`, 'utf8');

    if (await pathExists(dataDir, io)) await removeEmptyTree(dataDir, io);
    try {
      await io.rename(staging, dataDir);
    } catch (error) {
      if (await hasCompletedMarker(dataDir, io)) {
        await io.rm(staging, { recursive: true, force: true });
        return { migrated: false, reason: 'concurrent-migration-won' };
      }
      if (await pathExists(dataDir, io) && await directoryHasMeaningfulData(dataDir, io)) {
        throw new ProductRuntimeMigrationConflictError(legacyDataDir, dataDir);
      }
      throw error;
    }
    return {
      migrated: true,
      action: { action: 'migrate-product-runtime-root', from: legacyDataDir, to: dataDir }
    };
  } catch (error) {
    await io.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
