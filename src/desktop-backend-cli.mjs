import process from 'node:process';
import { getDesktopStatus } from './desktop-backend.mjs';
import { getDesktopSettings, saveDesktopSettings } from './desktop-settings.mjs';
import { getDesktopBrowser, probeDesktopBrowser } from './desktop-browser.mjs';
import { importSourceCheckout } from './source-import.mjs';

const [command = '', ...options] = process.argv.slice(2);
const JSON_OPTION = '--json';
const MAX_REQUEST_BYTES = 64 * 1024;

async function readJsonRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('Settings request is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw new Error('A settings request is required on standard input.');
  try { return JSON.parse(text); } catch { throw new Error('The settings request is not valid JSON.'); }
}

function usage() {
  console.error('Usage: node src/desktop-backend-cli.mjs <status --json|settings --json|settings save --json|settings import --json|browser --json|browser probe --json>');
}

try {
  if (command === 'status' && options.length === 1 && options[0] === JSON_OPTION) {
    console.log(JSON.stringify(await getDesktopStatus()));
  } else if (command === 'settings' && options.length === 1 && options[0] === JSON_OPTION) {
    console.log(JSON.stringify(await getDesktopSettings()));
  } else if (command === 'settings' && options.length === 2 && options[0] === 'save' && options[1] === JSON_OPTION) {
    console.log(JSON.stringify(await saveDesktopSettings(await readJsonRequest())));
  } else if (command === 'settings' && options.length === 2 && options[0] === 'import' && options[1] === JSON_OPTION) {
    console.log(JSON.stringify(await importSourceCheckout(await readJsonRequest())));
  } else if (command === 'browser' && options.length === 1 && options[0] === JSON_OPTION) {
    console.log(JSON.stringify(await getDesktopBrowser()));
  } else if (command === 'browser' && options.length === 2 && options[0] === 'probe' && options[1] === JSON_OPTION) {
    console.log(JSON.stringify(await probeDesktopBrowser(await readJsonRequest())));
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`CourseStow desktop backend failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
