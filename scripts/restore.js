/**
 * Restore the pristine source files from .obfuscate-backup/.
 * Run after `npm run build` if you want to continue developing.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, '.obfuscate-backup');

function walk(dir, relBase = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(relBase, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

function main() {
  if (!fs.existsSync(BACKUP_DIR)) {
    console.log('Nothing to restore (no backup directory).');
    return;
  }
  const files = walk(BACKUP_DIR);
  let done = 0;
  for (const rel of files) {
    const dest = path.join(ROOT, rel);
    // A backup for something the project no longer has is stale, not a job to
    // do — and throwing on it used to abort the whole restore, leaving the
    // rest of the backup behind to overwrite good source on the next build.
    if (!fs.existsSync(path.dirname(dest))) {
      console.log(`  skipped (gone from the project): ${rel}`);
      continue;
    }
    fs.copyFileSync(path.join(BACKUP_DIR, rel), dest);
    console.log(`  restored: ${rel}`);
    done++;
  }
  // Nothing outlives the build: a leftover backup is what turns an
  // interrupted build into lost work.
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  console.log(`✓ Restored ${done} file(s).`);
}

main();
