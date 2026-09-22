import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFile(path.join(ROOT, relative), 'utf8');
const [service, selfTest, mainForm, program, project, buildScript] = await Promise.all([
  read('desktop/CourseStow.ControlPanel/UpdateCheckService.cs'),
  read('desktop/CourseStow.ControlPanel/UpdateCheckSelfTest.cs'),
  read('desktop/CourseStow.ControlPanel/MainForm.cs'),
  read('desktop/CourseStow.ControlPanel/Program.cs'),
  read('desktop/CourseStow.ControlPanel/CourseStow.ControlPanel.csproj'),
  read('scripts/build-windows-control-panel.mjs')
]);

assert.match(service, /https:\/\/api\.github\.com\/repos\/aryanramz\/coursestow\/releases\/latest/);
assert.match(service, /CourseStow\/" \+ _currentVersion/);
assert.match(service, /TimeSpan\.FromSeconds\(5\)/);
assert.match(service, /HttpMethod\.Get/);
assert.match(service, /application\/vnd\.github\+json/);
assert.match(service, /IfNoneMatch/);
assert.doesNotMatch(service, /Headers\.Authorization\s*=/);
assert.match(service, /AutomaticInterval = TimeSpan\.FromHours\(24\)/);
assert.match(service, /File\.Replace\(temporary, _cacheFile/);
assert.match(service, /lastAttemptUtc/);
assert.match(service, /tag_name/);
assert.match(service, /root\["draft"\]/);
assert.match(service, /root\["prerelease"\]/);
assert.match(service, /BuildReleaseUrl/);
assert.doesNotMatch(service, /html_url\s+as/);
assert.match(mainForm, /Check for Updates/);
assert.match(mainForm, /StartAutomaticUpdateCheck/);
assert.match(mainForm, /if \(_closing\) return;/);
assert.match(program, /--update-check-self-test/);
assert.match(project, /System\.Net\.Http/);
assert.match(project, /UpdateCheckService\.cs/);
assert.match(project, /UpdateCheckSelfTest\.cs/);
assert.match(buildScript, /System\.Net\.Http\.dll/);
assert.match(selfTest, /automaticCheckDoesNotRetry/);
assert.match(selfTest, /manualCheckRetriesTransientFailure/);
assert.match(selfTest, /etagSentAnd304Reused/);
assert.match(selfTest, /updateCompletionAfterCloseIgnored/);

if (process.argv.includes('--require-built')) {
  assert.equal(process.platform, 'win32', '--require-built update-check testing requires Windows');
  const executable = path.join(ROOT, 'dist', 'CourseStow', 'CourseStow.exe');
  const stat = await fs.stat(executable);
  assert.equal(stat.isFile(), true, 'packaged CourseStow.exe is required');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'coursestow update selftest '));
  try {
    const output = path.join(temp, 'result.json');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--update-check-self-test', output], {
        cwd: temp,
        env: { ...process.env, COURSESTOW_DATA_DIR: path.join(temp, 'external data') },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(report.schemaVersion, 1);
    for (const [name, passed] of Object.entries(report).filter(([name]) => name !== 'schemaVersion'))
      assert.equal(passed, true, `compiled update-check assertion failed: ${name}`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

console.log('CourseStow update-check self-test passed.');
