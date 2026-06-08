/**
 * Preload injected into the embedded Facebook window. Same idea as the TikTok
 * and Instagram embeds: a MediaGrab toolbar + a «تحميل» button on every video
 * tile in Facebook's video search, forwarded to the normal download queue.
 *
 * The window uses a mobile user-agent (set in main.js) so Facebook serves a
 * lighter layout. Facebook's DOM is heavily obfuscated, so we key purely off
 * the stable video URL shapes (/watch/?v=, /reel/, /videos/).
 */
const { ipcRenderer } = require('electron');

(function () {
  const BTN_CLASS = 'mg-dl-btn';
  const BTN_LABEL = '⬇ تحميل';

  let defaultFolder = '';
  try { defaultFolder = new URLSearchParams(location.search).get('query') || new URLSearchParams(location.search).get('q') || ''; } catch {}

  let downloadedSet = new Set();

  function applyState(btn) {
    if (btn.dataset.done === '1') {
      btn.textContent = '✓ اتحمّل';
      btn.style.background = '#16a34a';
    } else {
      btn.textContent = BTN_LABEL;
      btn.style.background = '#7c3aed';
    }
  }

  function currentFolder() {
    return (document.getElementById('mg-folder') && document.getElementById('mg-folder').value || defaultFolder || '').trim();
  }

  // Pull a stable id + canonical URL out of a Facebook video link.
  function fbVideo(a) {
    const href = a.getAttribute('href') || '';
    let m;
    if ((m = href.match(/[?&]v=(\d+)/))) return { id: m[1], url: 'https://www.facebook.com/watch/?v=' + m[1] };
    if ((m = href.match(/\/reel\/(\d+)/))) return { id: m[1], url: 'https://www.facebook.com/reel/' + m[1] };
    if ((m = href.match(/\/videos\/(?:[^/]*\/)?(\d+)/))) return { id: m[1], url: 'https://www.facebook.com' + href.split('?')[0] };
    return null;
  }

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
    if (urls.length) ipcRenderer.send('facebook-embed:download', { urls, folder });
    return urls.length;
  }

  function updateSelCount() {
    const n = document.querySelectorAll('.mg-sel:checked').length;
    const el = document.getElementById('mg-sel-btn');
    if (el) el.textContent = '⬇ حمّل المحدد (' + n + ')';
  }

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
    if (urls.length) ipcRenderer.send('facebook-embed:download', { urls, folder });
    updateSelCount();
    return urls.length;
  }

  async function resetMarks() {
    try { await ipcRenderer.invoke('facebook-embed:clearDownloaded'); } catch {}
    downloadedSet = new Set();
    for (const btn of document.querySelectorAll('.' + BTN_CLASS + '[data-vid]')) {
      btn.dataset.done = '';
      applyState(btn);
    }
  }

  async function refreshDownloadedMarks() {
    try {
      const ids = await ipcRenderer.invoke('facebook-embed:downloadedIds');
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

  function pushPageDown() {
    try {
      const bar = document.getElementById('mg-toolbar');
      if (!bar || !document.body) return;
      const h = bar.offsetHeight + 14;
      document.body.style.paddingTop = h + 'px';
    } catch {}
  }

  function injectToolbar() {
    if (document.getElementById('mg-toolbar')) return;
    if (!document.body) return;

    const bar = document.createElement('div');
    bar.id = 'mg-toolbar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#15131f;color:#fff;display:flex;flex-direction:column;gap:9px;padding:11px 16px;font-family:sans-serif;font-size:13px;box-shadow:0 2px 16px rgba(0,0,0,.7);direction:rtl;border-bottom:1px solid #2a2740;';

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
    openBtn.style.cssText = btnStyle('#2563eb');
    openBtn.addEventListener('click', () => { ipcRenderer.invoke('facebook-embed:openFolder', currentFolder()); });
    row1.appendChild(openBtn);
    bar.appendChild(row1);

    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';

    const dlAll = document.createElement('button');
    dlAll.textContent = '⬇ حمّل كل الظاهر';
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

    const selToggle = document.createElement('button');
    selToggle.id = 'mg-sel-toggle';
    selToggle.textContent = '☑ تحديد';
    selToggle.style.cssText = btnStyle('#0ea5e9');
    row2.appendChild(selToggle);

    const selBtn = document.createElement('button');
    selBtn.id = 'mg-sel-btn';
    selBtn.textContent = '⬇ حمّل المحدد (0)';
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
      if (!on) { for (const cb of document.querySelectorAll('.mg-sel:checked')) cb.checked = false; updateSelCount(); }
    });

    const reset = document.createElement('button');
    reset.textContent = '↺ صفّر العلامات';
    reset.style.cssText = btnStyle('#374151');
    reset.addEventListener('click', () => resetMarks());
    row2.appendChild(reset);

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
    row2.appendChild(stopBtn);

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    row2.appendChild(spacer);

    const back = document.createElement('button');
    back.textContent = '✕ رجوع للنتايج';
    back.style.cssText = btnStyle('#dc2626');
    back.addEventListener('click', () => { try { history.back(); } catch {} });
    row2.appendChild(back);
    bar.appendChild(row2);

    (document.body || document.documentElement).appendChild(bar);
    pushPageDown();
    setTimeout(pushPageDown, 400);
    ipcRenderer.invoke('facebook-embed:baseDir').then((b) => { baseDir = b || ''; renderBasePath(); }).catch(() => {});
  }

  function addButtons() {
    for (const a of document.querySelectorAll('a[href*="/watch/"], a[href*="/reel/"], a[href*="/videos/"]')) {
      const v = fbVideo(a);
      if (!v) continue;
      if (a.closest('[role="dialog"]')) continue;
      if (!a.querySelector('img') && !a.querySelector('video')) continue;
      if (document.querySelector('.' + BTN_CLASS + '[data-vid="' + v.id + '"]')) continue;
      if (getComputedStyle(a).position === 'static') a.style.position = 'relative';

      const btn = document.createElement('button');
      btn.className = BTN_CLASS;
      btn.setAttribute('data-vid', v.id);
      btn.setAttribute('data-url', v.url);
      btn.style.cssText = 'position:absolute;top:8px;left:8px;z-index:50;background:#7c3aed;color:#fff;border:none;border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.5);';
      if (downloadedSet.has(v.id)) btn.dataset.done = '1';
      applyState(btn);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        ipcRenderer.send('facebook-embed:download', { url: v.url, folder: currentFolder() });
        btn.dataset.done = '1';
        btn.textContent = '✓ في الطابور';
        btn.style.background = '#16a34a';
        setTimeout(() => applyState(btn), 2500);
      }, true);
      a.appendChild(btn);

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'mg-sel';
      cb.setAttribute('data-vid', v.id);
      cb.setAttribute('data-url', v.url);
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
    s.textContent =
      '.mg-sel{display:none!important;}' +
      'html.mg-selecting .mg-sel{display:inline-block!important;}';
    (document.head || document.documentElement).appendChild(s);
  }

  function tick() {
    try {
      injectStyle();
      injectToolbar();
      pushPageDown();
      addButtons();
    } catch {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick);
  } else {
    tick();
  }
  setInterval(tick, 1500);
  refreshDownloadedMarks();
  setInterval(refreshDownloadedMarks, 3000);
})();
