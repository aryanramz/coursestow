import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadAppConfig } from './config.mjs';
import { findCompatibleChromiumExecutable } from './browser.mjs';
import { authenticateWithInstitutionAdapter, makeChromiumPageVisible } from './auth-flow.mjs';
import { acquireSyncLock, describeActiveLock } from './sync-lock.mjs';
import { clearAuthAttention } from './auth-attention.mjs';

export async function runRefreshLogin({
  loadConfig = loadAppConfig,
  acquireLock = acquireSyncLock,
  findBrowser = findCompatibleChromiumExecutable,
  launchPersistentContext = (...args) => chromium.launchPersistentContext(...args),
  authenticate = authenticateWithInstitutionAdapter,
  makeVisible = makeChromiumPageVisible,
  log = console,
  clearAttention = clearAuthAttention
} = {}) {
  const { config, paths } = await loadConfig({ mode: 'full' });
  if (!config.baseUrl) throw new Error('Brightspace is not configured. Open Settings before refreshing login.');

  const lock = await acquireLock(paths.lockDir, { mode: 'refresh-login' });
  if (!lock.acquired) throw new Error(`Another CourseStow operation is already running: ${describeActiveLock(lock)}.`);

  try {
    const browser = await findBrowser(config.browserExecutablePath);
    log.log(`Opening ${browser.name} for manual Brightspace login refresh.`);
    log.log('Complete institutional sign-in and MFA in the visible browser. Credentials are not printed or logged.');
    const context = await launchPersistentContext(config.profileDir, {
      executablePath: browser.path,
      headless: false,
      acceptDownloads: false,
      viewport: { width: 1280, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble']
    });
    try {
      const pages = context.pages();
      const page = pages[0] || await context.newPage();
      for (const extra of pages.slice(1)) await extra.close().catch(() => {});
      await makeVisible(context, page);
      await authenticate({
        page,
        context,
        config,
        allowAutomatic: false,
        makeVisible: () => makeVisible(context, page)
      });
      await clearAttention(config.stateDir);
      log.log('Brightspace login refresh completed.');
    } finally {
      await context.close();
    }
  } finally {
    await lock.release();
  }
}

async function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    const [entry, current] = await Promise.all([
      fs.realpath(path.resolve(process.argv[1])),
      fs.realpath(fileURLToPath(import.meta.url))
    ]);
    return process.platform === 'win32'
      ? entry.toLowerCase() === current.toLowerCase()
      : entry === current;
  } catch {
    return false;
  }
}

if (await isDirectEntry()) {
  await runRefreshLogin();
}
