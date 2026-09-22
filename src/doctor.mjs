import fsPromises from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { findCompatibleChromiumExecutable } from './browser.mjs';
import { loadAppConfig } from './config.mjs';

const { config, paths, migrations } = await loadAppConfig();

console.log(`Node: ${process.version}`);
console.log(`Platform: ${process.platform} ${process.arch}`);

let ok = true;
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error('Node check: FAIL (Node.js 20+ is required)');
  ok = false;
} else {
  console.log('Node check: PASS');
}

if (process.platform !== 'win32') {
  console.error('Platform check: FAIL (CourseStow is currently supported on Windows 10/11 only)');
  ok = false;
} else {
  console.log('Platform check: PASS (Windows)');
}

try {
  const pkg = JSON.parse(await fsPromises.readFile(path.join(paths.appRoot, 'package.json'), 'utf8'));
  console.log(`Project: ${pkg.name} ${pkg.version}`);
} catch {
  console.error(`Project check: FAIL (package.json not found under ${paths.appRoot})`);
  ok = false;
}

console.log(`Application: ${paths.appRoot}`);
console.log(`Config: ${paths.configFile}`);
console.log(`Session: ${paths.profileDir}`);
console.log(`State: ${paths.stateDir}`);
console.log(`Logs: ${paths.logsDir}`);
console.log(`Mirror: ${config.outputDir}`);
if (migrations.length) console.log(`Migration: ${migrations.length} runtime data action(s) applied`);

try {
  const probe = path.join(paths.stateDir, `.write-test-${process.pid}`);
  await fsPromises.writeFile(probe, 'ok', 'utf8');
  await fsPromises.unlink(probe);
  console.log('User data check: PASS (runtime directories are writable)');
} catch (error) {
  console.error(`User data check: FAIL (${error.message})`);
  ok = false;
}

try {
  const browser = await findCompatibleChromiumExecutable(config.browserExecutablePath || '');
  console.log(`Browser check: PASS (${browser.name}: ${browser.path})`);
} catch (error) {
  console.error(`Browser check: FAIL (${error.message})`);
  ok = false;
}

if (!ok) process.exitCode = 1;
else console.log('Doctor: PASS');
