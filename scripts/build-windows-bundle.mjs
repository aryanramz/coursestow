import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ROOT = path.join(ROOT, 'dist');
const BUNDLE_NAME = 'CourseStow';

export const BUNDLED_NODE_VERSION = '24.20.0';
export const BUNDLED_NODE_ARCH = 'x64';
export const BUNDLED_NODE_ARCHIVE = `node-v${BUNDLED_NODE_VERSION}-win-${BUNDLED_NODE_ARCH}.zip`;
export const BUNDLED_NODE_ARCHIVE_SHA256 = '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba';
export const BUNDLED_NODE_ARCHIVE_URL = `https://nodejs.org/dist/v${BUNDLED_NODE_VERSION}/${BUNDLED_NODE_ARCHIVE}`;

const RUNTIME_SOURCE_FILES = [
  'brightspace-url.mjs',
  'auth-attention.mjs',
  'auth-adapters.mjs',
  'auth-flow.mjs',
  'browser-launch-options.mjs',
  'browser.mjs',
  'config.mjs',
  'courseFolders.mjs',
  'crawler.mjs',
  'deadline-intelligence.mjs',
  'desktop-browser.mjs',
  'desktop-backend-cli.mjs',
  'desktop-backend.mjs',
  'desktop-settings.mjs',
  'credential-helper-client.mjs',
  'doctor.mjs',
  'index.mjs',
  'init-lock.mjs',
  'launcher.mjs',
  'login-setup.mjs',
  'migration.mjs',
  'process-lock.mjs',
  'product-migration.mjs',
  'publish-cli.mjs',
  'publish.mjs',
  'refresh-login.mjs',
  'runtime-paths.mjs',
  'schedule-config.mjs',
  'scheduled.mjs',
  'school-indexes.mjs',
  'source-import.mjs',
  'status.mjs',
  'sync-lock.mjs',
  'terms.mjs',
  'utils.mjs',
  'write-protection.mjs'
];

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function requireFile(file, label) {
  let stat;
  try { stat = await fs.stat(file); } catch {}
  if (!stat?.isFile()) throw new Error(`Required ${label} is missing: ${file}`);
}

async function run(command, args, { cwd = ROOT, env = process.env, label = command } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.once('error', error => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`));
    });
  });
}

async function validateRuntimeImportClosure() {
  const included = new Set(RUNTIME_SOURCE_FILES);
  for (const name of RUNTIME_SOURCE_FILES) {
    const file = path.join(ROOT, 'src', name);
    await requireFile(file, `runtime source file ${name}`);
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]\.\/([^'"]+)['"]/g)) {
      if (!included.has(match[1])) {
        throw new Error(`Runtime source manifest omits ${match[1]}, imported by src/${name}.`);
      }
    }
  }
}

async function downloadVerifiedNodeArchive(destination) {
  console.log(`Downloading private Node.js v${BUNDLED_NODE_VERSION} runtime...`);
  let response;
  try {
    response = await fetch(BUNDLED_NODE_ARCHIVE_URL, { redirect: 'follow' });
  } catch (error) {
    throw new Error(`Could not download ${BUNDLED_NODE_ARCHIVE_URL}: ${error.message}`);
  }
  if (!response.ok) throw new Error(`Node.js runtime download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== BUNDLED_NODE_ARCHIVE_SHA256) {
    throw new Error(`Node.js runtime checksum mismatch: expected ${BUNDLED_NODE_ARCHIVE_SHA256}, received ${actual}.`);
  }
  await fs.writeFile(destination, bytes, { flag: 'wx' });
}

async function extractPrivateNode(archive, extractionRoot, runtimeDir) {
  const expandCommand = 'Expand-Archive -LiteralPath $env:COURSESTOW_NODE_ARCHIVE -DestinationPath $env:COURSESTOW_NODE_EXTRACT -Force';
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', expandCommand], {
    env: {
      ...process.env,
      COURSESTOW_NODE_ARCHIVE: archive,
      COURSESTOW_NODE_EXTRACT: extractionRoot
    },
    label: 'Node.js runtime extraction'
  });

  const extractedRoot = path.join(extractionRoot, `node-v${BUNDLED_NODE_VERSION}-win-${BUNDLED_NODE_ARCH}`);
  const extractedNode = path.join(extractedRoot, 'node.exe');
  const extractedLicense = path.join(extractedRoot, 'LICENSE');
  await requireFile(extractedNode, 'extracted Node.js executable');
  await requireFile(extractedLicense, 'Node.js license');
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.copyFile(extractedNode, path.join(runtimeDir, 'node.exe'));
  await fs.copyFile(extractedLicense, path.join(runtimeDir, 'NODE_LICENSE.txt'));
}

async function installProductionDependencies(appDir, buildRoot, packageJson) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable. Run the bundle build through npm run build:windows-bundle.');
  await requireFile(npmCli, 'npm CLI used by the developer build environment');

  await fs.copyFile(path.join(ROOT, 'package-lock.json'), path.join(appDir, 'package-lock.json'));
  console.log('Installing locked production dependencies without lifecycle scripts or browser downloads...');
  await run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: appDir,
    env: {
      ...process.env,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      npm_config_cache: path.join(buildRoot, 'npm-cache')
    },
    label: 'Locked production dependency installation'
  });

  await fs.rm(path.join(appDir, 'package-lock.json'), { force: true });
  await fs.rm(path.join(appDir, 'node_modules', '.package-lock.json'), { force: true });
  await fs.rm(path.join(appDir, 'node_modules', '.bin'), { recursive: true, force: true });

  const installedPlaywrightFile = path.join(appDir, 'node_modules', 'playwright', 'package.json');
  const installedCoreFile = path.join(appDir, 'node_modules', 'playwright-core', 'package.json');
  await requireFile(installedPlaywrightFile, 'packaged Playwright dependency');
  await requireFile(installedCoreFile, 'packaged Playwright core dependency');
  const installedPlaywright = JSON.parse(await fs.readFile(installedPlaywrightFile, 'utf8'));
  if (installedPlaywright.version !== packageJson.dependencies.playwright) {
    throw new Error(`Packaged Playwright version ${installedPlaywright.version} does not match locked application version ${packageJson.dependencies.playwright}.`);
  }
  try {
    await fs.access(path.join(appDir, 'node_modules', 'playwright-core', '.local-browsers'));
    throw new Error('Playwright browser binaries were unexpectedly downloaded into the bundle.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function build() {
  if (process.platform !== 'win32') throw new Error('The Windows bundle must be built on Windows.');
  if (!isInside(ROOT, DIST_ROOT)) throw new Error(`Refusing to clean an unsafe dist path: ${DIST_ROOT}`);

  const sourcePackageFile = path.join(ROOT, 'package.json');
  const sourceLockFile = path.join(ROOT, 'package-lock.json');
  const sourceConfigFile = path.join(ROOT, 'config.example.json');
  const sourceLicenseFile = path.join(ROOT, 'LICENSE');
  const launcherTemplate = path.join(ROOT, 'packaging', 'windows', 'CourseStow.cmd');
  const controlPanelBuildScript = path.join(ROOT, 'scripts', 'build-windows-control-panel.mjs');
  const credentialHelperBuildScript = path.join(ROOT, 'scripts', 'build-windows-credential-helper.mjs');
  const controlPanelExe = path.join(ROOT, 'desktop', 'CourseStow.ControlPanel', 'bin', 'Release', 'CourseStow.exe');
  const controlPanelConfig = `${controlPanelExe}.config`;
  const credentialHelperExe = path.join(ROOT, 'desktop', 'CourseStow.CredentialHelper', 'bin', 'Release', 'CourseStow Credential Helper.exe');
  const credentialHelperConfig = `${credentialHelperExe}.config`;
  for (const [file, label] of [
    [sourcePackageFile, 'package.json'],
    [sourceLockFile, 'package-lock.json'],
    [sourceConfigFile, 'config.example.json'],
    [sourceLicenseFile, 'application license'],
    [launcherTemplate, 'packaged launcher template'],
    [controlPanelBuildScript, 'control-panel build script'],
    [credentialHelperBuildScript, 'credential-helper build script']
  ]) await requireFile(file, label);
  await validateRuntimeImportClosure();
  await run(process.execPath, [controlPanelBuildScript], { label: 'Windows control-panel build' });
  await run(process.execPath, [credentialHelperBuildScript], { label: 'Windows credential-helper build' });
  await requireFile(controlPanelExe, 'compiled Windows control panel');
  await requireFile(controlPanelConfig, 'Windows control-panel runtime configuration');
  await requireFile(credentialHelperExe, 'compiled Windows credential helper');
  await requireFile(credentialHelperConfig, 'Windows credential-helper runtime configuration');

  const sourcePackage = JSON.parse(await fs.readFile(sourcePackageFile, 'utf8'));
  const sourceLock = JSON.parse(await fs.readFile(sourceLockFile, 'utf8'));
  if (sourceLock.lockfileVersion !== 3 || sourceLock.packages?.['']?.version !== sourcePackage.version) {
    throw new Error('package-lock.json does not match the application package/version.');
  }
  if (JSON.stringify(sourceLock.packages?.['']?.dependencies || {}) !== JSON.stringify(sourcePackage.dependencies || {})) {
    throw new Error('package-lock.json production dependencies do not match package.json.');
  }

  await fs.rm(DIST_ROOT, { recursive: true, force: true });
  await fs.mkdir(DIST_ROOT, { recursive: true });
  const buildRoot = path.join(DIST_ROOT, `.windows-bundle-staging-${randomUUID()}`);
  const stagedBundle = path.join(buildRoot, BUNDLE_NAME);
  const finalBundle = path.join(DIST_ROOT, BUNDLE_NAME);
  const appDir = path.join(stagedBundle, 'app');
  const appSourceDir = path.join(appDir, 'src');
  const runtimeDir = path.join(stagedBundle, 'runtime');

  try {
    await fs.mkdir(appSourceDir, { recursive: true });
    for (const name of RUNTIME_SOURCE_FILES) {
      await fs.copyFile(path.join(ROOT, 'src', name), path.join(appSourceDir, name));
    }

    const runtimePackage = {
      name: sourcePackage.name,
      version: sourcePackage.version,
      private: true,
      type: sourcePackage.type,
      description: sourcePackage.description,
      author: sourcePackage.author,
      repository: sourcePackage.repository,
      homepage: sourcePackage.homepage,
      bugs: sourcePackage.bugs,
      dependencies: sourcePackage.dependencies,
      engines: sourcePackage.engines
    };
    await fs.writeFile(path.join(appDir, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`, 'utf8');
    await fs.copyFile(sourceConfigFile, path.join(appDir, 'config.example.json'));
    await fs.copyFile(sourceLicenseFile, path.join(appDir, 'LICENSE'));
    await fs.copyFile(sourceLicenseFile, path.join(stagedBundle, 'LICENSE'));
    await fs.copyFile(launcherTemplate, path.join(stagedBundle, 'CourseStow.cmd'));
    await fs.copyFile(controlPanelExe, path.join(stagedBundle, 'CourseStow.exe'));
    await fs.copyFile(controlPanelConfig, path.join(stagedBundle, 'CourseStow.exe.config'));
    await fs.copyFile(credentialHelperExe, path.join(stagedBundle, 'CourseStow Credential Helper.exe'));
    await fs.copyFile(credentialHelperConfig, path.join(stagedBundle, 'CourseStow Credential Helper.exe.config'));

    await installProductionDependencies(appDir, buildRoot, sourcePackage);

    const archive = path.join(buildRoot, BUNDLED_NODE_ARCHIVE);
    const extractionRoot = path.join(buildRoot, 'node-extracted');
    await downloadVerifiedNodeArchive(archive);
    await extractPrivateNode(archive, extractionRoot, runtimeDir);

    const manifest = {
      bundleFormatVersion: 1,
      application: {
        name: 'CourseStow',
        packageName: sourcePackage.name,
        version: sourcePackage.version,
        publisher: 'aryanramz',
        repository: 'https://github.com/aryanramz/coursestow'
      },
      runtime: {
        name: 'Node.js',
        version: BUNDLED_NODE_VERSION,
        platform: 'win32',
        architecture: BUNDLED_NODE_ARCH,
        archiveSha256: BUNDLED_NODE_ARCHIVE_SHA256
      },
      entrypoint: 'CourseStow.cmd',
      desktopEntrypoint: 'CourseStow.exe',
      credentialHelper: 'CourseStow Credential Helper.exe',
      desktop: {
        technology: '.NET Framework 4.8 WinForms',
        backendContract: 'status/settings/browser JSON over stdout; settings save/browser probe/source import JSON over stdin; credentials via private named pipe; scheduled sync via fixed hidden entry point',
        backendSchemaVersion: 1
      },
      applicationRoot: 'app',
      browserStrategy: 'installed Chromium-compatible browser; Edge, Chrome, and Brave officially tested; no bundled browser',
      productionDependencies: sourcePackage.dependencies
    };
    await fs.writeFile(path.join(stagedBundle, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await run(path.join(runtimeDir, 'node.exe'), ['--version'], { label: 'Packaged Node.js runtime verification' });
    await fs.rename(stagedBundle, finalBundle);
    console.log(`Windows bundle created: ${finalBundle}`);
  } catch (error) {
    await fs.rm(buildRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await fs.rm(buildRoot, { recursive: true, force: true });
}

build().catch(error => {
  console.error(`Windows bundle build failed: ${error.message}`);
  process.exitCode = 1;
});
