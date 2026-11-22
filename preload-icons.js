/**
 * Icons for the buttons MediaGrab injects into other sites' pages.
 *
 * Trusted Types: youtube / facebook / instagram forbid `innerHTML`, so every
 * icon is built with createElementNS — never from a markup string.
 * One set, same as the main window: 24px grid, 2px stroke, round caps.
 */

const NS = 'http://www.w3.org/2000/svg';

// path data per icon (a leading "M…" string = one <path>; arrays = several).
const PATHS = {
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  'check-square': ['m9 11 3 3L22 4', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  'folder-open': ['M3 18V6a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V10', 'M3.5 18.5 6 11h15.2a1 1 0 0 1 .96 1.28l-1.8 5.6A2 2 0 0 1 18.5 19H5a1.5 1.5 0 0 1-1.5-.5z'],
  reset: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  stop: ['M6 6h12v12H6z'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  incognito: ['M3 12h18', 'M5 12l1.5-6.5A2 2 0 0 1 8.4 4h7.2a2 2 0 0 1 1.9 1.5L19 12', 'M8.5 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M15.5 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M11.5 17h1'],
  key: ['M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8z', 'm15.5 7.5 3 3L22 7l-3-3'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z'],
  clipboard: ['M8 2h8v4H8z', 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'm21 21-4.3-4.3'],
  link: ['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'],
  files: ['M15 2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V6z', 'M15 2v4h4', 'M4 8v12a2 2 0 0 0 2 2h9'],
  'arrow-left': ['M19 12H5', 'm11 18-6-6 6-6'],
  'arrow-right': ['M5 12h14', 'm13 6 6 6-6 6'],
  video: ['M23 7l-7 5 7 5z', 'M3 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'],
  camera: ['M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z', 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
};

// the glyph a label used to start with → icon name
const GLYPH = {
  '⬇': 'download', '✓': 'check', '☑': 'check-square', '📁': 'folder', '📂': 'folder-open',
  '↺': 'reset', '⏹': 'stop', '✕': 'x', '⚠️': 'alert', '🕵️': 'incognito', '🔑': 'key',
  '🌐': 'globe', '📋': 'clipboard', '🔎': 'search', '🔍': 'search', '🔗': 'link', '📑': 'files',
  '⬅': 'arrow-left', '➡': 'arrow-right', '🎬': 'video', '📷': 'camera', '⏳': 'clock',
};

function svgIcon(name, size) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size || 14));
  svg.setAttribute('height', String(size || 14));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'flex:none;vertical-align:-2px;margin-inline-end:6px;';
  for (const d of PATHS[name]) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

/** Sets a label: a leading glyph (⬇ ✓ 📁 …) becomes an SVG icon, the rest text. */
function setLabel(el, label) {
  const str = String(label == null ? '' : label);
  el.dataset.mgLabel = str;
  const m = str.match(/^(\S+)\s+([\s\S]*)$/);
  const name = m && GLYPH[m[1]];
  if (!name) { el.textContent = str; return el; }
  el.textContent = '';
  el.appendChild(svgIcon(name));
  el.appendChild(document.createTextNode(m[2]));
  return el;
}

/** The label last set with setLabel (textContent would lose the icon). */
function getLabel(el) {
  return el.dataset.mgLabel !== undefined ? el.dataset.mgLabel : el.textContent;
}

module.exports = { setLabel, getLabel, svgIcon };
