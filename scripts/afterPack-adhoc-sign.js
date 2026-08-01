/**
 * Ad-hoc code-sign the macOS .app right after it's packed (and before the .dmg
 * is built around it).
 *
 * Why this exists: we have no Apple Developer ID, so electron-builder packs the
 * app unsigned. That's merely inconvenient on Intel (Gatekeeper prompt), but on
 * Apple Silicon it's fatal — macOS refuses to launch ANY arm64 binary without
 * at least an ad-hoc signature, and the user just sees "MediaGrab is damaged
 * and can't be opened". `codesign --sign -` costs nothing and fixes that.
 *
 * The user still has to right-click → Open once, because an ad-hoc signature
 * isn't a trusted developer identity — see docs/macos-install.md.
 *
 * No-op on Windows/Linux builds.
 */

const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`▶ ad-hoc signing ${appPath}`);
  // --deep so the bundled yt-dlp/ffmpeg/ffprobe and Electron's own frameworks
  // get a signature too; an unsigned nested binary invalidates the bundle.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log('✓ ad-hoc signature applied');
};
