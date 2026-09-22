import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { acquireSyncLock, inspectSyncLock } from './sync-lock.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brightspace-lock-selftest-'));
try {
  const first = await acquireSyncLock(root, { mode: 'quick' });
  if (!first.acquired) throw new Error('first lock was not acquired');

  const second = await acquireSyncLock(root, { mode: 'full' });
  if (second.acquired || second.reason !== 'another-run-active') throw new Error('second lock should have been blocked');

  await first.release();

  const third = await acquireSyncLock(root, { mode: 'publish' });
  if (!third.acquired) throw new Error('lock was not available after release');
  await third.release();

  const staleFile = path.join(root, '.coursestow.lock');
  await fs.writeFile(staleFile, JSON.stringify({ pid: 99999999, mode: 'stale', startedAt: '2000-01-01T00:00:00.000Z' }));
  const recovered = await acquireSyncLock(root, { mode: 'quick' });
  if (!recovered.acquired) throw new Error('stale lock was not recovered');
  await recovered.release();

  assert.equal((await inspectSyncLock(root)).active, false, 'a missing lock must not be active');

  await fs.writeFile(staleFile, JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    mode: 'quick',
    startedAt: new Date().toISOString()
  }));
  const liveSameHost = await inspectSyncLock(root);
  assert.equal(liveSameHost.active, true, 'a live same-host PID must be active');
  assert.equal(liveSameHost.existing?.mode, 'quick');

  await fs.writeFile(staleFile, JSON.stringify({
    pid: 2147483647,
    hostname: os.hostname(),
    mode: 'full',
    startedAt: new Date().toISOString()
  }));
  assert.equal((await inspectSyncLock(root)).active, false, 'a dead same-host PID must be stale immediately');

  await fs.writeFile(staleFile, JSON.stringify({
    pid: 42,
    hostname: 'different-host.invalid',
    mode: 'scheduled',
    startedAt: new Date().toISOString()
  }));
  assert.equal((await inspectSyncLock(root, { staleAfterHours: 1 })).active, true, 'a fresh foreign lock must remain active');

  await fs.writeFile(staleFile, JSON.stringify({
    pid: 42,
    hostname: 'different-host.invalid',
    mode: 'scheduled',
    startedAt: '2000-01-01T00:00:00.000Z'
  }));
  assert.equal((await inspectSyncLock(root, { staleAfterHours: 1 })).active, false, 'an old foreign lock must be stale');

  await fs.writeFile(staleFile, 'malformed lock');
  assert.equal((await inspectSyncLock(root, { staleAfterHours: 1 })).active, true, 'a fresh malformed lock must remain active');
  const oldTime = new Date('2000-01-01T00:00:00.000Z');
  await fs.utimes(staleFile, oldTime, oldTime);
  assert.equal((await inspectSyncLock(root, { staleAfterHours: 1 })).active, false, 'an old malformed lock must be stale');
  await fs.rm(staleFile, { force: true });

  console.log('Lock self-test passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
