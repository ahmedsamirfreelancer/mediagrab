'use strict';

/**
 * Pinterest popup rules. A pin may be an image or a video — the server
 * resolves which and downloads accordingly, so both ride the same button.
 */

const initEmbed = require('./preload-embed-core.js');

function pinUrl(id) { return 'https://www.pinterest.com/pin/' + id + '/'; }

initEmbed({
  folder() {
    try { return new URLSearchParams(location.search).get('q') || ''; } catch { return ''; }
  },

  // Only the search grid gets buttons. Opening a pin navigates to /pin/<id>/,
  // whose related pins would otherwise get buttons sprayed across them.
  listing() { return /^\/search/.test(location.pathname); },

  cards() {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/pin/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/pin\/(\d+)/);
      if (!m) continue;
      if (a.closest('[role="dialog"]')) continue;  // opened-pin overlay
      if (!a.querySelector('img')) continue;       // real cards wrap an <img>
      out.push({ el: a, id: m[1], url: pinUrl(m[1]), kind: 'pin' });
    }
    return out;
  },

  current() {
    const m = location.pathname.match(/^\/pin\/(\d+)/);
    return m ? { url: pinUrl(m[1]), id: m[1], kind: 'pin' } : null;
  },
});
