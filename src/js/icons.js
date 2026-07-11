// Static SVG markup from the identity's icon set (SF-Symbols style strokes).
// These strings are constants — never mixed with clipboard content, which is
// always rendered via textContent.

const stroke = 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round"';

export const TYPE_ICONS = {
  text: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M3 8h7M3 12h5" ${stroke}/></svg>`,
  link: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.5 9.5a3.54 3.54 0 0 0 5 0l1.5-1.5a3.54 3.54 0 0 0-5-5L7.5 4" ${stroke}/><path d="M9.5 6.5a3.54 3.54 0 0 0-5 0L3 8a3.54 3.54 0 0 0 5 5l.5-.5" ${stroke}/></svg>`,
  code: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3M7 11l2-6" ${stroke} stroke-linejoin="round"/></svg>`,
  image: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="2" ${stroke}/><circle cx="6" cy="6.5" r="1.5" fill="currentColor" opacity="0.7"/><path d="M2 11l3.5-3.5 2.5 2.5 2-2 4 3" ${stroke} stroke-linejoin="round"/></svg>`,
  prompt: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2l1.5 4.5H14l-3.75 2.73 1.43 4.39L8 11l-3.68 2.62 1.43-4.39L2 6.5h4.5L8 2z" ${stroke} stroke-linejoin="round"/></svg>`,
};

const PIN_PATH = 'M10 2L14 6l-2 2-4-1-3 3v2l2-2 1 4 3-3 1 1 2-2L10 2z';

export const PIN_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="${PIN_PATH}" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
export const PIN_ICON_FILLED = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="${PIN_PATH}" fill="currentColor"/></svg>`;

export const SEARCH_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" ${stroke}/><path d="M10.5 10.5L13.5 13.5" ${stroke}/></svg>`;

export const EMPTY_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="4" y="8" width="16" height="12" rx="2" ${stroke}/><path d="M8 8V6a4 4 0 0 1 8 0v2" ${stroke}/></svg>`;

export const NO_RESULTS_ICON = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="15" cy="15" r="9" ${stroke}/><path d="M22 22L28 28" ${stroke}/><path d="M12 15h6M15 12v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.35"/></svg>`;

export const SHIELD_ICON = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 2.5L3.5 5.5V10c0 4 3.5 6.5 6.5 7.5 3-1 6.5-3.5 6.5-7.5V5.5L10 2.5z" ${stroke} stroke-linejoin="round"/><path d="M7 10l2 2 4-4" ${stroke} stroke-linejoin="round"/></svg>`;

export const ACCESSIBILITY_ICON = `<svg width="56" height="56" viewBox="0 0 56 56" fill="none"><circle cx="28" cy="12" r="5" stroke="currentColor" stroke-width="2"/><path d="M16 22c0 0 4-3 12-3s12 3 12 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 22v10l-4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 22v10l4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 32l-2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M32 32l2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
