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
