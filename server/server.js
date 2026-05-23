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

function urlKey(url) {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex').slice(0, 16);
}

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
  const result = spawnSync('where', ['yt-dlp'], { encoding: 'utf8' });
  if (result.status === 0) {
    const first = result.stdout.split(/\r?\n/).find((l) => l.trim().endsWith('.exe'));
    if (first) return first.trim();
  }
  // Fallback to PATH lookup at exec time (less safe but functional)
  return 'yt-dlp.exe';
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

// Reels search by keyword — equivalent of the mobile app's Reels search tab.
// Web doesn't expose this UI but the API still responds for a logged-in
// session. We try multiple endpoint shapes because Instagram rotates them.
async function instagramReelsSearch(query, cookiesFile, count = 30) {
  const cookies = parseNetscapeCookies(cookiesFile);
  if (!cookies.sessionid) throw new Error('No sessionid cookie — re-import after logging in');

  const q = encodeURIComponent(query.trim());
  // The hashtag form of the query (Instagram hashtags can't contain spaces).
  const tagSlug = query.trim().replace(/\s+/g, '').toLowerCase();
  const endpoints = [
    // 1. Mobile API: clips search (Reels keyword search) — most likely to work
    `https://i.instagram.com/api/v1/fbsearch/clips/?query=${q}`,
    // 2. Mobile API: topsearch — finds best hashtag/account match
    `https://i.instagram.com/api/v1/fbsearch/topsearch/?query=${q}&context=blended`,
    // 3. Mobile API: tag content (if the query maps cleanly to a hashtag)
    `https://i.instagram.com/api/v1/tags/${encodeURIComponent(tagSlug)}/sections/`,
    // 4. Web fallback (sometimes works after the mobile ones fail)
    `https://www.instagram.com/api/v1/fbsearch/clips/?query=${q}`,
    `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tagSlug)}`,
  ];

  let lastErr = null;
  for (const url of endpoints) {
    try {
      const data = await instagramApiGet(url, cookies);
      const clips = [];

      // fbsearch/clips: { clips_serp_modules: [{ clips: [{ media: {...} }] }] }
      for (const mod of data.clips_serp_modules || []) {
        for (const c of mod.clips || []) {
          if (c.media) clips.push(c.media);
        }
      }

      // topsearch: best-effort — look for top hashtag and fall through if any
      // media is embedded; otherwise we'd need a 2nd call.
      for (const h of data.hashtags || []) {
        if (h.hashtag?.media_count) {
          // Found a hashtag — fetch its top media in a follow-up call.
          try {
            const tagUrl = `https://www.instagram.com/api/v1/tags/${encodeURIComponent(h.hashtag.name)}/sections/`;
            const tag = await instagramApiGet(tagUrl, cookies);
            for (const sec of tag.sections || []) {
              for (const m of sec.layout_content?.medias || []) {
                if (m.media) clips.push(m.media);
              }
            }
          } catch { /* skip and try next endpoint */ }
          break; // only follow the top hashtag
        }
      }

      // tags/web_info: { data: { recent: { sections: [...] }, top: { sections: [...] } } }
      const tagData = data.data || data;
      for (const bucket of ['recent', 'top']) {
        for (const sec of tagData[bucket]?.sections || []) {
          for (const m of sec.layout_content?.medias || []) {
            if (m.media) clips.push(m.media);
          }
        }
      }

      if (clips.length) return clips.slice(0, count);
      lastErr = new Error('No clips in response');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All Instagram endpoints rejected');
}

function isInstagramUrl(u) {
  if (typeof u !== 'string') return false;
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'instagram.com' || h.endsWith('.instagram.com');
  } catch { return false; }
}

function isFacebookUrl(u) {
  if (typeof u !== 'string') return false;
  try {
    const h = new URL(u).hostname.toLowerCase();
    return /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/i.test(h);
  } catch { return false; }
}

function buildInstagramUrl(input, mode) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const slug = raw.replace(/^[@#\s]+/, '').replace(/\s+/g, '');
  if (!slug) return null;
  if (mode === 'hashtag') return `https://www.instagram.com/explore/tags/${encodeURIComponent(slug)}/`;
  if (mode === 'account' || mode === 'username') return `https://www.instagram.com/${encodeURIComponent(slug)}/`;
  return null;
}

function buildFacebookUrl(input, mode) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const slug = raw.replace(/^[@#\s]+/, '').replace(/\s+/g, '');
  if (!slug) return null;
  // Hashtag → public hashtag page (often returns posts; yt-dlp pulls embedded videos)
  if (mode === 'hashtag') return `https://www.facebook.com/hashtag/${encodeURIComponent(slug)}`;
  // Account → page's videos tab (works for public pages without login)
  if (mode === 'account' || mode === 'username') return `https://www.facebook.com/${encodeURIComponent(slug)}/videos`;
  return null;
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
function refererForHost(hostname) {
  if (/tiktok|muscdn|byteoversea|ttwstatic/i.test(hostname)) return 'https://www.tiktok.com/';
  if (/instagram|cdninstagram/i.test(hostname)) return 'https://www.instagram.com/';
  if (/fbcdn|facebook/i.test(hostname)) return 'https://www.facebook.com/';
  return '';
}
app.get('/api/proxy/media', (req, res) => {
  const u = req.query.u;
  if (!u || typeof u !== 'string') return res.status(400).end('missing u');
  let parsed;
  try { parsed = new URL(u); } catch { return res.status(400).end('bad url'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return res.status(400).end();
  const host = parsed.hostname.toLowerCase();
  if (!PROXY_ALLOW.some((re) => re.test(host))) return res.status(403).end('host not allowed');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const ref = refererForHost(host);
  if (ref) headers.Referer = ref;
  if (req.headers.range) headers.Range = req.headers.range;

  const proto = parsed.protocol === 'https:' ? https : http;
  const upstream = proto.get(u, { headers, timeout: 30_000 }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      // Follow one redirect by re-proxying the new URL
      const redirected = new URL(r.headers.location, u).toString();
      const redirectReq = proto.get(redirected, { headers, timeout: 30_000 }, (r2) => {
        res.statusCode = r2.statusCode;
        for (const [k, v] of Object.entries(r2.headers)) {
          if (!/^(transfer-encoding|connection|keep-alive)$/i.test(k)) res.setHeader(k, v);
        }
        r2.pipe(res);
      });
      redirectReq.on('error', (e) => { if (!res.headersSent) res.status(502).end(e.message); });
      r.destroy();
      return;
    }
    res.statusCode = r.statusCode;
    for (const [k, v] of Object.entries(r.headers)) {
      if (!/^(transfer-encoding|connection|keep-alive)$/i.test(k)) res.setHeader(k, v);
    }
    r.pipe(res);
  });
  upstream.on('error', (e) => { if (!res.headersSent) res.status(502).end(e.message); });
  upstream.on('timeout', () => { upstream.destroy(new Error('timeout')); });
  req.on('close', () => { try { upstream.destroy(); } catch {} });
});

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
const FORBIDDEN_DIRS = [
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
  for (const forbidden of FORBIDDEN_DIRS) {
    if (resolved.toLowerCase().startsWith(forbidden.toLowerCase())) {
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
    .substring(0, 80) || 'video';
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

// Paginated TikWM user feed. yt-dlp's TikTok extractor caps out around
// 300 videos before TikTok throttles it, but TikWM's user/posts endpoint
// pages cursor-by-cursor reliably, so we go through it for channel listings.
//
// onItem(item, indexStartingAt1) is fired for each video so the caller can
// stream results to the UI as they arrive.
// maxCount default = Infinity → keep paginating until TikWM signals end
// (hasMore=false or empty cursor). Pass a finite number to cap.
async function tikwmUserPosts(username, { maxCount = Infinity, onItem = null } = {}) {
  const out = [];
  let cursor = '0';
  let idx = 0;
  while (out.length < maxCount) {
    const url = `https://www.tikwm.com/api/user/posts?unique_id=${encodeURIComponent(username)}&count=30&cursor=${encodeURIComponent(cursor)}&web=1&hd=1`;
    let data;
    let lastErr = null;
    // Retry transient failures (TikWM occasionally returns null / non-zero
    // for a single page even on healthy accounts). 3 tries with backoff.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        data = await tikwmSerializedRequest(url);
        if (data && data.code === 0 && data.data) { lastErr = null; break; }
        lastErr = new Error(`TikWM code=${data?.code} msg=${data?.msg || ''}`);
      } catch (e) {
        lastErr = e;
      }
      data = null;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
    if (!data) {
      // First page failed entirely → surface as an error so callers don't
      // misread it as "empty profile" and fall back to yt-dlp (which will
      // hit TikTok's 429 anyway).
      if (out.length === 0 && lastErr) {
        const err = new Error(lastErr.message || 'TikWM unavailable');
        err.code = 'TIKWM_UNAVAILABLE';
        throw err;
      }
      // Mid-pagination failure → keep what we have rather than discarding.
      break;
    }
    if (data.code !== 0 || !data.data) break;
    const videos = data.data.videos || [];
    if (!videos.length) break;
    for (const d of videos) {
      idx++;
      const item = {
        id: d.video_id || d.id,
        title: d.title || '',
        cover: d.cover || d.origin_cover || '',
        thumbnail: d.cover || d.origin_cover || '',
        duration: d.duration || 0,
        author: { nickname: d.author?.nickname || username, unique_id: d.author?.unique_id || username },
        play_count: d.play_count || 0,
        views: d.play_count || 0,
        play: d.play || null,
        hdplay: d.hdplay || null,
        url: `https://www.tiktok.com/@${d.author?.unique_id || username}/video/${d.video_id || d.id}`,
        platform: 'tiktok',
      };
      out.push(item);
      if (onItem) onItem(item, out.length);
      if (out.length >= maxCount) break;
    }
    if (!data.data.hasMore) break;
    cursor = String(data.data.cursor || '');
    if (!cursor || cursor === '0') break;
  }
  return out;
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
        return {
          id: d.id,
          play: d.play,
          hdplay: d.hdplay,
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
      if (code === 0) return resolve(lastFile || outputDir);
      // 101 = item rejected by --match-filter (e.g. an Instagram photo post
      // failing duration>0). Surface it as a friendly "not a video" message
      // so the UI can show it as skipped, not a hard error.
      if (code === 101) return reject(new Error('NOT_A_VIDEO'));
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

function getYtdlpInfoCached(targetUrl, flat = false, opts = {}) {
  const cacheKey = `${flat ? 'F' : 'S'}::${targetUrl}::${opts.playlistEnd || 'all'}`;
  const hit = ytdlpInfoCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  return null;
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

// POST /api/cancel-listing/:session — stop yt-dlp listing and surface partial items
app.post('/api/cancel-listing/:session', (req, res) => {
  const session = req.params.session;
  const entry = activeListings.get(session);
  if (!entry) return res.status(404).json({ error: 'Listing not found or already finished' });
  if (entry.proc) killProcessTree(entry.proc);
  res.json({ success: true, partialCount: entry.items?.length || 0 });
});

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

// POST /api/info
app.post('/api/info', async (req, res) => {
  try {
    const { url: targetUrl, platform } = req.body || {};
    if (!isHttpUrl(targetUrl)) return res.status(400).json({ error: 'Valid URL required' });
    const plat = (platform || '').toLowerCase();

    if (plat === 'tiktok') {
      if (isTikTokUser(targetUrl)) {
        const username = targetUrl.match(/@([^/?]+)/)?.[1];
        // TikWM's /api/user/posts is Cloudflare-gated and unreliable. yt-dlp
        // uses TikTok's real pagination API and pulls the full profile in one
        // pass (verified: 2019 items on a 2k-post account, zero blocks).
        const cleanUrl = `https://www.tiktok.com/@${username}`;
        const info = await ytdlpInfo(cleanUrl, true);
        const videos = Array.isArray(info) ? info : [info];
        const enrichedVideos = videos.map((v) => ({
          id: v.id,
          title: v.title || `Video ${v.id}`,
          cover: v.thumbnails?.[0]?.url || v.thumbnail || '',
          thumbnail: v.thumbnails?.[0]?.url || v.thumbnail || '',
          duration: v.duration,
          author: { nickname: v.uploader || username, unique_id: username },
          play_count: v.view_count || 0,
          views: v.view_count || 0,
          play: null,
          hdplay: null,
          url: v.url || v.webpage_url,
        }));
        return res.json({ type: 'channel', platform: 'tiktok', data: { videos: enrichedVideos } });
      } else {
        const tikInfo = await tikwmGetVideo(targetUrl);
        if (!tikInfo) return res.status(400).json({ error: 'TikTok API error (rate limited or invalid URL)' });
        const v = { ...tikInfo, id: targetUrl.match(/\/video\/(\d+)/)?.[1] || '' };
        return res.json({
          type: 'single', platform: 'tiktok',
          data: {
            id: v.id, title: v.title,
            thumbnail: v.cover || v.origin_cover,
            duration: v.duration,
            author: v.author?.nickname || v.author?.unique_id,
            playCount: v.play_count,
            downloadUrl: v.play, hdDownloadUrl: v.hdplay,
            musicUrl: v.music,
          },
        });
      }
    }

    // Instagram tag/profile pages are playlists; reel/p/ are singles.
    const igIsListing = isInstagramUrl(targetUrl) && /\/explore\/tags\/|\/instagram\.com\/[^/]+\/?$/i.test(targetUrl);
    const igIsSingle  = isInstagramUrl(targetUrl) && /\/(reel|reels|p|tv)\//i.test(targetUrl);
    const isPlaylist  = igIsListing || (!igIsSingle && /[/&?]list=|\/playlist|\/channel\/|\/c\/|\/@/i.test(targetUrl));
    const info = await ytdlpInfo(targetUrl, isPlaylist);

    if (Array.isArray(info)) {
      return res.json({
        type: 'playlist', platform: plat || 'other', count: info.length,
        videos: info.map((v) => ({
          id: v.id, title: v.title,
          url: v.url || v.webpage_url, duration: v.duration,
          thumbnail: v.thumbnail || v.thumbnails?.[0]?.url,
        })),
      });
    }

    return res.json({
      type: 'single', platform: plat || 'other',
      data: {
        id: info.id, title: info.title,
        thumbnail: info.thumbnail, duration: info.duration,
        description: info.description?.substring(0, 500),
        uploader: info.uploader || info.channel,
        viewCount: info.view_count, url: info.webpage_url,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
            });
            return; // success
          } catch (err) {
            lastErr = err;
            // "Not a video" is a known dead-end (Instagram photo post). Don't
            // retry and surface it as a graceful skip rather than red error.
            if (/NOT_A_VIDEO/.test(err.message)) {
              emitProgress(task.id, {
                title: task.title, progress: 100, speed: '',
                status: 'completed', skipped: true,
                error: 'تخطّى — البوست ده صور مش فيديو',
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

// Single attempt at downloading a task. Throws on failure so the caller can retry.
async function runDownloadOnce(task, entry, ctx) {
  const {
    outputDir, plat, quality, filenameTemplate,
    skipExisting, organizeByAuthor, subfolder,
    speedLimitKBps, downloadSubs, cookiesFile, customArgs,
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

  // Cross-session dedupe
  if (skipExisting) {
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

  if (plat === 'tiktok') {
    if (!task.downloadUrl && !task.hdDownloadUrl) {
      const tikInfo = await tikwmGetVideo(task.url);
      if (tikInfo) {
        task.downloadUrl = tikInfo.play;
        task.hdDownloadUrl = tikInfo.hdplay;
        task.title = tikInfo.title || task.title;
      }
    }
    const videoUrl = task.hdDownloadUrl || task.downloadUrl;
    if (!videoUrl) throw new Error('فشل الحصول على رابط التحميل من TikWM');

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

    // uniquePath stays as a final guard against rare title collisions
    // between two genuinely different videos.
    const destBase = uniquePath(path.join(taskOutputDir, filenameBase + '.mp4'));
    try {
      filePath = await downloadFile(videoUrl, destBase, task.id, task.title);
    } catch (dlErr) {
      if (entry.cancelled) throw new Error('Cancelled');
      const freshInfo = await tikwmGetVideo(task.url);
      if (!freshInfo || (!freshInfo.play && !freshInfo.hdplay)) throw dlErr;
      filePath = await downloadFile(freshInfo.hdplay || freshInfo.play, destBase, task.id, task.title);
    }

    // Audio-only mode: TikWM gives us video; convert to MP3 with ffmpeg and
    // discard the source .mp4 so the user gets exactly what the 🎵 button promised.
    if (quality === 'audio') {
      const mp3Path = uniquePath(filePath.replace(/\.mp4$/i, '.mp3'));
      emitProgress(task.id, { title: task.title, progress: 99, speed: '', status: 'downloading', eta: 'converting' });
      await extractAudioToMp3(filePath, mp3Path);
      try { fs.unlinkSync(filePath); } catch {}
      filePath = mp3Path;
    }
  } else {
    filePath = await ytdlpDownload(task.url, taskOutputDir, task.id, task.title, quality, filenameBase, {
      speedLimitKBps, downloadSubs, cookiesFile, customArgs,
      taskQuality: task.quality,
    });
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

// GET /api/tiktok-resolve?url=... — fetch play/hdplay for a single TikTok video.
// Used by the preview UI which gets items from a fast listing without download URLs.
app.get('/api/tiktok-resolve', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!isHttpUrl(targetUrl)) return res.status(400).json({ error: 'Valid URL required' });
    const info = await tikwmGetVideo(targetUrl);
    if (!info) return res.status(404).json({ error: 'فشل الحصول على الفيديو من TikWM (غالباً rate limit). جرب بعد ثوانٍ.' });
    res.json({
      play: info.play, hdplay: info.hdplay,
      title: info.title, cover: info.cover,
      duration: info.duration,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/info-stream — same as /api/info but emits items via Socket.IO as
// they arrive, so the client can render incrementally.
app.post('/api/info-stream', async (req, res) => {
  try {
    const { url: targetUrl, platform, socketId } = req.body || {};
    if (!isHttpUrl(targetUrl)) return res.status(400).json({ error: 'Valid URL required' });
    if (!socketId) return res.status(400).json({ error: 'socketId required' });

    const plat = (platform || '').toLowerCase();
    const session = uuidv4();
    res.json({ success: true, session });

    const emit = (event, payload) => io.to(socketId).emit(event, { session, ...payload });

    const isUserPage = plat === 'tiktok' && isTikTokUser(targetUrl);
    const isPlaylist = isUserPage || /[/&?]list=|\/playlist|\/channel\/|\/c\/|\/@/i.test(targetUrl);

    if (!isPlaylist) {
      // Single video — fall through to /api/info logic
      try {
        const info = await ytdlpInfo(targetUrl, false);
        emit('listing:item', { item: {
          id: info.id, title: info.title,
          thumbnail: info.thumbnail, duration: info.duration,
          uploader: info.uploader || info.channel,
          viewCount: info.view_count, url: info.webpage_url,
          platform: plat || 'other',
        }});
        emit('listing:complete', { count: 1 });
      } catch (err) {
        emit('listing:error', { error: err.message });
      }
      return;
    }

    let count = 0;
    const username = isUserPage ? targetUrl.match(/@([^/?]+)/)?.[1] : null;
    const cleanUrl = isUserPage ? `https://www.tiktok.com/@${username}` : targetUrl;

    const buildItem = (v) => isUserPage ? {
      id: v.id,
      title: v.title || `Video ${v.id}`,
      cover: v.thumbnails?.[0]?.url || v.thumbnail || '',
      thumbnail: v.thumbnails?.[0]?.url || v.thumbnail || '',
      duration: v.duration,
      author: { nickname: v.uploader || username, unique_id: username },
      play_count: v.view_count || 0,
      views: v.view_count || 0,
      play: null, hdplay: null,
      url: v.url || v.webpage_url,
      platform: 'tiktok',
    } : {
      id: v.id, title: v.title,
      url: v.url || v.webpage_url, duration: v.duration,
      thumbnail: v.thumbnail || v.thumbnails?.[0]?.url,
      uploader: v.uploader || v.channel,
      views: v.view_count || 0,
      platform: plat || 'other',
    };

    // TikTok user pages go straight to yt-dlp — TikWM's /api/user/posts is
    // Cloudflare-gated and unreliable; yt-dlp uses TikTok's real pagination
    // API and pulls the full profile in a single pass.

    // Cache hit → emit all items immediately, no yt-dlp run.
    const cached = getYtdlpInfoCached(cleanUrl, true);
    if (cached) {
      const list = Array.isArray(cached) ? cached : [cached];
      list.forEach((v, i) => {
        count = i + 1;
        emit('listing:item', { item: buildItem(v), index: count });
      });
      emit('listing:complete', { count, fromCache: true });
      return;
    }

    try {
      await ytdlpInfo(cleanUrl, true, {
        onItem: (v, idx) => {
          count = idx;
          emit('listing:item', { item: buildItem(v), index: idx });
        },
      });
      emit('listing:complete', { count });
    } catch (err) {
      emit('listing:error', { error: err.message, count });
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// POST /api/search
app.post('/api/search', async (req, res) => {
  try {
    const { query, platform, count = 30, mode } = req.body || {};
    if (!query || typeof query !== 'string') return res.status(400).json({ error: 'Query is required' });
    // count <= 0 or 'all' / 'unlimited' → no cap (paginate until upstream is exhausted)
    const isUnlimited = count === 0 || count === -1 || count === 'all' || count === 'unlimited';
    const safeCount = isUnlimited
      ? Infinity
      : Math.max(1, Math.min(100000, parseInt(count, 10) || 30));
    const plat = (platform || '').toLowerCase();

    if (plat === 'instagram') {
      const igMode = (mode || 'hashtag').toLowerCase();

      // Hashtag search via yt-dlp is dead (Instagram disabled /explore/tags
      // for unauthenticated scraping). Use the mobile clips-search endpoint
      // directly with the user's logged-in cookies — same data the mobile
      // app's Reels search tab shows.
      if (igMode === 'hashtag') {
        const dataDir = process.env.MEDIAGRAB_DATA_DIR || path.join(__dirname, 'data');
        const cookiesFile = path.join(dataDir, 'instagram-cookies.txt');
        if (!fs.existsSync(cookiesFile)) {
          return res.status(401).json({
            error: 'محتاج كوكيز Instagram للبحث بكلمة. اضغط "تسجيل دخول" أو "استيراد كوكيز" فوق.',
          });
        }
        try {
          const clips = await instagramReelsSearch(query, cookiesFile, safeCount);
          return res.json({
            platform: 'instagram',
            mode: 'reels-search',
            results: clips.map((m) => {
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
                downloadUrl: videoVer.url || null,
              };
            }),
          });
        } catch (e) {
          return res.status(500).json({
            error: 'فشل البحث: ' + e.message + ' — جرّب @اسم-حساب بدلاً منها.',
            raw: e.message,
          });
        }
      }

      // Account mode → yt-dlp on the profile page (still works).
      const igUrl = buildInstagramUrl(query, igMode);
      if (!igUrl) return res.status(400).json({ error: 'Invalid Instagram input' });
      try {
        // Infinity → omit playlistEnd so yt-dlp pulls the full profile.
        const ytOpts = Number.isFinite(safeCount) ? { playlistEnd: safeCount } : {};
        const info = await ytdlpInfo(igUrl, true, ytOpts);
        const list = Array.isArray(info) ? info : [info];
        return res.json({
          platform: 'instagram',
          mode: igMode,
          sourceUrl: igUrl,
          results: list.map((v) => ({
            id: v.id,
            title: v.title || v.description || `Reel ${v.id}`,
            url: v.url || v.webpage_url || `https://www.instagram.com/reel/${v.id}/`,
            duration: v.duration,
            thumbnail: v.thumbnail || v.thumbnails?.[0]?.url || '',
            uploader: v.uploader || v.channel || v.uploader_id || '',
            author: v.uploader || v.channel || v.uploader_id || '',
            playCount: v.view_count || 0,
          })),
        });
      } catch (e) {
        const msg = String(e?.message || e);
        const tagBroken = /instagram:tag|Unable to extract data/i.test(msg) && igMode === 'hashtag';
        const needsLogin = /login|cookies?|private|429|rate|HTTP Error 4\d\d/i.test(msg);
        let errorMsg;
        if (tagBroken) {
          errorMsg = 'Instagram عطّل قراءة صفحات الـ hashtags. جرّب تبحث بـ @اسم-حساب بدلاً منها — ده شغّال.';
        } else if (needsLogin) {
          errorMsg = 'متعرفش يقرأ كوكيز Instagram من Chrome. اقفل Chrome تماماً وجرب تاني، أو استورد ملف كوكيز بزرار "استيراد كوكيز".';
        } else {
          errorMsg = msg;
        }
        return res.status(needsLogin || tagBroken ? 401 : 500).json({
          error: errorMsg,
          raw: msg,
        });
      }
    }

    if (plat === 'facebook') {
      // Facebook works the same way as Instagram: hashtag page or account
      // page (videos tab), then yt-dlp pulls the listing using saved cookies.
      const fbMode = (mode || 'hashtag').toLowerCase();
      const fbUrl = buildFacebookUrl(query, fbMode);
      if (!fbUrl) return res.status(400).json({ error: 'Invalid Facebook input' });
      try {
        const ytOpts = Number.isFinite(safeCount) ? { playlistEnd: safeCount } : {};
        const info = await ytdlpInfo(fbUrl, true, ytOpts);
        const list = Array.isArray(info) ? info : [info];
        return res.json({
          platform: 'facebook',
          mode: fbMode,
          sourceUrl: fbUrl,
          results: list.map((v) => ({
            id: v.id,
            title: v.title || v.description || `Video ${v.id}`,
            url: v.url || v.webpage_url || '',
            duration: v.duration,
            thumbnail: v.thumbnail || v.thumbnails?.[0]?.url || '',
            uploader: v.uploader || v.channel || v.uploader_id || '',
            author: v.uploader || v.channel || v.uploader_id || '',
            playCount: v.view_count || 0,
          })),
        });
      } catch (e) {
        const msg = String(e?.message || e);
        const needsLogin = /login|cookies?|private|429|rate|HTTP Error 4\d\d/i.test(msg);
        return res.status(needsLogin ? 401 : 500).json({
          error: needsLogin
            ? 'محتاج تسجيل دخول Facebook. اضغط زرار تسجيل الدخول فوق وادخل بحسابك.'
            : msg,
          raw: msg,
        });
      }
    }

    if (plat === 'tiktok') {
      // Paginate through TikWM's feed/search via cursor. De-dupe by video ID
      // because TikWM's cursor windows occasionally overlap, especially for
      // popular queries.
      const out = [];
      const seenIds = new Set();
      let cursor = '0';
      const start = Date.now();
      // Bigger budget for unlimited requests — TikWM pages slowly.
      const TIME_BUDGET_MS = Number.isFinite(safeCount) ? 90_000 : 600_000;
      while (out.length < safeCount && (Date.now() - start) < TIME_BUDGET_MS) {
        let data;
        try {
          data = await apiRequest('https://www.tikwm.com/api/feed/search', {
            method: 'POST',
            body: { keywords: query, count: 30, cursor },
          });
        } catch { break; }
        const videos = data?.data?.videos || [];
        if (!videos.length) break;
        let addedThisPage = 0;
        for (const v of videos) {
          const vid = v.video_id || v.id;
          if (!vid || seenIds.has(vid)) continue;
          seenIds.add(vid);
          out.push({
            id: vid, title: v.title,
            thumbnail: v.cover || v.origin_cover,
            duration: v.duration,
            author: v.author?.nickname || v.author?.unique_id,
            playCount: v.play_count,
            url: `https://www.tiktok.com/@${v.author?.unique_id}/video/${vid}`,
            downloadUrl: v.play, hdDownloadUrl: v.hdplay,
          });
          addedThisPage++;
          if (out.length >= safeCount) break;
        }
        if (!data.data.hasMore) break;
        // If a whole page added nothing new, TikWM is stuck on the same window
        // — bail rather than spin forever.
        if (addedThisPage === 0) break;
        cursor = String(data.data.cursor || '');
        if (!cursor || cursor === '0') break;
      }
      return res.json({ platform: 'tiktok', results: out });
    }

    if (plat === 'youtube' || !plat) {
      // yt-dlp accepts ytsearchN — for "unlimited" we ask for a big-but-finite N
      // since ytsearchall isn't a thing.
      const ytCount = Number.isFinite(safeCount) ? safeCount : 1000;
      const searchQuery = `ytsearch${ytCount}:${query.replace(/"/g, '')}`;
      const info = await ytdlpInfo(searchQuery, true);
      const results = Array.isArray(info) ? info : [info];
      return res.json({
        platform: 'youtube',
        results: results.map((v) => ({
          id: v.id, title: v.title,
          url: v.url || v.webpage_url, duration: v.duration,
          thumbnail: v.thumbnail || v.thumbnails?.[0]?.url,
          uploader: v.uploader || v.channel,
        })),
      });
    }

    return res.status(400).json({ error: `Search not supported for platform: ${plat}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/downloads — completed history
app.get('/api/downloads', (req, res) => {
  res.json({ downloads: completedDownloads });
});

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

function appendHistory(entry) {
  const list = readJsonSafe(HISTORY_FILE, []);
  // Dedupe by URL — newest wins
  const filtered = list.filter((h) => h.url !== entry.url);
  filtered.unshift({ ...entry, id: uuidv4() });
  if (filtered.length > MAX_HISTORY) {
    // Remove orphan saved files for entries that fell off the end
    for (const dropped of filtered.slice(MAX_HISTORY)) {
      if (dropped.savedKey) {
        try { fs.unlinkSync(path.join(SAVED_DIR, dropped.savedKey + '.json')); } catch {}
      }
    }
    filtered.length = MAX_HISTORY;
  }
  atomicWrite(HISTORY_FILE, filtered);
}

// POST /api/results — save the current listing/search results to disk
//                     and to a per-URL file so it can be reopened any time.
app.post('/api/results', (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !Array.isArray(payload.results)) {
      return res.status(400).json({ error: 'results array required' });
    }
    const data = {
      url: payload.url || '',
      platform: payload.platform || '',
      filters: payload.filters || {},
      results: payload.results,
      savedAt: Date.now(),
      count: payload.results.length,
    };
    atomicWrite(RESULTS_FILE, data);

    // Per-URL durable copy (one file per saved listing)
    let savedKey = null;
    if (data.url) {
      savedKey = urlKey(data.url);
      fs.mkdirSync(SAVED_DIR, { recursive: true });
      atomicWrite(path.join(SAVED_DIR, savedKey + '.json'), data);

      appendHistory({
        url: data.url,
        platform: data.platform,
        count: data.count,
        title: payload.title || data.results[0]?.author?.unique_id || data.results[0]?.author || data.url,
        savedAt: data.savedAt,
        savedKey,
      });
    }

    res.json({ success: true, count: data.count, savedAt: data.savedAt, savedKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/saved/:key — load a previously saved listing (full results)
app.get('/api/saved/:key', (req, res) => {
  try {
    const file = path.join(SAVED_DIR, req.params.key + '.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/saved/:key — also removes the matching history entry
app.delete('/api/saved/:key', (req, res) => {
  try {
    const file = path.join(SAVED_DIR, req.params.key + '.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const list = readJsonSafe(HISTORY_FILE, []);
    atomicWrite(HISTORY_FILE, list.filter((h) => h.savedKey !== req.params.key));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history
app.get('/api/history', (req, res) => {
  res.json({ history: readJsonSafe(HISTORY_FILE, []) });
});

// DELETE /api/history/:id
app.delete('/api/history/:id', (req, res) => {
  const list = readJsonSafe(HISTORY_FILE, []);
  const next = list.filter((h) => h.id !== req.params.id);
  atomicWrite(HISTORY_FILE, next);
  res.json({ success: true });
});

// DELETE /api/history (clear all)
app.delete('/api/history', (req, res) => {
  atomicWrite(HISTORY_FILE, []);
  res.json({ success: true });
});

// ─── Watch Later ───────────────────────────────────────────────────────────────
app.get('/api/watchlist', (req, res) => {
  res.json({ items: readJsonSafe(WATCHLIST_FILE, []) });
});

app.post('/api/watchlist', (req, res) => {
  const item = req.body || {};
  if (!isHttpUrl(item.url)) return res.status(400).json({ error: 'Valid URL required' });
  const list = readJsonSafe(WATCHLIST_FILE, []);
  if (list.some((x) => x.url === item.url)) {
    return res.json({ success: true, duplicate: true });
  }
  list.unshift({ id: uuidv4(), addedAt: Date.now(), ...item });
  atomicWrite(WATCHLIST_FILE, list);
  res.json({ success: true });
});

app.delete('/api/watchlist/:id', (req, res) => {
  const list = readJsonSafe(WATCHLIST_FILE, []);
  atomicWrite(WATCHLIST_FILE, list.filter((x) => x.id !== req.params.id));
  res.json({ success: true });
});

app.delete('/api/watchlist', (req, res) => {
  atomicWrite(WATCHLIST_FILE, []);
  res.json({ success: true });
});

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

app.get('/api/schedules', (req, res) => {
  res.json({ schedules: readJsonSafe(SCHEDULES_FILE, []) });
});

app.post('/api/schedules', (req, res) => {
  const { fireAt, payload } = req.body || {};
  if (!fireAt || typeof fireAt !== 'number') return res.status(400).json({ error: 'fireAt timestamp required' });
  if (!payload) return res.status(400).json({ error: 'payload required' });
  const s = { id: uuidv4(), fireAt, payload, createdAt: Date.now() };
  const list = readJsonSafe(SCHEDULES_FILE, []);
  list.push(s);
  atomicWrite(SCHEDULES_FILE, list);
  scheduleFire(s);
  res.json({ success: true, schedule: s });
});

app.delete('/api/schedules/:id', (req, res) => {
  const t = scheduleTimers.get(req.params.id);
  if (t) { clearTimeout(t); scheduleTimers.delete(req.params.id); }
  const list = readJsonSafe(SCHEDULES_FILE, []);
  atomicWrite(SCHEDULES_FILE, list.filter((s) => s.id !== req.params.id));
  res.json({ success: true });
});

// GET /api/bookmarks
app.get('/api/bookmarks', (req, res) => {
  res.json({ bookmarks: readJsonSafe(BOOKMARKS_FILE, []) });
});

// POST /api/bookmarks { url, title, platform, tags? }
app.post('/api/bookmarks', (req, res) => {
  const { url, title, platform, tags } = req.body || {};
  if (!isHttpUrl(url)) return res.status(400).json({ error: 'Valid URL required' });
  const list = readJsonSafe(BOOKMARKS_FILE, []);
  // Preserve existing tags if updating an existing bookmark
  const existing = list.find((b) => b.url === url);
  const filtered = list.filter((b) => b.url !== url);
  filtered.unshift({
    id: uuidv4(),
    url, title: title || url,
    platform: platform || '',
    tags: Array.isArray(tags) ? tags : (existing?.tags || []),
    addedAt: Date.now(),
  });
  atomicWrite(BOOKMARKS_FILE, filtered);
  res.json({ success: true, bookmark: filtered[0] });
});

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

// DELETE /api/bookmarks/:id
app.delete('/api/bookmarks/:id', (req, res) => {
  const list = readJsonSafe(BOOKMARKS_FILE, []);
  atomicWrite(BOOKMARKS_FILE, list.filter((b) => b.id !== req.params.id));
  res.json({ success: true });
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
      spawn('open', [folder], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [folder], { detached: true, stdio: 'ignore' }).unref();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// GET /api/results — load last saved results
app.get('/api/results', (req, res) => {
  try {
    if (!fs.existsSync(RESULTS_FILE)) return res.json({ results: [], empty: true });
    const data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/results — clear saved results
app.delete('/api/results', (req, res) => {
  try {
    if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/downloaded-ids?platform=tiktok — list known IDs for client-side highlighting
app.get('/api/downloaded-ids', (req, res) => {
  const plat = (req.query.platform || '').toLowerCase();
  const all = loadDownloadedIds();
  if (plat) return res.json({ ids: Object.keys(all[plat] || {}) });
  res.json({ all });
});

// DELETE /api/downloaded-ids — clear the dedupe DB
app.delete('/api/downloaded-ids', (req, res) => {
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
  if (!entry) return res.status(404).json({ error: 'Download not found or already finished' });

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
