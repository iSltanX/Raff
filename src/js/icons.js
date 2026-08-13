// Raff v4 production assets.
//
// Every URL below resolves to approved Figma geometry. Each production file is
// either an isolated layer export or a geometry-only crop made necessary when
// Figma included the surrounding presentation frame in the download. UI colour
// is supplied through a semantic CSS mask, so one sanctioned drawing works in
// Light, Dark and component states.

const asset = (path) => new URL(path, import.meta.url).href;

// «02 — Logo System», SECTION "LIBRARY • Approved Brand Assets" (43:10) →
// COMPONENT_SET "Brand / Logo Mark" (46:27), variant Tone=Brand (43:9).
// Verified 2026-08-13: the file had been renumbered since this comment was
// last written and the previously-cited node (4:7981) no longer resolves;
// 43:9's own geometry (72/61/47-wide bars) is an exact match to this SVG's.
// This is the descending shelf logo, deliberately distinct from the
// equal-shelf app and menu icons.
export const BRAND_MARK = asset('../assets/v4/raff-logo-mark.svg');

// «08 — Product Screens» → panel Settings control (2:8094).
export const SETTINGS = asset('../assets/v4/panel-settings.svg');

// «05 — Iconography» → Product Core Icon Library.
export const SEARCH = asset('../assets/v4/icons/search.svg');
export const CLEAR = asset('../assets/v4/icons/x-circle.svg');
// «06 — Components» → Row / Action Button (77:603), exact 16px exports.
export const PIN_TOGGLE = asset('../assets/v4/icons/pin-off.svg');
export const TRASH = asset('../assets/v4/icons/trash.svg');
export const ALERT = asset('../assets/v4/icons/alert-triangle.svg');
export const IMAGE = asset('../assets/v4/icons/image.svg');
export const KEYBOARD = asset('../assets/v4/icons/keyboard.svg');
export const CHECK = asset('../assets/v4/icons/check-circle.svg');

// «06 — Components» → Row / Action Button (77:603), Pin geometry.
export const PIN = asset('../assets/v4/pin.svg');

// «08 — Product Screens» → the actual empty-panel shelf composition (2:7907).
// Figma's full-frame export carries the presentation background, so production
// composes the three original transparent line-layer exports instead.
export const SHELF = Object.freeze([
  asset('../assets/v4/empty-shelf-line-1.svg'),
  asset('../assets/v4/empty-shelf-line-2.svg'),
  asset('../assets/v4/empty-shelf-line-3.svg'),
]);

// «14 — App & Content Icons» → fallback glyphs used only when NSWorkspace
// cannot resolve installed native artwork. A category glyph never replaces a
// real ChatGPT, Claude, Chrome, Figma, or other application icon.
export const SOURCE_APP_ICONS = Object.freeze({
  figma: asset('../assets/v4/source-app/figma.svg'),
  chrome: asset('../assets/v4/source-app/chrome.svg'),
  safari: asset('../assets/v4/source-app/safari.svg'),
  notes: asset('../assets/v4/source-app/notes.svg'),
  vscode: asset('../assets/v4/source-app/app-window.svg'),
  unknown: asset('../assets/v4/source-app/app-window.svg'),
});

/** Resolves the fallback identities explicitly drawn in the Figma examples. */
export function sourceAppAsset(bundleId = '', appName = '') {
  const identity = `${bundleId} ${appName}`.toLocaleLowerCase('en');
  if (identity.includes('figma')) return SOURCE_APP_ICONS.figma;
  if (/google\.chrome|\bchrome\b|chromium/u.test(identity)) return SOURCE_APP_ICONS.chrome;
  if (/apple\.safari|\bsafari\b|سفاري/u.test(identity)) return SOURCE_APP_ICONS.safari;
  if (/apple\.notes|\bnotes\b|الملاحظات/u.test(identity)) return SOURCE_APP_ICONS.notes;
  if (/microsoft\.vscode|visual studio code|\bvs code\b/u.test(identity)) {
    return SOURCE_APP_ICONS.vscode;
  }
  return null;
}

/**
 * Creates a colour-adaptive icon from an original Figma SVG asset.
 * The source remains external instead of being copied into application code.
 */
export function createIcon(source, className = '') {
  const icon = document.createElement('span');
  icon.className = `figma-icon ${className}`.trim();
  icon.setAttribute('aria-hidden', 'true');
  icon.style.setProperty('--figma-icon', `url(${source})`);
  return icon;
}
