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

// «14 — App & Content Icons» → Content Icons section (12:28).
// These are the exact isolated Figma exports: 20px optical artwork, 1.5px
// stroke and round caps. The row supplies the surrounding 24px icon canvas.
// Source application identity deliberately never participates in this map.
export const CONTENT_TYPE_ICONS = Object.freeze({
  text: Object.freeze({
    asset: asset('../assets/v4/content-types/text.svg'),
    label: 'نص',
  }),
  link: Object.freeze({
    asset: asset('../assets/v4/content-types/link.svg'),
    label: 'رابط',
  }),
  code: Object.freeze({
    asset: asset('../assets/v4/content-types/code.svg'),
    label: 'شفرة برمجية',
  }),
  image: Object.freeze({
    asset: asset('../assets/v4/content-types/image.svg'),
    label: 'صورة',
  }),
  unknown: Object.freeze({
    asset: asset('../assets/v4/content-types/unknown.svg'),
    label: 'محتوى غير مصنف',
  }),
});

/** The sole ContentType → Raff Semantic Icon resolver used by history rows. */
export function contentTypeIcon(type = '') {
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPE_ICONS, type)
    ? CONTENT_TYPE_ICONS[type]
    : CONTENT_TYPE_ICONS.unknown;
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
