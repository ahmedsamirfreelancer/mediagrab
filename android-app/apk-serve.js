// Minimal LAN file server for handing the APK to the phone over WiFi.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'dist-apk');
const PORT = 8000;

const server = http.createServer((req, res) => {
  let name = decodeURIComponent((req.url || '/').split('?')[0]);
  if (name === '/' || name === '') {
    // simple index so the phone browser shows a download link
    const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.apk'));
    const links = files
      .map((f) => `<li><a href="/${f}">${f}</a></li>`)
      .join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<h2>MediaGrab</h2><ul>${links}</ul>`);
  }
  const file = path.join(ROOT, path.basename(name));
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('not found');
  }
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Length': stat.size,
    'Content-Disposition': 'attachment; filename="' + path.basename(file) + '"',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('APK server listening on 0.0.0.0:' + PORT);
});
