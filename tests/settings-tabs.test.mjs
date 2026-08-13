// Contract and interaction coverage for Raff's compact macOS-style Settings
// pages. The suite exercises the production markup and module in JSDOM; it
// deliberately avoids layout assertions because JSDOM has no layout engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsHtml = readFileSync(path.join(here, '../src/settings.html'), 'utf8');

const TABS = [
  { name: 'عام', suffix: 'general' },
  { name: 'الالتقاط', suffix: 'capture' },
  { name: 'الخصوصية', suffix: 'privacy' },
  { name: 'التعلّم', suffix: 'learning' },
  { name: 'حول', suffix: 'about' },
];

const SETTINGS = {
  hotkey: 'shift+super+v',
  launchAtLogin: false,
  historyLimit: 500,
  captureEnabled: true,
  respectConcealed: true,
  excludedApps: [],
  learningEnabled: true,
  firstRunShown: true,
  appearance: 'light',
  followSystem: true,
};

function createFakeTauri() {
  let settings = structuredClone(SETTINGS);
  const calls = [];
  const tauri = {
    core: {
      invoke(cmd, args) {
        calls.push({ cmd, args: structuredClone(args) });
        switch (cmd) {
          case 'get_state':
            return Promise.resolve({
              pinned: [],
              history: [],
              settings: structuredClone(settings),
              axTrusted: true,
              version: '4.0.0',
            });
          case 'update_settings':
            settings = structuredClone(args.settings);
            return Promise.resolve(null);
          case 'list_running_apps':
            return Promise.resolve([
              { name: 'Notes', bundleId: 'com.apple.Notes' },
            ]);
          case 'learning_summary':
            return Promise.resolve([]);
          case 'check_for_update':
            return Promise.resolve({ status: 'upToDate' });
          case 'consume_update_intent':
            return Promise.resolve(false);
          default:
            return Promise.resolve(null);
        }
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };

  return {
    tauri,
    countOf(cmd) {
      return calls.filter((call) => call.cmd === cmd).length;
    },
  };
}

function flush(times = 4) {
  let result = Promise.resolve();
  for (let index = 0; index < times; index += 1) {
    result = result.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return result;
}

async function mountSettings() {
  const dom = new JSDOM(settingsHtml, { url: 'http://localhost/settings.html' });
  dom.window.Element.prototype.scrollIntoView = () => {};
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const fake = createFakeTauri();
  dom.window.__TAURI__ = fake.tauri;
  const uncaught = [];
  dom.window.addEventListener('error', (event) =>
    uncaught.push(String(event.error ?? event.message))
  );
  dom.window.addEventListener('unhandledrejection', (event) =>
    uncaught.push(String(event.reason))
  );

  await import('../src/js/settings.js');
  await flush();
  return { dom, fake, uncaught };
}

const byId = (dom, id) => dom.window.document.getElementById(id);
const tabs = (dom) => [...dom.window.document.querySelectorAll('#settings-tabs [role="tab"]')];
const panels = (dom) => [...dom.window.document.querySelectorAll('[role="tabpanel"]')];
const selectedTabs = (dom) =>
  tabs(dom).filter((tab) => tab.getAttribute('aria-selected') === 'true');
const selectedTab = (dom) => selectedTabs(dom)[0];
const visiblePanels = (dom) => panels(dom).filter((panel) => !panel.hidden);

function press(dom, target, key) {
  target.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    })
  );
}

function assertActive(dom, suffix) {
  const tab = byId(dom, `settings-tab-${suffix}`);
  const panel = byId(dom, `settings-panel-${suffix}`);
  assert.equal(selectedTab(dom), tab, `${suffix} is the selected tab`);
  assert.equal(selectedTabs(dom).length, 1, `${suffix} is the only selected tab`);
  assert.equal(tab.tabIndex, 0, `${suffix} is the only tab in the tab order`);
  assert.equal(tabs(dom).filter((candidate) => candidate.tabIndex === 0).length, 1);
  assert.equal(dom.window.document.activeElement, tab, `${suffix} receives keyboard focus`);
  assert.deepEqual(visiblePanels(dom), [panel], `${suffix} is the only visible page`);
}

test('compact tabbed Settings contract and interactions', async (t) => {
  // settings.js is a window-lifetime singleton, just like its WKWebView in
  // production. Mount it once and drive every assertion through that session.
  const { dom, fake, uncaught } = await mountSettings();

  await t.test('exactly five labelled ARIA tabs expose one initial page', async (tabTest) => {
    const tablist = byId(dom, 'settings-tabs');
    assert.ok(tablist, 'the Settings tab list exists');
    assert.equal(tablist.getAttribute('role'), 'tablist');
    assert.ok(tablist.getAttribute('aria-label'), 'the tab list has an accessible name');
    assert.equal(dom.window.document.documentElement.dir, 'rtl');

    const actualTabs = tabs(dom);
    const actualPanels = panels(dom);
    assert.equal(actualTabs.length, 5, 'there are exactly five tabs');
    assert.equal(actualPanels.length, 5, 'there are exactly five tab panels');

    for (const [index, expected] of TABS.entries()) {
      await tabTest.test(expected.name, () => {
        const tab = actualTabs[index];
        const panel = byId(dom, `settings-panel-${expected.suffix}`);
        assert.equal(tab.id, `settings-tab-${expected.suffix}`);
        assert.equal(tab.textContent.replace(/\s+/gu, ' ').trim(), expected.name);
        assert.equal(tab.getAttribute('role'), 'tab');
        assert.equal(tab.getAttribute('aria-controls'), panel.id);
        assert.equal(panel.getAttribute('role'), 'tabpanel');
        assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
      });
    }

    assert.equal(selectedTab(dom)?.id, 'settings-tab-general');
    assert.equal(selectedTabs(dom).length, 1);
    assert.equal(tabs(dom).filter((tab) => tab.tabIndex === 0).length, 1);
    assert.deepEqual(visiblePanels(dom).map((panel) => panel.id), ['settings-panel-general']);
  });

  await t.test('clicking switches selection and leaves one page visible', () => {
    const capture = byId(dom, 'settings-tab-capture');
    capture.click();
    assert.equal(selectedTab(dom), capture);
    assert.equal(selectedTabs(dom).length, 1);
    assert.equal(capture.tabIndex, 0);
    assert.equal(tabs(dom).filter((tab) => tab.tabIndex === 0).length, 1);
    assert.deepEqual(visiblePanels(dom).map((panel) => panel.id), ['settings-panel-capture']);
  });

  await t.test('RTL arrows, Home, and End select and focus the expected page', () => {
    const general = byId(dom, 'settings-tab-general');
    general.click();
    general.focus();

    // DOM/visual order runs right-to-left: ArrowLeft advances visually left.
    press(dom, general, 'ArrowLeft');
    assertActive(dom, 'capture');
    press(dom, byId(dom, 'settings-tab-capture'), 'ArrowRight');
    assertActive(dom, 'general');

    // Previous from the right-most tab wraps to the left-most tab.
    press(dom, general, 'ArrowRight');
    assertActive(dom, 'about');
    press(dom, byId(dom, 'settings-tab-about'), 'ArrowLeft');
    assertActive(dom, 'general');

    press(dom, general, 'End');
    assertActive(dom, 'about');
    press(dom, byId(dom, 'settings-tab-about'), 'Home');
    assertActive(dom, 'general');
  });

  await t.test('appearance radios use one roving stop and RTL arrow selection', async () => {
    const group = byId(dom, 'appearance-segments');
    const radios = [...group.querySelectorAll('[role="radio"]')];
    const checked = () => radios.filter((radio) => radio.getAttribute('aria-checked') === 'true');
    const tabbable = () => radios.filter((radio) => radio.tabIndex === 0);

    assert.equal(group.getAttribute('role'), 'radiogroup');
    assert.deepEqual(checked(), [radios[0]], 'follow-system maps to تلقائي');
    assert.deepEqual(tabbable(), [radios[0]]);

    radios[0].focus();
    press(dom, radios[0], 'ArrowLeft');
    await flush();
    assert.deepEqual(checked(), [radios[1]], 'ArrowLeft advances visually left to داكن');
    assert.deepEqual(tabbable(), [radios[1]]);
    assert.equal(dom.window.document.activeElement, radios[1]);

    press(dom, radios[1], 'End');
    await flush();
    assert.deepEqual(checked(), [radios[2]]);
    assert.deepEqual(tabbable(), [radios[2]]);

    press(dom, radios[2], 'Home');
    await flush();
    assert.deepEqual(checked(), [radios[0]]);
    assert.deepEqual(tabbable(), [radios[0]]);
  });

  await t.test('each page retains its production controls and legacy columns are gone', () => {
    const expectedByPanel = {
      general: ['launch-toggle', 'history-limit', 'appearance-segments'],
      capture: ['capture-toggle'],
      privacy: [
        'hotkey-chip',
        'hotkey-sub',
        'concealed-toggle',
        'manage-excluded',
        'excluded-manager',
        'excluded-list',
        'running-apps',
        'add-excluded',
      ],
      learning: ['learning-toggle', 'show-learning', 'learning-view', 'clear-learning'],
      about: [
        'settings-version',
        'settings-repo',
        'settings-update',
        'settings-update-status',
        'open-about',
      ],
    };

    for (const [suffix, ids] of Object.entries(expectedByPanel)) {
      const panel = byId(dom, `settings-panel-${suffix}`);
      for (const id of ids) {
        const control = byId(dom, id);
        assert.ok(control, `${id} was retained`);
        assert.ok(panel.contains(control), `${id} belongs to the ${suffix} page`);
      }
    }

    assert.equal(dom.window.document.querySelector('.settings-column'), null);
    assert.ok(dom.window.document.querySelector('.bottom-row'), 'the fixed footer remains');
    assert.ok(byId(dom, 'window-close'));
    assert.ok(byId(dom, 'clear-history'));
    assert.ok(byId(dom, 'data-status'));
    assert.ok(byId(dom, 'done-btn'));
    assert.ok(byId(dom, 'confirm-overlay'));
    assert.equal(
      dom.window.document.querySelector('.confirm-dialog')?.getAttribute('role'),
      'alertdialog'
    );
    assert.ok(byId(dom, 'confirm-cancel'));
    assert.ok(byId(dom, 'confirm-accept'));

    const allIds = [...dom.window.document.querySelectorAll('[id]')].map((node) => node.id);
    assert.equal(new Set(allIds).size, allIds.length, 'the document has no duplicate IDs');
  });

  await t.test('About, clear, learning, exclusions, and hotkey actions remain wired', async () => {
    byId(dom, 'open-about').click();
    assert.equal(fake.countOf('open_about'), 1);

    byId(dom, 'settings-repo').click();
    assert.equal(fake.countOf('open_repository'), 1);

    const updateChecks = fake.countOf('check_for_update');
    byId(dom, 'settings-update').click();
    await flush();
    assert.equal(fake.countOf('check_for_update'), updateChecks + 1);

    byId(dom, 'manage-excluded').click();
    await flush();
    assert.equal(fake.countOf('list_running_apps'), 1);
    assert.equal(byId(dom, 'manage-excluded').getAttribute('aria-expanded'), 'true');

    byId(dom, 'show-learning').click();
    await flush();
    assert.equal(fake.countOf('learning_summary'), 1);
    assert.equal(byId(dom, 'show-learning').getAttribute('aria-expanded'), 'true');

    byId(dom, 'clear-learning').click();
    byId(dom, 'clear-learning').click();
    await flush();
    assert.equal(fake.countOf('clear_learning'), 1);

    byId(dom, 'clear-history').click();
    assert.equal(byId(dom, 'confirm-overlay').hidden, false, 'clear history still opens its dialog');
    assert.equal(byId(dom, 'settings-window').hasAttribute('inert'), true);
    assert.equal(byId(dom, 'settings-window').getAttribute('aria-hidden'), 'true');
    assert.equal(dom.window.document.activeElement, byId(dom, 'confirm-cancel'));
    byId(dom, 'confirm-cancel').click();
    await flush();
    assert.equal(byId(dom, 'confirm-overlay').hidden, true);
    assert.equal(byId(dom, 'settings-window').hasAttribute('inert'), false);
    assert.equal(byId(dom, 'settings-window').hasAttribute('aria-hidden'), false);

    const updatesBeforeHotkey = fake.countOf('update_settings');
    byId(dom, 'hotkey-chip').click();
    assert.equal(byId(dom, 'hotkey-chip').classList.contains('recording'), true);
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    await flush();
    assert.equal(
      fake.countOf('update_settings'),
      updatesBeforeHotkey + 1,
      'the new hotkey is persisted'
    );
    assert.deepEqual(uncaught, []);
  });
});
