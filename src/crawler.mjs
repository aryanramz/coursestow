import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ensureDir,
  extensionFromContentType,
  filenameFromDisposition,
  isLikelyDownload,
  safeName,
  shortHash,
  writeBufferIfChanged,
  writeJson,
  writeText
} from './utils.mjs';

function recordChange(config, change) {
  if (!config?._changes || !change || change.action === 'unchanged') return;
  const term = change.courseId ? config?._courseTermById?.[String(change.courseId)] : null;
  config._changes.push({
    at: new Date().toISOString(),
    ...(term ? { termKey: term.key, term: term.label } : {}),
    ...change
  });
}

function combinedAction(actions) {
  if (actions.includes('added')) return 'added';
  if (actions.includes('updated')) return 'updated';
  return 'unchanged';
}

async function readExistingText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

function simpleLineDiff(before = '', after = '', maxMiddleLines = 500) {
  const a = String(before).replace(/\r\n/g, '\n').split('\n');
  const b = String(after).replace(/\r\n/g, '\n').split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;

  const aEnd = a.length - suffix;
  const bEnd = b.length - suffix;
  const oldMiddle = a.slice(prefix, aEnd);
  const newMiddle = b.slice(prefix, bEnd);
  const out = [
    `@@ old lines ${prefix + 1}-${Math.max(prefix + 1, aEnd)} -> new lines ${prefix + 1}-${Math.max(prefix + 1, bEnd)} @@`,
    `common prefix lines: ${prefix}`,
    `common suffix lines: ${suffix}`,
    ''
  ];

  const emit = (mark, lines) => {
    const shown = lines.slice(0, maxMiddleLines);
    for (const line of shown) out.push(`${mark}${line}`);
    if (lines.length > shown.length) out.push(`${mark}... [${lines.length - shown.length} more line(s) omitted from diff; full before/after files are saved]`);
  };
  emit('-', oldMiddle);
  emit('+', newMiddle);
  return out.join('\n');
}

function jsonChanges(beforeText, afterText, limit = 300) {
  let before;
  let after;
  try { before = JSON.parse(beforeText); after = JSON.parse(afterText); } catch { return []; }
  const changes = [];
  const walk = (a, b, pathName) => {
    if (changes.length >= limit) return;
    if (Object.is(a, b)) return;
    const aObj = a && typeof a === 'object';
    const bObj = b && typeof b === 'object';
    if (!aObj || !bObj || Array.isArray(a) !== Array.isArray(b)) {
      changes.push({ path: pathName || '$', before: a, after: b });
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n && changes.length < limit; i++) walk(a[i], b[i], `${pathName || '$'}[${i}]`);
      return;
    }
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      if (changes.length >= limit) break;
      const child = pathName ? `${pathName}.${key}` : `$.${key}`;
      if (!(key in a)) changes.push({ path: child, before: '[missing]', after: b[key] });
      else if (!(key in b)) changes.push({ path: child, before: a[key], after: '[missing]' });
      else walk(a[key], b[key], child);
    }
  };
  walk(before, after, '$');
  return changes;
}

async function writeUpdateDiagnostic(config, meta, files) {
  if (!config?.writeUpdateDiagnostics || !config?._runId) return null;
  const changed = Object.entries(files).filter(([, pair]) => pair.before !== null && String(pair.before) !== String(pair.after));
  if (!changed.length) return null;

  config._diagnosticSequence = (config._diagnosticSequence || 0) + 1;
  const seq = String(config._diagnosticSequence).padStart(4, '0');
  const slug = safeName(`${meta?.courseId || 'global'}-${meta?.type || 'page'}-${meta?.id || ''}-${meta?.title || ''}`, 'update').slice(0, 110);
  const changesRoot = config.changesDir || path.join(config.outputDir, '_system', 'changes');
  const diagDir = path.join(changesRoot, 'diagnostics', config._runId, `${seq}-${slug}`);
  await ensureDir(diagDir);

  const changedFiles = [];
  let jsonFieldChanges = [];
  for (const [name, pair] of changed) {
    const safe = safeName(name, 'snapshot');
    const beforeFile = `before-${safe}`;
    const afterFile = `after-${safe}`;
    const diffFile = `diff-${safe}.txt`;
    await fs.writeFile(path.join(diagDir, beforeFile), String(pair.before), 'utf8');
    await fs.writeFile(path.join(diagDir, afterFile), String(pair.after), 'utf8');
    await fs.writeFile(path.join(diagDir, diffFile), simpleLineDiff(pair.before, pair.after), 'utf8');
    changedFiles.push({ name, before: beforeFile, after: afterFile, diff: diffFile });
    if (/\.json$/i.test(name)) jsonFieldChanges.push(...jsonChanges(pair.before, pair.after));
  }

  const diagnostic = {
    generatedAt: new Date().toISOString(),
    change: meta,
    changedFiles,
    jsonFieldChanges,
    note: 'Raw before/after semantic snapshots are saved here. HTML is diagnostic only and is not used for incremental change detection.'
  };
  await fs.writeFile(path.join(diagDir, 'diagnostic.json'), JSON.stringify(diagnostic, null, 2), 'utf8');
  return {
    path: path.relative(config.outputDir, diagDir).replace(/\\/g, '/'),
    changedFiles: changedFiles.map(x => x.name),
    jsonFieldChanges: jsonFieldChanges.slice(0, 50)
  };
}

const FALLBACK_ROUTES = {
  content: id => `/d2l/le/content/${id}/Home`,
  assignments: id => `/d2l/lms/dropbox/user/folders_list.d2l?ou=${id}`,
  quizzes: id => `/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${id}`,
  discussions: id => `/d2l/le/${id}/discussions/List`,
  grades: id => `/d2l/lms/grades/my_grades/main.d2l?ou=${id}`,
  calendar: id => `/d2l/le/calendar/${id}`,
  announcements: id => `/d2l/lms/news/main.d2l?ou=${id}`
};

function decodeHtml(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(value = '') {
  return decodeHtml(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalizeCourseName(value, id) {
  const v = stripTags(value || '').replace(/^[-–—\s]+/, '').replace(/\s+/g, ' ').trim();
  return v && !/^course home$/i.test(v) ? v : `Course ${id}`;
}

function addCourse(map, id, name, baseUrl, source) {
  id = String(id || '').trim();
  if (!/^\d+$/.test(id)) return;
  const normalized = normalizeCourseName(name, id);
  const existing = map.get(id);
  const score = (n) => {
    let s = n.length;
    if (/\b(Fall|Spring|Summer|Winter)\s+20\d{2}\b/i.test(n)) s += 1000;
    if (/^[A-Z]{2,5}\s*\d{3}/.test(n)) s += 500;
    if (/^Course \d+$/.test(n)) s -= 1000;
    return s;
  };
  if (!existing || score(normalized) > score(existing.name)) {
    map.set(id, {
      id,
      name: normalized,
      homeUrl: new URL(`/d2l/home/${id}`, baseUrl).href,
      discoveredFrom: source
    });
  }
}

function discoverFromJson(value, map, baseUrl, source = 'course-selector-json') {
  if (typeof value === 'string') {
    // Brightspace RPC payloads often embed the actual Course Selector markup
    // inside JSON strings. Parse those strings as markup too.
    if (/\/d2l\/home\/\d+/i.test(value)) discoverFromMarkup(value, map, baseUrl, source);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const x of value) discoverFromJson(x, map, baseUrl, source);
    return;
  }

  const keys = Object.keys(value);
  const getKey = (...names) => {
    const k = keys.find(key => names.some(n => key.toLowerCase() === n.toLowerCase()));
    return k ? value[k] : undefined;
  };

  const id = getKey('OrgUnitId', 'orgUnitId', 'Id', 'id');
  const name = getKey('Name', 'name', 'Title', 'title', 'DisplayName', 'displayName');
  const href = getKey('Href', 'href', 'Url', 'url', 'Link', 'link');

  if (id && name) addCourse(map, id, name, baseUrl, source);
  if (typeof href === 'string') {
    const m = href.match(/\/d2l\/home\/(\d+)/i);
    if (m) addCourse(map, m[1], name || '', baseUrl, source);
  }

  for (const child of Object.values(value)) discoverFromJson(child, map, baseUrl, source);
}

function discoverFromMarkup(raw, map, baseUrl, source = 'course-selector-markup') {
  const variants = [String(raw || '')];
  // Some Brightspace deployments return the selector as a D2L RPC payload with escaped HTML.
  // Unescape only what is needed for reliable href/text matching.
  if (variants[0].includes('\\"') || variants[0].includes('\\r') || variants[0].includes('\\u')) {
    variants.push(
      variants[0]
        .replace(/\\"/g, '"')
        .replace(/\\r\\n|\\n|\\r/g, '\n')
        .replace(/\\u0026/gi, '&')
        .replace(/\\u003c/gi, '<')
        .replace(/\\u003e/gi, '>')
    );
  }

  for (const markup of variants) {
    // Prefer the actual course anchor text. This is much more reliable than
    // looking at nearby title attributes in the selector payload.
    const anchorRe = /<a\b[^>]*href=["'](?:https?:\/\/[^"']+)?\/d2l\/home\/(\d+)[^"']*["'][^>]*>([\s\S]{0,800}?)<\/a>/gi;
    let match;
    while ((match = anchorRe.exec(markup))) {
      addCourse(map, match[1], stripTags(match[2]), baseUrl, source);
    }

    // Fallback for markup where the anchor itself is incomplete in a partial.
    const hrefRe = /href=["']([^"']*\/d2l\/home\/(\d+)[^"']*)["']/gi;
    while ((match = hrefRe.exec(markup))) {
      const id = match[2];
      const around = markup.slice(Math.max(0, match.index - 700), Math.min(markup.length, match.index + 1700));
      const title = around.match(/title=["']([^"']{2,500})["']/i);
      const inner = around.match(/href=["'][^"']*\/d2l\/home\/\d+[^"']*["'][^>]*>([\s\S]{0,800}?)<\/a>/i);
      addCourse(map, id, inner?.[1] || title?.[1] || '', baseUrl, source);
    }

    const objectish = /["']?(?:OrgUnitId|orgUnitId)["']?\s*[:=]\s*["']?(\d+)["']?[\s\S]{0,700}?["']?(?:Name|name|Title|title)["']?\s*[:=]\s*["']([^"']{2,500})["']/gi;
    while ((match = objectish.exec(markup))) addCourse(map, match[1], match[2], baseUrl, source);
  }
}

async function tryAutoSubmitSavedBrowserLogin(page) {
  try {
    // Chromium/Brave marks credentials supplied by its password manager with
    // :-webkit-autofill. We intentionally inspect only that state; the crawler
    // never reads the username/password values from the page.
    return await page.evaluate(() => {
      const password = document.querySelector('input[type="password"]');
      if (!password) return { detected: false, submitted: false };

      // Focusing can cause Chromium to apply a saved login on some SSO pages.
      try { password.focus({ preventScroll: true }); } catch {}

      let autofilled = false;
      try { autofilled = password.matches(':-webkit-autofill'); } catch {}
      if (!autofilled) return { detected: true, submitted: false };

      const form = password.form || password.closest('form');
      const submit = form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])')
        || document.querySelector('button[type="submit"], input[type="submit"]');
      if (!submit || submit.disabled) return { detected: true, submitted: false };

      submit.click();
      return { detected: true, submitted: true };
    });
  } catch {
    return { detected: false, submitted: false };
  }
}

export async function waitForAuthenticatedHome(page, baseUrl, timeoutMs, authConfig = {}) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});

  const isAuthenticated = async () => {
    try {
      return await page.locator('[data-prl*="/courseSelector/"], [data-cprl*="/courseSelector/"], a[href*="/d2l/home/"]').count() > 0;
    } catch {
      return false;
    }
  };

  if (await isAuthenticated()) {
    console.log('Existing Brightspace session found — continuing without login.');
    return;
  }

  const autoSubmit = authConfig.autoSubmitSavedBrowserCredentials !== false;
  const loginTimeoutMs = Number(authConfig.manualLoginTimeoutMs ?? 10 * 60 * 1000);

  console.log('\nBrightspace login is required.');
  if (autoSubmit) {
    console.log('If Brave exposes a saved login as browser autofill, CourseStow can attempt to submit it automatically.');
    console.log('The crawler never reads, stores, or logs the password itself.');
  }
  console.log('If credentials are not saved/autofilled, complete the login manually in the Brave window.');
  console.log('MFA/Duo approval is never bypassed and may still require you.');
  console.log('The sync will continue automatically after Brightspace loads.\n');

  const started = Date.now();
  let lastAssistAt = 0;
  let announcedAutoSubmit = false;
  while (Date.now() - started < loginTimeoutMs) {
    await page.waitForTimeout(1200);

    if (await isAuthenticated()) {
      console.log('Brightspace authentication completed — continuing.');
      return;
    }

    if (autoSubmit && Date.now() - lastAssistAt >= 3500) {
      lastAssistAt = Date.now();
      const assisted = await tryAutoSubmitSavedBrowserLogin(page);
      if (assisted.submitted && !announcedAutoSubmit) {
        announcedAutoSubmit = true;
        console.log('Saved browser credentials detected via autofill — submitted the login form.');
      }
    }
  }
  throw new Error(`Timed out waiting for Brightspace login (${Math.round(loginTimeoutMs / 60000)} minutes).`);
}

export async function discoverCourses(page, context, baseUrl, debugDir, config = {}) {
  const map = new Map();

  // 1) Direct visible links (works on many Brightspace deployments).
  const visible = await page.locator('a[href*="/d2l/home/"]').evaluateAll(anchors => anchors.map(a => ({
    href: a.href,
    text: (a.innerText || a.textContent || '').trim(),
    aria: a.getAttribute('aria-label') || '',
    title: a.getAttribute('title') || ''
  }))).catch(() => []);
  for (const item of visible) {
    const m = item.href.match(/\/d2l\/home\/(\d+)/i);
    if (m) addCourse(map, m[1], item.text || item.aria || item.title, baseUrl, 'visible-home-link');
  }

  // 2) Many Brightspace nav layouts expose an authenticated Course Selector endpoint.
  const selectorRoutes = await page.locator('[data-prl*="/courseSelector/"], [data-cprl*="/courseSelector/"]').evaluateAll(nodes => {
    const out = [];
    for (const n of nodes) {
      for (const key of ['data-prl', 'data-cprl']) {
        const v = n.getAttribute(key);
        if (v && v.includes('/courseSelector/')) out.push(v);
      }
    }
    return [...new Set(out)];
  }).catch(() => []);

  let rootOrgUnitId = null;
  for (const route of selectorRoutes) {
    const rm = route.match(/\/courseSelector\/(\d+)\//i);
    if (rm) rootOrgUnitId = rm[1];
    try {
      const url = new URL(route, baseUrl).href;
      const response = await context.request.get(url, { failOnStatusCode: false, timeout: config.navigationTimeoutMs || 45000 });
      const raw = await response.text();
      await ensureDir(debugDir);
      await writeText(path.join(debugDir, `course-selector-${shortHash(url)}.raw.txt`), raw);
      await writeJson(path.join(debugDir, `course-selector-${shortHash(url)}.meta.json`), {
        url, status: response.status(), contentType: response.headers()['content-type'] || ''
      });
      discoverFromMarkup(raw, map, baseUrl, 'course-selector');
      const jsonCandidate = raw.replace(/^\s*while\s*\(\s*1\s*\)\s*;\s*/i, '');
      try { discoverFromJson(JSON.parse(jsonCandidate), map, baseUrl, 'course-selector-json'); } catch {}
    } catch (error) {
      await writeText(path.join(debugDir, 'course-selector-error.txt'), String(error?.stack || error));
    }
  }

  // 3) The homepage calendar can expose course org-unit IDs even when
  //    the My Courses widget is rendered in a way that page.content() misses.
  const calendarCourses = await page.locator('a[href*="/d2l/le/calendar/"]').evaluateAll(anchors => anchors.map(a => {
    const href = a.href || '';
    const m = href.match(/\/d2l\/le\/calendar\/(\d+)\/event\//i);
    if (!m) return null;
    const li = a.closest('li');
    const lines = (li?.innerText || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const courseLine = [...lines].reverse().find(x => /\b(Fall|Spring|Summer|Winter)\s+20\d{2}\b/i.test(x));
    return { id: m[1], name: courseLine || '' };
  }).filter(Boolean)).catch(() => []);
  for (const c of calendarCourses) addCourse(map, c.id, c.name, baseUrl, 'homepage-calendar');

  // 4) Generic org-unit IDs appearing anywhere in tool links.
  const allLinks = await page.locator('a[href]').evaluateAll(anchors => anchors.map(a => ({
    href: a.href || '',
    text: (a.innerText || a.textContent || '').trim()
  }))).catch(() => []);
  for (const link of allLinks) {
    const patterns = [
      /\/d2l\/le\/content\/(\d+)/i,
      /\/d2l\/le\/(\d+)\/discussions/i,
      /\/d2l\/le\/calendar\/(\d+)/i,
      /[?&]ou=(\d+)/i
    ];
    for (const p of patterns) {
      const m = link.href.match(p);
      if (m) addCourse(map, m[1], link.text, baseUrl, 'generic-tool-link');
    }
  }

  // Do not treat the institution/home org unit as a course.
  if (rootOrgUnitId) map.delete(String(rootOrgUnitId));

  const courses = [...map.values()];
  courses.sort((a, b) => a.name.localeCompare(b.name));
  await writeJson(path.join(debugDir, 'discovered-courses.json'), { rootOrgUnitId, selectorRoutes, courses });
  return courses;
}

async function extractRichBlocks(page) {
  return page.locator('d2l-html-block[html]').evaluateAll(nodes => nodes.map((n, index) => {
    const html = n.getAttribute('html') || '';
    const holder = document.createElement('div');
    holder.innerHTML = html;
    return {
      index,
      html,
      text: (holder.innerText || holder.textContent || '').replace(/\s+/g, ' ').trim()
    };
  }).filter(x => x.html || x.text)).catch(() => []);
}

async function extractLinks(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const add = (raw, text = '', title = '', download = false) => {
      if (!raw) return;
      try {
        const href = new URL(raw, location.href).href;
        const key = `${href}|${text}|${title}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ href, text: String(text || '').replace(/\s+/g, ' ').trim(), title: title || '', download: Boolean(download) });
      } catch {}
    };

    for (const a of document.querySelectorAll('a[href]')) {
      add(a.getAttribute('href'), a.innerText || a.textContent || '', a.getAttribute('title') || '', a.hasAttribute('download'));
    }

    // Brightspace stores announcement/instruction bodies inside the `html`
    // attribute of d2l-html-block. Those anchors are not part of the live DOM,
    // so collect them explicitly as well.
    for (const block of document.querySelectorAll('d2l-html-block[html]')) {
      const holder = document.createElement('div');
      holder.innerHTML = block.getAttribute('html') || '';
      for (const a of holder.querySelectorAll('a[href]')) {
        add(a.getAttribute('href'), a.textContent || '', a.getAttribute('title') || '', a.hasAttribute('download'));
      }
    }
    return out;
  }).catch(() => []);
}

async function extractResourceCandidates(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const add = (raw, name = '', force = false, tag = '') => {
      if (!raw || String(raw).toLowerCase().startsWith('data:')) return;
      try {
        const href = new URL(raw, location.href).href;
        const key = `${href}|${String(tag || '').toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          href,
          name: String(name || '').replace(/\s+/g, ' ').trim(),
          force,
          tag: String(tag || '').toLowerCase()
        });
      } catch {}
    };
    const inspect = (root, inheritedName = '') => {
      for (const n of root.querySelectorAll('a[href], [data-location], iframe[src], embed[src], object[data], source[src], track[src], img[src], video[src], audio[src]')) {
        const title = n.getAttribute('data-title') || n.getAttribute('title') || inheritedName || (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
        const tag = n.tagName || '';
        const locationAttr = n.getAttribute('data-location');
        if (locationAttr) add(locationAttr, title, true, tag);

        const href = n.getAttribute('href');
        if (href && !href.toLowerCase().startsWith('javascript:')) add(href, title, n.hasAttribute('download'), tag);

        for (const attr of ['src', 'data']) {
          const raw = n.getAttribute(attr);
          if (!raw) continue;
          add(raw, title, n.tagName === 'IMG' || n.tagName === 'TRACK', tag);
          try {
            const absolute = new URL(raw, location.href);
            const embeddedFile = absolute.searchParams.get('file');
            if (embeddedFile) add(decodeURIComponent(embeddedFile), title, true, tag);
          } catch {}
        }
      }
    };

    inspect(document);
    for (const block of document.querySelectorAll('d2l-html-block[html]')) {
      const holder = document.createElement('div');
      holder.innerHTML = block.getAttribute('html') || '';
      inspect(holder, block.getAttribute('title') || '');
    }
    return out;
  }).catch(() => []);
}

export async function buildCourseNav(course, baseUrl) {
  const nav = {};
  for (const [section, builder] of Object.entries(FALLBACK_ROUTES)) {
    nav[section] = new URL(builder(course.id), baseUrl).href;
  }
  return nav;
}

function shouldCaptureResponse(response) {
  try {
    const type = (response.headers()['content-type'] || '').toLowerCase();
    const url = response.url();
    const rt = response.request().resourceType();
    return type.includes('application/json')
      || /\/d2l\/api\//i.test(url)
      || rt === 'xhr'
      || rt === 'fetch';
  } catch {
    return false;
  }
}

export function attachNetworkCapture(page, networkDir, baseUrl, enabled = true) {
  if (!enabled) return async () => {};
  const baseOrigin = new URL(baseUrl).origin;
  const pending = new Set();

  const handler = response => {
    const job = (async () => {
      try {
        const u = new URL(response.url());
        if (u.origin !== baseOrigin || !shouldCaptureResponse(response)) return;
        const headers = response.headers();
        const body = await response.body();
        if (body.length > 10 * 1024 * 1024) return; // diagnostic cap per response
        const contentType = (headers['content-type'] || '').toLowerCase();
        let ext = '.bin';
        if (contentType.includes('json')) ext = '.json';
        else if (contentType.includes('html')) ext = '.html';
        else if (contentType.includes('text/')) ext = '.txt';
        const key = shortHash(`${response.request().method()} ${response.url()}`);
        const file = path.join(networkDir, `${key}${ext}`);
        await ensureDir(networkDir);
        await writeBufferIfChanged(file, body);
        await writeJson(path.join(networkDir, `${key}.meta.json`), {
          url: response.url(),
          method: response.request().method(),
          resourceType: response.request().resourceType(),
          status: response.status(),
          contentType: headers['content-type'] || '',
          size: body.length
        });
      } catch {}
    })();
    pending.add(job);
    job.finally(() => pending.delete(job));
  };

  page.on('response', handler);
  return async () => {
    page.off('response', handler);
    await Promise.allSettled([...pending]);
  };
}

function normalizeSnapshotText(value = '') {
  // Visiting a Brightspace Content topic updates its own activity metadata.
  // That is crawler-induced state, not a professor/content change, so exclude it
  // from the persistent mirror and from incremental change detection.
  //
  // Brightspace also renders two asynchronous UI-only controls near the course
  // navigation: the overflow label `More` and the ReadSpeaker label `Listen`.
  // Depending on viewport/layout timing, body.innerText can contain either, both,
  // or neither even though the course data is identical. Diagnostics from v1.3
  // showed that all 24 false updates were only these labels changing. Remove them
  // only from the course-navigation header window, not from arbitrary course body
  // content where the words could be meaningful.
  let text = String(value).replace(/^\s*Last Visited[^\r\n]*$/gim, '');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const header = lines.slice(0, 18).map(x => x.replace(/\u00a0/g, ' ').trim());
  const navWords = /^(?:Course Home|Content|Assignments|Exams \/ Quizzes|Discussions|Class Progress|Grades|Learner Resources|Announcements|Syllabus|Email|FAQ|F\.A\.Q\.|Book Office Hours Meeting)$/i;
  const looksLikeCourseChrome = header.filter(x => navWords.test(x)).length >= 2;
  if (looksLikeCourseChrome) {
    text = lines
      .filter((line, i) => !(i < 18 && /^(?:More|Listen)$/i.test(line.replace(/\u00a0/g, ' ').trim())))
      .join('\n');
  }
  return text
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeSemanticLinks(links = []) {
  // Brightspace injects several UI-only anchors asynchronously. The most common
  // offender is ReadSpeaker's `Listen` control, which may appear or disappear
  // between otherwise identical page loads and shifts the index of every later
  // link. Non-navigational javascript:// / javascript:void(...) controls behave
  // similarly (search toggles, grade-calculation toggles, language/logout menus).
  //
  // These links are browser chrome, not course content. Remove them from the
  // semantic snapshot globally while keeping real HTTP(S) links, including
  // announcement resources, documents, videos, quiz links, and other course URLs.
  return links
    .filter(link => {
      const href = String(link?.href || '').trim();
      const text = String(link?.text || '').replace(/\s+/g, ' ').trim();
      const title = String(link?.title || '').replace(/\s+/g, ' ').trim();

      if (/^javascript:/i.test(href)) return false;
      if (/readspeaker\.com/i.test(href)) return false;
      if (/^Listen$/i.test(text)) return false;
      if (/Listen to this page using ReadSpeaker/i.test(title)) return false;
      return true;
    })
    .map(link => ({
      href: String(link.href || '').trim(),
      text: String(link.text || '').replace(/\s+/g, ' ').trim(),
      title: String(link.title || '').replace(/\s+/g, ' ').trim(),
      download: Boolean(link.download)
    }));
}

export async function savePageSnapshot(page, dir, label, config = null, meta = null) {
  await ensureDir(dir);
  const html = await page.content().catch(() => '');
  const bodyText = normalizeSnapshotText(await page.locator('body').innerText().catch(() => ''));
  const richBlocks = await extractRichBlocks(page);
  const normalizedRichBlocks = richBlocks.map(x => ({ ...x, text: normalizeSnapshotText(x.text) }));
  const richText = normalizedRichBlocks.map(x => x.text).filter(Boolean).join('\n\n');
  const text = normalizeSnapshotText(richText && !bodyText.includes(richText) ? `${bodyText}\n\n[Embedded Brightspace content]\n${richText}` : bodyText);
  const title = await page.title().catch(() => '');
  const url = page.url();
  const links = normalizeSemanticLinks(await extractLinks(page).catch(() => []));

  const textFile = path.join(dir, `${label}.txt`);
  const jsonFile = path.join(dir, `${label}.json`);
  const htmlFile = path.join(dir, `${label}.html`);
  const nextJson = JSON.stringify({ title, url, links, richBlocks: normalizedRichBlocks }, null, 2);
  const beforeText = await readExistingText(textFile);
  const beforeJson = await readExistingText(jsonFile);
  const beforeHtml = await readExistingText(htmlFile);

  // Treat visible text + navigable links as the semantic page state. Brightspace
  // injects session/CSRF values into raw HTML, so hashing raw HTML directly would
  // make an unchanged page look different on every run. Only refresh the HTML
  // snapshot when the semantic state actually changed.
  const textAction = await writeText(textFile, text);
  const jsonAction = await writeText(jsonFile, nextJson);
  const semanticAction = combinedAction([textAction, jsonAction]);
  if (semanticAction !== 'unchanged') await writeText(htmlFile, html);

  let diagnostic = null;
  if (semanticAction === 'updated' && config && meta) {
    diagnostic = await writeUpdateDiagnostic(config, meta, {
      [`${label}.txt`]: { before: beforeText, after: text },
      [`${label}.json`]: { before: beforeJson, after: nextJson },
      [`${label}.html`]: { before: beforeHtml, after: html }
    });
  }
  return { action: semanticAction, diagnostic };
}

function normalizeCalendarSnapshotText(value = '') {
  // The Brightspace calendar landing page is a live "today" view. It regenerates
  // the selected date, 24 hourly grid rows, and task-entry controls even when the
  // underlying course calendar has not changed. Those UI-only values made every
  // course calendar look modified on every sync.
  const month = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const dateOnly = new RegExp(`^${month}\\s+\\d{1,2},\\s+\\d{4}$`, 'i');
  const timeOnly = /^\d{1,2}:\d{2}\s*(?:AM|PM)$/i;
  const ignored = /^(?:Calendar Day View|Calendar View Modes|AgendaDayWeekMonthList|Agenda|Day|Week|Month|List|More|Listen|Previous|Next|Clear Selection|all day|Tasks|Add a task\.\.\.)$/i;

  return normalizeSnapshotText(value)
    .split(/\r?\n/)
    .map(line => line.replace(/\u00a0/g, ' ').trim())
    .filter(line => line && !dateOnly.test(line) && !timeOnly.test(line) && !ignored.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


function normalizeAssignmentListText(value = '') {
  // Keep assignment names, due dates, scores/status, and other student-visible
  // assignment information, but drop the generic account/navigation chrome that
  // can be re-rendered in a different order between otherwise identical loads.
  // The assignment detail links below provide stable assignment identity.
  const ignored = /^(?:Profile|My Portfolio|Notifications|Account Settings|Progress|English \(United States\)|Log Out|Course Home|Content|Assignments|Exams \/ Quizzes|Discussions|Class Progress|Grades|Learner Resources|More|Listen|skip to main content)$/i;
  return normalizeSnapshotText(value)
    .split(/\r?\n/)
    .map(line => line.replace(/\u00a0/g, ' ').trim())
    .filter(line => line && !ignored.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function saveAssignmentsListSnapshot(page, dir, label, courseId, config = null, meta = null) {
  await ensureDir(dir);
  const html = await page.content().catch(() => '');
  const rawText = await page.locator('body').innerText().catch(() => '');
  const text = normalizeAssignmentListText(rawText);
  const title = await page.title().catch(() => '');
  const url = page.url();
  const allLinks = await extractLinks(page).catch(() => []);

  // Generic Brightspace navigation/account links can change order or contain
  // session-specific query values. For the assignment index, only assignment
  // detail links are semantically meaningful. Canonicalize them to the stable
  // Dropbox assignment id (`db`) plus course id (`ou`).
  const assignments = [];
  const seen = new Set();
  for (const link of allLinks) {
    try {
      const u = new URL(link.href, url);
      if (!/\/d2l\/lms\/dropbox\/user\/folder_submit_files\.d2l$/i.test(u.pathname)) continue;
      const db = u.searchParams.get('db');
      const ou = u.searchParams.get('ou');
      if (!db || ou !== String(courseId)) continue;
      const key = String(db);
      if (seen.has(key)) continue;
      seen.add(key);
      assignments.push({
        id: key,
        href: new URL(`/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${encodeURIComponent(key)}&ou=${encodeURIComponent(String(courseId))}`, url).href,
        text: link.text || '',
        title: link.title || ''
      });
    } catch {}
  }
  assignments.sort((a, b) => `${a.id}|${a.text}`.localeCompare(`${b.id}|${b.text}`));

  const textFile = path.join(dir, `${label}.txt`);
  const jsonFile = path.join(dir, `${label}.json`);
  const htmlFile = path.join(dir, `${label}.html`);
  const nextJson = JSON.stringify({ title, url, assignments }, null, 2);
  const beforeText = await readExistingText(textFile);
  const beforeJson = await readExistingText(jsonFile);
  const beforeHtml = await readExistingText(htmlFile);
  const textAction = await writeText(textFile, text);
  const jsonAction = await writeText(jsonFile, nextJson);
  const semanticAction = combinedAction([textAction, jsonAction]);
  if (semanticAction !== 'unchanged') await writeText(htmlFile, html);
  let diagnostic = null;
  if (semanticAction === 'updated' && config && meta) {
    diagnostic = await writeUpdateDiagnostic(config, meta, {
      [`${label}.txt`]: { before: beforeText, after: text },
      [`${label}.json`]: { before: beforeJson, after: nextJson },
      [`${label}.html`]: { before: beforeHtml, after: html }
    });
  }
  return { action: semanticAction, diagnostic };
}

function normalizeAnnouncementListText(value = '') {
  // Keep the student-visible announcement list/body text, but strip the same
  // asynchronous course/navigation chrome handled by generic snapshots. The
  // announcement identities themselves are canonicalized separately below.
  return normalizeSnapshotText(value);
}

async function saveAnnouncementsListSnapshot(page, dir, label, courseId, config = null, meta = null) {
  await ensureDir(dir);
  const html = await page.content().catch(() => '');
  const rawText = await page.locator('body').innerText().catch(() => '');
  const text = normalizeAnnouncementListText(rawText);
  const title = await page.title().catch(() => '');
  const url = page.url();
  const allLinks = await extractLinks(page).catch(() => []);

  // Brightspace injects/removes ReadSpeaker and search/navigation controls on
  // this page asynchronously. That changes the position of every later link in
  // the raw `links` array even when no announcement changed. For the index page,
  // only actual announcement detail links are semantic. Canonicalize those to
  // stable announcement ids and stable URLs; announcement bodies/external links
  // are captured independently by the detail-page crawler.
  const announcements = [];
  const seen = new Set();
  const newsPath = new RegExp(`^/d2l/le/news/${courseId}/(\\d+)/view/?$`, 'i');
  for (const link of allLinks) {
    try {
      const u = new URL(link.href, url);
      const m = u.pathname.match(newsPath);
      if (!m) continue;
      const id = String(m[1]);
      if (seen.has(id)) continue;
      seen.add(id);
      announcements.push({
        id,
        href: new URL(`/d2l/le/news/${encodeURIComponent(String(courseId))}/${encodeURIComponent(id)}/view?ou=${encodeURIComponent(String(courseId))}`, url).href,
        text: link.text || '',
        title: link.title || ''
      });
    } catch {}
  }
  announcements.sort((a, b) => `${a.id}|${a.text}`.localeCompare(`${b.id}|${b.text}`));

  const textFile = path.join(dir, `${label}.txt`);
  const jsonFile = path.join(dir, `${label}.json`);
  const htmlFile = path.join(dir, `${label}.html`);
  const nextJson = JSON.stringify({ title, url, announcements }, null, 2);
  const beforeText = await readExistingText(textFile);
  const beforeJson = await readExistingText(jsonFile);
  const beforeHtml = await readExistingText(htmlFile);
  const textAction = await writeText(textFile, text);
  const jsonAction = await writeText(jsonFile, nextJson);
  const semanticAction = combinedAction([textAction, jsonAction]);
  if (semanticAction !== 'unchanged') await writeText(htmlFile, html);

  let diagnostic = null;
  if (semanticAction === 'updated' && config && meta) {
    diagnostic = await writeUpdateDiagnostic(config, meta, {
      [`${label}.txt`]: { before: beforeText, after: text },
      [`${label}.json`]: { before: beforeJson, after: nextJson },
      [`${label}.html`]: { before: beforeHtml, after: html }
    });
  }
  return { action: semanticAction, diagnostic };
}

async function saveCalendarListSnapshot(page, dir, label, courseId, config = null, meta = null) {
  await ensureDir(dir);
  const html = await page.content().catch(() => '');
  const rawText = await page.locator('body').innerText().catch(() => '');
  const text = normalizeCalendarSnapshotText(rawText);
  const title = await page.title().catch(() => '');
  const url = page.url();
  const allLinks = await extractLinks(page).catch(() => []);

  // Only event links are semantically meaningful to the calendar itself. The
  // normal page also contains a huge account/course-selector menu whose order and
  // generated controls can change independently of calendar data.
  const eventPath = new RegExp(`/d2l/le/calendar/${courseId}/event/\\d+`, 'i');
  const eventLinks = allLinks
    .filter(link => {
      try { return eventPath.test(new URL(link.href).pathname); } catch { return false; }
    })
    .map(link => ({ href: link.href, text: link.text, title: link.title }))
    .sort((a, b) => `${a.href}|${a.text}`.localeCompare(`${b.href}|${b.text}`));

  const textFile = path.join(dir, `${label}.txt`);
  const jsonFile = path.join(dir, `${label}.json`);
  const htmlFile = path.join(dir, `${label}.html`);
  const nextJson = JSON.stringify({ title, url, events: eventLinks }, null, 2);
  const beforeText = await readExistingText(textFile);
  const beforeJson = await readExistingText(jsonFile);
  const beforeHtml = await readExistingText(htmlFile);
  const textAction = await writeText(textFile, text);
  const jsonAction = await writeText(jsonFile, nextJson);
  const semanticAction = combinedAction([textAction, jsonAction]);
  if (semanticAction !== 'unchanged') await writeText(htmlFile, html);
  let diagnostic = null;
  if (semanticAction === 'updated' && config && meta) {
    diagnostic = await writeUpdateDiagnostic(config, meta, {
      [`${label}.txt`]: { before: beforeText, after: text },
      [`${label}.json`]: { before: beforeJson, after: nextJson },
      [`${label}.html`]: { before: beforeHtml, after: html }
    });
  }
  return { action: semanticAction, diagnostic };
}


function stableAssetUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    const volatile = /^(?:token|access_token|auth|authorization|signature|sig|expires?|exp|jwt|session(?:id)?|sid|timestamp|ts|cache|cb|nonce|state|code|x-amz-.+|x-goog-.+)$/i;
    for (const key of [...u.searchParams.keys()]) {
      if (volatile.test(key)) u.searchParams.delete(key);
    }
    const entries = [...u.searchParams.entries()].sort(([a, av], [b, bv]) => `${a}=${av}`.localeCompare(`${b}=${bv}`));
    u.search = '';
    for (const [k, v] of entries) u.searchParams.append(k, v);
    return u.href;
  } catch {
    return String(raw || '');
  }
}

function assetKindFrom(url, contentType = '', tag = '') {
  const u = String(url || '').toLowerCase();
  const t = String(contentType || '').split(';')[0].trim().toLowerCase();
  const element = String(tag || '').toLowerCase();
  if (element === 'track' || /\.(vtt|srt|ttml)(?:$|[?#])/i.test(u) || /text\/(?:vtt|srt)/i.test(t)) return 'transcript';
  if (element === 'video' || /\.(mp4|mov|m4v|webm|avi|mkv|wmv)(?:$|[?#])/i.test(u) || t.startsWith('video/')) return 'video';
  if (element === 'audio' || /\.(mp3|m4a|wav|aac|ogg|flac)(?:$|[?#])/i.test(u) || t.startsWith('audio/')) return 'audio';
  if (element === 'img' || /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)(?:$|[?#])/i.test(u) || t.startsWith('image/')) return 'image';
  if (/\.(pdf|docx?|pptx?|xlsx?|csv|txt|rtf|odt|ods|odp)(?:$|[?#])/i.test(u)
      || /application\/(?:pdf|msword|rtf|vnd\.ms-|vnd\.openxmlformats-officedocument)/i.test(t)
      || /^text\/(?:plain|csv)$/i.test(t)) return 'document';
  if (/\.(zip|7z|rar|tar|gz)(?:$|[?#])/i.test(u) || /application\/(?:zip|x-7z-compressed|x-rar-compressed|gzip)/i.test(t)) return 'archive';
  if (element === 'iframe' || element === 'embed' || element === 'object') return 'embed';
  return 'other';
}

function assetPolicy(config = {}) {
  const p = config.assetPolicy || {};
  return {
    downloadDocuments: p.downloadDocuments ?? true,
    downloadImages: p.downloadImages ?? true,
    downloadTranscripts: p.downloadTranscripts ?? true,
    downloadArchives: p.downloadArchives ?? true,
    downloadVideo: p.downloadVideo ?? false,
    downloadAudio: p.downloadAudio ?? false,
    maxDownloadBytes: Number(p.maxDownloadBytes ?? 25 * 1024 * 1024),
    indexExternalAssets: p.indexExternalAssets ?? true
  };
}

function shouldDownloadAsset(kind, policy) {
  if (kind === 'document') return policy.downloadDocuments;
  if (kind === 'image') return policy.downloadImages;
  if (kind === 'transcript') return policy.downloadTranscripts;
  if (kind === 'archive') return policy.downloadArchives;
  if (kind === 'video') return policy.downloadVideo;
  if (kind === 'audio') return policy.downloadAudio;
  return false;
}

async function probeResource(context, href, baseUrl, timeoutMs) {
  const url = new URL(href, baseUrl);
  const sameOrigin = url.origin === new URL(baseUrl).origin;
  if (!sameOrigin) return { sameOrigin, url: url.href, contentType: '', contentLength: null, disposition: '' };
  try {
    const response = await context.request.head(url.href, { timeout: timeoutMs, failOnStatusCode: false });
    const headers = response.headers();
    const rawLength = headers['content-length'];
    const contentLength = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
    return {
      sameOrigin,
      url: url.href,
      status: response.status(),
      contentType: headers['content-type'] || '',
      contentLength,
      disposition: headers['content-disposition'] || ''
    };
  } catch {
    return { sameOrigin, url: url.href, contentType: '', contentLength: null, disposition: '' };
  }
}

async function downloadLink(context, href, suggestedName, targetDir, baseUrl, timeoutMs, probe = null, maxDownloadBytes = Infinity) {
  try {
    const url = new URL(href, baseUrl);
    if (url.origin !== new URL(baseUrl).origin) return null;
    if (probe?.contentLength != null && probe.contentLength > maxDownloadBytes) return null;

    const response = await context.request.get(url.href, {
      timeout: timeoutMs,
      failOnStatusCode: false
    });
    if (!response.ok()) return null;

    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    const disposition = headers['content-disposition'] || '';
    const lowerType = contentType.toLowerCase();
    if (lowerType.includes('text/html') && !disposition.toLowerCase().includes('attachment')) return null;

    const body = await response.body();
    if (body.length > maxDownloadBytes) return null;

    let filename = filenameFromDisposition(disposition);
    if (!filename) {
      const pathnameName = decodeURIComponent(url.pathname.split('/').pop() || 'file');
      filename = suggestedName || pathnameName;
    }
    filename = safeName(filename, `file-${shortHash(url.href)}`);
    if (!path.extname(filename)) filename += extensionFromContentType(contentType);
    if (!path.extname(filename)) filename += '.bin';

    const final = path.join(targetDir, `${shortHash(url.href)}-${filename}`);
    await ensureDir(targetDir);
    const action = await writeBufferIfChanged(final, body);
    return { url: url.href, file: path.basename(final), size: body.length, contentType, action };
  } catch {
    return null;
  }
}

export function isStructuralResourceCandidate(item = {}) {
  return Boolean(
    item.force
    || ['iframe', 'embed', 'object', 'source', 'track', 'img', 'video', 'audio'].includes(String(item.tag || '').toLowerCase())
    || isLikelyDownload(item.href || '')
  );
}

export async function syncVisibleResources(page, context, targetDir, manifestFile, baseUrl, timeoutMs, config = {}) {
  const candidates = await extractResourceCandidates(page).catch(() => []);
  const results = [];
  const downloads = [];
  const seen = new Set();
  const policy = assetPolicy(config);
  let existingAssets = [];
  try { existingAssets = JSON.parse((await readExistingText(manifestFile)) || '[]'); } catch {}
  const previousByUrl = new Map((Array.isArray(existingAssets) ? existingAssets : []).filter(x => x?.url).map(x => [stableAssetUrl(x.url), x]));

  for (const item of candidates) {
    // Normal navigation anchors are semantic page links, not downloadable/media
    // assets. Indexing them made asset manifests depend on volatile Brightspace UI
    // chrome and created false updates on otherwise unchanged syncs.
    if (!isStructuralResourceCandidate(item)) continue;

    const candidateUrl = new URL(item.href, baseUrl);
    const stableCandidateUrl = stableAssetUrl(candidateUrl.href);
    if (seen.has(stableCandidateUrl)) continue;
    seen.add(stableCandidateUrl);

    const sameOrigin = candidateUrl.origin === new URL(baseUrl).origin;
    const preliminaryKind = assetKindFrom(item.href, '', item.tag);
    const preliminaryDownloadEligible = shouldDownloadAsset(preliminaryKind, policy)
      || (preliminaryKind === 'other' && item.force && isLikelyDownload(item.href));
    // Avoid extra network traffic for media/embed assets that are index-only by
    // policy. Probe headers only when they can affect a download decision.
    let probe = (sameOrigin && preliminaryDownloadEligible)
      ? await probeResource(context, item.href, baseUrl, timeoutMs)
      : { sameOrigin, url: candidateUrl.href, contentType: '', contentLength: null, disposition: '' };
    let kind = assetKindFrom(item.href, probe.contentType, item.tag);
    // Unknown same-origin links should only be treated as downloadable when the
    // URL itself looks like a file/download endpoint. This avoids fetching whole
    // HTML pages merely because they appeared in an embed element.
    const downloadEligible = shouldDownloadAsset(kind, policy)
      || (kind === 'other' && item.force && isLikelyDownload(item.href));
    const tooLarge = probe.contentLength != null && probe.contentLength > policy.maxDownloadBytes;
    let saved = null;

    if (probe.sameOrigin && downloadEligible && !tooLarge) {
      const quickAllowed = config.syncMode !== 'quick' || config._allowAssetDownloadsInCurrentSection === true;
      if (quickAllowed) {
        saved = await downloadLink(context, item.href, item.name, targetDir, baseUrl, timeoutMs, probe, policy.maxDownloadBytes);
        if (saved) downloads.push(saved);
      }
    }

    if (!probe.sameOrigin && !policy.indexExternalAssets) continue;
    const stableUrl = stableAssetUrl(probe.url);
    const previous = previousByUrl.get(stableUrl);
    let downloaded = Boolean(saved);
    let localFile = saved?.file || null;
    if (!downloaded && previous?.downloaded && previous?.localFile) {
      try {
        await fs.access(path.join(targetDir, previous.localFile));
        downloaded = true;
        localFile = previous.localFile;
      } catch {}
    }
    results.push({
      url: stableUrl,
      name: item.name || previous?.name || '',
      element: item.tag || previous?.element || '',
      kind,
      sameOrigin: probe.sameOrigin,
      contentType: probe.contentType || previous?.contentType || '',
      contentLength: probe.contentLength ?? previous?.contentLength ?? null,
      downloaded,
      localFile,
      skipReason: downloaded ? null
        : !probe.sameOrigin ? 'external-link-only'
          : tooLarge ? 'over-size-limit'
            : (kind === 'video' || kind === 'audio') && !shouldDownloadAsset(kind, policy) ? 'large-media-index-only'
              : !downloadEligible ? 'not-downloadable-by-policy'
                : config.syncMode === 'quick' && config._allowAssetDownloadsInCurrentSection !== true ? 'deferred-until-full-sync'
                  : 'download-unavailable'
    });
  }

  results.sort((a, b) => `${a.url}|${a.kind}|${a.element}|${a.name}`.localeCompare(`${b.url}|${b.kind}|${b.element}|${b.name}`));
  const assetAction = await writeJson(manifestFile, results);
  return { assets: results, downloads, assetAction };
}

// Backward-compatible export name used by older call sites. v1.2 call sites use
// syncVisibleResources so every page gets an asset index even when media is not
// downloaded.
export async function downloadVisibleResources(page, context, targetDir, baseUrl, timeoutMs, config = {}) {
  const manifestFile = path.join(targetDir, '_assets.json');
  const result = await syncVisibleResources(page, context, targetDir, manifestFile, baseUrl, timeoutMs, config);
  return result.downloads;
}

function canonicalizeUrl(raw, baseUrl) {
  try {
    const u = new URL(raw, baseUrl);
    u.hash = '';
    return u.href;
  } catch { return raw; }
}

function contentUrlBelongs(url, courseId, baseUrl) {
  try {
    const u = new URL(url, baseUrl);
    if (u.origin !== new URL(baseUrl).origin) return false;
    const p = u.pathname.toLowerCase();
    return p.includes(`/d2l/le/content/${courseId}`.toLowerCase())
      || p.includes(`/d2l/le/lessons/${courseId}`.toLowerCase());
  } catch {
    return false;
  }
}

async function crawlInteractiveContentModules(page, context, course, contentDir, config) {
  const modules = await page.locator('li[data-key*="ContentObject.ModuleCO-"]').evaluateAll(items => items.map(li => {
    const key = li.getAttribute('data-key') || '';
    const m = key.match(/ModuleCO-(\d+)/i);
    const anchor = li.querySelector(':scope > a');
    const labelNode = li.querySelector('[id^="TreeItem"] .d2l-textblock:not(.d2l-offscreen)');
    const label = (labelNode?.textContent || anchor?.innerText || '').replace(/\s+/g, ' ').trim();
    return m ? { key, moduleId: m[1], label } : null;
  }).filter(Boolean)).catch(() => []);

  const unique = [];
  const seen = new Set();
  for (const m of modules) {
    if (seen.has(m.moduleId)) continue;
    seen.add(m.moduleId);
    unique.push(m);
  }

  const discoveredUrls = new Set();
  const index = [];
  const limit = Math.min(unique.length, Number(config.maxInteractiveModulesPerCourse || 80));

  for (let i = 0; i < limit; i++) {
    const mod = unique[i];
    const key = String(i + 1).padStart(4, '0');
    const modDir = path.join(contentDir, 'Modules', `${key}-${safeName(mod.label || `Module ${mod.moduleId}`)}`);
    const networkDir = path.join(modDir, '_network');
    const stopCapture = attachNetworkCapture(page, networkDir, config.baseUrl, config.captureNetwork !== false);

    const clicked = await page.evaluate(moduleKey => {
      const li = [...document.querySelectorAll('li[data-key]')].find(x => x.getAttribute('data-key') === moduleKey);
      const a = li?.querySelector(':scope > a');
      if (!a) return false;
      a.click();
      return true;
    }, mod.key).catch(() => false);

    if (!clicked) {
      await stopCapture();
      continue;
    }

    await page.waitForTimeout(config.dynamicWaitMs || 1800);
    const changeMeta = { courseId: course.id, course: course.name, type: 'content-module', id: mod.moduleId, title: mod.label || `Module ${mod.moduleId}`, url: page.url() };
    const snapshot = await savePageSnapshot(page, modDir, 'page', config, changeMeta);
    const snapshotAction = snapshot.action;
    recordChange(config, { action: snapshotAction, ...changeMeta, diagnostic: snapshot.diagnostic });
    const assets = await syncVisibleResources(page, context, path.join(modDir, 'Files'), path.join(modDir, 'assets.json'), config.baseUrl, config.downloadTimeoutMs, config);
    const downloads = assets.downloads;
    recordChange(config, { action: assets.assetAction, courseId: course.id, course: course.name, type: 'assets-index', id: mod.moduleId, title: mod.label || `Module ${mod.moduleId}`, url: page.url() });
    const links = await extractLinks(page).catch(() => []);
    for (const link of links) {
      if (contentUrlBelongs(link.href, course.id, config.baseUrl)) discoveredUrls.add(canonicalizeUrl(link.href, config.baseUrl));
    }
    for (const d of downloads) recordChange(config, { action: d.action, courseId: course.id, course: course.name, type: 'file', title: d.file, url: d.url });
    index.push({ ...mod, snapshot: path.relative(contentDir, modDir), snapshotAction, downloads: downloads.length, discoveredContentUrls: links.filter(l => contentUrlBelongs(l.href, course.id, config.baseUrl)).map(l => l.href) });
    await stopCapture();
  }

  await writeJson(path.join(contentDir, '_modules.json'), index);
  return { modules: index.length, urls: [...discoveredUrls] };
}

export async function crawlContent(page, context, course, startUrl, courseDir, config) {
  const contentDir = path.join(courseDir, 'Content');
  const queue = [canonicalizeUrl(startUrl, config.baseUrl)];
  const visited = new Set();
  const index = [];
  let interactiveModules = 0;
  let interactiveDone = false;

  while (queue.length && visited.size < config.maxContentPagesPerCourse) {
    const url = canonicalizeUrl(queue.shift(), config.baseUrl);
    if (!url || visited.has(url)) continue;
    visited.add(url);

    console.log(`    content ${visited.size}: ${url}`);
    const pageKey = String(visited.size).padStart(4, '0');
    const snapshotDir = path.join(contentDir, 'Pages');
    const networkDir = path.join(contentDir, '_network', pageKey);
    const stopCapture = attachNetworkCapture(page, networkDir, config.baseUrl, config.captureNetwork !== false);

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs }).catch(() => null);
    await page.waitForTimeout(config.dynamicWaitMs || 1800);

    const title = await page.title().catch(() => '');
    const changeMeta = { courseId: course.id, course: course.name, type: 'content-page', id: pageKey, title, url: page.url() };
    const snapshot = await savePageSnapshot(page, snapshotDir, pageKey, config, changeMeta);
    const snapshotAction = snapshot.action;
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const pageAssets = await syncVisibleResources(page, context, path.join(contentDir, 'Files'), path.join(snapshotDir, `${pageKey}.assets.json`), config.baseUrl, config.downloadTimeoutMs, config);
    const pageDownloads = pageAssets.downloads;
    recordChange(config, { action: snapshotAction, ...changeMeta, diagnostic: snapshot.diagnostic });
    recordChange(config, { action: pageAssets.assetAction, courseId: course.id, course: course.name, type: 'assets-index', id: pageKey, title, url: page.url() });
    for (const d of pageDownloads) recordChange(config, { action: d.action, courseId: course.id, course: course.name, type: 'file', title: d.file, url: d.url });
    index.push({ pageKey, requestedUrl: url, finalUrl: page.url(), status: response?.status?.() ?? null, title, action: snapshotAction, downloads: pageDownloads.length, assets: pageAssets.assets.length, textPreview: bodyText.slice(0, 1000) });

    // Classic Brightspace Content uses JavaScript-only module tree links. A URL-only
    // crawler sees the tree but never enters those modules. Click each module once,
    // snapshot the rendered module, and collect the real topic URLs it reveals.
    if (!interactiveDone && /\/d2l\/le\/content\/\d+\/Home/i.test(url)) {
      interactiveDone = true;
      const interactive = await crawlInteractiveContentModules(page, context, course, contentDir, config).catch(() => ({ modules: 0, urls: [] }));
      interactiveModules = interactive.modules;
      for (const next of interactive.urls) if (!visited.has(next)) queue.push(next);
    }

    const links = await extractLinks(page);
    for (const link of links) {
      const next = canonicalizeUrl(link.href, config.baseUrl);
      if (contentUrlBelongs(next, course.id, config.baseUrl) && !visited.has(next)) queue.push(next);
    }

    await stopCapture();
  }

  await writeJson(path.join(contentDir, '_index.json'), index);
  return { pages: visited.size, interactiveModules };
}


function sectionDetailKey(section, rawUrl, courseId, baseUrl) {
  try {
    const u = new URL(rawUrl, baseUrl);
    if (u.origin !== new URL(baseUrl).origin) return null;
    const p = u.pathname;

    if (section === 'assignments' && /\/d2l\/lms\/dropbox\/user\/folder_submit_files\.d2l$/i.test(p)) {
      if (u.searchParams.get('ou') !== String(courseId)) return null;
      const db = u.searchParams.get('db');
      return db ? `assignment-${db}` : null;
    }

    if (section === 'announcements') {
      const m = p.match(new RegExp(`/d2l/le/news/${courseId}/(\\d+)/view$`, 'i'));
      return m ? `announcement-${m[1]}` : null;
    }

    if (section === 'discussions') {
      const m = p.match(new RegExp(`/d2l/le/${courseId}/discussions/topics/(\\d+)/View$`, 'i'));
      return m ? `topic-${m[1]}` : null;
    }

    if (section === 'calendar') {
      const m = p.match(new RegExp(`/d2l/le/calendar/${courseId}/event/(\\d+)`, 'i'));
      return m ? `event-${m[1]}` : null;
    }

    if (section === 'quizzes') {
      // Read only quiz summary/results pages. Never navigate to quiz start/attempt URLs.
      if (/start|attempt|take_quiz|quiz_start/i.test(`${p}${u.search}`)) return null;
      if (!/\/d2l\/lms\/quizzing\/user\//i.test(p)) return null;
      const qi = u.searchParams.get('qi') || u.searchParams.get('quizId') || u.searchParams.get('quizid');
      if (qi && (u.searchParams.get('ou') === String(courseId) || !u.searchParams.get('ou'))) return `quiz-${qi}`;
    }
  } catch {}
  return null;
}

async function crawlSectionDetails(page, context, course, section, links, sectionDir, config) {
  const targets = new Map();
  for (const link of links) {
    const key = sectionDetailKey(section, link.href, course.id, config.baseUrl);
    if (key && !targets.has(key)) targets.set(key, { key, url: link.href, label: link.text || link.title || key });
  }

  const limit = Number(config.maxSectionDetailPagesPerCourse || 120);
  const index = [];
  for (const target of [...targets.values()].slice(0, limit)) {
    console.log(`    ${section} detail: ${target.label}`);
    const detailDir = path.join(sectionDir, 'Details', safeName(target.key));
    const networkDir = path.join(detailDir, '_network');
    const stopCapture = attachNetworkCapture(page, networkDir, config.baseUrl, config.captureNetwork !== false);
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs }).catch(() => null);
    await page.waitForTimeout(config.dynamicWaitMs || 1800);
    const changeMeta = { courseId: course.id, course: course.name, type: `${section}-detail`, id: target.key, title: target.label, url: page.url() };
    const snapshot = await savePageSnapshot(page, detailDir, 'page', config, changeMeta);
    const snapshotAction = snapshot.action;
    recordChange(config, { action: snapshotAction, ...changeMeta, diagnostic: snapshot.diagnostic });
    const assets = await syncVisibleResources(page, context, path.join(detailDir, 'Files'), path.join(detailDir, 'assets.json'), config.baseUrl, config.downloadTimeoutMs, config);
    const downloads = assets.downloads;
    recordChange(config, { action: assets.assetAction, courseId: course.id, course: course.name, type: 'assets-index', id: target.key, title: target.label, url: page.url() });
    for (const d of downloads) recordChange(config, { action: d.action, courseId: course.id, course: course.name, type: 'file', title: d.file, url: d.url });
    const bodyText = await page.locator('body').innerText().catch(() => '');
    index.push({
      key: target.key,
      label: target.label,
      requestedUrl: target.url,
      finalUrl: page.url(),
      status: response?.status?.() ?? null,
      title: await page.title().catch(() => ''),
      action: snapshotAction,
      downloads: downloads.length,
      textPreview: bodyText.slice(0, 1500)
    });
    await stopCapture();
  }

  if (index.length) await writeJson(path.join(sectionDir, 'Details', '_index.json'), index);
  return index;
}

export async function syncSection(page, context, course, section, url, courseDir, config) {
  const quickDetailSections = Array.isArray(config.quickDetailSections) ? config.quickDetailSections : ['announcements'];
  const quickAssetSections = Array.isArray(config.quickAssetDownloadSections) ? config.quickAssetDownloadSections : ['announcements'];
  const sectionConfig = {
    ...config,
    _allowAssetDownloadsInCurrentSection: config.syncMode !== 'quick' || quickAssetSections.includes(section)
  };

  const dir = path.join(courseDir, safeName(section));
  const networkDir = path.join(dir, '_network');
  const stopCapture = attachNetworkCapture(page, networkDir, config.baseUrl, config.captureNetwork !== false);

  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs }).catch(() => null);
  await page.waitForTimeout(config.dynamicWaitMs || 1800);

  const status = response?.status?.() ?? null;
  const changeMeta = { courseId: course.id, course: course.name, type: `${section}-list`, title: section, url: page.url() };
  const snapshot = section === 'calendar'
    ? await saveCalendarListSnapshot(page, dir, 'page', course.id, sectionConfig, changeMeta)
    : section === 'assignments'
      ? await saveAssignmentsListSnapshot(page, dir, 'page', course.id, sectionConfig, changeMeta)
      : section === 'announcements'
        ? await saveAnnouncementsListSnapshot(page, dir, 'page', course.id, sectionConfig, changeMeta)
        : await savePageSnapshot(page, dir, 'page', sectionConfig, changeMeta);
  const snapshotAction = snapshot.action;
  recordChange(config, { action: snapshotAction, ...changeMeta, diagnostic: snapshot.diagnostic });
  const links = await extractLinks(page).catch(() => []);
  const assets = await syncVisibleResources(page, context, path.join(dir, 'Files'), path.join(dir, 'assets.json'), config.baseUrl, config.downloadTimeoutMs, sectionConfig);
  const downloads = assets.downloads;
  recordChange(config, { action: assets.assetAction, courseId: course.id, course: course.name, type: 'assets-index', title: section, url: page.url() });
  for (const d of downloads) recordChange(config, { action: d.action, courseId: course.id, course: course.name, type: 'file', title: d.file, url: d.url });
  const listFinalUrl = page.url();
  const listTitle = await page.title().catch(() => '');
  await stopCapture();

  const shouldCrawlDetails = config.syncMode !== 'quick' || quickDetailSections.includes(section);
  const details = shouldCrawlDetails
    ? await crawlSectionDetails(page, context, course, section, links, dir, sectionConfig)
    : [];

  return {
    section,
    requestedUrl: url,
    finalUrl: listFinalUrl,
    status,
    title: listTitle,
    action: snapshotAction,
    assets: assets.assets.length,
    downloads: downloads.length,
    detailPages: details.length,
    detailCrawl: shouldCrawlDetails
  };
}