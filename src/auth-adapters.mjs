export const STONY_BROOK_ADAPTER_ID = 'stony-brook';
export const STONY_BROOK_CREDENTIAL_TARGET = 'CourseStow:institution:stony-brook';
export const LEGACY_STONY_BROOK_CREDENTIAL_TARGET = 'Brightspace Sync:institution:stony-brook';

const AUTHENTICATED_SELECTOR = '[data-prl*="/courseSelector/"], [data-cprl*="/courseSelector/"], a[href*="/d2l/home/"]';
const STONY_BROOK_USERNAME_SELECTOR = '#username';
const STONY_BROOK_PASSWORD_SELECTOR = '#password';
const STONY_BROOK_SUBMIT_SELECTOR = 'button[name="_eventId_proceed"], input[name="_eventId_proceed"], #login-button';
const STONY_BROOK_HANDOFF_SELECTOR = 'a[href*="/d2l/lp/auth/saml/initiate-login"]';
const STONY_BROOK_HANDOFF_PATH = '/d2l/lp/auth/saml/initiate-login';
const STONY_BROOK_HANDOFF_ENTITY_ID = 'https://sso.cc.stonybrook.edu/idp/shibboleth';

function safeUrl(value) {
  try { return new URL(value); } catch { return null; }
}

function exactHttpsHost(value, hostname) {
  const url = safeUrl(value);
  return Boolean(
    url
    && url.protocol === 'https:'
    && !url.username
    && !url.password
    && url.hostname.toLowerCase() === hostname
  );
}

export function isTrustedBrightspaceUrl(value, configuredBaseUrl) {
  const current = safeUrl(value);
  const configured = safeUrl(configuredBaseUrl);
  return Boolean(
    current
    && configured
    && current.protocol === 'https:'
    && configured.protocol === 'https:'
    && !current.username
    && !current.password
    && !configured.username
    && !configured.password
    && current.origin.toLowerCase() === configured.origin.toLowerCase()
  );
}

function isDuoHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'duosecurity.com' || host.endsWith('.duosecurity.com');
}

async function count(page, selector) {
  try { return await page.locator(selector).count(); } catch { return 0; }
}

function isRecognizedStonyBrookHandoff(value, pageUrl) {
  try {
    const url = new URL(value, pageUrl);
    const keys = [...url.searchParams.keys()];
    return exactHttpsHost(url.href, 'mycourses.stonybrook.edu')
      && url.origin.toLowerCase() === 'https://mycourses.stonybrook.edu'
      && url.pathname === STONY_BROOK_HANDOFF_PATH
      && keys.length === 1
      && keys[0] === 'entityId'
      && url.searchParams.get('entityId') === STONY_BROOK_HANDOFF_ENTITY_ID
      && !url.hash;
  } catch {
    return false;
  }
}

export const stonyBrookAdapter = Object.freeze({
  id: STONY_BROOK_ADAPTER_ID,
  displayName: 'Stony Brook University',
  brightspaceHost: 'mycourses.stonybrook.edu',
  trustedSsoOrigin: 'https://sso.cc.stonybrook.edu',
  credentialTarget: STONY_BROOK_CREDENTIAL_TARGET,

  supportsBaseUrl(baseUrl) {
    const url = safeUrl(baseUrl);
    return exactHttpsHost(baseUrl, this.brightspaceHost)
      && url.origin.toLowerCase() === `https://${this.brightspaceHost}`;
  },

  isTrustedBrightspaceUrl(value) {
    return isTrustedBrightspaceUrl(value, `https://${this.brightspaceHost}`);
  },

  isTrustedSsoUrl(value) {
    const url = safeUrl(value);
    return Boolean(
      url
      && url.protocol === 'https:'
      && !url.username
      && !url.password
      && url.origin.toLowerCase() === this.trustedSsoOrigin
    );
  },

  isMfaUrl(value) {
    const url = safeUrl(value);
    return Boolean(url && url.protocol === 'https:' && !url.username && !url.password && isDuoHost(url.hostname));
  },

  async inspectPage(page) {
    const current = safeUrl(page.url());
    if (!current || current.protocol !== 'https:') return { state: 'unexpected' };

    if (this.isTrustedBrightspaceUrl(current.href)) {
      if ((await count(page, AUTHENTICATED_SELECTOR)) > 0) return { state: 'authenticated' };
      const handoff = page.locator(STONY_BROOK_HANDOFF_SELECTOR);
      const handoffCount = await count(page, STONY_BROOK_HANDOFF_SELECTOR);
      if (handoffCount === 1) {
        const href = await handoff.first().getAttribute('href').catch(() => null);
        if (isRecognizedStonyBrookHandoff(href, current.href)) return { state: 'institution-login' };
      }
      return { state: 'brightspace-wait' };
    }

    if (this.isMfaUrl(current.href)) return { state: 'mfa' };
    if (!this.isTrustedSsoUrl(current.href)) return { state: 'unexpected' };

    const frames = typeof page.frames === 'function' ? page.frames() : [];
    if (frames.some(frame => this.isMfaUrl(frame.url()))) return { state: 'mfa' };
    const [usernameCount, passwordCount, submitCount] = await Promise.all([
      count(page, STONY_BROOK_USERNAME_SELECTOR),
      count(page, STONY_BROOK_PASSWORD_SELECTOR),
      count(page, STONY_BROOK_SUBMIT_SELECTOR)
    ]);
    return usernameCount === 1 && passwordCount === 1 && submitCount >= 1
      ? { state: 'login-form' }
      : { state: 'sso-wait' };
  },

  async beginSsoHandoff(page) {
    if (!this.isTrustedBrightspaceUrl(page.url())) {
      throw new Error('Automatic sign-in stopped because the Brightspace origin is not trusted.');
    }
    const handoff = page.locator(STONY_BROOK_HANDOFF_SELECTOR);
    if (await handoff.count() !== 1) {
      throw new Error('The Stony Brook institutional sign-in control was not recognized. Use Refresh Login.');
    }
    const target = handoff.first();
    const href = await target.getAttribute('href').catch(() => null);
    if (!isRecognizedStonyBrookHandoff(href, page.url())) {
      throw new Error('The Stony Brook institutional sign-in control was not recognized. Use Refresh Login.');
    }
    if (!this.isTrustedBrightspaceUrl(page.url())) {
      throw new Error('Automatic sign-in stopped because the Brightspace origin is not trusted.');
    }
    await target.click();
  },

  async fillAndSubmit(page, credential) {
    const assertTrustedOrigin = () => {
      if (!this.isTrustedSsoUrl(page.url())) throw new Error('Automatic sign-in stopped because the authentication origin is not trusted.');
    };
    assertTrustedOrigin();
    await page.locator(STONY_BROOK_USERNAME_SELECTOR).fill(credential.username);
    assertTrustedOrigin();
    await page.locator(STONY_BROOK_PASSWORD_SELECTOR).fill(credential.password);
    assertTrustedOrigin();
    await page.locator(STONY_BROOK_SUBMIT_SELECTOR).first().click();
  }
});

export function institutionAdapterForBaseUrl(baseUrl) {
  return stonyBrookAdapter.supportsBaseUrl(baseUrl) ? stonyBrookAdapter : null;
}

export const AUTHENTICATED_BRIGHTSPACE_SELECTOR = AUTHENTICATED_SELECTOR;
export const STONY_BROOK_SSO_HANDOFF_SELECTOR = STONY_BROOK_HANDOFF_SELECTOR;
