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
  for (const rel of files) {
    fs.copyFileSync(path.join(BACKUP_DIR, rel), path.join(ROOT, rel));
    console.log(`  restored: ${rel}`);
  }
  console.log(`✓ Restored ${files.length} file(s).`);
}

main();
