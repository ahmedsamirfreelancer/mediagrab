/**
 * Preload injected into the embedded TikTok window. It runs in TikTok's page
 * (DOM access) but in an isolated world with ipcRenderer, so it can:
 *   1. Show a small MediaGrab toolbar with the destination folder name.
 *   2. Drop a "⬇ تحميل" button on every video card.
 *   3. Send the clicked video's URL back to the main process, which forwards
 *      it to the MediaGrab window's normal download queue.
 *
 * This gives the user TikTok's EXACT search results (real page, infinite
 * scroll) with one-click downloading — no scraping, no missing videos.
 */
const { ipcRenderer } = require('electron');

(function () {
  const BTN_CLASS = 'mg-dl-btn';
  const BTN_LABEL = '⬇ تحميل';

  // Default folder = the search query (so a search's videos group together).
  let defaultFolder = '';
  try { defaultFolder = new URLSearchParams(location.search).get('q') || ''; } catch {}

  // IDs already downloaded (server-side) → badge them. Re-clicking still works.
  let downloadedSet = new Set();

  // Paint a button according to whether its video was already downloaded.
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

  // Queue every visible video as ONE batch (so Stop can cancel them together).
  function downloadAllVisible() {
    const folder = currentFolder();
    const urls = [];
    for (const btn of document.querySelectorAll('.' + BTN_CLASS + '[data-vid]')) {
      const url = btn.getAttribute('data-url');
      if (!url) continue;
      urls.push(url);
      btn.dataset.done = '1';
      applyState(btn);
    }
    if (urls.length) ipcRenderer.send('tiktok-embed:download', { urls, folder });
    return urls.length;
  }

  // Update the "download selected (N)" button label with the checked count.
  function updateSelCount() {
    const n = document.querySelectorAll('.mg-sel:checked').length;
    const el = document.getElementById('mg-sel-btn');
    if (el) el.textContent = '⬇ حمّل المحدد (' + n + ')';
  }

  // Download only the videos whose checkbox is ticked.
  function downloadSelected() {
    const checked = Array.prototype.slice.call(document.querySelectorAll('.mg-sel:checked'));
    if (!checked.length) { alert('محدّدتش أي فيديو. علّم على الفيديوهات الأول (✓ في الركن).'); return 0; }
    if (!confirm('هتحمّل ' + checked.length + ' فيديو محدد. متأكد؟')) return 0;
    const folder = currentFolder();
    const urls = [];
    for (const cb of checked) {
      const url = cb.getAttribute('data-url');
      if (!url) continue;
      urls.push(url);
      const btn = document.querySelector('.' + BTN_CLASS + '[data-vid="' + cb.getAttribute('data-vid') + '"]');
      if (btn) { btn.dataset.done = '1'; applyState(btn); }
      cb.checked = false;
    }
    if (urls.length) ipcRenderer.send('tiktok-embed:download', { urls, folder });
    updateSelCount();
    return urls.length;
  }

  // Clear all green "downloaded" marks and reset every button to "تحميل".
  async function resetMarks() {
    try { await ipcRenderer.invoke('tiktok-embed:clearDownloaded'); } catch {}
    downloadedSet = new Set();
    for (const btn of document.querySelectorAll('.' + BTN_CLASS + '[data-vid]')) {
      btn.dataset.done = '';
      applyState(btn);
    }
  }

  async function refreshDownloadedMarks() {
    try {
      const ids = await ipcRenderer.invoke('tiktok-embed:downloadedIds');
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

  // True when el's nearest scrollable ancestor is the window/document (body or
  // html) rather than an inner overflow:scroll container. A sticky element
  // sticks relative to its scroll container, so this tells us whose top:0 we
  // must compensate for our toolbar — and whose we must leave alone.
  function scrollAncestorIsWindow(el) {
    let n = el.parentElement;
    while (n && n !== document.body && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflow)) return false;
      n = n.parentElement;
    }
    return true;
  }

  // Make room for our fixed toolbar. body paddingTop pushes the whole document
  // (and any inner scroll container, e.g. TikTok's <main> search grid) down by
  // the toolbar height. But viewport-anchored bars — position:fixed, or sticky
  // elements that stick to the WINDOW — ignore that padding and hide under our
  // toolbar, so we bump their top to the toolbar height. Critically we must NOT
  // bump the search Top/Users/Videos/Photo tab bar: it's sticky INSIDE <main>
  // (an overflow:scroll container already offset by the body padding), so its
  // top:0 is already right. Adding the toolbar height there double-counts it and
  // pins the tabs a toolbar-height too low, with videos peeking above them.
  // Runs every tick (idempotent) so it survives TikTok re-renders.
  function pushPageDown() {
    try {
      const bar = document.getElementById('mg-toolbar');
      if (!bar || !document.body) return;
      const h = bar.offsetHeight + 6;
      document.body.style.paddingTop = h + 'px';
      for (const el of document.querySelectorAll('body *')) {
        if (el.id === 'mg-toolbar' || el.closest('#mg-toolbar')) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        // Sticky-in-an-inner-scroller is already offset by the body padding.
        if (cs.position === 'sticky' && !scrollAncestorIsWindow(el)) continue;
        const top = parseFloat(cs.top);
        if (!isFinite(top) || top > 80) continue; // only near-top anchored bars
        const want = h + 'px';
        if (el.style.top !== want) el.style.top = want;
      }
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
    openBtn.addEventListener('click', () => { ipcRenderer.invoke('tiktok-embed:openFolder', currentFolder()); });
    row1.appendChild(openBtn);
    bar.appendChild(row1);

    // ── Row 2: actions ──
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';

    const dlAll = document.createElement('button');
    dlAll.textContent = '⬇ حمّل كل الظاهر';
    dlAll.title = 'ينزّل كل الفيديوهات الظاهرة دلوقتي';
    dlAll.style.cssText = btnStyle('#7c3aed');
    dlAll.addEventListener('click', () => {
      const count = document.querySelectorAll('.' + BTN_CLASS + '[data-vid]').length;
      if (!count) return;
      if (!confirm('هتحمّل كل الـ ' + count + ' فيديو الظاهرين. متأكد؟')) return;
      const n = downloadAllVisible();
      dlAll.textContent = '✓ ضفنا ' + n;
      setTimeout(() => { dlAll.textContent = '⬇ حمّل كل الظاهر'; }, 2500);
    });
    row2.appendChild(dlAll);

    // «تحديد» toggle — multi-select mode is off by default (clean grid, no
    // checkboxes) until the user clicks it.
    const selToggle = document.createElement('button');
    selToggle.id = 'mg-sel-toggle';
    selToggle.textContent = '☑ تحديد';
    selToggle.title = 'يفعّل وضع التحديد عشان تعلّم على كذا فيديو وتحمّلهم مرة واحدة';
    selToggle.style.cssText = btnStyle('#0ea5e9');
    row2.appendChild(selToggle);

    const selBtn = document.createElement('button');
    selBtn.id = 'mg-sel-btn';
    selBtn.textContent = '⬇ حمّل المحدد (0)';
    selBtn.title = 'يحمّل الفيديوهات اللي علّمت عليها (✓ في الركن)';
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
      if (!on) {
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
        const r = await ipcRenderer.invoke('tiktok-embed:stopAll');
        stopBtn.textContent = '⏹ وقفنا ' + ((r && r.cancelled) || 0);
        setTimeout(() => { stopBtn.textContent = '⏹ إيقاف'; }, 2500);
      } catch {}
    });
    row2.appendChild(stopBtn);

    // Shown only while a single video is open — downloads that exact video.
    const curBtn = document.createElement('button');
    curBtn.id = 'mg-current-btn';
    curBtn.textContent = '⬇ حمّل الفيديو المفتوح';
    curBtn.title = 'يحمّل الفيديو اللي إنت فاتحه دلوقتي';
    curBtn.style.cssText = btnStyle('#16a34a') + 'display:none;';
    curBtn.addEventListener('click', () => {
      const m = location.pathname.match(/\/@([^/]+)\/video\/(\d+)/);
      if (!m) return;
      const url = 'https://www.tiktok.com/@' + m[1] + '/video/' + m[2];
      ipcRenderer.send('tiktok-embed:download', { url, folder: currentFolder() });
      curBtn.textContent = '✓ في الطابور';
      setTimeout(() => { curBtn.textContent = '⬇ حمّل الفيديو المفتوح'; }, 2500);
    });
    row2.appendChild(curBtn);

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

    // Push the page down by the toolbar's real height (two rows, may wrap).
    pushPageDown();
    setTimeout(pushPageDown, 400);

    // Fetch the base output dir, then render "base\" before the folder input.
    ipcRenderer.invoke('tiktok-embed:baseDir').then((b) => { baseDir = b || ''; renderBasePath(); }).catch(() => {});
  }

  function addButtons() {
    // Only the search-results page gets buttons. When a video is opened TikTok
    // navigates to /@user/video/id, whose related/creator links would otherwise
    // get buttons sprayed across the open video — so bail unless we're on /search.
    if (!/^\/search/.test(location.pathname)) return;
    for (const a of document.querySelectorAll('a[href*="/video/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/@([^/]+)\/video\/(\d+)/);
      if (!m) continue;
      const user = m[1], id = m[2];
      // Skip the opened-video popup (comments/related links live there).
      if (a.closest('[role="dialog"]')) continue;
      // Grid thumbnails only — real cards wrap an <img>; text/comment links don't.
      if (!a.querySelector('img')) continue;
      // Exactly ONE button per video — TikTok renders several links per card.
      if (document.querySelector('.' + BTN_CLASS + '[data-vid="' + id + '"]')) continue;
      const url = 'https://www.tiktok.com/@' + user + '/video/' + id;
      if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
      const btn = document.createElement('button');
      btn.className = BTN_CLASS;
      btn.setAttribute('data-vid', id);
      btn.setAttribute('data-url', url);
      // z-index 50 (not 99999) so TikTok's video modal paints OVER these when a
      // video is opened — otherwise the grid buttons bleed through the video.
      btn.style.cssText = 'position:absolute;top:8px;left:8px;z-index:50;background:#7c3aed;color:#fff;border:none;border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.5);';
      if (downloadedSet.has(id)) btn.dataset.done = '1';
      applyState(btn);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const folder = currentFolder();
        ipcRenderer.send('tiktok-embed:download', { url, folder });
        btn.dataset.done = '1'; // optimistic — re-clicking still re-downloads
        btn.textContent = '✓ في الطابور';
        btn.style.background = '#16a34a';
        setTimeout(() => applyState(btn), 2500);
      }, true);
      a.appendChild(btn);

      // Selection checkbox (top-right) for the "download selected" workflow.
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'mg-sel';
      cb.setAttribute('data-vid', id);
      cb.setAttribute('data-url', url);
      cb.style.cssText = 'position:absolute;top:8px;right:8px;z-index:50;width:22px;height:22px;cursor:pointer;accent-color:#9333ea;';
      cb.addEventListener('click', (e) => e.stopPropagation(), true);
      cb.addEventListener('change', updateSelCount);
      a.appendChild(cb);
    }
  }

  function injectStyle() {
    if (document.getElementById('mg-style')) return;
    const s = document.createElement('style');
    s.id = 'mg-style';
    // Selection checkboxes are HIDDEN until the user turns on «تحديد» mode;
    // the per-video «تحميل» button stays for one-click single downloads.
    s.textContent =
      '.mg-sel{display:none!important;}' +
      'html.mg-selecting .mg-sel{display:inline-block!important;}' +
      '.mg-hide-btns .mg-dl-btn{display:none!important;}' +
      '.mg-hide-btns .mg-sel{display:none!important;}';
    (document.head || document.documentElement).appendChild(s);
  }

  function tick() {
    try {
      injectStyle();
      injectToolbar();
      pushPageDown();
      // When a video is open the path leaves /search → hide all grid buttons so
      // they never bleed over TikTok's video modal.
      const onVideo = /\/@[^/]+\/video\/\d+/.test(location.pathname);
      document.documentElement.classList.toggle('mg-hide-btns', !/^\/search/.test(location.pathname));
      const curBtn = document.getElementById('mg-current-btn');
      if (curBtn) curBtn.style.display = onVideo ? '' : 'none';
      addButtons();
    } catch {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick);
  } else {
    tick();
  }
  // TikTok loads videos lazily on scroll, so keep sweeping for new cards.
  setInterval(tick, 1500);
  // Refresh the "already downloaded" badges periodically (and once up front).
  refreshDownloadedMarks();
  setInterval(refreshDownloadedMarks, 3000);
})();
