import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTemporaryAssemblyVersionSource } from './windows-assembly-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_DIR = path.join(ROOT, 'desktop', 'CourseStow.CredentialHelper');
const OUTPUT_DIR = path.join(PROJECT_DIR, 'bin', 'Release');
const OUTPUT_EXE = path.join(OUTPUT_DIR, 'CourseStow Credential Helper.exe');
const OUTPUT_CONFIG = `${OUTPUT_EXE}.config`;
const SOURCE_FILES = [
  path.join(PROJECT_DIR, 'Program.cs'),
  path.join(ROOT, 'desktop', 'Shared', 'CourseStowProcessIdentity.cs'),
  path.join(ROOT, 'desktop', 'Shared', 'WindowsCredentialStore.cs'),
  path.join(PROJECT_DIR, 'Properties', 'AssemblyInfo.cs')
];

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function requireFile(file, label) {
  let stat;
  try { stat = await fs.stat(file); } catch {}
  if (!stat?.isFile()) throw new Error(`Required ${label} is missing: ${file}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: PROJECT_DIR, stdio: 'inherit', windowsHide: true });
    child.once('error', error => reject(new Error(`C# compiler could not start: ${error.message}`)));
    child.once('exit', (code, signal) => code === 0 && !signal
      ? resolve()
      : reject(new Error(`C# compiler failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`)));
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
  throw new Error('.NET Framework 4.x C# compiler was not found.');
}

async function build() {
  if (process.platform !== 'win32') throw new Error('The credential helper must be built on Windows.');
  if (!isInside(PROJECT_DIR, OUTPUT_DIR)) throw new Error(`Refusing to clean an unsafe credential-helper output path: ${OUTPUT_DIR}`);
  const manifest = path.join(PROJECT_DIR, 'app.manifest');
  const appConfig = path.join(PROJECT_DIR, 'App.config');
  for (const [file, label] of [
    [path.join(PROJECT_DIR, 'CourseStow.CredentialHelper.csproj'), 'credential-helper project'],
    [manifest, 'credential-helper manifest'],
    [appConfig, 'credential-helper configuration'],
    ...SOURCE_FILES.map(file => [file, `credential-helper source ${path.basename(file)}`])
  ]) await requireFile(file, label);

  const { compiler, frameworkDir } = await locateFrameworkCompiler();
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const references = ['System.dll', 'System.Core.dll', 'System.Web.Extensions.dll']
    .map(name => `/reference:${path.join(frameworkDir, name)}`);
  const generatedVersion = await createTemporaryAssemblyVersionSource(ROOT, 'credential-helper');
  try {
    await run(compiler, [
      '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/debug-',
      `/out:${OUTPUT_EXE}`, `/win32manifest:${manifest}`, ...references, ...SOURCE_FILES, generatedVersion.sourceFile
    ]);
  } finally {
    await generatedVersion.cleanup();
  }
  await fs.copyFile(appConfig, OUTPUT_CONFIG);
  await requireFile(OUTPUT_EXE, 'compiled credential helper');
  console.log(`Windows credential helper ${generatedVersion.packageVersion} created: ${OUTPUT_EXE}`);
}

build().catch(error => {
  console.error(`Windows credential-helper build failed: ${error.message}`);
  process.exitCode = 1;
});
