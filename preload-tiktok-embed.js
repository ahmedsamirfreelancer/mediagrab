'use strict';

/**
 * TikTok popup rules. The toolbar, the buttons and the queueing all come from
 * preload-embed-core.js — this file only says where TikTok keeps its posts.
 */

const initEmbed = require('./preload-embed-core.js');

// A post link: /@user/video/123 or /@user/photo/123 (photo = slideshow post).
const POST = /\/@([^/]+)\/(video|photo)\/(\d+)/;

function postUrl(m) { return 'https://www.tiktok.com/@' + m[1] + '/' + m[2] + '/' + m[3]; }

initEmbed({
  // Default folder = the search query, so a search's videos group together.
  folder() {
    try { return new URLSearchParams(location.search).get('q') || ''; } catch { return ''; }
  },

  // A listing is a page whose thumbnails are a clean list of posts: search
  // results or a creator's profile. A single open post is NOT one — its
  // related/creator links would get buttons sprayed over the open video.
  listing() {
    const p = location.pathname;
    if (POST.test(p)) return false;
    return /^\/search/.test(p) || /^\/@[^/]+\/?$/.test(p);
  },

  cards() {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]')) {
      const m = (a.getAttribute('href') || '').match(POST);
      if (!m) continue;
      if (a.closest('[role="dialog"]')) continue;   // the opened-post overlay
      if (!a.querySelector('img')) continue;        // real cards wrap an <img>
      out.push({ el: a, id: m[3], url: postUrl(m), kind: m[2] === 'photo' ? 'photo' : 'video' });
    }
    return out;
  },

  current() {
    const m = location.pathname.match(POST);
    return m ? { url: postUrl(m), id: m[3], kind: m[2] === 'photo' ? 'photo' : 'video' } : null;
  },

  // 27/08: a logged-in session returned zero videos for an Arabic search that
  // returned 24 logged out — and TikTok paints an empty page saying nothing.
  rescue: true,
});
