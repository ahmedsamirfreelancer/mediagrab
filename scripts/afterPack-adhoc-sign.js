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
 * The user still has to clear the quarantine flag once — see docs/macos-install.md.
 *
 * No-op on Windows/Linux builds.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// The same "unsigned arm64 binary = SIGKILL" rule applies to yt-dlp, ffmpeg and
// ffprobe, which we ship in Contents/Resources/bin. `codesign --deep` does NOT
// reach them: --deep recurses into nested *bundles* (frameworks, helper apps,
// plug-ins), while a bare Mach-O sitting in Resources is treated as data and
// left unsigned. Signing the app with unsigned executables inside it therefore
// produces a bundle that launches but can't download anything — which is
// exactly how this looked in the field. So sign each binary first, then the
// bundle around them (signing the outer bundle seals whatever is inside, so
// the order matters).
const BUNDLED_BINARIES = ['yt-dlp', 'ffmpeg', 'ffprobe'];

function sign(target, extraArgs = []) {
  execFileSync('codesign', ['--force', ...extraArgs, '--sign', '-', target], { stdio: 'inherit' });
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const binDir = path.join(appPath, 'Contents', 'Resources', 'bin');

  for (const name of BUNDLED_BINARIES) {
    const bin = path.join(binDir, name);
    if (!fs.existsSync(bin)) {
      // A missing engine means the packaged app can't download at all. Fail the
      // build here rather than shipping a .dmg that only breaks on the user's Mac.
      throw new Error(`bundled binary missing from the app: ${bin}`);
    }
    fs.chmodSync(bin, 0o755);
    console.log(`▶ ad-hoc signing ${name}`);
    sign(bin);
  }

  console.log(`▶ ad-hoc signing ${appPath}`);
  sign(appPath, ['--deep']);

  // Prove the signature is valid before the .dmg is wrapped around it. An
  // invalid signature is what macOS reports as "damaged", and we'd rather see
  // that in CI than in a support message.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
  console.log('✓ ad-hoc signature applied and verified');
};
