// The رفّ mark, by construction (Figma XCNmucSuAe007qWHnOXQpW, page «01 —
// Brand & Logo Geometry»). Every length is a Fibonacci number:
//
//   the frame is 610 × 377, a golden rectangle;
//   «ر» is a quarter ring centred on the top-left of its 377² square, with
//   radii 377 and 233 (377 ÷ 233 = φ), so it is 144 thick;
//   the shelf it becomes is 233 × 144, and the card resting on it is the same
//   golden rectangle, 55 below the top and 34 above the shelf (55 + 34 = 89);
//   every corner is 34. The two corners at the head of «ر» are tangent fillets
//   (centres at 497.83, 34 and 574.31, 34), so no corner bulges.
//
// On the 1024 icon canvas the frame starts at (220, 315): the geometric centre
// moved +13, −8 (Fibonacci again) towards the mark's centre of mass.
//
// Below 64 px the 34-unit gap is less than a pixel and melts, so the menu bar
// glyph and the 16/32 px app icons are drawn on the pixel grid instead
// (stroke 4 then 2, gap 2, radii 10/6 then 12/8 and 6/4 — all close to φ).
//
// Flat: one colour per shape, no gradient, no shadow.

export const COLOUR = Object.freeze({
  plate: '#f5f1ea', // sand/50
  ink: '#1f1915', // sand/925
  card: '#c25a2f', // clay/500
  darkPlate: '#221e1b', // sand/900
  darkInk: '#f5f1ea', // sand/50
  darkCard: '#ef9d79', // clay/300
});

/** «ر» becoming the shelf, in the 610 × 377 frame. */
export const SHELF =
  'M34 233L233 233A233 233 0 0 0 464.11 29.67A34 34 0 0 1 497.83 0L574.31 0A34 34 0 0 1 608.14 37.37A377 377 0 0 1 233 377L34 377A34 34 0 0 1 0 343L0 267A34 34 0 0 1 34 233Z';
/** The card, a golden rectangle resting on the shelf. */
export const CARD = { x: 0, y: 55, width: 233, height: 144, r: 34 };
export const FRAME = { width: 610, height: 377 };
/** Where the frame sits on the 1024 icon canvas. */
export const ORIGIN = { x: 220, y: 315 };

/** The pixel-grid mark on a 16 grid (the frame is 16 × 10, from y 3). */
export const MICRO_SHELF = 'M1 9L6 9A6 6 0 0 0 12 3L16 3A10 10 0 0 1 6 13L1 13A1 1 0 0 1 0 12L0 10A1 1 0 0 1 1 9Z';
export const MICRO_CARD = { x: 0, y: 4, width: 6, height: 3, r: 1 };

const rect = ({ x, y, width, height, r }, fill) =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${r}"${fill ? ` fill="${fill}"` : ''}/>`;

const svg = (width, height, body, viewBox = `0 0 ${width} ${height}`) =>
  `<svg width="${width}" height="${height}" viewBox="${viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg">\n${body}\n</svg>\n`;

/** The full mark in colour, at its own frame (docs, the DMG header). */
export function markSvg({ ink = COLOUR.ink, card = COLOUR.card } = {}) {
  return svg(FRAME.width, FRAME.height, `<path d="${SHELF}" fill="${ink}"/>\n${rect(CARD, card)}`);
}

/** The two halves as masks, sharing one frame so they overlay exactly. */
export const markBaseSvg = () => svg(FRAME.width, FRAME.height, `<path d="${SHELF}" fill="#000"/>`);
export const markCardSvg = () => svg(FRAME.width, FRAME.height, rect(CARD, '#000'));
export const microBaseSvg = () => svg(16, 16, `<path d="${MICRO_SHELF}" fill="#000"/>`);
export const microCardSvg = () => svg(16, 16, rect(MICRO_CARD, '#000'));

/** The four menu-bar template states on an 18 pt canvas (the 16 glyph, +1, +1). */
export function menubarSvg(state) {
  const extra = {
    capturing: rect(MICRO_CARD),
    paused: `<rect x="0.5" y="3" width="2" height="4.5" rx="1"/><rect x="3.5" y="3" width="2" height="4.5" rx="1"/>`,
    off: '',
    fault: `<rect x="2" y="2" width="2" height="3.4" rx="1"/><circle cx="3" cy="7" r="1"/>`,
  }[state];
  if (extra === undefined) throw new Error(`unknown menu-bar state ${state}`);
  return svg(18, 18, `<g transform="translate(1 1)" fill="#000">\n<path d="${MICRO_SHELF}"/>${extra}\n</g>`);
}

/**
 * A continuous-curvature rounded rectangle — Figma's corner smoothing, the
 * same construction as the macOS icon plate (smoothing 0.6). Four identical
 * corners of radius `r`, at (x, y).
 */
export function squirclePath(x, y, size, r, smoothing = 0.6) {
  const budget = size / 2;
  let s = smoothing;
  let p = (1 + s) * r;
  if (p > budget) {
    s = Math.min(s, budget / r - 1);
    p = Math.min(p, budget);
  }
  const rad = (deg) => (deg * Math.PI) / 180;
  const arcMeasure = 90 * (1 - s);
  const arc = Math.sin(rad(arcMeasure / 2)) * r * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p3p4 = r * Math.tan(rad(alpha / 2));
  const beta = 45 * s;
  const c = p3p4 * Math.cos(rad(beta));
  const d = c * Math.tan(rad(beta));
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  const n = (v) => Number(v.toFixed(3));
  const [A, AB, ABC, BC, C, D, L, R] = [a, a + b, a + b + c, b + c, c, d, arc, r].map(n);
  return [
    `M${n(x + size - p)} ${n(y)}`,
    `c${A} 0 ${AB} 0 ${ABC} ${D}a${R} ${R} 0 0 1 ${L} ${L}c${D} ${C} ${D} ${BC} ${D} ${ABC}`,
    `L${n(x + size)} ${n(y + size - p)}`,
    `c0 ${A} 0 ${AB} ${-D} ${ABC}a${R} ${R} 0 0 1 ${-L} ${L}c${-C} ${D} ${-BC} ${D} ${-ABC} ${D}`,
    `L${n(x + p)} ${n(y + size)}`,
    `c${-A} 0 ${-AB} 0 ${-ABC} ${-D}a${R} ${R} 0 0 1 ${-L} ${-L}c${-D} ${-C} ${-D} ${-BC} ${-D} ${-ABC}`,
    `L${n(x)} ${n(y + p)}`,
    `c0 ${-A} 0 ${-AB} ${D} ${-ABC}a${R} ${R} 0 0 1 ${L} ${-L}c${C} ${-D} ${BC} ${-D} ${ABC} ${-D}`,
    'Z',
  ].join('');
}

/** The 1024 app icon: the 824 plate at 100 (r 185.4, smoothing 0.6) and the mark. */
export function appIconSvg({ plate = COLOUR.plate, ink = COLOUR.ink, card = COLOUR.card } = {}) {
  return svg(
    1024,
    1024,
    [
      `<path d="${squirclePath(100, 100, 824, 185.4)}" fill="${plate}"/>`,
      `<g transform="translate(${ORIGIN.x} ${ORIGIN.y})">`,
      `<path d="${SHELF}" fill="${ink}"/>`,
      rect(CARD, card),
      '</g>',
    ].join('\n')
  );
}

/** One Icon Composer layer: a white mask on the 1024 canvas. */
export function iconLayerSvg(layer) {
  const shape = layer === 'shelf' ? `<path d="${SHELF}" fill="white"/>` : rect(CARD, 'white');
  return svg(1024, 1024, `<g transform="translate(${ORIGIN.x} ${ORIGIN.y})">${shape}</g>`);
}

/**
 * The app icon drawn for 32 and 16 px on whole pixels: a smaller plate and a
 * glyph whose gap stays at least a pixel. Scaling the 1024 icon down melts it.
 */
export function microAppIconSvg(size) {
  const spec = {
    32: {
      plate: [2, 28, 6.3],
      at: [6, 10],
      shelf: 'M1 8L8 8A8 8 0 0 0 16 0L20 0A12 12 0 0 1 8 12L1 12A1 1 0 0 1 0 11L0 9A1 1 0 0 1 1 8Z',
      card: { x: 0, y: 3, width: 8, height: 3, r: 1 },
    },
    16: {
      plate: [1, 14, 3.15],
      at: [3, 5],
      shelf: 'M0 4L4 4A4 4 0 0 0 8 0L10 0A6 6 0 0 1 4 6L0 6Z',
      card: { x: 0, y: 0, width: 4, height: 2, r: 0.5 },
    },
  }[size];
  if (!spec) throw new Error(`no pixel-grid icon at ${size}`);
  const [offset, plateSize, radius] = spec.plate;
  return svg(
    size,
    size,
    [
      `<path d="${squirclePath(offset, offset, plateSize, radius)}" fill="${COLOUR.plate}"/>`,
      `<g transform="translate(${spec.at[0]} ${spec.at[1]})">`,
      `<path d="${spec.shelf}" fill="${COLOUR.ink}"/>`,
      rect(spec.card, COLOUR.card),
      '</g>',
    ].join('\n')
  );
}
