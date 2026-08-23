/**
 * Assemble android-app/www/ from the desktop UI.
 *
 * The Android app runs the SAME web interface as the Electron build. It used to
 * live in its own repo as a hand-copied snapshot, which drifted ~300 lines
 * behind before anyone noticed. Now there is one source of truth —
 * ../server/public — and this script rebuilds www/ from it on every build.
 *
 * The only Android-specific web file is www-shim/platformBridge.js: there is no
 * local Express/Socket.IO server on a phone, so the shim fakes the socket,
 * answers /api/* itself, and routes downloads to the native yt-dlp plugin.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, '..', 'server', 'public');
const SHIM = path.join(ROOT, 'www-shim');
const OUT = path.join(ROOT, 'www');

// index.html loads socket.io from the local server on desktop. On Android that
// URL resolves to nothing, so the bridge takes its place — same file otherwise.
const SOCKET_TAG = '<script src="/socket.io/socket.io.js"></script>';
const BRIDGE_TAG = '<script src="platformBridge.js"></script>';

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error(`desktop UI not found at ${SRC}`);

  fs.rmSync(OUT, { recursive: true, force: true });
  copyDir(SRC, OUT);
  copyDir(SHIM, OUT);

  const indexPath = path.join(OUT, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  if (!html.includes(SOCKET_TAG)) {
    // Fail rather than ship a build whose UI never gets a socket: every queue
    // and progress update in the app rides on it.
    throw new Error('index.html no longer contains the socket.io script tag — update SOCKET_TAG');
  }
  html = html.split(SOCKET_TAG).join(BRIDGE_TAG);
  fs.writeFileSync(indexPath, html, 'utf8');

  console.log(`✓ www/ built from ${path.relative(ROOT, SRC)} (+ platformBridge shim)`);
}

main();
