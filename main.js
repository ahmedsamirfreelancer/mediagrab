const { app, BrowserWindow, dialog, shell, Menu, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

// Force the same userData folder in dev (`npm start`) and packaged builds.
// Without this, dev runs land in %APPDATA%/mediagrab (lowercase name from
// package.json) while the installer uses %APPDATA%/MediaGrab (productName),
// so dev mode wouldn't see the license/cookies the user already activated.
app.setName('MediaGrab');

let serverProcess = null;
let mainWin = null;
let activationWin = null;

const SERVER_PORT = 3456;

// License client lives outside asar (file IO + http) so require it relative.
const licenseClient = require('./license/client');

// Auto-updater is optional — keep MediaGrab functional if user hasn't installed it.
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch { /* electron-updater not installed yet; ignore until built */ }

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
  env.PATH = `${userBin};${getBinPath()};${env.PATH || ''}`;
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

function createActivationWindow() {
  activationWin = new BrowserWindow({
    width: 520,
    height: 640,
    title: 'MediaGrab — تفعيل',
    backgroundColor: '#1e1b4b',
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'license', 'preload.js'),
    },
  });
  activationWin.loadFile(path.join(__dirname, 'license', 'activate.html'));
  activationWin.on('closed', () => { activationWin = null; });
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

  mainWin.loadURL(`http://127.0.0.1:${SERVER_PORT}`);
  mainWin.on('closed', () => { mainWin = null; });
}

async function bootLicensedApp() {
  startServer();
  await waitForServer();
  createMainWindow();
  // Silently pull the TikTok login from the user's browser on startup, so the
  // embedded search shows the same results as their logged-in browser without
  // any manual "login" click. Non-blocking — never delays app boot.
  ensureTiktokLoggedInAuto();
  // Re-validate against the license server in the background. If revoked,
  // the next launch will fall back to activation flow.
  licenseClient.startCron();
  if (autoUpdater) {
    try {
      autoUpdater.autoDownload = true;
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch {}
  }
}

/* ─── IPC handlers (used by license/activate.html) ───────────────────────── */

ipcMain.handle('license:activate', async (_evt, key) => {
  const result = await licenseClient.activate(key);
  if (result.success) {
    // Boot the app and close the activation window.
    setTimeout(async () => {
      await bootLicensedApp();
      if (activationWin) {
        try { activationWin.close(); } catch {}
      }
    }, 600);
  }
  return result;
});

ipcMain.handle('license:deactivate', async () => licenseClient.deactivate());
ipcMain.handle('license:getStatus', async () => licenseClient.getStatus());
ipcMain.handle('license:getFingerprint', async () => licenseClient.getHardwareFingerprint());
ipcMain.handle('license:quit', async () => { app.quit(); });
ipcMain.handle('license:openExternal', async (_evt, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

/* ─── Shell helpers (opening downloaded files/folders) ───────────────────── */

ipcMain.handle('shell:showItemInFolder', async (_evt, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false };
  // Long Arabic paths (E:\منتجات التست\<query>\<title>) can exceed Windows'
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
// Upload the image to a temporary public host so Google can fetch it by URL.
// litterbox auto-deletes the file after 1 hour, so the screenshot only lives
// publicly for the short window needed to run the search.
function uploadToLitterbox(buffer, mime) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const boundary = '----MediaGrabLB' + Date.now();
    const ext = /png/i.test(mime || '') ? 'png'
              : /webp/i.test(mime || '') ? 'webp'
              : 'jpg';
    const textField = (name, val) => Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`, 'utf8');
    const fileHead = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="fileToUpload"; filename="image.${ext}"\r\n` +
      `Content-Type: ${mime || 'image/png'}\r\n\r\n`, 'utf8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([
      textField('reqtype', 'fileupload'),
      textField('time', '1h'),
      fileHead, buffer, tail,
    ]);

    const req = https.request({
      hostname: 'litterbox.catbox.moe',
      path: '/resources/internals/api.php',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'User-Agent': 'MediaGrab',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const url = (data || '').trim();
        if (/^https?:\/\//i.test(url)) resolve(url);
        else reject(new Error('فشل رفع الصورة: ' + url.slice(0, 120)));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('انتهى وقت رفع الصورة')));
    req.write(body);
    req.end();
  });
}

ipcMain.handle('image:reverseSearch', async (_evt, bytes, mime) => {
  try {
    const buffer = Buffer.from(bytes);
    if (!buffer.length) return { success: false, error: 'الصورة فاضية' };

    // 1) Host the image temporarily so Google can fetch it.
    const publicUrl = await uploadToLitterbox(buffer, mime);

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

ipcMain.handle('tiktok:login', async () => {
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
});

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

/* Open the REAL tiktok.com search in a visible window with download buttons
 * injected on every video (via preload-tiktok-embed.js). This gives the user
 * TikTok's exact, complete results with one-click downloading — the most
 * faithful "same as TikTok" experience. */
let lastEmbedBase = ''; // base output dir for the embedded window's downloads
ipcMain.handle('tiktok:openSearchWindow', async (_evt, query, base) => {
  lastEmbedBase = base || lastEmbedBase || '';
  // Make sure we've tried to pull the browser login before showing results,
  // so the window opens already logged in (guests get few/no video results).
  await ensureTiktokLoggedInAuto();
  const ses = session.fromPartition(TT_SESSION_PARTITION);
  await injectCookiesFromFileToSession(getTtCookiesFilePath(), ses);

  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    title: 'TikTok — دوس «تحميل» على أي فيديو',
    parent: mainWin || undefined,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      partition: TT_SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload-tiktok-embed.js'),
    },
  });
  // Land directly on the Videos tab (denser video grid than the mixed "Top").
  const url = `https://www.tiktok.com/search/video?q=${encodeURIComponent(query || '')}`;
  win.loadURL(url);
  return { success: true };
});

// A download button inside the embedded TikTok window was clicked — forward
// the video URL + chosen folder to the main window's normal download queue.
ipcMain.on('tiktok-embed:download', (_evt, payload) => {
  const hasWork = payload && (payload.url || (Array.isArray(payload.urls) && payload.urls.length));
  if (mainWin && hasWork) {
    mainWin.webContents.send('tiktok-embed:download', payload);
  }
});

// The embedded window asks which TikTok videos were already downloaded, so it
// can badge them with a "✓ اتحمّل" mark (still clickable for re-download).
ipcMain.handle('tiktok-embed:downloadedIds', async () => {
  return new Promise((resolve) => {
    try {
      const req = require('http').get(`http://127.0.0.1:${SERVER_PORT}/api/downloaded-ids?platform=tiktok`, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { try { resolve(JSON.parse(d).ids || []); } catch { resolve([]); } });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(4000, () => { req.destroy(); resolve([]); });
    } catch { resolve([]); }
  });
});

// The embedded window asks for its base download dir (to show the full path).
ipcMain.handle('tiktok-embed:baseDir', async () => lastEmbedBase);

// "فتح" button — open <base>\<folder> (or the base if that folder isn't there
// yet), handling Arabic/long paths the same way shell:showItemInFolder does.
ipcMain.handle('tiktok-embed:openFolder', async (_evt, folder) => {
  try {
    const winLong = (p) => (process.platform === 'win32' && !p.startsWith('\\\\?\\')) ? '\\\\?\\' + p : p;
    const exists = (p) => { try { return fs.existsSync(p) || fs.existsSync(winLong(p)); } catch { return false; } };
    let target = lastEmbedBase || '';
    if (folder) {
      const joined = path.join(lastEmbedBase || '', String(folder));
      if (exists(joined)) target = joined;
    }
    if (!target) return { success: false, error: 'مفيش مسار' };
    if (!exists(target)) { try { fs.mkdirSync(winLong(target), { recursive: true }); } catch {} }
    let err = await shell.openPath(winLong(target));
    if (err) err = await shell.openPath(target);
    return err ? { success: false, error: err } : { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Stop button inside the embedded window — cancel all active downloads.
ipcMain.handle('tiktok-embed:stopAll', async () => {
  return new Promise((resolve) => {
    try {
      const req = require('http').request(
        `http://127.0.0.1:${SERVER_PORT}/api/cancel-all`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ cancelled: 0 }); } });
        }
      );
      req.on('error', () => resolve({ cancelled: 0 }));
      req.setTimeout(5000, () => { req.destroy(); resolve({ cancelled: 0 }); });
      req.end('{}');
    } catch { resolve({ cancelled: 0 }); }
  });
});

// Reset the "✓ اتحمّل" marks — clears the TikTok downloaded-ids on the server.
ipcMain.handle('tiktok-embed:clearDownloaded', async () => {
  return new Promise((resolve) => {
    try {
      const req = require('http').request(
        `http://127.0.0.1:${SERVER_PORT}/api/downloaded-ids?platform=tiktok`,
        { method: 'DELETE' },
        (res) => { res.on('data', () => {}); res.on('end', () => resolve({ success: true })); }
      );
      req.on('error', () => resolve({ success: false }));
      req.setTimeout(4000, () => { req.destroy(); resolve({ success: false }); });
      req.end();
    } catch { resolve({ success: false }); }
  });
});

/* Load tiktok.com's own search page in a hidden window and scrape the video
 * grid — gives the exact same videos TikTok shows, unlike the TikWM API. */
ipcMain.handle('tiktok:searchViaPage', async (_evt, query) => {
  const ses = session.fromPartition(TT_SESSION_PARTITION);
  await injectCookiesFromFileToSession(getTtCookiesFilePath(), ses);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: TT_SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
    },
  });

  try {
    const url = `https://www.tiktok.com/search/video?q=${encodeURIComponent(query)}`;
    await win.loadURL(url);

    // TikTok hydrates slower than Instagram.
    await new Promise((r) => setTimeout(r, 4000));

    const MAX_SCROLLS = 60;
    const STAGNANT_LIMIT = 4;
    let stagnant = 0;
    let lastCount = 0;
    for (let i = 0; i < MAX_SCROLLS; i++) {
      try {
        await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight);');
      } catch { break; }
      await new Promise((r) => setTimeout(r, 1800));
      let currentCount = 0;
      try {
        currentCount = await win.webContents.executeJavaScript(
          'document.querySelectorAll(\'a[href*="/video/"]\').length'
        );
      } catch { break; }
      if (currentCount <= lastCount) {
        stagnant++;
        if (stagnant >= STAGNANT_LIMIT) break;
      } else {
        stagnant = 0;
        lastCount = currentCount;
      }
    }

    // Attribute-based scrape only — TikTok's CSS class names are hashed and
    // rotate per deploy, so we key off the canonical /@user/video/<id> href.
    const results = await win.webContents.executeJavaScript(`
      (() => {
        const seen = new Set();
        const out = [];
        for (const a of document.querySelectorAll('a[href*="/video/"]')) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\\/@([^/]+)\\/video\\/(\\d+)/);
          if (!m) continue;
          const user = m[1];
          const id = m[2];
          if (seen.has(id)) continue;
          seen.add(id);
          const img = a.querySelector('img');
          const card = a.closest('div');
          const cap = (a.getAttribute('title') || (img && img.alt) || (card && card.innerText) || '').trim().slice(0, 200);
          out.push({
            id,
            author: user,
            url: 'https://www.tiktok.com/@' + user + '/video/' + id,
            thumbnail: img ? (img.src || img.getAttribute('data-src') || '') : '',
            title: cap,
          });
        }
        return out;
      })();
    `);

    return { success: true, results, scrolls: lastCount };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    try { win.close(); } catch {}
  }
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

/* ─── Instagram API fetch via Electron's Chromium network stack ──────────
 * Node's https module gets blocked by Instagram's CDN because its TLS
 * fingerprint is identifiable as non-browser. Electron's net.fetch uses
 * Chromium's network stack, so the request looks like a real Chrome session.
 * We inject the imported cookies file into the persist:instagram session,
 * then fetch with that session.
 */
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

ipcMain.handle('instagram:apiFetch', async (_evt, urlStr) => {
  const ses = session.fromPartition(IG_SESSION_PARTITION);
  await injectCookiesFromFileToSession(getCookiesFilePath(), ses);
  const cookies = await ses.cookies.get({ domain: '.instagram.com' });
  const cookieMap = Object.fromEntries(cookies.map((c) => [c.name, c.value]));

  const { net } = require('electron');
  try {
    // Use the session's own fetch — it handles cookies + TLS like a real
    // browser tab. Avoid forbidden headers (Sec-Fetch-*, Cookie, Referer,
    // Accept-Encoding) because Chromium sets those itself; passing them
    // triggers ERR_INVALID_ARGUMENT.
    const response = await net.fetch(urlStr, {
      method: 'GET',
      session: ses,
      credentials: 'include',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'X-IG-App-ID': '936619743392459',
        'X-ASBD-ID': '129477',
        'X-IG-WWW-Claim': '0',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': cookieMap.csrftoken || '',
      },
    });
    const text = await response.text();
    if (!response.ok) {
      return { success: false, status: response.status, error: text.slice(0, 300) };
    }
    try { return { success: true, data: JSON.parse(text) }; }
    catch { return { success: false, error: 'Non-JSON: ' + text.slice(0, 300) }; }
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/* ─── Last-resort: real-browser search ──────────────────────────────────
 * Instagram's API endpoints return "Oops, an error occurred" to programmatic
 * callers even with valid cookies — they fingerprint the request shape.
 * The reliable workaround is to load Instagram's actual search page in a
 * hidden Electron window (same session, real Chromium render) and scrape
 * the rendered DOM. From Instagram's view this looks identical to a user
 * scrolling the search tab in their browser.
 */
ipcMain.handle('instagram:searchViaPage', async (_evt, query) => {
  const ses = session.fromPartition(IG_SESSION_PARTITION);
  await injectCookiesFromFileToSession(getCookiesFilePath(), ses);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: IG_SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
    },
  });

  try {
    const url = `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(query)}`;
    await win.loadURL(url);

    // Initial render
    await new Promise((r) => setTimeout(r, 3500));

    // Keep scrolling until Instagram stops loading new items. We give it up
    // to 60 scrolls (~90s) and stop early after 4 consecutive scrolls that
    // produce no new anchors (Instagram is out of results for this query).
    const MAX_SCROLLS = 60;
    const STAGNANT_LIMIT = 4;
    let stagnant = 0;
    let lastCount = 0;
    for (let i = 0; i < MAX_SCROLLS; i++) {
      try {
        await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight);');
      } catch { break; }
      await new Promise((r) => setTimeout(r, 1500));
      let currentCount = 0;
      try {
        currentCount = await win.webContents.executeJavaScript(
          'document.querySelectorAll(\'a[href*="/reel/"], a[href*="/p/"]\').length'
        );
      } catch { break; }
      if (currentCount <= lastCount) {
        stagnant++;
        if (stagnant >= STAGNANT_LIMIT) break;
      } else {
        stagnant = 0;
        lastCount = currentCount;
      }
    }

    // Scrape both /reel/ and /p/ anchors. Instagram's keyword-search page
    // actually puts the bulk of its reels under /p/ URLs even though they're
    // video posts. We keep both in the listing; the yt-dlp side has a
    // --match-filter "duration>0" that auto-skips any /p/ items that turn
    // out to be photo carousels.
    const results = await win.webContents.executeJavaScript(`
      (() => {
        const seen = new Set();
        const out = [];
        for (const a of document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]')) {
          const m = a.getAttribute('href').match(/\\/(reel|p)\\/([^/?]+)/);
          if (!m) continue;
          const key = m[2];
          if (seen.has(key)) continue;
          seen.add(key);
          const img = a.querySelector('img');
          out.push({
            id: key,
            kind: m[1],
            url: 'https://www.instagram.com/' + m[1] + '/' + key + '/',
            thumbnail: img ? img.src : '',
            alt: img ? (img.alt || '') : '',
          });
        }
        return out;
      })();
    `);

    return { success: true, results, scrolls: lastCount };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    try { win.close(); } catch {}
  }
});

ipcMain.handle('cookies:import', async (_evt, platform) => {
  if (platform !== 'instagram' && platform !== 'facebook' && platform !== 'tiktok') {
    return { success: false, error: 'Unsupported platform' };
  }
  const platLabel = platform === 'instagram' ? 'Instagram' : platform === 'facebook' ? 'Facebook' : 'TikTok';
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
    const domainNeedle = platform === 'instagram' ? 'instagram.com' : platform === 'facebook' ? 'facebook.com' : 'tiktok.com';
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
  return path.join(app.getPath('userData'), 'bin', 'yt-dlp.exe');
}

function getYtdlpBundledPath() {
  return path.join(getBinPath(), 'yt-dlp.exe');
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

ipcMain.handle('ytdlp:check', async () => {
  try {
    const release = await fetchJson('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');
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

ipcMain.handle('ytdlp:update', async () => {
  try {
    const release = await fetchJson('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');
    const asset = (release.assets || []).find((a) => a.name === 'yt-dlp.exe');
    if (!asset) return { success: false, message: 'yt-dlp.exe asset not found in latest release' };
    const dest = getYtdlpUserPath();
    await fetchBinary(asset.browser_download_url, dest);
    const version = readCurrentYtdlpVersion();
    // Restart the server so it picks up the new binary on PATH.
    if (serverProcess) {
      try { serverProcess.kill(); } catch {}
      serverProcess = null;
      startServer();
    }
    return { success: true, version, path: dest };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

/* ─── Error reporting to arqami.app ──────────────────────────────────────── */

const ERROR_ENDPOINT = process.env.MEDIAGRAB_ERROR_ENDPOINT || 'https://arqami.app/api/mediagrab/error';
const APP_VERSION_FOR_ERRORS = require('./package.json').version;

function reportError(err, context = {}) {
  try {
    const status = licenseClient.getStatus?.() || {};
    const payload = JSON.stringify({
      message: String(err?.message || err || 'unknown'),
      stack: String(err?.stack || ''),
      version: APP_VERSION_FOR_ERRORS,
      machineId: licenseClient.getHardwareFingerprint?.() || '',
      licenseKey: status.keyMasked || '',
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
    const win = mainWin || activationWin;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/* ─── App lifecycle ──────────────────────────────────────────────────────── */

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  // Init license client with userData path.
  licenseClient.init(app.getPath('userData'));

  // Auto-start with Windows (production builds only).
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: false,
        path: process.execPath,
      });
    } catch {}
  }

  if (licenseClient.isValid()) {
    await bootLicensedApp();
  } else {
    // Owner builds get a baked-in license key and skip the activation UI.
    const autoActivated = await licenseClient.tryAutoActivateWithOwnerKey();
    if (autoActivated) {
      await bootLicensedApp();
    } else {
      createActivationWindow();
    }
  }
});

app.on('window-all-closed', () => {
  if (serverProcess) try { serverProcess.kill(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) try { serverProcess.kill(); } catch {}
});
