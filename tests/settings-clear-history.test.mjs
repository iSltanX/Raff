// Regression coverage for «مسح سجل الحافظة» in the settings window.
// Deleting clipboard history is permanent and unrecoverable, so the guarantee
// under test is twofold: nothing is deleted unless the user explicitly
// confirms, and confirming deletes only the unpinned layer. These tests drive
// the real `src/js/settings.js` against a fake Tauri bridge whose backend
// mirrors the Rust `Store::clear_history` semantics (see the matching
// `clear_history_keeps_pinned` test in src-tauri/src/storage.rs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsHtml = readFileSync(path.join(here, '../src/settings.html'), 'utf8');

const now = Date.now();

function item(id, overrides = {}) {
  return {
    id,
    type: 'text',
    text: `item ${id}`,
    sourceApp: 'Notes',
    sourceAppBundleId: 'com.apple.Notes',
    createdAt: now - 60_000,
    isPinned: false,
    copyCount: 1,
    pasteCount: 0,
    lastUsedAt: now - 60_000,
    hasImage: false,
    ...overrides,
  };
}

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
  appIcon: 'auto',
};

function createFakeTauri() {
  // Backend state mirroring the Rust store's two layers.
  const backend = {
    pinned: [item('pin-text', { isPinned: true, text: 'pinned note' })],
    history: [
      item('h-text', { text: 'a text clip' }),
      item('h-image', { type: 'image', text: 'صورة 20×20', hasImage: true }),
    ],
    settings: { ...SETTINGS },
  };
  const calls = [];

  const tauri = {
    core: {
      invoke: (cmd, args) => {
        calls.push(cmd);
        switch (cmd) {
          case 'get_state':
            return Promise.resolve({
              pinned: structuredClone(backend.pinned),
              history: structuredClone(backend.history),
              settings: structuredClone(backend.settings),
              axTrusted: true,
              version: '2.1.2',
            });
          case 'clear_history':
            // Exactly what Store::clear_history does: empty the recent layer,
            // leave the pinned shelf and settings untouched.
            backend.history = [];
            return Promise.resolve(null);
          case 'clear_learning':
            return Promise.resolve(null);
          case 'learning_summary':
            return Promise.resolve([]);
          case 'update_settings':
            backend.settings = { ...backend.settings, ...args.settings };
            return Promise.resolve(null);
          case 'list_running_apps':
            return Promise.resolve([]);
          case 'check_for_update':
            return Promise.resolve({ status: 'uptodate' });
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
    backend,
    countOf: (cmd) => calls.filter((c) => c === cmd).length,
  };
}

function flush(times = 4) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

/** Boots the real settings.js once — it binds to elements at import time and
 * lives for the whole window session, exactly as in the app. */
async function mountSettings() {
  const dom = new JSDOM(settingsHtml, { url: 'http://localhost/settings.html' });
  // jsdom implements neither layout nor media queries; settings.js uses both
  // for the appearance cards, which this suite does not exercise.
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
  dom.window.__uncaughtErrors = [];
  dom.window.addEventListener('error', (e) =>
    dom.window.__uncaughtErrors.push(String(e.error ?? e.message))
  );
  dom.window.addEventListener('unhandledrejection', (e) =>
    dom.window.__uncaughtErrors.push(String(e.reason))
  );

  await import('../src/js/settings.js');
  await flush();
  return { dom, fake };
}

const $ = (dom, id) => dom.window.document.getElementById(id);
const overlayOpen = (dom) => $(dom, 'confirm-overlay').hidden === false;
const statusVisible = (dom) => $(dom, 'data-status').hidden === false;

test('«مسح سجل الحافظة» confirmation flow', async (t) => {
  const { dom, fake } = await mountSettings();
  const clearBtn = $(dom, 'clear-history');

  await t.test('the button alone deletes nothing — it only opens the dialog', async () => {
    clearBtn.click();
    await flush();
    assert.ok(overlayOpen(dom), 'confirmation dialog is shown');
    assert.equal(fake.countOf('clear_history'), 0, 'no deletion happened yet');
    assert.equal(fake.backend.history.length, 2, 'history untouched');
  });

  await t.test('the dialog names the consequence and offers both choices', () => {
    assert.match($(dom, 'confirm-title').textContent, /مسح سجل الحافظة؟/);
    // Source-wrapped across lines; compare the way a browser renders it.
    const text = $(dom, 'confirm-text').textContent.replace(/\s+/g, ' ').trim();
    assert.match(text, /غير المثبّتة/, 'says which items are affected');
    assert.match(text, /نهائيًا/, 'says the deletion is permanent');
    assert.match(text, /لا يمكن التراجع/, 'says it cannot be undone');
    assert.match($(dom, 'confirm-cancel').textContent, /إلغاء/);
    assert.match($(dom, 'confirm-accept').textContent, /مسح السجل/);
  });

  await t.test('the destructive button is never focused by default', () => {
    assert.equal(
      dom.window.document.activeElement.id,
      'confirm-cancel',
      'a stray Return must not delete anything'
    );
  });

  await t.test('rejecting via Cancel deletes nothing', async () => {
    $(dom, 'confirm-cancel').click();
    await flush();
    assert.ok(!overlayOpen(dom), 'dialog closed');
    assert.equal(fake.countOf('clear_history'), 0, 'no deletion');
    assert.equal(fake.backend.history.length, 2, 'history intact');
    assert.ok(!statusVisible(dom), 'no success message for a cancelled action');
  });

  await t.test('rejecting via Escape deletes nothing', async () => {
    clearBtn.click();
    await flush();
    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    await flush();
    assert.ok(!overlayOpen(dom), 'dialog closed');
    assert.equal(fake.countOf('clear_history'), 0, 'no deletion');
    assert.equal(fake.backend.history.length, 2, 'history intact');
  });

  await t.test('rejecting via a backdrop click deletes nothing', async () => {
    clearBtn.click();
    await flush();
    const overlay = $(dom, 'confirm-overlay');
    overlay.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    await flush();
    assert.ok(!overlayOpen(dom));
    assert.equal(fake.countOf('clear_history'), 0);
    assert.equal(fake.backend.history.length, 2);
  });

  await t.test('confirming deletes the unpinned items only', async () => {
    clearBtn.click();
    await flush();
    $(dom, 'confirm-accept').click();
    await flush();

    assert.equal(fake.countOf('clear_history'), 1, 'deletion ran exactly once');
    assert.deepEqual(fake.backend.history, [], 'text and image clips are gone');
    assert.equal(fake.backend.pinned.length, 1, 'pinned shelf survives');
    assert.equal(fake.backend.pinned[0].id, 'pin-text');
    assert.ok(!overlayOpen(dom), 'dialog closed after confirming');
  });

  await t.test('a quiet success message confirms what happened', () => {
    assert.ok(statusVisible(dom), 'success note is shown');
    assert.equal($(dom, 'data-status').textContent, 'تم مسح سجل الحافظة.');
  });

  await t.test('settings, hotkey and appearance are untouched by the wipe', () => {
    assert.equal(fake.backend.settings.hotkey, SETTINGS.hotkey);
    assert.equal(fake.backend.settings.historyLimit, SETTINGS.historyLimit);
    assert.equal(fake.backend.settings.appearance, SETTINGS.appearance);
    assert.equal(fake.backend.settings.followSystem, SETTINGS.followSystem);
    assert.equal(fake.backend.settings.learningEnabled, SETTINGS.learningEnabled);
  });

  await t.test('clearing again on an already-empty history is harmless', async () => {
    clearBtn.click();
    await flush();
    $(dom, 'confirm-accept').click();
    await flush();
    assert.equal(fake.countOf('clear_history'), 2);
    assert.deepEqual(fake.backend.history, []);
    assert.equal(fake.backend.pinned.length, 1, 'pinned still safe');
  });

  await t.test('no uncaught errors during the whole session', () => {
    assert.deepEqual(dom.window.__uncaughtErrors, []);
  });
});
