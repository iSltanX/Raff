// رفّ icon set: 16px geometry, 1.5 stroke, drawn as CSS masks so one file
// serves every appearance and state through `currentColor`.

const asset = (name) => new URL(`../assets/icons/${name}.svg`, import.meta.url).href;

export const SETTINGS = asset('settings');
export const SEARCH = asset('search');
export const CLEAR = asset('clear');
export const CLOSE = asset('close');
export const PIN = asset('pin');
export const PIN_TOGGLE = asset('pin-off');
export const TRASH = asset('trash');
export const CHECK = asset('check');
export const ALERT = asset('alert');
export const IMAGE = asset('image');
export const KEYBOARD = asset('keyboard');
export const SHIELD = asset('shield');

export const CONTENT_TYPE_ICONS = Object.freeze({
  text: Object.freeze({ asset: asset('text'), label: 'نص' }),
  link: Object.freeze({ asset: asset('link'), label: 'رابط' }),
  code: Object.freeze({ asset: asset('code'), label: 'شفرة برمجية' }),
  image: Object.freeze({ asset: asset('image'), label: 'صورة' }),
  unknown: Object.freeze({ asset: asset('unknown'), label: 'محتوى غير مصنف' }),
});

/** Content type → icon and spoken label. Source apps never pick the icon. */
export function contentTypeIcon(type = '') {
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPE_ICONS, type)
    ? CONTENT_TYPE_ICONS[type]
    : CONTENT_TYPE_ICONS.unknown;
}

export function createIcon(source, className = '') {
  const icon = document.createElement('span');
  icon.className = `icon ${className}`.trim();
  icon.setAttribute('aria-hidden', 'true');
  icon.style.setProperty('--icon', `url(${source})`);
  return icon;
}
