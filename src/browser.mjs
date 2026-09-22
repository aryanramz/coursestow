import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

export const BROWSER_ENGINE_ID = 'chromium';
export const EDGE_DOWNLOAD_URL = 'https://www.microsoft.com/edge/download';
export const BROWSER_PROBE_TIMEOUT_MS = 15_000;
const inspectionCache = new Map();

function candidate(name, executablePath, supportLevel, source = 'automatic') {
  return executablePath ? {
    engine: BROWSER_ENGINE_ID,
    name,
    path: path.normalize(executablePath),
    supportLevel,
    source
  } : null;
}

export function chromiumBrowserCandidates(configuredPath = '', env = process.env) {
  const local = env.LOCALAPPDATA;
  const pf = env.PROGRAMFILES;
  const pfx86 = env['PROGRAMFILES(X86)'];

  return [
    candidate('Custom Chromium browser', configuredPath, 'custom', 'configured'),

    candidate('Microsoft Edge', pf && path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'official'),
    candidate('Microsoft Edge', pfx86 && path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'official'),
    candidate('Microsoft Edge', local && path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'official'),

    candidate('Google Chrome', local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'official'),
    candidate('Google Chrome', pf && path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'official'),
    candidate('Google Chrome', pfx86 && path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'official'),

    candidate('Brave', local && path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'official'),
    candidate('Brave', pf && path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'official'),
    candidate('Brave', pfx86 && path.join(pfx86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'official'),

    candidate('Vivaldi', local && path.join(local, 'Vivaldi', 'Application', 'vivaldi.exe'), 'best-effort'),
    candidate('Vivaldi', pf && path.join(pf, 'Vivaldi', 'Application', 'vivaldi.exe'), 'best-effort'),
    candidate('Vivaldi', pfx86 && path.join(pfx86, 'Vivaldi', 'Application', 'vivaldi.exe'), 'best-effort'),

    candidate('Opera', local && path.join(local, 'Programs', 'Opera', 'launcher.exe'), 'best-effort'),
    candidate('Opera', pf && path.join(pf, 'Opera', 'launcher.exe'), 'best-effort'),
    candidate('Opera', pfx86 && path.join(pfx86, 'Opera', 'launcher.exe'), 'best-effort'),

    candidate('Opera GX', local && path.join(local, 'Programs', 'Opera GX', 'launcher.exe'), 'best-effort'),
    candidate('Opera GX', pf && path.join(pf, 'Opera GX', 'launcher.exe'), 'best-effort'),
    candidate('Opera GX', pfx86 && path.join(pfx86, 'Opera GX', 'launcher.exe'), 'best-effort'),

    candidate('Chromium', local && path.join(local, 'Chromium', 'Application', 'chrome.exe'), 'best-effort'),
    candidate('Chromium', pf && path.join(pf, 'Chromium', 'Application', 'chrome.exe'), 'best-effort'),
    candidate('Chromium', pfx86 && path.join(pfx86, 'Chromium', 'Application', 'chrome.exe'), 'best-effort')
  ].filter(Boolean);
}

async function isRegularFile(file, io = fsp) {
  try { return (await io.stat(file)).isFile(); } catch { return false; }
}

function safeBrowserResult(candidateValue, available, validationStatus) {
  return {
    engine: BROWSER_ENGINE_ID,
    available,
    displayName: candidateValue?.name || '',
    executablePath: candidateValue?.path || '',
    source: candidateValue?.source || 'automatic',
    configuredManually: candidateValue?.source === 'configured',
    supportLevel: candidateValue?.supportLevel || '',
    validationStatus
  };
}

export async function probeChromiumExecutable(executablePath, {
  io = fsp,
  tempRoot = os.tmpdir(),
  launchPersistentContext = (profileDir, options) => chromium.launchPersistentContext(profileDir, options),
  timeoutMs = BROWSER_PROBE_TIMEOUT_MS
} = {}) {
  const normalized = path.normalize(path.resolve(String(executablePath || '').trim()));
  if (!await isRegularFile(normalized, io)) return { compatible: false, status: 'missing' };

  await io.mkdir(tempRoot, { recursive: true });
  const profileDir = await io.mkdtemp(path.join(tempRoot, 'coursestow-browser-probe-'));
  let context;
  try {
    context = await launchPersistentContext(profileDir, {
      executablePath: normalized,
      headless: true,
      acceptDownloads: false,
      viewport: { width: 800, height: 600 },
      timeout: timeoutMs,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble']
    });
    const pages = context.pages();
    const page = pages[0] || await context.newPage();
    await page.goto('data:text/html,<title>CourseStow compatibility probe</title>', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });
    if (await page.title() !== 'CourseStow compatibility probe') {
      return { compatible: false, status: 'incompatible' };
    }
    return { compatible: true, status: 'compatible' };
  } catch {
    return { compatible: false, status: 'incompatible' };
  } finally {
    if (context) await context.close().catch(() => {});
    await io.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function inspectChromiumBrowser(configuredPath = '', {
  env = process.env,
  io = fsp,
  probe = probeChromiumExecutable,
  useCache = true
} = {}) {
  const configured = String(configuredPath || '').trim();
  const cacheKey = JSON.stringify([
    configured,
    env.LOCALAPPDATA || '',
    env.PROGRAMFILES || '',
    env['PROGRAMFILES(X86)'] || ''
  ]);
  const canCache = useCache && io === fsp && probe === probeChromiumExecutable;
  if (canCache && inspectionCache.has(cacheKey)) return { ...inspectionCache.get(cacheKey) };
  const candidates = chromiumBrowserCandidates(configured, env);
  const considered = configured ? candidates.filter(item => item.source === 'configured') : candidates;

  for (const item of considered) {
    if (!await isRegularFile(item.path, io)) {
      if (item.source === 'configured') {
        const result = safeBrowserResult(item, false, 'missing');
        if (canCache) inspectionCache.set(cacheKey, result);
        return { ...result };
      }
      continue;
    }
    const result = await probe(item.path, { io });
    if (result?.compatible) {
      const compatible = safeBrowserResult(item, true, 'compatible');
      if (canCache) inspectionCache.set(cacheKey, compatible);
      return { ...compatible };
    }
    if (item.source === 'configured') {
      const incompatible = safeBrowserResult(item, false, result?.status || 'incompatible');
      if (canCache) inspectionCache.set(cacheKey, incompatible);
      return { ...incompatible };
    }
  }

  const missing = safeBrowserResult(null, false, 'not-detected');
  if (canCache) inspectionCache.set(cacheKey, missing);
  return { ...missing };
}

export async function discoverChromiumBrowserCandidate(configuredPath = '', {
  env = process.env,
  io = fsp
} = {}) {
  const configured = String(configuredPath || '').trim();
  const candidates = chromiumBrowserCandidates(configured, env);
  const considered = configured ? candidates.filter(item => item.source === 'configured') : candidates;
  for (const item of considered) {
    if (await isRegularFile(item.path, io)) return safeBrowserResult(item, false, 'not-validated');
    if (item.source === 'configured') return safeBrowserResult(item, false, 'missing');
  }
  return safeBrowserResult(null, false, 'not-detected');
}

export function findChromiumExecutable(configuredPath = '') {
  const configured = String(configuredPath || '').trim();
  const candidates = chromiumBrowserCandidates(configured);
  const considered = configured ? candidates.filter(item => item.source === 'configured') : candidates;
  const found = considered.find(item => fs.existsSync(item.path) && fs.statSync(item.path).isFile());
  if (found) return found;

  throw new Error(
    'No compatible Chromium browser was found. Open CourseStow Settings to retry detection, '
    + 'choose a browser executable, or install Microsoft Edge.'
  );
}

export async function findCompatibleChromiumExecutable(configuredPath = '', options = {}) {
  const result = await inspectChromiumBrowser(configuredPath, options);
  if (result.available) {
    return {
      name: result.displayName,
      path: result.executablePath,
      supportLevel: result.supportLevel,
      source: result.source
    };
  }
  throw new Error(
    'No compatible Chromium browser was found. Open CourseStow Settings to retry detection, '
    + 'choose a browser executable, or install Microsoft Edge.'
  );
}
