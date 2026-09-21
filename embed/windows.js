'use strict';

/**
 * ONE popup system for every platform.
 *
 * MediaGrab's model: the app itself never renders a platform's content. Any
 * search, profile, page or browse opens the REAL site in its own window with a
 * download toolbar injected (preload-*-embed.js), and whatever the user clicks
 * there is forwarded to the main window's normal download queue.
 *
 * Everything that used to be copy-pasted per platform (download forwarding,
 * "already downloaded" badges, base dir, open-folder, stop-all) lives here
 * once. Per-platform differences live in the registry main.js passes in —
 * partition, preload, user agent, window size and the URL builders.
 */

const { ipcMain, BrowserWindow, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

let cfg = { getMainWin: () => null, serverPort: 0, platforms: {} };
let lastBase = '';                 // output dir the main window last told us
const winPlatform = new Map();     // webContents id → platform key
let guestSeq = 0;

const ROOT = path.join(__dirname, '..');

function platformCfg(key) { return (cfg.platforms || {})[key] || null; }
function platformOf(evt) { return winPlatform.get(evt.sender.id) || ''; }

// Which platform's "already downloaded" list this window reads. Usually its
// own, but the Ad Library browses Facebook and shares Facebook's list.
function idsPlatform(evt) {
  const key = platformOf(evt);
  const p = platformCfg(key);
  return (p && p.idsPlatform) || key;
}

/* ─── Local server calls (the popup has no socket of its own) ────────────── */

function serverJson(method, route, body) {
  return new Promise((resolve) => {
    try {
      const req = http.request(
        `http://127.0.0.1:${cfg.serverPort}${route}`,
        { method, headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        }
      );
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.end(body ? JSON.stringify(body) : undefined);
    } catch { resolve(null); }
  });
}

/* ─── Opening a popup ────────────────────────────────────────────────────── */

function createWindow(key, p, url, { guest = false } = {}) {
  const win = new BrowserWindow({
    width: p.width || 1200,
    height: p.height || 880,
    title: guest ? `${p.title} (زائر — من غير تسجيل دخول)` : p.title,
    parent: cfg.getMainWin() || undefined,
    autoHideMenuBar: true,
    backgroundColor: p.background || '#0f0f14',
    webPreferences: {
      // A guest window gets a throwaway in-memory partition (no `persist:`),
      // which is the whole point of "try without logging in".
      partition: guest ? `${key}-guest-${++guestSeq}` : p.partition,
      contextIsolation: true,
      nodeIntegration: false,
      // The embed preloads require() the shared toolbar core, which a
      // sandboxed preload cannot do.
      sandbox: false,
      preload: path.join(ROOT, p.preload),
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  const id = win.webContents.id;
  winPlatform.set(id, key);
  win.on('closed', () => winPlatform.delete(id));

  // A preload that throws leaves a window with no toolbar and no clue why,
  // which reads as "the download buttons disappeared".
  win.webContents.on('preload-error', (_e, file, err) => {
    console.error('[embed] preload failed:', file, err && err.message);
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && /MediaGrab/.test(message)) console.error('[embed]', message);
  });

  if (p.userAgent) { try { win.webContents.setUserAgent(p.userAgent); } catch {} }
  if (p.onNavigate) {
    win.webContents.on('did-navigate', () => {
      Promise.resolve(p.onNavigate(win)).catch(() => {});
    });
  }
  win.loadURL(url, p.userAgent ? { userAgent: p.userAgent } : undefined);
  return win;
}

/**
 * Open a platform popup. `url` wins over `query`; when neither is given the
 * platform's home page opens, so the user can just browse.
 */
async function openEmbed(key, opts = {}) {
  const p = platformCfg(key);
  if (!p) return { success: false, error: 'منصة مش معروفة' };
  if (opts.base) lastBase = opts.base;
  if (p.prepare) { try { await p.prepare(); } catch {} }

  const url = opts.url
    ? String(opts.url)
    : (opts.query ? p.search(opts.query) : p.home());
  createWindow(key, p, url);
  return { success: true };
}

/* ─── IPC: the main window asks for a popup ──────────────────────────────── */

function registerEmbeds(options) {
  cfg = Object.assign(cfg, options || {});

  ipcMain.handle('embed:open', (_evt, key, opts) => openEmbed(key, opts || {}));

  // Whatever the popup's toolbar queued → the main window's download queue.
  ipcMain.on('embed:download', (evt, payload) => {
    const main = cfg.getMainWin();
    const has = payload && (payload.url
      || (Array.isArray(payload.urls) && payload.urls.length)
      || (Array.isArray(payload.items) && payload.items.length));
    if (!main || !has) return;
    main.webContents.send('embed:download',
      Object.assign({ platform: platformOf(evt) }, payload));
  });

  ipcMain.handle('embed:baseDir', () => lastBase);
  ipcMain.handle('embed:setBaseDir', (_evt, base) => { lastBase = base || lastBase || ''; return true; });

  // Badge the posts this user already downloaded (still re-downloadable).
  ipcMain.handle('embed:downloadedIds', async (evt) => {
    const key = idsPlatform(evt);
    const r = await serverJson('GET', `/api/downloaded-ids?platform=${encodeURIComponent(key)}`);
    return (r && r.ids) || [];
  });

  ipcMain.handle('embed:clearDownloaded', async (evt) => {
    const key = idsPlatform(evt);
    await serverJson('DELETE', `/api/downloaded-ids?platform=${encodeURIComponent(key)}`);
    return { success: true };
  });

  ipcMain.handle('embed:stopAll', async () => {
    const r = await serverJson('POST', '/api/cancel-all', {});
    return r || { cancelled: 0 };
  });

  ipcMain.handle('embed:openFolder', async (_evt, folder) => openFolder(folder));

  ipcMain.handle('embed:close', (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (win && !win.isDestroyed()) win.close();
    return { success: true };
  });

  // ── Rescues, offered by the toolbar when a page comes back empty ──
  // Each one changes WHICH session asks the platform.
  ipcMain.handle('embed:guest', (evt, url) => {
    const key = platformOf(evt);
    const p = platformCfg(key);
    if (!p || !sameSite(p, url)) return { success: false, error: 'رابط برّه الموقع' };
    createWindow(key, p, String(url), { guest: true });
    return { success: true };
  });

  ipcMain.handle('embed:external', async (evt, url) => {
    const p = platformCfg(platformOf(evt));
    if (!p || !sameSite(p, url)) return { success: false, error: 'رابط برّه الموقع' };
    await shell.openExternal(String(url));
    return { success: true };
  });

  // Throw away the session we have (imported cookies included) and let the
  // user log in by hand in this very window.
  ipcMain.handle('embed:relogin', async (evt) => {
    const p = platformCfg(platformOf(evt));
    if (!p) return { success: false, error: 'منصة مش معروفة' };
    if (p.relogin) {
      const r = await p.relogin();
      if (r && r.success) { try { evt.sender.reload(); } catch {} }
      return r || { success: false };
    }
    if (!p.loginUrl) return { success: false, error: 'مفيش تسجيل دخول للمنصة دي' };
    try {
      await session.fromPartition(p.partition)
        .clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers'] });
    } catch {}
    if (p.cookiesFile) { try { fs.unlinkSync(p.cookiesFile()); } catch {} }
    try { evt.sender.loadURL(p.loginUrl, p.userAgent ? { userAgent: p.userAgent } : undefined); } catch {}
    return { success: true };
  });
}

// Only ever hand a URL back to a window / the system browser when it belongs
// to the platform that window is showing — the URL comes from the site's own
// page, which is not ours to trust with anything wider.
function sameSite(p, url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return p.hosts.some((d) => h === d || h.endsWith('.' + d));
  } catch { return false; }
}

/* ─── "فتح المجلد" from inside a popup ───────────────────────────────────── */

// Arabic titles under a deep output dir routinely pass Windows' 260-char
// limit, where both existsSync and openPath fail silently — so probe with the
// long-path prefix and fall back to the base folder.
async function openFolder(folder) {
  try {
    const long = (p) => (process.platform === 'win32' && !p.startsWith('\\\\?\\')) ? '\\\\?\\' + p : p;
    const exists = (p) => { try { return fs.existsSync(p) || fs.existsSync(long(p)); } catch { return false; } };
    let target = lastBase || '';
    if (folder) {
      const joined = path.join(lastBase || '', String(folder));
      if (exists(joined)) target = joined;
    }
    if (!target) return { success: false, error: 'مفيش مسار' };
    if (!exists(target)) { try { fs.mkdirSync(long(target), { recursive: true }); } catch {} }
    let err = await shell.openPath(long(target));
    if (err) err = await shell.openPath(target);
    return err ? { success: false, error: err } : { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { registerEmbeds, openEmbed };
