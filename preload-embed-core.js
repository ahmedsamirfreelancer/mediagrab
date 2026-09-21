'use strict';

/**
 * The download toolbar every popup wears.
 *
 * Runs inside the platform's own page (real DOM, real session, real infinite
 * scroll) and gives it: a destination folder, a ⬇ button on every post, a
 * multi-select mode, badges for what was already downloaded, and a stop.
 * Everything it queues goes out on ONE channel (`embed:download`) as one
 * shape: { items: [{ url, id, kind }], folder }.
 *
 * A platform preload supplies only what differs — which page is a listing,
 * where its posts are, and what the currently open post is:
 *
 *   require('./preload-embed-core.js')({
 *     folder:  () => 'default folder name',
 *     listing: () => true,                  // buttons belong on this page
 *     cards:   () => [{ el, id, url, kind }],
 *     current: () => ({ url, id, kind }),   // a single open post, or null
 *     rescue:  true,                        // offer the empty-page rescues
 *     onTick:  () => {},                    // per-platform layout fixes
 *   })
 */

const { ipcRenderer } = require('electron');

const BTN_CLASS = 'mg-dl-btn';
const BTN_LABEL = '⬇ تحميل';

module.exports = function initEmbed(rules) {
  const R = Object.assign({
    folder: () => '',
    listing: () => true,
    cards: () => [],
    current: () => null,
    rescue: false,
    onTick: () => {},
    decorate: () => {},
    buttons: () => [],
    scanMs: 1500,
  }, rules || {});

  let defaultFolder = '';
  try { defaultFolder = R.folder() || ''; } catch {}
  let downloaded = new Set();
  let baseDir = '';

  /* ── small helpers ────────────────────────────────────────────────── */

  const btnStyle = (bg) =>
    'background:' + bg + ';color:#fff;border:none;border-radius:8px;padding:7px 13px;' +
    'font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;';

  // Trusted-Types-safe element builder (see folderRow).
  function mkEl(tag, text, css) {
    const n = document.createElement(tag);
    if (text) n.textContent = text;
    if (css) n.style.cssText = css;
    return n;
  }

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  function currentFolder() {
    const el = $('#mg-folder');
    return ((el && el.value) || defaultFolder || '').trim();
  }

  function queue(items) {
    const list = (Array.isArray(items) ? items : [items]).filter((i) => i && i.url);
    if (!list.length) return 0;
    ipcRenderer.send('embed:download', { items: list, folder: currentFolder() });
    return list.length;
  }

  function flash(btn, text, restore) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = restore || old; }, 2500);
  }

  /* ── per-post button state ────────────────────────────────────────── */

  function paint(btn) {
    if (btn.dataset.done === '1') {
      btn.textContent = '✓ اتحمّل';
      btn.style.background = '#16a34a';
      btn.title = 'اتحمّل قبل كده — دوس لو عايز تحمّله تاني';
    } else {
      btn.textContent = BTN_LABEL;
      btn.style.background = btn.dataset.color || '#7c3aed';
      btn.title = '';
    }
  }

  function allButtons() { return $$('.' + BTN_CLASS + '[data-vid]'); }

  function itemOf(el) {
    return { url: el.getAttribute('data-url'), id: el.getAttribute('data-vid'), kind: el.getAttribute('data-kind') || 'video' };
  }

  function downloadAllVisible() {
    const items = [];
    for (const btn of allButtons()) {
      if (!btn.getAttribute('data-url')) continue;
      items.push(itemOf(btn));
      btn.dataset.done = '1';
      paint(btn);
    }
    return queue(items);
  }

  function selCount() { return $$('.mg-sel:checked').length; }

  function updateSelCount() {
    const el = $('#mg-sel-btn');
    if (el) el.textContent = '⬇ حمّل المحدد (' + selCount() + ')';
  }

  function downloadSelected() {
    const checked = $$('.mg-sel:checked');
    if (!checked.length) { alert('محدّدتش أي حاجة. علّم على اللي عايزه الأول (✓ في الركن).'); return 0; }
    if (!confirm('هتحمّل ' + checked.length + ' حاجة محددة. متأكد؟')) return 0;
    const items = [];
    for (const cb of checked) {
      items.push(itemOf(cb));
      const btn = $('.' + BTN_CLASS + '[data-vid="' + cb.getAttribute('data-vid') + '"]');
      if (btn) { btn.dataset.done = '1'; paint(btn); }
      cb.checked = false;
    }
    updateSelCount();
    return queue(items);
  }

  async function resetMarks() {
    try { await ipcRenderer.invoke('embed:clearDownloaded'); } catch {}
    downloaded = new Set();
    for (const btn of allButtons()) { btn.dataset.done = ''; paint(btn); }
  }

  async function refreshMarks() {
    try {
      const ids = await ipcRenderer.invoke('embed:downloadedIds');
      if (Array.isArray(ids)) downloaded = new Set(ids.map(String));
    } catch {}
    for (const btn of allButtons()) {
      if (downloaded.has(btn.getAttribute('data-vid')) && btn.dataset.done !== '1') {
        btn.dataset.done = '1';
        paint(btn);
      }
    }
  }

  /* ── injecting buttons on the page's posts ────────────────────────── */

  function attach(card) {
    if (!card || !card.el || !card.url || !card.id) return;
    const id = String(card.id);
    if ($('.' + BTN_CLASS + '[data-vid="' + CSS.escape(id) + '"]')) return;
    const el = card.el;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';

    const btn = document.createElement('button');
    btn.className = BTN_CLASS;
    btn.setAttribute('data-vid', id);
    btn.setAttribute('data-url', card.url);
    btn.setAttribute('data-kind', card.kind || 'video');
    btn.dataset.color = card.color || '#7c3aed';
    // z-index stays modest so the platform's own opened-post overlay paints
    // OVER the grid buttons instead of them bleeding through it.
    btn.style.cssText = 'position:absolute;top:8px;left:8px;z-index:50;background:' + (card.color || '#7c3aed')
      + ';color:#fff;border:none;border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;'
      + 'cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.5);';
    if (downloaded.has(id)) btn.dataset.done = '1';
    paint(btn);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      queue(itemOf(btn));
      btn.dataset.done = '1';
      btn.style.background = '#16a34a';
      flash(btn, '✓ في الطابور');
      setTimeout(() => paint(btn), 2500);
    }, true);
    el.appendChild(btn);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'mg-sel';
    cb.setAttribute('data-vid', id);
    cb.setAttribute('data-url', card.url);
    cb.setAttribute('data-kind', card.kind || 'video');
    cb.style.cssText = 'position:absolute;top:8px;right:8px;z-index:50;width:22px;height:22px;'
      + 'cursor:pointer;accent-color:#9333ea;';
    cb.addEventListener('click', (e) => e.stopPropagation(), true);
    cb.addEventListener('change', updateSelCount);
    el.appendChild(cb);

    try { R.decorate(card); } catch {}
  }

  function injectStyle() {
    if ($('#mg-style')) return;
    const s = document.createElement('style');
    s.id = 'mg-style';
    // Checkboxes stay hidden until «تحديد» is switched on, so the grid reads
    // clean; the per-post ⬇ button is always there for one-click downloads.
    s.textContent =
      '.mg-sel{display:none!important;}' +
      'html.mg-selecting .mg-sel{display:inline-block!important;}' +
      '.mg-hide-btns .mg-dl-btn,.mg-hide-btns .mg-sel{display:none!important;}';
    (document.head || document.documentElement).appendChild(s);
  }

  /* ── the toolbar ──────────────────────────────────────────────────── */

  // Our toolbar is position:fixed at the top, so the page has to move down by
  // its height — body padding does that for the document and for inner scroll
  // containers, but viewport-anchored bars (fixed, or sticky to the WINDOW)
  // ignore padding and would hide underneath, so those get their top bumped.
  // A sticky bar inside an inner scroller is already offset and must be left
  // alone, or it lands a toolbar-height too low. Idempotent: runs every tick.
  function pushPageDown() {
    try {
      const bar = $('#mg-toolbar');
      if (!bar || !document.body) return;
      const h = bar.offsetHeight + 6;
      document.body.style.paddingTop = h + 'px';
      for (const el of $$('body *')) {
        if (el.id === 'mg-toolbar' || el.closest('#mg-toolbar')) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        if (cs.position === 'sticky' && !scrollsWithWindow(el)) continue;
        const top = parseFloat(cs.top);
        if (!isFinite(top) || top > 80) continue; // near-top anchored bars only
        const want = h + 'px';
        if (el.style.top !== want) el.style.top = want;
      }
    } catch {}
  }

  function scrollsWithWindow(el) {
    let n = el.parentElement;
    while (n && n !== document.body && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflow)) return false;
      n = n.parentElement;
    }
    return true;
  }

  function mkBtn(label, title, bg, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.style.cssText = btnStyle(bg);
    b.addEventListener('click', onClick);
    return b;
  }

  function folderRow() {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;';
    // Built node by node, never innerHTML: YouTube (and Facebook) enforce
    // Trusted Types, where any innerHTML assignment throws and takes the
    // whole toolbar with it.
    row.appendChild(mkEl('strong', 'MediaGrab', 'color:#a855f7;font-size:15px;'));
    row.appendChild(mkEl('span', '📁 ينزّل في:', 'opacity:.85;'));

    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;min-width:280px;display:flex;align-items:center;background:#1c1a2b;'
      + 'border:1px solid #3a3754;border-radius:8px;padding:2px 6px;direction:ltr;';
    const base = document.createElement('span');
    base.id = 'mg-path-base';
    base.style.cssText = 'color:#8b93b8;font-size:12px;padding:4px;white-space:nowrap;max-width:55%;'
      + 'overflow:hidden;text-overflow:ellipsis;';
    const input = document.createElement('input');
    input.id = 'mg-folder';
    input.value = defaultFolder;
    input.placeholder = 'اسم المجلد';
    input.style.cssText = 'flex:1;min-width:120px;padding:5px 8px;border:none;background:transparent;'
      + 'color:#fff;direction:ltr;font-size:13px;font-weight:600;outline:none;';
    wrap.appendChild(base);
    wrap.appendChild(input);
    row.appendChild(wrap);
    row.appendChild(mkBtn('📂 فتح', 'يفتح مجلد التحميل', '#2563eb',
      () => ipcRenderer.invoke('embed:openFolder', currentFolder())));
    return row;
  }

  function actionRow() {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';

    const all = mkBtn('⬇ حمّل كل الظاهر', 'ينزّل كل اللي ظاهر قدامك دلوقتي', '#7c3aed', () => {
      const n = allButtons().length;
      if (!n) return;
      if (!confirm('هتحمّل كل الـ ' + n + ' اللي ظاهرين. متأكد؟')) return;
      flash(all, '✓ ضفنا ' + downloadAllVisible(), '⬇ حمّل كل الظاهر');
    });
    row.appendChild(all);

    const sel = mkBtn('⬇ حمّل المحدد (0)', 'يحمّل اللي علّمت عليه (✓ في الركن)', '#9333ea', () => {
      const n = downloadSelected();
      if (n > 0) { sel.textContent = '✓ ضفنا ' + n; setTimeout(updateSelCount, 2500); }
    });
    sel.id = 'mg-sel-btn';
    sel.style.display = 'none';

    const toggle = mkBtn('☑ تحديد', 'يفعّل وضع التحديد عشان تعلّم على كذا حاجة وتحمّلهم مرة واحدة', '#0ea5e9', () => {
      const on = document.documentElement.classList.toggle('mg-selecting');
      toggle.textContent = on ? '✓ خلّصت تحديد' : '☑ تحديد';
      toggle.style.background = on ? '#0369a1' : '#0ea5e9';
      sel.style.display = on ? '' : 'none';
      if (!on) { for (const cb of $$('.mg-sel:checked')) cb.checked = false; updateSelCount(); }
    });
    row.appendChild(toggle);
    row.appendChild(sel);

    row.appendChild(mkBtn('↺ صفّر العلامات', 'يشيل كل العلامات الخضرا ويرجّع الأزرار «تحميل»', '#374151', resetMarks));

    const stop = mkBtn('⏹ إيقاف', 'يوقف كل التحميلات الجارية', '#b91c1c', async () => {
      try {
        const r = await ipcRenderer.invoke('embed:stopAll');
        flash(stop, '⏹ وقفنا ' + ((r && r.cancelled) || 0), '⏹ إيقاف');
      } catch {}
    });
    row.appendChild(stop);

    // Shown only while one post is open — downloads that exact post.
    const cur = mkBtn('⬇ حمّل المفتوح', 'يحمّل اللي إنت فاتحه دلوقتي', '#16a34a', () => {
      let item = null;
      try { item = R.current(); } catch {}
      if (!item || !item.url) return;
      queue(item);
      flash(cur, '✓ في الطابور', '⬇ حمّل المفتوح');
    });
    cur.id = 'mg-current-btn';
    cur.style.display = 'none';
    row.appendChild(cur);

    for (const extra of (R.buttons({ mkBtn, queue, currentFolder, btnStyle }) || [])) row.appendChild(extra);

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    row.appendChild(spacer);

    row.appendChild(mkBtn('✕ رجوع', 'يرجّعك للصفحة اللي قبلها', '#dc2626',
      () => { try { history.back(); } catch {} }));
    // A real close: on macOS a full-screen window hides the traffic lights, so
    // without this there is no visible way out of the window.
    row.appendChild(mkBtn('✕ إغلاق النافذة', 'يقفل النافذة ويرجّعك للبرنامج', '#7f1d1d',
      () => ipcRenderer.invoke('embed:close').catch(() => {})));
    return row;
  }

  /* ── "the site came back empty" rescue row ────────────────────────── */

  const EMPTY_AFTER_MS = 9000;
  let emptySince = 0, sawCards = false, lastKey = '';

  function rescueRow() {
    const row = document.createElement('div');
    row.id = 'mg-empty';
    row.style.cssText = 'display:none;gap:8px;align-items:center;flex-wrap:wrap;background:#3b1d1d;'
      + 'border:1px solid #7f1d1d;border-radius:8px;padding:8px 12px;';
    const msg = mkEl('span', '⚠️ ', 'flex:1;min-width:240px;line-height:1.6;');
    msg.appendChild(mkEl('strong', 'الموقع رجّع صفر نتيجة للبحث ده.'));
    msg.appendChild(mkEl('span', ' ده مش عطل في البرنامج — غالبًا تسجيل الدخول. جرّب:', 'opacity:.85;'));
    row.appendChild(msg);
    row.appendChild(mkBtn('🕵️ جرّب من غير تسجيل دخول', 'يفتح نفس الصفحة في نافذة نضيفة من غير أي كوكيز', '#7c3aed',
      () => ipcRenderer.invoke('embed:guest', location.href).catch(() => {})));
    const relog = mkBtn('🔑 سجّل دخول من جديد', 'يمسح الجلسة الحالية وتسجّل دخول بإيدك، وبعدين يعيد الصفحة', '#2563eb', () => {
      relog.textContent = '… بيفتح صفحة الدخول';
      ipcRenderer.invoke('embed:relogin').catch(() => {})
        .then(() => { relog.textContent = '🔑 سجّل دخول من جديد'; });
    });
    row.appendChild(relog);
    row.appendChild(mkBtn('🌐 افتح في المتصفح', 'يفتح نفس الصفحة في متصفحك — لو فاضية هناك كمان يبقى الموقع نفسه', '#374151',
      () => ipcRenderer.invoke('embed:external', location.href).catch(() => {})));
    return row;
  }

  // Deliberately waits before accusing anyone: an empty grid a second after
  // navigating is just a grid still loading.
  function updateRescue(listing) {
    const row = $('#mg-empty');
    if (!row) return;
    const key = location.pathname + location.search;
    if (key !== lastKey) { lastKey = key; emptySince = Date.now(); sawCards = false; }
    if (!listing) { row.style.display = 'none'; return; }
    if (allButtons().length > 0) { sawCards = true; row.style.display = 'none'; return; }
    row.style.display = (!sawCards && Date.now() - emptySince > EMPTY_AFTER_MS) ? 'flex' : 'none';
  }

  function injectToolbar() {
    if ($('#mg-toolbar') || !document.body) return;
    const bar = document.createElement('div');
    bar.id = 'mg-toolbar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#15131f;'
      + 'color:#fff;display:flex;flex-direction:column;gap:9px;padding:11px 16px;font-family:sans-serif;'
      + 'font-size:13px;box-shadow:0 2px 16px rgba(0,0,0,.7);direction:rtl;border-bottom:1px solid #2a2740;';
    bar.appendChild(folderRow());
    bar.appendChild(actionRow());
    if (R.rescue) bar.appendChild(rescueRow());
    (document.body || document.documentElement).appendChild(bar);

    pushPageDown();
    setTimeout(pushPageDown, 400);
    ipcRenderer.invoke('embed:baseDir')
      .then((b) => {
        baseDir = b || '';
        const span = $('#mg-path-base');
        if (span) span.textContent = baseDir + '\\';
      })
      .catch(() => {});
  }

  /* ── the loop ─────────────────────────────────────────────────────── */

  function tick() {
    try {
      injectStyle();
      injectToolbar();
      pushPageDown();
      let listing = false;
      try { listing = !!R.listing(); } catch {}
      // Off a listing page every grid button is hidden, so none of them can
      // bleed over an opened post.
      document.documentElement.classList.toggle('mg-hide-btns', !listing);
      let open = null;
      try { open = R.current(); } catch {}
      const cur = $('#mg-current-btn');
      if (cur) cur.style.display = (open && open.url) ? '' : 'none';
      if (listing) { for (const card of (R.cards() || [])) attach(card); }
      if (R.rescue) updateRescue(listing);
      R.onTick();
    } catch (e) {
      // The sweep runs every 1.5s, so log the reason once instead of
      // swallowing the same failure forever — a silent catch here is how a
      // missing toolbar becomes "the buttons just disappeared".
      if (!tick.reported) { tick.reported = true; console.error('[MediaGrab] toolbar tick failed:', e && (e.stack || e.message)); }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();
  // Platforms load lazily on scroll, so keep sweeping for new posts.
  setInterval(tick, R.scanMs);
  refreshMarks();
  setInterval(refreshMarks, 3000);

  return { queue, currentFolder, btnStyle, mkBtn, ipcRenderer, tick };
};
