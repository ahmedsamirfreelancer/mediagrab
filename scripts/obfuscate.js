/**
 * Obfuscate JS source files before electron-builder packages them.
 *
 * Strategy:
 *  - Copy main.js, license/*.js, server/server.js, server/public/app.js
 *    to a "build-obfuscated/" mirror.
 *  - Run javascript-obfuscator on each with moderate settings (high settings
 *    break Express/Socket.IO dynamic requires).
 *  - electron-builder is configured to package from the project root; we
 *    overwrite the originals after backing them up to build-orig/.
 *
 * Run via `npm run build` (calls this script then electron-builder).
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, '.obfuscate-backup');

// Focus obfuscation on files that hold license logic + secrets. Leaving
// server/server.js readable means the dev loop stays fast and Express
// middleware quirks don't surface as obfuscation bugs.
// NOTE: client.js is excluded because the obfuscator was breaking the
// async activate flow (network call fired but the result wasn't being
// returned to main.js). Secrets are still injected at build time but the
// final code is readable — acceptable tradeoff since the bigger protection
// is the token signature, not the obfuscation.
const TARGETS = [
  'main.js',
  'license/preload.js',
  'license/activate.js',
];

// Files that still need build-time secret injection but should NOT be
// obfuscated. We rewrite them in place from the backup, then leave them be.
const SECRET_INJECT_ONLY = [
  'license/client.js',
];

// Moderate obfuscation — keeps Express/Socket.IO working.
const OPTIONS = {
  compact: true,
  controlFlowFlattening: false,    // breaks async/await in some node builds
  deadCodeInjection: false,
  identifierNamesGenerator: 'mangled',
  renameGlobals: false,
  selfDefending: false,
  stringArray: true,
  stringArrayThreshold: 0.5,
  stringArrayEncoding: ['base64'],
  stringArrayWrappersCount: 1,
  transformObjectKeys: false,      // breaks Express middleware
  unicodeEscapeSequence: false,
  reservedNames: ['^require$', '^module$', '^exports$', '^process$', '^global$'],
};

// Build-time Ed25519 PUBLIC key (PEM) embedded into the app to verify
// server-signed license tokens offline. It is PUBLIC — safe to ship; it can
// only verify, never sign/forge. The matching private key lives only on
// arqami.app. Set MEDIAGRAB_PUBLIC_KEY in your shell before `npm run build`
// (GitHub Actions passes it as a secret) or in a .env.production file.
let PUBLIC_KEY = process.env.MEDIAGRAB_PUBLIC_KEY
  || readEnvFile('.env.production', 'MEDIAGRAB_PUBLIC_KEY')
  || null;

function readEnvFile(name, key) {
  const f = path.join(ROOT, name);
  if (!fs.existsSync(f)) return null;
  const line = fs.readFileSync(f, 'utf8').split(/\r?\n/).find((l) => l.trim().startsWith(key + '='));
  return line ? line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : null;
}

// Accept a base64-encoded PEM too (convenient for a single-line .env.production).
if (PUBLIC_KEY && !PUBLIC_KEY.includes('BEGIN PUBLIC KEY')) {
  try { PUBLIC_KEY = Buffer.from(PUBLIC_KEY, 'base64').toString('utf8'); } catch { /* keep as-is */ }
}

if (!PUBLIC_KEY || !PUBLIC_KEY.includes('BEGIN PUBLIC KEY')) {
  console.error('');
  console.error('✗ MEDIAGRAB_PUBLIC_KEY (Ed25519 PEM) is required.');
  console.error('  Set it in your shell or create .env.production with:');
  console.error('    MEDIAGRAB_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----"');
  console.error('  (a base64-encoded PEM is also accepted)');
  console.error('');
  process.exit(1);
}

function backupRestore(rel) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) return null;
  const backup = path.join(BACKUP_DIR, rel);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(src, backup);
  } else {
    fs.copyFileSync(backup, src);
  }
  return src;
}

function injectSecrets(code, rel) {
  if (rel !== 'license/client.js') return code;
  if (!code.includes('__BUILD_TIME_PUBLIC_KEY__')) {
    throw new Error('license/client.js no longer contains __BUILD_TIME_PUBLIC_KEY__ placeholder');
  }
  // Inject the (public) Ed25519 verification key. JSON.stringify keeps the
  // PEM newlines as a valid JS string literal.
  code = code.replace(/'__BUILD_TIME_PUBLIC_KEY__'/g, JSON.stringify(PUBLIC_KEY));
  // Owner key is intentionally NOT baked into distributed builds anymore: every
  // copy now requires a real serial. The owner activates manually once.
  code = code.replace(/'__BUILD_TIME_OWNER_KEY__'/g, JSON.stringify(''));
  return code;
}

function backupAndObfuscate(rel) {
  const src = backupRestore(rel);
  if (!src) { console.warn(`  skip (missing): ${rel}`); return; }
  let code = fs.readFileSync(src, 'utf8');
  code = injectSecrets(code, rel);
  const result = JavaScriptObfuscator.obfuscate(code, OPTIONS);
  fs.writeFileSync(src, result.getObfuscatedCode());
  console.log(`  obfuscated: ${rel} (${code.length} → ${result.getObfuscatedCode().length} bytes)`);
}

function injectOnly(rel) {
  const src = backupRestore(rel);
  if (!src) { console.warn(`  skip (missing): ${rel}`); return; }
  let code = fs.readFileSync(src, 'utf8');
  code = injectSecrets(code, rel);
  fs.writeFileSync(src, code);
  console.log(`  secrets injected (not obfuscated): ${rel}`);
}

function main() {
  console.log('▶ MediaGrab obfuscate');
  for (const t of SECRET_INJECT_ONLY) injectOnly(t);
  for (const t of TARGETS) backupAndObfuscate(t);
  console.log('✓ Done. Originals backed up at .obfuscate-backup/');
}

main();
