/**
 * Preload injected into the embedded Instagram window. Mirrors
 * preload-tiktok-embed.js: it runs inside Instagram's page (DOM access) in an
 * isolated world with ipcRenderer, so it can:
 *   1. Show the same MediaGrab toolbar with the destination folder name.
 *   2. Drop a "⬇ تحميل" button on every reel / video post card.
 *   3. Send the clicked URL back to the main process, which forwards it to the
 *      MediaGrab window's normal download queue.
 *
 * The window itself is opened with a MOBILE user-agent (set in main.js) so
 * Instagram serves its phone layout — that's the only layout whose keyword
 * search surfaces Reels. From Instagram's view this is a real logged-in user
 * scrolling the search tab on a phone.
 */
const { ipcRenderer } = require('electron');

(function () {
  const BTN_CLASS = 'mg-dl-btn';
  const BTN_LABEL = '⬇ تحميل';

  // Default folder = the search query (so a search's reels group together).
  let defaultFolder = '';
  try { defaultFolder = new URLSearchParams(location.search).get('q') || ''; } catch {}

  // IDs already downloaded (server-side) → badge them. Re-clicking still works.
  let downloadedSet = new Set();

  function applyState(btn) {
    if (btn.dataset.done === '1') {
      btn.textContent = '✓ اتحمّل';
      btn.style.background = '#16a34a';
      btn.title = 'اتحمّل قبل كده — دوس لو عايز تحمّله تاني';
    } else {
      btn.textContent = BTN_LABEL;
      btn.style.background = '#7c3aed';
      btn.title = '';
    }
  }

  function currentFolder() {
    return (document.getElementById('mg-folder') && document.getElementById('mg-folder').value || defaultFolder || '').trim();
  }

  // Queue every visible reel/post as ONE batch (so Stop can cancel them together).
  function downloadAllVisible() {
    const folder = currentFolder();
    const items = [];
    for (const btn of document.querySelectorAll('.' + BTN_CLASS + '[data-vid]')) {
      const url = btn.getAttribute('data-url');
      if (!url) continue;
      items.push({ url, kind: btn.getAttribute('data-kind') || 'video' });
      btn.dataset.done = '1';
      applyState(btn);
    }
    if (items.length) ipcRenderer.send('instagram-embed:download', { items, folder });
    return items.length;
  }

  function updateSelCount() {
    const n = document.querySelectorAll('.mg-sel:checked').length;
    const el = document.getElementById('mg-sel-btn');
    if (el) el.textContent = '⬇ حمّل المحدد (' + n + ')';
  }

  function downloadSelected() {
    const checked = Array.prototype.slice.call(document.querySelectorAll('.mg-sel:checked'));
    if (!checked.length) { alert('محدّدتش أي حاجة. علّم على الريلز الأول (✓ في الركن).'); return 0; }
    if (!confirm('هتحمّل ' + checked.length + ' عنصر محدد. متأكد؟')) return 0;
    const folder = currentFolder();
    const items = [];
    for (const cb of checked) {
      const url = cb.getAttribute('data-url');
      if (!url) continue;
      items.push({ url, kind: cb.getAttribute('data-kind') || 'video' });
      const btn = document.querySelector('.' + BTN_CLASS + '[data-vid="' + cb.getAttribute('data-vid') + '"]');
      if (btn) { btn.dataset.done = '1'; applyState(btn); }
      cb.checked = false;
    }
    if (items.length) ipcRenderer.send('instagram-embed:download', { items, folder });
    updateSelCount();
    return items.length;
  }

  async function resetMarks() {
    try { await ipcRenderer.invoke('instagram-embed:clearDownloaded'); } catch {}
    downloadedSet = new Set();
    for (const btn of document.querySelectorAll('.' + BTN_CLASS + '[data-vid]')) {
      btn.dataset.done = '';
      applyState(btn);
    }
  }

  async function refreshDownloadedMarks() {
    try {
      const ids = await ipcRenderer.invoke('instagram-embed:downloadedIds');
      if (Array.isArray(ids)) downloadedSet = new Set(ids.map(String));
    } catch {}
    for (const btn of document.querySelectorAll('.' + BTN_CLASS + '[data-vid]')) {
      if (downloadedSet.has(btn.getAttribute('data-vid')) && btn.dataset.done !== '1') {
        btn.dataset.done = '1';
        applyState(btn);
      }
    }
  }

  let baseDir = '';
  function renderBasePath() {
    const span = document.getElementById('mg-path-base');
    if (span) span.textContent = (baseDir || '') + '\\';
  }
  function btnStyle(bg) {
    return 'background:' + bg + ';color:#fff;border:none;border-radius:8px;padding:7px 13px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;';
  }

  // Make room for our fixed toolbar — same logic as the TikTok embed: pad the
  // body for normal-flow content AND bump Instagram's own top-anchored
  // fixed/sticky bars down to exactly our toolbar height so nothing hides
  // under it.
  function pushPageDown() {
    try {
      const bar = document.getElementById('mg-toolbar');
      if (!bar || !document.body) return;
      const h = bar.offsetHeight + 14; // a little breathing room under the bar
      // Body padding pushes the (in-flow) grid below our toolbar. We do NOT
      // offset Instagram's own fixed/sticky bars: on mobile its page header
      // (back-arrow + title) is sticky, and pushing it down made it overlap
      // the grid while scrolling. Left alone it just tucks under our toolbar —
      // harmless, since our own "رجوع للنتايج" button covers going back.
      document.body.style.paddingTop = h + 'px';
    } catch {}
  }

  function injectToolbar() {
    if (document.getElementById('mg-toolbar')) return;
    if (!document.body) return;

    const bar = document.createElement('div');
    bar.id = 'mg-toolbar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#15131f;color:#fff;display:flex;flex-direction:column;gap:9px;padding:11px 16px;font-family:sans-serif;font-size:13px;box-shadow:0 2px 16px rgba(0,0,0,.7);direction:rtl;border-bottom:1px solid #2a2740;';

    // ── Row 1: destination path + open ──
    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;';
    row1.innerHTML = '<strong style="color:#a855f7;font-size:15px;">MediaGrab</strong><span style="opacity:.85;">📁 ينزّل في:</span>';

    const pathWrap = document.createElement('div');
    pathWrap.style.cssText = 'flex:1;min-width:280px;display:flex;align-items:center;background:#1c1a2b;border:1px solid #3a3754;border-radius:8px;padding:2px 6px;direction:ltr;';
    const pathSpan = document.createElement('span');
    pathSpan.id = 'mg-path-base';
    pathSpan.style.cssText = 'color:#8b93b8;font-size:12px;padding:4px 4px;white-space:nowrap;max-width:55%;overflow:hidden;text-overflow:ellipsis;';
    const input = document.createElement('input');
    input.id = 'mg-folder';
    input.value = defaultFolder;
    input.placeholder = 'اسم المجلد';
    input.style.cssText = 'flex:1;min-width:120px;padding:5px 8px;border:none;background:transparent;color:#fff;direction:ltr;font-size:13px;font-weight:600;outline:none;';
    pathWrap.appendChild(pathSpan);
    pathWrap.appendChild(input);
    row1.appendChild(pathWrap);

    const openBtn = document.createElement('button');
    openBtn.textContent = '📂 فتح';
    openBtn.title = 'يفتح مجلد التحميل';
    openBtn.style.cssText = btnStyle('#2563eb');
    openBtn.addEventListener('click', () => { ipcRenderer.invoke('instagram-embed:openFolder', currentFolder()); });
    row1.appendChild(openBtn);
    bar.appendChild(row1);

    // ── Row 2: actions ──
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';

    const dlAll = document.createElement('button');
    dlAll.textContent = '⬇ حمّل كل الظاهر';
    dlAll.title = 'ينزّل كل الريلز الظاهرة دلوقتي';
    dlAll.style.cssText = btnStyle('#7c3aed');
    dlAll.addEventListener('click', () => {
      const count = document.querySelectorAll('.' + BTN_CLASS + '[data-vid]').length;
      if (!count) return;
      if (!confirm('هتحمّل كل الـ ' + count + ' عنصر الظاهرين. متأكد؟')) return;
      const n = downloadAllVisible();
      dlAll.textContent = '✓ ضفنا ' + n;
      setTimeout(() => { dlAll.textContent = '⬇ حمّل كل الظاهر'; }, 2500);
    });
    row2.appendChild(dlAll);

    // «تحديد» toggle — turns multi-select mode on/off. Off by default, so the
    // grid shows clean thumbnails with no checkboxes until the user asks.
    const selToggle = document.createElement('button');
    selToggle.id = 'mg-sel-toggle';
    selToggle.textContent = '☑ تحديد';
    selToggle.title = 'يفعّل وضع التحديد عشان تعلّم على كذا فيديو وتحمّلهم مرة واحدة';
    selToggle.style.cssText = btnStyle('#0ea5e9');
    row2.appendChild(selToggle);

    const selBtn = document.createElement('button');
    selBtn.id = 'mg-sel-btn';
    selBtn.textContent = '⬇ حمّل المحدد (0)';
    selBtn.title = 'يحمّل الريلز اللي علّمت عليها (✓ في الركن)';
    selBtn.style.cssText = btnStyle('#9333ea') + 'display:none;';
    selBtn.addEventListener('click', () => {
      const n = downloadSelected();
      if (n > 0) { selBtn.textContent = '✓ ضفنا ' + n; setTimeout(updateSelCount, 2500); }
    });
    row2.appendChild(selBtn);

    selToggle.addEventListener('click', () => {
      const on = document.documentElement.classList.toggle('mg-selecting');
      selToggle.textContent = on ? '✓ خلّصت تحديد' : '☑ تحديد';
      selToggle.style.background = on ? '#0369a1' : '#0ea5e9';
      selBtn.style.display = on ? '' : 'none';
      if (!on) { // leaving select mode → clear ticks
        for (const cb of document.querySelectorAll('.mg-sel:checked')) cb.checked = false;
        updateSelCount();
      }
    });

    const reset = document.createElement('button');
    reset.textContent = '↺ صفّر العلامات';
    reset.title = 'يشيل كل العلامات الخضرا ويرجّع الأزرار «تحميل»';
    reset.style.cssText = btnStyle('#374151');
    reset.addEventListener('click', () => resetMarks());
    row2.appendChild(reset);

    const stopBtn = document.createElement('button');
    stopBtn.textContent = '⏹ إيقاف';
    stopBtn.title = 'يوقف كل التحميلات الجارية';
    stopBtn.style.cssText = btnStyle('#b91c1c');
    stopBtn.addEventListener('click', async () => {
      try {
        const r = await ipcRenderer.invoke('instagram-embed:stopAll');
        stopBtn.textContent = '⏹ وقفنا ' + ((r && r.cancelled) || 0);
        setTimeout(() => { stopBtn.textContent = '⏹ إيقاف'; }, 2500);
      } catch {}
    });
    row2.appendChild(stopBtn);

    // Shown only while a single reel/post is open — downloads that exact item.
    const curBtn = document.createElement('button');
    curBtn.id = 'mg-current-btn';
    curBtn.textContent = '⬇ حمّل المفتوح';
    curBtn.title = 'يحمّل الريل اللي إنت فاتحه دلوقتي';
    curBtn.style.cssText = btnStyle('#16a34a') + 'display:none;';
    curBtn.addEventListener('click', () => {
      const m = location.pathname.match(/\/(reel|p|tv)\/([^/?]+)/);
      if (!m) return;
      const url = 'https://www.instagram.com/' + m[1] + '/' + m[2] + '/';
      // /reel/ and /tv/ are always video; for /p/ check if a <video> is on the
      // open post — otherwise treat it as a photo so the server pulls the image.
      const kind = (m[1] === 'p' && !document.querySelector('video')) ? 'photo' : 'video';
      ipcRenderer.send('instagram-embed:download', { items: [{ url, kind }], folder: currentFolder() });
      curBtn.textContent = '✓ في الطابور';
      setTimeout(() => { curBtn.textContent = '⬇ حمّل المفتوح'; }, 2500);
    });
    row2.appendChild(curBtn);

    // Prev/Next — walk through the reels in the SAME order they were in the
    // grid (saved to sessionStorage), independent of Instagram's own viewer.
    const prevBtn = document.createElement('button');
    prevBtn.id = 'mg-prev-btn';
    prevBtn.textContent = '⏮ السابق';
    prevBtn.style.cssText = btnStyle('#4b5563') + 'display:none;';
    prevBtn.addEventListener('click', () => navReel(-1));
    row2.appendChild(prevBtn);

    const nextBtn = document.createElement('button');
    nextBtn.id = 'mg-next-btn';
    nextBtn.textContent = 'التالي ⏭';
    nextBtn.style.cssText = btnStyle('#4b5563') + 'display:none;';
    nextBtn.addEventListener('click', () => navReel(1));
    row2.appendChild(nextBtn);

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    row2.appendChild(spacer);

    const back = document.createElement('button');
    back.textContent = '✕ رجوع للنتايج';
    back.title = 'يرجّعك لقائمة نتايج البحث';
    back.style.cssText = btnStyle('#dc2626');
    back.addEventListener('click', () => { try { history.back(); } catch {} });
    row2.appendChild(back);
    bar.appendChild(row2);

    (document.body || document.documentElement).appendChild(bar);

    pushPageDown();
    setTimeout(pushPageDown, 400);

    ipcRenderer.invoke('instagram-embed:baseDir').then((b) => { baseDir = b || ''; renderBasePath(); }).catch(() => {});
  }

  // A single reel/post/tv is open in the full-screen viewer (no grid buttons).
  function onSingleItem() {
    return /^\/(reel|p|tv)\/[^/]+/.test(location.pathname);
  }
  // Grid pages = anywhere with a thumbnail grid: search, explore, AND profiles
  // (e.g. /username/ or /username/reels/). We show buttons on all of them and
  // only bail inside the single-item viewer.
  function onListingPage() {
    return !onSingleItem();
  }

  // The grid "cell" of a tile = the ancestor whose PARENT holds several tiles.
  function cellOf(a) {
    let el = a;
    while (el.parentElement && el.parentElement !== document.body) {
      const p = el.parentElement;
      if (p.querySelectorAll('a[href*="/reel/"], a[href*="/tv/"], a[href*="/p/"]').length > 1) return el;
      el = p;
    }
    return a;
  }

  // Is this grid tile a VIDEO (reel/IGTV/video-post) vs a photo? /reel/ and
  // /tv/ are always video. For /p/ we look in the whole cell for the play/clip
  // icon Instagram overlays on video thumbnails (or a <video>). Photos have no
  // such indicator. We scope to the cell because the icon often sits as a
  // sibling of the <a>, not inside it.
  function isVideoTile(a, cell) {
    if (/\/(reel|tv)\//.test(a.getAttribute('href') || '')) return true;
    const scope = cell || a;
    if (scope.querySelector('video')) return true;
    for (const el of scope.querySelectorAll('[aria-label]')) {
      const l = (el.getAttribute('aria-label') || '').toLowerCase();
      if (/clip|reel|\bvideo\b|\bplay\b|مقطع|ريل|فيديو/.test(l)) return true;
    }
    return false;
  }

  function addButtons() {
    // Show grid buttons everywhere except the single-item viewer.
    if (onSingleItem()) return;
    for (const a of document.querySelectorAll('a[href*="/reel/"], a[href*="/tv/"], a[href*="/p/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/(reel|tv|p)\/([^/?]+)/);
      if (!m) continue;
      const kind = m[1], id = m[2];
      // Skip the opened-item popup (comments/related links live there).
      if (a.closest('[role="dialog"]')) continue;
      // Grid thumbnails only — real cards wrap an <img>.
      if (!a.querySelector('img')) continue;
      // We DON'T hide photos (Instagram's grid leaves holes when tiles are
      // hidden). Every tile gets a type badge; only VIDEOS get a download
      // button + select checkbox — photos can't be downloaded, so we don't put
      // a button on them at all (it would only fail).
      const cell = cellOf(a);
      const isVid = isVideoTile(a, cell);
      // Exactly ONE decoration per item (badge is on every tile, so key on it).
      if (document.querySelector('.mg-type[data-vid="' + id + '"]')) continue;
      const url = 'https://www.instagram.com/' + kind + '/' + id + '/';
      const itemKind = isVid ? 'video' : 'photo';
      if (getComputedStyle(a).position === 'static') a.style.position = 'relative';

      // Both videos AND photos get a download button + select checkbox. Photos
      // download as images (yt-dlp pulls the post's image / all carousel slides);
      // data-kind tells the server which pipeline to use.
      {
        const btn = document.createElement('button');
        btn.className = BTN_CLASS;
        btn.setAttribute('data-vid', id);
        btn.setAttribute('data-url', url);
        btn.setAttribute('data-kind', itemKind);
        btn.style.cssText = 'position:absolute;top:8px;left:8px;z-index:50;background:' + (isVid ? '#7c3aed' : '#0891b2') + ';color:#fff;border:none;border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.5);';
        if (downloadedSet.has(id)) btn.dataset.done = '1';
        applyState(btn);
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const folder = currentFolder();
          ipcRenderer.send('instagram-embed:download', { items: [{ url, kind: itemKind }], folder });
          btn.dataset.done = '1';
          btn.textContent = '✓ في الطابور';
          btn.style.background = '#16a34a';
          setTimeout(() => applyState(btn), 2500);
        }, true);
        a.appendChild(btn);

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'mg-sel';
        cb.setAttribute('data-vid', id);
        cb.setAttribute('data-url', url);
        cb.setAttribute('data-kind', itemKind);
        cb.style.cssText = 'position:absolute;top:8px;right:8px;z-index:50;width:22px;height:22px;cursor:pointer;accent-color:#9333ea;';
        cb.addEventListener('click', (e) => e.stopPropagation(), true);
        cb.addEventListener('change', updateSelCount);
        a.appendChild(cb);
      }

      // Type badge — sits just under the «تحميل» button on every tile.
      const badge = document.createElement('div');
      badge.className = 'mg-type';
      badge.setAttribute('data-vid', id);
      badge.textContent = isVid ? '🎬 فيديو' : '📷 صورة';
      badge.style.cssText = 'position:absolute;top:42px;left:8px;z-index:50;padding:3px 8px;border-radius:7px;font-size:11px;font-weight:700;color:#fff;direction:rtl;box-shadow:0 1px 4px rgba(0,0,0,.6);background:' + (isVid ? '#16a34a' : '#6b7280') + ';';
      a.appendChild(badge);
    }
  }

  function injectStyle() {
    if (document.getElementById('mg-style')) return;
    const s = document.createElement('style');
    s.id = 'mg-style';
    // Selection checkboxes are HIDDEN by default — they only appear once the
    // user turns on «تحديد» (multi-select) mode. The per-tile «تحميل» button
    // stays visible for one-click single downloads.
    s.textContent =
      '.mg-sel{display:none!important;}' +
      'html.mg-selecting .mg-sel{display:inline-block!important;}' +
      '.mg-hide-btns .mg-dl-btn,.mg-hide-btns .mg-sel,.mg-hide-btns .mg-type{display:none!important;}' +
      // When a single reel is open, center its column in the window.
      'html.mg-single [role="main"]{display:flex!important;flex-direction:column!important;align-items:center!important;}';
    (document.head || document.documentElement).appendChild(s);
  }

  // NON-DESTRUCTIVE curation only. We learned the hard way that restyling
  // Instagram's grid container or hiding its tiles makes its React app re-render
  // and spin forever ("appeared then vanished, loads endlessly"). So we DON'T
  // touch the grid/tiles — download buttons land on Reels only (addButtons),
  // and here we just hide the fixed "Use the app" smart-banner, which is a
  // standalone overlay that's safe to remove.
  function curateGrid() {
    const banner = document.querySelector('[class*="smart"][class*="banner"], a[href*="app_store"], a[href*="play.google"]');
    if (banner) {
      const fixedAncestor = banner.closest('div,section');
      const target = fixedAncestor && /fixed|sticky/.test(getComputedStyle(fixedAncestor).position) ? fixedAncestor : null;
      if (target && target.dataset.mgHidden !== '1') {
        target.style.setProperty('display', 'none', 'important');
        target.dataset.mgHidden = '1';
      }
    }
    // Hide Instagram's fixed BOTTOM nav bar (home/search/reels/…) — the grid's
    // bottom row of «تحميل» buttons was colliding with it, and tapping it just
    // goes to blank app-shell pages. The nav isn't a <nav> with bottom:0 we can
    // match directly, so we find the home link (a[href="/"]) and walk up to its
    // fixed, viewport-bottom-anchored ancestor — that's the bar. Safe to hide
    // (standalone overlay, not the scrolling grid).
    for (const home of document.querySelectorAll('a[href="/"], a[href="/explore/"], a[href^="/reels"]')) {
      let el = home;
      while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed') {
          const r = el.getBoundingClientRect();
          const atBottom = Math.abs(window.innerHeight - r.bottom) < 8;
          if (atBottom && r.height > 0 && r.height < 110 && r.width > window.innerWidth * 0.5) {
            if (el.dataset.mgHidden !== '1') {
              el.style.setProperty('display', 'none', 'important');
              el.dataset.mgHidden = '1';
            }
          }
          break;
        }
        el = el.parentElement;
      }
    }
  }

  // Remember where the user was scrolled in the grid, so opening a reel and
  // hitting «رجوع للنتايج» returns them to the same spot instead of the top.
  let mgScrollY = 0;
  let mgPrevListing = false;
  function saveScroll() {
    if (!onListingPage()) return;
    const y = window.scrollY || (document.scrollingElement && document.scrollingElement.scrollTop) || 0;
    if (y > 0) mgScrollY = y;
  }
  window.addEventListener('scroll', saveScroll, true);
  // While we're auto-restoring the scroll position, ANY real user input (wheel,
  // touch, arrow/space/pageup keys) means "I'm taking over" — so we cancel the
  // remaining restore steps instead of yanking the user back up to the old spot.
  // We listen for genuine input events only; a programmatic scrollTo() doesn't
  // fire wheel/touch/key, so our own restore never cancels itself.
  let mgRestoreTimers = [];
  let mgUserGrabbed = false;
  function cancelRestore() {
    mgUserGrabbed = true;
    for (const t of mgRestoreTimers) clearTimeout(t);
    mgRestoreTimers = [];
  }
  for (const ev of ['wheel', 'touchstart', 'touchmove', 'keydown']) {
    window.addEventListener(ev, (e) => {
      if (ev === 'keydown') {
        const k = e.key || '';
        if (!/Arrow|Page|Home|End| /.test(k) && k !== 'Spacebar') return;
      }
      if (mgRestoreTimers.length) cancelRestore();
    }, { passive: true, capture: true });
  }
  function restoreScrollSoon() {
    const y = mgScrollY;
    if (y <= 0) return;
    mgUserGrabbed = false;
    for (const t of mgRestoreTimers) clearTimeout(t);
    mgRestoreTimers = [80, 250, 550, 1000, 1600].map((t) => setTimeout(() => {
      if (mgUserGrabbed || !onListingPage()) return;
      try {
        window.scrollTo(0, y);
        if (document.scrollingElement) document.scrollingElement.scrollTop = y;
      } catch {}
    }, t));
  }

  // Instagram sometimes serves a blank first paint to the automated window
  // (zero tiles, empty body) even when the query has plenty of Reels. If a
  // SEARCH page is still empty after a few seconds, reload it ONCE (guarded by
  // sessionStorage so we never loop on a genuinely empty query).
  const mgStart = Date.now();
  function checkBlankReload() {
    if (!/^\/explore\/search/.test(location.pathname)) return;
    if (Date.now() - mgStart < 7000) return;
    const tiles = document.querySelectorAll('a[href*="/reel/"], a[href*="/tv/"], a[href*="/p/"]');
    if (tiles.length > 0) return;
    const key = 'mg_reload_' + location.search;
    const n = parseInt(sessionStorage.getItem(key) || '0', 10);
    if (n >= 1) return;
    try { sessionStorage.setItem(key, String(n + 1)); } catch {}
    location.reload();
  }

  // Save the order of reels currently in the grid so the viewer's prev/next can
  // walk them even after a full page navigation into a single reel.
  function collectReelOrder() {
    if (onSingleItem()) return;
    const btns = document.querySelectorAll('.' + BTN_CLASS + '[data-url]');
    if (!btns.length) return;
    const urls = [];
    for (const b of btns) { const u = b.getAttribute('data-url'); if (u) urls.push(u); }
    try { sessionStorage.setItem('mg_reel_order', JSON.stringify(urls)); } catch {}
  }

  function navReel(dir) {
    let order = [];
    try { order = JSON.parse(sessionStorage.getItem('mg_reel_order') || '[]'); } catch {}
    if (!order.length) return;
    const m = location.pathname.match(/\/(reel|p|tv)\/([^/?]+)/);
    if (!m) return;
    const curId = m[2];
    let idx = order.findIndex((u) => u.indexOf('/' + curId + '/') !== -1);
    if (idx < 0) idx = 0;
    const t = idx + dir;
    if (t < 0 || t >= order.length) return;
    location.assign(order[t]);
  }

  // Loading / empty-state overlay. Instagram's search grid takes a few seconds
  // to render (the JS hydrates the tiles after first paint), and for a long /
  // specific query it's slower still. With no feedback the window just looks
  // blank, so the user closes it thinking the search failed ("no results for a
  // long name"). This overlay shows a spinner until the first tiles appear, and
  // if the query genuinely returns nothing after a while it says so clearly.
  const mgSearchStart = Date.now();
  function gridTileCount() {
    let n = 0;
    for (const a of document.querySelectorAll('a[href*="/reel/"], a[href*="/tv/"], a[href*="/p/"]')) {
      if (a.querySelector('img') && !a.closest('[role="dialog"]')) n++;
    }
    return n;
  }
  function ensureOverlay() {
    if (document.getElementById('mg-loading')) return document.getElementById('mg-loading');
    if (!document.body) return null;
    const ov = document.createElement('div');
    ov.id = 'mg-loading';
    ov.style.cssText = 'position:fixed;left:0;right:0;bottom:0;top:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:rgba(8,7,14,.92);color:#fff;font-family:sans-serif;direction:rtl;text-align:center;padding:24px;';
    ov.innerHTML =
      '<div id="mg-load-spin" style="width:46px;height:46px;border:5px solid #3a3754;border-top-color:#a855f7;border-radius:50%;animation:mgspin 0.9s linear infinite;"></div>' +
      '<div id="mg-load-msg" style="font-size:16px;font-weight:700;max-width:420px;line-height:1.7;">⏳ بنجيب نتايج البحث من إنستجرام…<br><span style="font-size:13px;font-weight:400;opacity:.8;">الاسم الطويل بياخد ثواني أكتر — استنى شوية</span></div>' +
      '<button id="mg-load-x" style="background:#374151;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;">تجاهل</button>';
    if (!document.getElementById('mg-spin-style')) {
      const st = document.createElement('style');
      st.id = 'mg-spin-style';
      st.textContent = '@keyframes mgspin{to{transform:rotate(360deg)}}';
      (document.head || document.documentElement).appendChild(st);
    }
    (document.body || document.documentElement).appendChild(ov);
    ov.querySelector('#mg-load-x').addEventListener('click', () => { ov.dataset.dismissed = '1'; ov.style.display = 'none'; });
    return ov;
  }
  function manageLoadingOverlay() {
    // Only on the keyword-search page; the single-reel viewer & profiles manage
    // themselves.
    if (!/^\/explore\/search/.test(location.pathname)) {
      const ex = document.getElementById('mg-loading');
      if (ex) ex.style.display = 'none';
      return;
    }
    const tiles = gridTileCount();
    const ov = document.getElementById('mg-loading');
    if (tiles > 0) { if (ov) ov.style.display = 'none'; return; }
    // No tiles yet.
    const elapsed = Date.now() - mgSearchStart;
    const o = ov || ensureOverlay();
    if (!o || o.dataset.dismissed === '1') return;
    o.style.display = 'flex';
    // After ~13s with still nothing, call it a genuine empty result.
    if (elapsed > 13000) {
      const spin = document.getElementById('mg-load-spin');
      const msg = document.getElementById('mg-load-msg');
      if (spin) spin.style.display = 'none';
      if (msg) msg.innerHTML = '🔍 إنستجرام مرجّعش أي نتايج للبحث ده.<br><span style="font-size:13px;font-weight:400;opacity:.85;">جرّب كلمة أقصر أو أعم (مثلاً كلمة-كلمتين بدل الجملة كاملة).</span>';
    }
  }

  function tick() {
    try {
      injectStyle();
      injectToolbar();
      pushPageDown();
      checkBlankReload();
      collectReelOrder();
      const single = onSingleItem();
      document.documentElement.classList.toggle('mg-single', single);
      const pv = document.getElementById('mg-prev-btn');
      const nx = document.getElementById('mg-next-btn');
      if (pv) pv.style.display = single ? '' : 'none';
      if (nx) nx.style.display = single ? '' : 'none';
      // Hide grid buttons when a single item is open so they don't bleed over
      // Instagram's full-screen reel viewer.
      const listingNow = onListingPage();
      document.documentElement.classList.toggle('mg-hide-btns', !listingNow);
      const curBtn = document.getElementById('mg-current-btn');
      if (curBtn) curBtn.style.display = onSingleItem() ? '' : 'none';
      addButtons();
      curateGrid();
      manageLoadingOverlay();
      // Returned to the grid from a single reel → restore scroll position.
      if (listingNow && !mgPrevListing) restoreScrollSoon();
      mgPrevListing = listingNow;
    } catch {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick);
  } else {
    tick();
  }
  // Instagram loads items lazily on scroll, so keep sweeping for new cards.
  setInterval(tick, 1500);
  refreshDownloadedMarks();
  setInterval(refreshDownloadedMarks, 3000);
})();
