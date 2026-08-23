/**
 * Preload injected into the embedded Facebook AD LIBRARY window
 * (facebook.com/ads/library). This is the "spy tool" surface: a clean MediaGrab
 * toolbar + per-ad-card actions (download the creative, copy the ad text, copy
 * the landing-page link, open all ads from the same advertiser).
 *
 * Unlike preload-facebook-embed.js (which keys off video URL shapes in the
 * normal video search), the Ad Library has its own card layout. Facebook's DOM
 * classes are obfuscated, so we anchor on the STABLE "Library ID" label that
 * every ad card carries, then walk up to the card container and pull the
 * creative (<video>/<img>), the ad copy, and the landing link out of it.
 *
 * The window runs with a DESKTOP user-agent (set in main.js) so we get the grid
 * layout, not the mobile single-column one.
 *
 * Downloads are forwarded to the main window's normal queue via the dedicated
 * 'fb-adlib:download' channel; bookkeeping (downloaded marks, folder, stop)
 * reuses the existing 'facebook-embed:*' handlers since the platform is still FB.
 */
const { ipcRenderer } = require('electron');

(function () {
  const CARD_FLAG = 'mgAdCard';        // dataset flag marking a processed card
  const LIB_RE = /(?:Library ID|معرّف المكتبة|معرف المكتبة)\s*:?\s*(\d{5,})/i;

  let defaultFolder = '';
  let baseDir = '';
  let downloadedSet = new Set();

  /* ── small helpers ─────────────────────────────────────────────────────── */

  function currentFolder() {
    const el = document.getElementById('mg-folder');
    return ((el && el.value) || defaultFolder || '').trim();
  }

  function btnStyle(bg) {
    return 'background:' + bg + ';color:#fff;border:none;border-radius:8px;padding:7px 13px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;';
  }

  function chip(bg) {
    return 'display:inline-flex;align-items:center;gap:4px;background:' + bg + ';color:#fff;border:none;border-radius:7px;padding:5px 9px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.45);';
  }

  function copyText(text) {
    if (!text) return false;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }

  function toast(msg, bg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483647;background:' + (bg || '#16a34a') + ';color:#fff;padding:10px 18px;border-radius:10px;font-family:sans-serif;font-size:13px;font-weight:700;box-shadow:0 4px 18px rgba(0,0,0,.6);direction:rtl;';
    document.body.appendChild(t);
    setTimeout(() => { try { t.remove(); } catch {} }, 2200);
  }

  // Decode a Facebook l.php redirect (l.facebook.com/l.php?u=ENCODED) to the
  // real landing URL. Pass-through for already-direct links.
  function realLink(href) {
    if (!href) return '';
    try {
      if (/l\.facebook\.com\/l\.php/i.test(href)) {
        const u = new URL(href).searchParams.get('u');
        if (u) return decodeURIComponent(u);
      }
    } catch {}
    return href;
  }

  /* ── card discovery ────────────────────────────────────────────────────── */

  // Find the smallest sensible ancestor of `node` that looks like a full ad
  // card: it contains the Library-ID text AND a creative (img/video), and isn't
  // so wide that it's actually the whole grid row.
  function cardFromLabel(node) {
    let el = node;
    let best = null;
    for (let i = 0; i < 14 && el && el.parentElement; i++) {
      el = el.parentElement;
      const w = el.offsetWidth || 0;
      if (w > 720) break; // climbed past the column into the row/grid
      const hasMedia = el.querySelector('video, img');
      if (hasMedia && w >= 180 && w <= 700) {
        best = el;
        // The full card also carries the CTA / landing link below the creative —
        // prefer the ancestor that includes it so the landing button works.
        if (el.querySelector('a[href*="l.php"], a[href*="l.facebook.com"]')) return el;
      }
    }
    return best;
  }

  // Walk text nodes to find "Library ID: <n>" occurrences and resolve each to a
  // card element keyed by its library id.
  function findCards() {
    const out = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const m = (n.nodeValue || '').match(LIB_RE);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      const card = cardFromLabel(n.parentElement || n);
      if (!card) continue;
      seen.add(id);
      out.push({ id, card });
    }
    return out;
  }

  /* ── creative + text extraction from a card ────────────────────────────── */

  function pickVideoSrc(card) {
    const v = card.querySelector('video');
    if (!v) return '';
    const src = (v.querySelector('source') && v.querySelector('source').src) || v.src || v.currentSrc || '';
    return /^https?:/i.test(src) ? src : ''; // skip blob:/MSE — can't fetch those directly
  }

  function pickImageSrc(card) {
    let best = '', bestArea = 0;
    for (const img of card.querySelectorAll('img')) {
      const w = img.naturalWidth || img.clientWidth || 0;
      const h = img.naturalHeight || img.clientHeight || 0;
      const area = w * h;
      // Skip avatars / tiny icons / platform glyphs.
      if (w < 120 || h < 120) continue;
      const src = img.currentSrc || img.src || '';
      if (!/^https?:/i.test(src)) continue;
      if (area > bestArea) { bestArea = area; best = src; }
    }
    return best;
  }

  // Best-effort: the longest meaningful text block in the card = the ad copy.
  function pickAdText(card) {
    let best = '';
    const SKIP = /Library ID|معرّف المكتبة|Started running|بدأ عرض|Platforms|Sponsored|تمويل|See ad details|See summary|multiple versions|use this creative|Active|Inactive/i;
    for (const el of card.querySelectorAll('div, span')) {
      if (el.children.length > 2) continue;            // leaf-ish only
      const t = (el.innerText || '').trim();
      if (!t || t.length < 25) continue;
      if (SKIP.test(t)) continue;
      if (t.length > best.length) best = t;
    }
    return best;
  }

  // The advertiser's page name (used to re-search the library for that page).
  function pickAdvertiser(card) {
    for (const a of card.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (/l\.facebook\.com/i.test(href)) continue;
      if (!/facebook\.com|^\//.test(href)) continue;
      if (a.querySelector('img')) continue;            // avatar link
      const t = (a.innerText || '').trim();
      if (t && t.length >= 2 && t.length <= 60) return { name: t, href };
    }
    return null;
  }

  function pickLanding(card) {
    // 1) Facebook redirect link (l.php?u=…) → decode to the real URL.
    const redir = card.querySelector('a[href*="l.facebook.com/l.php"], a[href*="/l.php?"]');
    if (redir) { const r = realLink(redir.href); if (r) return r; }
    // 2) Any anchor that leaves Facebook (the CTA / displayed domain link).
    for (const x of card.querySelectorAll('a[href^="http"]')) {
      try {
        const h = new URL(x.href).hostname;
        if (!/facebook\.com|fbcdn\.net|instagram\.com/i.test(h)) return x.href;
      } catch {}
    }
    return '';
  }

  // The ad's own page in the Library (lets the user open the exact ad).
  function adPermalink(id) {
    return 'https://www.facebook.com/ads/library/?id=' + id;
  }

  function openExternal(url) {
    if (url) ipcRenderer.invoke('fb-adlib:openExternal', url).catch(() => {});
  }

  function readCard(card, id) {
    const video = pickVideoSrc(card);
    const image = video ? '' : pickImageSrc(card);
    return {
      id,
      kind: video ? 'video' : 'image',
      media: video || image || '',
      text: pickAdText(card),
      landing: pickLanding(card),
      advertiser: pickAdvertiser(card),
    };
  }

  /* ── downloading ───────────────────────────────────────────────────────── */

  function sendDownload(items) {
    const real = items.filter((it) => it && it.media);
    if (!real.length) { toast('مفيش إبداع قابل للتحميل هنا', '#b91c1c'); return 0; }
    ipcRenderer.send('fb-adlib:download', {
      folder: currentFolder(),
      items: real.map((it) => ({
        id: it.id,
        kind: it.kind,
        downloadUrl: it.media,
        // The advertiser name → server saves each creative in a folder by page.
        advertiser: (it.advertiser && it.advertiser.name) || '',
        title: 'fb_ad_' + it.id,
      })),
    });
    return real.length;
  }

  function markDone(id) {
    downloadedSet.add(String(id));
    const dl = document.querySelector('.mg-card-dl[data-adid="' + id + '"]');
    if (dl) { dl.textContent = '✓ اتحمّل'; dl.style.background = '#16a34a'; }
    const cb = document.querySelector('.mg-card-sel[data-adid="' + id + '"]');
    if (cb) cb.checked = false;
  }

  /* ── per-card overlay injection ────────────────────────────────────────── */

  function injectCardOverlay(id, card) {
    if (card.dataset[CARD_FLAG] === '1') return;
    card.dataset[CARD_FLAG] = '1';
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

    const bar = document.createElement('div');
    bar.className = 'mg-card-bar';
    bar.style.cssText = 'position:absolute;top:6px;left:6px;z-index:60;display:flex;gap:5px;align-items:center;flex-wrap:wrap;max-width:calc(100% - 12px);direction:rtl;';

    const data = () => readCard(card, id);

    const dl = document.createElement('button');
    dl.className = 'mg-card-dl';
    dl.setAttribute('data-adid', id);
    dl.style.cssText = chip(downloadedSet.has(String(id)) ? '#16a34a' : '#7c3aed');
    dl.textContent = downloadedSet.has(String(id)) ? '✓ اتحمّل' : '⬇ تحميل';
    dl.title = 'حمّل إبداع الإعلان (صورة/فيديو)';
    dl.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const n = sendDownload([data()]);
      if (n) { dl.textContent = '✓ في الطابور'; dl.style.background = '#16a34a'; markDone(id); }
    }, true);
    bar.appendChild(dl);

    const txt = document.createElement('button');
    txt.style.cssText = chip('#0ea5e9');
    txt.textContent = '📋 نص';
    txt.title = 'انسخ نص الإعلان';
    txt.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const d = data();
      if (copyText(d.text)) toast('اتنسخ نص الإعلان'); else toast('مفيش نص', '#b91c1c');
    }, true);
    bar.appendChild(txt);

    const adBtn = document.createElement('button');
    adBtn.style.cssText = chip('#db2777');
    adBtn.textContent = '🔎 إعلان';
    adBtn.title = 'افتح الإعلان نفسه في المتصفح (تشوف تفاصيله)';
    adBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      openExternal(adPermalink(id));
      toast('فتحنا الإعلان في المتصفح');
    }, true);
    bar.appendChild(adBtn);

    const link = document.createElement('button');
    link.style.cssText = chip('#0891b2');
    link.textContent = '🔗 لاند';
    link.title = 'انسخ رابط صفحة الهبوط (الموقع)';
    link.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const d = data();
      if (d.landing && copyText(d.landing)) toast('اتنسخ رابط اللاند: ' + d.landing.slice(0, 40) + '…');
      else toast('الإعلان ده مفيهوش رابط موقع', '#b91c1c');
    }, true);
    bar.appendChild(link);

    const openLand = document.createElement('button');
    openLand.style.cssText = chip('#0d9488');
    openLand.textContent = '🌐 افتح';
    openLand.title = 'افتح موقع الهبوط في المتصفح (كروم)';
    openLand.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const d = data();
      if (d.landing) { openExternal(d.landing); toast('فتحنا الموقع في المتصفح'); }
      else toast('الإعلان ده مفيهوش رابط موقع', '#b91c1c');
    }, true);
    bar.appendChild(openLand);

    const page = document.createElement('button');
    page.style.cssText = chip('#9333ea');
    page.textContent = '📑 الصفحة';
    page.title = 'كل إعلانات نفس الصفحة';
    page.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const adv = data().advertiser;
      if (!adv || !adv.name) { toast('معرفتش اسم الصفحة', '#b91c1c'); return; }
      openSamePageAds(adv.name);
    }, true);
    bar.appendChild(page);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'mg-card-sel';
    cb.setAttribute('data-adid', id);
    cb.style.cssText = 'position:absolute;top:8px;right:8px;z-index:60;width:22px;height:22px;cursor:pointer;accent-color:#9333ea;display:none;';
    cb.addEventListener('click', (e) => e.stopPropagation(), true);
    cb.addEventListener('change', updateSelCount);
    card.appendChild(cb);

    card.appendChild(bar);
  }

  // Re-search the Ad Library for a specific advertiser by name, keeping the
  // current country / language filters from the URL.
  function openSamePageAds(name) {
    try {
      const cur = new URL(location.href);
      cur.searchParams.set('q', name);
      cur.searchParams.set('search_type', 'keyword_unordered');
      location.href = cur.toString();
    } catch {}
  }

  /* ── toolbar ───────────────────────────────────────────────────────────── */

  function allCardData() {
    return findCards().map(({ id, card }) => readCard(card, id));
  }

  function updateSelCount() {
    const n = document.querySelectorAll('.mg-card-sel:checked').length;
    const el = document.getElementById('mg-sel-btn');
    if (el) el.textContent = '⬇ حمّل المحدد (' + n + ')';
  }

  function downloadAllVisible() {
    const data = allCardData();
    if (!data.length) { toast('مفيش إعلانات ظاهرة', '#b91c1c'); return; }
    if (!confirm('هتحمّل إبداعات ' + data.length + ' إعلان ظاهرين. متأكد؟')) return;
    const n = sendDownload(data);
    data.forEach((d) => markDone(d.id));
    if (n) toast('ضفنا ' + n + ' للطابور');
  }

  function downloadSelected() {
    const checked = Array.prototype.slice.call(document.querySelectorAll('.mg-card-sel:checked'));
    if (!checked.length) { toast('علّم على إعلانات الأول (✓)', '#b91c1c'); return; }
    const cards = findCards();
    const byId = {}; cards.forEach((c) => { byId[c.id] = c.card; });
    const items = [];
    checked.forEach((cb) => {
      const id = cb.getAttribute('data-adid');
      if (byId[id]) items.push(readCard(byId[id], id));
    });
    const n = sendDownload(items);
    items.forEach((d) => markDone(d.id));
    updateSelCount();
    if (n) toast('ضفنا ' + n + ' للطابور');
  }

  async function refreshDownloadedMarks() {
    try {
      const ids = await ipcRenderer.invoke('facebook-embed:downloadedIds');
      if (Array.isArray(ids)) downloadedSet = new Set(ids.map(String));
    } catch {}
    for (const dl of document.querySelectorAll('.mg-card-dl[data-adid]')) {
      if (downloadedSet.has(dl.getAttribute('data-adid'))) { dl.textContent = '✓ اتحمّل'; dl.style.background = '#16a34a'; }
    }
  }

  async function resetMarks() {
    try { await ipcRenderer.invoke('facebook-embed:clearDownloaded'); } catch {}
    downloadedSet = new Set();
    for (const dl of document.querySelectorAll('.mg-card-dl[data-adid]')) { dl.textContent = '⬇ تحميل'; dl.style.background = '#7c3aed'; }
  }

  // Force a stable font on our own toolbar + buttons so Facebook's page CSS
  // can't squeeze/stretch the text (the "crumpled font" the user saw).
  function injectStyle() {
    if (document.getElementById('mg-adlib-style')) return;
    const s = document.createElement('style');
    s.id = 'mg-adlib-style';
    s.textContent =
      '#mg-toolbar, #mg-toolbar *, .mg-card-bar, .mg-card-bar * {' +
        "font-family:'Segoe UI',Tahoma,Arial,sans-serif !important;" +
        'letter-spacing:normal !important;font-stretch:normal !important;' +
        'line-height:1.4 !important;box-sizing:border-box !important;' +
      '}' +
      '#mg-toolbar button{flex:0 0 auto !important;}';
    (document.head || document.documentElement).appendChild(s);
  }

  function injectToolbar() {
    if (document.getElementById('mg-toolbar')) return;
    if (!document.body) return;

    const bar = document.createElement('div');
    bar.id = 'mg-toolbar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#15131f;color:#fff;display:flex;align-items:center;gap:8px;padding:10px 16px;font-size:13px;box-shadow:0 2px 16px rgba(0,0,0,.7);direction:rtl;border-bottom:1px solid #2a2740;flex-wrap:wrap;';

    const brand = document.createElement('strong');
    brand.textContent = 'MediaGrab · مكتبة الإعلانات';
    brand.style.cssText = 'color:#a855f7;font-size:15px;white-space:nowrap;margin-left:6px;';
    bar.appendChild(brand);

    const dlAll = document.createElement('button');
    dlAll.textContent = '⬇ حمّل كل الظاهر';
    dlAll.style.cssText = btnStyle('#7c3aed');
    dlAll.addEventListener('click', downloadAllVisible);
    bar.appendChild(dlAll);

    const selToggle = document.createElement('button');
    selToggle.textContent = '☑ تحديد';
    selToggle.style.cssText = btnStyle('#0ea5e9');
    bar.appendChild(selToggle);

    const selBtn = document.createElement('button');
    selBtn.id = 'mg-sel-btn';
    selBtn.textContent = '⬇ حمّل المحدد (0)';
    selBtn.style.cssText = btnStyle('#9333ea') + 'display:none;';
    selBtn.addEventListener('click', downloadSelected);
    bar.appendChild(selBtn);

    selToggle.addEventListener('click', () => {
      const on = document.documentElement.classList.toggle('mg-selecting');
      selToggle.textContent = on ? '✓ خلّصت تحديد' : '☑ تحديد';
      selToggle.style.background = on ? '#0369a1' : '#0ea5e9';
      selBtn.style.display = on ? '' : 'none';
      for (const cb of document.querySelectorAll('.mg-card-sel')) cb.style.display = on ? 'block' : 'none';
      if (!on) { for (const cb of document.querySelectorAll('.mg-card-sel:checked')) cb.checked = false; updateSelCount(); }
    });

    const reset = document.createElement('button');
    reset.textContent = '↺ صفّر';
    reset.style.cssText = btnStyle('#374151');
    reset.addEventListener('click', resetMarks);
    bar.appendChild(reset);

    const stopBtn = document.createElement('button');
    stopBtn.textContent = '⏹ إيقاف';
    stopBtn.style.cssText = btnStyle('#b91c1c');
    stopBtn.addEventListener('click', async () => {
      try {
        const r = await ipcRenderer.invoke('facebook-embed:stopAll');
        stopBtn.textContent = '⏹ وقفنا ' + ((r && r.cancelled) || 0);
        setTimeout(() => { stopBtn.textContent = '⏹ إيقاف'; }, 2500);
      } catch {}
    });
    bar.appendChild(stopBtn);

    const openBtn = document.createElement('button');
    openBtn.textContent = '📂 فتح المجلد';
    openBtn.style.cssText = btnStyle('#2563eb');
    openBtn.addEventListener('click', () => { ipcRenderer.invoke('facebook-embed:openFolder', currentFolder()); });
    bar.appendChild(openBtn);

    // Real window close — see the note in the embed preloads: a full-screen
    // window on macOS has no visible traffic lights.
    const closeWin = document.createElement('button');
    closeWin.textContent = '✕ إغلاق النافذة';
    closeWin.title = 'يقفل النافذة ويرجّعك للبرنامج';
    closeWin.style.cssText = btnStyle('#7f1d1d');
    closeWin.addEventListener('click', () => {
      ipcRenderer.invoke('mg-embed:closeWindow').catch(() => {});
    });
    bar.appendChild(closeWin);

    const note = document.createElement('span');
    note.textContent = '📁 كل إعلان بيتحفظ في فولدر باسم صفحته';
    note.style.cssText = 'opacity:.65;font-size:12px;white-space:nowrap;margin-right:auto;';
    bar.appendChild(note);

    (document.body || document.documentElement).appendChild(bar);
    pushPageDown();
    setTimeout(pushPageDown, 400);
  }

  function pushPageDown() {
    try {
      const bar = document.getElementById('mg-toolbar');
      if (!bar || !document.body) return;
      const h = bar.offsetHeight + 12;
      document.body.style.paddingTop = h + 'px';
    } catch {}
  }

  /* ── tick loop ─────────────────────────────────────────────────────────── */

  // Clicking an ad's CTA / destination link (Order Now, Shop now, the displayed
  // domain…) opens it in the user's default browser (Chrome) instead of
  // navigating away inside the embedded window.
  let clickHooked = false;
  function installClickInterceptor() {
    if (clickHooked || !document.body) return;
    clickHooked = true;
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      let target = '';
      if (/l\.facebook\.com\/l\.php|\/l\.php\?/i.test(href)) {
        target = realLink(a.href);
      } else if (/^https?:/i.test(a.href)) {
        try { const h = new URL(a.href).hostname; if (!/facebook\.com|fbcdn\.net|instagram\.com/i.test(h)) target = a.href; } catch {}
      }
      if (target) { e.preventDefault(); e.stopPropagation(); openExternal(target); }
    }, true);
  }

  function tick() {
    try {
      injectStyle();
      installClickInterceptor();
      injectToolbar();
      pushPageDown();
      for (const { id, card } of findCards()) injectCardOverlay(id, card);
    } catch {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();
  setInterval(tick, 1500);
  refreshDownloadedMarks();
  setInterval(refreshDownloadedMarks, 4000);
})();
