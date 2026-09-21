'use strict';

/**
 * Instagram popup rules.
 *
 * Instagram is the fussiest of the platforms: its React app re-renders (and
 * then spins forever) if we restyle its grid, it sometimes serves the
 * automated window a blank first paint, and it returns nothing at all for a
 * long, specific Arabic query. Everything here exists because of one of those.
 */

const initEmbed = require('./preload-embed-core.js');

const TILE_SEL = 'a[href*="/reel/"], a[href*="/tv/"], a[href*="/p/"]';
const SEARCH_PAGE = /^\/explore\/search/;

/* ─── What kind of tile is this ──────────────────────────────────────────── */

// The grid "cell" of a tile = the ancestor whose PARENT holds several tiles.
function cellOf(a) {
  let el = a;
  while (el.parentElement && el.parentElement !== document.body) {
    if (el.parentElement.querySelectorAll(TILE_SEL).length > 1) return el;
    el = el.parentElement;
  }
  return a;
}

// Video vs photo. /reel/ and /tv/ are always video; for /p/ we look across the
// whole cell for the play/clip icon Instagram overlays on video thumbnails —
// it often sits as a SIBLING of the <a>, not inside it.
function isVideoTile(a, cell) {
  if (/\/(reel|tv)\//.test(a.getAttribute('href') || '')) return true;
  const scope = cell || a;
  if (scope.querySelector('video')) return true;
  for (const el of scope.querySelectorAll('[aria-label]')) {
    if (/clip|reel|\bvideo\b|\bplay\b|مقطع|ريل|فيديو/.test((el.getAttribute('aria-label') || '').toLowerCase())) return true;
  }
  return false;
}

function single() { return /^\/(reel|p|tv)\/[^/]+/.test(location.pathname); }
function q() { try { return new URLSearchParams(location.search).get('q') || ''; } catch { return ''; } }
function node(tag, text, css) {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  if (css) n.style.cssText = css;
  return n;
}

// Headline + optional smaller second line, without touching innerHTML.
function setMessage(box, headline, note) {
  box.textContent = '';
  box.appendChild(document.createTextNode(headline));
  if (!note) return;
  box.appendChild(document.createElement('br'));
  box.appendChild(node('span', note, 'font-size:13px;font-weight:400;opacity:.85;'));
}

/* ─── Blank first paint ──────────────────────────────────────────────────── */

// Instagram sometimes paints nothing at all for the automated window even when
// the query has plenty of reels. Reload a still-empty search ONCE (guarded in
// sessionStorage so a genuinely empty query never loops).
const startedAt = Date.now();
function reloadIfBlank() {
  if (!SEARCH_PAGE.test(location.pathname)) return;
  if (Date.now() - startedAt < 7000) return;
  if (document.querySelectorAll(TILE_SEL).length) return;
  const key = 'mg_reload_' + location.search;
  if (parseInt(sessionStorage.getItem(key) || '0', 10) >= 1) return;
  try { sessionStorage.setItem(key, '1'); } catch {}
  location.reload();
}

/* ─── Keeping the user's place ───────────────────────────────────────────── */

let scrollY = 0, wasListing = false, restoreTimers = [], userGrabbed = false;

window.addEventListener('scroll', () => {
  if (single()) return;
  const y = window.scrollY || (document.scrollingElement && document.scrollingElement.scrollTop) || 0;
  if (y > 0) scrollY = y;
}, true);

// While we auto-restore, any genuine user input means "I'm taking over", so we
// drop the remaining steps instead of yanking them back up. A programmatic
// scrollTo fires none of these, so our own restore never cancels itself.
for (const ev of ['wheel', 'touchstart', 'touchmove', 'keydown']) {
  window.addEventListener(ev, (e) => {
    if (ev === 'keydown' && !/Arrow|Page|Home|End| /.test(e.key || '')) return;
    if (restoreTimers.length) {
      userGrabbed = true;
      for (const t of restoreTimers) clearTimeout(t);
      restoreTimers = [];
    }
  }, { passive: true, capture: true });
}

function restoreScrollSoon() {
  const y = scrollY;
  if (y <= 0) return;
  userGrabbed = false;
  for (const t of restoreTimers) clearTimeout(t);
  restoreTimers = [80, 250, 550, 1000, 1600].map((ms) => setTimeout(() => {
    if (userGrabbed || single()) return;
    try {
      window.scrollTo(0, y);
      if (document.scrollingElement) document.scrollingElement.scrollTop = y;
    } catch {}
  }, ms));
}

/* ─── Walking reels from inside the viewer ───────────────────────────────── */

function saveReelOrder() {
  if (single()) return;
  const urls = [];
  for (const b of document.querySelectorAll('.mg-dl-btn[data-url]')) {
    const u = b.getAttribute('data-url');
    if (u) urls.push(u);
  }
  if (urls.length) { try { sessionStorage.setItem('mg_reel_order', JSON.stringify(urls)); } catch {} }
}

function navReel(dir) {
  let order = [];
  try { order = JSON.parse(sessionStorage.getItem('mg_reel_order') || '[]'); } catch {}
  const m = location.pathname.match(/\/(reel|p|tv)\/([^/?]+)/);
  if (!order.length || !m) return;
  let i = order.findIndex((u) => u.indexOf('/' + m[2] + '/') !== -1);
  if (i < 0) i = 0;
  const t = i + dir;
  if (t >= 0 && t < order.length) location.assign(order[t]);
}

/* ─── Hiding Instagram's own chrome (never its grid) ─────────────────────── */

// NON-DESTRUCTIVE only: restyling the grid container or hiding tiles makes the
// React app re-render and spin forever. These two are standalone overlays.
function hideChrome() {
  const banner = document.querySelector('[class*="smart"][class*="banner"], a[href*="app_store"], a[href*="play.google"]');
  if (banner) {
    const box = banner.closest('div,section');
    if (box && /fixed|sticky/.test(getComputedStyle(box).position)) hideOnce(box);
  }
  // The bottom nav bar collided with the grid's bottom row of buttons, and
  // tapping it only led to blank app-shell pages. It isn't a <nav> we can
  // match, so walk up from the home link to its bottom-anchored fixed ancestor.
  for (const home of document.querySelectorAll('a[href="/"], a[href="/explore/"], a[href^="/reels"]')) {
    let el = home;
    while (el && el !== document.body) {
      if (getComputedStyle(el).position === 'fixed') {
        const r = el.getBoundingClientRect();
        if (Math.abs(window.innerHeight - r.bottom) < 8 && r.height > 0 && r.height < 110
            && r.width > window.innerWidth * 0.5) hideOnce(el);
        break;
      }
      el = el.parentElement;
    }
  }
}

function hideOnce(el) {
  if (el.dataset.mgHidden === '1') return;
  el.style.setProperty('display', 'none', 'important');
  el.dataset.mgHidden = '1';
}

/* ─── "Still loading" / "nothing came back" overlay ──────────────────────── */

// Instagram's grid hydrates seconds after first paint, and longer for a long
// query — with no feedback the window just looks blank and the user closes it
// thinking the search failed.
const searchStart = Date.now();

function tiles() {
  let n = 0;
  for (const a of document.querySelectorAll(TILE_SEL)) {
    if (a.querySelector('img') && !a.closest('[role="dialog"]')) n++;
  }
  return n;
}

// إنستجرام مابيرجّعش نتايج لجملة طويلة/محدّدة. بنقصّرها بالتدريج: ٣ كلمات →
// كلمتين → أول كلمة. الأصل متخزّن عشان كل محاولة تتقاس على البحث الأصلي مش على
// اللي قبلها، ومفيش لفّة لا نهائية.
const ORIG_KEY = 'mg_ig_orig_q', STEP_KEY = 'mg_ig_shrink_step';

function shorterQuery() {
  const cur = q().trim();
  if (!cur) return null;
  let orig = '', step = 0;
  try { orig = sessionStorage.getItem(ORIG_KEY) || ''; step = parseInt(sessionStorage.getItem(STEP_KEY) || '0', 10); } catch {}
  if (!orig || (orig !== cur && step === 0)) {
    orig = cur; step = 0;
    try { sessionStorage.setItem(ORIG_KEY, orig); sessionStorage.setItem(STEP_KEY, '0'); } catch {}
  }
  const words = orig.split(/\s+/).map((t) => t.replace(/[«»"'،,.؟?!]/g, '')).filter((t) => t.length >= 2);
  const tries = [];
  if (words.length > 3) tries.push(words.slice(0, 3).join(' '));
  if (words.length > 2) tries.push(words.slice(0, 2).join(' '));
  // آخر محاولة = أول كلمة مش أطول كلمة: في العربي أول كلمة غالبًا اسم المنتج
  // («سجادة صلاة قطن مصري» → «سجادة») وأطول كلمة بتطلع حشو.
  if (words.length > 1 && words[0].length >= 3) tries.push(words[0]);
  while (step < tries.length && tries[step].trim() === cur) step++;
  if (step >= tries.length) return null;
  try { sessionStorage.setItem(STEP_KEY, String(step + 1)); } catch {}
  return tries[step];
}

function overlay() {
  const found = document.getElementById('mg-loading');
  if (found || !document.body) return found;
  const ov = document.createElement('div');
  ov.id = 'mg-loading';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;'
    + 'align-items:center;justify-content:center;gap:16px;background:rgba(8,7,14,.92);color:#fff;'
    + 'font-family:sans-serif;direction:rtl;text-align:center;padding:24px;';
  // Built node by node, never innerHTML — Instagram enforces Trusted Types,
  // where an innerHTML assignment throws and the overlay never appears.
  const spin = node('div', '', 'width:46px;height:46px;border:5px solid #3a3754;border-top-color:#a855f7;'
    + 'border-radius:50%;animation:mgspin .9s linear infinite;');
  spin.id = 'mg-load-spin';
  const msg = node('div', '', 'font-size:16px;font-weight:700;max-width:420px;line-height:1.7;');
  msg.id = 'mg-load-msg';
  setMessage(msg, '⏳ بنجيب نتايج البحث من إنستجرام…', 'الاسم الطويل بياخد ثواني أكتر — استنى شوية');
  const dismiss = node('button', 'تجاهل', 'background:#374151;color:#fff;border:none;border-radius:8px;'
    + 'padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;');
  dismiss.id = 'mg-load-x';
  ov.appendChild(spin);
  ov.appendChild(msg);
  ov.appendChild(dismiss);
  if (!document.getElementById('mg-spin-style')) {
    const st = document.createElement('style');
    st.id = 'mg-spin-style';
    st.textContent = '@keyframes mgspin{to{transform:rotate(360deg)}}'
      + 'html.mg-single [role="main"]{display:flex!important;flex-direction:column!important;align-items:center!important;}';
    (document.head || document.documentElement).appendChild(st);
  }
  document.body.appendChild(ov);
  dismiss.addEventListener('click', () => {
    ov.dataset.dismissed = '1';
    ov.style.display = 'none';
  });
  return ov;
}

function manageOverlay() {
  const ov = document.getElementById('mg-loading');
  if (!SEARCH_PAGE.test(location.pathname)) { if (ov) ov.style.display = 'none'; return; }
  if (tiles() > 0) { if (ov) ov.style.display = 'none'; return; }
  const o = ov || overlay();
  if (!o || o.dataset.dismissed === '1') return;
  o.style.display = 'flex';
  if (Date.now() - searchStart <= 13000) return;

  // Still nothing: shorten the search ourselves and say what we're trying.
  const next = shorterQuery();
  const msg = document.getElementById('mg-load-msg');
  if (next) {
    if (msg) setMessage(msg, '🔍 مفيش نتايج للجملة كاملة — بنجرّب «' + next + '»…');
    location.replace('/explore/search/keyword/?q=' + encodeURIComponent(next));
    return;
  }
  const spin = document.getElementById('mg-load-spin');
  if (spin) spin.style.display = 'none';
  if (msg) {
    setMessage(msg, '🔍 إنستجرام مرجّعش أي نتايج للبحث ده — حتى بعد ما قصّرناه.',
      'جرّب كلمة تانية، أو ابحث باسم حساب بدل كلمة.');
  }
}

/* ─── Rules ──────────────────────────────────────────────────────────────── */

initEmbed({
  folder: q,

  // Buttons everywhere with a thumbnail grid (search, explore, profiles); the
  // only page we bail on is the full-screen single-item viewer.
  listing: () => !single(),

  cards() {
    const out = [];
    for (const a of document.querySelectorAll(TILE_SEL)) {
      const m = (a.getAttribute('href') || '').match(/\/(reel|tv|p)\/([^/?]+)/);
      if (!m) continue;
      if (a.closest('[role="dialog"]')) continue;
      if (!a.querySelector('img')) continue;
      // Photos get a button too — yt-dlp pulls the post's image (and every
      // carousel slide); `kind` tells the server which pipeline to use.
      const video = isVideoTile(a, cellOf(a));
      out.push({
        el: a,
        id: m[2],
        url: 'https://www.instagram.com/' + m[1] + '/' + m[2] + '/',
        kind: video ? 'video' : 'photo',
        color: video ? '#7c3aed' : '#0891b2',
      });
    }
    return out;
  },

  current() {
    const m = location.pathname.match(/^\/(reel|p|tv)\/([^/?]+)/);
    return m ? { url: 'https://www.instagram.com/' + m[1] + '/' + m[2] + '/', id: m[2], kind: 'video' } : null;
  },

  // A type badge under the button, so a photo is never mistaken for a video.
  decorate(card) {
    const badge = document.createElement('div');
    badge.className = 'mg-type';
    badge.setAttribute('data-vid', card.id);
    badge.textContent = card.kind === 'video' ? '🎬 فيديو' : '📷 صورة';
    badge.style.cssText = 'position:absolute;top:42px;left:8px;z-index:50;padding:3px 8px;border-radius:7px;'
      + 'font-size:11px;font-weight:700;color:#fff;direction:rtl;box-shadow:0 1px 4px rgba(0,0,0,.6);'
      + 'background:' + (card.kind === 'video' ? '#16a34a' : '#6b7280') + ';';
    card.el.appendChild(badge);
  },

  // Prev/next walk the grid's reels even after a full page navigation.
  buttons({ mkBtn }) {
    const prev = mkBtn('⬅ السابق', 'الريل اللي قبله', '#334155', () => navReel(-1));
    const next = mkBtn('التالي ➡', 'الريل اللي بعده', '#334155', () => navReel(1));
    prev.id = 'mg-prev-btn';
    next.id = 'mg-next-btn';
    prev.style.display = next.style.display = 'none';
    return [prev, next];
  },

  onTick() {
    reloadIfBlank();
    saveReelOrder();
    const one = single();
    document.documentElement.classList.toggle('mg-single', one);
    for (const id of ['mg-prev-btn', 'mg-next-btn']) {
      const el = document.getElementById(id);
      if (el) el.style.display = one ? '' : 'none';
    }
    hideChrome();
    manageOverlay();
    if (!one && wasListing === false) restoreScrollSoon(); // came back to the grid
    wasListing = !one;
  },

  rescue: true,
});
