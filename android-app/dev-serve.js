/*
 * dev-serve.js — development server for the Android app over WiFi.
 *
 * Serves the live web UI (www/) as the web root so the installed app (whose
 * capacitor.config server.url points here) always loads the latest interface —
 * no APK reinstall needed for UI/JS changes. Also exposes the APK at
 * /mediagrab.apk for the one-time install.
 *
 * No-cache headers force the WebView to fetch fresh files every launch.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const WWW = path.join(__dirname, 'www');
const APK = path.join(__dirname, 'dist-apk', 'mediagrab.apk');
const PORT = 8000;
const HOST = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

function send(res, code, headers, stream) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers));
  if (stream && stream.pipe) stream.pipe(res);
  else res.end(stream || '');
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // The APK download endpoint
  if (urlPath === '/mediagrab.apk') {
    if (!fs.existsSync(APK)) return send(res, 404, {}, 'apk not built yet');
    const stat = fs.statSync(APK);
    return send(res, 200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': stat.size,
      'Content-Disposition': 'attachment; filename="mediagrab.apk"',
    }, fs.createReadStream(APK));
  }

  // Otherwise serve the live web UI from www/
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const file = path.normalize(path.join(WWW, urlPath));
  if (!file.startsWith(WWW)) return send(res, 403, {}, 'forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, {}, 'not found');
  }
  const ext = path.extname(file).toLowerCase();
  send(res, 200, { 'Content-Type': MIME[ext] || 'application/octet-stream' }, fs.createReadStream(file));
});

server.listen(PORT, HOST, () => {
  console.log('MediaGrab dev server on http://' + HOST + ':' + PORT + ' (www live + /mediagrab.apk)');
});
