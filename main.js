const { app, BrowserWindow, dialog, shell, Menu, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { registerEmbeds, openEmbed } = require('./embed/windows');

// Force the same userData folder in dev (`npm start`) and packaged builds.
// Without this, dev runs land in %APPDATA%/mediagrab (lowercase name from
// package.json) while the installer uses %APPDATA%/MediaGrab (productName),
// so dev mode wouldn't see the cookies/settings the installed copy already has.
app.setName('MediaGrab');

let serverProcess = null;
let mainWin = null;

const SERVER_PORT = 3456;

// MediaGrab is free: no serial, no activation screen, no license server.
// The one thing kept from that era is a stable per-machine id, used only to
// group crash reports — it is a hash of hardware attributes, no user data.
function machineId() {
  const os = require('os');
  const crypto = require('crypto');
  const raw = [process.platform, os.arch(), os.cpus()[0] && os.cpus()[0].model, os.totalmem()].join('|');
  return crypto.createHash('sha256').update('mediagrab:' + raw).digest('hex').slice(0, 32);
}

// Auto-updater is optional — keep MediaGrab functional if user hasn't installed it.
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch { /* electron-updater not installed yet; ignore until built */ }

const IS_MAC = process.platform === 'darwin';
// Bundled binaries are named yt-dlp.exe/ffmpeg.exe on Windows and
// yt-dlp/ffmpeg (no extension) on macOS.
const EXE = IS_MAC ? '' : '.exe';

function getBinPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, 'resources');
}

function getServerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'server', 'server.js');
  }
  return path.join(__dirname, 'server', 'server.js');
}

function startServer() {
  if (serverProcess) return;
  const env = Object.assign({}, process.env);
  // userData/bin holds the updated yt-dlp (written by ytdlp:update). It takes
  // precedence over the bundled binary in resources/bin so users always run
  // the latest version once they've updated.
  const userBin = path.join(app.getPath('userData'), 'bin');
  // path.delimiter, not a hard-coded ';' — macOS separates PATH entries with ':'
  // and a ';' there would collapse both bin dirs into one bogus entry.
  const sep = path.delimiter;
  env.PATH = `${userBin}${sep}${getBinPath()}${sep}${env.PATH || ''}`;
  env.MEDIAGRAB_DATA_DIR = path.join(app.getPath('userData'), 'data');

  serverProcess = fork(getServerPath(), [], {
    env,
    cwd: path.dirname(getServerPath()),
    silent: true,
  });

  serverProcess.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on('data', (d) => process.stderr.write(`[server-err] ${d}`));
  serverProcess.on('exit', (code) => {
    console.log(`server exited with code ${code}`);
    serverProcess = null;
  });
}

async function waitForServer(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const ok = await new Promise((resolve) => {
        const req = require('http').get(`http://127.0.0.1:${SERVER_PORT}/api/active`, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(500, () => { req.destroy(); resolve(false); });
      });
      if (ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'MediaGrab',
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload-main.js'),
    },
  });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // In dev (`npm start`) the renderer's console is invisible from the
  // terminal, which hides exactly the errors that break the UI on boot.
  if (!app.isPackaged) {
    mainWin.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[ui] ${message} (${source}:${line})`);
    });
  }

  mainWin.loadURL(`http://127.0.0.1:${SERVER_PORT}`);
  mainWin.on('closed', () => { mainWin = null; });
}

async function bootApp() {
  startServer();
  await waitForServer();
  createMainWindow();
  // Silently pull the TikTok login from the user's browser on startup, so the
  // embedded search shows the same results as their logged-in browser without
  // any manual "login" click. Non-blocking — never delays app boot.
  ensureTiktokLoggedInAuto();
  if (autoUpdater || IS_MAC) setupAutoUpdater();
}

/* ─── Shell helpers (opening downloaded files/folders) ───────────────────── */

ipcMain.handle('shell:showItemInFolder', async (_evt, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false };
  // Long Arabic paths (<output dir>\<query>\<title>) can exceed Windows'
  // 260-char limit, making fs.existsSync + showItemInFolder silently fail. We
  // probe with the \\?\ long-path prefix and walk UP to the first existing
  // ancestor folder, opening that so "المجلد" always lands somewhere useful.
  const winLong = (p) => (process.platform === 'win32' && !p.startsWith('\\\\?\\')) ? '\\\\?\\' + p : p;
  const exists = (p) => { try { return fs.existsSync(p) || fs.existsSync(winLong(p)); } catch { return false; } };
  try {
    if (exists(filePath)) {
      try { shell.showItemInFolder(filePath); return { success: true }; } catch {}
    }
    let folder = path.dirname(filePath);
    for (let i = 0; i < 5 && folder && folder !== path.dirname(folder); i++) {
      if (exists(folder)) {
        let err = await shell.openPath(winLong(folder));
        if (err) err = await shell.openPath(folder);
        if (!err) return { success: true, openedFolder: true };
      }
      folder = path.dirname(folder);
    }
    return { success: false, error: 'تعذّر فتح المجلد' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('shell:openPath', async (_evt, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false };
  try {
    // Windows MAX_PATH workaround: the \\?\ prefix lifts the 260-char limit
    // for the actual file open. Required when Arabic captions push paths
    // past the limit.
    const winLong = process.platform === 'win32' && filePath.length > 240 && !filePath.startsWith('\\\\?\\')
      ? '\\\\?\\' + filePath
      : filePath;
    let err = await shell.openPath(winLong);
    if (err && winLong !== filePath) {
      // Some shells reject the \\?\ prefix — try once without.
      err = await shell.openPath(filePath);
    }
    if (err) {
      // Last resort: open the parent folder so the user can find it manually.
      const folder = path.dirname(filePath);
      if (fs.existsSync(folder)) {
        const ferr = await shell.openPath(folder);
        if (!ferr) return { success: true, openedFolder: true };
      }
      return { success: false, error: err };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/* ─── Reverse image search (Google Lens) ─────────────────────────────────
 * User pastes a product screenshot (Ctrl+V); we upload the raw bytes to
 * Google Lens' upload endpoint, which answers with a 303 redirect to the
 * visual-search results page. We open that page in the user's default
 * browser so they can read the product's English name, then search it here.
 *
 * The old www.google.com/searchbyimage/upload endpoint is dead (returns 500);
 * lens.google.com/v3/upload is the current one and needs the image under the
 * multipart field name "encoded_image".
 */
// Low-level multipart POST. Resolves with { status, text }; rejects only on
// a transport/timeout error so the caller can decide what a non-2xx means.
function postMultipart({ hostname, path, fields = {}, fileField, filename, mime, buffer }) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const boundary = '----MediaGrabLB' + Date.now();
    const textField = (name, val) => Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`, 'utf8');
    const parts = Object.entries(fields).map(([k, v]) => textField(k, v));
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\n` +
      `Content-Type: ${mime || 'image/png'}\r\n\r\n`, 'utf8'));
    parts.push(buffer, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    const body = Buffer.concat(parts);

    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'User-Agent': 'MediaGrab',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: (data || '').trim() }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('انتهى وقت رفع الصورة')));
    req.write(body);
    req.end();
  });
}

// Upload the image to a temporary public host so Google can fetch it by URL.
// We try several hosts in order — the primary (litterbox) is flaky and
// sometimes answers with a 500 HTML page, so any single host being down must
// not break image search. All are short-lived / disposable public hosts.
async function uploadPublicImage(buffer, mime) {
  const ext = /png/i.test(mime || '') ? 'png'
            : /webp/i.test(mime || '') ? 'webp'
            : 'jpg';
  const filename = `image.${ext}`;
  const hosts = [
    { // litterbox — auto-deletes after 1h; returns the raw URL as plain text
      hostname: 'litterbox.catbox.moe', path: '/resources/internals/api.php',
      fields: { reqtype: 'fileupload', time: '1h' }, fileField: 'fileToUpload',
      parse: (r) => (/^https?:\/\//i.test(r.text) ? r.text : null),
    },
    { // catbox — permanent, same API family; reliable fallback
      hostname: 'catbox.moe', path: '/user/api.php',
      fields: { reqtype: 'fileupload' }, fileField: 'fileToUpload',
      parse: (r) => (/^https?:\/\//i.test(r.text) ? r.text : null),
    },
    { // tmpfiles.org — JSON { data: { url } }; needs /dl/ for a direct image
      hostname: 'tmpfiles.org', path: '/api/v1/upload',
      fields: {}, fileField: 'file',
      parse: (r) => {
        try {
          const u = JSON.parse(r.text)?.data?.url;
          return u ? u.replace('tmpfiles.org/', 'tmpfiles.org/dl/') : null;
        } catch { return null; }
      },
    },
  ];

  const errors = [];
  for (const h of hosts) {
    try {
      const res = await postMultipart({ ...h, filename, mime, buffer });
      const url = h.parse(res);
      if (url) return url;
      errors.push(`${h.hostname}: ${res.status} ${res.text.slice(0, 60)}`);
    } catch (e) {
      errors.push(`${h.hostname}: ${e.message}`);
    }
  }
  throw new Error('فشل رفع الصورة (كل الاستضافات): ' + errors.join(' | ').slice(0, 200));
}

ipcMain.handle('image:reverseSearch', async (_evt, bytes, mime) => {
  try {
    const buffer = Buffer.from(bytes);
    if (!buffer.length) return { success: false, error: 'الصورة فاضية' };

    // 1) Host the image temporarily so Google can fetch it.
    const publicUrl = await uploadPublicImage(buffer, mime);

    // 2) Let the user's real browser run the Lens search BY URL. The browser
    //    handles the full redirect/cookie chain itself, so results render
    //    normally with no "not associated with your account" / 403 errors.
    const searchUrl = 'https://lens.google.com/uploadbyurl?url='
      + encodeURIComponent(publicUrl) + '&hl=en';
    await shell.openExternal(searchUrl);
    return { success: true, url: searchUrl };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/* TikTok user URLs now go through yt-dlp in server.js — no Electron-side
 * scraper/bridge/login needed. yt-dlp uses TikTok's real pagination API and
 * pulls full profiles in one pass without authentication. */

/* ─── Instagram in-app login ─────────────────────────────────────────────── */

const IG_SESSION_PARTITION = 'persist:instagram';
const IG_LOGIN_URL = 'https://www.instagram.com/accounts/login/';

function getCookiesFilePath() {
  return path.join(app.getPath('userData'), 'data', 'instagram-cookies.txt');
}

/**
 * Read Instagram cookies from the persistent session and write them to a
 * Netscape-format cookies.txt that yt-dlp accepts.
 */
async function persistInstagramCookies() {
  const ses = session.fromPartition(IG_SESSION_PARTITION);
  const all = await ses.cookies.get({});
  const igCookies = all.filter((c) => c.domain && c.domain.includes('instagram.com'));
  if (!igCookies.length) return { saved: 0, file: null };

  const lines = ['# Netscape HTTP Cookie File', '# Generated by MediaGrab', ''];
  for (const c of igCookies) {
    const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    const flag = 'TRUE';
    const cpath = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = c.session ? 0 : Math.floor(c.expirationDate || (Date.now() / 1000 + 365 * 86400));
    lines.push([domain, flag, cpath, secure, expiry, c.name, c.value].join('\t'));
  }
  const file = getCookiesFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return { saved: igCookies.length, file };
}

async function isInstagramLoggedIn() {
  const ses = session.fromPartition(IG_SESSION_PARTITION);
  const cookies = await ses.cookies.get({ domain: '.instagram.com', name: 'sessionid' });
  return cookies.length > 0 && !!cookies[0].value;
}

ipcMain.handle('instagram:status', async () => {
  const loggedIn = await isInstagramLoggedIn();
  const file = getCookiesFilePath();
  return { loggedIn, cookiesFile: fs.existsSync(file) ? file : null };
});

ipcMain.handle('instagram:login', async () => {
  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 480,
      height: 700,
      title: 'تسجيل الدخول إلى Instagram',
      parent: mainWin || undefined,
      modal: !!mainWin,
      autoHideMenuBar: true,
      webPreferences: {
        partition: IG_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let finalized = false;
    async function finalize(success) {
      if (finalized) return;
      finalized = true;
      const result = success ? await persistInstagramCookies() : { saved: 0, file: null };
      try { loginWin.close(); } catch {}
      resolve({ success, ...result });
    }

    // When Instagram redirects to its home or onetap page after login, capture cookies.
    loginWin.webContents.on('did-navigate', async (_evt, url) => {
      if (/instagram\.com\/(accounts\/onetap|\?|$)/i.test(url) || url === 'https://www.instagram.com/') {
        if (await isInstagramLoggedIn()) finalize(true);
      }
    });
    loginWin.webContents.on('did-navigate-in-page', async (_evt, url) => {
      if (await isInstagramLoggedIn()) finalize(true);
    });
    loginWin.on('closed', () => finalize(finalized));

    loginWin.loadURL(IG_LOGIN_URL);
  });
});

ipcMain.handle('instagram:logout', async () => {
  const ses = session.fromPartition(IG_SESSION_PARTITION);
  await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers'] });
  try { fs.unlinkSync(getCookiesFilePath()); } catch {}
  return { success: true };
});

/* ─── Facebook in-app login (same pattern as Instagram) ──────────────────── */

const FB_SESSION_PARTITION = 'persist:facebook';
const FB_LOGIN_URL = 'https://www.facebook.com/login/';

function getFbCookiesFilePath() {
  return path.join(app.getPath('userData'), 'data', 'facebook-cookies.txt');
}

async function persistFacebookCookies() {
  const ses = session.fromPartition(FB_SESSION_PARTITION);
  const all = await ses.cookies.get({});
  const fbCookies = all.filter((c) => c.domain && /facebook\.com$/i.test(c.domain));
  if (!fbCookies.length) return { saved: 0, file: null };

  const lines = ['# Netscape HTTP Cookie File', '# Generated by MediaGrab', ''];
  for (const c of fbCookies) {
    const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    const cpath = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = c.session ? 0 : Math.floor(c.expirationDate || (Date.now() / 1000 + 365 * 86400));
    lines.push([domain, 'TRUE', cpath, secure, expiry, c.name, c.value].join('\t'));
  }
  const file = getFbCookiesFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return { saved: fbCookies.length, file };
}

async function isFacebookLoggedIn() {
  const ses = session.fromPartition(FB_SESSION_PARTITION);
  // c_user holds the FB user ID once login completes.
  const cookies = await ses.cookies.get({ domain: '.facebook.com', name: 'c_user' });
  return cookies.length > 0 && !!cookies[0].value;
}

ipcMain.handle('facebook:status', async () => {
  const loggedIn = await isFacebookLoggedIn();
  const file = getFbCookiesFilePath();
  return { loggedIn, cookiesFile: fs.existsSync(file) ? file : null };
});

ipcMain.handle('facebook:login', async () => {
  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 520,
      height: 720,
      title: 'تسجيل الدخول إلى Facebook',
      parent: mainWin || undefined,
      modal: !!mainWin,
      autoHideMenuBar: true,
      webPreferences: {
        partition: FB_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let finalized = false;
    async function finalize(success) {
      if (finalized) return;
      finalized = true;
      const result = success ? await persistFacebookCookies() : { saved: 0, file: null };
      try { loginWin.close(); } catch {}
      resolve({ success, ...result });
    }

    // FB redirects to home (/) or m.facebook.com after a successful login.
    loginWin.webContents.on('did-navigate', async (_evt, url) => {
      try {
        const u = new URL(url);
        if (/facebook\.com$/i.test(u.hostname) && !/\/login\/?/i.test(u.pathname)) {
          if (await isFacebookLoggedIn()) finalize(true);
        }
      } catch {}
    });
    loginWin.webContents.on('did-navigate-in-page', async () => {
      if (await isFacebookLoggedIn()) finalize(true);
    });
    loginWin.on('closed', () => finalize(finalized));

    loginWin.loadURL(FB_LOGIN_URL);
  });
});

ipcMain.handle('facebook:logout', async () => {
  const ses = session.fromPartition(FB_SESSION_PARTITION);
  await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers'] });
  try { fs.unlinkSync(getFbCookiesFilePath()); } catch {}
  return { success: true };
});

/* ─── TikTok in-app login + real-page search (mirrors Instagram) ──────────
 * The TikWM API search returns a different/smaller set than tiktok.com's own
 * search. To match TikTok exactly we load the real search page in a hidden
 * Electron window (real Chromium render, same session as a logged-in user)
 * and scrape the rendered video grid. Login is optional — search usually
 * works logged-out, but a persisted session helps when TikTok gates results.
 */
const TT_SESSION_PARTITION = 'persist:tiktok';
const TT_LOGIN_URL = 'https://www.tiktok.com/login';

function getTtCookiesFilePath() {
  return path.join(app.getPath('userData'), 'data', 'tiktok-cookies.txt');
}

async function persistTiktokCookies() {
  const ses = session.fromPartition(TT_SESSION_PARTITION);
  const all = await ses.cookies.get({});
  const ttCookies = all.filter((c) => c.domain && /tiktok\.com$/i.test(c.domain));
  if (!ttCookies.length) return { saved: 0, file: null };

  const lines = ['# Netscape HTTP Cookie File', '# Generated by MediaGrab', ''];
  for (const c of ttCookies) {
    const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    const cpath = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = c.session ? 0 : Math.floor(c.expirationDate || (Date.now() / 1000 + 365 * 86400));
    lines.push([domain, 'TRUE', cpath, secure, expiry, c.name, c.value].join('\t'));
  }
  const file = getTtCookiesFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return { saved: ttCookies.length, file };
}

async function isTiktokLoggedIn() {
  const ses = session.fromPartition(TT_SESSION_PARTITION);
  // TikTok sets `sessionid` (httpOnly) once logged in.
  const cookies = await ses.cookies.get({ domain: '.tiktok.com', name: 'sessionid' });
  return cookies.length > 0 && !!cookies[0].value;
}

ipcMain.handle('tiktok:status', async () => {
  const loggedIn = await isTiktokLoggedIn();
  const file = getTtCookiesFilePath();
  return { loggedIn, cookiesFile: fs.existsSync(file) ? file : null };
});

// Opens TikTok's own login page in our session partition and resolves once
// the cookie jar actually has a sessionid. Shared by the settings button and
// by the "log in again" rescue on the empty-results notice.
function openTiktokLoginWindow() {
  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 520,
      height: 720,
      title: 'تسجيل الدخول إلى TikTok',
      parent: mainWin || undefined,
      modal: !!mainWin,
      autoHideMenuBar: true,
      webPreferences: {
        partition: TT_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let finalized = false;
    async function finalize(success) {
      if (finalized) return;
      finalized = true;
      const result = success ? await persistTiktokCookies() : { saved: 0, file: null };
      try { loginWin.close(); } catch {}
      resolve({ success, ...result });
    }

    // TikTok redirects to home (/) or /foryou after a successful login.
    loginWin.webContents.on('did-navigate', async (_evt, url) => {
      try {
        const u = new URL(url);
        if (/tiktok\.com$/i.test(u.hostname) && !/\/login\/?/i.test(u.pathname)) {
          if (await isTiktokLoggedIn()) finalize(true);
        }
      } catch {}
    });
    loginWin.webContents.on('did-navigate-in-page', async () => {
      if (await isTiktokLoggedIn()) finalize(true);
    });
    loginWin.on('closed', () => finalize(finalized));

    loginWin.loadURL(TT_LOGIN_URL);
  });
}

ipcMain.handle('tiktok:login', async () => openTiktokLoginWindow());

ipcMain.handle('tiktok:logout', async () => {
  const ses = session.fromPartition(TT_SESSION_PARTITION);
  await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers'] });
  try { fs.unlinkSync(getTtCookiesFilePath()); } catch {}
  return { success: true };
});

/* Auto-login: pull the TikTok session straight from whatever browser the user
 * is already logged into, via yt-dlp's --cookies-from-browser. We try the
 * common browsers in order and stop at the first that yields a TikTok
 * `sessionid`, write it to our cookies file, and load it into the search
 * session — no manual login needed. (Chromium browsers may need to be CLOSED
 * because of Windows' cookie-DB lock; Firefox works while open.) */
async function autoPullTiktokCookiesFromBrowser() {
  const { spawnSync } = require('child_process');
  const ytdlp = getYtdlpActivePath();
  const outFile = getTtCookiesFilePath();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // Firefox first — it has no DB lock / app-bound encryption, so it's the most
  // likely to succeed. Chromium browsers (Chrome/Edge/Brave) often fail on
  // Windows because of app-bound cookie encryption even when closed.
  const browsers = ['firefox', 'chrome', 'edge', 'brave', 'opera', 'vivaldi', 'chromium'];
  let realError = '';   // an installed browser that failed (lock/encryption)
  let foundNoLogin = false; // a browser opened but had no TikTok sessionid
  for (const b of browsers) {
    let r;
    try {
      r = spawnSync(ytdlp, [
        '--cookies-from-browser', b,
        '--cookies', outFile,
        '--skip-download', '--no-warnings', '--ignore-errors',
        '--playlist-items', '0',
        'https://www.tiktok.com/@tiktok',
      ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    } catch (e) {
      realError = e.message;
      continue;
    }

    if (fs.existsSync(outFile)) {
      const txt = fs.readFileSync(outFile, 'utf8');
      if (/tiktok\.com/i.test(txt) && /\bsessionid\b/i.test(txt)) {
        try {
          const ses = session.fromPartition(TT_SESSION_PARTITION);
          await injectCookiesFromFileToSession(outFile, ses);
        } catch {}
        return { success: true, browser: b };
      }
    }

    const err = (r.stderr || '');
    if (/could not find|not find .* cookies database|unsupported browser/i.test(err)) {
      // Browser not installed — ignore, it shouldn't define the final message.
      continue;
    }
    if (err.trim()) {
      // Installed but failed (locked DB / app-bound encryption).
      realError = (err.split('\n').filter(Boolean).slice(-1)[0] || '').trim();
    } else {
      // Ran clean but no TikTok login in it.
      foundNoLogin = true;
    }
  }

  if (realError) {
    return { success: false, error: realError, hint: 'app-bound' };
  }
  return {
    success: false,
    error: foundNoLogin
      ? 'مفيش تسجيل دخول TikTok في المتصفحات. سجّل دخول TikTok في المتصفح الأول.'
      : 'مفيش متصفح مدعوم متسطّب فيه تسجيل دخول TikTok.',
  };
}

ipcMain.handle('tiktok:cookiesFromBrowser', async () => autoPullTiktokCookiesFromBrowser());

// Pull the TikTok login from the browser automatically, at most once per app
// run, but only when we're not already logged in. Fired on startup and right
// before the search window opens, so the user never has to click "login".
let ttAutoPullDone = false;
async function ensureTiktokLoggedInAuto() {
  if (ttAutoPullDone) return;
  ttAutoPullDone = true;
  try {
    if (await isTiktokLoggedIn()) return;
    await autoPullTiktokCookiesFromBrowser();
  } catch {}
}

/* ─── Pinterest embedded search (mirrors the TikTok embed) ────────────────
 * Open pinterest.com's real pins search in a visible window with a download
 * button on every pin (via preload-pinterest-embed.js). Pinterest browsing and
 * search work logged-out, but if the user logs in inside the window we persist
 * the cookies so yt-dlp can reach gated video pins too. The server figures out
 * per pin whether it's a video (yt-dlp) or an image (resolved off the page). */
const PIN_SESSION_PARTITION = 'persist:pinterest';
const PIN_LOGIN_URL = 'https://www.pinterest.com/login/';

function getPinterestCookiesFilePath() {
  return path.join(app.getPath('userData'), 'data', 'pinterest-cookies.txt');
}

async function persistPinterestCookies() {
  const ses = session.fromPartition(PIN_SESSION_PARTITION);
  const all = await ses.cookies.get({});
  const pinCookies = all.filter((c) => c.domain && /pinterest\.com$/i.test(c.domain));
  if (!pinCookies.length) return { saved: 0, file: null };

  const lines = ['# Netscape HTTP Cookie File', '# Generated by MediaGrab', ''];
  for (const c of pinCookies) {
    const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    const cpath = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = c.session ? 0 : Math.floor(c.expirationDate || (Date.now() / 1000 + 365 * 86400));
    lines.push([domain, 'TRUE', cpath, secure, expiry, c.name, c.value].join('\t'));
  }
  const file = getPinterestCookiesFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return { saved: pinCookies.length, file };
}

async function isPinterestLoggedIn() {
  const ses = session.fromPartition(PIN_SESSION_PARTITION);
  // Pinterest sets `_pinterest_sess` once logged in.
  const cookies = await ses.cookies.get({ domain: '.pinterest.com', name: '_pinterest_sess' });
  return cookies.length > 0 && !!cookies[0].value;
}

ipcMain.handle('pinterest:status', async () => {
  const loggedIn = await isPinterestLoggedIn();
  const file = getPinterestCookiesFilePath();
  return { loggedIn, cookiesFile: fs.existsSync(file) ? file : null };
});

ipcMain.handle('pinterest:login', async () => {
  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 520,
      height: 720,
      title: 'تسجيل الدخول إلى Pinterest',
      parent: mainWin || undefined,
      modal: !!mainWin,
      autoHideMenuBar: true,
      webPreferences: {
        partition: PIN_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let finalized = false;
    async function finalize(success) {
      if (finalized) return;
      finalized = true;
      const result = success ? await persistPinterestCookies() : { saved: 0, file: null };
      try { loginWin.close(); } catch {}
      resolve({ success, ...result });
    }

    // Pinterest redirects away from /login (to / or /<user>) after login.
    loginWin.webContents.on('did-navigate', async (_evt, url) => {
      try {
        const u = new URL(url);
        if (/pinterest\.com$/i.test(u.hostname) && !/\/login\/?/i.test(u.pathname)) {
          if (await isPinterestLoggedIn()) finalize(true);
        }
      } catch {}
    });
    loginWin.webContents.on('did-navigate-in-page', async () => {
      if (await isPinterestLoggedIn()) finalize(true);
    });
    loginWin.on('closed', () => finalize(finalized));

    loginWin.loadURL(PIN_LOGIN_URL);
  });
});

ipcMain.handle('pinterest:logout', async () => {
  const ses = session.fromPartition(PIN_SESSION_PARTITION);
  await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers'] });
  try { fs.unlinkSync(getPinterestCookiesFilePath()); } catch {}
  return { success: true };
});

/* ─── The user agents the popups wear ────────────────────────────────────── */

// An Android Chrome (mobile) UA. Instagram serves its phone layout to any
// phone UA, and that is the only layout whose keyword search surfaces Reels.
// UNLIKE an iPhone Safari UA it also makes Instagram serve the reel as
// Chromium-playable MSE/MP4 instead of native HLS (.m3u8), which our window
// cannot play — the video would just sit there frozen.
const IG_MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const FB_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// Ad Library wants the DESKTOP grid layout, not the mobile single column.
const FB_DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ─── The popup registry ────────────────────────────────────────────────────
 * What differs between platforms, in one table: where its session lives, which
 * preload wears the download toolbar, how it spells a search URL, and what has
 * to happen before its window opens. Everything else about popups —
 * forwarding downloads, badges, stop, open-folder — is embed/windows.js. */

const EMBED_PLATFORMS = {
  tiktok: {
    title: 'TikTok — دوس «تحميل» على أي فيديو',
    hosts: ['tiktok.com'],
    partition: TT_SESSION_PARTITION,
    preload: 'preload-tiktok-embed.js',
    width: 1200, height: 860, background: '#000000',
    // Land on the Videos tab: a denser video grid than the mixed "Top".
    search: (q) => `https://www.tiktok.com/search/video?q=${encodeURIComponent(q)}`,
    home: () => 'https://www.tiktok.com/',
    cookiesFile: getTtCookiesFilePath,
    // Pull the browser login BEFORE showing results — a guest session gets
    // few or no videos back.
    prepare: async () => {
      await ensureTiktokLoggedInAuto();
      await injectCookiesFromFileToSession(getTtCookiesFilePath(), session.fromPartition(TT_SESSION_PARTITION));
    },
    relogin: async () => {
      const ses = session.fromPartition(TT_SESSION_PARTITION);
      try { await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers'] }); } catch {}
      try { fs.unlinkSync(getTtCookiesFilePath()); } catch {}
      // Don't let the auto-puller drag the same rejected cookies back in.
      ttAutoPullDone = true;
      return openTiktokLoginWindow();
    },
  },

  youtube: {
    title: 'YouTube — دوس «تحميل» على أي فيديو',
    hosts: ['youtube.com', 'youtu.be'],
    partition: 'persist:youtube',
    preload: 'preload-youtube-embed.js',
    width: 1280, height: 900, background: '#0f0f0f',
    search: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
    home: () => 'https://www.youtube.com/',
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube',
  },

  instagram: {
    title: 'Instagram — دوس «تحميل» على أي ريل',
    hosts: ['instagram.com', 'instagr.am'],
    partition: IG_SESSION_PARTITION,
    preload: 'preload-instagram-embed.js',
    // Stay UNDER Instagram's ~736px tablet breakpoint: above it the mobile
    // site flips to the desktop sidebar layout, whose keyword search hides
    // Reels and just spins.
    width: 700, height: 940, background: '#000000',
    userAgent: IG_MOBILE_UA,
    search: (q) => `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`,
    home: () => 'https://www.instagram.com/',
    loginUrl: IG_LOGIN_URL,
    cookiesFile: getCookiesFilePath,
    // The live session is the source of truth once a real login exists. Only
    // seed from the file when it has no sessionid — otherwise every search
    // overwrites a freshly-rotated one with the stale snapshot, which is the
    // "logs in then out every time" loop.
    prepare: async () => {
      if (await isInstagramLoggedIn()) return;
      await injectCookiesFromFileToSession(getCookiesFilePath(), session.fromPartition(IG_SESSION_PARTITION));
    },
    // If they (re)log in via Instagram's one-tap screen inside the window,
    // refresh the cookies file so yt-dlp keeps working.
    onNavigate: async () => { if (await isInstagramLoggedIn()) await persistInstagramCookies(); },
  },

  facebook: {
    title: 'Facebook — دوس «تحميل» على أي فيديو',
    hosts: ['facebook.com', 'fb.watch', 'fb.com'],
    partition: FB_SESSION_PARTITION,
    preload: 'preload-facebook-embed.js',
    width: 760, height: 940, background: '#000000',
    userAgent: FB_MOBILE_UA,
    search: (q) => `https://www.facebook.com/watch/search/?query=${encodeURIComponent(q)}`,
    home: () => 'https://www.facebook.com/watch/',
    loginUrl: FB_LOGIN_URL,
    cookiesFile: getFbCookiesFilePath,
    prepare: async () => {
      await injectCookiesFromFileToSession(getFbCookiesFilePath(), session.fromPartition(FB_SESSION_PARTITION));
    },
  },

  pinterest: {
    title: 'Pinterest — دوس «تحميل» على أي صورة/فيديو',
    hosts: ['pinterest.com', 'pin.it'],
    partition: PIN_SESSION_PARTITION,
    preload: 'preload-pinterest-embed.js',
    width: 1200, height: 860, background: '#ffffff',
    search: (q) => `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(q)}`,
    home: () => 'https://www.pinterest.com/',
    loginUrl: PIN_LOGIN_URL,
    cookiesFile: getPinterestCookiesFilePath,
    // Browsing works logged out; a login inside the window is persisted so
    // yt-dlp can reach gated video pins too.
    prepare: async () => {
      if (await isPinterestLoggedIn()) return;
      await injectCookiesFromFileToSession(getPinterestCookiesFilePath(), session.fromPartition(PIN_SESSION_PARTITION));
    },
    onNavigate: async () => { if (await isPinterestLoggedIn()) await persistPinterestCookies(); },
  },

  // The Ad Library browses Facebook with a different preload and the DESKTOP
  // layout, and shares Facebook's session and downloaded-ids list.
  adlibrary: {
    title: 'مكتبة إعلانات فيسبوك — MediaGrab',
    hosts: ['facebook.com'],
    partition: FB_SESSION_PARTITION,
    idsPlatform: 'facebook',
    preload: 'preload-fb-adlibrary.js',
    width: 1180, height: 940, background: '#0b0b14',
    userAgent: FB_DESKTOP_UA,
    search: (q) => adLibraryUrl({ query: q }),
    home: () => adLibraryUrl({}),
    prepare: async () => {
      await injectCookiesFromFileToSession(getFbCookiesFilePath(), session.fromPartition(FB_SESSION_PARTITION));
    },
  },
};

registerEmbeds({
  getMainWin: () => mainWin,
  serverPort: SERVER_PORT,
  platforms: EMBED_PLATFORMS,
});

/* ─── Facebook Ad Library (the "spy tool" surface) ─────────────────────────── */

// "Winning products" = ads still ACTIVE that started running ≥ N days ago,
// which is Facebook's own start_date[max] = (today − N days).
function adLibraryUrl(opts) {
  const minDays = parseInt(opts.minDays, 10) || 0;
  const params = new URLSearchParams({
    active_status: minDays > 0 ? 'active' : (opts.activeStatus || 'active'),
    ad_type: 'all',
    country: opts.country || 'EG',
    media_type: opts.mediaType || 'all',
    search_type: 'keyword_unordered',
    q: opts.query || '',
  });
  if (opts.lang) params.set('content_languages[0]', opts.lang);
  if (minDays > 0) {
    params.set('start_date[max]', new Date(Date.now() - minDays * 86400000).toISOString().slice(0, 10));
  }
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

ipcMain.handle('facebook:openAdLibrary', async (_evt, opts) => {
  opts = opts || {};
  return openEmbed('adlibrary', { url: adLibraryUrl(opts), base: opts.base });
});


// Forward Ad Library creative downloads to the main window's queue.
ipcMain.on('fb-adlib:download', (_evt, payload) => {
  const hasWork = payload && Array.isArray(payload.items) && payload.items.length;
  if (mainWin && hasWork) mainWin.webContents.send('fb-adlib:download', payload);
});

// Open a landing page / ad permalink in the user's default browser (Chrome),
// instead of navigating inside the embedded Facebook window.
ipcMain.handle('fb-adlib:openExternal', async (_evt, url) => {
  try { if (url && /^https?:/i.test(url)) await shell.openExternal(url); return { success: true }; }
  catch (e) { return { success: false, error: e.message }; }
});

// Real app version for the header badge (so it never goes stale per release).
ipcMain.handle('app:getVersion', () => { try { return app.getVersion(); } catch { return ''; } });

/* ─── App auto-update (electron-updater) ─────────────────────────────────── */
// We keep the latest updater state in memory so the renderer can ask for it any
// time (e.g. the window opened after the update already downloaded silently),
// and we also push every state change so the in-app banner shows live without
// the user having to dig into Settings.
let appUpdateState = { status: 'idle', version: null, progress: 0 };

function sendUpdateStatus(status, extra) {
  appUpdateState = { ...appUpdateState, status, ...(extra || {}) };
  try {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('app-update:status', appUpdateState);
    }
  } catch {}
}

/* macOS update path.
 *
 * Squirrel.Mac (what electron-updater drives on macOS) refuses to apply an
 * update to an app that isn't code-signed by an Apple Developer ID, and our
 * mac build is unsigned — calling checkForUpdates() there only produces a
 * "Could not get code signature" error. So on macOS we do the honest thing:
 * ask the public releases repo what the newest version is and, if it's newer,
 * tell the user to download it (the "install" button opens the release page).
 * The moment a Developer ID cert is added to the build, delete this and let
 * electron-updater handle macOS like it does Windows.
 */
const RELEASES_API = 'https://api.github.com/repos/ahmedsamirfreelancer/mediagrab-releases/releases/latest';
const RELEASES_PAGE = 'https://github.com/ahmedsamirfreelancer/mediagrab-releases/releases/latest';

function isNewerVersion(latest, current) {
  const a = String(latest).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

async function checkMacUpdate() {
  sendUpdateStatus('checking');
  try {
    const release = await fetchJson(RELEASES_API);
    const latest = String(release.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    if (latest && isNewerVersion(latest, current)) {
      // 'manual' = a newer build exists but the user has to install it himself.
      sendUpdateStatus('manual', { version: latest });
      return { supported: true, manual: true, current, latest };
    }
    sendUpdateStatus('uptodate');
    return { supported: true, manual: true, current, latest };
  } catch (e) {
    sendUpdateStatus('error');
    return { supported: true, manual: true, error: e.message, current: app.getVersion() };
  }
}

function setupMacUpdateCheck() {
  checkMacUpdate().catch(() => {});
  setInterval(() => { checkMacUpdate().catch(() => {}); }, 6 * 60 * 60 * 1000);
}

function setupAutoUpdater() {
  if (IS_MAC) return setupMacUpdateCheck();
  try {
    autoUpdater.autoDownload = true;          // pull the new version in the background
    autoUpdater.autoInstallOnAppQuit = true;  // and apply it when the user closes the app
    autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
    autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info && info.version }));
    autoUpdater.on('update-not-available', () => sendUpdateStatus('uptodate'));
    autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', { progress: Math.round((p && p.percent) || 0) }));
    autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', { version: info && info.version }));
    autoUpdater.on('error', () => sendUpdateStatus('error'));
    autoUpdater.checkForUpdates().catch(() => {});
    // Re-check every 3 hours so long-running instances — and ones whose boot
    // check hit a momentary network/antivirus blip — still pick up new releases
    // with zero user action. electron-updater no-ops if already latest/downloaded.
    setInterval(() => {
      try { autoUpdater.checkForUpdates().catch(() => {}); } catch {}
    }, 3 * 60 * 60 * 1000);
  } catch {}
}

// Manual "check for updates" button in Settings.
ipcMain.handle('app:checkForUpdate', async () => {
  if (IS_MAC) return checkMacUpdate();
  if (!autoUpdater) return { supported: false, current: (() => { try { return app.getVersion(); } catch { return ''; } })() };
  try {
    sendUpdateStatus('checking');
    const r = await autoUpdater.checkForUpdates();
    const latest = r && r.updateInfo ? r.updateInfo.version : null;
    return { supported: true, current: app.getVersion(), latest, status: appUpdateState.status };
  } catch (e) {
    return { supported: true, error: e.message, current: app.getVersion() };
  }
});

// Renderer asks for whatever state we already know (on window open).
ipcMain.handle('app:updateState', () => ({
  ...appUpdateState,
  current: (() => { try { return app.getVersion(); } catch { return ''; } })(),
}));

// "Restart & install" button / banner — applies the downloaded update right now.
ipcMain.handle('app:installUpdate', () => {
  // On macOS there's nothing to install in place — open the release page so
  // the user can grab the new .dmg.
  if (IS_MAC) {
    try { shell.openExternal(RELEASES_PAGE); return true; } catch { return false; }
  }
  if (!autoUpdater) return false;
  try { setImmediate(() => autoUpdater.quitAndInstall()); return true; } catch { return false; }
});



/* ─── Manual cookies.txt import (workaround for Chrome 127+ DPAPI lock) ────
 * Chrome on Windows 127+ encrypts its cookie DB with a key tied to the user's
 * SID + an "app-bound" flag, which yt-dlp can't read via --cookies-from-browser.
 * Users hit a "Failed to decrypt with DPAPI" error. The escape hatch is to let
 * them export cookies from any Chrome extension (e.g. "Get cookies.txt LOCALLY")
 * and copy that file into our data dir — yt-dlp then uses --cookies <file>.
 */
function getDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

/* ─── Seeding a popup's session from an imported cookies file ────────────
 * A cookies.txt exported from the user's browser is how a login gets into a
 * platform's partition without them typing it again — and the same file is
 * what yt-dlp reads for gated posts. */
async function injectCookiesFromFileToSession(filePath, ses) {
  if (!fs.existsSync(filePath)) return 0;
  // Always re-inject — the imported cookies are the source of truth and the
  // session may have stale values from a prior login attempt.
  const text = fs.readFileSync(filePath, 'utf8');
  let added = 0;
  let failed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [rawDomain, , cpath, secure, expiry, name, value] = parts;
    // Electron's cookies.set wants the domain WITHOUT the Netscape leading
    // dot. The dot is wire-format only — Electron handles subdomain scoping
    // via the URL + an empty/missing domain field.
    const hostDomain = rawDomain.replace(/^\./, '');
    const isSecure = secure === 'TRUE';
    const url = (isSecure ? 'https://' : 'http://') + hostDomain + (cpath || '/');
    try {
      await ses.cookies.set({
        url,
        name,
        value,
        domain: rawDomain.startsWith('.') ? rawDomain : hostDomain,
        path: cpath || '/',
        secure: isSecure,
        httpOnly: name === 'sessionid' || name === 'csrftoken',
        sameSite: 'no_restriction',
        expirationDate: parseInt(expiry, 10) || undefined,
      });
      added++;
    } catch (e) {
      failed++;
      console.log(`[IG cookie] failed ${name}: ${e.message}`);
    }
  }
  console.log(`[IG cookie] injected ${added}, failed ${failed}`);
  return added;
}



ipcMain.handle('cookies:import', async (_evt, platform) => {
  if (platform !== 'instagram' && platform !== 'facebook' && platform !== 'tiktok' && platform !== 'pinterest') {
    return { success: false, error: 'Unsupported platform' };
  }
  const platLabel = platform === 'instagram' ? 'Instagram' : platform === 'facebook' ? 'Facebook' : platform === 'pinterest' ? 'Pinterest' : 'TikTok';
  const result = await dialog.showOpenDialog(mainWin || undefined, {
    title: `اختر ملف كوكيز ${platLabel}`,
    properties: ['openFile'],
    filters: [{ name: 'Cookies', extensions: ['txt'] }],
  });
  if (result.canceled || !result.filePaths?.[0]) return { success: false, cancelled: true };
  const src = result.filePaths[0];
  try {
    const content = fs.readFileSync(src, 'utf8');
    // Sanity-check: Netscape cookies files start with this header.
    if (!/Netscape HTTP Cookie File/i.test(content)) {
      return { success: false, error: 'الملف ده مش Netscape cookies.txt. صدّره من الـ extension تاني.' };
    }
    const domainNeedle = platform === 'instagram' ? 'instagram.com' : platform === 'facebook' ? 'facebook.com' : platform === 'pinterest' ? 'pinterest.com' : 'tiktok.com';
    if (!new RegExp(domainNeedle, 'i').test(content)) {
      return { success: false, error: `الملف مفيهوش كوكيز ${domainNeedle}.` };
    }
    const destDir = getDataDir();
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${platform}-cookies.txt`);
    fs.copyFileSync(src, dest);
    return { success: true, file: dest };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/* ─── yt-dlp auto-update ─────────────────────────────────────────────────── */

const https = require('https');
const { spawnSync } = require('child_process');

function getYtdlpUserPath() {
  return path.join(app.getPath('userData'), 'bin', 'yt-dlp' + EXE);
}

function getYtdlpBundledPath() {
  return path.join(getBinPath(), 'yt-dlp' + EXE);
}

function getYtdlpActivePath() {
  const userPath = getYtdlpUserPath();
  if (fs.existsSync(userPath)) return userPath;
  return getYtdlpBundledPath();
}

function readCurrentYtdlpVersion() {
  try {
    const r = spawnSync(getYtdlpActivePath(), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return (r.stdout || '').trim() || null;
  } catch { return null; }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MediaGrab' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function fetchBinary(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.partial';
    const file = fs.createWriteStream(tmp);
    const go = (u) => {
      https.get(u, { headers: { 'User-Agent': 'MediaGrab' } }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          return go(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(tmp); } catch {}
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try { fs.renameSync(tmp, dest); resolve(dest); }
            catch (e) { reject(e); }
          });
        });
      }).on('error', (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
    };
    go(url);
  });
}

// NIGHTLY, not stable: Instagram (and other sites) break often and the fixes
// land in nightly weeks before any stable release — the stable build is
// regularly "marked as broken" and unable to extract Instagram at all.
const YTDLP_RELEASE_API = 'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest';

ipcMain.handle('ytdlp:check', async () => {
  try {
    const release = await fetchJson(YTDLP_RELEASE_API);
    const latest = String(release.tag_name || '').replace(/^v/, '');
    const current = readCurrentYtdlpVersion();
    return {
      current,
      latest,
      updateAvailable: latest && current && latest !== current,
    };
  } catch (e) {
    return { error: e.message };
  }
});

// Download the latest nightly yt-dlp into userData/bin (which getYtdlpActivePath
// prefers over the bundled copy) and restart the server so it's picked up.
// Shared by the manual "update" button and the silent on-launch refresh.
async function updateYtdlpToLatest() {
  const release = await fetchJson(YTDLP_RELEASE_API);
  // `yt-dlp_macos` is the universal2 (Intel + Apple Silicon) build.
  const assetName = IS_MAC ? 'yt-dlp_macos' : 'yt-dlp.exe';
  const asset = (release.assets || []).find((a) => a.name === assetName);
  if (!asset) throw new Error(`${assetName} asset not found in latest release`);
  const dest = getYtdlpUserPath();
  await fetchBinary(asset.browser_download_url, dest);
  // A fresh download has no exec bit on macOS — without this the server can
  // only fail with EACCES when it tries to spawn it.
  if (IS_MAC) {
    try { fs.chmodSync(dest, 0o755); } catch {}
    // Apple Silicon kills any Mach-O that carries no signature at all
    // ("Killed: 9") — chmod alone is not enough for a binary we downloaded
    // ourselves. An ad-hoc signature costs nothing and makes it runnable.
    try { spawnSync('codesign', ['--force', '--sign', '-', dest], { timeout: 20000 }); } catch {}
    // Belt and braces: strip quarantine in case the file ever picks it up.
    try { spawnSync('xattr', ['-d', 'com.apple.quarantine', dest], { timeout: 5000 }); } catch {}
  }
  const version = readCurrentYtdlpVersion();
  if (serverProcess) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
    startServer();
  }
  return { version, path: dest };
}

ipcMain.handle('ytdlp:update', async () => {
  try {
    const { version, path: dest } = await updateYtdlpToLatest();
    return { success: true, version, path: dest };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// Once per day, refresh yt-dlp to the latest nightly in the background so the
// app keeps downloading after Instagram/etc. change their site — without the
// user having to notice anything broke or click "update". Best-effort: any
// failure (offline, GitHub down) is swallowed and the bundled copy stays.
function maybeAutoUpdateYtdlp() {
  try {
    const stampFile = path.join(app.getPath('userData'), 'bin', '.ytdlp-checked');
    let last = 0;
    try { last = parseInt(fs.readFileSync(stampFile, 'utf8'), 10) || 0; } catch {}
    if (Date.now() - last < 24 * 60 * 60 * 1000) return;
    updateYtdlpToLatest()
      .then(() => {
        try {
          fs.mkdirSync(path.dirname(stampFile), { recursive: true });
          fs.writeFileSync(stampFile, String(Date.now()), 'utf8');
        } catch {}
      })
      .catch(() => {});
  } catch {}
}

/* ─── Error reporting ────────────────────────────────────────────────────── */

// arqami.app is the SaaS platform now and answers
// 404 here, so every crash report since 2026-08-02 went nowhere.
const ERROR_ENDPOINT = process.env.MEDIAGRAB_ERROR_ENDPOINT || 'https://license.ahmedsamir.net/api/mediagrab/error';
const APP_VERSION_FOR_ERRORS = require('./package.json').version;

function reportError(err, context = {}) {
  try {

    const payload = JSON.stringify({
      message: String(err?.message || err || 'unknown'),
      stack: String(err?.stack || ''),
      version: APP_VERSION_FOR_ERRORS,
      machineId: machineId(),
      context: typeof context === 'string' ? context : JSON.stringify(context),
    });
    const u = new URL(ERROR_ENDPOINT);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: 'POST',
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': `MediaGrab/${APP_VERSION_FOR_ERRORS}`,
      },
    });
    req.on('error', () => {}); // best-effort
    req.on('timeout', () => req.destroy());
    req.write(payload);
    req.end();
  } catch { /* never throw from the error reporter itself */ }
}

process.on('uncaughtException', (err) => { reportError(err, { source: 'uncaughtException' }); });
process.on('unhandledRejection', (reason) => { reportError(reason, { source: 'unhandledRejection' }); });

/* ─── Single instance + auto-start ───────────────────────────────────────── */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWin;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/* ─── macOS menu ─────────────────────────────────────────────────────────── */

// Minimal roles-only menu. Electron on macOS derives the standard keyboard
// shortcuts from the menu, so this is what makes Cmd+V / Cmd+Q / Cmd+W work at
// all — it is not decoration.
function buildMacMenu() {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

/* ─── App lifecycle ──────────────────────────────────────────────────────── */

app.whenReady().then(async () => {
  // macOS: an app with NO menu bar loses every standard accelerator with it —
  // Cmd+V (pasting a link, the app's main input), Cmd+A, Cmd+W, and Cmd+Q. So
  // on mac we install the minimal roles menu instead of nothing. Windows keeps
  // its menu hidden (autoHideMenuBar covers it there).
  Menu.setApplicationMenu(IS_MAC ? buildMacMenu() : null);

  // Auto-start with Windows (production builds only).
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings(IS_MAC
        // macOS: omit `path`. process.execPath is the executable INSIDE the
        // bundle; registering that launches a bare process instead of the app.
        ? { openAtLogin: true, openAsHidden: false }
        : { openAtLogin: true, openAsHidden: false, path: process.execPath });
    } catch {}
  }

  // Free build: nothing to check, nothing to activate — boot straight in.
  await bootApp();

  // Keep yt-dlp fresh in the background (once/day) so downloads keep working
  // after sites change. Delayed so it never competes with first-paint.
  setTimeout(maybeAutoUpdateYtdlp, 8000);
});

app.on('window-all-closed', () => {
  // macOS convention: the app stays alive after its last window closes. We
  // also keep the server up — killing it here (as we used to) left the app a
  // zombie: no window, no way to get one back, only Force Quit.
  if (IS_MAC) return;
  if (serverProcess) try { serverProcess.kill(); } catch {}
  app.quit();
});

// Dock icon click with no windows open → give the window back.
app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length > 0) return;
  startServer();
  await waitForServer();
  createMainWindow();
});

app.on('before-quit', () => {
  if (serverProcess) try { serverProcess.kill(); } catch {}
});
