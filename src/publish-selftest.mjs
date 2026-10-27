import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { publishMirrorToDrive, resolveDrivePublishConfig } from './publish.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bs-publish-test-'));
const src = path.join(tmp, 'BrightspaceMirror');
const dst = path.join(tmp, 'Drive', 'Brightspace Mirror');
const stateDir = path.join(tmp, 'AppData', 'state');
await fs.mkdir(path.join(src, '2026-Fall', 'Example Course [1]'), { recursive: true });
await fs.mkdir(path.join(src, '_school'), { recursive: true });
await fs.mkdir(path.join(src, '_system'), { recursive: true });
await fs.writeFile(path.join(src, '2026-Fall', 'Example Course [1]', 'page.txt'), 'hello');
await fs.writeFile(path.join(src, '2026-Fall', 'Example Course [1]', '_sync_state.json'), '{"legacy":true}');
await fs.writeFile(path.join(src, '_school', 'current.json'), '{"ok":true}');
await fs.writeFile(path.join(src, '_system', 'secret.txt'), 'do not publish');

assert.equal(resolveDrivePublishConfig({ drivePublish: {} }).mountWaitMs, 60_000);
assert.equal(resolveDrivePublishConfig({ drivePublish: { mountWaitMs: -2 } }).mountWaitMs, 0);
assert.equal(resolveDrivePublishConfig({ drivePublish: { mountWaitMs: 999_999 } }).mountWaitMs, 300_000);

const config = {
  outputDir: src,
  systemDir: path.join(src, '_system'),
  stateDir,
  drivePublish: { enabled: true, destination: dst, deleteRemoved: true, verifyDestinationOnFull: true }
};

let r = await publishMirrorToDrive(config, 'quick');
assert.equal(r.copied, 2);
assert.equal(await fs.readFile(path.join(dst, '2026-Fall', 'Example Course [1]', 'page.txt'), 'utf8'), 'hello');
await assert.rejects(fs.access(path.join(dst, '2026-Fall', 'Example Course [1]', '_sync_state.json')));
assert.equal(await fs.readFile(path.join(src, '2026-Fall', 'Example Course [1]', '_sync_state.json'), 'utf8'), '{"legacy":true}');
assert.equal(await fs.readFile(path.join(dst, '_school', 'current.json'), 'utf8'), '{"ok":true}');
await assert.rejects(fs.access(path.join(dst, '_system', 'secret.txt')));
await fs.access(path.join(stateDir, 'drive_publish_state.json'));
await assert.rejects(fs.access(path.join(src, '_system', 'drive_publish_state.json')));

r = await publishMirrorToDrive(config, 'quick');
assert.equal(r.copied, 0);
assert.equal(r.unchanged, 2);

await new Promise(resolve => setTimeout(resolve, 20));
await fs.writeFile(path.join(src, '2026-Fall', 'Example Course [1]', 'page.txt'), 'hello2');
r = await publishMirrorToDrive(config, 'quick');
assert.equal(r.copied, 1);

// Manual recovery must verify remote files even when fingerprints are unchanged.
const copiedPage = path.join(dst, '2026-Fall', 'Example Course [1]', 'page.txt');
await fs.unlink(copiedPage);
r = await publishMirrorToDrive(config, 'manual');
assert.equal(r.verifiedMissing, 1);
assert.equal(r.copied, 1);
assert.equal(await fs.readFile(copiedPage, 'utf8'), 'hello2');

await fs.unlink(path.join(src, '_school', 'current.json'));
r = await publishMirrorToDrive(config, 'quick');
assert.equal(r.deleted, 1);
await assert.rejects(fs.access(path.join(dst, '_school', 'current.json')));

const disabled = await publishMirrorToDrive({ outputDir: src, drivePublish: { enabled: false } }, 'manual');
assert.equal(disabled.reason, 'disabled');
const missingDestination = await publishMirrorToDrive({ outputDir: src, drivePublish: { enabled: true, destination: '' } }, 'manual');
assert.equal(missingDestination.reason, 'destination-not-configured');

console.log('Drive publish self-test: PASS');
await fs.rm(tmp, { recursive: true, force: true });
