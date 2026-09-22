import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTemporaryAssemblyVersionSource } from './windows-assembly-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_DIR = path.join(ROOT, 'desktop', 'CourseStow.ControlPanel');
const OUTPUT_DIR = path.join(PROJECT_DIR, 'bin', 'Release');
const OUTPUT_EXE = path.join(OUTPUT_DIR, 'CourseStow.exe');
const OUTPUT_CONFIG = `${OUTPUT_EXE}.config`;
const SOURCE_FILES = [
  'BackendDiagnosticSanitizer.cs',
  'BackendClient.cs',
  'ControlPanelSelfTest.cs',
  'FolderPicker.cs',
  'InstallerMaintenance.cs',
  'InstallerMaintenanceSelfTest.cs',
  'MainForm.cs',
  'Program.cs',
  'ScheduledRunCommand.cs',
  'SetupSettingsForm.cs',
  'UpdateCheckSelfTest.cs',
  'UpdateCheckService.cs',
  'WindowsTaskScheduler.cs',
  path.join('..', 'Shared', 'CourseStowProcessIdentity.cs'),
  path.join('..', 'Shared', 'WindowsCredentialStore.cs'),
  path.join('Properties', 'AssemblyInfo.cs')
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

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      windowsHide: true
    });
    child.once('error', error => reject(new Error(`C# compiler could not start: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`C# compiler failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`));
    });
  });
}

async function locateFrameworkCompiler() {
  const windowsRoot = process.env.WINDIR || process.env.SystemRoot;
  if (!windowsRoot) throw new Error('The Windows directory is unavailable.');
  for (const framework of ['Framework64', 'Framework']) {
    const frameworkDir = path.join(windowsRoot, 'Microsoft.NET', framework, 'v4.0.30319');
    const compiler = path.join(frameworkDir, 'csc.exe');
    try {
      await requireFile(compiler, '.NET Framework C# compiler');
      return { compiler, frameworkDir };
    } catch {}
  }
  throw new Error('.NET Framework 4.x C# compiler was not found. Install the .NET Framework 4.8 developer tools.');
}

async function build() {
  if (process.platform !== 'win32') throw new Error('The Windows control panel must be built on Windows.');
  if (!isInside(PROJECT_DIR, OUTPUT_DIR)) throw new Error(`Refusing to clean an unsafe control-panel output path: ${OUTPUT_DIR}`);

  const manifest = path.join(PROJECT_DIR, 'app.manifest');
  const appConfig = path.join(PROJECT_DIR, 'App.config');
  for (const [file, label] of [
    [path.join(PROJECT_DIR, 'CourseStow.ControlPanel.csproj'), 'WinForms project'],
    [manifest, 'application manifest'],
    [appConfig, 'application configuration'],
    ...SOURCE_FILES.map(name => [path.join(PROJECT_DIR, name), `control-panel source ${name}`])
  ]) await requireFile(file, label);

  const { compiler, frameworkDir } = await locateFrameworkCompiler();
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const references = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Net.Http.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll', 'Microsoft.CSharp.dll']
    .map(name => `/reference:${path.join(frameworkDir, name)}`);
  const generatedVersion = await createTemporaryAssemblyVersionSource(ROOT, 'control-panel');
  try {
    await run(compiler, [
      '/nologo',
      '/target:winexe',
      '/platform:anycpu',
      '/optimize+',
      '/debug-',
      `/out:${OUTPUT_EXE}`,
      `/win32manifest:${manifest}`,
      ...references,
      ...SOURCE_FILES.map(name => path.join(PROJECT_DIR, name)),
      generatedVersion.sourceFile
    ]);
  } finally {
    await generatedVersion.cleanup();
  }
  await fs.copyFile(appConfig, OUTPUT_CONFIG);
  await requireFile(OUTPUT_EXE, 'compiled CourseStow control panel');
  await requireFile(OUTPUT_CONFIG, 'compiled control-panel runtime configuration');
  console.log(`Windows control panel ${generatedVersion.packageVersion} created: ${OUTPUT_EXE}`);
}

build().catch(error => {
  console.error(`Windows control-panel build failed: ${error.message}`);
  process.exitCode = 1;
});
