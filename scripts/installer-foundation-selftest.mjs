import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_BUNDLE = path.join(ROOT, 'dist', 'CourseStow');
const EXPECTED_APP_ID = '7E264BC7-FCBE-4BF2-9A24-E342C533A770';
const EXPECTED_INNO_VERSION = '7.1.0';
const EXPECTED_INNO_SHA256 = '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f';

const read = relative => fs.readFile(path.join(ROOT, relative), 'utf8');
const packageJson = JSON.parse(await read('package.json'));
const installerSource = await read('installer/windows/CourseStow.iss');
const productInclude = await read('installer/windows/includes/Product.iss');
const assetsReadme = await read('installer/windows/assets/README.md');
const buildScript = await read('scripts/build-windows-installer.ps1');
const provisionScript = await read('scripts/provision-inno-setup-ci.ps1');
const assemblyVersionSource = await read('scripts/windows-assembly-version.mjs');
const controlPanelAssemblyInfo = await read('desktop/CourseStow.ControlPanel/Properties/AssemblyInfo.cs');
const credentialHelperAssemblyInfo = await read('desktop/CourseStow.CredentialHelper/Properties/AssemblyInfo.cs');
const workflow = await read('.github/workflows/ci.yml');

assert.equal(packageJson.name, 'coursestow');
assert.equal(packageJson.version, '3.0.0', 'Windows v3 packaging must use the authoritative 3.0.0 version');
for (const wrapper of ['FULL_SYNC.cmd', 'PUBLISH_TO_DRIVE.cmd', 'QUICK_SYNC.cmd', 'SCHEDULED_SYNC.cmd', 'SETUP_LOGIN.cmd', 'START_HERE.cmd']) {
  assert.doesNotMatch(await read(wrapper), /CourseStow\s+v\d+\.\d+\.\d+/i, `${wrapper} must not duplicate the package version`);
}
assert.equal(packageJson.scripts['build:windows-installer'], 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-installer.ps1');
assert.equal(packageJson.scripts['installer-foundation-selftest'], 'node scripts/installer-foundation-selftest.mjs');
assert.match(assetsReadme, /default artwork/i);
for (const [label, source] of [
  ['control-panel AssemblyInfo', controlPanelAssemblyInfo],
  ['credential-helper AssemblyInfo', credentialHelperAssemblyInfo]
]) {
  assert.doesNotMatch(source, /Assembly(?:Version|FileVersion|InformationalVersion)\s*\(\s*"\d/, `${label} must not contain an independent numeric version`);
}
assert.match(assemblyVersionSource, /package\.json/);
assert.match(assemblyVersionSource, /AssemblyVersion\(\"\$\{assemblyVersion\}\"\)/);
assert.match(assemblyVersionSource, /AssemblyFileVersion\(\"\$\{assemblyVersion\}\"\)/);
assert.match(assemblyVersionSource, /AssemblyInformationalVersion\(\"\$\{packageVersion\}\"\)/);

assert.match(productInclude, new RegExp(`#define ProductAppId "\\{\\{${EXPECTED_APP_ID.replaceAll('-', '\\-')}\\}"`));
assert.match(productInclude, /#define ProductName "CourseStow"/);
assert.match(productInclude, /#define ProductPublisher "aryanramz"/);
assert.match(productInclude, /https:\/\/github\.com\/aryanramz\/coursestow/);
assert.match(productInclude, /https:\/\/github\.com\/aryanramz\/coursestow\/issues/);
assert.match(productInclude, /https:\/\/github\.com\/aryanramz\/coursestow\/releases/);

assert.match(installerSource, /^AppId=\{#ProductAppId\}$/m);
assert.match(installerSource, /^SetupArchitecture=x64$/m);
assert.match(installerSource, /^ArchitecturesAllowed=x64compatible and not arm64$/m);
assert.match(installerSource, /^MinVersion=10\.0\.19045$/m);
assert.match(installerSource, /^PrivilegesRequired=lowest$/m);
assert.doesNotMatch(installerSource, /^PrivilegesRequiredOverridesAllowed=/m, 'default blank override list must keep per-user scope fixed');
assert.match(installerSource, /^DefaultDirName=\{localappdata\}\\Programs\\\{#ProductName\}$/m);
assert.match(installerSource, /^DisableDirPage=yes$/m);
assert.match(installerSource, /^LicenseFile=\{#ProjectLicenseFile\}$/m);
assert.match(installerSource, /IsDotNetInstalled\(net48, 0\)/);
assert.match(productInclude, /https:\/\/dotnet\.microsoft\.com\/en-us\/download\/dotnet-framework\/net48/);
assert.match(installerSource, /^Name: "desktopicon";.+Flags: unchecked$/m);
assert.equal((installerSource.match(/^Name: "\{userprograms\}/gm) || []).length, 1, 'installer must create exactly one direct Start Menu shortcut');
assert.doesNotMatch(installerSource, /\{group\}|unins000|Startup|RunOnce|URLProtocol|ChangesAssociations/i);
assert.match(installerSource, /^Filename: "\{app\}\\\{#ProductExecutable\}"; Parameters: "--installer-launch"; Description: "Launch \{#ProductName\}";.+Flags: nowait postinstall skipifsilent$/m);
assert.doesNotMatch(installerSource, /^\s*(?:Filename|Name):.+(?:Settings|Logs|Documentation|Uninstall)/mi);

assert.match(buildScript, /\$ExpectedCompilerVersion = '7\.1\.0'/);
assert.match(buildScript, /\$ExpectedCompilerMachine = 0x8664/);
assert.match(buildScript, /& \$Path --version/);
assert.match(buildScript, /\$env:ISCC_PATH/);
assert.match(buildScript, /package\.json/);
assert.match(buildScript, /dist\\CourseStow/);
assert.match(buildScript, /bundle-manifest\.json/);
assert.match(buildScript, /Assert-PackagedBinaryVersion \(Join-Path \$bundleRoot 'CourseStow\.exe'\)/);
assert.match(buildScript, /Assert-PackagedBinaryVersion \(Join-Path \$bundleRoot 'CourseStow Credential Helper\.exe'\)/);
assert.match(buildScript, /System\.Security\.Cryptography\.SHA256/);
assert.match(buildScript, /\$checksumLine = "\$sha256  \$\(\[System\.IO\.Path\]::GetFileName\(\$installerFile\)\)"/);
assert.match(buildScript, /\$installerBaseName = "\$ProductName-\$appVersion-Setup"/);
assert.match(installerSource, /^OutputBaseFilename=\{#ProductName\}-\{#AppVersion\}-Setup$/m);

assert.match(provisionScript, new RegExp(`\\$ExpectedVersion = '${EXPECTED_INNO_VERSION.replaceAll('.', '\\.')}';?`));
assert.match(provisionScript, new RegExp(`\\$ExpectedSha256 = '${EXPECTED_INNO_SHA256}'`));
assert.match(provisionScript, /releases\/download\/is-7_1_0\/innosetup-7\.1\.0-x64\.exe/);
assert.match(provisionScript, /Get-AuthenticodeSignature/);
assert.match(provisionScript, /\$env:GITHUB_ACTIONS -ne 'true'/);

assert.match(workflow, /npm run installer-foundation-selftest/);
assert.match(workflow, /scripts[\\/]provision-inno-setup-ci\.ps1/);
assert.match(workflow, /npm run build:windows-installer/);
assert.match(workflow, /name: coursestow-installer-development/);
assert.doesNotMatch(workflow, /create-release|softprops\/action-gh-release|gh release create/i);

async function runPowerShell(script, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output: `${stdout}\n${stderr}` }));
  });
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createSyntheticRepository(root, {
  bundle = true,
  packageVersion = packageJson.version,
  manifestVersion = packageVersion
} = {}) {
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(root, 'installer', 'windows'), { recursive: true });
  await fs.copyFile(path.join(ROOT, 'scripts', 'build-windows-installer.ps1'), path.join(root, 'scripts', 'build-windows-installer.ps1'));
  await fs.copyFile(path.join(ROOT, 'installer', 'windows', 'CourseStow.iss'), path.join(root, 'installer', 'windows', 'CourseStow.iss'));
  await fs.writeFile(path.join(root, 'LICENSE'), 'synthetic MIT license fixture\n', 'utf8');
  await writeJson(path.join(root, 'package.json'), { name: 'coursestow', version: packageVersion });
  if (!bundle) return;

  const bundleRoot = path.join(root, 'dist', 'CourseStow');
  const files = [
    'CourseStow.exe',
    'CourseStow.exe.config',
    'CourseStow Credential Helper.exe',
    'CourseStow Credential Helper.exe.config',
    'CourseStow.cmd',
    'runtime/node.exe',
    'app/src/launcher.mjs',
    'app/node_modules/playwright/package.json'
  ];
  for (const relative of files) {
    const target = path.join(bundleRoot, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (relative === 'CourseStow.exe' || relative === 'CourseStow Credential Helper.exe') {
      await fs.copyFile(path.join(SOURCE_BUNDLE, relative), target);
    } else {
      await fs.writeFile(target, 'fixture\n', 'utf8');
    }
  }
  const license = await fs.readFile(path.join(root, 'LICENSE'));
  await fs.writeFile(path.join(bundleRoot, 'LICENSE'), license);
  await fs.writeFile(path.join(bundleRoot, 'app', 'LICENSE'), license);
  await writeJson(path.join(bundleRoot, 'app', 'package.json'), { name: 'coursestow', version: packageVersion });
  await writeJson(path.join(bundleRoot, 'bundle-manifest.json'), {
    application: {
      name: 'CourseStow',
      packageName: 'coursestow',
      version: manifestVersion,
      publisher: 'aryanramz',
      repository: 'https://github.com/aryanramz/coursestow'
    },
    runtime: { platform: 'win32', architecture: 'x64' },
    desktopEntrypoint: 'CourseStow.exe',
    credentialHelper: 'CourseStow Credential Helper.exe'
  });
}

if (process.platform === 'win32') {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'coursestow-installer-foundation-'));
  try {
    const missingBundleRoot = path.join(temp, 'missing bundle repo');
    await createSyntheticRepository(missingBundleRoot, { bundle: false });
    let result = await runPowerShell(path.join(missingBundleRoot, 'scripts', 'build-windows-installer.ps1'), missingBundleRoot, { ISCC_PATH: path.join(temp, 'not-used.exe') });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Portable bundle is missing:.+Run npm run build:windows-bundle first\./s);

    const mismatchRoot = path.join(temp, 'version mismatch repo');
    await createSyntheticRepository(mismatchRoot, { manifestVersion: '9.9.9' });
    result = await runPowerShell(path.join(mismatchRoot, 'scripts', 'build-windows-installer.ps1'), mismatchRoot, { ISCC_PATH: path.join(temp, 'not-used.exe') });
    assert.notEqual(result.code, 0);
    assert.match(result.output, new RegExp(`Portable bundle manifest version mismatch: expected ${packageJson.version.replaceAll('.', '\\.')}.*, found 9\\.9\\.9\\.`));

    const staleBinaryRoot = path.join(temp, 'stale binary repo');
    await createSyntheticRepository(staleBinaryRoot, { packageVersion: '9.9.9' });
    result = await runPowerShell(path.join(staleBinaryRoot, 'scripts', 'build-windows-installer.ps1'), staleBinaryRoot, { ISCC_PATH: path.join(temp, 'not-used.exe') });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Packaged Windows binary version mismatch for CourseStow\.exe: expected 9\.9\.9 \(9\.9\.9\.0\)/);

    const incompleteRoot = path.join(temp, 'incomplete bundle repo');
    await createSyntheticRepository(incompleteRoot);
    await fs.rm(path.join(incompleteRoot, 'dist', 'CourseStow', 'CourseStow.exe'));
    result = await runPowerShell(path.join(incompleteRoot, 'scripts', 'build-windows-installer.ps1'), incompleteRoot, { ISCC_PATH: path.join(temp, 'not-used.exe') });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Portable bundle is incomplete; required file is missing: CourseStow\.exe/);

    const privateDataRoot = path.join(temp, 'private data bundle repo');
    await createSyntheticRepository(privateDataRoot);
    await fs.writeFile(path.join(privateDataRoot, 'dist', 'CourseStow', 'config.json'), '{}\n', 'utf8');
    result = await runPowerShell(path.join(privateDataRoot, 'scripts', 'build-windows-installer.ps1'), privateDataRoot, { ISCC_PATH: path.join(temp, 'not-used.exe') });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Portable bundle contains private runtime material and cannot be installed: config\.json/);

    const browserRoot = path.join(temp, 'bundled browser repo');
    await createSyntheticRepository(browserRoot);
    await fs.mkdir(path.join(browserRoot, 'dist', 'CourseStow', 'app', 'node_modules', 'playwright-core', '.local-browsers'), { recursive: true });
    result = await runPowerShell(path.join(browserRoot, 'scripts', 'build-windows-installer.ps1'), browserRoot, { ISCC_PATH: path.join(temp, 'not-used.exe') });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Portable bundle unexpectedly contains Playwright-downloaded browser binaries\./);

    const compilerRoot = path.join(temp, 'compiler validation repo');
    await createSyntheticRepository(compilerRoot);
    result = await runPowerShell(path.join(compilerRoot, 'scripts', 'build-windows-installer.ps1'), compilerRoot, { ISCC_PATH: path.join(temp, 'missing-iscc.exe') });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /ISCC_PATH does not point to an existing compiler:/);

    result = await runPowerShell(path.join(compilerRoot, 'scripts', 'build-windows-installer.ps1'), compilerRoot, { ISCC_PATH: process.execPath });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Inno Setup compiler version mismatch: expected 7\.1\.0 x64/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

console.log(`Windows installer foundation self-test: PASS (${process.platform === 'win32' ? 'static and failure-path checks' : 'portable static checks'})`);
