/**
 * MediaGrab — Server
 * Hardened: no shell, validated paths, real concurrency, working cancel on Windows.
 */

const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { spawn, spawnSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);

// ─── Config ────────────────────────────────────────────────────────────────────
const PORT = 3456;
const DEFAULT_OUTPUT_DIR = path.join(
  process.env.USERPROFILE || os.homedir(),
  'Downloads',
  'MediaGrab'
);
const MAX_COMPLETED_HISTORY = 200;
const DATA_DIR = process.env.MEDIAGRAB_DATA_DIR || path.join(__dirname, 'data');
const SAVED_DIR = path.join(DATA_DIR, 'saved');
const DOWNLOADED_IDS_FILE = path.join(DATA_DIR, 'downloaded_ids.json');
const RESULTS_FILE = path.join(DATA_DIR, 'last_results.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const QUEUE_STATE_FILE = path.join(DATA_DIR, 'queue_state.json');
const BOOKMARKS_FILE = path.join(DATA_DIR, 'bookmarks.json');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');
const MAX_HISTORY = 50;
const crypto = require('crypto');


// Cross-session dedupe: remember every video ID we've successfully downloaded.
// Stored as { [platform]: { [id]: { filePath, at } } }.
let downloadedIdsCache = null;
function loadDownloadedIds() {
  if (downloadedIdsCache) return downloadedIdsCache;
  downloadedIdsCache = readJsonSafe(DOWNLOADED_IDS_FILE, {});
  return downloadedIdsCache;
}

function isAlreadyDownloaded(platform, id) {
  if (!id) return null;
  const all = loadDownloadedIds();
  return all[platform]?.[id] || null;
}

function recordDownloaded(platform, id, filePath) {
  if (!id) return;
  const all = loadDownloadedIds();
  if (!all[platform]) all[platform] = {};
  all[platform][id] = { filePath, at: Date.now() };
  // Best-effort write — don't block downloads on a slow disk
  try { atomicWrite(DOWNLOADED_IDS_FILE, all); } catch (e) { console.warn('IDs save failed:', e.message); }
}

function extractVideoId(task) {
  // Use the explicit id if provided (from listing), else parse the URL
  if (task.videoId) return String(task.videoId);
  const url = task.url || '';
  const m = url.match(/\/video\/(\d+)/) || url.match(/v=([\w-]{11})/) || url.match(/youtu\.be\/([\w-]{11})/);
  return m ? m[1] : null;
}
const TIKWM_CONCURRENCY = 4;          // parallel TikWM lookups for channels
const API_TIMEOUT_MS = 30_000;        // per HTTPS request
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000; // 10 min per file
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;           // 120 req/min per IP

// CORS limited to localhost (the app runs locally only)
const ALLOWED_ORIGINS = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
];

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
      else cb(new Error('CORS blocked'));
    },
  },
});

// ─── Locate yt-dlp once at startup ─────────────────────────────────────────────
function findYtdlp() {
  const isWin = process.platform === 'win32';
  // `where` is Windows-only; macOS/Linux use `which`. The bundled binary is
  // yt-dlp.exe on Windows and plain `yt-dlp` elsewhere — main.js puts both the
  // user-updated and bundled bin dirs at the front of PATH before forking us.
  const result = spawnSync(isWin ? 'where' : 'which', ['yt-dlp'], { encoding: 'utf8' });
  if (result.status === 0) {
    const lines = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const first = isWin ? lines.find((l) => l.endsWith('.exe')) : lines[0];
    if (first) return first;
  }
  // Fallback to PATH lookup at exec time (less safe but functional)
  return isWin ? 'yt-dlp.exe' : 'yt-dlp';
}

const YTDLP_PATH = findYtdlp();
console.log(`yt-dlp: ${YTDLP_PATH}`);

// ─── Instagram support (cookies from browser) ──────────────────────────────────
// Instagram blocks unauthenticated access for most listings (tags, profiles).
// We pull cookies from the user's installed browser so requests look like a
// logged-in user. Default = chrome; configurable via env or settings.
const INSTAGRAM_BROWSER = (process.env.MEDIAGRAB_IG_BROWSER || 'chrome').toLowerCase();

// Parse a Netscape-format cookies.txt into a name→value map. Same format the
// in-app Instagram/Facebook login flow writes, and the same format browser
// extensions like "Get cookies.txt LOCALLY" export.
function parseNetscapeCookies(filePath) {
  const out = {};
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      const [, , , , , name, value] = parts;
      if (name && value !== undefined) out[name] = value;
    }
  } catch { /* file missing or unreadable */ }
  return out;
}

function serializeCookies(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Direct Instagram private-API call. Two flavors depending on host:
//  - www.instagram.com → web app headers (Sec-Ch-Ua, X-IG-WWW-Claim, …)
//  - i.instagram.com   → mobile-app headers (real Instagram Android UA)
// The mobile flavor is more permissive for keyword/clips searches.
function instagramApiGet(apiUrl, cookies) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(apiUrl);
    const isMobileHost = /^i\.instagram\.com$/i.test(parsed.hostname);

    const webHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'X-IG-App-ID': '936619743392459',
      'X-ASBD-ID': '129477',
      'X-IG-WWW-Claim': '0',
      'X-Requested-With': 'XMLHttpRequest',
      'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Referer': 'https://www.instagram.com/',
      'Origin': 'https://www.instagram.com',
    };
    const mobileHeaders = {
      'User-Agent': 'Instagram 309.1.0.41.113 Android (33/13; 480dpi; 1080x2274; samsung; SM-G991B; o1s; exynos2100; en_US; 547253565)',
      'X-IG-App-ID': '567067343352427',           // Android app ID
      'X-IG-Capabilities': '3brTvx0=',
      'X-IG-Connection-Type': 'WIFI',
      'X-IG-Connection-Speed': '-1kbps',
      'X-IG-Bandwidth-Speed-KBPS': '-1.000',
      'X-IG-Bandwidth-TotalBytes-B': '0',
      'X-IG-Bandwidth-TotalTime-MS': '0',
      'Accept-Language': 'en-US, en',
    };

    const headers = Object.assign(
      isMobileHost ? mobileHeaders : webHeaders,
      {
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate',
        'X-CSRFToken': cookies.csrftoken || '',
        'X-Mid': cookies.mid || '',
        'Cookie': serializeCookies(cookies),
      },
    );

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: API_TIMEOUT_MS,
      headers,
    }, (res) => {
      const chunks = [];
      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip') stream = res.pipe(require('zlib').createGunzip());
      else if (encoding === 'br') stream = res.pipe(require('zlib').createBrotliDecompress());
      else if (encoding === 'deflate') stream = res.pipe(require('zlib').createInflate());
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        console.log(`[IG] ${res.statusCode} ${parsed.hostname}${parsed.pathname} (${data.length}b): ${data.slice(0, 200).replace(/\n/g, ' ')}`);
        if (res.statusCode !== 200) {
          return reject(new Error(`Instagram ${res.statusCode} @ ${parsed.hostname}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Non-JSON: ' + data.slice(0, 200))); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Instagram API timed out')));
    req.end();
  });
}


function isInstagramUrl(u) {
  if (typeof u !== 'string') return false;
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'instagram.com' || h.endsWith('.instagram.com');
  } catch { return false; }
}

// Instagram shortcodes (the /p/<code>/ part) are a base64 encoding of the
// numeric media id. Decode it so we can hit the media-info API, which — unlike
// yt-dlp — returns IMAGE posts (yt-dlp's IG extractor only does videos and
// refuses photo posts with "There is no video in this post").
const IG_SC_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function instagramShortcodeToMediaId(shortcode) {
  let id = 0n;
  for (const ch of shortcode) {
    const v = IG_SC_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    id = id * 64n + BigInt(v);
  }
  return id.toString();
}

// Resolve a photo post into its full-resolution image URLs (one per carousel
// slide). Returns [] for videos / on failure so the caller can fall back.
async function instagramResolvePhotoUrls(postUrl, cookiesFile) {
  const m = String(postUrl).match(/\/(?:p|reel|tv)\/([^/?]+)/);
  if (!m) return [];
  const mediaId = instagramShortcodeToMediaId(m[1]);
  if (!mediaId) return [];
  const cookies = parseNetscapeCookies(cookiesFile);
  // No login → can't reach the media-info API at all. Signal it so the caller
  // shows a clear "log in first" message instead of a vague red error.
  if (!cookies.sessionid) throw new Error('IG_LOGIN_REQUIRED');
  const data = await instagramApiGet(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, cookies);
  const item = (data.items && data.items[0]) || null;
  if (!item) return [];
  // A single video that the grid heuristic mislabelled as a photo: don't save
  // its cover image silently — signal the caller to pull the real video.
  if (!item.carousel_media && (item.media_type === 2 || (item.video_versions && item.video_versions.length))) {
    throw new Error('IG_IS_VIDEO');
  }
  const slides = item.carousel_media || [item];
  const urls = [];
  for (const s of slides) {
    // Mixed carousel: a video slide returns its real mp4 (downloadFile names it
    // .mp4 from the content-type), not just a cover image.
    if (s.video_versions && s.video_versions.length) {
      const bestV = s.video_versions.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      if (bestV && bestV.url) { urls.push(bestV.url); continue; }
    }
    // Pick the highest-resolution image candidate (first is usually largest).
    const cands = (s.image_versions2 && s.image_versions2.candidates) || [];
    if (cands.length) {
      const best = cands.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      if (best && best.url) urls.push(best.url);
    }
  }
  return urls;
}

function isFacebookUrl(u) {
  if (typeof u !== 'string') return false;
  try {
    const h = new URL(u).hostname.toLowerCase();
    return /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/i.test(h);
  } catch { return false; }
}


// Pinterest IMAGE pins: yt-dlp's Pinterest extractor only handles VIDEO pins
// and errors on images ("No video formats found"). For images we fetch the pin
// page and pull the full-resolution image straight off i.pinimg.com — the same
// idea as the Instagram photo path. Returns [] for videos / on failure so the
// caller falls back to its original error. Follows one redirect (pin.it links).
function pinterestResolveImageUrls(pinUrl, _depth = 0) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(pinUrl); } catch { return resolve([]); }
    const req = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'GET',
      timeout: API_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      // Follow a single redirect (pin.it short links, locale redirects).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && _depth < 3) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${target.hostname}${res.headers.location}`;
        return resolve(pinterestResolveImageUrls(next, _depth + 1));
      }
      const chunks = [];
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(require('zlib').createGunzip());
      else if (enc === 'br') stream = res.pipe(require('zlib').createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(require('zlib').createInflate());
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        const urls = [];
        // 1) JSON-LD / embedded "contentUrl" (the exact pin media — most precise).
        let m = html.match(/"contentUrl":"(https:\\?\/\\?\/i\.pinimg\.com\\?\/[^"]+)"/);
        if (m) urls.push(m[1].replace(/\\\//g, '/'));
        // 2) og:image meta tag.
        if (!urls.length) {
          m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
          if (m) urls.push(m[1]);
        }
        // 3) Any /originals/ image as a last resort.
        if (!urls.length) {
          m = html.match(/https:\/\/i\.pinimg\.com\/originals\/[A-Za-z0-9/_.-]+\.(?:jpe?g|png|gif|webp)/i);
          if (m) urls.push(m[0]);
        }
        // Upgrade sized thumbnails (e.g. /736x/) to /originals/ for full res.
        const upgraded = urls
          .map((u) => u.replace(/\/(?:\d+x\d*|\d+x)\//, '/originals/'))
          .filter((u) => /^https:\/\/i\.pinimg\.com\//i.test(u));
        resolve([...new Set(upgraded)]);
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(API_TIMEOUT_MS, () => { req.destroy(); resolve([]); });
    req.end();
  });
}



function ytdlpExtraArgsForUrl(targetUrl) {
  const extra = [];
  const dataDir = process.env.MEDIAGRAB_DATA_DIR || path.join(__dirname, 'data');
  if (isInstagramUrl(targetUrl)) {
    // Prefer the cookies file written by the in-app Instagram login flow.
    // Falls back to scraping the user's installed browser only if that file
    // doesn't exist (e.g. fresh install before first login).
    const cookiesFile = path.join(dataDir, 'instagram-cookies.txt');
    if (fs.existsSync(cookiesFile)) {
      extra.push('--cookies', cookiesFile);
    } else {
      extra.push('--cookies-from-browser', INSTAGRAM_BROWSER);
    }
  } else if (isFacebookUrl(targetUrl)) {
    const cookiesFile = path.join(dataDir, 'facebook-cookies.txt');
    if (fs.existsSync(cookiesFile)) {
      extra.push('--cookies', cookiesFile);
    } else {
      extra.push('--cookies-from-browser', INSTAGRAM_BROWSER); // same browser var
    }
  }
  return extra;
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory rate limiter
const rateBuckets = new Map(); // ip -> { count, reset }
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.reset < now) {
    rateBuckets.set(ip, { count: 1, reset: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests, slow down.' });
  }
  bucket.count++;
  next();
}
app.use('/api/', rateLimit);

// ─── Media proxy ───────────────────────────────────────────────────────────────
// TikTok / Instagram / Facebook CDNs reject requests without a matching Referer.
// The UI loads from http://localhost:3456, so direct <img>/<video> tags get
// 403. We proxy through the server, adding the right Referer per host.
const PROXY_ALLOW = [
  /\.tiktokcdn\.com$/i,
  /\.tiktokcdn-us\.com$/i,
  /\.tiktokcdn-eu\.com$/i,
  /\.ttwstatic\.com$/i,
  /\.byteoversea\.com$/i,
  /\.tiktokv\.com$/i,
  /\.tiktokv\.us$/i,
  /\.muscdn\.com$/i,
  /\.cdninstagram\.com$/i,
  /\.fbcdn\.net$/i,
];

// ─── State ─────────────────────────────────────────────────────────────────────
const activeDownloads = new Map();   // id -> { proc, request, status, info, cancelled }
const completedDownloads = [];       // bounded

function pushCompleted(record) {
  completedDownloads.push(record);
  if (completedDownloads.length > MAX_COMPLETED_HISTORY) {
    completedDownloads.splice(0, completedDownloads.length - MAX_COMPLETED_HISTORY);
  }
}

// ─── Path & filename safety ────────────────────────────────────────────────────
const FORBIDDEN_DIRS = process.platform === 'darwin'
  ? ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/private',
     path.join(os.homedir(), 'Library')]
  : [
    'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
    'C:\\ProgramData', path.join(os.homedir(), 'AppData'),
  ];

function validateOutputDir(dir) {
  if (!dir || typeof dir !== 'string') return DEFAULT_OUTPUT_DIR;
  const cleaned = dir.trim();
  if (!cleaned) return DEFAULT_OUTPUT_DIR;
  if (cleaned.includes('..')) throw new Error('Invalid output directory (path traversal)');
  if (!path.isAbsolute(cleaned)) throw new Error('Output directory must be absolute');
  const resolved = path.resolve(cleaned);
  // Compare with a trailing separator on BOTH sides: a bare prefix check would
  // read "/Users/ahmed/…" as living under "/usr" and reject the user's own
  // home folder on macOS.
  const target = (resolved.toLowerCase() + path.sep);
  for (const forbidden of FORBIDDEN_DIRS) {
    if (target.startsWith(forbidden.toLowerCase() + path.sep)) {
      throw new Error(`Cannot write to system directory: ${forbidden}`);
    }
  }
  return resolved;
}

function sanitizeFilename(name) {
  // Cap at 80 chars to stay well clear of Windows' 260-char MAX_PATH limit
  // once the output dir + subfolder + extension are factored in. Long
  // Instagram/TikTok captions used to blow past this and break shell.openPath.
  return String(name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80)
    // Windows can't create/delete names ending in a dot or space (and the
    // product name often ends in "…"), which leaves un-deletable folders.
    .replace(/[. ]+$/, '')
    .trim() || 'video';
}

function isHttpUrl(s) {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function applyFilenameTemplate(template, vars) {
  let out = template || '{title}';
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), v != null ? String(v) : '');
  }
  return sanitizeFilename(out);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// If `dest` exists, append ` (1)`, ` (2)`, … to the basename until a free name is found.
function uniquePath(dest) {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

// ─── HTTPS helper with timeout ─────────────────────────────────────────────────
function apiRequest(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(reqUrl); } catch { return reject(new Error('Invalid URL')); }

    const isPost = options.method === 'POST';
    const postData = options.body
      ? (typeof options.body === 'string' ? options.body : new URLSearchParams(options.body).toString())
      : '';

    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: isPost ? 'POST' : 'GET',
      timeout: options.timeout ?? API_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.tikwm.com/',
        ...(isPost ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        } : {}),
      },
    };

    const proto = parsed.protocol === 'https:' ? https : http;
    const req = proto.request(reqOpts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        apiRequest(res.headers.location, options).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch {
          reject(new Error(`Non-JSON response from ${parsed.hostname} (status ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`Request to ${parsed.hostname} timed out`)); });
    if (isPost) req.write(postData);
    req.end();
  });
}

// ─── Concurrency limiter ───────────────────────────────────────────────────────
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(
      (v) => { active--; resolve(v); next(); },
      (e) => { active--; reject(e); next(); }
    );
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

const tikwmLimiter = createLimiter(TIKWM_CONCURRENCY);

// ─── TikWM ─────────────────────────────────────────────────────────────────────
// Serialize TikWM single-video calls (Free API: 1 req/sec)
let tikwmLastCallAt = 0;
const TIKWM_MIN_INTERVAL = 1100; // ms

async function tikwmSerializedRequest(reqUrl, options) {
  const now = Date.now();
  const wait = Math.max(0, tikwmLastCallAt + TIKWM_MIN_INTERVAL - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  tikwmLastCallAt = Date.now();
  return apiRequest(reqUrl, options);
}


async function tikwmGetVideo(videoUrl, retries = 4) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      // TikWM /api/?url=... now requires POST + form data (GET is Cloudflare-gated).
      const data = await tikwmSerializedRequest('https://www.tikwm.com/api/', {
        method: 'POST',
        body: { url: videoUrl, hd: 1 },
      });
      if (data.code === 0 && data.data) {
        const d = data.data;
        // Photo/slideshow posts come back with an `images` array and no
        // playable video — surface it so the download path can pull the images.
        const images = Array.isArray(d.images) ? d.images.filter(Boolean)
          : (d.images ? [d.images] : null);
        return {
          id: d.id,
          play: d.play,
          hdplay: d.hdplay,
          images: (images && images.length) ? images : null,
          title: d.title,
          cover: d.cover || d.origin_cover,
          music: d.music,
          duration: d.duration,
          author: d.author,
          play_count: d.play_count,
        };
      }
      lastErr = data.msg || 'TikWM error';
      // Back off harder on rate limits
      const isRateLimit = /limit/i.test(data.msg || '');
      const delay = isRateLimit ? 1500 * (i + 1) : 800;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, delay));
    } catch (e) {
      lastErr = e.message;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.log(`tikwmGetVideo failed for ${videoUrl}: ${lastErr}`);
  return null;
}

// ─── File download with progress, timeout, extension detection ─────────────────
function downloadFile(fileUrl, destBase, downloadId, title) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(fileUrl); } catch { return reject(new Error('Invalid file URL')); }
    const proto = parsed.protocol === 'https:' ? https : http;

    const req = proto.get(fileUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: DOWNLOAD_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, destBase, downloadId, title).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      // Detect extension from content-type
      const ct = (res.headers['content-type'] || '').toLowerCase();
      let ext = '.mp4';
      if (ct.includes('video/webm')) ext = '.webm';
      else if (ct.includes('video/quicktime')) ext = '.mov';
      else if (ct.includes('audio/mpeg') || ct.includes('audio/mp3')) ext = '.mp3';
      else if (ct.includes('audio/mp4') || ct.includes('audio/m4a')) ext = '.m4a';
      else if (ct.includes('image/jpeg')) ext = '.jpg';
      else if (ct.includes('image/png')) ext = '.png';
      else if (ct.includes('image/webp')) ext = '.webp';
      else if (ct.includes('image/gif')) ext = '.gif';

      const destWithExt = destBase.endsWith(ext) ? destBase : destBase.replace(/\.[a-z0-9]{2,4}$/i, '') + ext;
      const dest = uniquePath(destWithExt);

      const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
      let receivedBytes = 0;
      let lastEmit = 0;
      const startTime = Date.now();

      const fileStream = fs.createWriteStream(dest);

      // Track for cancel
      const entry = activeDownloads.get(downloadId);
      if (entry) { entry.request = req; entry.fileStream = fileStream; }

      res.on('data', (chunk) => {
        // Abort the moment the user cancels — without this, a fast TikTok
        // download finishes before cancel-all's destroy() takes effect.
        if (entry && entry.cancelled) {
          try { req.destroy(); } catch {}
          try { fileStream.destroy(); } catch {}
          reject(new Error('Cancelled'));
          return;
        }
        receivedBytes += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 250) {
          lastEmit = now;
          const elapsed = (now - startTime) / 1000;
          const speedBps = receivedBytes / Math.max(elapsed, 0.1);
          const speedTxt = formatBytes(speedBps) + '/s';
          if (totalBytes > 0) {
            const progress = Math.round((receivedBytes / totalBytes) * 100);
            const remaining = (totalBytes - receivedBytes) / Math.max(speedBps, 1);
            emitProgress(downloadId, {
              title, progress, speed: speedTxt,
              eta: formatEta(remaining),
              downloaded: receivedBytes, total: totalBytes,
              status: 'downloading',
            });
          } else {
            // No content-length — emit indeterminate progress with bytes received
            emitProgress(downloadId, {
              title, progress: 0, speed: speedTxt,
              downloaded: receivedBytes, total: 0,
              status: 'downloading',
            });
          }
        }
      });

      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve(dest);
      });
      fileStream.on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Download timed out')));

    const entry = activeDownloads.get(downloadId);
    if (entry) entry.request = req;
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ─── Socket emit ───────────────────────────────────────────────────────────────
function emitProgress(id, data) {
  const status = data.status || 'downloading';
  const eventMap = {
    downloading: 'download:progress',
    completed: 'download:complete',
    error: 'download:error',
    cancelled: 'download:cancelled',
    queued: 'download:queued',
  };
  io.emit(eventMap[status] || 'download:progress', { id, ...data });
}

// ─── yt-dlp ────────────────────────────────────────────────────────────────────
function buildYtdlpFormat(quality) {
  if (quality === 'audio') return 'bestaudio[ext=m4a]/bestaudio';
  if (quality === '1080') return 'bestvideo[height<=1080]+bestaudio/best[height<=1080]';
  if (quality === '720')  return 'bestvideo[height<=720]+bestaudio/best[height<=720]';
  if (quality === '480')  return 'bestvideo[height<=480]+bestaudio/best[height<=480]';
  if (quality === '360')  return 'bestvideo[height<=360]+bestaudio/best[height<=360]';
  return 'best[ext=mp4]/best';
}

const YTDLP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function ytdlpDownload(ytdlpUrl, outputDir, downloadId, title, quality, filenameBase, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!isHttpUrl(ytdlpUrl)) return reject(new Error('Invalid URL'));

    const { speedLimitKBps = 0, downloadSubs = false, cookiesFile = '', customArgs = '' } = opts;
    const effectiveQuality = opts.taskQuality || quality;

    const safeName = sanitizeFilename(filenameBase || title || '%(title)s');
    const ext = effectiveQuality === 'audio' ? '%(ext)s' : 'mp4';
    const outputTemplate = path.join(outputDir, `${safeName}.${ext}`);

    const args = [
      ytdlpUrl,
      '-f', buildYtdlpFormat(effectiveQuality),
      '-o', outputTemplate,
      '--no-playlist',
      '--newline',
      '--no-warnings',
      '--no-overwrites',
      // NOTE: --restrict-filenames is DELIBERATELY off. It strips non-ASCII
      // chars from the WHOLE path including the parent dir, so our computed
      // taskOutputDir (with Arabic in the subfolder name) wouldn't match the
      // actual write location yt-dlp picks. The output template (-o) below
      // controls filename safety on our terms.
      '--user-agent', YTDLP_UA,
      '--sleep-requests', '1',
    ];
    if (effectiveQuality !== 'audio') {
      args.push('--merge-output-format', 'mp4');
      // For Instagram in particular yt-dlp will happily return image
      // carousel slots as the "best format" — explicitly require a video
      // stream so it errors out on photo posts instead of silently
      // downloading a JPG with .mp4 extension.
      if (isInstagramUrl(ytdlpUrl)) {
        args.push('--match-filter', 'duration>0');
      }
    } else {
      args.push('-x', '--audio-format', 'mp3');
    }
    if (speedLimitKBps > 0) args.push('--limit-rate', `${speedLimitKBps}K`);
    if (downloadSubs) args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'all', '--convert-subs', 'srt');
    if (cookiesFile && fs.existsSync(cookiesFile)) args.push('--cookies', cookiesFile);
    // Auto-inject browser cookies for Instagram so logged-in scraping works
    args.push(...ytdlpExtraArgsForUrl(ytdlpUrl));
    if (customArgs) {
      // Split safely on whitespace, preserving quoted segments.
      const extra = customArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      for (const a of extra) args.push(a.replace(/^"|"$/g, ''));
    }

    // No shell — pass absolute path so Windows finds the .exe
    const proc = spawn(YTDLP_PATH, args, { windowsHide: true });

    const entry = activeDownloads.get(downloadId);
    if (entry) entry.proc = proc;

    let lastFile = '';
    let stderrTail = ''; // keep the last bit of stderr to classify failures

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      for (const line of text.split('\n')) {
        const destMatch = line.match(/Destination:\s+(.+)/);
        if (destMatch) lastFile = destMatch[1].trim();
        const mergeMatch = line.match(/Merging formats into "(.+)"/);
        if (mergeMatch) lastFile = mergeMatch[1].trim();
        const info = parseYtdlpProgress(line.trim());
        if (info) {
          emitProgress(downloadId, {
            title, progress: info.progress,
            speed: info.speed || '', eta: info.eta || '',
            status: 'downloading',
          });
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      for (const line of text.split('\n')) {
        const info = parseYtdlpProgress(line.trim());
        if (info) {
          emitProgress(downloadId, {
            title, progress: info.progress,
            speed: info.speed || '', eta: info.eta || '',
            status: 'downloading',
          });
        }
      }
    });

    proc.on('close', (code) => {
      if (entry?.cancelled) return reject(new Error('Cancelled'));
      if (code === 0) {
        // Prefer the path WE built (correct Node string encoding) over the one
        // parsed from yt-dlp's stdout, which mangles non-ASCII parent dirs into
        // spaces on Windows (the cause of "Windows cannot find E:\ \ \..mp4" and
        // "تعذّر فتح المجلد"). Only usable when safeName is a concrete name.
        if (!/%\(/.test(safeName)) {
          const finalExt = effectiveQuality === 'audio' ? 'mp3' : 'mp4';
          const built = path.join(outputDir, `${safeName}.${finalExt}`);
          try {
            if (fs.existsSync(built) || fs.existsSync('\\\\?\\' + built)) return resolve(built);
          } catch {}
        }
        return resolve(lastFile || outputDir);
      }
      // 101 = item rejected by --match-filter (e.g. an Instagram photo post
      // failing duration>0). Surface it as a friendly "not a video" message
      // so the UI can show it as skipped, not a hard error.
      if (code === 101) return reject(new Error('NOT_A_VIDEO'));
      // Pinterest (and the odd other site) returns image-only items as having
      // "No video formats". The Pinterest path keys its image fallback off this
      // exact reason so a transient video failure doesn't grab a cover image.
      if (/No video formats found|There is no video|Requested format is not available/i.test(stderrTail)) {
        return reject(new Error('NO_VIDEO_FORMATS'));
      }
      reject(new Error(`yt-dlp exited with code ${code}`));
    });

    proc.on('error', (err) => {
      reject(new Error(`yt-dlp spawn failed: ${err.message}`));
    });
  });
}

// Extract MP3 audio from a downloaded video using bundled ffmpeg. Used by the
// TikTok 🎵 button — TikWM gives us video URLs only, so the actual conversion
// has to happen client-side after download.
function extractAudioToMp3(srcVideoPath, destMp3Path) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y', '-i', srcVideoPath,
      '-vn',                 // drop video stream
      '-acodec', 'libmp3lame',
      '-q:a', '2',           // VBR ~190kbps, good quality
      destMp3Path,
    ], { windowsHide: true });
    let stderrBuf = '';
    proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(destMp3Path);
      else reject(new Error(`ffmpeg exited ${code}: ${stderrBuf.slice(-400)}`));
    });
    proc.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
  });
}

function parseYtdlpProgress(line) {
  const match = line.match(
    /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\S+)\s+at\s+([\d.]+\S+\/s)\s+ETA\s+(\S+)/
  );
  if (match) {
    return {
      progress: Math.round(parseFloat(match[1])),
      speed: match[3],
      eta: match[4],
    };
  }
  if (line.includes('has already been downloaded')) {
    return { progress: 100, speed: '-', eta: '00:00' };
  }
  return null;
}

// 5-min cache + stale-on-error fallback. TikTok rate-limits aggressively, so
// returning a slightly stale listing beats failing the user request.
const ytdlpInfoCache = new Map(); // key -> { value, expiresAt }
const YTDLP_CACHE_TTL = 5 * 60_000;
const YTDLP_STALE_TTL = 60 * 60_000; // keep stale entries for 1 hour as fallback

function _ytdlpInfoCached(key, factory) {
  const now = Date.now();
  const hit = ytdlpInfoCache.get(key);
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.value);

  return factory().then((value) => {
    ytdlpInfoCache.set(key, { value, expiresAt: now + YTDLP_CACHE_TTL, storedAt: now });
    // garbage collect entries older than stale TTL
    for (const [k, v] of ytdlpInfoCache) {
      if ((v.storedAt || v.expiresAt) + YTDLP_STALE_TTL < now) ytdlpInfoCache.delete(k);
    }
    return value;
  }).catch((err) => {
    const isRateLimit = /429|too many requests|rate limit/i.test(err.message || '');
    if (isRateLimit && hit) {
      // Stale-while-error: return the previous successful response.
      console.log(`Returning stale cache for ${key} due to rate limit`);
      return hit.value;
    }
    if (isRateLimit) {
      throw new Error('TikTok مؤقتاً يحظر الطلبات (429). انتظر 5-10 دقائق وحاول مرة أخرى.');
    }
    throw err;
  });
}

function ytdlpInfo(targetUrl, flat = false, opts = {}) {
  const cacheKey = `${flat ? 'F' : 'S'}::${targetUrl}::${opts.playlistEnd || 'all'}`;
  return _ytdlpInfoCached(cacheKey, () => _ytdlpInfoRaw(targetUrl, flat, opts));
}


function _ytdlpInfoRaw(targetUrl, flat = false, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!isHttpUrl(targetUrl) && !targetUrl.startsWith('ytsearch')) {
      return reject(new Error('Invalid URL'));
    }
    const onItem = typeof opts.onItem === 'function' ? opts.onItem : null;
    const playlistEnd = opts.playlistEnd; // undefined = no limit (full channel)
    const baseArgs = [
      '--no-warnings',
      '--user-agent', YTDLP_UA,
      // Listings: 0.5s between requests (was 2s — too slow for big channels).
      // If we hit 429, the cache + retry layer kicks in.
      '--sleep-requests', flat ? '0.5' : '1',
      ...ytdlpExtraArgsForUrl(targetUrl),
    ];
    const args = flat
      ? [
          ...baseArgs,
          '--flat-playlist', '--dump-json',
          ...(playlistEnd ? ['--playlist-end', String(playlistEnd)] : []),
          targetUrl,
        ]
      : [...baseArgs, '--dump-json', '--no-playlist', targetUrl];

    const proc = spawn(YTDLP_PATH, args, { windowsHide: true });

    let stdoutBuf = '';
    let stderr = '';
    const items = [];
    // 10 min for playlist scans — large TikTok profiles can have 2000+ videos
    // and yt-dlp paginates at ~10 items/sec, so 5 min wasn't enough.
    const timeoutMs = flat ? 10 * 60_000 : 60_000;
    const timeout = setTimeout(() => {
      try { killProcessTree(proc); } catch {}
      reject(new Error('yt-dlp info timed out'));
    }, timeoutMs);

    // Parse stdout line-by-line so we can stream items via onItem callback.
    proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const item = JSON.parse(line);
          items.push(item);
          if (onItem) { try { onItem(item, items.length); } catch {} }
        } catch { /* ignore non-JSON lines */ }
      }
    });
    proc.stderr.on('data', (d) => (stderr += d));

    proc.on('close', (code) => {
      clearTimeout(timeout);
      // Flush any trailing line
      const trail = stdoutBuf.trim();
      if (trail) {
        try {
          const item = JSON.parse(trail);
          items.push(item);
          if (onItem) { try { onItem(item, items.length); } catch {} }
        } catch {}
      }
      if (code !== 0) return reject(new Error(stderr.trim() || `yt-dlp exited ${code}`));
      if (items.length === 0) return reject(new Error('No items parsed from yt-dlp output'));
      resolve(items.length === 1 ? items[0] : items);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`yt-dlp spawn failed: ${err.message}`));
    });
  });
}

// Active listing sessions — so we can stop them mid-fetch.
const activeListings = new Map(); // sessionId -> { proc, items, onItem }


// ─── Cancel (Windows-aware) ────────────────────────────────────────────────────
function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32' && proc.pid) {
    spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true });
  } else {
    try { proc.kill('SIGTERM'); } catch {}
  }
}

function isTikTokUser(tikUrl) {
  return /tiktok\.com\/@[^/]+\/?(\?.*)?$/i.test(tikUrl) && !/\/video\//i.test(tikUrl);
}

// ─── Routes ────────────────────────────────────────────────────────────────────


// Per-server download concurrency limiter (default 3, override via setting)
let downloadLimiter = createLimiter(3);
let currentConcurrency = 3;
function setConcurrency(n) {
  const v = Math.max(1, Math.min(10, parseInt(n, 10) || 3));
  if (v !== currentConcurrency) {
    currentConcurrency = v;
    downloadLimiter = createLimiter(v);
  }
}

// POST /api/download
app.post('/api/download', async (req, res) => {
  try {
    const {
      url: targetUrl,
      platform,
      outputDir: rawOutputDir,
      type = 'single',
      selectedVideos = [],
      id: clientId,
      downloadUrl: clientDownloadUrl,
      hdDownloadUrl: clientHdDownloadUrl,
      quality = 'best',
      filenameTemplate = '{title}',
      concurrent,
      skipExisting = true,
      organizeByAuthor = false,
      speedLimitKBps = 0,
      downloadSubs = false,
      cookiesFile = '',
      customArgs = '',
      subfolder = '',
      autoRetry = 2,        // try up to N extra times on failure
      ignoreGlobalDedupe = false, // bypass cross-session dedupe (per-product folders)
    } = req.body || {};

    if (!targetUrl && (!Array.isArray(selectedVideos) || selectedVideos.length === 0)) {
      return res.status(400).json({ error: 'URL or selectedVideos required' });
    }
    if (targetUrl && !isHttpUrl(targetUrl)) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    let outputDir;
    try { outputDir = validateOutputDir(rawOutputDir); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    ensureDir(outputDir);

    if (concurrent != null) setConcurrency(concurrent);

    const plat = (platform || '').toLowerCase();
    const tasks = [];

    if (type === 'batch' && selectedVideos.length > 0) {
      for (const video of selectedVideos) {
        if (video.url && !isHttpUrl(video.url)) continue;
        tasks.push({
          // Honor client-provided id so progress events match the client queue item
          id: video.id || uuidv4(),
          url: video.url || targetUrl,
          title: video.title || 'Video',
          downloadUrl: video.downloadUrl || null,
          hdDownloadUrl: video.hdDownloadUrl || null,
          author: video.author || '',
          platform: video.platform || plat,
          videoId: video.videoId || null,
          kind: video.kind || null,
        });
      }
    } else {
      tasks.push({
        id: clientId || uuidv4(),
        url: targetUrl,
        title: (req.body?.title && String(req.body.title).trim()) || '',
        downloadUrl: clientDownloadUrl || null,
        hdDownloadUrl: clientHdDownloadUrl || null,
        author: req.body?.author || '',
        platform: plat,
        videoId: req.body?.videoId || null,
      });
    }

    // TikTok user/channel expansion
    if (plat === 'tiktok' && tasks.length === 1 && !tasks[0].downloadUrl) {
      const taskUrl = tasks[0].url;
      if (isTikTokUser(taskUrl)) {
        const username = taskUrl.match(/@([^/?]+)/)?.[1];
        try {
          const cleanUrl = `https://www.tiktok.com/@${username}`;
          const info = await ytdlpInfo(cleanUrl, true);
          const videos = Array.isArray(info) ? info : [info];
          tasks.length = 0;
          const enriched = await Promise.all(videos.map((v) => tikwmLimiter(async () => {
            const videoUrl = v.url || v.webpage_url;
            const tikInfo = await tikwmGetVideo(videoUrl);
            return {
              id: uuidv4(),
              url: videoUrl,
              title: (tikInfo?.title || v.title || `Video ${v.id}`).substring(0, 100),
              downloadUrl: tikInfo?.play || null,
              hdDownloadUrl: tikInfo?.hdplay || null,
              // Photo posts in a profile: carry the slides + music too.
              images: (tikInfo?.images && tikInfo.images.length) ? tikInfo.images : null,
              musicUrl: tikInfo?.music || null,
              author: username,
              platform: 'tiktok',
            };
          })));
          tasks.push(...enriched);
        } catch (err) {
          console.log(`yt-dlp user listing failed for @${username}: ${err.message}`);
          return res.status(500).json({ error: `فشل جلب فيديوهات @${username}: ${err.message}` });
        }
      } else if (!tasks[0].downloadUrl && !tasks[0].hdDownloadUrl) {
        const tikInfo = await tikwmGetVideo(taskUrl);
        if (tikInfo) {
          tasks[0].title = tikInfo.title || tasks[0].title;
          tasks[0].downloadUrl = tikInfo.play;
          tasks[0].hdDownloadUrl = tikInfo.hdplay;
          // Carry photo-post images + music so runDownloadOnce downloads the
          // slides (not the background audio). Without this the pre-resolve sets
          // downloadUrl=audio and the images get dropped.
          if (tikInfo.images && tikInfo.images.length) tasks[0].images = tikInfo.images;
          if (tikInfo.music) tasks[0].musicUrl = tikInfo.music;
        }
      }
    }

    // Respond immediately with task IDs so the client can render queue items
    res.json({ success: true, downloads: tasks.map((t) => ({ id: t.id, title: t.title })) });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Process downloads with real concurrency + per-task auto-retry
    for (const task of tasks) {
      activeDownloads.set(task.id, { status: 'queued', info: task, cancelled: false });
      emitProgress(task.id, { title: task.title, progress: 0, speed: '', status: 'queued' });

      downloadLimiter(async () => {
        const entry = activeDownloads.get(task.id);
        if (!entry || entry.cancelled) return;

        // Run once with up to `autoRetry` extra attempts.
        let lastErr = null;
        for (let attempt = 0; attempt <= autoRetry; attempt++) {
          if (entry.cancelled) return;
          if (attempt > 0) {
            const delay = 2000 * attempt;
            emitProgress(task.id, {
              title: task.title, progress: 0, speed: '',
              status: 'queued', error: `إعادة محاولة ${attempt}/${autoRetry} بعد ${delay/1000}s...`,
            });
            await sleep(delay);
            if (entry.cancelled) return;
          }
          try {
            await runDownloadOnce(task, entry, {
              outputDir, plat, quality, filenameTemplate,
              skipExisting, organizeByAuthor, subfolder,
              speedLimitKBps, downloadSubs, cookiesFile, customArgs,
              ignoreGlobalDedupe,
            });
            return; // success
          } catch (err) {
            lastErr = err;
            // Known dead-ends (photo posts, login needed, unresolvable pins).
            // Don't retry — surface a clear graceful skip, not a red error.
            const skipMsg = gracefulSkipMessage(err.message);
            if (skipMsg) {
              emitProgress(task.id, {
                title: task.title, progress: 100, speed: '',
                status: 'completed', skipped: true,
                error: skipMsg,
              });
              activeDownloads.delete(task.id);
              return;
            }
            console.log(`Attempt ${attempt + 1} failed for ${task.id}: ${err.message}`);
          }
        }

        // All attempts failed
        emitProgress(task.id, {
          title: task.title, progress: 0, speed: '',
          status: entry.cancelled ? 'cancelled' : 'error',
          error: lastErr?.message || 'فشل بعد كل المحاولات',
        });
        activeDownloads.delete(task.id);
      }).catch((err) => {
        console.error(`Limiter error for ${task.id}:`, err);
      });
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Map a known dead-end error signal to a friendly Arabic skip message. Returns
// null for genuine failures (which should retry / surface as a red error).
function gracefulSkipMessage(msg) {
  if (!msg) return null;
  if (/NOT_A_VIDEO/.test(msg))       return 'تخطّى — البوست ده صور مش فيديو';
  if (/IG_LOGIN_REQUIRED/.test(msg)) return 'محتاج تسجّل دخول انستجرام من الإعدادات الأول عشان تنزّل الصور';
  if (/IG_NO_MEDIA/.test(msg))       return 'تخطّى — مش لاقي صور في البوست ده';
  if (/FB_NOT_VIDEO/.test(msg))      return 'تخطّى — ده مش فيديو على فيسبوك';
  if (/PIN_UNRESOLVABLE/.test(msg))  return 'تخطّى — مش قادر أجيب المحتوى من البِن ده (غالباً idea/story pin)';
  return null;
}

// Single attempt at downloading a task. Throws on failure so the caller can retry.
async function runDownloadOnce(task, entry, ctx) {
  const {
    outputDir, plat, quality, filenameTemplate,
    skipExisting, organizeByAuthor, subfolder,
    speedLimitKBps, downloadSubs, cookiesFile, customArgs,
    ignoreGlobalDedupe,
  } = ctx;

  emitProgress(task.id, { title: task.title, progress: 0, speed: '', status: 'downloading' });

  let filePath;
  // Fall back to a unique-ish placeholder if title is empty, so TikTok results
  // with no title don't all collapse to "video.mp4".
  const vidId = extractVideoId(task);
  const titleForName = (task.title && String(task.title).trim())
    || (vidId ? `Video ${vidId}` : `Video ${String(task.id).slice(0, 8)}`);
  const filenameBase = applyFilenameTemplate(filenameTemplate, {
    title: titleForName,
    author: task.author,
    id: task.id,
    platform: task.platform || plat,
    quality,
  });

  let taskOutputDir = outputDir;
  if (subfolder) {
    taskOutputDir = path.join(outputDir, sanitizeFilename(subfolder));
    ensureDir(taskOutputDir);
  } else if (organizeByAuthor && task.author) {
    taskOutputDir = path.join(outputDir, sanitizeFilename(task.author));
    ensureDir(taskOutputDir);
  }

  // Cross-session dedupe (skipped for per-product folder downloads so the
  // same video can live in each product's folder).
  if (skipExisting && !ignoreGlobalDedupe) {
    const vid = extractVideoId(task);
    const prior = isAlreadyDownloaded(plat, vid);
    if (prior && fs.existsSync(prior.filePath)) {
      emitProgress(task.id, {
        title: task.title, progress: 100, speed: '',
        status: 'completed', filePath: prior.filePath,
        skipped: true, dedupe: true,
      });
      pushCompleted({
        id: task.id, title: task.title, platform: plat,
        filePath: prior.filePath, completedAt: new Date().toISOString(),
        skipped: true, dedupe: true,
      });
      activeDownloads.delete(task.id);
      return;
    }
  }

  if (task.platform === 'facebook-ad' && task.downloadUrl) {
    // Facebook Ad Library creative: scontent image or progressive video URL is
    // already direct + public (signed). Pull it straight — yt-dlp isn't needed
    // and can't read these. downloadFile picks the real extension from the
    // response content-type, so the passed base ext is only a hint.
    // Each creative is filed under a folder named after the advertiser page.
    let adDir = taskOutputDir;
    if (task.author) { adDir = path.join(taskOutputDir, sanitizeFilename(task.author)); ensureDir(adDir); }
    const ext = task.kind === 'video' ? '.mp4' : '.jpg';
    const destBase = uniquePath(path.join(adDir, filenameBase + ext));
    filePath = await downloadFile(task.downloadUrl, destBase, task.id, task.title);
  } else if (plat === 'tiktok') {
    if (!task.downloadUrl && !task.hdDownloadUrl && !(task.images && task.images.length)) {
      const tikInfo = await tikwmGetVideo(task.url);
      if (tikInfo) {
        task.downloadUrl = tikInfo.play;
        task.hdDownloadUrl = tikInfo.hdplay;
        task.title = tikInfo.title || task.title;
        if (tikInfo.images && tikInfo.images.length) task.images = tikInfo.images;
        if (tikInfo.music) task.musicUrl = tikInfo.music;
      }
    }
    const videoUrl = task.hdDownloadUrl || task.downloadUrl;

    if (task.images && task.images.length) {
      // Photo/slideshow post. An `images` array is TikWM's authoritative signal
      // for a photo post — and for these its `play` is just the background audio
      // (or an auto-generated slideshow), NOT the real content. So images win
      // over any `play` URL here; we only fall to the video path when there are
      // no images at all.
      if (quality === 'audio' && task.musicUrl) {
        // Audio mode: there are no video frames to extract from, so pull the
        // post's music track directly. downloadFile names it from the
        // content-type; convert to mp3 if it came back as m4a/other.
        const tmp = uniquePath(path.join(taskOutputDir, filenameBase + '.mp3'));
        filePath = await downloadFile(task.musicUrl, tmp, task.id, task.title);
        if (!/\.mp3$/i.test(filePath)) {
          const mp3Path = uniquePath(filePath.replace(/\.[a-z0-9]+$/i, '.mp3'));
          emitProgress(task.id, { title: task.title, progress: 99, speed: '', status: 'downloading', eta: 'converting' });
          await extractAudioToMp3(filePath, mp3Path);
          try { fs.unlinkSync(filePath); } catch {}
          filePath = mp3Path;
        }
      } else {
        // Download each slide straight (like Instagram photos / Pinterest image
        // pins). downloadFile detects the real extension from the content-type,
        // so the .jpg here is only a hint.
        let saved = '';
        for (let i = 0; i < task.images.length; i++) {
          if (entry.cancelled) throw new Error('Cancelled');
          const suffix = task.images.length > 1 ? `_${String(i + 1).padStart(2, '0')}` : '';
          const destBase = uniquePath(path.join(taskOutputDir, `${filenameBase}${suffix}.jpg`));
          saved = await downloadFile(task.images[i], destBase, task.id, task.title);
          emitProgress(task.id, {
            title: task.title, status: 'downloading',
            progress: Math.round(((i + 1) / task.images.length) * 100), speed: '',
          });
        }
        filePath = saved;
      }
    } else {
    // Skip-if-exists: filenames are now unique per video (title-derived), so
    // a same-named file in the target folder really IS this video. Either the
    // user already downloaded it earlier, or — for audio mode — already
    // extracted the MP3. Either way, no need to re-download.
    const expectedExt = quality === 'audio' ? '.mp3' : '.mp4';
    const expectedPath = path.join(taskOutputDir, filenameBase + expectedExt);
    if (skipExisting && fs.existsSync(expectedPath)) {
      emitProgress(task.id, {
        title: task.title, progress: 100, speed: '',
        status: 'completed', filePath: expectedPath, skipped: true,
      });
      pushCompleted({
        id: task.id, title: task.title, platform: plat,
        filePath: expectedPath, completedAt: new Date().toISOString(),
        skipped: true,
      });
      recordDownloaded(plat, extractVideoId(task), expectedPath);
      activeDownloads.delete(task.id);
      return;
    }

    // yt-dlp fallback — handles TikTok Shop / gated videos TikWM can't resolve,
    // and prevents one failure from looping slow TikWM retries (limiter pile-up).
    const ttYtdlpFallback = () => {
      const ttCookies = path.join(process.env.MEDIAGRAB_DATA_DIR || '', 'tiktok-cookies.txt');
      const ck = fs.existsSync(ttCookies) ? ttCookies : (cookiesFile || '');
      return ytdlpDownload(task.url, taskOutputDir, task.id, task.title, quality, filenameBase, {
        speedLimitKBps, downloadSubs, cookiesFile: ck, customArgs, taskQuality: task.quality,
      });
    };

    if (!videoUrl) {
      // TikWM couldn't resolve it (e.g. TikTok Shop video) → let yt-dlp try.
      filePath = await ttYtdlpFallback();
    } else {
      // uniquePath stays as a final guard against rare title collisions.
      const destBase = uniquePath(path.join(taskOutputDir, filenameBase + '.mp4'));
      try {
        filePath = await downloadFile(videoUrl, destBase, task.id, task.title);
      } catch (dlErr) {
        if (entry.cancelled) throw new Error('Cancelled');
        try {
          const freshInfo = await tikwmGetVideo(task.url);
          if (freshInfo && (freshInfo.play || freshInfo.hdplay)) {
            filePath = await downloadFile(freshInfo.hdplay || freshInfo.play, destBase, task.id, task.title);
          } else {
            filePath = await ttYtdlpFallback();
          }
        } catch (e2) {
          if (entry.cancelled) throw new Error('Cancelled');
          filePath = await ttYtdlpFallback(); // last resort
        }
      }
    }

    // Audio-only mode: TikWM gives us video; convert to MP3 with ffmpeg and
    // discard the source .mp4. (yt-dlp's audio path already yields audio, so
    // only convert when we actually got an .mp4 from downloadFile.)
    if (quality === 'audio' && /\.mp4$/i.test(filePath)) {
      const mp3Path = uniquePath(filePath.replace(/\.mp4$/i, '.mp3'));
      emitProgress(task.id, { title: task.title, progress: 99, speed: '', status: 'downloading', eta: 'converting' });
      await extractAudioToMp3(filePath, mp3Path);
      try { fs.unlinkSync(filePath); } catch {}
      filePath = mp3Path;
    }
    }
  } else if (plat === 'instagram' && task.kind === 'photo') {
    // Image post (single or carousel). yt-dlp can't fetch IG photos, so we
    // resolve the real image CDN URLs from the media-info API and pull them
    // straight with downloadFile (which adds the right Instagram Referer).
    const igCookies = path.join(process.env.MEDIAGRAB_DATA_DIR || path.join(__dirname, 'data'), 'instagram-cookies.txt');
    let imgUrls;
    try {
      imgUrls = await instagramResolvePhotoUrls(task.url, igCookies);
    } catch (e) {
      if (/IG_IS_VIDEO/.test(e.message)) {
        // Grid mislabelled a video as a photo — pull the real video with yt-dlp
        // (it injects the IG cookies automatically) instead of a cover image.
        filePath = await ytdlpDownload(task.url, taskOutputDir, task.id, task.title, quality, filenameBase, {
          speedLimitKBps, downloadSubs, cookiesFile, customArgs, taskQuality: task.quality, kind: 'video',
        });
        imgUrls = null; // already downloaded as video
      } else {
        throw e; // IG_LOGIN_REQUIRED (or other) → graceful-skip handler upstream
      }
    }
    if (imgUrls) {
      if (!imgUrls.length) throw new Error('IG_NO_MEDIA');
      let saved = '';
      for (let i = 0; i < imgUrls.length; i++) {
        if (entry.cancelled) throw new Error('Cancelled');
        const suffix = imgUrls.length > 1 ? `_${String(i + 1).padStart(2, '0')}` : '';
        const destBase = uniquePath(path.join(taskOutputDir, `${filenameBase}${suffix}.jpg`));
        saved = await downloadFile(imgUrls[i], destBase, task.id, task.title);
        emitProgress(task.id, {
          title: task.title, status: 'downloading',
          progress: Math.round(((i + 1) / imgUrls.length) * 100), speed: '',
        });
      }
      filePath = saved;
    }
  } else if (plat === 'pinterest') {
    // Video pins: yt-dlp handles them (incl. HLS → mp4). Image pins: yt-dlp
    // refuses ("No video formats found"), so we resolve the image off the pin
    // page and pull it straight with downloadFile — like Instagram photos.
    try {
      filePath = await ytdlpDownload(task.url, taskOutputDir, task.id, task.title, quality, filenameBase, {
        speedLimitKBps, downloadSubs, cookiesFile, customArgs, taskQuality: task.quality,
      });
    } catch (e) {
      if (entry.cancelled) throw e;
      // Only treat it as an image pin when yt-dlp explicitly found no video.
      // Any other failure (network, gated video) bubbles up to the normal retry
      // so we never silently save a video's cover image instead of the video.
      if (!/NO_VIDEO_FORMATS/.test(e.message)) throw e;
      const imgUrls = await pinterestResolveImageUrls(task.url);
      if (!imgUrls.length) throw new Error('PIN_UNRESOLVABLE'); // idea/story pin, etc.
      let saved = '';
      for (let i = 0; i < imgUrls.length; i++) {
        if (entry.cancelled) throw new Error('Cancelled');
        const u = imgUrls[i];
        const extn = ((u.match(/\.(jpe?g|png|gif|webp)(?:\?|$)/i) || [, 'jpg'])[1] || 'jpg')
          .toLowerCase().replace('jpeg', 'jpg');
        const suffix = imgUrls.length > 1 ? `_${String(i + 1).padStart(2, '0')}` : '';
        const destBase = uniquePath(path.join(taskOutputDir, `${filenameBase}${suffix}.${extn}`));
        saved = await downloadFile(u, destBase, task.id, task.title);
        emitProgress(task.id, {
          title: task.title, status: 'downloading',
          progress: Math.round(((i + 1) / imgUrls.length) * 100), speed: '',
        });
      }
      filePath = saved;
    }
  } else {
    try {
      filePath = await ytdlpDownload(task.url, taskOutputDir, task.id, task.title, quality, filenameBase, {
        speedLimitKBps, downloadSubs, cookiesFile, customArgs,
        taskQuality: task.quality, kind: task.kind,
      });
    } catch (e) {
      // A Facebook item with no video (a photo card, or a blob/DRM stream
      // yt-dlp can't extract) → graceful skip with a clear message instead of a
      // raw "yt-dlp exited with code N" red error. FB has no image fallback.
      if (/NO_VIDEO_FORMATS/.test(e.message) && isFacebookUrl(task.url)) {
        throw new Error('FB_NOT_VIDEO');
      }
      throw e;
    }
  }

  if (entry.cancelled) throw new Error('Cancelled');

  recordDownloaded(plat, extractVideoId(task), filePath);
  emitProgress(task.id, { title: task.title, progress: 100, speed: '', status: 'completed', filePath });
  pushCompleted({
    id: task.id, title: task.title, platform: plat,
    filePath, completedAt: new Date().toISOString(),
  });
  activeDownloads.delete(task.id);
}




// Short-lived cache of TikTok search results, keyed by query. TikWM paginates
// inconsistently (sometimes 2 pages, sometimes 8), so the same search returns a
// different count each time. Caching makes a repeated search return the exact
// same set for a few minutes.
const tiktokSearchCache = new Map(); // key -> { ts, results }
const TIKTOK_SEARCH_TTL_MS = 10 * 60 * 1000;



// DELETE /api/downloads — clear completed history
app.delete('/api/downloads', (req, res) => {
  completedDownloads.length = 0;
  res.json({ success: true });
});

// ─── Results / History / Bookmarks persistence ─────────────────────────────────
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}












// ─── Schedules (one-shot) ──────────────────────────────────────────────────────
// A schedule { id, fireAt, payload } — payload is forwarded to /api/download.
let scheduleTimers = new Map(); // id -> Timeout

function scheduleFire(s) {
  const due = s.fireAt - Date.now();
  if (due <= 0) {
    runSchedule(s);
    return;
  }
  const t = setTimeout(() => runSchedule(s), Math.min(due, 2_147_483_000));
  scheduleTimers.set(s.id, t);
}

async function runSchedule(s) {
  console.log(`Firing schedule ${s.id} at ${new Date().toISOString()}`);
  scheduleTimers.delete(s.id);
  // Remove from disk first
  const list = readJsonSafe(SCHEDULES_FILE, []);
  atomicWrite(SCHEDULES_FILE, list.filter((x) => x.id !== s.id));
  // Re-issue the download via internal POST
  try {
    const json = JSON.stringify(s.payload || {});
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/api/download', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
    });
    req.on('error', (e) => console.error('Schedule fire failed:', e.message));
    req.end(json);
  } catch (e) { console.error('Schedule fire exception:', e.message); }
}

function loadSchedules() {
  const list = readJsonSafe(SCHEDULES_FILE, []);
  for (const s of list) scheduleFire(s);
}






// PATCH /api/bookmarks/:id { tags? title? }
app.patch('/api/bookmarks/:id', (req, res) => {
  const { tags, title } = req.body || {};
  const list = readJsonSafe(BOOKMARKS_FILE, []);
  const idx = list.findIndex((b) => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (Array.isArray(tags)) list[idx].tags = tags;
  if (typeof title === 'string') list[idx].title = title;
  atomicWrite(BOOKMARKS_FILE, list);
  res.json({ success: true, bookmark: list[idx] });
});


// POST /api/open-file — open a downloaded file with the OS default app
app.post('/api/open-file', (req, res) => {
  const { filePath } = req.body || {};
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'filePath required' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  try {
    if (process.platform === 'win32') {
      // `start "" "<path>"` via cmd; `""` is the empty window title
      spawn('cmd', ['/c', 'start', '""', filePath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/file — delete a downloaded file from disk (sanitized to known dirs)
app.delete('/api/file', (req, res) => {
  const { filePath } = req.body || {};
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'filePath required' });
  }
  // Safety: only allow deletes inside the user's download tree (never System dirs)
  try {
    const resolved = path.resolve(filePath);
    for (const forbidden of FORBIDDEN_DIRS) {
      if (resolved.toLowerCase().startsWith(forbidden.toLowerCase())) {
        return res.status(403).json({ error: 'Refusing to delete from system path' });
      }
    }
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
    fs.unlinkSync(resolved);
    // Also drop from downloaded-ids DB so the user can re-download if they want
    const all = loadDownloadedIds();
    let changed = false;
    for (const platform of Object.keys(all)) {
      for (const [id, info] of Object.entries(all[platform])) {
        if (info.filePath && path.resolve(info.filePath) === resolved) {
          delete all[platform][id];
          changed = true;
        }
      }
    }
    if (changed) atomicWrite(DOWNLOADED_IDS_FILE, all);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/open-folder — open the folder containing the file (selecting it on Windows)
app.post('/api/open-folder', (req, res) => {
  const { filePath } = req.body || {};
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'filePath required' });
  }
  try {
    const fileExists = fs.existsSync(filePath);
    const folder = fileExists ? path.dirname(filePath) : (fs.existsSync(path.dirname(filePath)) ? path.dirname(filePath) : null);
    if (!folder) {
      return res.status(404).json({ error: 'الملف أو المجلد غير موجود' });
    }

    if (process.platform === 'win32') {
      // explorer.exe wants `/select,"C:\path\to\file"` as a SINGLE arg, not
      // two separate args. Using `shell: true` lets us pass the whole
      // command string so quoting + Arabic paths work correctly.
      const target = fileExists ? filePath : folder;
      const cmd = fileExists
        ? `explorer.exe /select,"${target}"`
        : `explorer.exe "${target}"`;
      spawn(cmd, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      // -R reveals and selects the file in Finder — the mac equivalent of
      // explorer /select above. Without a file we just open the folder.
      const args = fileExists ? ['-R', filePath] : [folder];
      spawn('open', args, { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [folder], { detached: true, stdio: 'ignore' }).unref();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/env — what OS are we on, and where do files go by default.
// The UI used to hard-code Windows paths as its fallbacks, which made every
// "download to the default folder" action fail on macOS (an absolute Windows
// path isn't absolute on POSIX, so validateOutputDir rejected it outright).
app.get('/api/env', (req, res) => {
  res.json({
    platform: process.platform,
    sep: path.sep,
    home: os.homedir(),
    defaultOutputDir: DEFAULT_OUTPUT_DIR,
  });
});

// GET /api/disk-space?dir=path — return free/total bytes for the volume
app.get('/api/disk-space', (req, res) => {
  try {
    const dir = req.query.dir ? validateOutputDir(req.query.dir) : DEFAULT_OUTPUT_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const stats = fs.statfsSync ? fs.statfsSync(dir) : null;
    if (!stats) return res.json({ supported: false });
    res.json({
      supported: true,
      dir,
      freeBytes: Number(stats.bsize) * Number(stats.bavail),
      totalBytes: Number(stats.bsize) * Number(stats.blocks),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/next-subfolder — return the next free auto-numbered folder name
// inside a base dir (1, 2, 3, …), skipping names that already exist. Used by
// the batch downloader when the user leaves the folder name blank.
app.post('/api/next-subfolder', (req, res) => {
  try {
    const base = validateOutputDir(req.body?.outputDir);
    ensureDir(base);
    const prefix = typeof req.body?.prefix === 'string' ? req.body.prefix : '';
    let n = 1;
    // Cap the scan so a malformed request can't spin forever.
    while (n < 100000) {
      const name = `${prefix}${n}`;
      if (!fs.existsSync(path.join(base, sanitizeFilename(name)))) {
        return res.json({ name });
      }
      n++;
    }
    res.status(500).json({ error: 'No free folder name found' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});



// GET /api/downloaded-ids?platform=tiktok — list known IDs for client-side highlighting
app.get('/api/downloaded-ids', (req, res) => {
  const plat = (req.query.platform || '').toLowerCase();
  const all = loadDownloadedIds();
  if (plat) return res.json({ ids: Object.keys(all[plat] || {}) });
  res.json({ all });
});

// DELETE /api/downloaded-ids[?platform=tiktok] — clear the dedupe DB, or just
// one platform's IDs (used by the TikTok window's "reset marks" button).
app.delete('/api/downloaded-ids', (req, res) => {
  const plat = (req.query.platform || '').toLowerCase();
  if (plat) {
    const all = loadDownloadedIds();
    delete all[plat];
    downloadedIdsCache = all;
    try { atomicWrite(DOWNLOADED_IDS_FILE, all); } catch {}
    return res.json({ success: true, platform: plat });
  }
  downloadedIdsCache = {};
  try { atomicWrite(DOWNLOADED_IDS_FILE, {}); } catch {}
  res.json({ success: true });
});

// GET /api/stats — overall download analytics
app.get('/api/stats', (req, res) => {
  try {
    const all = loadDownloadedIds();
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const out = {
      totalDownloads: 0,
      todayCount: 0,
      weekCount: 0,
      perPlatform: {},
      topAuthors: {}, // author -> count (only TikTok structures with this info)
      totalBytes: 0,
    };
    for (const [platform, ids] of Object.entries(all)) {
      const entries = Object.values(ids);
      out.perPlatform[platform] = entries.length;
      out.totalDownloads += entries.length;
      for (const e of entries) {
        if (e.at && now - e.at < dayMs) out.todayCount++;
        if (e.at && now - e.at < 7 * dayMs) out.weekCount++;
        // Try to size each file
        try {
          if (e.filePath && fs.existsSync(e.filePath)) {
            out.totalBytes += fs.statSync(e.filePath).size;
          }
        } catch {}
        // Author from path: subfolder name
        if (e.filePath) {
          const parent = path.basename(path.dirname(e.filePath));
          if (parent && parent !== 'MediaGrab') {
            out.topAuthors[parent] = (out.topAuthors[parent] || 0) + 1;
          }
        }
      }
    }
    out.topAuthorsList = Object.entries(out.topAuthors)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
    delete out.topAuthors;
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/active — current in-flight downloads (for reconnect)
app.get('/api/active', (req, res) => {
  const list = [];
  for (const [id, entry] of activeDownloads) {
    list.push({
      id,
      title: entry.info?.title || 'Unknown',
      status: entry.status || 'downloading',
    });
  }
  res.json({ active: list });
});

// POST /api/cancel-all — cancel every active download
app.post('/api/cancel-all', (req, res) => {
  const ids = [...activeDownloads.keys()];
  for (const id of ids) {
    const entry = activeDownloads.get(id);
    if (!entry) continue;
    entry.cancelled = true;
    if (entry.proc) killProcessTree(entry.proc);
    if (entry.request) { try { entry.request.destroy(); } catch {} }
    if (entry.fileStream) { try { entry.fileStream.destroy(); } catch {} }
    emitProgress(id, {
      title: entry.info?.title || 'Unknown',
      progress: 0, speed: '', status: 'cancelled',
    });
    activeDownloads.delete(id);
  }
  res.json({ success: true, cancelled: ids.length });
});

// POST /api/cancel/:id
app.post('/api/cancel/:id', (req, res) => {
  const { id } = req.params;
  const entry = activeDownloads.get(id);
  // Already finished/removed → nothing to cancel, but treat as success so the
  // UI doesn't flash a scary "فشل إلغاء التحميل" for a download that's done.
  if (!entry) return res.json({ success: true, alreadyDone: true });

  entry.cancelled = true;

  if (entry.proc) killProcessTree(entry.proc);
  if (entry.request) { try { entry.request.destroy(); } catch {} }
  if (entry.fileStream) { try { entry.fileStream.destroy(); } catch {} }

  // For tasks still in pre-download phase (waiting for TikWM), the limiter
  // will see cancelled=true and skip work; we emit cancellation now.
  emitProgress(id, {
    title: entry.info?.title || 'Unknown',
    progress: 0, speed: '', status: 'cancelled',
  });
  activeDownloads.delete(id);
  res.json({ success: true });
});

// ─── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Re-emit current state so clients can rebuild their queue after reconnect
  for (const [id, entry] of activeDownloads) {
    socket.emit('download:progress', {
      id,
      title: entry.info?.title || 'Unknown',
      progress: 0, speed: '',
      status: entry.status || 'downloading',
    });
  }

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// ─── Interrupted-queue handling ───────────────────────────────────────────────
// On startup, surface anything that was downloading at last shutdown so the
// user can re-queue it.
let interruptedQueue = readJsonSafe(QUEUE_STATE_FILE, []);
// Wipe the file so the next shutdown writes a fresh snapshot.
try { atomicWrite(QUEUE_STATE_FILE, []); } catch {}

// GET /api/interrupted — list interrupted downloads (cleared after read)
app.get('/api/interrupted', (req, res) => {
  res.json({ interrupted: interruptedQueue });
});

app.delete('/api/interrupted', (req, res) => {
  interruptedQueue = [];
  res.json({ success: true });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Media Downloader server running at http://localhost:${PORT}`);
  console.log(`Default output dir: ${DEFAULT_OUTPUT_DIR}`);
  ensureDir(DEFAULT_OUTPUT_DIR);
  if (interruptedQueue.length) {
    console.log(`Found ${interruptedQueue.length} interrupted downloads from previous run.`);
  }
  // Re-arm any pending schedules from disk
  try { loadSchedules(); } catch (e) { console.error('loadSchedules failed:', e.message); }
});

// Graceful shutdown — kill all child processes + persist active queue
function shutdown() {
  console.log('Shutting down…');
  // Snapshot active downloads so we can resurface them on next start.
  try {
    const snapshot = [];
    for (const [id, entry] of activeDownloads) {
      snapshot.push({
        id,
        title: entry.info?.title,
        url: entry.info?.url,
        downloadUrl: entry.info?.downloadUrl,
        hdDownloadUrl: entry.info?.hdDownloadUrl,
        platform: entry.info?.platform,
        author: entry.info?.author,
      });
    }
    if (snapshot.length) atomicWrite(QUEUE_STATE_FILE, snapshot);
  } catch (e) { console.error('Snapshot failed:', e.message); }

  for (const [, entry] of activeDownloads) {
    if (entry.proc) killProcessTree(entry.proc);
    if (entry.request) { try { entry.request.destroy(); } catch {} }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
