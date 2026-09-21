'use strict';

/**
 * YouTube popup rules.
 *
 * YouTube spells a video two ways — /watch?v=<id> and /shorts/<id> — and the
 * same video appears as several anchors per card (thumbnail, title, channel
 * row), so the id is what keeps one button per video.
 */

const initEmbed = require('./preload-embed-core.js');

function idOf(href) {
  let m;
  if ((m = href.match(/[?&]v=([\w-]{11})/))) return m[1];
  if ((m = href.match(/\/shorts\/([\w-]{11})/))) return m[1];
  return null;
}

function watchUrl(id) { return 'https://www.youtube.com/watch?v=' + id; }

function onPlayer() {
  return /^\/watch/.test(location.pathname) || /^\/shorts\//.test(location.pathname);
}

initEmbed({
  folder() {
    try { return new URLSearchParams(location.search).get('search_query') || ''; } catch { return ''; }
  },

  // Search, home, a channel's videos — all listings. The player page is not:
  // its sidebar of recommendations would collect buttons beside the video.
  listing: () => !onPlayer(),

  cards() {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]')) {
      const id = idOf(a.getAttribute('href') || '');
      if (!id) continue;
      // Thumbnail anchors only — the title and channel links point at the same
      // video and would each try to claim a button.
      if (!a.querySelector('img')) continue;
      out.push({ el: a, id, url: watchUrl(id), kind: 'video' });
    }
    return out;
  },

  current() {
    const id = idOf(location.href);
    return (id && onPlayer()) ? { url: watchUrl(id), id, kind: 'video' } : null;
  },
});
