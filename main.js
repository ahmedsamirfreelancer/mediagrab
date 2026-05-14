const { app, BrowserWindow, shell, Menu, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

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
