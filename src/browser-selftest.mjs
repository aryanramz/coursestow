import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BROWSER_ENGINE_ID,
  EDGE_DOWNLOAD_URL,
  chromiumBrowserCandidates,
  findCompatibleChromiumExecutable,
  inspectChromiumBrowser,
  probeChromiumExecutable
} from './browser.mjs';
import { probeDesktopBrowser } from './desktop-browser.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'coursestow-browser-contract-'));
try {
  const env = {
    LOCALAPPDATA: path.join(temp, 'Local App Data'),
    PROGRAMFILES: path.join(temp, 'Program Files'),
    'PROGRAMFILES(X86)': path.join(temp, 'Program Files x86')
  };
  const configured = path.join(temp, 'Custom Browser', 'custom.exe');
  const candidates = chromiumBrowserCandidates(configured, env);
  assert.equal(candidates[0].source, 'configured', 'configured executable must have highest priority');
  assert.equal(candidates[0].path, path.normalize(configured));
  assert.deepEqual(
    [...new Set(candidates.filter(item => item.source === 'automatic').map(item => item.name))],
    ['Microsoft Edge', 'Google Chrome', 'Brave', 'Vivaldi', 'Opera', 'Opera GX', 'Chromium'],
    'automatic Chromium-family ordering must be deterministic'
  );
  assert.equal(candidates.every(item => item.source === 'configured'
    || [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].some(root => item.path.startsWith(root))), true,
  'discovery must use only fixed installation locations rather than broad filesystem scanning');

  const automaticCandidates = candidates.filter(item => item.source === 'automatic');
  for (const family of ['Microsoft Edge', 'Google Chrome', 'Brave', 'Vivaldi', 'Opera', 'Opera GX', 'Chromium']) {
    const selected = automaticCandidates.find(item => item.name === family);
    const result = await inspectChromiumBrowser('', {
      env,
      useCache: false,
      io: { stat: async value => ({ isFile: () => value === selected.path }) },
      probe: async value => ({ compatible: value === selected.path, status: 'compatible' })
    });
    assert.equal(result.available, true, `${family} fixture must be detected`);
    assert.equal(result.displayName, family);
    assert.equal(result.engine, BROWSER_ENGINE_ID);
    assert.equal(result.source, 'automatic');
  }

  const missingConfigured = await inspectChromiumBrowser(configured, {
    env,
    useCache: false,
    io: { stat: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } },
    probe: async () => { throw new Error('missing configured executable must not be probed'); }
  });
  assert.equal(missingConfigured.available, false);
  assert.equal(missingConfigured.validationStatus, 'missing');
  assert.equal(missingConfigured.configuredManually, true);

  const runtimeCompatible = await findCompatibleChromiumExecutable(configured, {
    env,
    useCache: false,
    io: { stat: async value => ({ isFile: () => value === configured }) },
    probe: async value => ({ compatible: value === configured, status: 'compatible' })
  });
  assert.equal(runtimeCompatible.path, configured, 'runtime browser lookup must require the compatibility probe');
  await assert.rejects(
    findCompatibleChromiumExecutable(configured, {
      env,
      useCache: false,
      io: { stat: async value => ({ isFile: () => value === configured }) },
      probe: async () => ({ compatible: false, status: 'incompatible' })
    }),
    /No compatible Chromium browser/,
    'runtime commands must reject a present executable that fails the compatibility probe'
  );

  const fakeExecutable = path.join(temp, 'probe.exe');
  await fs.writeFile(fakeExecutable, 'synthetic executable fixture');
  let observedProfile = '';
  let observedOptions;
  const compatible = await probeChromiumExecutable(fakeExecutable, {
    tempRoot: path.join(temp, 'Probe Temp'),
    launchPersistentContext: async (profileDir, options) => {
      observedProfile = profileDir;
      observedOptions = options;
      const page = {
        goto: async value => assert.match(value, /^data:text\/html,/),
        title: async () => 'CourseStow compatibility probe'
      };
      return { pages: () => [page], newPage: async () => page, close: async () => {} };
    }
  });
  assert.equal(compatible.compatible, true, 'compatible Chromium probe must pass');
  assert.equal(observedOptions.executablePath, fakeExecutable);
  assert.equal(observedOptions.headless, true);
  assert.equal(observedProfile.includes('BrowserProfile'), false, 'compatibility probe must never use the user BrowserProfile');
  await assert.rejects(fs.access(observedProfile), 'temporary compatibility profile must be deleted');

  let rejectedProfile = '';
  const rejected = await probeChromiumExecutable(fakeExecutable, {
    tempRoot: path.join(temp, 'Rejected Temp'),
    launchPersistentContext: async profileDir => {
      rejectedProfile = profileDir;
      throw new Error('not a Chromium browser');
    }
  });
  assert.equal(rejected.compatible, false, 'non-browser executable must be rejected');
  assert.equal(rejected.status, 'incompatible');
  await assert.rejects(fs.access(rejectedProfile), 'rejected-probe temporary profile must be deleted');
  assert.equal(EDGE_DOWNLOAD_URL, 'https://www.microsoft.com/edge/download', 'missing-browser recovery URL must be fixed and trusted');

  let automaticProbePath = 'not-called';
  const automaticProbe = await probeDesktopBrowser({ schemaVersion: 1, executablePath: '' }, {
    inspect: async executablePath => {
      automaticProbePath = executablePath;
      return {
        engine: BROWSER_ENGINE_ID,
        available: true,
        displayName: 'Microsoft Edge',
        executablePath: path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        source: 'automatic',
        configuredManually: false,
        supportLevel: 'official',
        validationStatus: 'compatible'
      };
    }
  });
  assert.equal(automaticProbePath, '', 'reset-to-automatic must explicitly probe without the configured executable');
  assert.equal(automaticProbe.source, 'automatic');

  console.log('Browser engine, discovery, and compatibility-probe self-test: PASS');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
