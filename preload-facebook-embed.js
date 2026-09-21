'use strict';

/**
 * Facebook popup rules. Facebook spells a video link three different ways
 * (watch?v=, /reel/, /videos/) — all three are pulled back to one stable id
 * and one canonical URL so the same post never gets two buttons.
 */

const initEmbed = require('./preload-embed-core.js');

function fbVideo(a) {
  const href = a.getAttribute('href') || '';
  let m;
  if ((m = href.match(/[?&]v=(\d+)/))) return { id: m[1], url: 'https://www.facebook.com/watch/?v=' + m[1] };
  if ((m = href.match(/\/reel\/(\d+)/))) return { id: m[1], url: 'https://www.facebook.com/reel/' + m[1] };
  if ((m = href.match(/\/videos\/(?:[^/]*\/)?(\d+)/))) return { id: m[1], url: 'https://www.facebook.com' + href.split('?')[0] };
  return null;
}

initEmbed({
  folder() {
    try { return new URLSearchParams(location.search).get('query') || ''; } catch { return ''; }
  },

  // Facebook's feed and its video pages share one layout, so every page is
  // fair game — the card test below is what keeps buttons off plain links.
  listing() { return true; },

  cards() {
    const out = [];
    const sel = 'a[href*="/watch/"], a[href*="/reel/"], a[href*="/videos/"]';
    for (const a of document.querySelectorAll(sel)) {
      const v = fbVideo(a);
      if (!v) continue;
      if (a.closest('[role="dialog"]')) continue;
      if (!a.querySelector('img') && !a.querySelector('video')) continue;
      out.push({ el: a, id: v.id, url: v.url, kind: 'video' });
    }
    return out;
  },

  current() {
    const here = location.href;
    let m;
    if ((m = here.match(/[?&]v=(\d+)/))) return { id: m[1], url: 'https://www.facebook.com/watch/?v=' + m[1], kind: 'video' };
    if ((m = location.pathname.match(/\/reel\/(\d+)/))) return { id: m[1], url: 'https://www.facebook.com/reel/' + m[1], kind: 'video' };
    if ((m = location.pathname.match(/\/videos\/(?:[^/]*\/)?(\d+)/))) {
      return { id: m[1], url: 'https://www.facebook.com' + location.pathname, kind: 'video' };
    }
    return null;
  },

  rescue: true,
});
