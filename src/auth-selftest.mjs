import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  AUTHENTICATED_BRIGHTSPACE_SELECTOR,
  LEGACY_STONY_BROOK_CREDENTIAL_TARGET,
  STONY_BROOK_SSO_HANDOFF_SELECTOR,
  STONY_BROOK_CREDENTIAL_TARGET,
  institutionAdapterForBaseUrl,
  stonyBrookAdapter
} from './auth-adapters.mjs';
import { authenticateWithInstitutionAdapter, makeChromiumPageVisible } from './auth-flow.mjs';
import { buildSyncBrowserLaunchOptions } from './browser-launch-options.mjs';
import { createWindowsCredentialProvider, requestCredentialHelper } from './credential-helper-client.mjs';
import { runRefreshLogin } from './refresh-login.mjs';
import {
  hasAuthAttention,
  isAuthenticationAttentionError,
  runAndClearAuthAttention,
  setAuthAttention
} from './auth-attention.mjs';

const USERNAME_SELECTOR = '#username';
const PASSWORD_SELECTOR = '#password';
const SUBMIT_SELECTOR = 'button[name="_eventId_proceed"], input[name="_eventId_proceed"], #login-button';

assert.equal(STONY_BROOK_CREDENTIAL_TARGET, 'CourseStow:institution:stony-brook');
assert.equal(LEGACY_STONY_BROOK_CREDENTIAL_TARGET, 'Brightspace Sync:institution:stony-brook');

class FakeLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }
  async count() {
    if (this.selector === AUTHENTICATED_BRIGHTSPACE_SELECTOR) return this.page.authenticated ? 1 : 0;
    if (this.selector === STONY_BROOK_SSO_HANDOFF_SELECTOR) return this.page.handoffAvailable ? 1 : 0;
    if (this.selector === USERNAME_SELECTOR) return this.page.loginForm ? 1 : 0;
    if (this.selector === PASSWORD_SELECTOR) return this.page.loginForm ? 1 : 0;
    if (this.selector === SUBMIT_SELECTOR) return this.page.loginForm ? 1 : 0;
    if (this.selector.includes('password')) this.page.genericPasswordQueries++;
    return 0;
  }
  async getAttribute(name) {
    if (name === 'href' && this.selector === STONY_BROOK_SSO_HANDOFF_SELECTOR) return this.page.handoffHref;
    return null;
  }
  async fill(value) {
    this.page.fills.push({ selector: this.selector, value });
    if (this.selector === USERNAME_SELECTOR && this.page.redirectAfterUsernameFill) {
      this.page.currentUrl = 'https://unexpected.example.test/login';
    }
  }
  first() { return this; }
  async click() {
    if (this.selector === STONY_BROOK_SSO_HANDOFF_SELECTOR) {
      this.page.handoffClicks++;
      if (!this.page.handoffSticks) {
        this.page.currentUrl = this.page.handoffTarget;
        this.page.loginForm = this.page.handoffProvidesLoginForm;
      }
      return;
    }
    this.page.submits++;
    this.page.currentUrl = 'https://mycourses.stonybrook.edu/d2l/home';
    this.page.authenticated = true;
  }
}

class FakePage {
  constructor({
    url,
    authenticated = false,
    loginForm = false,
    mfaCompletes = false,
    authenticatedTarget = 'https://mycourses.stonybrook.edu/d2l/home',
    redirectAfterUsernameFill = false,
    handoffAvailable = false,
    handoffTarget = 'https://sso.cc.stonybrook.edu/idp/profile/SAML2/Redirect/SSO',
    handoffProvidesLoginForm = false,
    handoffSticks = false
  }) {
    this.currentUrl = url;
    this.authenticated = authenticated;
    this.loginForm = loginForm;
    this.mfaCompletes = mfaCompletes;
    this.authenticatedTarget = authenticatedTarget;
    this.redirectAfterUsernameFill = redirectAfterUsernameFill;
    this.handoffAvailable = handoffAvailable;
    this.handoffTarget = handoffTarget;
    this.handoffProvidesLoginForm = handoffProvidesLoginForm;
    this.handoffSticks = handoffSticks;
    this.handoffHref = '/d2l/lp/auth/saml/initiate-login?entityId=https://sso.cc.stonybrook.edu/idp/shibboleth';
    this.handoffClicks = 0;
    this.fills = [];
    this.submits = 0;
    this.genericPasswordQueries = 0;
    this.broughtToFront = 0;
  }
  async goto() {}
  url() { return this.currentUrl; }
  locator(selector) { return new FakeLocator(this, selector); }
  frames() { return []; }
  async waitForTimeout() {
    if (this.mfaCompletes) {
      this.currentUrl = this.authenticatedTarget;
      this.authenticated = true;
    }
  }
  async bringToFront() { this.broughtToFront++; }
}

function config(overrides = {}) {
  return {
    baseUrl: 'https://mycourses.stonybrook.edu',
    navigationTimeoutMs: 1000,
    appRoot: path.resolve('app'),
    auth: { automaticLoginEnabled: true, manualLoginTimeoutMs: 1000 },
    ...overrides
  };
}

function quietLog() {
  const messages = [];
  return { messages, log(message) { messages.push(String(message)); } };
}

assert.equal(institutionAdapterForBaseUrl('https://mycourses.stonybrook.edu')?.id, 'stony-brook');
for (const unsupported of [
  'http://mycourses.stonybrook.edu',
  'https://synthetic-user:synthetic-password' + '@mycourses.stonybrook.edu',
  'https://mycourses.stonybrook.edu.evil.test',
  'https://stonybrook.example.test',
  'https://sso.cc.stonybrook.edu'
]) assert.equal(institutionAdapterForBaseUrl(unsupported), null, `unsupported Brightspace origin accepted: ${unsupported}`);
for (const untrusted of [
  'http://sso.cc.stonybrook.edu/login',
  'https://synthetic-user:synthetic-password' + '@sso.cc.stonybrook.edu/login',
  'https://sso.cc.stonybrook.edu.evil.test/login',
  'https://stonybrook.example.test/login'
]) assert.equal(stonyBrookAdapter.isTrustedSsoUrl(untrusted), false, `untrusted SSO origin accepted: ${untrusted}`);

const validSessionPage = new FakePage({ url: 'https://mycourses.stonybrook.edu/d2l/home', authenticated: true });
let validSessionReads = 0;
const validSession = await authenticateWithInstitutionAdapter({
  page: validSessionPage,
  context: {},
  config: config(),
  credentialProvider: { async read() { validSessionReads++; return null; } },
  makeVisible: async () => { throw new Error('valid session must not become visible'); },
  log: quietLog()
});
assert.equal(validSession.authenticated, true);
assert.equal(validSessionReads, 0, 'a persistent valid session must not retrieve credentials');

for (const url of [
  'https://mycourses.stonybrook.edu.evil.test',
  'http://mycourses.stonybrook.edu',
  'https://synthetic-user:synthetic-password' + '@mycourses.stonybrook.edu/d2l/home'
]) {
  const fakeAuthenticatedPage = new FakePage({ url, authenticated: true });
  let reads = 0;
  await assert.rejects(authenticateWithInstitutionAdapter({
    page: fakeAuthenticatedPage,
    context: {},
    config: config(),
    credentialProvider: { async read() { reads++; return null; } },
    makeVisible: async () => {},
    log: quietLog(),
    timeoutMs: 50,
    pollMs: 0
  }), /unexpected authentication host/i);
  assert.equal(reads, 0, 'authenticated-looking DOM on an untrusted origin must not retrieve credentials');
}

const fakeUsername = 'SyntheticStudent';
const fakePassword = 'SyntheticPasswordValue123';
const trustedPage = new FakePage({ url: 'https://sso.cc.stonybrook.edu/idp/profile/SAML2/Redirect/SSO', loginForm: true });
let trustedReads = 0;
const trustedLog = quietLog();
const trusted = await authenticateWithInstitutionAdapter({
  page: trustedPage,
  context: {},
  config: config(),
  credentialProvider: {
    async read(target) {
      trustedReads++;
      assert.equal(target, STONY_BROOK_CREDENTIAL_TARGET);
      return { username: fakeUsername, password: fakePassword };
    }
  },
  makeVisible: async () => { throw new Error('credential-only login should stay unobtrusive'); },
  log: trustedLog,
  pollMs: 0
});
assert.equal(trusted.authenticated, true);
assert.equal(trustedReads, 1);
assert.deepEqual(trustedPage.fills, [
  { selector: USERNAME_SELECTOR, value: fakeUsername },
  { selector: PASSWORD_SELECTOR, value: fakePassword }
]);
assert.equal(trustedPage.submits, 1);
assert.equal(trustedLog.messages.join('\n').includes(fakePassword), false);
assert.equal(trustedLog.messages.join('\n').includes(fakeUsername), false);

const handoffPage = new FakePage({
  url: 'https://mycourses.stonybrook.edu/d2l/login',
  handoffAvailable: true,
  handoffProvidesLoginForm: true
});
let handoffReads = 0;
const handoffResult = await authenticateWithInstitutionAdapter({
  page: handoffPage,
  context: {},
  config: config(),
  credentialProvider: {
    async read() {
      handoffReads++;
      assert.equal(stonyBrookAdapter.isTrustedSsoUrl(handoffPage.url()), true, 'credential read occurred before trusted SSO');
      return { username: fakeUsername, password: fakePassword };
    }
  },
  makeVisible: async () => {},
  log: quietLog(),
  pollMs: 0
});
assert.equal(handoffResult.authenticated, true);
assert.equal(handoffPage.handoffClicks, 1, 'institutional handoff must be initiated exactly once');
assert.equal(handoffReads, 1);

const wrongHandoffPage = new FakePage({
  url: 'https://mycourses.stonybrook.edu/d2l/login',
  handoffAvailable: true,
  handoffTarget: 'https://sso.cc.stonybrook.edu.evil.test/login',
  handoffProvidesLoginForm: true
});
let wrongHandoffReads = 0;
await assert.rejects(authenticateWithInstitutionAdapter({
  page: wrongHandoffPage,
  context: {},
  config: config(),
  credentialProvider: { async read() { wrongHandoffReads++; return null; } },
  makeVisible: async () => {},
  log: quietLog(),
  pollMs: 0
}), /unexpected authentication host/i);
assert.equal(wrongHandoffPage.handoffClicks, 1);
assert.equal(wrongHandoffReads, 0, 'wrong handoff destination must fail before credential access');

const stuckHandoffPage = new FakePage({
  url: 'https://mycourses.stonybrook.edu/d2l/login',
  handoffAvailable: true,
  handoffSticks: true
});
await assert.rejects(authenticateWithInstitutionAdapter({
  page: stuckHandoffPage,
  context: {},
  config: config(),
  credentialProvider: { async read() { throw new Error('credential read must not occur'); } },
  makeVisible: async () => {},
  log: quietLog(),
  pollMs: 0
}), /handoff did not complete/i);
assert.equal(stuckHandoffPage.handoffClicks, 1, 'a stalled handoff must never be clicked repeatedly');

const missingHandoffPage = new FakePage({ url: 'https://mycourses.stonybrook.edu/d2l/login' });
await assert.rejects(authenticateWithInstitutionAdapter({
  page: missingHandoffPage,
  context: {},
  config: config(),
  credentialProvider: { async read() { throw new Error('credential read must not occur'); } },
  makeVisible: async () => {},
  log: quietLog(),
  pollMs: 0
}), /control was not recognized.*Refresh Login/i);

const credentialFailurePage = new FakePage({ url: 'https://sso.cc.stonybrook.edu/login', loginForm: true });
const credentialFailureLog = quietLog();
const credentialFailure = await authenticateWithInstitutionAdapter({
  page: credentialFailurePage,
  context: {},
  config: config(),
  credentialProvider: { async read() { throw new Error(fakePassword); } },
  makeVisible: async () => {},
  log: credentialFailureLog,
  pollMs: 0
}).then(() => null, error => error);
assert.ok(credentialFailure instanceof Error);
assert.equal(isAuthenticationAttentionError(credentialFailure), true);
assert.equal(credentialFailure.message.includes(fakePassword), false);
assert.equal(credentialFailure.message.includes(fakeUsername), false);
assert.equal(credentialFailureLog.messages.join('\n').includes(fakePassword), false);
assert.equal(credentialFailurePage.fills.length, 0);

const redirectRacePage = new FakePage({
  url: 'https://sso.cc.stonybrook.edu/login',
  loginForm: true,
  redirectAfterUsernameFill: true
});
await assert.rejects(authenticateWithInstitutionAdapter({
  page: redirectRacePage,
  context: {},
  config: config(),
  credentialProvider: { async read() { return { username: fakeUsername, password: fakePassword }; } },
  makeVisible: async () => {},
  log: quietLog(),
  pollMs: 0
}), /could not use the saved Windows credential/i);
assert.deepEqual(redirectRacePage.fills.map(item => item.selector), [USERNAME_SELECTOR], 'origin must be revalidated before filling the password');

for (const url of [
  'https://sso.cc.stonybrook.edu.evil.test/login',
  'https://stonybrook.example.test/login',
  'http://sso.cc.stonybrook.edu/login'
]) {
  const page = new FakePage({ url, loginForm: true });
  let reads = 0;
  await assert.rejects(authenticateWithInstitutionAdapter({
    page,
    context: {},
    config: config(),
    credentialProvider: { async read() { reads++; return { username: fakeUsername, password: fakePassword }; } },
    makeVisible: async () => {},
    log: quietLog(),
    timeoutMs: 50,
    pollMs: 0
  }), /unexpected authentication host/i);
  assert.equal(reads, 0, 'untrusted origin must not retrieve credentials');
  assert.equal(page.fills.length, 0, 'untrusted origin must not receive credentials');
}

const genericPasswordPage = new FakePage({
  url: 'https://generic.example.test/login',
  loginForm: true,
  mfaCompletes: true,
  authenticatedTarget: 'https://generic.example.test/d2l/home'
});
let genericReads = 0;
await authenticateWithInstitutionAdapter({
  page: genericPasswordPage,
  context: {},
  config: config({ baseUrl: 'https://generic.example.test', auth: { automaticLoginEnabled: false, manualLoginTimeoutMs: 1000 } }),
  credentialProvider: { async read() { genericReads++; return null; } },
  makeVisible: async () => {},
  log: quietLog(),
  pollMs: 0
});
assert.equal(genericReads, 0);
assert.equal(genericPasswordPage.fills.length, 0, 'generic password fields must never be filled');

const mfaPage = new FakePage({ url: 'https://api-123.duosecurity.com/frame/v4/auth', mfaCompletes: true });
let mfaReads = 0;
let visibleEscalations = 0;
const mfaResult = await authenticateWithInstitutionAdapter({
  page: mfaPage,
  context: {},
  config: config(),
  credentialProvider: { async read() { mfaReads++; return null; } },
  makeVisible: async () => { visibleEscalations++; },
  log: quietLog(),
  pollMs: 0
});
assert.equal(mfaResult.humanEscalation, true);
assert.equal(visibleEscalations, 1);
assert.equal(mfaReads, 0, 'MFA must not retrieve or submit credentials');

const backgroundOptions = buildSyncBrowserLaunchOptions(
  config({ headless: true, auth: { automaticLoginEnabled: false } }),
  path.resolve('Browser', 'browser.exe')
);
assert.equal(backgroundOptions.headless, false, 'background sync must retain a real browser window');
assert.equal(backgroundOptions.args.includes('--start-minimized'), true, 'former headless mode must start minimized');
const automaticOptions = buildSyncBrowserLaunchOptions(config({ headless: false }), path.resolve('Browser', 'browser.exe'));
assert.equal(automaticOptions.headless, false);
assert.equal(automaticOptions.args.includes('--start-minimized'), true, 'automatic Stony Brook sign-in must start minimized');
const foregroundOptions = buildSyncBrowserLaunchOptions(
  config({ headless: false, auth: { automaticLoginEnabled: false } }),
  path.resolve('Browser', 'browser.exe')
);
assert.equal(foregroundOptions.headless, false);
assert.equal(foregroundOptions.args.includes('--start-minimized'), false, 'ordinary foreground mode must not be minimized');

const visibilityCalls = [];
const visibilityPage = new FakePage({ url: 'https://api-123.duosecurity.com/frame/v4/auth' });
await makeChromiumPageVisible({
  async newCDPSession() {
    return {
      async send(method, payload) {
        visibilityCalls.push({ method, payload });
        if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
        return {};
      },
      async detach() { visibilityCalls.push({ method: 'detach' }); }
    };
  }
}, visibilityPage);
assert.deepEqual(visibilityCalls[1], {
  method: 'Browser.setWindowBounds',
  payload: { windowId: 7, bounds: { windowState: 'normal' } }
});
assert.equal(visibilityPage.broughtToFront, 1, 'human escalation must restore and focus the headed browser window');

const providerOperations = [];
const provider = createWindowsCredentialProvider({
  appRoot: path.resolve('app'),
  request: async (operation, target, options) => {
    providerOperations.push({ operation, target, options });
    if (operation === 'read') return { schemaVersion: 1, ok: true, found: true, username: fakeUsername, password: fakePassword };
    return { schemaVersion: 1, ok: true };
  }
});
assert.deepEqual(await provider.read(STONY_BROOK_CREDENTIAL_TARGET), { username: fakeUsername, password: fakePassword });
await provider.write(STONY_BROOK_CREDENTIAL_TARGET, fakeUsername, fakePassword);
await provider.delete(STONY_BROOK_CREDENTIAL_TARGET);
assert.deepEqual(providerOperations.map(item => item.operation), ['read', 'write', 'delete']);

let capturedLaunch;
const helperRead = requestCredentialHelper('read', STONY_BROOK_CREDENTIAL_TARGET, {
  appRoot: path.resolve('Bundle', 'app'),
  spawnProcess(executable, args, options) {
    capturedLaunch = { executable, args, options };
    const child = new EventEmitter();
    child.kill = () => {};
    const pipe = net.createConnection({ path: `\\\\.\\pipe\\${args[1]}`, allowHalfOpen: true });
    let requestText = '';
    let responded = false;
    pipe.setEncoding('utf8');
    pipe.on('data', chunk => {
      requestText += chunk;
      if (responded || !requestText.includes('\n')) return;
      responded = true;
      const request = JSON.parse(requestText);
      assert.equal(request.operation, 'read');
      pipe.end(JSON.stringify({ schemaVersion: 1, ok: true, found: true, username: fakeUsername, password: fakePassword }));
      setImmediate(() => child.emit('exit', 0));
    });
    return child;
  }
});
const helperResponse = await helperRead;
assert.equal(helperResponse.password, fakePassword);
assert.deepEqual(capturedLaunch.args.slice(0, 1), ['--pipe']);
assert.equal(capturedLaunch.args.some(value => value.includes(fakeUsername) || value.includes(fakePassword)), false);
assert.equal(JSON.stringify(capturedLaunch.options).includes(fakePassword), false);
assert.equal(capturedLaunch.options.stdio, 'ignore');

const safeHelperFailure = await requestCredentialHelper('read', STONY_BROOK_CREDENTIAL_TARGET, {
  appRoot: path.resolve('Bundle', 'app'),
  spawnProcess() { throw new Error(fakePassword); }
}).then(() => null, error => error);
assert.ok(safeHelperFailure instanceof Error);
assert.equal(safeHelperFailure.message.includes(fakePassword), false);
assert.equal(safeHelperFailure.message.includes(fakeUsername), false);

const refreshProfile = path.resolve('External Runtime Data', 'BrowserProfile');
const attentionTestRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brightspace-auth-attention-'));
const refreshState = path.join(attentionTestRoot, 'state');
await setAuthAttention(refreshState);
let refreshLaunch;
let refreshAuthenticated = 0;
let refreshVisible = 0;
let refreshClosed = 0;
let refreshReleased = 0;
const refreshPage = new FakePage({ url: 'https://mycourses.stonybrook.edu/d2l/home', authenticated: true });
await runRefreshLogin({
  loadConfig: async () => ({
    config: {
      baseUrl: 'https://mycourses.stonybrook.edu',
      profileDir: refreshProfile,
      stateDir: refreshState,
      browserExecutablePath: '',
      navigationTimeoutMs: 1000,
      auth: { manualLoginTimeoutMs: 1000 }
    },
    paths: { lockDir: path.resolve('External Runtime Data', 'state') }
  }),
  acquireLock: async () => ({ acquired: true, async release() { refreshReleased++; } }),
  findBrowser: () => ({ name: 'Synthetic Installed Browser', path: path.resolve('Browser', 'browser.exe') }),
  launchPersistentContext: async (profileDir, options) => {
    refreshLaunch = { profileDir, options };
    return {
      pages: () => [refreshPage],
      async newPage() { return refreshPage; },
      async close() { refreshClosed++; }
    };
  },
  authenticate: async options => {
    refreshAuthenticated++;
    assert.equal(options.allowAutomatic, false);
  },
  makeVisible: async () => { refreshVisible++; },
  log: quietLog()
});
assert.equal(refreshLaunch.profileDir, refreshProfile, 'Refresh Login must use the persistent runtime profile');
assert.equal(refreshLaunch.options.headless, false, 'Refresh Login must open a visible browser');
assert.equal(refreshAuthenticated, 1);
assert.equal(refreshVisible, 1);
assert.equal(refreshClosed, 1);
assert.equal(refreshReleased, 1);
assert.equal(await hasAuthAttention(refreshState), false, 'successful Refresh Login must clear auth attention');

await setAuthAttention(refreshState);
let manualSyncRuns = 0;
await runAndClearAuthAttention(async () => { manualSyncRuns += 1; }, refreshState);
assert.equal(manualSyncRuns, 1);
assert.equal(await hasAuthAttention(refreshState), false, 'successful manual Quick/Full wrapper must clear auth attention');
await fs.rm(attentionTestRoot, { recursive: true, force: true });

const allTestOutput = JSON.stringify({ trustedLog: trustedLog.messages, capturedLaunch });
assert.equal(allTestOutput.includes(fakeUsername), false);
assert.equal(allTestOutput.includes(fakePassword), false);
console.log('Authentication adapter and credential transport self-test: PASS');
