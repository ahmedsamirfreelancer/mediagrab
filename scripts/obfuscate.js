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

// Build-time secret. Set MEDIAGRAB_BUILD_SECRET in your shell before
// `npm run build` (or in a .env.production file). MUST match arqami.app's
// LICENSE_TOKEN_SECRET env var.
const BUILD_SECRET = process.env.MEDIAGRAB_BUILD_SECRET
  || readEnvFile('.env.production', 'MEDIAGRAB_BUILD_SECRET')
  || null;

function readEnvFile(name, key) {
  const f = path.join(ROOT, name);
  if (!fs.existsSync(f)) return null;
  const line = fs.readFileSync(f, 'utf8').split(/\r?\n/).find((l) => l.trim().startsWith(key + '='));
  return line ? line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : null;
}

if (!BUILD_SECRET) {
  console.error('');
  console.error('✗ MEDIAGRAB_BUILD_SECRET is required.');
  console.error('  Set it in your shell or create .env.production with:');
  console.error('    MEDIAGRAB_BUILD_SECRET="your-secret-matching-arqami-app"');
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
  if (!code.includes('__BUILD_TIME_SECRET__')) {
    throw new Error('license/client.js no longer contains __BUILD_TIME_SECRET__ placeholder');
  }
  code = code.replace(/'__BUILD_TIME_SECRET__'/g, JSON.stringify(BUILD_SECRET));
  const ownerKey = process.env.MEDIAGRAB_OWNER_KEY
    || readEnvFile('.env.production', 'MEDIAGRAB_OWNER_KEY')
    || '';
  code = code.replace(/'__BUILD_TIME_OWNER_KEY__'/g, JSON.stringify(ownerKey));
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
