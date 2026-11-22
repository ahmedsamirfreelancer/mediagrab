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
const { setLabel, getLabel, svgIcon } = require('./preload-icons.js');

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
    if (text) setLabel(n, text);
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
    const old = getLabel(btn);
    setLabel(btn, text);
    setTimeout(() => { setLabel(btn, restore || old); }, 2500);
  }

  /* ── per-post button state ────────────────────────────────────────── */

  function paint(btn) {
    if (btn.dataset.done === '1') {
      setLabel(btn, '✓ اتحمّل');
      btn.style.background = '#16a34a';
      btn.title = 'اتحمّل قبل كده — دوس لو عايز تحمّله تاني';
    } else {
      setLabel(btn, BTN_LABEL);
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

  function updateSelCount() { refreshMain(); }

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
      '.mg-hide-btns .mg-dl-btn,.mg-hide-btns .mg-sel{display:none!important;}' + CSS;
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
        // An app shell pinned absolutely to the window (YouTube's <ytd-app>)
        // ignores body padding too: move it down and shrink it by the bar.
        if (cs.position === 'absolute' && el.parentElement === document.body
            && (el.dataset.mgShell || (parseFloat(cs.top) <= 4 && el.offsetHeight >= window.innerHeight * 0.8))) {
          el.dataset.mgShell = '1';
          el.style.top = h + 'px';
          el.style.height = 'calc(100% - ' + h + 'px)';
          continue;
        }
        // YouTube's side drawer manages its own top (it compensates for the
        // shifted app shell), so we pin it where its first row clears the
        // site's header instead of adding the bar on top of its own value.
        if (el.localName === 'tp-yt-app-drawer') {
          const dTop = (h + 44) + 'px';
          if (el.style.top !== dTop) el.style.top = dTop;
          continue;
        }
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        if (cs.position === 'sticky' && !scrollsWithWindow(el)) continue;
        // Shift by the bar's height from the element's ORIGINAL offset: a
        // side drawer pinned at top:56px must stay 56px under the site's own
        // header, not land on top of it.
        if (el.dataset.mgTop0 === undefined) {
          const top = parseFloat(cs.top);
          if (!isFinite(top) || top > 80) continue; // near-top anchored bars only
          el.dataset.mgTop0 = String(top);
        }
        const want = (parseFloat(el.dataset.mgTop0) + h) + 'px';
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
    setLabel(b, label);
    b.title = title;
    b.style.cssText = btnStyle(bg);
    b.addEventListener('click', onClick);
    return b;
  }

  /* ── the toolbar: one slim row ────────────────────────────────────── */

  // Colours live in variables on the bar: light by default, `.mg-dark` flips them
  // to follow the app's own theme (see syncTheme).
  const CSS = [
    '#mg-toolbar{--bg:rgba(255,255,255,.94);--fg:#2A2622;--sub:#5F584F;--hov:rgba(60,40,20,.08);--chip:rgba(60,40,20,.06);',
    '--line:rgba(60,40,20,.14);--pop:#FFFFFF;--inp:#FFFFFF;--inl:rgba(60,40,20,.22);--cnt:#C2410C;--shadow:rgba(60,40,20,.16);',
    '--grad:linear-gradient(135deg,#FF7A45,#E5532D);--glow:rgba(229,83,45,.32);--sel:rgba(229,83,45,.14);}',
    '#mg-toolbar.mg-dark{--bg:rgba(27,30,43,.92);--fg:#ECEEF5;--sub:#B0B5C9;--hov:rgba(255,255,255,.1);--chip:rgba(255,255,255,.07);',
    '--line:rgba(255,255,255,.12);--pop:#242838;--inp:#1F2231;--inl:rgba(255,255,255,.18);--cnt:#FFB59A;--shadow:rgba(0,0,0,.45);--sel:rgba(255,107,61,.2);}',
    '#mg-toolbar{position:fixed;top:0;left:0;right:0;max-height:38vh;z-index:2147483647;color:var(--fg);',
    'background:var(--bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);',
    'border-bottom:1px solid var(--line);box-shadow:0 2px 14px var(--shadow);direction:rtl;',
    "font-family:'Segoe UI',Tahoma,sans-serif;font-size:13px;line-height:1.2;}",
    '#mg-toolbar *{box-sizing:border-box;}',
    '#mg-row{height:48px;padding:0 12px;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:10px;position:relative;}',
    '#mg-toolbar .mg-grp{display:flex;align-items:center;gap:6px;min-width:0;}',
    '#mg-toolbar .mg-left{justify-self:end;}',
    '#mg-toolbar .mg-mark{width:26px;height:26px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;',
    'color:#fff;background:var(--grad);}',
    '#mg-toolbar button{font:inherit;cursor:pointer;border:none;outline:none;}',
    '#mg-toolbar button:focus-visible{box-shadow:0 0 0 2px var(--glow);}',
    '#mg-toolbar .mg-chip{display:flex;align-items:center;gap:6px;height:32px;max-width:100%;padding:0 10px;border-radius:9px;',
    'background:var(--chip);color:var(--fg);}',
    '#mg-toolbar .mg-chip b{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;direction:ltr;}',
    '#mg-toolbar .mg-chip span{opacity:.7;white-space:nowrap;}',
    '#mg-toolbar .mg-chip svg,#mg-toolbar .mg-ib svg,#mg-toolbar .mg-txt svg{margin:0!important;}',
    '#mg-toolbar .mg-ib{width:32px;height:32px;border-radius:9px;background:transparent;color:var(--sub);display:flex;align-items:center;justify-content:center;}',
    '#mg-toolbar .mg-ib:hover,#mg-toolbar .mg-chip:hover,#mg-toolbar .mg-txt:hover{background:var(--hov);color:var(--fg);}',
    '#mg-toolbar .mg-txt{height:32px;padding:0 10px;border-radius:9px;background:transparent;color:var(--sub);display:flex;align-items:center;gap:6px;white-space:nowrap;}',
    '#mg-toolbar .mg-txt.on{background:var(--sel);color:var(--fg);}',
    '#mg-toolbar .mg-primary{height:34px;padding:0 18px;border-radius:10px;color:#fff;font-weight:700;display:flex;align-items:center;gap:7px;',
    'background:var(--grad);white-space:nowrap;box-shadow:0 2px 10px var(--glow);}',
    '#mg-toolbar .mg-primary:hover{filter:brightness(1.08);}',
    '#mg-toolbar .mg-primary[disabled]{opacity:.45;cursor:default;filter:none;box-shadow:none;}',
    '#mg-toolbar .mg-primary svg{margin:0!important;}',
    '#mg-toolbar .mg-cnt{font-weight:700;color:var(--cnt);white-space:nowrap;direction:ltr;}',
    '#mg-toolbar .mg-pop{display:none;position:absolute;top:50px;z-index:2;min-width:230px;padding:10px;border-radius:12px;',
    'background:var(--pop);border:1px solid var(--line);box-shadow:0 10px 30px var(--shadow);flex-direction:column;gap:8px;}',
    '#mg-toolbar .mg-pop.open{display:flex;}',
    '#mg-toolbar .mg-pop input{width:100%;height:34px;padding:0 10px;border-radius:8px;border:1px solid var(--inl);background:var(--inp);color:var(--fg);direction:ltr;font-size:13px;font-weight:600;}',
    '#mg-toolbar .mg-pop small{color:var(--sub);direction:ltr;word-break:break-all;}',
    '#mg-toolbar .mg-item{height:34px;padding:0 10px;border-radius:8px;background:transparent;color:var(--fg);display:flex;align-items:center;gap:8px;text-align:start;}',
    '#mg-toolbar .mg-item:hover{background:var(--hov);}',
    '@media (max-width:820px){#mg-toolbar .mg-chip span{display:none}#mg-toolbar .mg-chip b{max-width:90px}#mg-toolbar .mg-primary{padding:0 12px}}',
    '@media (max-width:600px){#mg-row{padding:0 8px;gap:6px}#mg-toolbar #mg-seltoggle{font-size:0;padding:0 8px}#mg-toolbar .mg-chip b{max-width:60px}}',
    '#mg-bar{position:absolute;left:0;right:0;bottom:0;height:3px;background:transparent;display:none;}',
    '#mg-bar i{display:block;height:100%;width:0;background:var(--grad);transition:width .4s;}',
  ].join('');

  // The app's theme decides the bar's colours (asked of the main window).
  async function syncTheme() {
    try {
      const t = await ipcRenderer.invoke('embed:theme');
      const bar = $('#mg-toolbar');
      if (bar) bar.classList.toggle('mg-dark', t === 'dark');
    } catch {}
  }

  function iconBtn(name, title, onClick) {
    const b = document.createElement('button');
    b.className = 'mg-ib';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.appendChild(svgIcon(name, 18));
    b.addEventListener('click', onClick);
    return b;
  }

  function textBtn(cls, label, title, onClick) {
    const b = document.createElement('button');
    b.className = cls;
    b.title = title;
    setLabel(b, label);
    b.addEventListener('click', onClick);
    return b;
  }

  function popover(side) {
    const p = document.createElement('div');
    p.className = 'mg-pop';
    p.style[side] = '12px';
    return p;
  }

  function closePops(except) {
    for (const p of $$('#mg-toolbar .mg-pop')) if (p !== except) p.classList.remove('open');
  }

  function folderChip() {
    const chip = document.createElement('button');
    chip.className = 'mg-chip';
    chip.id = 'mg-chip';
    chip.appendChild(svgIcon('folder', 16));
    chip.appendChild(mkEl('span', 'ينزّل في'));
    chip.appendChild(mkEl('b', defaultFolder || 'التحميلات'));
    chip.appendChild(svgIcon('chevron', 14));
    return chip;
  }

  function syncChip() {
    const chip = $('#mg-chip');
    if (!chip) return;
    const name = currentFolder();
    chip.querySelector('b').textContent = name || 'التحميلات';
    chip.title = (baseDir ? baseDir + '\\' : '') + name;
    const small = $('#mg-pop-path');
    if (small) small.textContent = chip.title;
  }

  function folderPop() {
    const pop = popover('right');
    pop.id = 'mg-pop-folder';
    const input = document.createElement('input');
    input.id = 'mg-folder';
    input.value = defaultFolder;
    input.placeholder = 'اسم المجلد';
    input.addEventListener('input', syncChip);
    const path = document.createElement('small');
    path.id = 'mg-pop-path';
    pop.appendChild(mkEl('span', 'اسم مجلد التحميل', 'color:#a3a1b8;'));
    pop.appendChild(input);
    pop.appendChild(path);
    pop.appendChild(textBtn('mg-item', '📂 فتح المجلد', 'يفتح مجلد التحميل',
      () => ipcRenderer.invoke('embed:openFolder', currentFolder())));
    return pop;
  }

  /* what the one big button does depends on what is on screen */

  function mainAction() {
    const sel = document.documentElement.classList.contains('mg-selecting');
    if (sel && selCount() > 0) return { label: '⬇ حمّل المحدد (' + selCount() + ')', run: downloadSelected };
    let open = null;
    try { open = R.current(); } catch {}
    if (open && open.url) return { label: '⬇ حمّل', run: () => queue(open) };
    const n = allButtons().length;
    if (n > 1) return { label: '⬇ حمّل الكل (' + n + ')', run: downloadAllVisible, confirm: 'هتحمّل كل الـ ' + n + ' اللي ظاهرين. متأكد؟' };
    if (n === 1) return { label: '⬇ حمّل', run: downloadAllVisible };
    return null;
  }

  function refreshMain() {
    const b = $('#mg-main');
    if (!b) return;
    const a = mainAction();
    b.disabled = !a;
    const label = a ? a.label : '⬇ حمّل';
    if (getLabel(b) !== label) setLabel(b, label);
  }

  function runMain() {
    const a = mainAction();
    if (!a) return;
    if (a.confirm && !confirm(a.confirm)) return;
    const n = a.run();
    if (n) track(n);
  }

  function selectToggle() {
    const t = textBtn('mg-txt', '☑ تحديد', 'تحديد كذا حاجة وتحميلهم مرة واحدة', () => {
      const on = document.documentElement.classList.toggle('mg-selecting');
      t.classList.toggle('on', on);
      if (!on) for (const cb of $$('.mg-sel:checked')) cb.checked = false;
      refreshMain();
    });
    t.id = 'mg-seltoggle';
    return t;
  }

  function menuPop() {
    const pop = popover('left');
    pop.id = 'mg-pop-menu';
    pop.appendChild(textBtn('mg-item', '↺ صفّر العلامات', 'يشيل كل العلامات الخضرا ويرجّع الأزرار «تحميل»',
      () => { closePops(); resetMarks(); }));
    return pop;
  }

  /* progress: «3 / 12» + a hairline bar, only while something is downloading */

  let total = 0, lastQueued = 0, idlePolls = 0, pollTimer = null;

  function showProgress(done) {
    const cnt = $('#mg-cnt'), stop = $('#mg-stop'), bar = $('#mg-bar');
    if (!cnt) return;
    const on = total > 0;
    cnt.style.display = on ? '' : 'none';
    stop.style.display = on ? '' : 'none';
    bar.style.display = on ? 'block' : 'none';
    if (on) {
      cnt.textContent = Math.min(done, total) + ' / ' + total;
      bar.firstChild.style.width = Math.round(100 * Math.min(done, total) / total) + '%';
    }
  }

  async function poll() {
    let active = 0;
    try { active = (await ipcRenderer.invoke('embed:active')).active || 0; } catch {}
    const settled = Date.now() - lastQueued > 4000;
    idlePolls = (active === 0 && settled) ? idlePolls + 1 : 0;
    showProgress(total - active);
    if (idlePolls >= 2) {
      showProgress(total);
      clearInterval(pollTimer); pollTimer = null;
      setTimeout(() => { if (!pollTimer) { total = 0; showProgress(0); } }, 2500);
    }
  }

  function track(n) {
    total += n;
    lastQueued = Date.now();
    idlePolls = 0;
    showProgress(0);
    if (!pollTimer) pollTimer = setInterval(poll, 1000);
  }

  async function stopAll() {
    try { await ipcRenderer.invoke('embed:stopAll'); } catch {}
    total = 0; idlePolls = 0;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    showProgress(0);
  }

  function toolbarRow() {
    const row = document.createElement('div');
    row.id = 'mg-row';

    const right = document.createElement('div');
    right.className = 'mg-grp';
    const mark = document.createElement('div');
    mark.className = 'mg-mark';
    const mi = svgIcon('download', 16); mi.style.margin = '0'; mi.setAttribute('stroke-width', '2.6');
    mark.appendChild(mi);
    mark.title = 'MediaGrab';
    right.appendChild(mark);
    const chip = folderChip();
    right.appendChild(chip);

    const mid = document.createElement('div');
    mid.className = 'mg-grp';
    const main = textBtn('mg-primary', '⬇ حمّل', 'ينزّل اللي ظاهر قدامك', runMain);
    main.id = 'mg-main';
    main.disabled = true;
    mid.appendChild(main);
    mid.appendChild(selectToggle());
    const cnt = document.createElement('span');
    cnt.className = 'mg-cnt'; cnt.id = 'mg-cnt'; cnt.style.display = 'none';
    mid.appendChild(cnt);
    const stop = iconBtn('stop', 'إيقاف التحميلات الجارية', stopAll);
    stop.id = 'mg-stop'; stop.style.display = 'none';
    mid.appendChild(stop);

    const left = document.createElement('div');
    left.className = 'mg-grp mg-left';
    for (const extra of (R.buttons({ mkBtn, queue, currentFolder, btnStyle }) || [])) {
      extra.style.cssText = 'display:none;';
      extra.className = 'mg-txt';
      left.appendChild(extra);
    }
    const more = iconBtn('more', 'المزيد', (e) => {
      e.stopPropagation();
      const p = $('#mg-pop-menu'); const was = p.classList.contains('open');
      closePops(); p.classList.toggle('open', !was);
    });
    left.appendChild(more);
    left.appendChild(iconBtn('arrow-right', 'رجوع للصفحة اللي قبلها', () => { try { history.back(); } catch {} }));
    // A real close: on macOS a full-screen window hides the traffic lights.
    left.appendChild(iconBtn('x', 'إغلاق النافذة', () => ipcRenderer.invoke('embed:close').catch(() => {})));

    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = $('#mg-pop-folder'); const was = p.classList.contains('open');
      closePops(); p.classList.toggle('open', !was); syncChip();
    });

    row.appendChild(right); row.appendChild(mid); row.appendChild(left);
    row.appendChild(folderPop()); row.appendChild(menuPop());
    const bar = document.createElement('div');
    bar.id = 'mg-bar'; bar.appendChild(document.createElement('i'));
    row.appendChild(bar);
    return row;
  }

  /* ── "the site came back empty" rescue row ────────────────────────── */

  const EMPTY_AFTER_MS = 9000;
  let emptySince = 0, sawCards = false, lastKey = '', reloaded = false;

  // One calm line, one button: either «no results — try another word» or, when
  // the site itself is asking for a login, «log in first» (the site's own page).
  function rescueRow() {
    const row = document.createElement('div');
    row.id = 'mg-empty';
    row.style.cssText = 'display:none;gap:10px;align-items:center;background:var(--chip);'
      + 'border:1px solid var(--line);border-radius:10px;padding:6px 12px;min-height:40px;';
    const msg = mkEl('span', '', 'flex:1;min-width:0;line-height:1.5;');
    msg.id = 'mg-empty-msg';
    row.appendChild(msg);
    const act = mkBtn('🔎 جرّب كلمة تانية', '', '#E5532D', () => {
      if (act.dataset.mode === 'login') ipcRenderer.invoke('embed:relogin').catch(() => {});
      else ipcRenderer.invoke('embed:retype').catch(() => {});
    });
    act.id = 'mg-empty-act';
    act.style.padding = '6px 14px';
    row.appendChild(act);
    return row;
  }

  function needsLogin() { return /login|accounts\/|signin/i.test(location.pathname + location.search); }

  // Deliberately waits before accusing anyone: an empty grid a second after
  // navigating is just a grid still loading. A page that is still empty after
  // the first wait is reloaded once by itself; only a second wait shows the line.
  function updateRescue(listing) {
    const row = $('#mg-empty');
    if (!row) return;
    const key = location.pathname + location.search;
    if (key !== lastKey) { lastKey = key; emptySince = Date.now(); sawCards = false; reloaded = false; }
    if (!listing) { row.style.display = 'none'; return; }
    if (allButtons().length > 0) { sawCards = true; row.style.display = 'none'; return; }
    const waited = Date.now() - emptySince;
    if (!sawCards && !reloaded && waited > EMPTY_AFTER_MS && !needsLogin()) {
      reloaded = true; emptySince = Date.now();
      try { location.reload(); } catch {}
      return;
    }
    const show = !sawCards && waited > EMPTY_AFTER_MS;
    if (show) {
      const login = needsLogin();
      const act = $('#mg-empty-act');
      act.dataset.mode = login ? 'login' : 'retype';
      setLabel(act, login ? '🔑 سجّل دخول' : '🔎 جرّب كلمة تانية');
      $('#mg-empty-msg').textContent = login ? 'الموقع عايزك تسجّل دخول الأول.' : 'مفيش نتايج للبحث ده.';
    }
    row.style.display = show ? 'flex' : 'none';
  }
  function injectToolbar() {
    if ($('#mg-toolbar') || !document.body) return;
    const bar = document.createElement('div');
    bar.id = 'mg-toolbar';
    bar.appendChild(toolbarRow());
    if (R.rescue) {
      const rescue = rescueRow();
      rescue.style.margin = '0 12px 8px';
      bar.appendChild(rescue);
    }
    document.addEventListener('click', () => closePops(), true);
    syncTheme();
    setInterval(syncTheme, 4000);
    (document.body || document.documentElement).appendChild(bar);

    pushPageDown();
    setTimeout(pushPageDown, 400);
    ipcRenderer.invoke('embed:baseDir')
      .then((b) => {
        baseDir = b || '';
        syncChip();
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
      refreshMain();
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
