/**
 * Download bundled binaries (yt-dlp, ffmpeg, ffprobe) into resources/.
 * Run automatically by `npm install` (postinstall hook) so we don't have
 * to commit ~200MB of binaries to git.
 *
 * Idempotent: if a binary already exists at the expected path, skip it.
 * Set FORCE_DOWNLOAD=1 to re-download anyway.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const RESOURCES_DIR = path.join(__dirname, '..', 'resources');
const FORCE = process.env.FORCE_DOWNLOAD === '1';

// yt-dlp.exe is small (~10MB). Use the NIGHTLY channel, not stable: Instagram
// (a core platform here) breaks frequently and the fixes land in nightly weeks
// before they reach a stable release — the stable build is regularly unable to
// extract Instagram at all ("marked as broken"). The app also self-updates
// yt-dlp to nightly on launch (see main.js), so what's bundled is just a floor.
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe';

// ffmpeg/ffprobe are huge (~95MB each). Use the gyan.dev essentials build —
// a well-maintained Windows static build that's small and battery-included.
// We extract just the two .exe files we need from the .7z, OR fall back to
// pre-extracted nightly downloads if 7z isn't available.
const FFMPEG_RELEASE_URL = 'https://github.com/GyanD/codexffmpeg/releases/download/2024-09-30-git-44a108ce69/ffmpeg-2024-09-30-git-44a108ce69-essentials_build.zip';

function exists(p) {
  return fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024; // > 1MB
}

function downloadFile(url, dest, attempt = 0) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.partial';
    const file = fs.createWriteStream(tmp);
    https.get(url, { headers: { 'User-Agent': 'MediaGrab-build' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close();
        try { fs.unlinkSync(tmp); } catch {}
        return downloadFile(res.headers.location, dest, attempt).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(tmp); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const pct = ((received / total) * 100).toFixed(1);
          process.stdout.write(`\r  downloading ${path.basename(dest)}: ${pct}%`);
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          process.stdout.write('\n');
          fs.renameSync(tmp, dest);
          resolve(dest);
        });
      });
    }).on('error', (e) => {
      file.close();
      try { fs.unlinkSync(tmp); } catch {}
      reject(e);
    });
  });
}

async function downloadYtdlp() {
  const dest = path.join(RESOURCES_DIR, 'yt-dlp.exe');
  if (exists(dest) && !FORCE) {
    console.log('  ✓ yt-dlp.exe already present, skipping');
    return;
  }
  await downloadFile(YTDLP_URL, dest);
  console.log('  ✓ yt-dlp.exe downloaded');
}

async function downloadFfmpeg() {
  const ffmpegDest = path.join(RESOURCES_DIR, 'ffmpeg.exe');
  const ffprobeDest = path.join(RESOURCES_DIR, 'ffprobe.exe');
  if (exists(ffmpegDest) && exists(ffprobeDest) && !FORCE) {
    console.log('  ✓ ffmpeg.exe + ffprobe.exe already present, skipping');
    return;
  }

  // Try to use PowerShell to download + extract the ZIP without extra deps.
  // (Node has no built-in ZIP extractor; PowerShell ships with Windows.)
  const zipPath = path.join(RESOURCES_DIR, 'ffmpeg.zip');
  console.log('  downloading ffmpeg bundle (~75MB)…');
  await downloadFile(FFMPEG_RELEASE_URL, zipPath);

  console.log('  extracting ffmpeg.exe + ffprobe.exe…');
  const extractDir = path.join(RESOURCES_DIR, '_ffmpeg-extract');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  if (process.platform === 'win32') {
    execSync(`powershell -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${extractDir}'"`, { stdio: 'inherit' });
  } else {
    execSync(`unzip -q -o "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' });
  }

  // Find the .exe files inside the extracted bundle (one folder deep).
  function findExe(name) {
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const r = walk(full);
          if (r) return r;
        } else if (entry.name.toLowerCase() === name.toLowerCase()) {
          return full;
        }
      }
      return null;
    }
    return walk(extractDir);
  }

  const ffmpegSrc = findExe('ffmpeg.exe');
  const ffprobeSrc = findExe('ffprobe.exe');
  if (!ffmpegSrc || !ffprobeSrc) {
    throw new Error('ffmpeg.exe or ffprobe.exe not found in extracted bundle');
  }

  fs.copyFileSync(ffmpegSrc, ffmpegDest);
  fs.copyFileSync(ffprobeSrc, ffprobeDest);
  console.log('  ✓ ffmpeg.exe + ffprobe.exe extracted');

  // Clean up
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.unlinkSync(zipPath);
}

async function main() {
  if (process.platform !== 'win32' && !process.env.CI) {
    console.log('  ℹ Not on Windows — skipping binary download (CI/dev only on Win)');
    return;
  }
  console.log('▶ MediaGrab: downloading bundled binaries');
  fs.mkdirSync(RESOURCES_DIR, { recursive: true });
  await downloadYtdlp();
  await downloadFfmpeg();
  console.log('✓ All binaries ready in resources/');
}

main().catch((e) => {
  console.error('\n✗ Binary download failed:', e.message);
  console.error('  You can re-run manually: node scripts/download-binaries.js');
  // Don't fail the install — user can still develop without binaries
  // (just can't run downloads until they fetch them).
  process.exit(0);
});
