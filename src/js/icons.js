// Static SVG markup from the identity's icon set (SF-Symbols style strokes).
// These strings are constants — never mixed with clipboard content, which is
// always rendered via textContent.

const stroke = 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round"';

export const TYPE_ICONS = {
  text: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M3 8h7M3 12h5" ${stroke}/></svg>`,
  link: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.5 9.5a3.54 3.54 0 0 0 5 0l1.5-1.5a3.54 3.54 0 0 0-5-5L7.5 4" ${stroke}/><path d="M9.5 6.5a3.54 3.54 0 0 0-5 0L3 8a3.54 3.54 0 0 0 5 5l.5-.5" ${stroke}/></svg>`,
  code: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3M7 11l2-6" ${stroke} stroke-linejoin="round"/></svg>`,
  image: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="2" ${stroke}/><circle cx="6" cy="6.5" r="1.5" fill="currentColor" opacity="0.7"/><path d="M2 11l3.5-3.5 2.5 2.5 2-2 4 3" ${stroke} stroke-linejoin="round"/></svg>`,
};

const PIN_PATH = 'M10 2L14 6l-2 2-4-1-3 3v2l2-2 1 4 3-3 1 1 2-2L10 2z';

export const PIN_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="${PIN_PATH}" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
export const PIN_ICON_FILLED = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="${PIN_PATH}" fill="currentColor"/></svg>`;

export const SEARCH_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" ${stroke}/><path d="M10.5 10.5L13.5 13.5" ${stroke}/></svg>`;

// Echoes the brand mark's containing-bracket language for the empty shelf —
// the same open bracket holding two content bars, just unfilled.
export const EMPTY_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M16.5 4.9L5.6 4.9L5.6 19.1L16.5 19.1" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="9" y="9.15" width="6.75" height="2.1" rx="1.05" fill="currentColor"/><rect x="9" y="13.2" width="4.5" height="2.1" rx="1.05" fill="currentColor" opacity="0.5"/></svg>`;

// Small circular arrow for the titlebar «تحديث رَفّ» button. Sized to sit
// beside the «محلي» chip without competing with it.
export const REFRESH_ICON = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" ${stroke}/><path d="M13.5 2.6v3.1h-3.1" ${stroke} stroke-linejoin="round"/></svg>`;

// Shown by the failure state — deliberately quiet, no alarm colours. The
// bracket reads as "broken" via the gap in its stroke, not a new metaphor.
export const BROKEN_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M16.5 4.9L5.6 4.9L5.6 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.6 14.4L5.6 19.1L16.5 19.1" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="9" y="9.15" width="6.75" height="2.1" rx="1.05" fill="currentColor"/><rect x="9" y="13.2" width="4.5" height="2.1" rx="1.05" fill="currentColor" opacity="0.4"/></svg>`;

export const NO_RESULTS_ICON = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M20 7.3L9.5 7.3L9.5 24.7L18 24.7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><rect x="13" y="13.2" width="6.5" height="2.6" rx="1.3" fill="currentColor" opacity="0.6"/><circle cx="23" cy="23" r="5" ${stroke}/><path d="M26.5 26.5l4 4" ${stroke}/></svg>`;

export const SHIELD_ICON = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 2.5L3.5 5.5V10c0 4 3.5 6.5 6.5 7.5 3-1 6.5-3.5 6.5-7.5V5.5L10 2.5z" ${stroke} stroke-linejoin="round"/><path d="M7 10l2 2 4-4" ${stroke} stroke-linejoin="round"/></svg>`;

export const SUN_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" ${stroke}/><path d="M8 1.2v1.9M8 12.9v1.9M1.2 8h1.9M12.9 8h1.9M3.2 3.2l1.35 1.35M11.45 11.45l1.35 1.35M12.8 3.2l-1.35 1.35M4.55 11.45L3.2 12.8" ${stroke}/></svg>`;

export const MOON_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.6 9.8A5.9 5.9 0 0 1 6.2 2.4a5.9 5.9 0 1 0 7.4 7.4z" ${stroke} stroke-linejoin="round"/></svg>`;

export const ACCESSIBILITY_ICON = `<svg width="56" height="56" viewBox="0 0 56 56" fill="none"><circle cx="28" cy="12" r="5" stroke="currentColor" stroke-width="2"/><path d="M16 22c0 0 4-3 12-3s12 3 12 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 22v10l-4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 22v10l4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 32l-2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M32 32l2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
