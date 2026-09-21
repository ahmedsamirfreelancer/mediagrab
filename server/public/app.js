/**
 * MediaGrab — Client
 *
 * The app is a launcher and a download queue, nothing else. It never renders
 * a platform's content: a video link downloads straight away, and anything
 * else (a word, a profile, a page) opens the REAL site in its own window with
 * a download button on every post. What you click there lands in the queue
 * below through `embed:download`.
 */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────
  const state = {
    platform: 'tiktok',
    queue: new Map(),
    activeBatch: null,
    // Filled from /api/env on boot; these are only what we assume until then.
    env: { platform: 'win32', sep: '\\', home: '', defaultOutputDir: '' },
    settings: {
      outputDir: '',
      quality: 'best',
      concurrent: 3,
      filenameTemplate: '{title}',
      autoDetect: true,
      autoDownload: false,
      skipExisting: true,
      organizeByAuthor: false,
      notifyOnComplete: true,
      speedLimitKBps: 0,
      downloadSubs: false,
      cookiesFile: '',
      customArgs: '',
    },
  };

  // ─── DOM ────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    mainInput: $('#main-input'),
    pasteBtn: $('#paste-btn'),
    goBtn: $('#go-btn'),
    goLabel: $('#go-label'),
    launchHint: $('#launch-hint'),
    launchPlatform: $('#launch-platform'),
    openHomeBtn: $('#open-home-btn'),
    openHomeLabel: $('#open-home-label'),
    imgSearchBtn: $('#img-search-btn'),
    subfolderInput: $('#subfolder-input'),
    folderPath: $('#folder-path'),
    launcher: $('#launcher'),
    adlibSection: $('#adlib-section'),
    statsBtn: $('#stats-btn'),
    statsModal: $('#stats-modal'),
    statsClose: $('#stats-close'),
    statsBody: $('#stats-body'),
    notesBtn: $('#notes-btn'),
    notesModal: $('#notes-modal'),
    notesClose: $('#notes-close'),
    notesBody: $('#notes-body'),
    notesInput: $('#notes-input'),
    notesAddBtn: $('#notes-add-btn'),
    notesProgress: $('#notes-progress'),
    notesClearDone: $('#notes-clear-done'),
    notesClearAll: $('#notes-clear-all'),
    queueList: $('#queue-list'),
    queueCount: $('#queue-count'),
    queueEmpty: $('#queue-empty'),
    stopAllBtn: $('#stop-all-btn'),
    clearCompletedBtn: $('#clear-completed-btn'),
    loading: $('#loading'),
    connectionStatus: $('#connection-status'),
    settingsBtn: $('#settings-btn'),
    settingsModal: $('#settings-modal'),
    settingsClose: $('#settings-close'),
    settingsSave: $('#settings-save'),
    settingsReset: $('#settings-reset'),
    toastContainer: $('#toast-container'),
  };

  /* ─── The platforms ───────────────────────────────────────────────────────
   * `post` is what tells a single video apart from everything else on the
   * same site: a link that matches it downloads, a link that doesn't opens
   * the page in a window (a profile, a hashtag, a search, the site itself). */
  const PLATFORMS = {
    tiktok: {
      name: 'تيك توك',
      site: /tiktok\.com|vm\.tiktok/i,
      post: /\/(video|photo)\/\d+|vm\.tiktok\.com\//i,
      id: /\/(?:video|photo)\/(\d+)/,
      ask: 'اكتب اللي بتدوّر عليه على تيك توك',
    },
    youtube: {
      name: 'يوتيوب',
      site: /youtube\.com|youtu\.be/i,
      post: /[?&]v=[\w-]{11}|youtu\.be\/[\w-]{11}|\/shorts\/[\w-]{11}/i,
      id: /(?:[?&]v=|youtu\.be\/|\/shorts\/)([\w-]{11})/,
      ask: 'اكتب اللي بتدوّر عليه على يوتيوب',
    },
    instagram: {
      name: 'إنستجرام',
      site: /instagram\.com|instagr\.am/i,
      post: /\/(p|reel|tv)\/[^/?]+/i,
      id: /\/(?:p|reel|tv)\/([^/?]+)/,
      ask: 'اكتب كلمة — أو @اسم حساب',
    },
    facebook: {
      name: 'فيسبوك',
      site: /facebook\.com|fb\.watch|fb\.com/i,
      post: /[?&]v=\d+|\/reel\/\d+|\/videos\/\d+|fb\.watch\//i,
      id: /(?:[?&]v=|\/reel\/|\/videos\/)(\d+)/,
      ask: 'اكتب كلمة — أو اسم صفحة',
    },
    pinterest: {
      name: 'بنترست',
      site: /pinterest\.com|pin\.it/i,
      post: /\/pin\/\d+|pin\.it\//i,
      id: /\/pin\/(\d+)/,
      ask: 'اكتب اللي بتدوّر عليه على بنترست',
    },
    adlibrary: { name: 'مكتبة الإعلانات' },
  };

  function platformName(key) { return (PLATFORMS[key] || {}).name || key; }

  function detectPlatform(url) {
    for (const [key, p] of Object.entries(PLATFORMS)) {
      if (p.site && p.site.test(url)) return key;
    }
    return null;
  }

  function isValidUrl(s) {
    if (!s) return false;
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch { return false; }
  }

  // A link to ONE video/pin/post — the only thing that skips the window.
  function isSinglePost(key, url) {
    const p = PLATFORMS[key];
    return !!(p && p.post && p.post.test(url));
  }

  // The name a download gets. Built from the post's id, never from the raw
  // URL — a URL as a filename came out as "https___www...mp4", which Windows
  // would not open. Popup downloads are named the same way.
  function nameFor(key, url) {
    const p = PLATFORMS[key];
    const m = p && p.id && url.match(p.id);
    return m ? `${key}_${m[1]}` : '';
  }

  // ─── Socket.IO ──────────────────────────────────────
  let socket;

  function initSocket() {
    socket = io({ transports: ['websocket', 'polling'], reconnection: true });

    socket.on('connect', async () => {
      setConnection(true, 'متصل');
      // Rebuild the queue from the server for anything we don't know about
      // (e.g. after a refresh).
      try {
        const r = await fetch('/api/active');
        const data = await r.json();
        for (const item of data.active || []) {
          if (state.queue.has(item.id)) continue;
          addQueueItem({ id: item.id, title: item.title, thumbnail: '', url: '', status: item.status, progress: 0 });
        }
      } catch { /* ignore */ }
    });

    socket.on('disconnect', () => setConnection(false, 'بيحاول يتصل…'));
    socket.on('connect_error', () => setConnection(false, 'مفيش اتصال'));

    socket.on('download:progress', (data) => {
      if (!state.queue.has(data.id)) {
        addQueueItem({ id: data.id, title: data.title || 'فيديو', thumbnail: '', url: '', status: 'downloading', progress: data.progress || 0 });
      }
      updateQueueItem(data.id, {
        progress: data.progress, speed: data.speed, eta: data.eta, title: data.title,
        status: 'downloading', downloaded: data.downloaded, total: data.total,
      });
    });

    socket.on('download:complete', (data) => {
      updateQueueItem(data.id, { progress: 100, status: 'completed', filePath: data.filePath, title: data.title });
      const msg = data.dedupe
        ? `سبق تنزيله: ${truncate(data.title || 'فيديو', 45)}`
        : data.skipped
          ? `تم تخطّى (موجود): ${truncate(data.title || 'فيديو', 50)}`
          : `تم: ${truncate(data.title || 'فيديو', 50)}`;
      const actions = data.filePath ? [
        { label: '▶ فتح الملف', onClick: () => openDownloadedFile(data.filePath) },
        { label: '📁 المجلد', onClick: () => openDownloadedFolder(data.filePath) },
      ] : [];
      toast(msg, 'success', 8000, actions);
      onTaskFinished(data.id, data.skipped ? 'skipped' : 'completed');
    });

    socket.on('download:error', (data) => {
      updateQueueItem(data.id, { status: 'error', error: data.error });
      toast(`فشل: ${truncate(data.error || 'خطأ غير معروف', 80)}`, 'error');
      onTaskFinished(data.id, 'error');
    });

    socket.on('download:queued', (data) => {
      if (!state.queue.has(data.id)) {
        addQueueItem({ id: data.id, title: data.title || 'فيديو', thumbnail: '', url: '', status: 'queued', progress: 0 });
      } else {
        updateQueueItem(data.id, { status: 'queued', progress: 0 });
      }
    });

    socket.on('download:cancelled', (data) => updateQueueItem(data.id, { status: 'cancelled' }));
  }

  function setConnection(ok, text) {
    dom.connectionStatus.classList.toggle('connected', ok);
    const el = dom.connectionStatus.querySelector('.status-text');
    if (el) el.textContent = text;
  }

  // ─── API ────────────────────────────────────────────
  async function apiCall(endpoint, body, method = 'POST') {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${endpoint}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // Single link → queue. A fresh queue id every time, so re-downloading the
  // same link adds a row instead of overwriting the old one.
  async function startDownload(url, info = {}) {
    if (!isValidUrl(url)) return toast('الرابط ده مش مظبوط', 'warning');
    const id = generateId();
    addQueueItem({
      id, title: info.title || url, thumbnail: info.thumbnail || '',
      url, status: 'queued', progress: 0,
    });

    try {
      await apiCall('/download', {
        url, platform: info.platform || state.platform, id,
        title: info.title || '',
        author: info.author || '',
        kind: info.kind || null,
        quality: info.quality || state.settings.quality,
        outputDir: state.settings.outputDir,
        filenameTemplate: state.settings.filenameTemplate,
        concurrent: state.settings.concurrent,
        skipExisting: state.settings.skipExisting,
        organizeByAuthor: state.settings.organizeByAuthor,
        speedLimitKBps: state.settings.speedLimitKBps,
        downloadSubs: state.settings.downloadSubs,
        cookiesFile: state.settings.cookiesFile,
        customArgs: state.settings.customArgs,
        subfolder: getCurrentSubfolder(),
        downloadUrl: info.downloadUrl || null,
        hdDownloadUrl: info.hdDownloadUrl || null,
      });
    } catch (err) {
      updateQueueItem(id, { status: 'error', error: err.message });
      toast(err.message, 'error');
    }
  }

  // Batch — we pre-create the queue rows with ids we control, then send those
  // exact ids to the server so its progress events match our rows.
  async function startBatchDownload(items, opts = {}) {
    if (!items.length) return;
    if (items.length >= 5 && !(await diskSpaceOk(items))) return;

    const enriched = items.map((item) => ({
      id: generateId(),
      url: item.url,
      title: item.title || 'فيديو',
      thumbnail: item.thumbnail || '',
      downloadUrl: item.downloadUrl || null,
      hdDownloadUrl: item.hdDownloadUrl || null,
      author: item.author || '',
      platform: item.platform || state.platform,
      kind: item.kind || null,
    }));

    for (const it of enriched) {
      addQueueItem({ id: it.id, title: it.title, thumbnail: it.thumbnail, url: it.url, status: 'queued', progress: 0 });
    }
    state.activeBatch = { ids: new Set(enriched.map((e) => e.id)), total: enriched.length, finished: 0, errors: 0, skipped: 0 };

    try {
      await apiCall('/download', {
        type: 'batch',
        platform: enriched[0].platform || state.platform,
        url: enriched[0].url || '',
        selectedVideos: enriched,
        quality: state.settings.quality,
        outputDir: opts.outputDir || state.settings.outputDir,
        filenameTemplate: state.settings.filenameTemplate,
        concurrent: state.settings.concurrent,
        skipExisting: state.settings.skipExisting,
        organizeByAuthor: state.settings.organizeByAuthor,
        speedLimitKBps: state.settings.speedLimitKBps,
        downloadSubs: state.settings.downloadSubs,
        cookiesFile: state.settings.cookiesFile,
        customArgs: state.settings.customArgs,
        subfolder: opts.subfolder !== undefined ? opts.subfolder : getCurrentSubfolder(),
        ignoreGlobalDedupe: opts.ignoreGlobalDedupe || false,
      });
      toast(`بدأنا ${enriched.length} تحميل`, 'info');
    } catch (err) {
      enriched.forEach((it) => updateQueueItem(it.id, { status: 'error', error: err.message }));
      toast(err.message, 'error');
    }
  }

  // Rough guard before a big batch: a full disk fails every item one by one.
  async function diskSpaceOk(items) {
    try {
      const ds = await (await fetch('/api/disk-space')).json();
      if (!ds.supported) return true;
      const bytesPerSec = state.platform === 'youtube' ? 250 * 1024 : 150 * 1024;
      const estimated = items.reduce((s, it) => s + (it.duration || 0), 0) * bytesPerSec;
      if (estimated <= ds.freeBytes * 0.9) return true;
      const need = (estimated / 1024 / 1024 / 1024).toFixed(2);
      const free = (ds.freeBytes / 1024 / 1024 / 1024).toFixed(2);
      return confirm(`⚠️ المساحة الفاضية قليلة!\n\nمتوقع: ${need} GB\nفاضي: ${free} GB\n\nتكمّل؟`);
    } catch { return true; }
  }

  async function cancelDownload(id) {
    try {
      await apiCall(`/cancel/${id}`, null, 'POST');
      updateQueueItem(id, { status: 'cancelled' });
    } catch {
      toast('مقدرناش نلغي التحميل', 'error');
    }
  }

  /* ─── The launcher ────────────────────────────────────────────────────────
   * One box, one button. What the button does is decided by what's in the
   * box, and the label says which before it's pressed. */

  function currentBase() {
    return (state.settings.outputDir || '').trim() || batchDefaultDir();
  }

  async function openPopup(key, opts = {}) {
    const api = window.electronAPI && window.electronAPI.embed;
    if (!api) return toast('فتح المواقع متاح في تطبيق سطح المكتب بس', 'warning');
    const r = await api.open(key, Object.assign({ base: currentBase() }, opts));
    if (r && r.success === false) return toast(r.error || 'مقدرناش نفتح الموقع', 'error');
    toast(`فتحنا ${platformName(key)} — دوس «تحميل» على أي حاجة`, 'info', 5000);
  }

  // The one action of the whole screen.
  function go() {
    const text = (dom.mainInput.value || '').trim();
    if (!text) {
      const p = PLATFORMS[state.platform];
      return toast(p && p.ask ? p.ask : 'اكتب حاجة الأول', 'warning');
    }
    if (!isValidUrl(text)) return openPopup(state.platform, { query: text });

    // A link: its own site decides, not the open tab.
    const key = detectPlatform(text) || state.platform;
    if (isSinglePost(key, text)) {
      startDownload(text, { platform: key, title: nameFor(key, text) });
      dom.mainInput.value = '';
      updateGoButton();
      return;
    }
    // A profile / page / hashtag / anything else on the site → open it.
    openPopup(key, { url: text });
  }

  // Keeps the button honest: it says «نزّل» only when pressing it downloads.
  function updateGoButton() {
    const text = (dom.mainInput.value || '').trim();
    const link = isValidUrl(text);
    const key = link ? (detectPlatform(text) || state.platform) : state.platform;
    const willDownload = link && isSinglePost(key, text);
    dom.goLabel.textContent = willDownload ? 'نزّل' : 'افتح';
    dom.goBtn.classList.toggle('is-download', willDownload);
    dom.launchHint.textContent = willDownload
      ? `لينك فيديو من ${platformName(key)} — هينزّل على طول`
      : link
        ? `هنفتح الصفحة دي في شباك ${platformName(key)} وعليها أزرار تحميل`
        : 'لينك فيديو جاهز بينزّل على طول · أي كلمة تانية بتفتح الموقع';
  }

  // ─── Platform tabs ──────────────────────────────────
  function switchPlatform(key) {
    state.platform = key;
    $$('.platform-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.platform === key));

    // The Ad Library has its own filter panel instead of the launcher box.
    const isAdLib = key === 'adlibrary';
    if (dom.launcher) dom.launcher.style.display = isAdLib ? 'none' : '';
    if (dom.adlibSection) dom.adlibSection.style.display = isAdLib ? '' : 'none';
    if (isAdLib) refreshFacebookLoginStatus();

    const p = PLATFORMS[key] || {};
    if (dom.launchPlatform) dom.launchPlatform.textContent = p.name || key;
    if (dom.openHomeLabel) dom.openHomeLabel.textContent = `افتح ${p.name || key} من غير بحث`;
    if (dom.mainInput) dom.mainInput.placeholder = `لينك فيديو — أو ${p.ask || 'اكتب اللي بتدوّر عليه'}`;

    // Facebook is the one platform whose login we still manage from here: its
    // video search is empty without one.
    const fbBanner = document.getElementById('fb-login-banner');
    if (fbBanner) {
      const show = key === 'facebook' && !!(window.electronAPI && window.electronAPI.facebook);
      fbBanner.style.display = show ? 'flex' : 'none';
      if (show) refreshFacebookLoginStatus();
    }
    // Instagram mirrors TikTok: no banner here, you log in inside the window.
    const igBanner = document.getElementById('ig-login-banner');
    if (igBanner) igBanner.style.display = 'none';

    updateGoButton();
    updateFolderUI();
  }

  /* ─── What the popups send back ───────────────────────────────────────────
   * One channel for every platform: { platform, items:[{url,id,kind}], folder }.
   * The folder is the one typed in the popup's own toolbar, so a search's
   * videos land together. */

  function bindEmbedDownloads() {
    const api = window.electronAPI && window.electronAPI.embed;
    if (api && api.onDownload) api.onDownload(onEmbedDownload);
    // Ad Library creatives carry a direct media URL + the advertiser's name,
    // so the server downloads them straight instead of through yt-dlp.
    const fb = window.electronAPI && window.electronAPI.facebook;
    if (fb && fb.onAdLibDownload) fb.onAdLibDownload(onAdLibraryDownload);
  }

  function onEmbedDownload(data) {
    if (!data) return;
    const key = data.platform || state.platform;
    const raw = Array.isArray(data.items) ? data.items
      : Array.isArray(data.urls) ? data.urls.map((u) => ({ url: u }))
        : data.url ? [{ url: data.url, kind: data.kind }] : [];
    const items = raw.filter((it) => it && it.url).map((it) => ({
      url: it.url,
      kind: it.kind || null,
      // A clean ASCII name from the post id — NOT the raw URL, which made
      // unopenable filenames like "https___www...mp4".
      title: it.id ? `${key}_${it.id}` : it.url,
      platform: key,
    }));
    if (!items.length) return;
    startBatchDownload(items, {
      outputDir: currentBase(),
      subfolder: (data.folder || '').trim(),
      ignoreGlobalDedupe: true,
    });
  }

  function onAdLibraryDownload(data) {
    if (!data || !Array.isArray(data.items) || !data.items.length) return;
    const items = data.items.filter((it) => it && it.downloadUrl).map((it) => ({
      url: it.downloadUrl,
      downloadUrl: it.downloadUrl,
      kind: it.kind || 'image',
      title: it.title || ('fb_ad_' + (it.id || '')),
      author: (it.advertiser || '').trim() || 'fb-ads',
      platform: 'facebook-ad',
    }));
    if (items.length) {
      startBatchDownload(items, {
        outputDir: currentBase(),
        subfolder: (data.folder || '').trim(),
        ignoreGlobalDedupe: true,
      });
    }
  }

  // ─── Destination folder ─────────────────────────────
  function getCurrentSubfolder() {
    return (dom.subfolderInput && dom.subfolderInput.value || '').trim();
  }

  function updateFolderUI() {
    if (!dom.folderPath) return;
    const base = state.settings.outputDir || state.env.defaultOutputDir || '';
    const sub = getCurrentSubfolder();
    const sep = state.env.sep || '\\';
    dom.folderPath.textContent = sub ? `${base}${sep}${sub}${sep}` : `${base}${sep}`;
    // The popups show the same base path in their own toolbar.
    const api = window.electronAPI && window.electronAPI.embed;
    if (api && api.setBaseDir) api.setBaseDir(currentBase());
  }

  // ─── Batch tracking + browser notifications ─────────
  function onTaskFinished(id, kind /* completed | error | skipped */) {
    const batch = state.activeBatch;
    if (!batch || !batch.ids.has(id)) return;
    batch.finished++;
    if (kind === 'error') batch.errors++;
    if (kind === 'skipped') batch.skipped++;
    if (batch.finished >= batch.total) {
      const ok = batch.total - batch.errors;
      const title = batch.errors === 0
        ? `اكتملت ${ok} تحميلات`
        : `اكتمل ${ok}/${batch.total} (فشل ${batch.errors})`;
      const body = batch.skipped > 0 ? `(${batch.skipped} متخطّى)` : '';
      notifyUser(title, body);
      state.activeBatch = null;
    }
  }

  function notifyUser(title, body) {
    if (!state.settings.notifyOnComplete) return;
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      try { new Notification(title, { body, icon: '/favicon.ico' }); } catch {}
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') { try { new Notification(title, { body }); } catch {} }
      });
    }
  }


  // ─── Product Notes (creatives checklist) ────────────
  // قائمة بأسماء المنتجات اللي المستخدم هينزّل لها كرييتفات.
  // كل منتج يتعلّم عليه ✓ بعد ما يتحمّل. محفوظة في localStorage فتفضل بعد قفل البرنامج.
  const NOTES_KEY = 'mediagrab_product_notes';

  function loadNotes() {
    try { return JSON.parse(localStorage.getItem(NOTES_KEY)) || []; }
    catch { return []; }
  }
  function saveNotes(list) {
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(list)); } catch {}
  }

  function openNotes() {
    if (!dom.notesModal) return;
    renderNotes();
    dom.notesModal.classList.remove('hidden');
    if (dom.notesInput) setTimeout(() => dom.notesInput.focus(), 50);
  }

  function addNote() {
    const name = (dom.notesInput?.value || '').trim();
    if (!name) return;
    const list = loadNotes();
    if (list.some((n) => n.name.toLowerCase() === name.toLowerCase())) {
      toast('المنتج ده موجود في القائمة بالفعل', 'warning');
      dom.notesInput.value = '';
      return;
    }
    list.unshift({ id: 'n' + Date.now() + Math.floor(Math.random() * 1000), name, done: false, createdAt: Date.now() });
    saveNotes(list);
    dom.notesInput.value = '';
    renderNotes();
  }

  function updateNote(id, patch) {
    const list = loadNotes();
    const item = list.find((n) => n.id === id);
    if (!item) return;
    Object.assign(item, patch);
    saveNotes(list);
    renderNotes();
  }

  function deleteNote(id) {
    saveNotes(loadNotes().filter((n) => n.id !== id));
    renderNotes();
  }

  function renderNotes() {
    if (!dom.notesBody) return;
    const list = loadNotes();
    // المُحمّل ينزل تحت، والباقي بترتيب الإضافة (الأحدث فوق)
    list.sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1));
    const doneCount = list.filter((n) => n.done).length;

    if (dom.notesProgress) {
      dom.notesProgress.textContent = list.length
        ? `اتحمّل ${doneCount} من ${list.length} منتج`
        : '';
    }

    if (!list.length) {
      dom.notesBody.innerHTML = '<div class="history-empty">لسه مفيش منتجات — اكتب اسم منتج فوق وضيفه</div>';
      return;
    }

    dom.notesBody.innerHTML = '';
    list.forEach((n) => {
      const el = document.createElement('div');
      el.className = 'note-item' + (n.done ? ' note-done' : '');
      el.innerHTML = `
        <label class="note-check" title="علّم لما تحمّل كرييتفات المنتج">
          <input type="checkbox" ${n.done ? 'checked' : ''}>
        </label>
        <div class="note-name">${escapeHtml(n.name)}</div>
        <div class="note-actions">
          <button class="btn btn-secondary btn-sm note-search" title="ابحث عن المنتج ده دلوقتي">🔍 ابحث</button>
          <button class="icon-btn note-delete" title="حذف">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      `;
      el.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
        updateNote(n.id, { done: e.target.checked });
      });
      el.querySelector('.note-search').addEventListener('click', () => {
        dom.notesModal.classList.add('hidden');
        dom.mainInput.value = n.name;
        updateGoButton();
        openPopup(state.platform, { query: n.name });
      });
      el.querySelector('.note-delete').addEventListener('click', () => deleteNote(n.id));
      dom.notesBody.appendChild(el);
    });
  }


  // ─── Stats panel ────────────────────────────────────
  async function openStats() {
    if (!dom.statsModal) return;
    dom.statsBody.innerHTML = 'جاري التحميل...';
    dom.statsModal.classList.remove('hidden');
    try {
      const r = await fetch('/api/stats');
      const s = await r.json();
      const fmt = (b) => b < 1024*1024 ? (b/1024).toFixed(1)+' KB'
                       : b < 1024*1024*1024 ? (b/1024/1024).toFixed(1)+' MB'
                       : (b/1024/1024/1024).toFixed(2)+' GB';
      let html = `
        <div class="stats-grid">
          <div class="stat"><span class="stat-label">إجمالي التحميلات</span><span class="stat-value">${s.totalDownloads}</span></div>
          <div class="stat"><span class="stat-label">اليوم</span><span class="stat-value">${s.todayCount}</span></div>
          <div class="stat"><span class="stat-label">آخر أسبوع</span><span class="stat-value">${s.weekCount}</span></div>
          <div class="stat"><span class="stat-label">إجمالي الحجم</span><span class="stat-value">${fmt(s.totalBytes)}</span></div>
        </div>
        <h3 style="margin-top:20px;font-size:0.95rem;">حسب المنصة</h3>
        <div class="stats-grid">`;
      for (const [p, c] of Object.entries(s.perPlatform || {})) {
        html += `<div class="stat"><span class="stat-label">${escapeHtml(p)}</span><span class="stat-value">${c}</span></div>`;
      }
      html += `</div>`;
      if (s.topAuthorsList?.length) {
        html += `<h3 style="margin-top:20px;font-size:0.95rem;">أكثر القنوات تنزيلًا</h3><div class="top-authors">`;
        for (const a of s.topAuthorsList) {
          html += `<div class="author-row"><span>${escapeHtml(a.name)}</span><span class="author-count">${a.count}</span></div>`;
        }
        html += `</div>`;
      }
      dom.statsBody.innerHTML = html;
    } catch (err) {
      dom.statsBody.innerHTML = `فشل: ${escapeHtml(err.message)}`;
    }
  }


  // ─── Interrupted-queue restoration ──────────────────
  async function checkInterrupted() {
    try {
      const r = await fetch('/api/interrupted');
      const data = await r.json();
      const list = data.interrupted || [];
      if (!list.length) return;
      const yes = confirm(`فيه ${list.length} تحميل لم يكتمل من الجلسة السابقة. تحب أكمّلهم الآن؟`);
      if (yes) {
        startBatchDownload(list.map((t) => ({
          id: undefined,
          url: t.url,
          title: t.title,
          downloadUrl: t.downloadUrl,
          hdDownloadUrl: t.hdDownloadUrl,
          author: t.author,
          platform: t.platform,
        })));
      }
      await fetch('/api/interrupted', { method: 'DELETE' });
    } catch { /* ignore */ }
  }


  // ─── Queue ──────────────────────────────────────────
  function addQueueItem(item) {
    state.queue.set(item.id, item);
    renderQueueItem(item);
    updateQueueCount();
  }

  function renderQueueItem(item) {
    dom.queueEmpty.classList.add('hidden');
    let el = dom.queueList.querySelector(`[data-queue-id="${cssEscape(item.id)}"]`);
    if (el) { updateQueueItemDOM(el, item); return; }

    el = document.createElement('div');
    el.className = `queue-item ${item.status}`;
    el.dataset.queueId = item.id;
    el.innerHTML = `
      <div class="queue-item-thumb">
        ${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" referrerpolicy="no-referrer" alt="">` : ''}
      </div>
      <div class="queue-item-info">
        <div class="queue-item-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="queue-item-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${item.progress || 0}%"></div>
          </div>
          <span class="progress-text">${item.progress || 0}%</span>
        </div>
      </div>
      <div class="queue-item-status ${item.status}">${statusLabel(item.status)}</div>
      <div class="queue-item-actions">
        <button class="icon-btn queue-open-btn" title="فتح الملف" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="icon-btn queue-folder-btn" title="فتح المجلد" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="icon-btn queue-retry-btn" title="إعادة المحاولة" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
        <button class="icon-btn queue-cancel-btn" title="إلغاء">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `;
    el.querySelector('.queue-cancel-btn').addEventListener('click', () => cancelDownload(item.id));
    el.querySelector('.queue-retry-btn').addEventListener('click', () => retryDownload(item.id));
    el.querySelector('.queue-open-btn').addEventListener('click', () => {
      const cur = state.queue.get(item.id);
      openDownloadedFile(cur?.filePath);
    });
    el.querySelector('.queue-folder-btn').addEventListener('click', () => {
      const cur = state.queue.get(item.id);
      openDownloadedFolder(cur?.filePath);
    });

    // Right-click on queue item → delete from disk
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const cur = state.queue.get(item.id);
      if (!cur?.filePath) return toast('لا يوجد ملف مرتبط', 'warning');
      if (!confirm(`حذف الملف من الجهاز؟\n${cur.filePath}`)) return;
      fetch('/api/file', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: cur.filePath }),
      }).then((r) => r.json()).then((d) => {
        if (d.success) {
          toast('تم الحذف', 'success');
          el.remove();
          state.queue.delete(item.id);
        } else {
          toast(d.error || 'فشل الحذف', 'error');
        }
      });
    });

    if (dom.queueList.children.length > 1) {
      dom.queueList.insertBefore(el, dom.queueList.children[1] || null);
    } else {
      dom.queueList.appendChild(el);
    }
  }

  function updateQueueItem(id, updates) {
    const item = state.queue.get(id);
    if (!item) return;
    // A pasted link starts the row off labelled with the URL itself; the
    // first event that carries the real title replaces it.
    if (updates.title && /^https?:\/\//i.test(item.title || '')) item.title = updates.title;
    Object.assign(item, Object.assign({}, updates, { title: item.title }));
    const el = dom.queueList.querySelector(`[data-queue-id="${cssEscape(id)}"]`);
    if (el) updateQueueItemDOM(el, item);
    updateQueueCount();
  }

  function updateQueueItemDOM(el, item) {
    el.className = `queue-item ${item.status}`;
    const titleEl = el.querySelector('.queue-item-title');
    if (titleEl && titleEl.textContent !== item.title) {
      titleEl.textContent = item.title;
      titleEl.title = item.title;
    }
    const progressFill = el.querySelector('.progress-fill');
    const progressText = el.querySelector('.progress-text');
    const statusEl = el.querySelector('.queue-item-status');

    const pct = Math.round(item.progress || 0);
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressText) {
      let txt = `${pct}%`;
      if (item.status === 'downloading' && item.speed) txt += ` ${item.speed}`;
      if (item.status === 'downloading' && item.eta) txt += ` · ETA ${item.eta}`;
      progressText.textContent = txt;
    }
    if (statusEl) {
      statusEl.className = `queue-item-status ${item.status}`;
      statusEl.textContent = statusLabel(item.status);
    }
    const cancelBtn = el.querySelector('.queue-cancel-btn');
    if (cancelBtn) {
      const terminal = ['completed', 'error', 'cancelled'].includes(item.status);
      cancelBtn.style.display = terminal ? 'none' : '';
    }
    const retryBtn = el.querySelector('.queue-retry-btn');
    if (retryBtn) {
      const failed = ['error', 'cancelled'].includes(item.status);
      retryBtn.style.display = failed ? '' : 'none';
    }
    const openBtn = el.querySelector('.queue-open-btn');
    const folderBtn = el.querySelector('.queue-folder-btn');
    const isCompleted = item.status === 'completed' && item.filePath;
    if (openBtn) openBtn.style.display = isCompleted ? '' : 'none';
    if (folderBtn) folderBtn.style.display = isCompleted ? '' : 'none';
  }

  function retryDownload(id) {
    const item = state.queue.get(id);
    if (!item || !item.url) return toast('لا يمكن إعادة المحاولة (لا يوجد URL)', 'warning');
    const el = dom.queueList.querySelector(`[data-queue-id="${cssEscape(id)}"]`);
    if (el) el.remove();
    state.queue.delete(id);
    startDownload(item.url, {
      title: item.title, url: item.url,
      thumbnail: item.thumbnail,
      downloadUrl: item.downloadUrl, hdDownloadUrl: item.hdDownloadUrl,
    });
  }

  function updateQueueCount() {
    const active = [...state.queue.values()].filter(
      (q) => q.status === 'downloading' || q.status === 'queued'
    ).length;
    dom.queueCount.textContent = active > 0 ? `${active} نشط` : '';
    const hasItems = dom.queueList.querySelectorAll('.queue-item').length > 0;
    dom.queueEmpty.classList.toggle('hidden', hasItems);
  }

  async function clearCompletedDownloads() {
    const toRemove = [];
    state.queue.forEach((item, id) => {
      if (['completed', 'error', 'cancelled'].includes(item.status)) toRemove.push(id);
    });
    toRemove.forEach((id) => {
      state.queue.delete(id);
      const el = dom.queueList.querySelector(`[data-queue-id="${cssEscape(id)}"]`);
      if (el) {
        el.style.transition = 'opacity 0.3s, transform 0.3s';
        el.style.opacity = '0';
        el.style.transform = 'translateX(40px)';
        setTimeout(() => el.remove(), 300);
      }
    });
    setTimeout(updateQueueCount, 350);
    // Also clear server-side history
    try { await apiCall('/downloads', null, 'DELETE'); } catch { /* ignore */ }
  }

  function statusLabel(status) {
    const labels = {
      queued: 'في الانتظار',
      downloading: 'يحمّل',
      completed: 'مكتمل',
      error: 'خطأ',
      cancelled: 'أُلغي',
    };
    return labels[status] || status;
  }


  // ─── Instagram in-app login (Electron-only) ─────────
  async function refreshInstagramLoginStatus() {
    if (!window.electronAPI?.instagram) return;
    const statusEl = document.getElementById('ig-login-status');
    const loginBtn = document.getElementById('ig-login-btn');
    const logoutBtn = document.getElementById('ig-logout-btn');
    if (!statusEl) return;
    try {
      const { loggedIn, cookiesFile } = await window.electronAPI.instagram.status();
      if (loggedIn) {
        statusEl.textContent = 'مسجل دخول Instagram ✓';
        if (loginBtn) loginBtn.textContent = 'إعادة تسجيل دخول';
        if (logoutBtn) logoutBtn.style.display = '';
      } else if (cookiesFile) {
        statusEl.textContent = 'كوكيز مستوردة ✓ — جاهز للبحث';
        if (loginBtn) loginBtn.textContent = 'تسجيل دخول Instagram';
        if (logoutBtn) logoutBtn.style.display = '';
      } else {
        statusEl.textContent = 'مش مسجل دخول';
        if (loginBtn) loginBtn.textContent = 'تسجيل دخول Instagram';
        if (logoutBtn) logoutBtn.style.display = 'none';
      }
    } catch (e) { /* ignore */ }
  }


  // ─── yt-dlp settings section (Electron-only) ────
  async function refreshYtdlpSection() {
    if (!window.electronAPI?.ytdlp) return;
    document.getElementById('ytdlp-section').style.display = '';
    try {
      const r = await window.electronAPI.ytdlp.check();
      const cur = document.getElementById('ytdlp-current');
      const latest = document.getElementById('ytdlp-latest');
      const updBtn = document.getElementById('ytdlp-update-btn');
      if (cur) cur.textContent = r.current || '—';
      if (latest) latest.textContent = r.latest || '—';
      if (updBtn) updBtn.style.display = r.updateAvailable ? '' : 'none';
    } catch (e) { /* ignore */ }
  }

  function bindYtdlpButtons() {
    if (!window.electronAPI) return;

    const checkBtn = document.getElementById('ytdlp-check-btn');
    if (checkBtn) {
      checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = 'جاري الفحص...';
        await refreshYtdlpSection();
        checkBtn.disabled = false;
        checkBtn.textContent = 'فحص';
      });
    }

    const updBtn = document.getElementById('ytdlp-update-btn');
    if (updBtn) {
      updBtn.addEventListener('click', async () => {
        updBtn.disabled = true;
        updBtn.textContent = 'جاري التحديث...';
        const r = await window.electronAPI.ytdlp.update();
        if (r.success) {
          toast(`تم التحديث إلى ${r.version}`, 'success');
          refreshYtdlpSection();
        } else {
          toast(r.message || 'فشل التحديث', 'error');
        }
        updBtn.disabled = false;
        updBtn.textContent = 'تحديث yt-dlp';
      });
    }
  }

  // ── App auto-update UI ──────────────────────────────────────────────────
  // Reflects whatever state the main process reports into the Settings section
  // and the big top banner. Called both on a live push and when opening Settings.
  function applyAppUpdateState(s) {
    if (!s) return;
    const curEl = document.getElementById('appupdate-current');
    const statusEl = document.getElementById('appupdate-status');
    const installBtn = document.getElementById('appupdate-install-btn');
    if (curEl && s.current) curEl.textContent = 'v' + s.current;
    const labels = {
      idle: '—',
      checking: 'جاري الفحص...',
      uptodate: 'أنت على آخر نسخة ✓',
      available: 'في تحديث جديد — بينزّل...',
      downloading: `بينزّل التحديث... ${s.progress || 0}%`,
      downloaded: `تحديث جاهز (v${s.version || ''}) — أعد التشغيل عشان يتثبّت`,
      // 'manual' = نسخة الماك: التحديث مش بيتثبّت لوحده، بيفتح صفحة التحميل.
      manual: `في نسخة أحدث (v${s.version || ''}) — نزّلها من صفحة الإصدارات`,
      error: 'تعذّر الفحص — جرّب تاني',
    };
    if (statusEl) statusEl.textContent = labels[s.status] || '—';
    const ready = s.status === 'downloaded' || s.status === 'manual';
    if (installBtn) {
      installBtn.style.display = ready ? '' : 'none';
      installBtn.textContent = s.status === 'manual' ? 'افتح صفحة التحميل' : 'أعد التشغيل وثبّت';
    }
    const banner = document.getElementById('appupdate-banner');
    if (banner) banner.style.display = ready ? 'flex' : 'none';
    const bannerBtn = document.getElementById('appupdate-banner-btn');
    if (bannerBtn && s.status === 'manual') bannerBtn.textContent = 'افتح صفحة التحميل';
  }

  async function refreshAppUpdateSection() {
    if (!window.electronAPI?.app?.updateState) return;
    const section = document.getElementById('appupdate-section');
    if (section) section.style.display = '';
    try { applyAppUpdateState(await window.electronAPI.app.updateState()); } catch (e) { /* ignore */ }
  }

  function bindAppUpdateButtons() {
    if (!window.electronAPI?.app) return;
    // Live status pushed from the main process (download progress, ready, etc.).
    if (window.electronAPI.app.onUpdateStatus) {
      window.electronAPI.app.onUpdateStatus((s) => applyAppUpdateState(s));
    }
    const checkBtn = document.getElementById('appupdate-check-btn');
    if (checkBtn) {
      checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true; checkBtn.textContent = 'جاري الفحص...';
        try {
          const r = await window.electronAPI.app.checkForUpdate();
          if (r && r.supported === false) toast('التحديث التلقائي مش متاح في النسخة دي', 'info');
          else if (r && r.error) toast('تعذّر الفحص — اتأكد من النت', 'error');
          else if (r && r.manual && r.latest && r.latest !== r.current) toast(`في نسخة أحدث v${r.latest} — نزّلها من صفحة الإصدارات`, 'success');
          else if (r && r.latest && r.latest !== r.current) toast(`في تحديث جديد v${r.latest} — بينزّل دلوقتي`, 'success');
          else toast('أنت على آخر نسخة ✓', 'success');
        } catch (e) { toast('تعذّر الفحص — اتأكد من النت', 'error'); }
        checkBtn.disabled = false; checkBtn.textContent = 'فحص التحديثات';
      });
    }
    const installBtn = document.getElementById('appupdate-install-btn');
    if (installBtn) installBtn.addEventListener('click', () => window.electronAPI.app.installUpdate());
    const bannerBtn = document.getElementById('appupdate-banner-btn');
    if (bannerBtn) bannerBtn.addEventListener('click', () => window.electronAPI.app.installUpdate());
    const bannerLater = document.getElementById('appupdate-banner-later');
    if (bannerLater) bannerLater.addEventListener('click', () => {
      const b = document.getElementById('appupdate-banner'); if (b) b.style.display = 'none';
    });
    // On open: if an update already downloaded silently before the window loaded,
    // show the banner right away so the user notices "في تحديث" أول ما يفتح.
    if (window.electronAPI.app.updateState) {
      window.electronAPI.app.updateState().then(applyAppUpdateState).catch(() => {});
    }
  }

  async function refreshFacebookLoginStatus() {
    if (!window.electronAPI?.facebook) return;
    const statusEl = document.getElementById('fb-login-status');
    const loginBtn = document.getElementById('fb-login-btn');
    const logoutBtn = document.getElementById('fb-logout-btn');
    if (!statusEl) return;
    try {
      const { loggedIn, cookiesFile } = await window.electronAPI.facebook.status();
      if (loggedIn) {
        statusEl.textContent = 'مسجل دخول Facebook ✓';
        if (loginBtn) loginBtn.textContent = 'إعادة تسجيل دخول';
        if (logoutBtn) logoutBtn.style.display = '';
      } else if (cookiesFile) {
        statusEl.textContent = 'كوكيز مستوردة ✓ — جاهز للبحث';
        if (loginBtn) loginBtn.textContent = 'تسجيل دخول Facebook';
        if (logoutBtn) logoutBtn.style.display = '';
      } else {
        statusEl.textContent = 'مش مسجل دخول';
        if (loginBtn) loginBtn.textContent = 'تسجيل دخول Facebook';
        if (logoutBtn) logoutBtn.style.display = 'none';
      }
    } catch (e) { /* ignore */ }
  }

  async function refreshTiktokLoginStatus() {
    if (!window.electronAPI?.tiktok) return;
    const statusEl = document.getElementById('tiktok-login-status');
    const loginBtn = document.getElementById('tiktok-login-btn');
    const logoutBtn = document.getElementById('tiktok-logout-btn');
    if (!statusEl) return;
    try {
      const { loggedIn, cookiesFile } = await window.electronAPI.tiktok.status();
      if (loggedIn) {
        statusEl.textContent = 'مسجل دخول TikTok ✓';
        if (loginBtn) loginBtn.textContent = 'إعادة تسجيل دخول';
        if (logoutBtn) logoutBtn.style.display = '';
      } else if (cookiesFile) {
        statusEl.textContent = 'كوكيز مستوردة ✓ — جاهز للبحث';
        if (loginBtn) loginBtn.textContent = 'تسجيل دخول TikTok';
        if (logoutBtn) logoutBtn.style.display = '';
      } else {
        statusEl.textContent = 'مش مسجل دخول (البحث بيشتغل برضه)';
        if (loginBtn) loginBtn.textContent = 'تسجيل دخول TikTok';
        if (logoutBtn) logoutBtn.style.display = 'none';
      }
    } catch (e) { /* ignore */ }
  }

  function bindCookieImportButtons() {
    function wireImport(btnId, platform, onDone) {
      const btn = document.getElementById(btnId);
      if (!btn || !window.electronAPI?.cookies) return;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = '...';
        try {
          const r = await window.electronAPI.cookies.import(platform);
          if (r?.success) {
            toast('تم استيراد الكوكيز ✓', 'success');
            if (onDone) onDone();
          } else if (!r?.cancelled) {
            toast(r?.error || 'فشل الاستيراد', 'error');
          }
        } catch (e) {
          toast(e?.message || 'فشل الاستيراد', 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = original;
        }
      });
    }
    wireImport('ig-import-btn', 'instagram', refreshInstagramLoginStatus);
    wireImport('fb-import-btn', 'facebook', refreshFacebookLoginStatus);
    wireImport('tiktok-import-btn', 'tiktok', refreshTiktokLoginStatus);
  }

  function bindFacebookLoginButtons() {
    const loginBtn = document.getElementById('fb-login-btn');
    const logoutBtn = document.getElementById('fb-logout-btn');
    if (loginBtn) {
      loginBtn.addEventListener('click', async () => {
        if (!window.electronAPI?.facebook) return;
        loginBtn.disabled = true;
        loginBtn.textContent = 'جاري الفتح...';
        try {
          const res = await window.electronAPI.facebook.login();
          if (res?.success) toast('تم تسجيل الدخول بنجاح', 'success');
          else toast('لم يتم تسجيل الدخول', 'warning');
        } catch (e) {
          toast(e?.message || 'خطأ في فتح نافذة تسجيل الدخول', 'error');
        } finally {
          loginBtn.disabled = false;
          refreshFacebookLoginStatus();
        }
      });
    }
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        if (!window.electronAPI?.facebook) return;
        if (!confirm('تسجيل خروج Facebook؟')) return;
        await window.electronAPI.facebook.logout();
        toast('تم تسجيل الخروج', 'info');
        refreshFacebookLoginStatus();
      });
    }
  }

  function bindTiktokLoginButtons() {
    const loginBtn = document.getElementById('tiktok-login-btn');
    const logoutBtn = document.getElementById('tiktok-logout-btn');
    const autoBtn = document.getElementById('tiktok-autobrowser-btn');
    if (autoBtn) {
      autoBtn.addEventListener('click', async () => {
        if (!window.electronAPI?.tiktok?.cookiesFromBrowser) return;
        autoBtn.disabled = true;
        const original = autoBtn.textContent;
        autoBtn.textContent = 'بيسحب من المتصفح...';
        try {
          const r = await window.electronAPI.tiktok.cookiesFromBrowser();
          if (r?.success) {
            toast(`اتسحب الدخول من ${r.browser} ✓ — جاهز للبحث`, 'success', 6000);
          } else if (r?.hint === 'app-bound' || /DPAPI|decrypt/i.test(r?.error || '')) {
            toast('Chrome/Edge بيشفّر الكوكيز ومينفعش نقراها تلقائي. الحل: «تسجيل دخول TikTok» يدوي مرة (بالباسورد أو QR)، أو استخدم Firefox، أو «استيراد كوكيز». بس جرّب تبحث الأول — غالباً مش محتاج تسجيل أصلاً.', 'warning', 12000);
          } else {
            toast(r?.error || 'مقدرناش نسحب الدخول. جرّب تبحث من غير تسجيل', 'error', 8000);
          }
        } catch (e) {
          toast(e?.message || 'فشل السحب من المتصفح', 'error');
        } finally {
          autoBtn.disabled = false;
          autoBtn.textContent = original;
          refreshTiktokLoginStatus();
        }
      });
    }
    if (loginBtn) {
      loginBtn.addEventListener('click', async () => {
        if (!window.electronAPI?.tiktok) return;
        loginBtn.disabled = true;
        loginBtn.textContent = 'جاري الفتح...';
        try {
          const res = await window.electronAPI.tiktok.login();
          if (res?.success) toast('تم تسجيل الدخول بنجاح', 'success');
          else toast('لم يتم تسجيل الدخول', 'warning');
        } catch (e) {
          toast(e?.message || 'خطأ في فتح نافذة تسجيل الدخول', 'error');
        } finally {
          loginBtn.disabled = false;
          refreshTiktokLoginStatus();
        }
      });
    }
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        if (!window.electronAPI?.tiktok) return;
        if (!confirm('تسجيل خروج TikTok؟')) return;
        await window.electronAPI.tiktok.logout();
        toast('تم تسجيل الخروج', 'info');
        refreshTiktokLoginStatus();
      });
    }
  }


  // ─── Batch download (paste many links → one folder) ──────────────────
  // Whatever the server reports as its own download folder. This used to be
  // a hard-coded personal path, which is simply wrong on anyone else machine
  // (and not even a valid absolute path off Windows). A user who wants a
  // different folder sets it in Settings and it is remembered.
  function batchDefaultDir() {
    return state.env.defaultOutputDir || '';
  }

  function parseBatchLinks(text) {
    return (text || '').split(/[\s,;\n]+/).map((s) => s.trim()).filter(isValidUrl);
  }

  function bindBatchModal() {
    const modal = document.getElementById('batch-modal');
    const openBtn = document.getElementById('batch-btn');
    const closeBtn = document.getElementById('batch-close');
    const linksEl = document.getElementById('batch-links');
    const folderEl = document.getElementById('batch-folder');
    const subfolderEl = document.getElementById('batch-subfolder');
    const countHint = document.getElementById('batch-count-hint');
    const pasteBtn = document.getElementById('batch-paste');
    const dlBtn = document.getElementById('batch-download');
    if (!modal || !openBtn) return;

    const updateCount = () => {
      const n = parseBatchLinks(linksEl?.value).length;
      if (countHint) countHint.textContent = `${n} رابط صالح`;
    };
    const close = () => modal.classList.add('hidden');
    const open = () => {
      if (folderEl && !folderEl.value.trim()) {
        let last = '';
        try { last = localStorage.getItem('mediagrab_batch_dir') || ''; } catch {}
        folderEl.value = last || batchDefaultDir();
      }
      updateCount();
      modal.classList.remove('hidden');
      linksEl?.focus();
    };

    openBtn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    if (linksEl) linksEl.addEventListener('input', updateCount);

    if (pasteBtn) pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && linksEl) {
          linksEl.value = (linksEl.value.trim() ? linksEl.value.trim() + '\n' : '') + text.trim();
          updateCount();
        }
      } catch {
        toast('مقدرناش نقرا الحافظة. الصق يدوي بـ Ctrl+V', 'warning');
      }
    });

    if (dlBtn) dlBtn.addEventListener('click', async () => {
      const urls = parseBatchLinks(linksEl?.value);
      if (!urls.length) return toast('مفيش روابط صالحة. الصق روابط الأول', 'warning');
      const dir = (folderEl?.value || '').trim() || batchDefaultDir();
      try { localStorage.setItem('mediagrab_batch_dir', dir); } catch {}

      // Subfolder: use the typed product name, or auto-number (1, 2, 3…) when blank.
      let sub = (subfolderEl?.value || '').trim();
      if (!sub) {
        try {
          const r = await apiCall('/next-subfolder', { outputDir: dir, prefix: '' });
          sub = r?.name || '';
        } catch (e) {
          toast('متعرفناش نرقّم المجلد تلقائي: ' + (e?.message || 'خطأ'), 'warning');
        }
      }

      const items = urls.map((u) => ({ id: undefined, url: u, title: u, platform: detectPlatform(u) || state.platform }));
      toast(`تحميل ${urls.length} رابط في ${sub ? dir + (state.env.sep || '\\') + sub : dir}`, 'info');
      startBatchDownload(items, { outputDir: dir, subfolder: sub });
      close();
      if (subfolderEl) subfolderEl.value = '';
    });
  }


  function bindInstagramLoginButtons() {
    const loginBtn = document.getElementById('ig-login-btn');
    const logoutBtn = document.getElementById('ig-logout-btn');
    if (loginBtn) {
      loginBtn.addEventListener('click', async () => {
        if (!window.electronAPI?.instagram) return;
        loginBtn.disabled = true;
        loginBtn.textContent = 'جاري الفتح...';
        try {
          const res = await window.electronAPI.instagram.login();
          if (res?.success) {
            toast('تم تسجيل الدخول بنجاح', 'success');
          } else {
            toast('لم يتم تسجيل الدخول', 'warning');
          }
        } catch (e) {
          toast(e?.message || 'خطأ في فتح نافذة تسجيل الدخول', 'error');
        } finally {
          loginBtn.disabled = false;
          refreshInstagramLoginStatus();
        }
      });
    }
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        if (!window.electronAPI?.instagram) return;
        if (!confirm('تسجيل خروج Instagram؟')) return;
        await window.electronAPI.instagram.logout();
        toast('تم تسجيل الخروج', 'info');
        refreshInstagramLoginStatus();
      });
    }
  }


  // ─── UI helpers ─────────────────────────────────────
  function showLoading(show) { dom.loading.classList.toggle('hidden', !show); }

  function toast(message, type = 'info', duration = 4000, actions = []) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icons = { success: '✓', error: '✕', warning: '!', info: 'i' };

    const main = document.createElement('div');
    main.className = 'toast-main';
    main.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-msg">${escapeHtml(message)}</span>`;
    el.appendChild(main);

    if (actions && actions.length) {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'toast-actions';
      for (const a of actions) {
        const btn = document.createElement('button');
        btn.className = 'toast-action';
        btn.textContent = a.label;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          try { a.onClick(); } catch (err) { console.error(err); }
          // Don't auto-dismiss — user might want both buttons.
        });
        actionsEl.appendChild(btn);
      }
      el.appendChild(actionsEl);
    }

    dom.toastContainer.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-out');
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  // Open file — prefer Electron's shell.openPath (Unicode-safe). Falls back
  // to the legacy server endpoint if running outside Electron.
  function openDownloadedFile(filePath) {
    if (!filePath) return toast('مسار الملف غير معروف', 'warning');
    if (window.electronAPI?.shell) {
      window.electronAPI.shell.openPath(filePath).then((d) => {
        if (!d?.success) toast(d?.error || 'فشل فتح الملف', 'error');
      }).catch(() => toast('فشل فتح الملف', 'error'));
      return;
    }
    fetch('/api/open-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    }).then((r) => r.json()).then((d) => {
      if (!d.success) toast(d.error || 'فشل فتح الملف', 'error');
    }).catch(() => toast('فشل فتح الملف', 'error'));
  }

  function openDownloadedFolder(filePath) {
    if (!filePath) return toast('مسار الملف غير معروف', 'warning');
    if (window.electronAPI?.shell) {
      window.electronAPI.shell.showItemInFolder(filePath).then((d) => {
        if (!d?.success) toast(d?.error || 'فشل فتح المجلد', 'error');
      }).catch(() => toast('فشل فتح المجلد', 'error'));
      return;
    }
    fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    }).then((r) => r.json()).then((d) => {
      if (!d.success) toast(d.error || 'فشل فتح المجلد', 'error');
    }).catch(() => toast('فشل فتح المجلد', 'error'));
  }


  // ─── Settings ──────────────────────────────────────
  function loadSettings() {
    try {
      const saved = localStorage.getItem('mediagrab_settings');
      if (saved) Object.assign(state.settings, JSON.parse(saved));
    } catch { /* ignore */ }
    applySettingsToForm();
  }

  function saveSettings() {
    state.settings.outputDir = $('#output-dir').value.trim();
    state.settings.quality = $('#video-quality').value;
    state.settings.concurrent = parseInt($('#concurrent-downloads').value, 10);
    state.settings.filenameTemplate = $('#filename-template').value.trim() || '{title}';
    state.settings.autoDetect = $('#auto-detect-platform').checked;
    state.settings.autoDownload = $('#auto-download').checked;
    state.settings.skipExisting = $('#skip-existing').checked;
    state.settings.organizeByAuthor = $('#organize-by-author').checked;
    state.settings.notifyOnComplete = $('#notify-on-complete').checked;
    state.settings.speedLimitKBps = Math.max(0, parseInt($('#speed-limit').value, 10) || 0);
    state.settings.downloadSubs = $('#download-subs').checked;
    state.settings.cookiesFile = $('#cookies-file').value.trim();
    state.settings.customArgs = $('#custom-args').value.trim();
    localStorage.setItem('mediagrab_settings', JSON.stringify(state.settings));
    dom.settingsModal.classList.add('hidden');
    toast('تم حفظ الإعدادات', 'success');
    // Request notification permission if enabled
    if (state.settings.notifyOnComplete && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function resetSettings() {
    state.settings = {
      outputDir: '', quality: 'best', concurrent: 3,
      filenameTemplate: '{title}', autoDetect: true, autoDownload: false,
      skipExisting: true, organizeByAuthor: false, notifyOnComplete: true,
    };
    applySettingsToForm();
    toast('تمت إعادة الإعدادات الافتراضية', 'info');
  }

  function applySettingsToForm() {
    $('#output-dir').value = state.settings.outputDir;
    $('#video-quality').value = state.settings.quality;
    $('#concurrent-downloads').value = state.settings.concurrent;
    $('#filename-template').value = state.settings.filenameTemplate;
    $('#auto-detect-platform').checked = state.settings.autoDetect;
    $('#auto-download').checked = state.settings.autoDownload;
    if ($('#skip-existing'))      $('#skip-existing').checked      = state.settings.skipExisting;
    if ($('#organize-by-author')) $('#organize-by-author').checked = state.settings.organizeByAuthor;
    if ($('#notify-on-complete')) $('#notify-on-complete').checked = state.settings.notifyOnComplete;
    if ($('#speed-limit')) $('#speed-limit').value = state.settings.speedLimitKBps || 0;
    if ($('#download-subs')) $('#download-subs').checked = state.settings.downloadSubs;
    if ($('#cookies-file')) $('#cookies-file').value = state.settings.cookiesFile || '';
    if ($('#custom-args')) $('#custom-args').value = state.settings.customArgs || '';
  }


  // ─── Events ─────────────────────────────────────────
  function initEvents() {
    $$('.platform-tab').forEach((tab) => {
      tab.addEventListener('click', () => switchPlatform(tab.dataset.platform));
    });

    dom.goBtn.addEventListener('click', go);
    dom.mainInput.addEventListener('input', updateGoButton);
    dom.mainInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
    });

    dom.pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return toast('الحافظة فاضية', 'warning');
        dom.mainInput.value = text.trim();
        updateGoButton();
        dom.mainInput.focus();
      } catch {
        toast('مقدرناش نقرا الحافظة — الزق بإيدك', 'warning');
      }
    });

    if (dom.openHomeBtn) {
      dom.openHomeBtn.addEventListener('click', () => openPopup(state.platform));
    }

    if (dom.subfolderInput) {
      dom.subfolderInput.addEventListener('input', updateFolderUI);
    }

    if (dom.stopAllBtn) {
      dom.stopAllBtn.addEventListener('click', async () => {
        const active = [...state.queue.values()].filter((q) => q.status === 'downloading' || q.status === 'queued');
        if (!active.length) return toast('مفيش تحميلات شغّالة', 'info');
        if (!confirm(`توقف ${active.length} تحميل شغّال؟`)) return;
        try {
          const r = await apiCall('/cancel-all', null, 'POST');
          toast(`وقّفنا ${r.cancelled || 0} تحميل`, 'warning');
        } catch (err) {
          toast('مقدرناش نوقف: ' + err.message, 'error');
        }
      });
    }

    if (dom.clearCompletedBtn) {
      dom.clearCompletedBtn.addEventListener('click', clearCompletedDownloads);
    }

    // ── Settings ──
    dom.settingsBtn.addEventListener('click', () => {
      applySettingsToForm();
      refreshYtdlpSection();
      refreshAppUpdateSection();
      dom.settingsModal.classList.remove('hidden');
    });
    dom.settingsClose.addEventListener('click', () => dom.settingsModal.classList.add('hidden'));
    dom.settingsSave.addEventListener('click', () => { saveSettings(); updateFolderUI(); });
    dom.settingsReset.addEventListener('click', resetSettings);
    dom.settingsModal.addEventListener('click', (e) => {
      if (e.target === dom.settingsModal) dom.settingsModal.classList.add('hidden');
    });

    // ── Stats ──
    if (dom.statsBtn) dom.statsBtn.addEventListener('click', openStats);
    if (dom.statsClose) dom.statsClose.addEventListener('click', () => dom.statsModal.classList.add('hidden'));
    if (dom.statsModal) {
      dom.statsModal.addEventListener('click', (e) => {
        if (e.target === dom.statsModal) dom.statsModal.classList.add('hidden');
      });
    }

    // ── Product notes ──
    if (dom.notesBtn) dom.notesBtn.addEventListener('click', openNotes);
    if (dom.notesClose) dom.notesClose.addEventListener('click', () => dom.notesModal.classList.add('hidden'));
    if (dom.notesModal) {
      dom.notesModal.addEventListener('click', (e) => {
        if (e.target === dom.notesModal) dom.notesModal.classList.add('hidden');
      });
    }
    if (dom.notesAddBtn) dom.notesAddBtn.addEventListener('click', addNote);
    if (dom.notesInput) {
      dom.notesInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addNote(); }
      });
    }
    if (dom.notesClearDone) dom.notesClearDone.addEventListener('click', () => {
      const list = loadNotes();
      if (!list.some((n) => n.done)) return toast('مفيش منتجات متعلّم عليها', 'info');
      if (!confirm('تمسح كل المنتجات اللي اتحمّلت من القايمة؟')) return;
      saveNotes(list.filter((n) => !n.done));
      renderNotes();
    });
    if (dom.notesClearAll) dom.notesClearAll.addEventListener('click', () => {
      if (!loadNotes().length) return;
      if (!confirm('تمسح قايمة المنتجات كلها؟')) return;
      saveNotes([]);
      renderNotes();
    });

    bindReverseImageSearch();

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      for (const m of $$('.modal-overlay')) m.classList.add('hidden');
    });
  }

  /* ─── Reverse image search ────────────────────────────────────────────────
   * Paste a product screenshot → Google Lens opens in the real browser, where
   * the product's English name can be read and searched back here. */
  function bindReverseImageSearch() {
    async function search(blob) {
      if (!(window.electronAPI && window.electronAPI.image)) {
        return toast('البحث بالصورة في تطبيق سطح المكتب بس', 'warning');
      }
      if (!blob || !blob.size) return toast('مفيش صورة. انسخ صورة المنتج الأول', 'warning');
      toast('بنرفع الصورة ونفتح جوجل في المتصفح…', 'info', 8000);
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const r = await window.electronAPI.image.reverseSearch(bytes, blob.type || 'image/png');
        if (r && r.success) {
          toast('فتحنا نتيجة جوجل في المتصفح — هتلاقي اسم المنتج بالانجليزي، انسخه وابحث بيه فوق', 'success', 7000);
        } else {
          toast('فشل البحث بالصورة: ' + ((r && r.error) || 'خطأ غير معروف'), 'error');
        }
      } catch {
        toast('مقدرناش نقرا الصورة من الحافظة', 'error');
      }
    }

    document.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          const blob = it.getAsFile();
          if (blob) { e.preventDefault(); search(blob); return; }
        }
      }
      // No image → let the normal text paste go through untouched.
    });

    if (!dom.imgSearchBtn) return;
    dom.imgSearchBtn.addEventListener('click', async () => {
      if (!(navigator.clipboard && navigator.clipboard.read)) {
        return toast('انسخ صورة المنتج وبعدين اضغط Ctrl+V', 'info');
      }
      try {
        for (const it of await navigator.clipboard.read()) {
          const type = it.types.find((t) => t.startsWith('image/'));
          if (type) { search(await it.getType(type)); return; }
        }
        toast('مفيش صورة في الحافظة. انسخ صورة المنتج (أو استخدم Ctrl+V)', 'warning');
      } catch {
        toast('انسخ صورة المنتج وبعدين اضغط Ctrl+V في أي مكان', 'info');
      }
    });
  }

  // ─── Utils ──────────────────────────────────────────
  function generateId() {
    return 'dl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return String(str || '').replace(/[^a-z0-9_-]/gi, '');
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.substring(0, n - 1) + '…' : s;
  }

  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '';
    seconds = Math.round(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatNumber(num) {
    if (!num) return '0';
    num = parseInt(num, 10);
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return num.toLocaleString();
  }


  function bindAdLibrary() {
    const btn = document.getElementById('adlib-open-btn');
    if (!btn) return;
    const open = () => {
      if (!window.electronAPI?.facebook?.openAdLibrary) {
        toast('مكتبة الإعلانات متاحة في تطبيق سطح المكتب بس', 'warning');
        return;
      }
      const base = (state.settings.outputDir || '').trim() || batchDefaultDir();
      window.electronAPI.facebook.openAdLibrary({
        query:        (document.getElementById('adlib-query')?.value || '').trim(),
        country:       document.getElementById('adlib-country')?.value || 'EG',
        activeStatus:  document.getElementById('adlib-status')?.value || 'active',
        mediaType:     document.getElementById('adlib-media')?.value || 'all',
        lang:          document.getElementById('adlib-lang')?.value || '',
        minDays:       parseInt(document.getElementById('adlib-duration')?.value || '0', 10) || 0,
        base,
      });
      toast('فتحنا مكتبة الإعلانات — الأزرار بتظهر على كل إعلان', 'info', 5000);
    };
    btn.addEventListener('click', open);
    const q = document.getElementById('adlib-query');
    if (q) q.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    // Quick keyword chips fill the search box (one click = ready to open).
    const chips = document.getElementById('adlib-chips');
    if (chips && q) {
      chips.addEventListener('click', (e) => {
        const c = e.target.closest('.adlib-chip');
        if (!c) return;
        q.value = c.textContent.trim();
        q.focus();
      });
    }
  }

  // Ask the server what OS it's running on before anything renders a path or
  // picks a default folder.
  async function loadEnv() {
    try {
      const env = await apiCall('/env', null, 'GET');
      if (env && env.platform) Object.assign(state.env, env);
    } catch { /* keep the defaults */ }
    // Placeholders are examples, and a Windows example on a Mac is a wrong hint.
    const batchFolder = document.getElementById('batch-folder');
    if (batchFolder) batchFolder.placeholder = batchDefaultDir();
    const cookiesFile = document.getElementById('cookies-file');
    if (cookiesFile && state.env.home) {
      cookiesFile.placeholder = 'مثال: ' + state.env.home + (state.env.sep || '\\') + 'cookies.txt';
    }
    updateFolderUI();
  }


  // ─── Init ───────────────────────────────────────────
  function init() {
    loadSettings();
    loadEnv();
    initSocket();
    initEvents();
    bindEmbedDownloads();
    bindInstagramLoginButtons();
    bindFacebookLoginButtons();
    bindTiktokLoginButtons();
    bindAdLibrary();
    bindBatchModal();
    bindCookieImportButtons();
    bindYtdlpButtons();
    bindAppUpdateButtons();
    switchPlatform('tiktok');

    // The real app version in the header badge, so it never goes stale.
    if (window.electronAPI && window.electronAPI.app && window.electronAPI.app.version) {
      window.electronAPI.app.version().then((v) => {
        const el = document.getElementById('version-badge');
        if (el && v) el.textContent = 'v' + v;
      }).catch(() => {});
    }

    setTimeout(checkInterrupted, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
