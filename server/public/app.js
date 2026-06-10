/**
 * MediaGrab — Client
 * Real-time downloader UI with proper batch IDs, settings wiring, and reconnect.
 */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────
  const state = {
    platform: 'tiktok',
    results: [],            // full unfiltered results
    filteredResults: [],    // after sort+filter (what's rendered)
    selected: new Set(),    // indexes into filteredResults
    queue: new Map(),
    filters: {
      sortBy: 'views_desc', // الافتراضي الجديد: الأكثر مشاهدة
      duration: 'all',
      views: 'all',
      search: '',
    },
    view: 'grid', // 'grid' | 'list'
    pagination: {
      page: 1,
      // 0 = show all on one page
      size: parseInt(localStorage.getItem('mediagrab_page_size'), 10) || 50,
    },
    context: null, // { name, type: 'channel' | 'search' | 'single' }
    downloadedIds: { tiktok: new Set(), youtube: new Set(), instagram: new Set(), facebook: new Set() },
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
    urlInput: $('#url-input'),
    pasteBtn: $('#paste-btn'),
    importUrlsBtn: $('#import-urls-btn'),
    importUrlsFile: $('#import-urls-file'),
    infoBtn: $('#info-btn'),
    downloadBtn: $('#download-btn'),
    searchInput: $('#search-input'),
    searchBtn: $('#search-btn'),
    imgSearchBtn: $('#img-search-btn'),
    searchSection: $('#search-section'),
    countBtn: $('#count-btn'),
    countResult: $('#count-result'),
    resultsSection: $('#results-section'),
    resultsGrid: $('#results-grid'),
    resultCount: $('#result-count'),
    paginationTop: $('#pagination-top'),
    paginationBottom: $('#pagination-bottom'),
    statsBar: $('#stats-bar'),
    sortBy: $('#sort-by'),
    filterDuration: $('#filter-duration'),
    filterViews: $('#filter-views'),
    filterSearch: $('#filter-search'),
    stopAllBtn: $('#stop-all-btn'),
    previewModal: $('#preview-modal'),
    previewBody: $('#preview-body'),
    previewTitle: $('#preview-title'),
    previewClose: $('#preview-close'),
    previewDownload: $('#preview-download'),
    previewOpenOriginal: $('#preview-open-original'),
    exportResultsBtn: $('#export-results-btn'),
    clearResultsBtn: $('#clear-results-btn'),
    historyBtn: $('#history-btn'),
    historyModal: $('#history-modal'),
    historyClose: $('#history-close'),
    historyBody: $('#history-body'),
    historyClear: $('#history-clear'),
    statsBtn: $('#stats-btn'),
    statsModal: $('#stats-modal'),
    statsClose: $('#stats-close'),
    statsBody: $('#stats-body'),
    bookmarksBtn: $('#bookmarks-btn'),
    bookmarksModal: $('#bookmarks-modal'),
    bookmarksClose: $('#bookmarks-close'),
    bookmarksBody: $('#bookmarks-body'),
    bookmarkCurrentBtn: $('#bookmark-current-btn'),
    viewGridBtn: $('#view-grid-btn'),
    viewListBtn: $('#view-list-btn'),
    subfolderInput: $('#subfolder-input'),
    folderPath: $('#folder-path'),
    quickChips: $('#quick-chips'),
    selectedCount: $('#selected-count'),
    selectAllBtn: $('#select-all-btn'),
    deselectAllBtn: $('#deselect-all-btn'),
    downloadSelectedBtn: $('#download-selected-btn'),
    downloadAllBtn: $('#download-all-btn'),
    scheduleAllBtn: $('#schedule-all-btn'),
    queueSection: $('#queue-section'),
    queueList: $('#queue-list'),
    queueCount: $('#queue-count'),
    queueEmpty: $('#queue-empty'),
    clearCompletedBtn: $('#clear-completed-btn'),
    loading: $('#loading'),
    connectionStatus: $('#connection-status'),
    settingsBtn: $('#settings-btn'),
    settingsModal: $('#settings-modal'),
    settingsClose: $('#settings-close'),
    settingsSave: $('#settings-save'),
    settingsReset: $('#settings-reset'),
    dropZone: $('#drop-zone'),
    dropHint: $('#drop-hint'),
    platformDetected: $('#platform-detected'),
    toastContainer: $('#toast-container'),
  };

  // ─── Platform detection ─────────────────────────────
  const platformPatterns = {
    tiktok: /tiktok\.com|vm\.tiktok/i,
    youtube: /youtube\.com|youtu\.be/i,
    instagram: /instagram\.com|instagr\.am/i,
    facebook: /facebook\.com|fb\.watch|fb\.com/i,
  };

  const platformNames = {
    tiktok: 'TikTok',
    youtube: 'YouTube',
    instagram: 'Instagram',
    facebook: 'Facebook',
  };

  function isValidUrl(s) {
    if (!s) return false;
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch { return false; }
  }

  function looksLikeChannel(url) {
    if (!url) return false;
    // TikTok user page (no /video/)
    if (/tiktok\.com\/@[^/]+\/?(\?.*)?$/i.test(url) && !/\/video\//i.test(url)) return true;
    // YouTube channel/playlist
    if (/youtube\.com\/(@|c\/|channel\/|user\/)/i.test(url)) return true;
    if (/youtube\.com\/playlist\?list=/i.test(url)) return true;
    // Instagram profile
    if (/instagram\.com\/[^/?]+\/?(\?.*)?$/i.test(url) && !/\/p\/|\/reel\/|\/tv\//i.test(url)) return true;
    return false;
  }

  // ─── Socket.IO ──────────────────────────────────────
  let socket;

  function initSocket() {
    socket = io({ transports: ['websocket', 'polling'], reconnection: true });

    socket.on('connect', async () => {
      dom.connectionStatus.classList.add('connected');
      dom.connectionStatus.querySelector('.status-text').textContent = 'Connected';
      // Load known downloaded IDs so cards show the "downloaded" badge
      refreshDownloadedIds();
      // Rebuild queue from server for items we don't know about (after refresh)
      try {
        const r = await fetch('/api/active');
        const data = await r.json();
        for (const item of data.active || []) {
          if (!state.queue.has(item.id)) {
            addQueueItem({
              id: item.id, title: item.title, thumbnail: '',
              url: '', status: item.status, progress: 0,
            });
          }
        }
      } catch { /* ignore */ }
    });

    socket.on('disconnect', () => {
      dom.connectionStatus.classList.remove('connected');
      dom.connectionStatus.querySelector('.status-text').textContent = 'Reconnecting…';
    });

    socket.on('connect_error', () => {
      dom.connectionStatus.classList.remove('connected');
      dom.connectionStatus.querySelector('.status-text').textContent = 'Connection Error';
    });

    socket.on('download:progress', (data) => {
      // Auto-create queue item if missing (server-initiated batch)
      if (!state.queue.has(data.id)) {
        addQueueItem({
          id: data.id, title: data.title || 'Video', thumbnail: '',
          url: '', status: 'downloading', progress: data.progress || 0,
        });
      }
      updateQueueItem(data.id, {
        progress: data.progress, speed: data.speed, eta: data.eta,
        status: 'downloading',
        downloaded: data.downloaded, total: data.total,
      });
      const card = state.cardByQueueId?.get(data.id);
      if (card) setCardDownloadState(card, 'downloading', data.progress || 0, data.speed);
    });

    socket.on('download:complete', (data) => {
      updateQueueItem(data.id, { progress: 100, status: 'completed', filePath: data.filePath });
      const card = state.cardByQueueId?.get(data.id);
      if (card) {
        setCardDownloadState(card, 'completed', 100, '', { filePath: data.filePath, skipped: data.skipped });
        state.cardByQueueId.delete(data.id);
      }
      const msg = data.dedupe
        ? `سبق تنزيله: ${truncate(data.title || 'Video', 45)}`
        : data.skipped
          ? `تم تخطّى (موجود): ${truncate(data.title || 'Video', 50)}`
          : `تم: ${truncate(data.title || 'Video', 50)}`;
      // refresh downloaded-ids cache so future renders mark them
      if (data.id && state.downloadedIds && state.lastResultsPlatform === state.platform) {
        // best-effort
      }
      const actions = data.filePath ? [
        { label: '▶ فتح الملف',   onClick: () => openDownloadedFile(data.filePath) },
        { label: '📁 المجلد',     onClick: () => openDownloadedFolder(data.filePath) },
      ] : [];
      toast(msg, 'success', 8000, actions);
      onTaskFinished(data.id, data.skipped ? 'skipped' : 'completed');
    });

    socket.on('download:error', (data) => {
      updateQueueItem(data.id, { status: 'error', error: data.error });
      toast(`فشل: ${truncate(data.error || 'خطأ غير معروف', 80)}`, 'error');
      onTaskFinished(data.id, 'error');
      const card = state.cardByQueueId?.get(data.id);
      if (card) {
        setCardDownloadState(card, 'error', 0, '', { error: data.error });
        state.cardByQueueId.delete(data.id);
      }
    });

    socket.on('download:queued', (data) => {
      if (!state.queue.has(data.id)) {
        addQueueItem({
          id: data.id, title: data.title || 'Video', thumbnail: '',
          url: '', status: 'queued', progress: 0,
        });
      } else {
        updateQueueItem(data.id, { status: 'queued', progress: 0 });
      }
    });

    socket.on('download:cancelled', (data) => {
      updateQueueItem(data.id, { status: 'cancelled' });
    });

    // Streaming listing events
    let _streamRenderPending = false;
    socket.on('listing:item', (data) => {
      if (currentStreamSession && data.session !== currentStreamSession) return;
      const item = normalizeItem(data.item);
      state.results.push(item);
      dom.resultsSection.classList.remove('hidden');

      // Throttle full re-renders to keep things smooth during fast streams.
      // The current page is re-rendered (so new items appear if they fall on
      // this page, and pagination updates).
      if (!_streamRenderPending) {
        _streamRenderPending = true;
        requestAnimationFrame(() => {
          _streamRenderPending = false;
          renderResults();
          const totalShown = state.filteredResults.length;
          const totalAll = state.results.length;
          dom.resultCount.textContent = totalShown === totalAll
            ? `${totalAll} عنصر (يتم الجلب…)`
            : `${totalShown} من ${totalAll} (يتم الجلب…)`;
        });
      }
    });

    socket.on('listing:complete', (data) => {
      if (currentStreamSession && data.session !== currentStreamSession) return;
      currentStreamSession = null;
      showLoading(false);
      // Track context (channel/playlist) so downloads land in the right folder
      state.context = inferContextFromUrl(dom.urlInput.value.trim(), 'channel', state.results);
      renderResults();
      saveResultsToStorage();
      autoBookmarkIfChannel();
      toast(`جلب ${data.count} فيديو`, 'success');
    });

    socket.on('listing:error', (data) => {
      if (currentStreamSession && data.session !== currentStreamSession) return;
      currentStreamSession = null;
      showLoading(false);
      toast(data.error || 'فشل جلب القائمة', 'error');
    });
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

  async function fetchInfo(url) {
    if (!isValidUrl(url)) return toast('رابط غير صالح', 'warning');

    // Channels/playlists → use streaming endpoint so items show up incrementally.
    if (looksLikeChannel(url) && socket?.connected) {
      return fetchInfoStreaming(url);
    }

    showLoading(true);
    try {
      const data = await apiCall('/info', { url, platform: state.platform });
      handleInfoResult(data);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      showLoading(false);
    }
  }

  // Convert any tiktokcdn / cdninstagram / fbcdn URL into a proxied one so
  // the browser doesn't send Referer: http://localhost:3456 (which the CDN
  // rejects with 403).
  function proxyMedia(url) {
    if (!url || typeof url !== 'string') return url;
    if (/tiktokcdn|tiktokv|muscdn|byteoversea|ttwstatic|cdninstagram|fbcdn/i.test(url)) {
      return '/api/proxy/media?u=' + encodeURIComponent(url);
    }
    return url;
  }

  // Thumbnail retry — TikTok CDN occasionally rate-limits a request the
  // first time, especially after a tab switch. Up to 3 retries with backoff.
  window.thumbRetry = function (img) {
    const tries = parseInt(img.dataset.retry || '0', 10) + 1;
    img.dataset.retry = tries;
    if (tries > 3) { img.style.display = 'none'; return; }
    const base = img.dataset.thumb;
    if (!base) { img.style.display = 'none'; return; }
    const sep = base.includes('?') ? '&' : '?';
    setTimeout(() => { img.src = base + sep + 'r=' + tries + '_' + Date.now(); }, 400 * tries);
  };

  // After a tab switch back, re-prompt the lazy loader to fetch images that
  // are currently in view but never loaded — IntersectionObserver doesn't
  // always re-fire on visibility change.
  function nudgeVisibleThumbnails() {
    if (!dom.resultsGrid) return;
    const imgs = dom.resultsGrid.querySelectorAll('img[data-thumb]');
    imgs.forEach((img) => {
      if (!img.complete || img.naturalWidth === 0) {
        // Force a fresh load
        const src = img.dataset.thumb;
        if (src) img.src = src + (src.includes('?') ? '&' : '?') + 'n=' + Date.now();
      }
    });
  }

  
  let currentStreamSession = null;

  async function fetchInfoStreaming(url) {
    showLoading(true);
    state.results = [];
    state.selected.clear();
    state.pagination.page = 1;
    renderResults();

    try {
      const data = await apiCall('/info-stream', {
        url, platform: state.platform, socketId: socket.id,
      });
      currentStreamSession = data.session;
      // Wait for listing:complete or :error (handled in initSocket).
    } catch (err) {
      showLoading(false);
      toast(err.message, 'error');
    }
  }

  // Single-item download (URL input or single card).
  // Always use a fresh queue ID so re-clicking the same card creates a new
  // queue entry instead of overwriting the previous one.
  // Map queue-id → originating card element, so socket progress events can
  // update the card the user clicked.
  if (!state.cardByQueueId) state.cardByQueueId = new Map();

  async function startDownload(url, info, sourceCard) {
    if (!isValidUrl(url)) return toast('رابط غير صالح', 'warning');
    const id = generateId();
    if (sourceCard) {
      state.cardByQueueId.set(id, sourceCard);
      setCardDownloadState(sourceCard, 'queued', 0);
    } else {
      // Only show in the bottom Queue panel when there's no originating card
      // (e.g. paste-URL → Download button). Card-initiated downloads have
      // their own per-card progress UI, so duplicating them would be noise.
      addQueueItem({
        id,
        title: info?.title || url,
        thumbnail: info?.thumbnail || '',
        url, status: 'queued', progress: 0,
      });
    }
    try {
      await apiCall('/download', {
        url, platform: state.platform, id,
        title: info?.title || '',
        author: info?.author || '',
        videoId: info?.id || null,
        quality: info?.quality || state.settings.quality,
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
        downloadUrl: info?.downloadUrl || null,
        hdDownloadUrl: info?.hdDownloadUrl || null,
      });
    } catch (err) {
      updateQueueItem(id, { status: 'error', error: err.message });
      toast(err.message, 'error');
    }
  }

  // Batch download — pre-create queue items with IDs we control,
  // then send those exact IDs to the server so progress events match.
  async function startBatchDownload(items, opts = {}) {
    if (!items.length) return;

    // Disk-space sanity check for big batches
    if (items.length >= 5) {
      try {
        const r = await fetch('/api/disk-space');
        const ds = await r.json();
        if (ds.supported) {
          const platform = state.platform;
          const bytesPerSec = platform === 'youtube' ? 250 * 1024 : 150 * 1024;
          const totalDuration = items.reduce((s, it) => s + (it.duration || 0), 0);
          const estimated = totalDuration * bytesPerSec;
          if (estimated > ds.freeBytes * 0.9) {
            const need = (estimated / 1024 / 1024 / 1024).toFixed(2);
            const free = (ds.freeBytes / 1024 / 1024 / 1024).toFixed(2);
            const ok = confirm(`⚠️ المساحة الحرة قليلة!\n\nمتوقع: ${need} GB\nمتاح: ${free} GB\n\nتكمّل التحميل؟`);
            if (!ok) return;
          }
        }
      } catch { /* skip warning if API fails */ }
    }

    // Always assign fresh queue IDs so a re-download of the same set creates
    // new queue rows instead of overwriting the previous ones.
    const enriched = items.map((item) => ({
      id: generateId(),
      url: item.url,
      title: item.title || 'Video',
      thumbnail: item.thumbnail || '',
      downloadUrl: item.downloadUrl || null,
      hdDownloadUrl: item.hdDownloadUrl || null,
      author: item.author || '',
      platform: item.platform || state.platform,
      kind: item.kind || null,
    }));

    for (const it of enriched) {
      addQueueItem({
        id: it.id, title: it.title, thumbnail: it.thumbnail,
        url: it.url, status: 'queued', progress: 0,
      });
    }

    // Track this batch for notification
    state.activeBatch = { ids: new Set(enriched.map((e) => e.id)), total: enriched.length, finished: 0, errors: 0, skipped: 0 };

    try {
      await apiCall('/download', {
        type: 'batch',
        platform: state.platform,
        url: enriched[0]?.url || '',
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
      toast(`بدء ${enriched.length} تحميل`, 'info');
    } catch (err) {
      enriched.forEach((it) => updateQueueItem(it.id, { status: 'error', error: err.message }));
      toast(err.message, 'error');
    }
  }

  async function searchVideos(query) {
    showLoading(true);
    state.pagination.page = 1;
    try {
      // count: 0 → unlimited. Server keeps paginating each platform's source
      // until it's exhausted (TikWM cursor end, yt-dlp playlist end, etc.).
      const payload = { query, platform: state.platform, count: 0 };
      // Instagram + Facebook: detect mode from prefix. @user → account, otherwise hashtag.
      if (state.platform === 'instagram' || state.platform === 'facebook') {
        const trimmed = query.trim();
        payload.mode = trimmed.startsWith('@') ? 'account' : 'hashtag';
        payload.query = trimmed.replace(/^[@#]/, '');
      }

      // Instagram keyword search: open the REAL instagram.com search in a live
      // window (mobile UA so Reels show) with a download button on every reel.
      if (state.platform === 'instagram' && payload.mode === 'hashtag' && window.electronAPI?.instagram?.openSearchWindow) {
        const base = (state.settings.outputDir || '').trim() || BATCH_DEFAULT_DIR;
        window.electronAPI.instagram.openSearchWindow(payload.query, base);
        toast('فتحنا Instagram — دوس «تحميل» على أي ريل', 'info', 5000);
        return;
      }

      // Facebook keyword search: open Facebook's live video search in a window
      // (mobile UA) with a download button on every video.
      if (state.platform === 'facebook' && payload.mode === 'hashtag' && window.electronAPI?.facebook?.openSearchWindow) {
        const base = (state.settings.outputDir || '').trim() || BATCH_DEFAULT_DIR;
        window.electronAPI.facebook.openSearchWindow(payload.query, base);
        toast('فتحنا Facebook — دوس «تحميل» على أي فيديو', 'info', 5000);
        return;
      }

      // TikTok: open the REAL tiktok.com search in a window with download
      // buttons on every video — exact same results as the site, and nothing
      // gets pulled into the in-app grid.
      if (state.platform === 'tiktok' && window.electronAPI?.tiktok?.openSearchWindow) {
        const base = (state.settings.outputDir || '').trim() || BATCH_DEFAULT_DIR;
        window.electronAPI.tiktok.openSearchWindow(payload.query, base);
        toast('فتحنا تيك توك — دوس «تحميل» على أي فيديو', 'info', 5000);
        return;
      }

      const data = await apiCall('/search', payload);
      handleSearchResult(data);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      showLoading(false);
    }
  }

  // Reels keyword search using Electron's network stack. Tries fbsearch/clips
  // first, then topsearch → tag sections as fallbacks.
  async function instagramReelsSearchViaElectron(keyword, count) {
    const q = encodeURIComponent(keyword);
    const slug = keyword.replace(/\s+/g, '').toLowerCase();
    const endpoints = [
      // 1. Stable old web search (returns hashtags/users mix — we follow up
      //    on the top hashtag to fetch its reels)
      `https://www.instagram.com/web/search/topsearch/?context=blended&query=${q}`,
      // 2. Reels-focused mobile API
      `https://www.instagram.com/api/v1/fbsearch/clips/?query=${q}`,
      `https://www.instagram.com/api/v1/fbsearch/topsearch/?query=${q}&context=blended`,
      // 3. Tag-content direct (if query maps cleanly to a hashtag)
      `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(slug)}`,
      `https://i.instagram.com/api/v1/tags/${encodeURIComponent(slug)}/sections/`,
    ];
    const fetch1 = window.electronAPI.instagram.apiFetch;
    let lastErr = '';
    for (const url of endpoints) {
      const r = await fetch1(url);
      if (!r?.success) { lastErr = r?.error || 'fetch failed'; continue; }
      const d = r.data || {};
      const clips = [];
      // fbsearch/clips
      for (const mod of d.clips_serp_modules || []) {
        for (const c of mod.clips || []) if (c.media) clips.push(c.media);
      }
      // topsearch — if it returns a hashtag, follow up with its sections
      if (!clips.length && d.hashtags?.length) {
        const top = d.hashtags[0]?.hashtag?.name;
        if (top) {
          const r2 = await fetch1(`https://i.instagram.com/api/v1/tags/${encodeURIComponent(top)}/sections/`);
          if (r2?.success) {
            for (const sec of r2.data?.sections || []) {
              for (const m of sec.layout_content?.medias || []) if (m.media) clips.push(m.media);
            }
          }
        }
      }
      // tag sections (direct or web_info)
      const tagRoot = d.data || d;
      for (const sec of tagRoot.sections || []) {
        for (const m of sec.layout_content?.medias || []) if (m.media) clips.push(m.media);
      }
      for (const bucket of ['recent', 'top']) {
        for (const sec of tagRoot[bucket]?.sections || []) {
          for (const m of sec.layout_content?.medias || []) if (m.media) clips.push(m.media);
        }
      }
      if (clips.length) {
        return {
          platform: 'instagram',
          mode: 'reels-search',
          results: clips.slice(0, count).map((m) => {
            const owner = m.owner || m.user || {};
            const shortcode = m.code || m.shortcode || m.pk || m.id;
            const videoVer = (m.video_versions && m.video_versions[0]) || {};
            return {
              id: m.pk || m.id || shortcode,
              title: m.caption?.text?.substring(0, 200) || `Reel ${shortcode}`,
              url: shortcode ? `https://www.instagram.com/reel/${shortcode}/` : '',
              duration: Math.round(m.video_duration || 0),
              thumbnail: (m.image_versions2?.candidates?.[0]?.url) || m.thumbnail_url || '',
              uploader: owner.username || '',
              author: owner.full_name || owner.username || '',
              playCount: m.play_count || m.view_count || 0,
              platform: 'instagram',
              downloadUrl: videoVer.url || null,
            };
          }),
        };
      }
    }
    throw new Error('Instagram رفض كل الـ endpoints: ' + lastErr.slice(0, 100));
  }

  async function cancelDownload(id) {
    try {
      await apiCall(`/cancel/${id}`, null, 'POST');
      updateQueueItem(id, { status: 'cancelled' });
    } catch {
      toast('فشل إلغاء التحميل', 'error');
    }
  }

  // ─── Result handling ────────────────────────────────
  function handleInfoResult(data) {
    let items = [];
    if (data.type === 'channel' || data.type === 'playlist') {
      items = data.data?.videos || data.videos || [];
    } else if (data.data) {
      items = [data.data];
    }
    if (!items.length) return toast('لا توجد نتائج', 'warning');

    state.results = items.map(normalizeItem);
    state.selected.clear();
    state.pagination.page = 1;
    // Track context so downloads land in a folder named after the channel/playlist.
    state.context = inferContextFromUrl(dom.urlInput.value.trim(), data.type, items);
    renderResults();
    saveResultsToStorage();
    autoBookmarkIfChannel();

    if (state.settings.autoDownload && state.results.length === 1) {
      startDownload(state.results[0].url || dom.urlInput.value.trim(), state.results[0]);
    }
  }

  function handleSearchResult(data) {
    const rawItems = data.results || data.videos || [];
    if (!rawItems.length) return toast('لا توجد نتائج بحث', 'warning');
    // De-dupe by id — paginated TikTok cursors can overlap and Instagram's
    // grid sometimes renders the same reel in the "trending" + "regular"
    // sections, so both paths can leak duplicates into the result list.
    const seen = new Set();
    const items = [];
    for (const it of rawItems) {
      const key = String(it.id ?? it.url ?? '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
    // Ignore late responses from a prior platform — by the time this fired
    // the user may have switched tabs and started another search.
    const respPlatform = data.platform || state.platform;
    if (respPlatform !== state.platform) {
      // Stash the results in case the user switches back to that platform.
      if (!state.resultsByPlatform) state.resultsByPlatform = {};
      state.resultsByPlatform[respPlatform] = items.map(normalizeItem);
      return;
    }
    state.results = items.map(normalizeItem);
    if (!state.resultsByPlatform) state.resultsByPlatform = {};
    state.resultsByPlatform[state.platform] = state.results;
    state.selected.clear();
    state.pagination.page = 1;
    state.context = {
      type: 'search',
      name: 'بحث-' + (dom.searchInput.value.trim() || 'unknown') + '-' + state.platform,
      platform: state.platform,
    };
    renderResults();
    saveResultsToStorage();
  }

  // Build a folder-friendly context name from the URL + result shape.
  function inferContextFromUrl(url, type, items) {
    try {
      const u = new URL(url);
      // TikTok user
      const tikUser = url.match(/tiktok\.com\/@([^/?#]+)/i)?.[1];
      if (tikUser && type !== 'single') return { type: 'channel', name: '@' + tikUser, platform: 'tiktok' };
      // YouTube channel/playlist
      const ytChan = url.match(/youtube\.com\/(?:@|c\/|channel\/|user\/)([^/?#]+)/i)?.[1];
      if (ytChan) return { type: 'channel', name: ytChan, platform: 'youtube' };
      const ytList = u.searchParams.get('list');
      if (ytList) return { type: 'playlist', name: 'playlist-' + ytList.slice(0, 12), platform: 'youtube' };
      // Instagram profile
      const igUser = url.match(/instagram\.com\/([^/?#]+)/i)?.[1];
      if (igUser && type !== 'single') return { type: 'channel', name: igUser, platform: 'instagram' };
      // Single video — fall back to author from first item if available
      if (items && items[0]) {
        const author = items[0].author?.unique_id || items[0].author?.nickname || items[0].uploader || items[0].author;
        if (author && typeof author === 'string') return { type: 'channel', name: author, platform: state.platform };
      }
      return { type: 'single', name: '', platform: state.platform };
    } catch {
      return { type: 'single', name: '', platform: state.platform };
    }
  }

  function normalizeItem(item) {
    const author = typeof item.author === 'string'
      ? item.author
      : (item.author?.nickname || item.author?.unique_id || item.uploader || item.channel || '');
    return {
      id: item.id || generateId(),
      title: item.title || item.desc || 'Untitled',
      thumbnail: item.thumbnail || item.cover || item.thumbnailUrl || '',
      duration: item.duration || 0,
      author,
      views: item.views || item.viewCount || item.playCount || item.play_count || 0,
      url: item.url || item.webpage_url || '',
      platform: item.platform || state.platform,
      downloadUrl: item.downloadUrl || item.play || null,
      hdDownloadUrl: item.hdDownloadUrl || item.hdplay || null,
    };
  }

  // ─── Persistence (localStorage) ─────────────────────
  const RESULTS_STORAGE_KEY = 'mediagrab_last_results';
  const FILTERS_STORAGE_KEY = 'mediagrab_filters';
  const RESULTS_TTL_MS = 24 * 60 * 60 * 1000; // 24h

  function saveFiltersPreference() {
    try { localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(state.filters)); } catch {}
  }

  function loadFiltersPreference() {
    try {
      const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
      if (raw) Object.assign(state.filters, JSON.parse(raw));
    } catch {}
  }

  // Save to: (1) server file at data/last_results.json, (2) localStorage as backup.
  function saveResultsToStorage() {
    if (!state.results.length) return;
    const data = {
      url: dom.urlInput.value.trim(),
      platform: state.platform,
      results: state.results,
      filters: state.filters,
      savedAt: Date.now(),
    };

    // localStorage backup (synchronous, survives server restart)
    try {
      localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('localStorage save failed:', e.message);
    }

    // Persist to server file (async, survives browser cache wipe)
    fetch('/api/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      keepalive: true, // allow request to continue if page is unloading
    }).catch((e) => console.warn('Server-file save failed:', e.message));
  }

  async function loadResultsFromStorage() {
    let data = null;

    // Prefer server file (most authoritative across browsers/devices)
    try {
      const r = await fetch('/api/results');
      if (r.ok) {
        const d = await r.json();
        if (d && Array.isArray(d.results) && d.results.length > 0) data = d;
      }
    } catch { /* fall through to localStorage */ }

    // Fallback to localStorage
    if (!data) {
      try {
        const raw = localStorage.getItem(RESULTS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.results) && parsed.results.length > 0) {
            data = parsed;
          }
        }
      } catch { /* ignore */ }
    }

    if (!data) return;
    if (Date.now() - (data.savedAt || 0) > RESULTS_TTL_MS) {
      clearStoredResults();
      return;
    }

    if (data.url) dom.urlInput.value = data.url;
    if (data.platform) {
      state.platform = data.platform;
      switchPlatform(data.platform);
    }
    state.results = data.results;
    // Don't overwrite the user's preferred filters with whatever was saved
    // alongside an older result set — the preference is the source of truth.

    renderResults();
    const ageMin = Math.round((Date.now() - data.savedAt) / 60_000);
    toast(`تم استعادة ${state.results.length} فيديو من آخر جلسة (${ageMin} دقيقة مضت)`, 'info');
  }

  function clearStoredResults() {
    try { localStorage.removeItem(RESULTS_STORAGE_KEY); } catch {}
    fetch('/api/results', { method: 'DELETE' }).catch(() => {});
  }

  // Throttled variant — used during streaming so an early refresh keeps
  // the partial list. Saves at most every 1.5 seconds.
  let _saveTimer = null;
  function saveResultsThrottled() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      saveResultsToStorage();
    }, 1500);
  }

  // Save immediately when the user is about to leave the page (refresh, close).
  window.addEventListener('beforeunload', () => {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    saveResultsToStorage();
  });

  // ─── Filtering / Sorting / Stats ────────────────────
  function applyFiltersAndSort() {
    const f = state.filters;
    let list = state.results.slice();

    if (f.search) {
      const q = f.search.toLowerCase();
      list = list.filter((it) =>
        (it.title || '').toLowerCase().includes(q) ||
        (it.author || '').toLowerCase().includes(q)
      );
    }

    if (f.duration !== 'all') {
      list = list.filter((it) => {
        const d = it.duration || 0;
        if (f.duration === 'short')  return d > 0 && d < 30;
        if (f.duration === 'medium') return d >= 30 && d <= 60;
        if (f.duration === 'long')   return d > 60;
        return true;
      });
    }

    if (f.views !== 'all') {
      const thresholds = { '10k': 10_000, '100k': 100_000, '1m': 1_000_000, '10m': 10_000_000 };
      const min = thresholds[f.views] || 0;
      list = list.filter((it) => (it.views || 0) >= min);
    }

    switch (f.sortBy) {
      case 'views_desc':    list.sort((a, b) => (b.views || 0) - (a.views || 0)); break;
      case 'views_asc':     list.sort((a, b) => (a.views || 0) - (b.views || 0)); break;
      case 'duration_desc': list.sort((a, b) => (b.duration || 0) - (a.duration || 0)); break;
      case 'duration_asc':  list.sort((a, b) => (a.duration || 0) - (b.duration || 0)); break;
      case 'title_asc':     list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ar')); break;
      default: break;
    }

    state.filteredResults = list;
    state.selected.clear();
  }

  // Estimate ~150 KB/sec for TikTok HD; ~250 KB/sec for YouTube best
  function estimateSize(items) {
    const platform = state.platform;
    const bytesPerSec = platform === 'youtube' ? 250 * 1024 : 150 * 1024;
    let total = 0;
    let withDuration = 0;
    for (const it of items) {
      if (it.duration > 0) { total += it.duration * bytesPerSec; withDuration++; }
    }
    return { totalBytes: total, withDuration };
  }

  function fmtBytes(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function fmtSecondsTotal(seconds) {
    if (!seconds) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h} ساعة ${m} دقيقة`;
    if (m > 0) return `${m} دقيقة ${s} ثانية`;
    return `${s} ثانية`;
  }

  function renderStats() {
    if (!dom.statsBar) return;
    const items = state.filteredResults;
    if (!items.length) { dom.statsBar.innerHTML = ''; return; }
    const totalDuration = items.reduce((s, it) => s + (it.duration || 0), 0);
    const totalViews = items.reduce((s, it) => s + (it.views || 0), 0);
    const { totalBytes, withDuration } = estimateSize(items);
    const sizeNote = withDuration < items.length ? ' (تقدير لـ ' + withDuration + ')' : ' (تقديري)';

    dom.statsBar.innerHTML = `
      <div class="stat"><span class="stat-label">العدد</span><span class="stat-value">${items.length}</span></div>
      <div class="stat"><span class="stat-label">إجمالي المدة</span><span class="stat-value">${fmtSecondsTotal(totalDuration)}</span></div>
      <div class="stat"><span class="stat-label">الحجم</span><span class="stat-value">${fmtBytes(totalBytes)}${sizeNote}</span></div>
      <div class="stat"><span class="stat-label">إجمالي المشاهدات</span><span class="stat-value">${formatNumber(totalViews)}</span></div>
    `;
  }

  async function refreshDownloadedIds() {
    try {
      const r = await fetch('/api/downloaded-ids?platform=' + encodeURIComponent(state.platform));
      const data = await r.json();
      state.downloadedIds[state.platform] = new Set((data.ids || []).map(String));
    } catch {}
  }

  // ─── Render results ─────────────────────────────────
  function renderResults() {
    applyFiltersAndSort();
    dom.resultsSection.classList.remove('hidden');
    const totalShown = state.filteredResults.length;
    const totalAll = state.results.length;

    // Clamp current page after filter/sort changes
    const totalPages = pageCount();
    if (state.pagination.page > totalPages) state.pagination.page = totalPages || 1;

    const { from, to } = pageBounds();
    const slice = state.filteredResults.slice(from, to);

    dom.resultCount.textContent = totalShown === totalAll
      ? `${totalAll} عنصر`
      : `${totalShown} من ${totalAll}`;

    dom.resultsGrid.innerHTML = '';
    dom.resultsGrid.classList.toggle('list-view', state.view === 'list');
    slice.forEach((item, i) => {
      // pass the absolute index in filteredResults so selection mapping stays valid
      dom.resultsGrid.appendChild(createVideoCard(item, from + i));
    });

    renderPagination();
    renderStats();
    updateFolderUI();
    updateSelectionUI();
  }

  function pageCount() {
    const size = state.pagination.size;
    const total = state.filteredResults.length;
    if (!size || size <= 0) return 1; // all-on-one-page
    return Math.max(1, Math.ceil(total / size));
  }

  function pageBounds() {
    const size = state.pagination.size;
    const total = state.filteredResults.length;
    if (!size || size <= 0) return { from: 0, to: total };
    const page = state.pagination.page;
    const from = (page - 1) * size;
    const to = Math.min(from + size, total);
    return { from, to };
  }

  function goToPage(p) {
    const total = pageCount();
    state.pagination.page = Math.max(1, Math.min(total, p));
    renderResults();
    // Scroll to top of results when paginating
    try { dom.resultsSection?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
  }

  function setPageSize(sizeStr) {
    const size = sizeStr === 'all' ? 0 : Math.max(1, parseInt(sizeStr, 10) || 50);
    state.pagination.size = size;
    state.pagination.page = 1;
    try { localStorage.setItem('mediagrab_page_size', String(size)); } catch {}
    renderResults();
  }

  function renderPagination() {
    const renderInto = (container, includeSizePicker) => {
      if (!container) return;
      container.innerHTML = '';
      const total = state.filteredResults.length;
      const size = state.pagination.size;
      const pages = pageCount();
      const page = state.pagination.page;

      // Hide entirely if no items
      if (total === 0) return;

      // Page buttons (windowed: first, last, current ± 2, ellipses)
      const wantPages = pages > 1;
      if (wantPages) {
        const mkBtn = (label, p, opts = {}) => {
          const b = document.createElement('button');
          b.className = 'pg-btn' + (opts.active ? ' active' : '');
          b.textContent = label;
          if (opts.disabled) b.disabled = true;
          else b.addEventListener('click', () => goToPage(p));
          return b;
        };
        const mkEllipsis = () => {
          const s = document.createElement('span');
          s.className = 'pg-ellipsis';
          s.textContent = '…';
          return s;
        };

        container.appendChild(mkBtn('«', 1, { disabled: page === 1 }));
        container.appendChild(mkBtn('‹', page - 1, { disabled: page === 1 }));

        const window2 = 2;
        const pageNums = new Set([1, pages, page]);
        for (let d = 1; d <= window2; d++) {
          if (page - d >= 1) pageNums.add(page - d);
          if (page + d <= pages) pageNums.add(page + d);
        }
        const sorted = [...pageNums].sort((a, b) => a - b);
        let prev = 0;
        for (const n of sorted) {
          if (prev && n - prev > 1) container.appendChild(mkEllipsis());
          container.appendChild(mkBtn(String(n), n, { active: n === page }));
          prev = n;
        }

        container.appendChild(mkBtn('›', page + 1, { disabled: page === pages }));
        container.appendChild(mkBtn('»', pages, { disabled: page === pages }));
      }

      // Info text
      const info = document.createElement('span');
      info.className = 'pg-info';
      if (!size) {
        info.textContent = `الكل (${total})`;
      } else {
        const { from, to } = pageBounds();
        info.textContent = `${from + 1}–${to} من ${total}`;
      }
      container.appendChild(info);

      // Page-size selector (only on the top bar to avoid duplication)
      if (includeSizePicker) {
        const label = document.createElement('span');
        label.className = 'pg-size-label';
        label.textContent = 'لكل صفحة:';
        const sel = document.createElement('select');
        sel.className = 'pg-size';
        const opts = [25, 50, 100, 200, 500];
        for (const v of opts) {
          const o = document.createElement('option');
          o.value = String(v);
          o.textContent = String(v);
          if (v === size) o.selected = true;
          sel.appendChild(o);
        }
        const allOpt = document.createElement('option');
        allOpt.value = 'all';
        allOpt.textContent = 'الكل';
        if (!size) allOpt.selected = true;
        sel.appendChild(allOpt);
        sel.addEventListener('change', (e) => setPageSize(e.target.value));
        container.appendChild(label);
        container.appendChild(sel);
      }
    };

    renderInto(dom.paginationTop, true);
    renderInto(dom.paginationBottom, false);
  }

  // Suggest a subfolder name based on context, but only when the user hasn't
  // typed their own override.
  function updateFolderUI() {
    if (!dom.subfolderInput) return;
    const suggested = state.context?.name || '';
    // Only autofill if the input is empty OR it still matches a previous suggestion
    if (!dom.subfolderInput.value.trim() || dom.subfolderInput.dataset.auto === '1') {
      dom.subfolderInput.value = suggested;
      dom.subfolderInput.dataset.auto = '1';
    }
    if (dom.folderPath) {
      const base = state.settings.outputDir || 'C:\\Users\\ahmed\\Downloads\\MediaGrab';
      const sub = dom.subfolderInput.value.trim();
      dom.folderPath.textContent = sub ? `${base}\\${sub}\\` : `${base}\\`;
    }
  }

  function getCurrentSubfolder() {
    return (dom.subfolderInput?.value || '').trim();
  }

  function setView(v) {
    state.view = v;
    dom.viewGridBtn?.classList.toggle('active', v === 'grid');
    dom.viewListBtn?.classList.toggle('active', v === 'list');
    try { localStorage.setItem('mediagrab_view', v); } catch {}
    if (state.results.length) renderResults();
  }

  // Visually reflects download state on the originating result card.
  // status: 'queued' | 'downloading' | 'completed' | 'error'
  function setCardDownloadState(card, status, progress = 0, speed = '', extra = {}) {
    if (!card) return;
    card.classList.remove('dl-queued', 'dl-downloading', 'dl-completed', 'dl-error');
    card.classList.add('dl-' + status);

    let overlay = card.querySelector('.card-dl-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'card-dl-overlay';
      overlay.innerHTML = `
        <div class="card-dl-label"></div>
        <div class="card-dl-bar"><div class="card-dl-bar-fill"></div></div>
      `;
      const thumb = card.querySelector('.card-thumbnail');
      (thumb || card).appendChild(overlay);
    }
    const label = overlay.querySelector('.card-dl-label');
    const fill = overlay.querySelector('.card-dl-bar-fill');
    const dlBtn = card.querySelector('.card-dl-btn');

    if (status === 'queued') {
      label.textContent = 'في الطابور...';
      fill.style.width = '0%';
      if (dlBtn) { dlBtn.disabled = true; dlBtn.innerHTML = '⏳ بنحضّر'; }
    } else if (status === 'downloading') {
      const speedTxt = speed ? ` · ${speed}` : '';
      label.textContent = `${progress}%${speedTxt}`;
      fill.style.width = `${progress}%`;
      if (dlBtn) { dlBtn.disabled = true; dlBtn.innerHTML = `⬇ ${progress}%`; }
    } else if (status === 'completed') {
      const msg = extra.skipped ? '✓ موجود' : '✓ تم التنزيل';
      label.textContent = msg;
      fill.style.width = '100%';
      if (dlBtn) {
        dlBtn.disabled = false;
        dlBtn.innerHTML = '📁 افتح';
        // Replace the listener so a re-click opens the file, not re-downloads.
        const newBtn = dlBtn.cloneNode(true);
        dlBtn.parentNode.replaceChild(newBtn, dlBtn);
        newBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (extra.filePath) openDownloadedFile(extra.filePath);
        });
      }
      // Auto-fade the overlay after a couple of seconds so the card looks
      // clean again, but keep the green tint on the card itself.
      setTimeout(() => overlay.classList.add('fade-out'), 2500);
    } else if (status === 'error') {
      label.textContent = '✕ فشل: ' + (extra.error || '').slice(0, 40);
      fill.style.width = '0%';
      if (dlBtn) { dlBtn.disabled = false; dlBtn.innerHTML = '↻ إعادة'; }
    }
  }

  function createVideoCard(item, index) {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.index = index;
    const platformIcon = getPlatformSVG(item.platform);

    // Was this video downloaded before (any past session)?
    const platformIds = state.downloadedIds[item.platform] || state.downloadedIds[state.platform];
    const isDownloaded = platformIds && item.id && platformIds.has(String(item.id));
    if (isDownloaded) card.classList.add('was-downloaded');

    card.innerHTML = `
      ${isDownloaded ? '<div class="downloaded-badge" title="نزل قبل كده">✓ نزل</div>' : ''}
      <label class="card-checkbox">
        <input type="checkbox" data-index="${index}" ${state.selected.has(index) ? 'checked' : ''}>
      </label>
      <div class="card-thumbnail">
        ${item.thumbnail ? `<img src="${escapeHtml(proxyMedia(item.thumbnail))}" alt="" loading="lazy" data-thumb="${escapeHtml(proxyMedia(item.thumbnail))}" data-retry="0" onerror="thumbRetry(this)">` : ''}
        ${item.duration ? `<span class="card-duration">${formatDuration(item.duration)}</span>` : ''}
        <span class="card-platform-badge ${escapeAttr(item.platform)}">${platformIcon}</span>
      </div>
      <div class="card-body">
        <div class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="card-meta">
          ${item.author ? `<span>${escapeHtml(item.author)}</span>` : ''}
          ${item.views ? `<span>${formatNumber(item.views)} مشاهدة</span>` : ''}
        </div>
        <div class="card-actions">
          <button class="btn btn-secondary btn-sm card-info-btn" data-index="${index}" title="معلومات">ℹ</button>
          <button class="btn btn-secondary btn-sm card-audio-btn" data-index="${index}" title="تحميل صوت فقط (MP3)">🎵</button>
          <button class="btn btn-primary btn-sm card-dl-btn" data-index="${index}">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            تحميل
          </button>
        </div>
      </div>
    `;

    const cb = card.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', () => {
      if (cb.checked) { state.selected.add(index); card.classList.add('selected'); }
      else { state.selected.delete(index); card.classList.remove('selected'); }
      updateSelectionUI();
    });

    card.querySelector('.card-dl-btn').addEventListener('click', () => {
      const url = item.url || dom.urlInput.value.trim();
      startDownload(url, item, card);
    });

    // Audio-only (MP3) per-card download — overrides quality just for this task
    card.querySelector('.card-audio-btn').addEventListener('click', () => {
      const url = item.url || dom.urlInput.value.trim();
      startDownload(url, { ...item, quality: 'audio' }, card);
    });

    card.querySelector('.card-info-btn').addEventListener('click', () => {
      if (item.url) {
        dom.urlInput.value = item.url;
        fetchInfo(item.url);
      }
    });

    // Click thumbnail → open preview
    card.querySelector('.card-thumbnail').addEventListener('click', () => openPreview(item));

    // Right-click → context menu
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCardContextMenu(e.clientX, e.clientY, item);
    });

    return card;
  }

  // ─── Card context menu ──────────────────────────────
  function showCardContextMenu(x, y, item) {
    const menu = $('#card-context-menu');
    if (!menu) return;
    const url = item.url || '';
    const items = [
      { icon: '📋', label: 'نسخ الرابط',     run: () => { navigator.clipboard.writeText(url); toast('تم النسخ', 'success'); } },
      { icon: '▶',  label: 'معاينة',          run: () => openPreview(item) },
      { icon: '⬇',  label: 'تحميل (الجودة الافتراضية)', run: () => startDownload(url, item) },
      { icon: '🎵', label: 'تحميل صوت فقط',   run: () => startDownload(url, { ...item, quality: 'audio' }) },
      { icon: '🖼',  label: 'تحميل الصورة فقط', run: () => downloadThumbnail(item) },
      { icon: '⏱',  label: 'احفظ للوقت لاحق',   run: () => addToWatchLater(item) },
      'sep',
      { icon: '🌐', label: 'فتح في الموقع',   run: () => window.open(url, '_blank', 'noopener') },
    ];

    menu.innerHTML = '';
    for (const it of items) {
      if (it === 'sep') { menu.appendChild(document.createElement('hr')); continue; }
      const li = document.createElement('li');
      li.innerHTML = `<span class="ctx-icon">${it.icon}</span><span>${escapeHtml(it.label)}</span>`;
      if (it.danger) li.classList.add('danger');
      li.addEventListener('click', () => { it.run(); hideContextMenu(); });
      menu.appendChild(li);
    }
    menu.classList.remove('hidden');
    // Position, keeping it inside the viewport
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const left = Math.min(x, window.innerWidth - w - 8);
    const top  = Math.min(y, window.innerHeight - h - 8);
    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';
  }

  function hideContextMenu() {
    const menu = $('#card-context-menu');
    if (menu) menu.classList.add('hidden');
  }

  document.addEventListener('click', hideContextMenu);
  document.addEventListener('scroll', hideContextMenu, true);
  window.addEventListener('resize', hideContextMenu);

  async function addToWatchLater(item) {
    try {
      const r = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: item.url, title: item.title,
          thumbnail: item.thumbnail || item.cover,
          platform: item.platform || state.platform,
          downloadUrl: item.downloadUrl, hdDownloadUrl: item.hdDownloadUrl,
        }),
      });
      const d = await r.json();
      if (d.duplicate) toast('موجود بالفعل في القائمة', 'info');
      else toast('تم الحفظ في "للوقت لاحق"', 'success');
    } catch (e) { toast('فشل الحفظ', 'error'); }
  }

  function downloadThumbnail(item) {
    const url = item.thumbnail || item.cover;
    if (!url) return toast('لا توجد صورة لهذا الفيديو', 'warning');
    const a = document.createElement('a');
    a.href = url;
    a.download = sanitizeForFilename(item.title || 'thumbnail') + '.jpg';
    a.referrerPolicy = 'no-referrer';
    a.click();
  }

  function sanitizeForFilename(s) {
    return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 120);
  }

  function toCsv(items) {
    const cols = ['title', 'author', 'duration', 'views', 'platform', 'url', 'thumbnail'];
    const esc = (v) => {
      const s = String(v == null ? '' : v).replace(/"/g, '""');
      return /[,"\n\r]/.test(s) ? `"${s}"` : s;
    };
    const head = cols.join(',');
    const rows = items.map((it) => cols.map((c) => {
      if (c === 'author') return esc(typeof it.author === 'string' ? it.author : (it.author?.unique_id || it.author?.nickname || ''));
      return esc(it[c]);
    }).join(','));
    // BOM so Excel detects UTF-8
    return '﻿' + [head, ...rows].join('\r\n');
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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

  function showShortcutsHelp() {
    toast(`اختصارات: u=رابط · / =بحث · a=تحديد الكل · d=تحميل · h=السجل · s=إعدادات · x=إيقاف الكل · Esc=إغلاق`, 'info', 8000);
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

  // ─── History ────────────────────────────────────────
  async function openHistory() {
    if (!dom.historyModal) return;
    dom.historyBody.innerHTML = '<div class="history-empty">جاري التحميل...</div>';
    dom.historyModal.classList.remove('hidden');
    try {
      const r = await fetch('/api/history');
      const data = await r.json();
      renderHistory(data.history || []);
    } catch (err) {
      dom.historyBody.innerHTML = `<div class="history-empty">فشل التحميل: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderHistory(list) {
    if (!list.length) {
      dom.historyBody.innerHTML = '<div class="history-empty">لا يوجد سجل بعد</div>';
      return;
    }
    dom.historyBody.innerHTML = '';
    list.forEach((h) => {
      const ageMin = Math.round((Date.now() - (h.savedAt || 0)) / 60_000);
      const ageText = ageMin < 60 ? `${ageMin} دقيقة` : `${Math.round(ageMin / 60)} ساعة`;
      const el = document.createElement('div');
      el.className = 'history-item';
      el.innerHTML = `
        <div class="history-info">
          <div class="history-title">${escapeHtml(h.title || h.url)}</div>
          <div class="history-meta">
            <span class="history-platform ${escapeAttr(h.platform)}">${escapeHtml(h.platform || '')}</span>
            <span>${h.count || 0} فيديو</span>
            <span>${ageText} مضت</span>
          </div>
          <div class="history-url">${escapeHtml(h.url)}</div>
        </div>
        <div class="history-actions">
          <button class="btn btn-primary btn-sm history-open">فتح</button>
          <button class="icon-btn history-delete" title="حذف">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      `;
      el.querySelector('.history-open').addEventListener('click', () => {
        dom.urlInput.value = h.url;
        if (h.platform) switchPlatform(h.platform);
        dom.historyModal.classList.add('hidden');
        openSavedListing(h);
      });
      el.querySelector('.history-delete').addEventListener('click', async () => {
        if (h.savedKey) await fetch('/api/saved/' + encodeURIComponent(h.savedKey), { method: 'DELETE' });
        else await fetch('/api/history/' + encodeURIComponent(h.id), { method: 'DELETE' });
        el.remove();
      });
      dom.historyBody.appendChild(el);
    });
  }

  // Open a previously saved listing instantly (no yt-dlp refetch).
  async function openSavedListing(historyEntry) {
    if (!historyEntry?.savedKey) {
      // No saved file (older entry) — fall back to refetch.
      return fetchInfo(historyEntry.url);
    }
    showLoading(true);
    try {
      const r = await fetch('/api/saved/' + encodeURIComponent(historyEntry.savedKey));
      if (!r.ok) throw new Error('Saved listing not found');
      const data = await r.json();
      state.results = (data.results || []).map(normalizeItem);
      state.selected.clear();
      if (data.platform) state.platform = data.platform;
      renderResults();
      toast(`فُتح من السجل: ${state.results.length} فيديو`, 'success');
    } catch (err) {
      toast('فشل فتح من السجل، جاري الجلب من جديد...', 'warning');
      await fetchInfo(historyEntry.url);
    } finally {
      showLoading(false);
    }
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

  // ─── Bookmarks ──────────────────────────────────────
  async function openBookmarks() {
    if (!dom.bookmarksModal) return;
    dom.bookmarksBody.innerHTML = '<div class="history-empty">جاري التحميل...</div>';
    dom.bookmarksModal.classList.remove('hidden');
    try {
      const r = await fetch('/api/bookmarks');
      const data = await r.json();
      renderBookmarks(data.bookmarks || []);
    } catch (err) {
      dom.bookmarksBody.innerHTML = `<div class="history-empty">فشل: ${escapeHtml(err.message)}</div>`;
    }
  }

  let _bookmarksFilter = ''; // active tag filter

  function renderBookmarks(list) {
    if (!list.length) {
      dom.bookmarksBody.innerHTML = '<div class="history-empty">اضغط "★ حفظ" بعد جلب القائمة لإضافة قناة هنا</div>';
      return;
    }
    // Build tag chip bar
    const allTags = [...new Set(list.flatMap((b) => b.tags || []))].sort();
    let html = '';
    if (allTags.length) {
      html += '<div class="bm-tag-bar">';
      html += `<button class="chip ${!_bookmarksFilter ? 'chip-active' : ''}" data-tag="">الكل</button>`;
      for (const t of allTags) {
        html += `<button class="chip ${_bookmarksFilter === t ? 'chip-active' : ''}" data-tag="${escapeAttr(t)}">${escapeHtml(t)}</button>`;
      }
      html += '</div>';
    }
    dom.bookmarksBody.innerHTML = html;

    // Tag chip click
    dom.bookmarksBody.querySelectorAll('.bm-tag-bar .chip').forEach((chip) => {
      chip.addEventListener('click', () => { _bookmarksFilter = chip.dataset.tag; renderBookmarks(list); });
    });

    const filtered = _bookmarksFilter
      ? list.filter((b) => (b.tags || []).includes(_bookmarksFilter))
      : list;

    filtered.forEach((b) => {
      const el = document.createElement('div');
      el.className = 'history-item';
      const tagsHtml = (b.tags || []).map((t) => `<span class="bm-tag">${escapeHtml(t)}</span>`).join('');
      el.innerHTML = `
        <div class="history-info">
          <div class="history-title">${escapeHtml(b.title)}</div>
          <div class="history-meta">
            <span class="history-platform ${escapeAttr(b.platform)}">${escapeHtml(b.platform || '')}</span>
            <span class="bm-tags">${tagsHtml}</span>
          </div>
          <div class="history-url">${escapeHtml(b.url)}</div>
        </div>
        <div class="history-actions">
          <button class="btn btn-primary btn-sm bm-open">فتح</button>
          <button class="btn btn-secondary btn-sm bm-refresh" title="جلب الفيديوهات الجديدة فقط">↻ تحديث</button>
          <button class="btn btn-ghost btn-sm bm-edit-tags" title="تعديل التصنيفات">🏷</button>
          <button class="icon-btn bm-delete" title="حذف">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      `;
      el.querySelector('.bm-open').addEventListener('click', async () => {
        dom.urlInput.value = b.url;
        if (b.platform) switchPlatform(b.platform);
        dom.bookmarksModal.classList.add('hidden');
        // Prefer the saved listing if we have one for this URL
        try {
          const r = await fetch('/api/history');
          const hist = (await r.json()).history || [];
          const match = hist.find((h) => h.url === b.url && h.savedKey);
          if (match) return openSavedListing(match);
        } catch {}
        fetchInfo(b.url);
      });
      el.querySelector('.bm-refresh').addEventListener('click', () => {
        dom.urlInput.value = b.url;
        if (b.platform) switchPlatform(b.platform);
        dom.bookmarksModal.classList.add('hidden');
        refreshChannelNew(b);
      });
      el.querySelector('.bm-edit-tags').addEventListener('click', async () => {
        const current = (b.tags || []).join(', ');
        const next = prompt('التصنيفات (مفصولة بفاصلة):\nمثل: ملابس، رجالي، إعلانات', current);
        if (next === null) return;
        const tags = next.split(',').map((s) => s.trim()).filter(Boolean);
        try {
          await fetch('/api/bookmarks/' + encodeURIComponent(b.id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags }),
          });
          b.tags = tags;
          renderBookmarks(list); // re-render to show new tag chips
          toast('تم تحديث التصنيفات', 'success');
        } catch { toast('فشل التحديث', 'error'); }
      });
      el.querySelector('.bm-delete').addEventListener('click', async () => {
        await fetch('/api/bookmarks/' + encodeURIComponent(b.id), { method: 'DELETE' });
        el.remove();
      });
      dom.bookmarksBody.appendChild(el);
    });
  }

  // Refresh: fetch the channel listing and only show items we don't already
  // have saved for this URL (the "new since last visit" list).
  async function refreshChannelNew(bookmark) {
    showLoading(true);
    try {
      // Step 1: load previously-saved IDs for this URL
      let priorIds = new Set();
      try {
        const r = await fetch('/api/history');
        const hist = (await r.json()).history || [];
        const match = hist.find((h) => h.url === bookmark.url && h.savedKey);
        if (match) {
          const r2 = await fetch('/api/saved/' + encodeURIComponent(match.savedKey));
          if (r2.ok) {
            const data = await r2.json();
            priorIds = new Set((data.results || []).map((it) => String(it.id)).filter(Boolean));
          }
        }
      } catch {}

      toast(`جاري جلب الجديد فقط... (آخر زيارة: ${priorIds.size} فيديو)`, 'info', 5000);

      // Step 2: fetch fresh listing using the streaming endpoint
      // We'll filter on listing:item by replacing renderResults logic temporarily.
      // Simpler: fetch via /api/info (non-streaming) since we're filtering after.
      const data = await apiCall('/info', { url: bookmark.url, platform: bookmark.platform || state.platform });
      let items = [];
      if (data.type === 'channel' || data.type === 'playlist') items = data.data?.videos || data.videos || [];
      else if (data.data) items = [data.data];

      const fresh = items.filter((it) => it.id && !priorIds.has(String(it.id)));

      if (!fresh.length) {
        toast('لا يوجد جديد منذ آخر زيارة', 'info');
        // Still show the full list so the user can browse
        state.results = items.map(normalizeItem);
      } else {
        state.results = fresh.map(normalizeItem);
        toast(`فيه ${fresh.length} فيديو جديد منذ آخر زيارة`, 'success');
      }

      state.context = inferContextFromUrl(bookmark.url, 'channel', state.results);
      state.selected.clear();
      renderResults();
      saveResultsToStorage(); // overwrites with the merged latest set on next full open
    } catch (err) {
      toast('فشل التحديث: ' + err.message, 'error');
    } finally {
      showLoading(false);
    }
  }

  async function bookmarkCurrent(silent = false) {
    const url = dom.urlInput.value.trim();
    if (!isValidUrl(url)) {
      if (!silent) toast('لا يوجد رابط للحفظ', 'warning');
      return;
    }
    try {
      const r = await fetch('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          platform: state.platform,
          title: state.results[0]?.author?.unique_id || state.results[0]?.author || url,
        }),
      });
      const data = await r.json();
      if (data.success && !silent) toast('تمت إضافة القناة للمفضلة', 'success');
      else if (!data.success && !silent) toast(data.error || 'فشل الحفظ', 'error');
    } catch (e) {
      if (!silent) toast('فشل الحفظ', 'error');
    }
  }

  // Auto-bookmark a channel/playlist URL (called silently after listing).
  function autoBookmarkIfChannel() {
    const url = dom.urlInput.value.trim();
    if (looksLikeChannel(url) && state.results.length > 1) {
      bookmarkCurrent(true);
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

  // ─── Preview ────────────────────────────────────────
  let previewCurrent = null;

  async function openPreview(item) {
    if (!dom.previewModal) return;
    previewCurrent = item;
    dom.previewTitle.textContent = item.title || 'معاينة';
    dom.previewBody.innerHTML = '';
    dom.previewModal.classList.remove('hidden');

    const platform = (item.platform || state.platform || '').toLowerCase();

    if (platform === 'youtube') {
      const id = extractYoutubeId(item.url || '');
      if (id) {
        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${id}?autoplay=1`;
        iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
        iframe.allowFullscreen = true;
        dom.previewBody.appendChild(iframe);
      } else {
        dom.previewBody.innerHTML = '<div class="preview-msg">تعذر استخراج معرّف فيديو YouTube</div>';
      }
      return;
    }

    // Prefer the standard `play` URL for preview: it reliably supports range
    // requests (seeking), while `hdplay` is often missing/unseekable. Download
    // still uses HD elsewhere — this only affects the in-app preview player.
    let playUrl = item.downloadUrl || item.hdDownloadUrl;

    // TikTok lazy-resolve: listing returned items without download URLs to be fast.
    if (platform === 'tiktok' && !playUrl && item.url) {
      dom.previewBody.innerHTML = '<div class="preview-msg">جاري جلب الفيديو...</div>';
      try {
        const r = await fetch('/api/tiktok-resolve?url=' + encodeURIComponent(item.url));
        const data = await r.json();
        if (r.ok && (data.play || data.hdplay)) {
          item.downloadUrl   = data.play;
          item.hdDownloadUrl = data.hdplay;
          playUrl = data.play || data.hdplay;
          // Update the cached results so the next click is instant
          const cached = state.results.find((r) => r === item || r.url === item.url);
          if (cached) {
            cached.downloadUrl = data.play;
            cached.hdDownloadUrl = data.hdplay;
          }
          saveResultsToStorage();
        } else {
          dom.previewBody.innerHTML = `<div class="preview-msg">${escapeHtml(data.error || 'تعذر جلب الفيديو')}</div>`;
          return;
        }
      } catch (err) {
        dom.previewBody.innerHTML = `<div class="preview-msg">فشل جلب الفيديو: ${escapeHtml(err.message)}</div>`;
        return;
      }
      // Don't set innerHTML to '' if we have a video to inject below
      dom.previewBody.innerHTML = '';
    }

    if (playUrl) {
      const video = document.createElement('video');
      video.src = proxyMedia(playUrl);
      video.controls = true;
      video.autoplay = true;
      // Fit by HEIGHT, not width: a portrait video at width:100% grows taller
      // than the modal and its controls bar gets clipped. Constraining both
      // dimensions (auto size, preserve aspect) keeps the whole player — controls
      // included — visible for any aspect ratio.
      video.style.maxWidth = '100%';
      video.style.maxHeight = '68vh';
      video.style.width = 'auto';
      video.style.height = 'auto';
      dom.previewBody.appendChild(video);
    } else if (item.thumbnail) {
      // No streamable video URL (Instagram scraping gives thumbnails only).
      // Show the thumbnail at least so the modal isn't a blank black box.
      dom.previewBody.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; gap:12px; padding:16px;">
          <img src="${escapeHtml(proxyMedia(item.thumbnail))}"
               style="max-width:100%; max-height:60vh; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.5);">
          <div class="preview-msg" style="margin:0;">المعاينة المباشرة غير متاحة — اضغط "تحميل" لجلب الفيديو الفعلي.</div>
        </div>
      `;
    } else {
      dom.previewBody.innerHTML = '<div class="preview-msg">لا يوجد رابط معاينة لهذه المنصة.</div>';
    }
  }

  function closePreview() {
    if (!dom.previewModal) return;
    dom.previewModal.classList.add('hidden');
    // Stop playback by clearing the body
    dom.previewBody.innerHTML = '';
    previewCurrent = null;
  }

  function extractYoutubeId(url) {
    if (!url) return null;
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  function updateSelectionUI() {
    const count = state.selected.size;
    dom.selectedCount.textContent = count;
    dom.downloadSelectedBtn.disabled = count === 0;
    // Sync DOM checkboxes with state.selected (used by quick chips).
    // Each card carries data-index = its absolute index in filteredResults,
    // so this stays correct across paginated views.
    $$('.video-card').forEach((card) => {
      const cb = card.querySelector('input[type="checkbox"]');
      if (!cb) return;
      const i = parseInt(card.dataset.index, 10);
      const isSel = state.selected.has(i);
      if (cb.checked !== isSel) cb.checked = isSel;
      card.classList.toggle('selected', isSel);
    });
  }

  // Quick chip selection — picks items from filteredResults by criteria
  function applyQuickChip(action) {
    if (!state.filteredResults.length) return toast('لا توجد نتائج', 'warning');
    const list = state.filteredResults;
    state.selected.clear();

    let picked = [];
    switch (action) {
      case 'top10':
        picked = list.slice().sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 10);
        break;
      case 'top25':
        picked = list.slice().sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 25);
        break;
      case 'views_1m':
        picked = list.filter((it) => (it.views || 0) >= 1_000_000);
        break;
      case 'views_100k':
        picked = list.filter((it) => (it.views || 0) >= 100_000);
        break;
      case 'views_10k':
        picked = list.filter((it) => (it.views || 0) >= 10_000);
        break;
      case 'short':
        picked = list.filter((it) => (it.duration || 0) > 0 && (it.duration || 0) < 30);
        break;
      case 'long':
        picked = list.filter((it) => (it.duration || 0) > 60);
        break;
      case 'clear':
        updateSelectionUI();
        toast('تم إلغاء التحديد', 'info');
        return;
    }

    // Map picked items to their indices in filteredResults
    for (const it of picked) {
      const idx = list.indexOf(it);
      if (idx >= 0) state.selected.add(idx);
    }
    updateSelectionUI();
    toast(`تم تحديد ${picked.length} فيديو`, 'success');
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
    Object.assign(item, updates);
    const el = dom.queueList.querySelector(`[data-queue-id="${cssEscape(id)}"]`);
    if (el) updateQueueItemDOM(el, item);
    updateQueueCount();
  }

  function updateQueueItemDOM(el, item) {
    el.className = `queue-item ${item.status}`;
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

  // ─── Platform tabs ─────────────────────────────────
  function switchPlatform(platform) {
    state.platform = platform;
    $$('.platform-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.platform === platform);
    });
    const searchable = ['tiktok', 'youtube', 'instagram', 'facebook'];
    dom.searchSection.style.display = searchable.includes(platform) ? '' : 'none';

    // Ad Library tab: swap the whole download/search UI for the spy-tool launch
    // panel. The actual browsing happens in the embedded Facebook window.
    const isAdLib = platform === 'adlibrary';
    const adlibSection = document.getElementById('adlib-section');
    const inputSection = document.getElementById('drop-zone');
    if (adlibSection) adlibSection.style.display = isAdLib ? '' : 'none';
    if (inputSection) inputSection.style.display = isAdLib ? 'none' : '';
    if (isAdLib) {
      dom.searchSection.style.display = 'none';
      dom.resultsSection?.classList.add('hidden');
      refreshFacebookLoginStatus();
    }

    // Update search placeholder per platform.
    if (dom.searchInput) {
      const placeholders = {
        tiktok: 'ابحث على TikTok…',
        youtube: 'ابحث على YouTube…',
        instagram: 'ابحث: كلمة (مثل: عطور) أو @اسم-حساب — Reels مباشرة',
        facebook: 'ابحث: hashtag (مثلاً: عطور) أو @صفحة',
      };
      dom.searchInput.placeholder = placeholders[platform] || 'Search for videos...';
    }

    // Instagram now mirrors TikTok exactly: NO in-app login banner. You just
    // search → the Instagram window opens → if you're not logged in you log in
    // inside that window (Instagram's own "Log in"), and it persists. So keep
    // the banner hidden on every tab.
    const igBanner = document.getElementById('ig-login-banner');
    if (igBanner) igBanner.style.display = 'none';
    // Show/hide Facebook login banner.
    const fbBanner = document.getElementById('fb-login-banner');
    if (fbBanner) {
      const showBanner = platform === 'facebook' && !!window.electronAPI?.facebook;
      fbBanner.style.display = showBanner ? 'flex' : 'none';
      if (showBanner) refreshFacebookLoginStatus();
    }
    // Show/hide TikTok login banner.
    const ttBanner = document.getElementById('tiktok-login-banner');
    if (ttBanner) {
      const showBanner = platform === 'tiktok' && !!window.electronAPI?.tiktok;
      ttBanner.style.display = showBanner ? 'flex' : 'none';
      if (showBanner) refreshTiktokLoginStatus();
    }
    // Show/hide the "open TikTok in a window" button (Electron only).
    const ttEmbedRow = document.getElementById('tiktok-embed-row');
    if (ttEmbedRow) {
      ttEmbedRow.style.display = (platform === 'tiktok' && !!window.electronAPI?.tiktok?.openSearchWindow) ? 'block' : 'none';
    }

    // Per-platform isolation: each tab keeps its own results, context, and
    // search query. Switching tabs swaps everything so the user only sees
    // state belonging to the active platform.
    if (!state.resultsByPlatform) state.resultsByPlatform = {};
    if (!state.contextByPlatform) state.contextByPlatform = {};
    if (!state.queryByPlatform)   state.queryByPlatform = {};

    // Save current platform's state before switching away
    const prevPlatform = state.results[0]?.platform || state.context?.platform;
    if (prevPlatform && prevPlatform !== platform) {
      if (state.results.length) state.resultsByPlatform[prevPlatform] = state.results.slice();
      if (state.context)        state.contextByPlatform[prevPlatform]  = state.context;
      if (dom.searchInput)      state.queryByPlatform[prevPlatform]    = dom.searchInput.value;
    }

    // Restore destination platform's state (or clear)
    state.results = (state.resultsByPlatform[platform] || []).slice();
    state.context = state.contextByPlatform[platform] || null;
    state.selected.clear();
    state.pagination.page = 1;
    if (dom.searchInput) dom.searchInput.value = state.queryByPlatform[platform] || '';

    // Hide any global loading indicator left over from the previous tab.
    showLoading(false);

    if (state.results.length) {
      dom.resultsSection.classList.remove('hidden');
      renderResults();
      // Force-reload any thumbnails that failed silently on previous render.
      setTimeout(nudgeVisibleThumbnails, 200);
    } else {
      dom.resultsSection.classList.add('hidden');
    }
  }

  function detectPlatform(url) {
    for (const [platform, regex] of Object.entries(platformPatterns)) {
      if (regex.test(url)) return platform;
    }
    return null;
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

  // ─── License & yt-dlp settings sections (Electron-only) ────
  async function refreshLicenseSection() {
    if (!window.electronAPI?.license) return;
    document.getElementById('license-section').style.display = '';
    try {
      const s = await window.electronAPI.license.getStatus();
      const statusMap = {
        active: { text: 'مفعّل ✓', color: '#22c55e' },
        revoked: { text: 'ملغى', color: '#dc2626' },
        expired: { text: 'منتهي', color: '#f59e0b' },
        invalid: { text: 'غير صالح', color: '#dc2626' },
        inactive: { text: 'غير مفعّل', color: '#64748b' },
      };
      const m = statusMap[s.status] || statusMap.inactive;
      const el = document.getElementById('license-status-text');
      if (el) { el.textContent = m.text; el.style.color = m.color; }
      const keyEl = document.getElementById('license-key-masked');
      if (keyEl) keyEl.textContent = s.keyMasked || '—';
      const expEl = document.getElementById('license-expires');
      if (expEl) expEl.textContent = s.expiresAt ? new Date(s.expiresAt).toLocaleDateString('ar-EG') : 'بدون انتهاء';
      const machineEl = document.getElementById('license-machine');
      if (machineEl) machineEl.textContent = s.fingerprint || '—';
    } catch (e) { /* ignore */ }
  }

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

  function bindLicenseAndYtdlpButtons() {
    if (!window.electronAPI) return;

    const deactivateBtn = document.getElementById('license-deactivate-btn');
    if (deactivateBtn) {
      deactivateBtn.addEventListener('click', async () => {
        if (!confirm('إلغاء التفعيل من الجهاز ده؟ هتحتاج تستخدم نفس المفتاح على الجهاز الجديد.')) return;
        await window.electronAPI.license.deactivate();
        toast('تم إلغاء التفعيل. التطبيق هيقفل.', 'info');
        setTimeout(() => window.close(), 1500);
      });
    }

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
      error: 'تعذّر الفحص — جرّب تاني',
    };
    if (statusEl) statusEl.textContent = labels[s.status] || '—';
    if (installBtn) installBtn.style.display = (s.status === 'downloaded') ? '' : 'none';
    const banner = document.getElementById('appupdate-banner');
    if (banner) banner.style.display = (s.status === 'downloaded') ? 'flex' : 'none';
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
  const BATCH_DEFAULT_DIR = 'E:\\منتجات التست';

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
        folderEl.value = last || BATCH_DEFAULT_DIR;
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
      const dir = (folderEl?.value || '').trim() || BATCH_DEFAULT_DIR;
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
      toast(`تحميل ${urls.length} رابط في ${sub ? dir + '\\' + sub : dir}`, 'info');
      startBatchDownload(items, { outputDir: dir, subfolder: sub });
      close();
      if (subfolderEl) subfolderEl.value = '';
    });
  }

  function bindTiktokEmbed() {
    const btn = document.getElementById('tiktok-embed-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        if (!window.electronAPI?.tiktok?.openSearchWindow) return;
        const q = (dom.searchInput?.value || '').trim();
        if (!q) return toast('اكتب اسم المنتج الأول', 'warning');
        window.electronAPI.tiktok.openSearchWindow(q);
        toast('فتحنا تيك توك — دوس «تحميل» على أي فيديو', 'info', 5000);
      });
    }
    // Downloads triggered from inside the embedded TikTok window → normal queue.
    if (window.electronAPI?.tiktok?.onEmbedDownload) {
      window.electronAPI.tiktok.onEmbedDownload((data) => {
        if (!data) return;
        // Use the Output Directory from Settings, then a subfolder named after
        // the search (so each product's videos group in their own folder).
        const base = (state.settings.outputDir || '').trim() || BATCH_DEFAULT_DIR;
        const sub = (data.folder || '').trim();
        // Accept a single url OR an array — sending "all/selected" as ONE batch
        // makes it a single cancellable job (Stop cancels them all reliably).
        const urls = Array.isArray(data.urls) ? data.urls : (data.url ? [data.url] : []);
        if (!urls.length) return;
        // Clean ASCII filename from the video id (NOT the raw URL — that made
        // unopenable names like "https___www...mp4").
        const items = urls.map((u) => {
          const id = (u.match(/\/video\/(\d+)/) || [])[1];
          return { id: undefined, url: u, title: id ? ('tiktok_' + id) : u, platform: 'tiktok' };
        });
        startBatchDownload(items, { outputDir: base, subfolder: sub, ignoreGlobalDedupe: true });
      });
    }
    // Same, for the embedded Instagram window.
    if (window.electronAPI?.instagram?.onEmbedDownload) {
      window.electronAPI.instagram.onEmbedDownload((data) => {
        if (!data) return;
        const base = (state.settings.outputDir || '').trim() || BATCH_DEFAULT_DIR;
        const sub = (data.folder || '').trim();
        // New payload shape carries a kind ('video'|'photo') per item; fall back
        // to the old url/urls shape (all treated as video) for compatibility.
        const raw = Array.isArray(data.items) ? data.items
          : (Array.isArray(data.urls) ? data.urls.map((u) => ({ url: u, kind: 'video' }))
          : (data.url ? [{ url: data.url, kind: data.kind || 'video' }] : []));
        if (!raw.length) return;
        const items = raw.map((it) => {
          const u = it.url;
          const m = u.match(/\/(reel|tv|p)\/([^/?]+)/);
          return {
            id: undefined,
            url: u,
            kind: it.kind || 'video',
            title: m ? ('instagram_' + m[2]) : u,
            platform: 'instagram',
          };
        });
        startBatchDownload(items, { outputDir: base, subfolder: sub, ignoreGlobalDedupe: true });
      });
    }
    // Same, for the embedded Facebook window.
    if (window.electronAPI?.facebook?.onEmbedDownload) {
      window.electronAPI.facebook.onEmbedDownload((data) => {
        if (!data) return;
        const base = (state.settings.outputDir || '').trim() || BATCH_DEFAULT_DIR;
        const sub = (data.folder || '').trim();
        const urls = Array.isArray(data.urls) ? data.urls : (data.url ? [data.url] : []);
        if (!urls.length) return;
        const items = urls.map((u) => {
          const id = (u.match(/[?&]v=(\d+)/) || u.match(/\/(?:reel|videos)\/(\d+)/) || [])[1];
          return { id: undefined, url: u, title: id ? ('facebook_' + id) : u, platform: 'facebook' };
        });
        startBatchDownload(items, { outputDir: base, subfolder: sub, ignoreGlobalDedupe: true });
      });
    }
    // Ad Library creatives: each item carries a direct media URL + kind so the
    // server downloads it straight (downloadFile), not through yt-dlp.
    if (window.electronAPI?.facebook?.onAdLibDownload) {
      window.electronAPI.facebook.onAdLibDownload((data) => {
        if (!data || !Array.isArray(data.items) || !data.items.length) return;
        const base = (state.settings.outputDir || '').trim() || BATCH_DEFAULT_DIR;
        const sub = (data.folder || '').trim();
        const items = data.items
          .filter((it) => it && it.downloadUrl)
          .map((it) => ({
            id: undefined,
            url: it.downloadUrl,
            downloadUrl: it.downloadUrl,
            kind: it.kind || 'image',
            title: it.title || ('fb_ad_' + (it.id || '')),
            // advertiser page name → server saves into a folder named after it
            author: (it.advertiser || '').trim() || 'fb-ads',
            platform: 'facebook-ad',
          }));
        if (items.length) startBatchDownload(items, { outputDir: base, subfolder: sub, ignoreGlobalDedupe: true });
      });
    }
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

  function showPlatformDetected(platform) {
    if (!platform) { dom.platformDetected.classList.add('hidden'); return; }
    dom.platformDetected.classList.remove('hidden');
    dom.platformDetected.querySelector('.detected-text').textContent =
      `Detected: ${platformNames[platform]}`;
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

    dom.urlInput.addEventListener('input', () => {
      const url = dom.urlInput.value.trim();
      if (url && state.settings.autoDetect) {
        const detected = detectPlatform(url);
        if (detected) { switchPlatform(detected); showPlatformDetected(detected); }
        else showPlatformDetected(null);
      } else {
        showPlatformDetected(null);
      }
    });

    dom.pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        dom.urlInput.value = text;
        dom.urlInput.dispatchEvent(new Event('input'));
      } catch {
        toast('لا يمكن قراءة الحافظة. الصق يدويًا بـ Ctrl+V.', 'warning');
      }
    });

    if (dom.importUrlsBtn) dom.importUrlsBtn.addEventListener('click', () => dom.importUrlsFile?.click());
    if (dom.importUrlsFile) dom.importUrlsFile.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const urls = text.split(/[\s,;\n]+/).map((s) => s.trim()).filter(isValidUrl);
      if (!urls.length) return toast('لم يتم العثور على روابط صالحة في الملف', 'warning');
      const items = urls.map((u) => ({ id: undefined, url: u, title: u, platform: detectPlatform(u) || state.platform }));
      toast(`تحميل ${urls.length} رابط من الملف`, 'info');
      startBatchDownload(items);
      e.target.value = ''; // allow re-importing same file
    });

    dom.infoBtn.addEventListener('click', () => {
      const url = dom.urlInput.value.trim();
      if (!url) return toast('من فضلك أدخل رابطًا', 'warning');
      fetchInfo(url);
    });


    dom.downloadBtn.addEventListener('click', async () => {
      const raw = dom.urlInput.value.trim();
      if (!raw) return toast('من فضلك أدخل رابطًا', 'warning');

      // Multi-URL: split by newline, comma, or whitespace, keep valid URLs only
      const urls = raw.split(/[\s,;\n]+/).map((s) => s.trim()).filter(isValidUrl);

      if (urls.length > 1) {
        // Batch of independent video links
        const items = urls.map((u) => ({ id: undefined, url: u, title: u, platform: detectPlatform(u) || state.platform }));
        toast(`تحميل ${urls.length} رابط دفعة واحدة`, 'info');
        startBatchDownload(items);
        return;
      }

      const url = urls[0] || raw;
      if (looksLikeChannel(url)) {
        toast('قناة/قائمة — جاري جلب الفيديوهات لتختار منها', 'info');
        await fetchInfo(url);
        return;
      }
      startDownload(url, { title: url, url });
    });

    dom.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); dom.infoBtn.click(); }
    });

    dom.searchBtn.addEventListener('click', () => {
      const query = dom.searchInput.value.trim();
      if (!query) return toast('أدخل كلمة بحث', 'warning');
      searchVideos(query);
    });
    dom.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); dom.searchBtn.click(); }
    });

    // ─── Reverse image search (paste a product screenshot) ───────────────
    // Upload the image to Google Lens (via Electron main) and open the
    // results page so the user can read the product's English name, then
    // search that name above to pull videos/images.
    async function reverseImageSearch(blob) {
      if (!window.electronAPI?.image) {
        return toast('البحث بالصورة متاح في تطبيق سطح المكتب فقط', 'warning');
      }
      if (!blob || !blob.size) {
        return toast('مفيش صورة. انسخ صورة المنتج الأول', 'warning');
      }
      toast('بنرفع الصورة ونفتح جوجل في المتصفح…', 'info', 8000);
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const r = await window.electronAPI.image.reverseSearch(bytes, blob.type || 'image/png');
        if (r?.success) {
          toast('فتحنا نتيجة جوجل في المتصفح — هتلاقي اسم المنتج بالإنجليزي، انسخه وابحث بيه فوق', 'success', 7000);
        } else {
          toast('فشل البحث بالصورة: ' + (r?.error || 'خطأ غير معروف'), 'error');
        }
      } catch (e) {
        toast('فشل قراءة الصورة من الحافظة', 'error');
      }
    }

    // Ctrl+V anywhere with an image in the clipboard → reverse search.
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          const blob = it.getAsFile();
          if (blob) { e.preventDefault(); reverseImageSearch(blob); return; }
        }
      }
      // No image → let the normal text paste proceed untouched.
    });

    // Button: pull the image straight from the clipboard (no focus needed).
    dom.imgSearchBtn?.addEventListener('click', async () => {
      if (!navigator.clipboard?.read) {
        return toast('انسخ صورة المنتج ثم اضغط Ctrl+V', 'info');
      }
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const type = it.types.find((t) => t.startsWith('image/'));
          if (type) { reverseImageSearch(await it.getType(type)); return; }
        }
        toast('مفيش صورة في الحافظة. انسخ صورة المنتج (أو استخدم Ctrl+V)', 'warning');
      } catch {
        toast('انسخ صورة المنتج ثم اضغط Ctrl+V في أي مكان', 'info');
      }
    });

    dom.selectAllBtn.addEventListener('click', () => {
      state.filteredResults.forEach((_, i) => state.selected.add(i));
      $$('.video-card input[type="checkbox"]').forEach((cb) => {
        cb.checked = true;
        cb.closest('.video-card').classList.add('selected');
      });
      updateSelectionUI();
    });

    dom.deselectAllBtn.addEventListener('click', () => {
      state.selected.clear();
      $$('.video-card input[type="checkbox"]').forEach((cb) => {
        cb.checked = false;
        cb.closest('.video-card').classList.remove('selected');
      });
      updateSelectionUI();
    });

    dom.downloadSelectedBtn.addEventListener('click', () => {
      if (state.selected.size === 0) return;
      const items = [...state.selected].map((i) => state.filteredResults[i]).filter(Boolean);
      startBatchDownload(items);
    });

    dom.downloadAllBtn.addEventListener('click', () => {
      const list = state.filteredResults.length ? state.filteredResults : state.results;
      if (list.length === 0) return;
      startBatchDownload(list);
    });

    if (dom.scheduleAllBtn) {
      dom.scheduleAllBtn.addEventListener('click', async () => {
        const list = state.filteredResults.length ? state.filteredResults : state.results;
        const sel = state.selected.size > 0 ? [...state.selected].map((i) => state.filteredResults[i]).filter(Boolean) : list;
        if (!sel.length) return toast('لا يوجد فيديوهات', 'warning');
        const when = prompt(`كم ساعة بعد الآن لجدولة تنزيل ${sel.length} فيديو؟\n(مثل: 2 = ساعتين، 0.5 = نصف ساعة)`, '4');
        if (!when) return;
        const hours = parseFloat(when);
        if (!isFinite(hours) || hours <= 0) return toast('قيمة غير صالحة', 'warning');
        const fireAt = Date.now() + hours * 3600_000;
        try {
          await fetch('/api/schedules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fireAt,
              payload: {
                type: 'batch', platform: state.platform,
                selectedVideos: sel,
                quality: state.settings.quality,
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
              },
            }),
          });
          toast(`تم الجدولة: ${sel.length} فيديو في ${new Date(fireAt).toLocaleString('ar-EG')}`, 'success', 8000);
        } catch (e) { toast('فشل الجدولة', 'error'); }
      });
    }

    dom.clearCompletedBtn.addEventListener('click', clearCompletedDownloads);

    if (dom.stopAllBtn) {
      dom.stopAllBtn.addEventListener('click', async () => {
        const active = [...state.queue.values()].filter(
          (q) => q.status === 'downloading' || q.status === 'queued'
        );
        if (!active.length) return toast('لا توجد تحميلات نشطة', 'info');
        if (!confirm(`إيقاف ${active.length} تحميل نشط؟`)) return;
        try {
          const r = await apiCall('/cancel-all', null, 'POST');
          toast(`تم إيقاف ${r.cancelled || 0} تحميل`, 'warning');
        } catch (err) {
          toast('فشل الإيقاف: ' + err.message, 'error');
        }
      });
    }

    // Preview modal events
    if (dom.previewClose) dom.previewClose.addEventListener('click', closePreview);
    if (dom.previewModal) {
      dom.previewModal.addEventListener('click', (e) => {
        if (e.target === dom.previewModal) closePreview();
      });
    }
    if (dom.previewDownload) {
      dom.previewDownload.addEventListener('click', () => {
        if (previewCurrent) {
          startDownload(previewCurrent.url || dom.urlInput.value.trim(), previewCurrent);
          closePreview();
        }
      });
    }
    if (dom.previewOpenOriginal) {
      dom.previewOpenOriginal.addEventListener('click', () => {
        if (previewCurrent?.url) window.open(previewCurrent.url, '_blank', 'noopener');
      });
    }

    // Filter / sort handlers
    const onFilterChange = () => {
      state.filters.sortBy   = dom.sortBy?.value || 'views_desc';
      state.filters.duration = dom.filterDuration?.value || 'all';
      state.filters.views    = dom.filterViews?.value || 'all';
      state.filters.search   = (dom.filterSearch?.value || '').trim();
      saveFiltersPreference(); // remember user's choice across sessions
      // Filter changed → start from page 1 of the new list
      state.pagination.page = 1;
      renderResults();
      saveResultsToStorage();
    };
    dom.sortBy?.addEventListener('change', onFilterChange);
    dom.filterDuration?.addEventListener('change', onFilterChange);
    dom.filterViews?.addEventListener('change', onFilterChange);
    let searchDebounce;
    dom.filterSearch?.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(onFilterChange, 200);
    });

    if (dom.exportResultsBtn) {
      dom.exportResultsBtn.addEventListener('click', () => {
        if (!state.results.length) return toast('لا توجد نتائج للتصدير', 'warning');
        const fmt = (prompt('اختر الصيغة: 1 = CSV، 2 = JSON', '1') || '1').trim();
        if (fmt === '2') {
          const blob = new Blob([JSON.stringify({
            url: dom.urlInput.value.trim(), platform: state.platform,
            exportedAt: new Date().toISOString(),
            count: state.results.length, results: state.results,
          }, null, 2)], { type: 'application/json' });
          downloadBlob(blob, `mediagrab-${state.platform}-${Date.now()}.json`);
        } else {
          const csv = toCsv(state.results);
          downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }),
            `mediagrab-${state.platform}-${Date.now()}.csv`);
        }
        toast(`تم تصدير ${state.results.length} فيديو`, 'success');
      });
    }

    // History modal
    if (dom.historyBtn) dom.historyBtn.addEventListener('click', openHistory);
    if (dom.historyClose) dom.historyClose.addEventListener('click', () => dom.historyModal.classList.add('hidden'));
    if (dom.historyModal) dom.historyModal.addEventListener('click', (e) => {
      if (e.target === dom.historyModal) dom.historyModal.classList.add('hidden');
    });
    if (dom.historyClear) dom.historyClear.addEventListener('click', async () => {
      if (!confirm('مسح كل سجل البحث؟')) return;
      await fetch('/api/history', { method: 'DELETE' });
      renderHistory([]);
    });

    // Stats
    if (dom.statsBtn) dom.statsBtn.addEventListener('click', openStats);
    if (dom.statsClose) dom.statsClose.addEventListener('click', () => dom.statsModal.classList.add('hidden'));
    if (dom.statsModal) dom.statsModal.addEventListener('click', (e) => {
      if (e.target === dom.statsModal) dom.statsModal.classList.add('hidden');
    });

    // Bookmarks
    if (dom.bookmarksBtn) dom.bookmarksBtn.addEventListener('click', openBookmarks);
    if (dom.bookmarksClose) dom.bookmarksClose.addEventListener('click', () => dom.bookmarksModal.classList.add('hidden'));
    if (dom.bookmarksModal) dom.bookmarksModal.addEventListener('click', (e) => {
      if (e.target === dom.bookmarksModal) dom.bookmarksModal.classList.add('hidden');
    });
    if (dom.bookmarkCurrentBtn) dom.bookmarkCurrentBtn.addEventListener('click', bookmarkCurrent);

    // View toggle
    if (dom.viewGridBtn) dom.viewGridBtn.addEventListener('click', () => setView('grid'));
    if (dom.viewListBtn) dom.viewListBtn.addEventListener('click', () => setView('list'));

    // Quick select chips
    if (dom.quickChips) {
      dom.quickChips.addEventListener('click', (e) => {
        const btn = e.target.closest('.chip');
        if (!btn) return;
        applyQuickChip(btn.dataset.action);
      });
    }

    // Subfolder input — once user edits, stop auto-overwriting it
    if (dom.subfolderInput) {
      dom.subfolderInput.addEventListener('input', () => {
        dom.subfolderInput.dataset.auto = '0';
        updateFolderUI();
      });
    }

    if (dom.clearResultsBtn) {
      dom.clearResultsBtn.addEventListener('click', () => {
        if (!state.results.length) return;
        if (!confirm('مسح جميع النتائج المعروضة والمحفوظة؟')) return;
        state.results = [];
        state.filteredResults = [];
        state.selected.clear();
        dom.resultsGrid.innerHTML = '';
        dom.resultsSection.classList.add('hidden');
        clearStoredResults();
        toast('تم مسح النتائج', 'info');
      });
    }

    dom.settingsBtn.addEventListener('click', () => {
      applySettingsToForm();
      refreshLicenseSection();
      refreshYtdlpSection();
      refreshAppUpdateSection();
      dom.settingsModal.classList.remove('hidden');
    });
    dom.settingsClose.addEventListener('click', () => dom.settingsModal.classList.add('hidden'));
    dom.settingsSave.addEventListener('click', saveSettings);
    dom.settingsReset.addEventListener('click', resetSettings);
    dom.settingsModal.addEventListener('click', (e) => {
      if (e.target === dom.settingsModal) dom.settingsModal.classList.add('hidden');
    });

    document.addEventListener('keydown', (e) => {
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

      if (e.key === 'Escape') {
        dom.settingsModal.classList.add('hidden');
        if (dom.historyModal) dom.historyModal.classList.add('hidden');
        closePreview();
      }

      // Ctrl+V outside input → focus URL and paste
      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !inField) {
        e.preventDefault();
        dom.urlInput.focus();
        navigator.clipboard.readText().then((text) => {
          dom.urlInput.value = text;
          dom.urlInput.dispatchEvent(new Event('input'));
        }).catch(() => {});
      }

      if (inField) return; // skip single-letter shortcuts when typing

      // / → focus search
      if (e.key === '/') {
        e.preventDefault();
        if (dom.filterSearch && state.results.length) dom.filterSearch.focus();
        else dom.searchInput?.focus();
      }
      // u → focus URL input
      if (e.key === 'u') { e.preventDefault(); dom.urlInput.focus(); dom.urlInput.select(); }
      // a → select all visible cards
      if (e.key === 'a' && state.results.length) { e.preventDefault(); dom.selectAllBtn?.click(); }
      // d → download all selected (or all if none selected)
      if (e.key === 'd' && state.results.length) {
        e.preventDefault();
        if (state.selected.size > 0) dom.downloadSelectedBtn?.click();
        else dom.downloadAllBtn?.click();
      }
      // h → open history
      if (e.key === 'h') { e.preventDefault(); openHistory(); }
      // s → open settings
      if (e.key === 's' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); dom.settingsBtn?.click(); }
      // x → stop all downloads
      if (e.key === 'x') { e.preventDefault(); dom.stopAllBtn?.click(); }
      // ? → show shortcuts help
      if (e.key === '?') { e.preventDefault(); showShortcutsHelp(); }
    });

    dom.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dom.dropZone.classList.add('drag-over');
    });
    dom.dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dom.dropZone.classList.remove('drag-over');
    });
    dom.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.dropZone.classList.remove('drag-over');
      const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list') || '';
      if (text && isValidUrl(text.trim())) {
        dom.urlInput.value = text.trim();
        dom.urlInput.dispatchEvent(new Event('input'));
      } else if (text) {
        toast('النص المُسقَط ليس رابطًا صالحًا', 'warning');
      }
    });

    // ─── Drag & drop image file(s) anywhere → reverse-image-search each ──────
    let imgDropOverlay = null;
    function showImgDropOverlay(show) {
      if (show && !imgDropOverlay) {
        imgDropOverlay = document.createElement('div');
        imgDropOverlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(108,92,231,.18);display:flex;align-items:center;justify-content:center;pointer-events:none;';
        imgDropOverlay.innerHTML = '<div style="background:#1e1b3a;color:#fff;padding:22px 34px;border-radius:14px;font-size:18px;font-weight:700;border:2px dashed #a855f7;">🔎 أفلت الصور للبحث عنها في جوجل</div>';
        document.body.appendChild(imgDropOverlay);
      } else if (!show && imgDropOverlay) {
        imgDropOverlay.remove();
        imgDropOverlay = null;
      }
    }
    function dragHasFiles(e) {
      const types = e.dataTransfer?.types || [];
      return Array.prototype.indexOf.call(types, 'Files') !== -1;
    }
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => {
      if (!dragHasFiles(e)) return;
      dragDepth++;
      showImgDropOverlay(true);
    });
    document.addEventListener('dragover', (e) => {
      if (dragHasFiles(e)) e.preventDefault();
    });
    document.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) showImgDropOverlay(false);
    });
    document.addEventListener('drop', async (e) => {
      const files = Array.from(e.dataTransfer?.files || []).filter((f) => (f.type || '').startsWith('image/'));
      dragDepth = 0;
      showImgDropOverlay(false);
      if (!files.length) return;
      e.preventDefault();
      toast(files.length > 1 ? `بنبحث عن ${files.length} صورة في جوجل…` : 'بنبحث عن الصورة في جوجل…', 'info', 6000);
      // One Google search per image, staggered so the uploads/tabs don't clash.
      for (let i = 0; i < files.length; i++) {
        reverseImageSearch(files[i]);
        if (i < files.length - 1) await new Promise((r) => setTimeout(r, 1300));
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

  function getPlatformSVG(platform) {
    const svgs = {
      tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1v-3.48a6.37 6.37 0 0 0-.79-.05A6.34 6.34 0 0 0 3.15 15a6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V8.81a8.24 8.24 0 0 0 4.76 1.51v-3.44a4.85 4.85 0 0 1-1-.19z"/></svg>',
      youtube: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
      instagram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/></svg>',
      facebook: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
    };
    return svgs[platform] || '';
  }

  // ─── Init ───────────────────────────────────────────
  // Ad Library launch panel → opens the embedded Facebook Ad Library window.
  function bindAdLibrary() {
    const btn = document.getElementById('adlib-open-btn');
    if (!btn) return;
    const open = () => {
      if (!window.electronAPI?.facebook?.openAdLibrary) {
        toast('مكتبة الإعلانات متاحة في تطبيق سطح المكتب بس', 'warning');
        return;
      }
      const base = (state.settings.outputDir || '').trim() || BATCH_DEFAULT_DIR;
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

  function init() {
    loadSettings();
    loadFiltersPreference();
    if (dom.sortBy)         dom.sortBy.value         = state.filters.sortBy   || 'views_desc';
    if (dom.filterDuration) dom.filterDuration.value = state.filters.duration || 'all';
    if (dom.filterViews)    dom.filterViews.value    = state.filters.views    || 'all';
    if (dom.filterSearch)   dom.filterSearch.value   = state.filters.search   || '';

    try {
      const v = localStorage.getItem('mediagrab_view');
      if (v === 'list' || v === 'grid') state.view = v;
    } catch {}
    setView(state.view);

    initSocket();
    initEvents();
    bindInstagramLoginButtons();
    bindFacebookLoginButtons();
    bindAdLibrary();
    bindTiktokLoginButtons();
    // Show the real app version in the header badge (never goes stale).
    if (window.electronAPI?.app?.version) {
      window.electronAPI.app.version().then((v) => {
        const el = document.getElementById('version-badge');
        if (el && v) el.textContent = 'v' + v;
      }).catch(() => {});
    }
    bindTiktokEmbed();
    bindBatchModal();
    bindCookieImportButtons();
    bindLicenseAndYtdlpButtons();
    bindAppUpdateButtons();
    switchPlatform('tiktok');

    // No auto-restore on refresh — the user picks what to open from History.
    setTimeout(checkInterrupted, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
