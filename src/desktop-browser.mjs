import path from 'node:path';
import { loadAppConfig } from './config.mjs';
import { inspectChromiumBrowser } from './browser.mjs';

export const DESKTOP_BROWSER_SCHEMA_VERSION = 1;

function browserResponse(result) {
  return {
    schemaVersion: DESKTOP_BROWSER_SCHEMA_VERSION,
    engine: result.engine,
    available: Boolean(result.available),
    displayName: result.displayName || '',
    executablePath: result.executablePath || '',
    source: result.source || 'automatic',
    configuredManually: Boolean(result.configuredManually),
    supportLevel: result.supportLevel || '',
    validationStatus: result.validationStatus || 'not-detected'
  };
}

export async function getDesktopBrowser({ runtime = {}, inspect = inspectChromiumBrowser } = {}) {
  const { config } = await loadAppConfig({ mode: 'full', runtime });
  return browserResponse(await inspect(config.browserExecutablePath || '', { useCache: false }));
}

export async function probeDesktopBrowser(request, { inspect = inspectChromiumBrowser } = {}) {
  if (request?.schemaVersion !== DESKTOP_BROWSER_SCHEMA_VERSION) {
    throw new Error('The browser request version is not supported.');
  }
  const executablePath = String(request?.executablePath || '').trim();
  if (executablePath && !path.isAbsolute(executablePath)) {
    throw new Error('Choose an absolute browser executable path.');
  }
  return browserResponse(await inspect(executablePath, { useCache: false }));
}
