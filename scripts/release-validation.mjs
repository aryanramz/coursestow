import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_COMPONENT = 2147483647;

export function parseStableReleaseTag(tag) {
  const match = /^(?:v)((?:0|[1-9][0-9]*))\.((?:0|[1-9][0-9]*))\.((?:0|[1-9][0-9]*))$/.exec(tag ?? '');
  if (!match) throw new Error('Release tag must use exact stable form vMAJOR.MINOR.PATCH.');
  const components = match.slice(1).map(value => Number(value));
  if (components.some(value => !Number.isSafeInteger(value) || value > MAX_COMPONENT))
    throw new Error('Release tag contains an unsupported numeric component.');
  return components.join('.');
}

export function validateTagMatchesPackage(tag, packageVersion) {
  const tagVersion = parseStableReleaseTag(tag);
  if (tagVersion !== packageVersion)
    throw new Error(`Release tag ${tag} does not match package.json version ${packageVersion}.`);
  return tagVersion;
}

export function expectedReleaseArtifactNames(version) {
  const base = `CourseStow-${version}-Setup.exe`;
  return [base, `${base}.sha256`];
}

async function sha256(file) {
  const bytes = await fs.readFile(file);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function validateReleaseArtifacts(directory, version) {
  const expected = expectedReleaseArtifactNames(version);
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(entries) !== JSON.stringify(sortedExpected))
    throw new Error(`Release artifact directory must contain exactly: ${expected.join(', ')}.`);

  const installer = path.join(directory, expected[0]);
  const sidecar = path.join(directory, expected[1]);
  const actual = await sha256(installer);
  const checksumText = await fs.readFile(sidecar, 'ascii');
  const required = `${actual}  ${expected[0]}`;
  if (checksumText !== required)
    throw new Error('Release installer SHA-256 sidecar is invalid or does not match the installer.');
  return { installer, sidecar, checksumLine: required };
}

export function releaseNotes(tag, checksumLine) {
  return [
    `# CourseStow ${tag}`,
    '',
    'Download the Windows setup executable and verify it with the attached SHA-256 sidecar.',
    '',
    'SHA-256:',
    '```text',
    checksumLine,
    '```',
    ''
  ].join('\n');
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (index + 1 >= args.length || args[index + 1].startsWith('--'))
    throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (packageJson.name !== 'coursestow') throw new Error('package.json name must remain coursestow.');
  const tag = readOption(args, '--tag') ?? process.env.GITHUB_REF_NAME;
  if (!tag) throw new Error('A release tag is required through --tag or GITHUB_REF_NAME.');
  const version = validateTagMatchesPackage(tag, packageJson.version);
  const artifactDirectory = readOption(args, '--artifacts');
  const notesFile = readOption(args, '--write-notes');
  let artifacts = null;
  if (artifactDirectory) artifacts = await validateReleaseArtifacts(path.resolve(artifactDirectory), version);
  if (notesFile) {
    if (!artifacts) throw new Error('--write-notes requires --artifacts.');
    await fs.writeFile(path.resolve(notesFile), releaseNotes(tag, artifacts.checksumLine), 'utf8');
  }
  console.log(`Validated CourseStow stable release contract for ${tag}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Release validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
