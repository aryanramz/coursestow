import net from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { STONY_BROOK_CREDENTIAL_TARGET } from './auth-adapters.mjs';

const MAX_RESPONSE_BYTES = 64 * 1024;
const ALLOWED_TARGETS = new Set([STONY_BROOK_CREDENTIAL_TARGET]);

function helperExecutable(appRoot) {
  const packaged = path.resolve(appRoot, '..', 'CourseStow Credential Helper.exe');
  if (existsSync(packaged)) return packaged;
  return path.resolve(
    appRoot,
    'desktop',
    'CourseStow.CredentialHelper',
    'bin',
    'Release',
    'CourseStow Credential Helper.exe'
  );
}

function safeHelperError() {
  return new Error('Windows could not access the saved Brightspace credential. Use Settings to replace or remove it.');
}

export async function requestCredentialHelper(operation, target, {
  appRoot,
  username = '',
  password = '',
  timeoutMs = 15_000,
  spawnProcess = spawn
} = {}) {
  if (!['probe', 'read', 'write', 'delete'].includes(operation) || !ALLOWED_TARGETS.has(target)) throw safeHelperError();
  const pipeName = `CourseStow-Credential-${process.pid}-${randomUUID()}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  let request = JSON.stringify({ schemaVersion: 1, operation, target, username, password });
  username = '';
  password = '';

  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(safeHelperError());
      else resolve(value);
    };
    const server = net.createServer(socket => {
      let bytes = 0;
      const chunks = [];
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          socket.destroy();
          finish(new Error('oversized response'));
          return;
        }
        chunks.push(chunk);
      });
      socket.once('error', error => finish(error));
      socket.once('end', () => {
        let responseText = '';
        try {
          responseText = chunks.join('');
          chunks.fill('');
          const response = JSON.parse(responseText);
          responseText = '';
          if (response?.schemaVersion !== 1 || response?.ok !== true) throw new Error('invalid helper response');
          finish(null, response);
        } catch (error) {
          chunks.fill('');
          responseText = '';
          finish(error);
        }
      });
      socket.write(`${request}\n`);
      request = '';
    });
    server.once('error', error => finish(error));
    const timer = setTimeout(() => {
      try { child?.kill(); } catch {}
      finish(new Error('credential helper timeout'));
    }, timeoutMs);
    server.listen(pipePath, () => {
      try {
        const executable = helperExecutable(appRoot);
        child = spawnProcess(executable, ['--pipe', pipeName], {
          cwd: path.dirname(executable),
          windowsHide: true,
          stdio: 'ignore'
        });
        child.once('error', error => finish(error));
        child.once('exit', code => {
          if (!settled && code !== 0) finish(new Error('credential helper failed'));
        });
      } catch (error) {
        finish(error);
      }
    });
  });
}

export function createWindowsCredentialProvider({ appRoot, request = requestCredentialHelper } = {}) {
  return {
    async read(target) {
      const response = await request('read', target, { appRoot });
      if (!response.found || typeof response.username !== 'string' || typeof response.password !== 'string') return null;
      return { username: response.username, password: response.password };
    },
    async write(target, username, password) {
      await request('write', target, { appRoot, username, password });
    },
    async delete(target) {
      await request('delete', target, { appRoot });
    }
  };
}
