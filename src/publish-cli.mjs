import { loadAppConfig } from './config.mjs';
import { ensureDir } from './utils.mjs';
import { publishMirrorToDrive } from './publish.mjs';
import { acquireSyncLock, describeActiveLock } from './sync-lock.mjs';

async function runPublish(config) {
  const result = await publishMirrorToDrive(config, 'manual');
  if (result.skipped) {
    console.log(`Drive publish skipped: ${result.reason}.`);
    if (result.destination) console.log(`Destination: ${result.destination}`);
    return;
  }
  console.log(`Drive publish complete: ${result.copied} copied, ${result.deleted} deleted, ${result.unchanged} unchanged, ${result.failed} failed.`);
  console.log(`Destination: ${result.destination}`);
  console.log(`Duration: ${result.durationSeconds}s`);
  if (result.failed) process.exitCode = 2;
}

async function main() {
  const { config, paths } = await loadAppConfig();
  await ensureDir(paths.lockDir);
  const lock = await acquireSyncLock(paths.lockDir, { mode: 'publish' });
  if (!lock.acquired) {
    console.log(`Another CourseStow operation is already running: ${describeActiveLock(lock)}.`);
    console.log('Manual Drive publish was skipped so it cannot copy a partially-updated mirror.');
    return;
  }
  try {
    await runPublish(config);
  } finally {
    await lock.release();
  }
}

main().catch(error => {
  console.error(`\nERROR: ${error.stack || error.message}`);
  process.exitCode = 1;
});
