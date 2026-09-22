import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, writeJson, writeJsonAtomic } from './utils.mjs';
import { parseTermKey } from './terms.mjs';

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function readText(file, maxChars = 18000) {
  try {
    const value = await fs.readFile(file, 'utf8');
    return value.length > maxChars ? `${value.slice(0, maxChars)}\n... [truncated in status index]` : value;
  } catch { return ''; }
}

async function listFilesRecursive(dir) {
  const out = [];
  async function walk(current) {
    let entries = [];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(dir);
  return out;
}

function summarizeChanges(changes) {
  return {
    total: changes.length,
    added: changes.filter(x => x.action === 'added').length,
    updated: changes.filter(x => x.action === 'updated').length
  };
}

async function summarizeAssets(courseDir) {
  const files = await listFilesRecursive(courseDir);
  const manifests = files.filter(file => /(?:^|[\\/])assets\.json$/i.test(file) || /\.assets\.json$/i.test(file));
  const seen = new Map();
  for (const file of manifests) {
    const assets = await readJson(file, []);
    if (!Array.isArray(assets)) continue;
    for (const asset of assets) {
      if (!asset?.url) continue;
      const key = asset.url;
      const prior = seen.get(key);
      if (!prior || (!prior.downloaded && asset.downloaded)) seen.set(key, asset);
    }
  }
  const items = [...seen.values()];
  const byKind = {};
  for (const item of items) byKind[item.kind || 'other'] = (byKind[item.kind || 'other'] || 0) + 1;
  return {
    total: items.length,
    downloaded: items.filter(x => x.downloaded).length,
    indexedOnly: items.filter(x => !x.downloaded).length,
    byKind,
    media: items.filter(x => ['video', 'audio'].includes(x.kind)).slice(0, 100).map(x => ({
      name: x.name || '', kind: x.kind, url: x.url, contentType: x.contentType || '',
      downloaded: Boolean(x.downloaded), skipReason: x.skipReason || null
    })),
    transcripts: items.filter(x => x.kind === 'transcript').slice(0, 100).map(x => ({
      name: x.name || '', url: x.url, downloaded: Boolean(x.downloaded), localFile: x.localFile || null
    }))
  };
}

async function sectionStatus(courseDir, section) {
  const dir = path.join(courseDir, section);
  const overviewText = await readText(path.join(dir, 'page.txt'));
  const pageJson = await readJson(path.join(dir, 'page.json'), {});
  const detailIndex = await readJson(path.join(dir, 'Details', '_index.json'), []);
  const assets = await readJson(path.join(dir, 'assets.json'), []);
  return {
    overviewText,
    page: pageJson,
    details: Array.isArray(detailIndex) ? detailIndex.map(x => ({
      key: x.key, label: x.label, finalUrl: x.finalUrl, status: x.status,
      title: x.title, textPreview: x.textPreview
    })) : [],
    assets: Array.isArray(assets) ? assets : []
  };
}

async function contentStatus(courseDir) {
  const dir = path.join(courseDir, 'Content');
  const index = await readJson(path.join(dir, '_index.json'), []);
  const modules = await readJson(path.join(dir, '_modules.json'), []);
  return {
    pages: Array.isArray(index) ? index.length : 0,
    modules: Array.isArray(modules) ? modules.length : 0,
    recentPages: Array.isArray(index) ? index.slice(-20).map(x => ({
      pageKey: x.pageKey, title: x.title, finalUrl: x.finalUrl,
      textPreview: x.textPreview, assets: x.assets, downloads: x.downloads
    })) : []
  };
}

async function updateCourseSyncState(config, course, mode, completedAt, term) {
  const courseStateDir = path.join(config.stateDir || config.systemDir || path.join(config.outputDir, '_system'), 'courses');
  const file = path.join(courseStateDir, `${String(course.id).replace(/[^a-z0-9_-]/gi, '_')}.json`);
  const legacyFile = path.join(course.courseDir, '_sync_state.json');
  const state = await readJson(file, await readJson(legacyFile, {}));
  const next = {
    ...state,
    lastSuccessfulSync: completedAt,
    lastSyncMode: mode,
    term: term || state.term || null,
    ...(mode === 'quick' ? { lastQuickSync: completedAt } : { lastFullSync: completedAt })
  };
  await writeJsonAtomic(file, next);
  return next;
}

function relativeMirrorPath(...parts) {
  return parts.filter(Boolean).join('/').replace(/\\/g, '/');
}


async function scanTermCourseMetadata(config) {
  const found = [];
  let termEntries = [];
  try { termEntries = await fs.readdir(config.outputDir, { withFileTypes: true }); } catch { return found; }
  for (const termEntry of termEntries) {
    if (!termEntry.isDirectory() || (!/^\d{4}-(?:Winter|Spring|Summer|Fall)$/i.test(termEntry.name) && termEntry.name !== 'Unclassified')) continue;
    const termDir = path.join(config.outputDir, termEntry.name);
    let courseEntries = [];
    try { courseEntries = await fs.readdir(termDir, { withFileTypes: true }); } catch { continue; }
    for (const courseEntry of courseEntries) {
      if (!courseEntry.isDirectory()) continue;
      const id = courseEntry.name.match(/\[(\d+)\]$/)?.[1];
      if (!id) continue;
      const courseDir = path.join(termDir, courseEntry.name);
      const meta = await readJson(path.join(courseDir, '_course.json'), {});
      found.push({
        id: String(meta?.id || id),
        name: meta?.name || courseEntry.name.replace(/\s*\[\d+\]$/, ''),
        term: meta?.term || (termEntry.name === 'Unclassified' ? { season: 'Unknown', year: null, label: 'Unclassified', key: 'Unclassified' } : parseTermKey(termEntry.name)),
        homeUrl: meta?.homeUrl || null,
        mirrorPath: meta?.mirrorPath || relativeMirrorPath(termEntry.name, courseEntry.name),
        courseStatusFile: relativeMirrorPath(termEntry.name, courseEntry.name, '_course_status.json'),
        latestChangesFile: relativeMirrorPath(termEntry.name, courseEntry.name, '_latest_changes.json')
      });
    }
  }
  return found;
}

async function updateCourseRegistry(config, manifest, completedAt) {
  const schoolDir = path.join(config.outputDir, '_school');
  const file = path.join(schoolDir, 'all_courses.json');
  const previous = await readJson(file, { courses: [] });
  const map = new Map((previous?.courses || []).map(c => [String(c.id), c]));
  const activeTermKeys = new Set((manifest.activeTerms || []).map(t => t.key));

  // Rebuild missing registry entries from the persistent term archive itself.
  // This matters on the first v2 migration: historical course folders may
  // already exist even though v1 never had an all_courses.json registry.
  for (const archived of await scanTermCourseMetadata(config)) {
    const prior = map.get(String(archived.id)) || {};
    map.set(String(archived.id), {
      ...prior,
      ...archived,
      firstSeenAt: prior.firstSeenAt || null,
      lastSeenAt: prior.lastSeenAt || null,
      active: false,
      archived: !activeTermKeys.has(archived.term?.key)
    });
  }

  for (const course of manifest.courses) {
    const id = String(course.id);
    const prior = map.get(id) || {};
    map.set(id, {
      ...prior,
      id,
      name: course.name,
      term: course.term,
      homeUrl: course.homeUrl,
      mirrorPath: course.mirrorPath,
      courseStatusFile: relativeMirrorPath(course.mirrorPath, '_course_status.json'),
      latestChangesFile: relativeMirrorPath(course.mirrorPath, '_latest_changes.json'),
      firstSeenAt: prior.firstSeenAt || completedAt,
      lastSeenAt: completedAt,
      active: true,
      archived: false
    });
  }

  for (const [id, course] of map) {
    if (!manifest.courses.some(c => String(c.id) === id)) {
      const isActiveTerm = course?.term?.key && activeTermKeys.has(course.term.key);
      map.set(id, { ...course, active: false, archived: !isActiveTerm });
    }
  }

  const courses = [...map.values()].sort((a, b) => {
    const ak = `${a.term?.key || 'zzzz'}|${a.name || ''}`;
    const bk = `${b.term?.key || 'zzzz'}|${b.name || ''}`;
    return ak.localeCompare(bk);
  });
  const registry = { generatedAt: completedAt, courses };
  await writeJson(file, registry);
  return registry;
}

export async function writeProjectViews(config, manifest, changes, mode, completedAt) {
  const schoolDir = path.join(config.outputDir, '_school');
  const systemDir = config.systemDir || path.join(config.outputDir, '_system');
  const stateDir = config.stateDir || systemDir;
  await ensureDir(schoolDir);
  await ensureDir(systemDir);
  await ensureDir(stateDir);
  const courseStatuses = [];

  for (const course of manifest.courses) {
    const courseDir = course.courseDir;
    const courseChanges = changes.filter(x => String(x.courseId || '') === String(course.id));
    const syncState = await updateCourseSyncState(config, course, mode, completedAt, course.term);

    const latestChanges = {
      generatedAt: completedAt,
      syncMode: mode,
      courseId: course.id,
      course: course.name,
      term: course.term,
      summary: summarizeChanges(courseChanges),
      changes: courseChanges
    };
    await writeJson(path.join(courseDir, '_latest_changes.json'), latestChanges);

    const [assignments, quizzes, grades, calendar, announcements, discussions, content, assets] = await Promise.all([
      sectionStatus(courseDir, 'assignments'), sectionStatus(courseDir, 'quizzes'),
      sectionStatus(courseDir, 'grades'), sectionStatus(courseDir, 'calendar'),
      sectionStatus(courseDir, 'announcements'), sectionStatus(courseDir, 'discussions'),
      contentStatus(courseDir), summarizeAssets(courseDir)
    ]);

    const status = {
      generatedAt: completedAt,
      course: {
        id: course.id,
        name: course.name,
        homeUrl: course.homeUrl,
        term: course.term,
        mirrorDir: course.mirrorDir,
        mirrorPath: course.mirrorPath
      },
      sync: syncState,
      latestChanges: latestChanges.summary,
      assignments: {
        items: assignments.page?.assignments || [], overviewText: assignments.overviewText,
        detailPages: assignments.details
      },
      quizzes: { overviewText: quizzes.overviewText, detailPages: quizzes.details },
      announcements: { overviewText: announcements.overviewText, items: announcements.details },
      grades: { overviewText: grades.overviewText },
      calendar: {
        overviewText: calendar.overviewText, events: calendar.page?.events || [], detailPages: calendar.details
      },
      discussions: { overviewText: discussions.overviewText, topics: discussions.details },
      content,
      assets
    };
    await writeJson(path.join(courseDir, '_course_status.json'), status);
    courseStatuses.push({
      id: course.id,
      name: course.name,
      term: course.term,
      mirrorDir: course.mirrorDir,
      mirrorPath: course.mirrorPath,
      sync: syncState,
      latestChanges: latestChanges.summary,
      content: { pages: content.pages, modules: content.modules },
      assets: { total: assets.total, downloaded: assets.downloaded, indexedOnly: assets.indexedOnly, byKind: assets.byKind }
    });
  }

  const globalStateFile = path.join(stateDir, 'state.json');
  const globalState = await readJson(globalStateFile, {});
  const nextGlobalState = {
    ...globalState,
    schemaVersion: manifest.schemaVersion,
    lastSuccessfulSync: completedAt,
    lastSyncMode: mode,
    ...(mode === 'quick' ? { lastQuickSync: completedAt } : { lastFullSync: completedAt }),
    activeTerms: manifest.activeTerms || [],
    discoveredTerms: manifest.discoveredTerms || [],
    discoveredCourses: manifest.discoveredCourses || manifest.courses.length,
    syncedCourses: manifest.courses.length
  };
  await writeJsonAtomic(globalStateFile, nextGlobalState);

  const globalLatest = {
    generatedAt: completedAt,
    syncMode: mode,
    activeTerms: manifest.activeTerms || [],
    summary: summarizeChanges(changes),
    changes
  };
  await writeJson(path.join(schoolDir, '_latest_changes.json'), globalLatest);
  await writeJson(path.join(schoolDir, '_school_status.json'), {
    generatedAt: completedAt,
    activeTerms: manifest.activeTerms || [],
    sync: nextGlobalState,
    latestChanges: globalLatest.summary,
    courses: courseStatuses
  });

  // Semester-scoped school views let old terms remain queryable without making
  // the current school project scan every historical course on every question.
  for (const term of manifest.activeTerms || []) {
    const termDir = path.join(schoolDir, term.key);
    await ensureDir(termDir);
    const termCourses = courseStatuses.filter(c => c.term?.key === term.key);
    const termChanges = changes.filter(c => c.termKey === term.key);
    await writeJson(path.join(termDir, '_latest_changes.json'), {
      generatedAt: completedAt,
      syncMode: mode,
      term,
      summary: summarizeChanges(termChanges),
      changes: termChanges
    });
    await writeJson(path.join(termDir, '_school_status.json'), {
      generatedAt: completedAt,
      term,
      active: true,
      latestChanges: summarizeChanges(termChanges),
      courses: termCourses
    });
  }

  const registry = await updateCourseRegistry(config, manifest, completedAt);

  // Mark semester views that are no longer active as archived without touching
  // the underlying mirrored course data. Their last real data remains queryable forever,
  // but Quick/Full Sync will no longer crawl those courses.
  const activeTermKeys = new Set((manifest.activeTerms || []).map(t => t.key));
  const registryTerms = new Map();
  for (const course of registry.courses || []) {
    if (course?.term?.key) registryTerms.set(course.term.key, course.term);
  }
  for (const [termKey, term] of registryTerms) {
    if (activeTermKeys.has(termKey)) continue;
    const termDir = path.join(schoolDir, termKey);
    await ensureDir(termDir);
    const statusFile = path.join(termDir, '_school_status.json');
    const prior = await readJson(statusFile, {});
    const archivedCourses = (registry.courses || []).filter(c => c.term?.key === termKey).map(c => ({
      id: c.id, name: c.name, term: c.term, mirrorPath: c.mirrorPath,
      courseStatusFile: c.courseStatusFile, latestChangesFile: c.latestChangesFile
    }));
    await writeJson(statusFile, {
      ...prior,
      term,
      active: false,
      archived: true,
      archivedAt: prior.archivedAt || completedAt,
      courses: prior.courses?.length ? prior.courses : archivedCourses
    });
  }

  const current = {
    generatedAt: completedAt,
    activeTerms: manifest.activeTerms || [],
    sync: {
      lastSuccessfulSync: nextGlobalState.lastSuccessfulSync,
      lastQuickSync: nextGlobalState.lastQuickSync || null,
      lastFullSync: nextGlobalState.lastFullSync || null,
      lastSyncMode: nextGlobalState.lastSyncMode
    },
    courses: courseStatuses.map(course => ({
      id: course.id,
      name: course.name,
      term: course.term,
      mirrorPath: course.mirrorPath,
      courseStatusFile: relativeMirrorPath(course.mirrorPath, '_course_status.json'),
      latestChangesFile: relativeMirrorPath(course.mirrorPath, '_latest_changes.json')
    })),
    schoolStatusFile: '_school/_school_status.json',
    latestChangesFile: '_school/_latest_changes.json'
  };
  await writeJson(path.join(schoolDir, 'current.json'), current);

  return { globalState: nextGlobalState, courseStatuses, registry, current };
}
