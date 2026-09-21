/*
 * platformBridge.js — Capacitor/Android compatibility shim for the MediaGrab web UI.
 *
 * The UI was written for the Electron build (local Express + Socket.IO server
 * and window.electronAPI). On Android there is no local server. This shim:
 *   - provides a fake Socket.IO so the UI loads and we can push events into it,
 *   - short-circuits /api/* calls,
 *   - and routes the real download through the native MediaGrabDownloader
 *     plugin (yt-dlp on-device), translating its progress/complete/error into
 *     the socket events the existing queue UI already understands.
 */
(function () {
  'use strict';

  var IS_ANDROID = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  window.MG_BRIDGE = { phase: 2, android: IS_ANDROID };

  // ── Fake Socket.IO with a real handler registry ────────────────
  var handlers = {};
  function fire(ev, data) {
    var h = handlers[ev];
    if (h) { try { h(data); } catch (e) { console.error('[MG_BRIDGE] handler', ev, e); } }
  }
  window.MG_BRIDGE.emitSocket = fire;

  if (typeof window.io === 'undefined') {
    var fakeSocket = {
      id: 'android-local',
      connected: true,
      on: function (ev, cb) {
        handlers[ev] = cb;
        if (ev === 'connect' && typeof cb === 'function') {
          setTimeout(function () { fire('connect'); }, 60);
        }
        return fakeSocket;
      },
      off: function (ev) { if (ev) delete handlers[ev]; return fakeSocket; },
      once: function (ev, cb) { handlers[ev] = cb; return fakeSocket; },
      emit: function () { return fakeSocket; },
      close: function () { return fakeSocket; },
      disconnect: function () { return fakeSocket; },
      connect: function () { return fakeSocket; },
    };
    window.io = function () { return fakeSocket; };
  }

  // ── Native downloader plugin ───────────────────────────────────
  var Downloader = null;
  try {
    if (window.Capacitor && typeof window.Capacitor.registerPlugin === 'function') {
      Downloader = window.Capacitor.registerPlugin('MediaGrabDownloader');
    } else if (window.Capacitor && window.Capacitor.Plugins) {
      Downloader = window.Capacitor.Plugins.MediaGrabDownloader;
    }
  } catch (e) { /* not on device */ }
  window.MG_BRIDGE.downloader = Downloader;

  if (Downloader) {
    Downloader.addListener('progress', function (d) {
      fire('download:progress', {
        id: d.id, progress: Math.round(d.progress || 0), speed: '', eta: d.eta || 0,
      });
    });
    Downloader.addListener('complete', function (d) {
      fire('download:complete', { id: d.id, filePath: d.filePath, title: d.name });
    });
    Downloader.addListener('error', function (d) {
      fire('download:error', { id: d.id, error: d.error || 'فشل التحميل' });
    });
    Downloader.init()
      .then(function () { console.log('[MG_BRIDGE] engine ready'); })
      .catch(function (e) { console.warn('[MG_BRIDGE] engine init failed', e); });
  } else {
    console.warn('[MG_BRIDGE] native downloader not available (web preview?)');
  }

  function handleDownloadRequest(bodyStr) {
    var body;
    try { body = JSON.parse(bodyStr || '{}'); } catch (e) { body = {}; }
    if (!Downloader) {
      fire('download:error', { id: body.id, error: 'المحرّك مش جاهز' });
      return;
    }
    var items;
    if (body.type === 'batch' && Array.isArray(body.selectedVideos)) {
      items = body.selectedVideos.map(function (v) {
        return { id: v.id, url: v.url, audioOnly: (v.quality || body.quality) === 'audio' };
      });
    } else {
      items = [{ id: body.id, url: body.url, audioOnly: body.quality === 'audio' }];
    }
    items.forEach(function (it) {
      if (!it.url) return;
      Downloader.download({ id: it.id, url: it.url, audioOnly: !!it.audioOnly })
        .catch(function (e) {
          fire('download:error', { id: it.id, error: (e && e.message) || 'فشل التحميل' });
        });
    });
  }

  // ── fetch('/api/*') shim ───────────────────────────────────────
  var EMPTY_PAYLOAD = {
    ok: true,
    active: [], items: [], results: [], history: [], bookmarks: [],
    watchlist: [], interrupted: [], list: [], saved: [], schedules: [],
    ids: [], stats: {}, data: {},
    free: 0, total: 0, used: 0,
  };

  function fakeResponse(payload) {
    var body = payload || EMPTY_PAYLOAD;
    return {
      ok: true,
      status: 200,
      headers: { get: function () { return null; } },
      json: function () { return Promise.resolve(body); },
      text: function () { return Promise.resolve(JSON.stringify(body)); },
      blob: function () { return Promise.resolve(new Blob([])); },
    };
  }

  // The UI asks the server what platform it is on and where files go by
  // default (GET /api/env). There is no server here, so answer for Android —
  // otherwise the UI keeps its pre-flight assumption of Windows and prints
  // Windows paths on a phone.
  var ENV_PAYLOAD = {
    platform: 'android',
    sep: '/',
    home: '/storage/emulated/0',
    defaultOutputDir: '/storage/emulated/0/Download/MediaGrab',
  };

  function isLocalApi(url) {
    if (typeof url !== 'string') {
      try { url = String(url && url.url ? url.url : url); } catch (e) { return false; }
    }
    return url.indexOf('/api/') === 0 || url.indexOf('/socket.io/') === 0;
  }

  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = (input && input.url) ? input.url : input;
    if (isLocalApi(url)) {
      if (typeof url === 'string' && url.indexOf('/api/download') !== -1) {
        handleDownloadRequest(init && init.body);
        return Promise.resolve(fakeResponse({ ok: true }));
      }
      if (typeof url === 'string' && url.indexOf('/api/env') !== -1) {
        return Promise.resolve(fakeResponse(ENV_PAYLOAD));
      }
      return Promise.resolve(fakeResponse());
    }
    if (nativeFetch) return nativeFetch(input, init);
    return Promise.reject(new Error('fetch unavailable'));
  };

  /* ── The popups, Android-side ────────────────────────────────────────────
   * The desktop UI asks window.electronAPI.embed to open a platform; on a
   * phone that is the native WebView (EmbeddedBrowserActivity), which injects
   * the same download buttons and hands what you tap to the on-device engine.
   * Same UI, same model, different door. */

  function searchUrlFor(platform, q) {
    var e = encodeURIComponent(q || '');
    switch (platform) {
      case 'youtube': return 'https://m.youtube.com/results?search_query=' + e;
      case 'instagram': return 'https://www.instagram.com/explore/search/keyword/?q=' + e;
      case 'facebook': return 'https://www.facebook.com/watch/search/?q=' + e;
      case 'pinterest': return 'https://www.pinterest.com/search/pins/?q=' + e;
      case 'adlibrary':
        return 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&q=' + e;
      case 'tiktok':
      default: return 'https://www.tiktok.com/search?q=' + e;
    }
  }

  function homeUrlFor(platform) {
    switch (platform) {
      case 'youtube': return 'https://m.youtube.com/';
      case 'instagram': return 'https://www.instagram.com/';
      case 'facebook': return 'https://www.facebook.com/watch/';
      case 'pinterest': return 'https://www.pinterest.com/';
      case 'adlibrary': return 'https://www.facebook.com/ads/library/';
      case 'tiktok':
      default: return 'https://www.tiktok.com/';
    }
  }

  function openEmbed(platform, opts) {
    opts = opts || {};
    var url = opts.url || (opts.query ? searchUrlFor(platform, opts.query) : homeUrlFor(platform));
    if (!Downloader || !Downloader.openBrowser) {
      console.warn('[MG_BRIDGE] openBrowser unavailable; would open', url);
      return Promise.resolve({ success: false, error: 'المتصفح المدمج مش جاهز' });
    }
    Downloader.openBrowser({ url: url, platform: platform });
    return Promise.resolve({ success: true });
  }

  // Everything the desktop UI reaches for on the Electron side. What a phone
  // has no answer for resolves to "not here" instead of throwing, so one shared
  // interface runs on both.
  var noop = function () { return Promise.resolve({ success: false, error: 'مش متاح على الموبايل' }); };
  window.electronAPI = window.electronAPI || {
    embed: {
      open: openEmbed,
      // Downloads started inside the native popup come back as engine events,
      // which the queue already listens to — nothing to forward here.
      onDownload: function () {},
      setBaseDir: function () { return Promise.resolve(true); },
    },
    instagram: { status: noop, login: noop, logout: noop },
    facebook: { status: noop, login: noop, logout: noop, openAdLibrary: function (o) { return openEmbed('adlibrary', { query: (o || {}).query }); }, onAdLibDownload: function () {} },
    tiktok: { status: noop, login: noop, logout: noop, cookiesFromBrowser: noop },
    pinterest: { status: noop, login: noop, logout: noop },
    cookies: { import: noop },
    image: { reverseSearch: noop },
    app: { version: function () { return Promise.resolve(''); }, checkForUpdate: noop, updateState: noop, installUpdate: noop, onUpdateStatus: function () {} },
    ytdlp: { check: noop, update: noop },
    shell: { showItemInFolder: noop, openPath: noop },
  };

  function wireUI() {
    // There is no server to be connected to on a phone.
    var cs = document.getElementById('connection-status');
    if (cs) cs.style.display = 'none';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireUI);
  } else {
    wireUI();
  }

  console.log('[MG_BRIDGE] phase 2 shim active (android=' + IS_ANDROID + ', engine=' + !!Downloader + ')');
})();
