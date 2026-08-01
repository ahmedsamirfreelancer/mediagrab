/**
 * MediaGrab License Client
 *
 * Talks to arqami.app license API and persists state in userData/license.json.
 *
 * - Hardware fingerprint is the "domain" field on the server side
 *   (license_products.type='desktop'). One key = one machine.
 * - On activate, server returns a signed token. We verify the signature
 *   locally so the user can keep working briefly even if the server is
 *   unreachable. After grace_days we lock down.
 * - cron_validate runs once at startup and once a day.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');

const API_BASE = process.env.MEDIAGRAB_LICENSE_API || 'https://arqami.app/api/license';
const PRODUCT_SLUG = 'mediagrab';
const APP_VERSION = '1.0.0';

// Ed25519 PUBLIC key used to verify server-signed tokens offline. It is safe
// to ship in readable form — a public key can only VERIFY, never sign/forge.
// The matching PRIVATE key never leaves arqami.app. At build time,
// scripts/obfuscate.js replaces the placeholder below with the real PEM.
// In dev, MEDIAGRAB_LICENSE_PUBKEY (base64 of the PEM) can override.
const PUBLIC_KEY_PEM = process.env.MEDIAGRAB_LICENSE_PUBKEY
  ? Buffer.from(process.env.MEDIAGRAB_LICENSE_PUBKEY, 'base64').toString('utf8')
  : '__BUILD_TIME_PUBLIC_KEY__';

// Optional owner license key. If a value is baked in at build time, the app
// will auto-activate with it on first launch (no manual key entry needed for
// the owner's own machines). Leave as the placeholder for customer builds —
// scripts/obfuscate.js wipes it to an empty string unless MEDIAGRAB_OWNER_KEY
// is set in the build env.
const OWNER_KEY = process.env.MEDIAGRAB_OWNER_KEY || '__BUILD_TIME_OWNER_KEY__';

const GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

let storeFile = null;
let cache = null;

function init(userDataDir) {
  storeFile = path.join(userDataDir, 'license.json');
  cache = readStore();
  return module.exports;
}

function readStore() {
  try {
    if (!fs.existsSync(storeFile)) return {};
    return JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  } catch { return {}; }
}

function writeStore() {
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const tmp = storeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, storeFile);
  } catch (e) {
    console.error('license store write failed:', e.message);
  }
}

/**
 * Cache the result so we don't shell out on every API call.
 */
let cachedFingerprint = null;

/**
 * Read Windows MachineGuid from registry. Stable for the lifetime of the
 * Windows install — survives username changes, hostname changes, drive
 * letter remaps. Set fresh by sysprep/clone.
 */
function readWindowsMachineGuid() {
  // Retry a few times: on a busy/slow boot (antivirus, disk churn) a single
  // reg query can time out. A miss here used to drop us to the volatile
  // CPU-hash fallback below, producing a DIFFERENT fingerprint and kicking the
  // user to the activation screen. Retrying makes that far less likely.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = execSync(
        'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: 'utf8', windowsHide: true, timeout: 8000 }
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]+)/i);
      if (m) return m[1].toLowerCase();
    } catch { /* retry */ }
  }
  return null;
}

/**
 * Read the macOS IOPlatformUUID — the Mac equivalent of MachineGuid. Stable
 * for the life of the machine (it's burned into the hardware, so unlike the
 * Windows GUID it even survives a clean reinstall).
 */
function readMacPlatformUuid() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', {
        encoding: 'utf8',
        timeout: 8000,
      });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1].toLowerCase();
    } catch { /* retry */ }
  }
  return null;
}

/**
 * Build a stable per-machine ID. On Windows we use MachineGuid and on macOS
 * IOPlatformUUID (both rock solid). Anywhere else we fall back to hashed
 * CPU + memory + arch.
 */
function getHardwareFingerprint() {
  if (cachedFingerprint) return cachedFingerprint;

  if (process.platform === 'win32' || process.platform === 'darwin') {
    const id = process.platform === 'win32'
      ? readWindowsMachineGuid()
      : readMacPlatformUuid();
    if (id) {
      // Hash so the license API never sees the raw machine GUID.
      cachedFingerprint = crypto.createHash('sha256').update('mediagrab:' + id).digest('hex').substring(0, 32);
      return cachedFingerprint;
    }
    // Machine id unreadable this boot. Do NOT invent a fresh CPU-hash — that
    // would differ from the id we activated with and log the user
    // out. Reuse the last-known fingerprint persisted at activation instead.
    if (cache && cache.fingerprint) {
      cachedFingerprint = cache.fingerprint;
      return cachedFingerprint;
    }
  }

  // Fallback (non-Windows, or Windows with no GUID and no stored id yet):
  // stable hardware attributes (no username, no homedir).
  const cpu = os.cpus()[0]?.model || 'unknown';
  const raw = `${process.platform}|${os.arch()}|${cpu}|${os.totalmem()}`;
  cachedFingerprint = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
  return cachedFingerprint;
}

/**
 * Verify the server-signed token offline using the embedded Ed25519 public key.
 * Server's generateLicenseToken format:
 *   base64(`${product}|${domain}|${tokenExp}|${licExp}:${ed25519SigBase64}`)
 */
function verifyToken(token) {
  if (!token) return { valid: false, reason: 'no_token' };
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const lastColon = decoded.lastIndexOf(':');
    if (lastColon === -1) return { valid: false, reason: 'malformed' };
    const payload = decoded.slice(0, lastColon);
    const sig = decoded.slice(lastColon + 1);
    const ok = crypto.verify(null, Buffer.from(payload), PUBLIC_KEY_PEM, Buffer.from(sig, 'base64'));
    if (!ok) return { valid: false, reason: 'invalid_signature' };
    const [product, domain, tokenExpStr] = payload.split('|');
    const tokenExp = parseInt(tokenExpStr, 10);
    if (Math.floor(Date.now() / 1000) > tokenExp) {
      return { valid: false, reason: 'token_expired', product, domain };
    }
    return { valid: true, product, domain };
  } catch (e) {
    return { valid: false, reason: 'error', error: e.message };
  }
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': `MediaGrab/${APP_VERSION}`,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { resolve({ success: false, message: 'Invalid response' }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function apiCall(endpoint, extra = {}) {
  return postJson(`${API_BASE}/${endpoint}`, {
    license_key: cache.key || extra.license_key,
    product: PRODUCT_SLUG,
    domain: getHardwareFingerprint(),
    site_url: `mediagrab://desktop`,
    wp_version: '',
    php_version: process.version,
    plugin_version: APP_VERSION,
    ...extra,
  });
}

/* ─── Public API ───────────────────────────────────────────────────────── */

async function activate(licenseKey) {
  const key = String(licenseKey || '').trim();
  if (!key) return { success: false, message: 'أدخل مفتاح الترخيص' };

  let result;
  try {
    result = await apiCall('activate', { license_key: key });
  } catch (e) {
    return { success: false, message: 'فشل الاتصال بسيرفر التراخيص: ' + e.message };
  }

  if (result?.success !== true) {
    return { success: false, message: result?.message || 'فشل التفعيل' };
  }

  cache.key = key;
  cache.status = 'active';
  cache.fingerprint = getHardwareFingerprint();
  cache.lastValid = Date.now();
  cache.expiresAt = result.expires_at || null;
  cache.token = result.token || null;
  cache.tokenSavedAt = Date.now();
  writeStore();

  return { success: true, message: result.message || 'تم التفعيل', expiresAt: cache.expiresAt };
}

async function deactivate() {
  if (cache.key) {
    try { await apiCall('deactivate', { license_key: cache.key }); }
    catch (e) { console.warn('deactivate api failed:', e.message); }
  }
  cache = {};
  writeStore();
  return { success: true };
}

async function validate() {
  if (!cache.key) return { valid: false, reason: 'no_key' };

  // Fast path — verify cached token locally.
  const tokCheck = verifyToken(cache.token);
  if (tokCheck.valid && tokCheck.domain === getHardwareFingerprint()) {
    return { valid: true, source: 'token' };
  }

  // Token missing/expired — call server.
  let result;
  try {
    result = await apiCall('validate');
  } catch (e) {
    // Server unreachable — apply grace period.
    const since = Date.now() - (cache.lastValid || 0);
    if (since < GRACE_DAYS * DAY_MS) {
      return { valid: true, source: 'grace', warn: 'Server unreachable, using grace period' };
    }
    return { valid: false, reason: 'server_unreachable' };
  }

  if (result?.success && result.valid) {
    cache.status = 'active';
    cache.lastValid = Date.now();
    // Trust the server's expiry verbatim — including null (lifetime license).
    // Using `|| cache.expiresAt` here would keep a stale old date and lock a
    // machine that the server now considers lifetime.
    cache.expiresAt = result.expires_at != null ? result.expires_at : null;
    if (result.token) {
      cache.token = result.token;
      cache.tokenSavedAt = Date.now();
    }
    writeStore();
    return { valid: true, source: 'server' };
  }

  // Only an EXPLICIT negative verdict from the server should log the user out.
  // A server error (500 / malformed / success:false with no verdict) is a
  // transient glitch — deploys, DB hiccups — and must NOT wipe the license.
  // Treat it like "unreachable" and fall back to the grace window instead of
  // marking the machine invalid and nuking the token.
  const explicitReason = result?.success === true
    && result.valid === false
    && (result.reason === 'revoked' || result.reason === 'expired' || result.reason === 'invalid_key');

  if (!explicitReason) {
    const since = Date.now() - (cache.lastValid || 0);
    if (since < GRACE_DAYS * DAY_MS) {
      return { valid: true, source: 'grace', warn: 'Validation glitch, using grace period' };
    }
    return { valid: false, reason: 'server_error' };
  }

  // Server explicitly says the license is dead.
  cache.status = result.reason === 'revoked' ? 'revoked'
              : result.reason === 'expired' ? 'expired'
              : 'invalid';
  cache.token = null;
  writeStore();
  return { valid: false, reason: result.reason };
}

/**
 * Try to silently activate using the owner key baked in at build time.
 * Returns true if activation succeeded (caller can skip the activation UI).
 * No-op if no owner key was provided at build time, or if a license is
 * already active.
 */
async function tryAutoActivateWithOwnerKey() {
  if (isValid()) return true;
  // OWNER_KEY is replaced at build time. For customer builds it becomes "".
  // For owner builds it becomes a real ARQ-XXXXX-... key. We can't compare
  // against the placeholder string here, because the global /g replacement
  // in obfuscate.js would substitute it too.
  const key = (OWNER_KEY || '').trim();
  if (!key) return false;
  try {
    const res = await activate(key);
    return res.success === true;
  } catch {
    return false;
  }
}

function isValid() {
  if (cache.status !== 'active') return false;
  if (cache.expiresAt && new Date(cache.expiresAt) < new Date()) return false;
  // NOTE: we deliberately do NOT hard-fail on a fingerprint mismatch here.
  // mediagrab is a lifetime license that follows the machine — if the
  // fingerprint drifts, the server rebinds it on the next validate(). Kicking
  // the user to the activation screen synchronously (before that server heal
  // could run) was the main cause of the "logs out after a while" complaints.
  // The signed token already binds the domain; trust it + the grace window.
  const tokCheck = verifyToken(cache.token);
  if (tokCheck.valid) return true;
  // Token expired — fall back to grace window
  const since = Date.now() - (cache.lastValid || 0);
  return since < GRACE_DAYS * DAY_MS;
}

function getStatus() {
  return {
    licensed: isValid(),
    status: cache.status || 'inactive',
    keyMasked: cache.key
      ? cache.key.slice(0, 8) + '•'.repeat(Math.max(0, cache.key.length - 13)) + cache.key.slice(-5)
      : '',
    expiresAt: cache.expiresAt || null,
    fingerprint: getHardwareFingerprint(),
    lastValid: cache.lastValid || null,
  };
}

let cronTimer = null;
function startCron() {
  if (cronTimer) return;
  // Validate at startup (delayed 30s to let app finish booting) then every 24h.
  setTimeout(() => { validate().catch(() => {}); }, 30 * 1000);
  cronTimer = setInterval(() => { validate().catch(() => {}); }, DAY_MS);
}

module.exports = {
  init,
  activate,
  deactivate,
  validate,
  isValid,
  getStatus,
  startCron,
  getHardwareFingerprint,
  tryAutoActivateWithOwnerKey,
};
