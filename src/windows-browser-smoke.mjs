import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { findChromiumExecutable } from './browser.mjs';

if (process.platform !== 'win32') {
  console.log('Windows browser smoke test: SKIP (non-Windows runner)');
  process.exit(0);
}

const browser = findChromiumExecutable('');
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coursestow-smoke-'));
let context;

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: browser.path,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check']
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('data:text/html,<title>CourseStow Smoke</title><p>ok</p>');
  const title = await page.title();
  if (title !== 'CourseStow Smoke') throw new Error(`Unexpected browser title: ${title}`);
  console.log(`Windows browser smoke test: PASS (${browser.name})`);
} finally {
  await context?.close().catch(() => {});
  await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
