import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { ensureDir, exists, writeJson } from './utils.mjs';
import { loadAppConfig } from './config.mjs';
import { findCompatibleChromiumExecutable } from './browser.mjs';
import { installWriteProtection } from './write-protection.mjs';
import { resolveCourseDirectory } from './courseFolders.mjs';
import { ensureMirrorLayout, MIRROR_SCHEMA_VERSION } from './migration.mjs';
import {
  chooseActiveTerms,
  enrichCoursesWithTerms,
  filterCoursesToActiveTerms
} from './terms.mjs';
import {
  attachNetworkCapture,
  buildCourseNav,
  crawlContent,
  discoverCourses,
  savePageSnapshot,
  syncSection
} from './crawler.mjs';
import { writeProjectViews } from './status.mjs';
import { writeSchoolIndexes } from './school-indexes.mjs';
import { publishMirrorToDrive, resolveDrivePublishConfig } from './publish.mjs';
import { acquireSyncLock, describeActiveLock } from './sync-lock.mjs';
import { authenticateWithInstitutionAdapter, makeChromiumPageVisible } from './auth-flow.mjs';
import { buildSyncBrowserLaunchOptions } from './browser-launch-options.mjs';
import { createWindowsCredentialProvider } from './credential-helper-client.mjs';
import {
  AUTH_ATTENTION_EXIT_CODE,
  isAuthenticationAttentionError,
  runAndClearAuthAttention,
  setAuthAttention
} from './auth-attention.mjs';

const APP_VERSION = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

function requestedMode() {
  const modeArg = process.argv.find(arg => /^--mode=/i.test(arg));
  const value = modeArg ? modeArg.split('=')[1] : 'full';
  if (!['quick', 'full'].includes(String(value).toLowerCase())) throw new Error(`Unknown sync mode: ${value}. Use --mode=quick or --mode=full.`);
  return String(value).toLowerCase();
}

async function removeLegacyPlaintextAuthState(profileDir) {
  const legacyFile = path.join(profileDir, '_brightspace-auth-state.json');
  if (!(await exists(legacyFile))) return;
  try {
    await fs.rm(legacyFile, { force: true });
    console.log('Removed legacy plaintext auth-state backup; the Chromium profile now owns session persistence.');
  } catch (error) {
    console.warn(`Could not remove legacy plaintext auth-state backup: ${error.message}`);
  }
}

function changeSummary(changes) {
  return {
    total: changes.length,
    added: changes.filter(x => x.action === 'added').length,
    updated: changes.filter(x => x.action === 'updated').length
  };
}

function termDisplay(terms) {
  return terms?.length ? terms.map(t => t.label).join(', ') : '(none)';
}

async function runSync(mode, config, { scheduledRun = false } = {}) {
  if (!config.baseUrl) throw new Error(`baseUrl is missing from ${config.configFile}.`);
  const browser = await findCompatibleChromiumExecutable(config.browserExecutablePath);
  await ensureDir(config.outputDir);
  await ensureDir(config.profileDir);
  await removeLegacyPlaintextAuthState(config.profileDir);

  // v1.7 performs an in-place, idempotent migration before the browser starts.
  // Existing course trees are moved, not recopied, whenever possible.
  const layout = await ensureMirrorLayout(config, APP_VERSION);
  config.systemDir = layout.systemDir;
  config.changesDir = layout.changesDir;
  config.homeSnapshotDir = layout.homeSnapshotDir;
  if (layout.actions.length) {
    console.log(`Mirror migration: ${layout.actions.length} action(s) applied.`);
    for (const item of layout.actions) console.log(`  - ${item.action}${item.to ? ` -> ${item.to}` : ''}`);
  }

  const startedAt = new Date();
  console.log(`CourseStow v${APP_VERSION} — ${mode.toUpperCase()} mode`);
  console.log(`Brightspace: ${config.baseUrl}`);
  console.log(`Mirror:      ${config.outputDir}`);
  console.log(`Schema:      v${MIRROR_SCHEMA_VERSION} term-scoped`);
  console.log(`Mode:        READ-FOCUSED ${mode} incremental crawler`);
  if (mode === 'quick') console.log(`Quick checks: ${config.quickSections.join(', ')} (details: ${config.quickDetailSections.join(', ') || 'none'})`);
  console.log('Write guard:  post-login state-changing requests blocked');
  console.log('Session:      persistent Chromium profile only (no standalone cookie export)');
  console.log('Media:        video/audio indexed, not downloaded by default');
  console.log(`Asset limit:  ${(config.assetPolicy.maxDownloadBytes / 1024 / 1024).toFixed(0)} MB per downloaded file`);
  const drivePublish = resolveDrivePublishConfig(config);
  console.log(`Drive publish: ${drivePublish.enabled ? drivePublish.destination : 'disabled'}`);
  console.log(`Network diag: ${config.captureNetwork ? 'ON' : 'off'}\n`);

  config._changes = [];
  config._runId = startedAt.toISOString().replace(/[:.]/g, '-');
  config._diagnosticSequence = 0;
  config._courseTermById = {};

  console.log(`Browser:     ${browser.name} (${browser.path})`);

  const context = await chromium.launchPersistentContext(
    config.profileDir,
    buildSyncBrowserLaunchOptions(config, browser.path, { scheduledRun })
  );

  await new Promise(resolve => setTimeout(resolve, 700));
  const startupPages = context.pages();
  const page = startupPages[0] || await context.newPage();
  for (const extra of startupPages.slice(1)) await extra.close().catch(() => {});
  page.setDefaultNavigationTimeout(config.navigationTimeoutMs);

  try {
    const homeSnapshot = config.homeSnapshotDir;
    const homeNetworkDir = path.join(homeSnapshot, '_network');
    const stopHomeCapture = attachNetworkCapture(page, homeNetworkDir, config.baseUrl, config.captureNetwork !== false);
    await authenticateWithInstitutionAdapter({
      page,
      context,
      config,
      credentialProvider: createWindowsCredentialProvider({ appRoot: config.appRoot }),
      makeVisible: () => makeChromiumPageVisible(context, page)
    });

    // Authentication and SSO/MFA must be allowed to complete normally. Once
    // Brightspace is authenticated, install the crawler's network write guard.
    await installWriteProtection(context, config.baseUrl);

    await page.waitForTimeout(config.dynamicWaitMs || 2200);
    await savePageSnapshot(page, homeSnapshot, 'page');

    const discoveredRaw = await discoverCourses(page, context, config.baseUrl, homeSnapshot, config);
    await stopHomeCapture();
    if (!discoveredRaw.length) throw new Error('No real course org units were discovered. Zip _system/debug/BrightspaceHome and send it back for diagnosis.');

    const discovered = enrichCoursesWithTerms(discoveredRaw);
    const discoveredTermsMap = new Map(discovered.filter(c => c.term).map(c => [c.term.key, c.term]));
    const discoveredTerms = [...discoveredTermsMap.values()].sort((a, b) => a.key.localeCompare(b.key));
    const activeTerms = chooseActiveTerms(discovered, config, startedAt);
    let courses = filterCoursesToActiveTerms(discovered, activeTerms);

    // Defensive fallback: if Brightspace ever stops putting term text in course
    // names, avoid a destructive zero-course run. We mirror the discovered set
    // under Unclassified rather than silently dropping it.
    if (!courses.length && discovered.length) {
      console.warn('No discovered course names could be matched to an active term. Using an Unclassified term for this run.');
      const unclassified = { season: 'Unknown', year: null, label: 'Unclassified', key: 'Unclassified' };
      courses = discovered.map(c => ({ ...c, term: c.term || unclassified }));
      activeTerms.splice(0, activeTerms.length, unclassified);
    }

    for (const course of courses) config._courseTermById[String(course.id)] = course.term;

    console.log(`\nDiscovered ${discovered.length} accessible course(s) across: ${termDisplay(discoveredTerms)}`);
    console.log(`Active term(s): ${termDisplay(activeTerms)}`);
    console.log(`Syncing ${courses.length} course(s):`);
    for (const c of courses) console.log(`  - ${c.name} [${c.id}] (${c.term?.key || 'Unclassified'})`);

    const manifest = {
      schemaVersion: MIRROR_SCHEMA_VERSION,
      appVersion: APP_VERSION,
      syncMode: mode,
      generatedAt: startedAt.toISOString(),
      baseUrl: config.baseUrl,
      discoveredCourses: discovered.length,
      discoveredTerms,
      activeTerms,
      courses: []
    };

    for (const course of courses) {
      const term = course.term || { season: 'Unknown', year: null, label: 'Unclassified', key: 'Unclassified' };
      const termDir = path.join(config.outputDir, term.key);
      await ensureDir(termDir);
      const resolved = await resolveCourseDirectory(termDir, course);
      const { mirrorDir, courseDir, courseWasNew } = resolved;
      const mirrorPath = `${term.key}/${mirrorDir}`.replace(/\\/g, '/');
      if (resolved.migrated.length) {
        console.log(`  folder migration: ${resolved.migrated.map(x => `${x.from} -> ${x.to}`).join('; ')}`);
      }
      if (courseWasNew) {
        config._changes.push({
          at: new Date().toISOString(), action: 'added', type: 'course', courseId: course.id,
          course: course.name, title: course.name, termKey: term.key, term: term.label
        });
      }

      console.log(`\n== ${course.name} [${course.id}] :: ${term.key} ==`);
      const nav = await buildCourseNav(course, config.baseUrl);
      await writeJson(path.join(courseDir, '_course.json'), {
        ...course,
        term,
        nav,
        mirrorDir,
        mirrorPath,
        schemaVersion: MIRROR_SCHEMA_VERSION
      });

      const summary = { ...course, term, mirrorDir, mirrorPath, courseDir, nav, sections: [] };

      if (mode === 'full') {
        try {
          const content = await crawlContent(page, context, course, nav.content, courseDir, config);
          summary.sections.push({ section: 'content', ...content });
        } catch (error) {
          summary.sections.push({ section: 'content', error: error.message });
          console.warn(`  content failed: ${error.message}`);
        }
      } else {
        console.log('  content... skipped in QUICK mode');
        summary.sections.push({ section: 'content', skipped: true, reason: 'quick-mode' });
      }

      const sections = mode === 'quick'
        ? config.quickSections
        : ['assignments', 'quizzes', 'discussions', 'grades', 'calendar', 'announcements'];

      for (const section of sections) {
        console.log(`  ${section}...`);
        try {
          const result = await syncSection(page, context, course, section, nav[section], courseDir, config);
          summary.sections.push(result);
        } catch (error) {
          summary.sections.push({ section, error: error.message });
          console.warn(`  ${section} failed: ${error.message}`);
        }
      }

      manifest.courses.push(summary);
    }

    const completedAt = new Date().toISOString();
    manifest.completedAt = completedAt;
    manifest.durationSeconds = Math.round((Date.parse(completedAt) - startedAt.getTime()) / 1000);
    manifest.changeSummary = changeSummary(config._changes);
    await writeJson(path.join(config.systemDir, 'manifest.json'), manifest);

    if (config.writeChangeLog) {
      const changesDir = config.changesDir;
      await ensureDir(changesDir);
      const changeLog = {
        generatedAt: completedAt,
        syncMode: mode,
        activeTerms,
        summary: manifest.changeSummary,
        changes: config._changes
      };
      await writeJson(path.join(changesDir, 'latest.json'), changeLog);
      if (config._changes.length) {
        const stamp = completedAt.replace(/[:.]/g, '-');
        await writeJson(path.join(changesDir, `${stamp}.json`), changeLog);
      }
    }

    await writeProjectViews(config, manifest, config._changes, mode, completedAt);
    const schoolIndexes = await writeSchoolIndexes(config, manifest, config._changes, mode, completedAt);

    console.log(`\nChanges: ${manifest.changeSummary.added} added, ${manifest.changeSummary.updated} updated.`);
    if (!config._changes.length) console.log('No Brightspace content changes detected.');
    console.log(`Upcoming deadlines indexed: ${schoolIndexes.upcoming.count}.`);
    console.log(`Deadline changes detected: ${schoolIndexes.deadlineChanges.length}.`);
    console.log(`Sync digest entries: ${schoolIndexes.digest.summary.total}.`);
    console.log(`Duration: ${manifest.durationSeconds}s (${mode} mode)`);
    console.log(`Sync complete. Mirror written to:\n${config.outputDir}`);

    const publishResult = await publishMirrorToDrive(config, mode);
    if (publishResult.skipped) {
      console.warn(`Drive publish skipped: ${publishResult.reason}.`);
      if (publishResult.destination) console.warn(`Drive destination: ${publishResult.destination}`);
    } else {
      console.log(`Drive publish: ${publishResult.copied} copied, ${publishResult.deleted} deleted, ${publishResult.unchanged} unchanged, ${publishResult.failed} failed (${publishResult.durationSeconds}s).`);
      console.log(`Drive destination: ${publishResult.destination}`);
      if (publishResult.failed) console.warn('Drive publish had file errors; they will be retried on the next run.');
    }
  } finally {
    await context.close();
  }
}

async function main() {
  const mode = requestedMode();
  const scheduledRun = process.argv.includes('--scheduled-run');
  const { config, paths, migrations } = await loadAppConfig({ mode });
  if (migrations.length) console.log(`Runtime data migration: ${migrations.length} action(s) applied.`);
  await ensureDir(paths.lockDir);
  const lock = await acquireSyncLock(paths.lockDir, { mode });
  if (!lock.acquired) {
    console.log(`CourseStow v${APP_VERSION} — ${mode.toUpperCase()} mode`);
    console.log(`Another CourseStow operation is already running: ${describeActiveLock(lock)}.`);
    console.log('This run was skipped to protect the mirror from overlapping writes.');
    if (scheduledRun) process.exitCode = 3;
    return;
  }

  const releaseAndExit = async code => {
    await lock.release();
    process.exit(code);
  };
  process.once('SIGINT', () => { void releaseAndExit(130); });
  process.once('SIGTERM', () => { void releaseAndExit(143); });

  try {
    try {
      if (scheduledRun) {
        await runSync(mode, config, { scheduledRun: true });
      } else {
        await runAndClearAuthAttention(
          () => runSync(mode, config, { scheduledRun: false }),
          paths.stateDir
        );
      }
    } catch (error) {
      if (scheduledRun && isAuthenticationAttentionError(error)) {
        await setAuthAttention(paths.stateDir).catch(() => {});
        process.exitCode = AUTH_ATTENTION_EXIT_CODE;
        return;
      }
      throw error;
    }
  } finally {
    await lock.release();
  }
}

main().catch(error => {
  if (isAuthenticationAttentionError(error)) {
    console.error('\nERROR: Brightspace authentication requires attention. Use Refresh Login.');
  } else {
    console.error(`\nERROR: ${error.stack || error.message}`);
  }
  process.exitCode = 1;
});
