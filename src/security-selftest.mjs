import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
if (packageMetadata.name !== 'coursemirror' || packageMetadata.version !== '3.0.0') {
  throw new Error('Package identity must be CourseMirror 3.0.0 for Windows v3 finalization.');
}
if (packageMetadata.repository?.url !== 'https://github.com/aryanramz/coursemirror.git') {
  throw new Error('Package repository metadata must use the canonical CourseMirror repository.');
}
const readme = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8');
const requiredDisclaimer = 'CourseMirror is an unofficial third-party utility for D2L Brightspace. It is not affiliated with or endorsed by D2L Corporation.';
if (!readme.includes(requiredDisclaimer)) throw new Error('README is missing the CourseMirror third-party disclaimer.');
if (!readme.includes('CourseMirror — for D2L Brightspace')) throw new Error('README is missing the CourseMirror tagline.');
if (/github\.com\/aryanramz\/brightspace-sync/i.test(readme)) throw new Error('README still uses the former repository URL.');
const brightspaceUrlSource = await fs.readFile(path.join(ROOT, 'src', 'brightspace-url.mjs'), 'utf8');
if (!brightspaceUrlSource.includes('normalizeBrightspaceBaseUrl')) {
  throw new Error('External D2L Brightspace URL terminology was incorrectly renamed.');
}
const ignore = await fs.readFile(path.join(ROOT, '.gitignore'), 'utf8');
for (const required of ['.brightspace-profile/', 'BrightspaceMirror/', 'config.json', '.env']) {
  if (!ignore.includes(required)) throw new Error(`.gitignore is missing sensitive path: ${required}`);
}

const example = JSON.parse(await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8'));
if (example.configVersion !== 1) {
  throw new Error('config.example.json must declare configVersion 1.');
}
const exampleText = JSON.stringify(example).toLowerCase();
for (const forbidden of ['"password"', '"passwd"', '"secret"', '"username"']) {
  if (exampleText.includes(forbidden)) throw new Error(`config.example.json contains a credential-like field: ${forbidden}`);
}
if (/https?:\/\/(?:mycourses\.)?[a-z0-9.-]+\.edu/i.test(String(example.baseUrl || ''))) {
  throw new Error('config.example.json must not ship with a real institution .edu Brightspace URL.');
}
if (example.captureNetwork !== false) {
  throw new Error('config.example.json must keep raw network capture disabled by default.');
}
if (example.drivePublish?.enabled !== false || example.drivePublish?.destination) {
  throw new Error('config.example.json must keep Drive publishing opt-in with no assumed destination.');
}
if (Object.hasOwn(example, 'profileDir')) {
  throw new Error('config.example.json must not allow the browser profile to be placed beside application files.');
}

const indexSource = await fs.readFile(path.join(ROOT, 'src', 'index.mjs'), 'utf8');
if (/\.storageState\s*\(/.test(indexSource) || /\.addCookies\s*\(/.test(indexSource)) {
  throw new Error('src/index.mjs must not export or manually restore standalone browser auth state.');
}

const secretPatterns = [
  { name: 'Windows user-profile path', re: /C:\\Users\\[^\\\s]+/i },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'OpenAI-style API key', re: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub personal token', re: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: 'private key material', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'institution email address', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.edu\b/i },
  { name: 'student-ID-like field', re: /\b(?:student|empl|banner)[ _-]?(?:id|number)\b.{0,24}[=: ]+\d{7,12}\b/i }
];

async function walk(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', '.brightspace-profile', 'BrightspaceMirror'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

for (const file of await walk(ROOT)) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
  for (const pattern of secretPatterns) {
    if (pattern.re.test(text)) throw new Error(`${path.relative(ROOT, file)} contains ${pattern.name}.`);
  }
}

console.log('Security self-test: PASS (sensitive local paths ignored; public defaults generic; no standalone auth export or common secret/academic-PII patterns detected).');
