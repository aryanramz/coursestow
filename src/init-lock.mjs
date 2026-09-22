import { acquireProcessLock, describeProcessLock } from './process-lock.mjs';

export const INIT_LOCK_FILE_NAME = '.coursestow-init.lock';
export const DEFAULT_INIT_LOCK_WAIT_MS = 30_000;
export const DEFAULT_INIT_LOCK_STALE_MS = 60 * 60 * 1000;

export function acquireInitializationLock(paths, {
  waitMs = DEFAULT_INIT_LOCK_WAIT_MS,
  pollMs = 100,
  staleAfterMs = DEFAULT_INIT_LOCK_STALE_MS
} = {}) {
  return acquireProcessLock(paths.stateDir, {
    fileName: INIT_LOCK_FILE_NAME,
    mode: 'initialization',
    waitMs,
    pollMs,
    staleAfterMs
  });
}

export function initializationLockError(lock) {
  return new Error(
    `Timed out after ${lock?.waitedMs ?? DEFAULT_INIT_LOCK_WAIT_MS}ms waiting for CourseStow initialization: ${describeProcessLock(lock)}.`
  );
}
