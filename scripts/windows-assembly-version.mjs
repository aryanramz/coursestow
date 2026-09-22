import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_ASSEMBLY_VERSION_COMPONENT = 65534;

export async function createTemporaryAssemblyVersionSource(repositoryRoot, buildLabel) {
  const packageFile = path.join(repositoryRoot, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(await fs.readFile(packageFile, 'utf8'));
  } catch (error) {
    throw new Error(`Authoritative package metadata could not be read: ${error.message}`);
  }

  const packageVersion = String(packageJson.version ?? '');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageVersion);
  if (!match) throw new Error(`Authoritative package version is not a three-part numeric Windows assembly version: ${packageVersion}`);
  const components = match.slice(1).map(Number);
  if (components.some(value => value > MAX_ASSEMBLY_VERSION_COMPONENT)) {
    throw new Error(`Authoritative package version contains a Windows assembly component above ${MAX_ASSEMBLY_VERSION_COMPONENT}: ${packageVersion}`);
  }

  const assemblyVersion = `${packageVersion}.0`;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `coursestow-${buildLabel}-assembly-version-`));
  const sourceFile = path.join(temporaryDirectory, 'AssemblyVersion.g.cs');
  const source = [
    'using System.Reflection;',
    '',
    `[assembly: AssemblyVersion("${assemblyVersion}")]`,
    `[assembly: AssemblyFileVersion("${assemblyVersion}")]`,
    `[assembly: AssemblyInformationalVersion("${packageVersion}")]`,
    ''
  ].join('\n');
  await fs.writeFile(sourceFile, source, 'utf8');

  return {
    packageVersion,
    assemblyVersion,
    sourceFile,
    cleanup: () => fs.rm(temporaryDirectory, { recursive: true, force: true })
  };
}
