import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, exists, writeJson, writeJsonAtomic } from './utils.mjs';
import { canonicalCourseStowDir } from './courseFolders.mjs';
import { inferCalendarTerm, parseTerm } from './terms.mjs';

export const MIRROR_SCHEMA_VERSION = 2;
export const MIRROR_LAYOUT = 'term-scoped-v2';

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function copyNewerFile(source, target) {
  const sourceStat = await fs.stat(source);
  let shouldCopy = true;
  try {
    const targetStat = await fs.stat(target);
    shouldCopy = sourceStat.mtimeMs > targetStat.mtimeMs + 1;
  } catch {}
  if (!shouldCopy) return;
  await ensureDir(path.dirname(target));
  await fs.copyFile(source, target);
  try { await fs.utimes(target, sourceStat.atime, sourceStat.mtime); } catch {}
}

export async function mergeTree(source, target) {
  await ensureDir(target);
  let entries = [];
  try { entries = await fs.readdir(source, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) await mergeTree(src, dst);
    else await copyNewerFile(src, dst);
  }
}

async function moveOrMerge(source, target) {
  if (!(await exists(source))) return false;
  await ensureDir(path.dirname(target));
  if (!(await exists(target))) {
    try {
      await fs.rename(source, target);
      return true;
    } catch {}
  }
  await mergeTree(source, target);
  await fs.rm(source, { recursive: true, force: true });
  return true;
}

function legacyCourseFolderId(name = '') {
  return String(name).match(/\[(\d+)\]$/)?.[1] || null;
}

async function migrationLog(systemDir, event) {
  const file = path.join(systemDir, 'migrations.json');
  const existing = await readJson(file, { migrations: [] });
  const migrations = Array.isArray(existing?.migrations) ? existing.migrations : [];
  migrations.push(event);
  await writeJson(file, { migrations: migrations.slice(-200) });
}

async function migrateRootCourseFolders(outputDir, config, actions) {
  let entries = [];
  try { entries = await fs.readdir(outputDir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const id = legacyCourseFolderId(entry.name);
    if (!id) continue;

    const source = path.join(outputDir, entry.name);
    const meta = await readJson(path.join(source, '_course.json'), {});
    const name = meta?.name || entry.name.replace(/\s*\[\d+\]$/, '');
    const term = meta?.term?.key ? meta.term : (parseTerm(name) || parseTerm(config.currentTerm) || inferCalendarTerm());
    const termKey = term?.key || 'Unclassified';
    const course = { id: String(meta?.id || id), name };
    const canonical = canonicalCourseStowDir(course);
    const target = path.join(outputDir, termKey, canonical);
    await moveOrMerge(source, target);
    actions.push({ action: 'move-course-to-term', courseId: String(id), from: entry.name, to: `${termKey}/${canonical}`, term: term?.label || null });
  }
}

export async function ensureMirrorLayout(config, appVersion = '1.7.0') {
  const outputDir = config.outputDir;
  const systemDir = path.join(outputDir, '_system');
  const stateDir = config.stateDir || systemDir;
  const schemaFile = path.join(systemDir, 'schema.json');
  const oldSchema = await readJson(schemaFile, null);
  const firstV2Migration = !oldSchema || Number(oldSchema.schemaVersion || 0) < MIRROR_SCHEMA_VERSION;
  const actions = [];

  await ensureDir(outputDir);
  await ensureDir(systemDir);
  await ensureDir(stateDir);

  const legacyGlobalState = path.join(systemDir, 'state.json');
  const runtimeGlobalState = path.join(stateDir, 'state.json');
  if (stateDir !== systemDir && await exists(legacyGlobalState) && !(await exists(runtimeGlobalState))) {
    await writeJsonAtomic(runtimeGlobalState, await readJson(legacyGlobalState, {}));
    actions.push({ action: 'copy-global-state-to-user-data' });
  }

  if (firstV2Migration) {
    const legacyDir = path.join(systemDir, 'legacy-v1');
    await ensureDir(legacyDir);

    // Preserve the old global project files before _school becomes the v2 index.
    if (await exists(path.join(outputDir, '_school'))) {
      await moveOrMerge(path.join(outputDir, '_school'), path.join(legacyDir, '_school'));
      actions.push({ action: 'archive-legacy-school-view', to: '_system/legacy-v1/_school' });
    }

    for (const name of ['_sync_state.json', '_manifest.json']) {
      const source = path.join(outputDir, name);
      if (await exists(source)) {
        if (name === '_sync_state.json') {
          const legacyState = await readJson(source, {});
          const stateFile = path.join(stateDir, 'state.json');
          if (!(await exists(stateFile))) {
            await writeJsonAtomic(stateFile, { ...legacyState, schemaVersion: MIRROR_SCHEMA_VERSION, migratedFromLegacyState: true });
          }
        }
        await moveOrMerge(source, path.join(legacyDir, name));
        actions.push({ action: 'archive-legacy-file', file: name, to: `_system/legacy-v1/${name}` });
      }
    }
  }

  // These migrations are safe/idempotent and also repair a partially migrated
  // mirror if a run was interrupted midway through a move.
  await migrateRootCourseFolders(outputDir, config, actions);

  if (await exists(path.join(outputDir, '_changes'))) {
    await moveOrMerge(path.join(outputDir, '_changes'), path.join(systemDir, 'changes'));
    actions.push({ action: 'move-global-changes', to: '_system/changes' });
  }
  if (await exists(path.join(outputDir, '_BrightspaceHome'))) {
    await moveOrMerge(path.join(outputDir, '_BrightspaceHome'), path.join(systemDir, 'debug', 'BrightspaceHome'));
    actions.push({ action: 'move-home-diagnostics', to: '_system/debug/BrightspaceHome' });
  }

  await ensureDir(path.join(systemDir, 'changes'));
  await ensureDir(path.join(systemDir, 'debug', 'BrightspaceHome'));
  await ensureDir(path.join(outputDir, '_school'));

  const nowIso = new Date().toISOString();
  const schemaIdentityChanged = !oldSchema
    || Number(oldSchema.schemaVersion || 0) !== MIRROR_SCHEMA_VERSION
    || oldSchema.layout !== MIRROR_LAYOUT
    || oldSchema.paths?.runtimeState !== 'outside-mirror'
    || oldSchema.appVersion !== appVersion;
  const schema = {
    schemaVersion: MIRROR_SCHEMA_VERSION,
    layout: MIRROR_LAYOUT,
    appVersion,
    createdAt: oldSchema?.createdAt || nowIso,
    updatedAt: schemaIdentityChanged ? nowIso : (oldSchema?.updatedAt || oldSchema?.createdAt || nowIso),
    paths: {
      system: '_system',
      changes: '_system/changes',
      runtimeState: 'outside-mirror',
      school: '_school',
      termPattern: 'YYYY-Season',
      coursePattern: '<stable course name> [orgUnitId]'
    }
  };
  await writeJson(schemaFile, schema);

  if (actions.length) {
    await migrationLog(systemDir, {
      at: new Date().toISOString(),
      fromSchemaVersion: Number(oldSchema?.schemaVersion || 1),
      toSchemaVersion: MIRROR_SCHEMA_VERSION,
      actions
    });
  }

  return {
    schema,
    actions,
    systemDir,
    stateDir,
    changesDir: path.join(systemDir, 'changes'),
    homeSnapshotDir: path.join(systemDir, 'debug', 'BrightspaceHome')
  };
}
