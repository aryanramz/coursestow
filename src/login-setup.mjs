import { spawn } from 'node:child_process';
import { loadAppConfig } from './config.mjs';
import { findCompatibleChromiumExecutable } from './browser.mjs';

const { config } = await loadAppConfig();
const { profileDir, baseUrl } = config;
if (!baseUrl) throw new Error(`baseUrl is missing from ${config.configFile}.`);

const browser = await findCompatibleChromiumExecutable(config.browserExecutablePath);
console.log(`Opening the dedicated CourseStow profile in ${browser.name}.`);
console.log(`Browser: ${browser.path}`);
console.log(`Profile: ${profileDir}`);
console.log(`Site:    ${baseUrl}`);
console.log('');
console.log('Sign in normally to establish an authenticated session in this dedicated browser profile.');
console.log('Saving the login in the browser password manager is optional; automatic password-manager submission is best-effort only.');
console.log('If your institution offers a trusted/remembered MFA device option, choose it only if appropriate for your own device.');
console.log('Close this browser window when you are done. CourseStow does not require a password in config.json or source code.');
console.log('Session cookies remain inside the dedicated Chromium profile; no standalone cookie/state export is created.');
console.log('');

const child = spawn(browser.path, [`--user-data-dir=${profileDir}`, '--no-default-browser-check', baseUrl], {
  detached: true,
  stdio: 'ignore',
  windowsHide: false
});
child.unref();
