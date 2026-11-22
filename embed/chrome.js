/* Open external links in Google Chrome (never Edge unless nothing else exists). */
const { shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function findChrome() {
  const env = process.env;
  const c = [
    env.ProgramFiles && path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return c.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

async function openInChrome(url) {
  url = String(url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, chrome: false };
  const chrome = findChrome();
  if (chrome) {
    try {
      const child = spawn(chrome, [url], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return { ok: true, chrome: true };
    } catch { /* fall through */ }
  }
  await shell.openExternal(url);
  return { ok: true, chrome: false };
}

module.exports = { openInChrome, findChrome };
