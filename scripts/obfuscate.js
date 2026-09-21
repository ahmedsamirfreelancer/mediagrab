/**
 * Obfuscate JS source files before electron-builder packages them.
 *
 * Strategy:
 *  - Back up the originals to .obfuscate-backup/.
 *  - Run javascript-obfuscator on them in place with moderate settings (high
 *    settings break Express/Socket.IO dynamic requires).
 *  - scripts/restore.js puts the originals back after the build.
 *
 * Run via `npm run build` (calls this script then electron-builder).
 *
 * NOTE: MediaGrab is free — there is no license key, no serial and no build
 * secret to inject any more. This step is now cosmetic (it just makes the
 * shipped bundle less readable) and nothing depends on it succeeding.
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, '.obfuscate-backup');

// server/server.js and server/public/app.js are deliberately left readable:
// obfuscating them broke Express middleware and made every UI bug untraceable.
const TARGETS = [
  'main.js',
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

// Obfuscated output is one enormous line of `_0x…` names, so a file that
// still reads like source has not been through here.
function looksObfuscated(file) {
  const head = fs.readFileSync(file, 'utf8').slice(0, 400).trim();
  return head.startsWith('var _0x') || head.startsWith('const _0x') || head.startsWith('function _0x');
}

/**
 * Put a pristine copy in .obfuscate-backup/ before mangling the file.
 *
 * The backup is REFRESHED from the current source every run. It used to be
 * kept forever and copied back OVER the source instead — so a backup left
 * behind by an interrupted build (restore.js threw on a target the project no
 * longer had) silently replaced months-newer source with an old snapshot.
 * The backup only wins when the source is itself still obfuscated, i.e. a
 * build that really was interrupted.
 */
function backupRestore(rel) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) return null;
  const backup = path.join(BACKUP_DIR, rel);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (fs.existsSync(backup) && looksObfuscated(src)) {
    fs.copyFileSync(backup, src);
  } else {
    fs.copyFileSync(src, backup);
  }
  return src;
}

function backupAndObfuscate(rel) {
  const src = backupRestore(rel);
  if (!src) { console.warn(`  skip (missing): ${rel}`); return; }
  const code = fs.readFileSync(src, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, OPTIONS);
  fs.writeFileSync(src, result.getObfuscatedCode());
  console.log(`  obfuscated: ${rel} (${code.length} → ${result.getObfuscatedCode().length} bytes)`);
}

function main() {
  console.log('▶ MediaGrab obfuscate');
  for (const t of TARGETS) backupAndObfuscate(t);
  console.log('✓ Done. Originals backed up at .obfuscate-backup/');
}

main();
