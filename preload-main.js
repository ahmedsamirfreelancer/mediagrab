/**
 * Preload for the main MediaGrab window (the one that loads http://127.0.0.1:3456).
 * Exposes Electron-side functionality (Instagram login, license info) to the
 * web UI through window.electronAPI.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Instagram in-app login + direct API fetch (uses Chromium's network stack
  // to bypass the bot detection that blocks Node's https module).
  instagram: {
    status: () => ipcRenderer.invoke('instagram:status'),
    login: () => ipcRenderer.invoke('instagram:login'),
    logout: () => ipcRenderer.invoke('instagram:logout'),
    apiFetch: (url) => ipcRenderer.invoke('instagram:apiFetch', url),
    searchViaPage: (query) => ipcRenderer.invoke('instagram:searchViaPage', query),
    // Open instagram.com search in a visible (mobile-UA) window with download
    // buttons on every reel — the Instagram twin of tiktok.openSearchWindow.
    openSearchWindow: (query, base) => ipcRenderer.invoke('instagram:openSearchWindow', query, base),
    onEmbedDownload: (cb) => ipcRenderer.on('instagram-embed:download', (_e, data) => cb(data)),
  },
  // Facebook in-app login (same pattern as Instagram)
  facebook: {
    status: () => ipcRenderer.invoke('facebook:status'),
    login: () => ipcRenderer.invoke('facebook:login'),
    logout: () => ipcRenderer.invoke('facebook:logout'),
  },
  // TikTok in-app login + real-page search (matches tiktok.com results)
  tiktok: {
    status: () => ipcRenderer.invoke('tiktok:status'),
    login: () => ipcRenderer.invoke('tiktok:login'),
    logout: () => ipcRenderer.invoke('tiktok:logout'),
    searchViaPage: (query) => ipcRenderer.invoke('tiktok:searchViaPage', query),
    cookiesFromBrowser: () => ipcRenderer.invoke('tiktok:cookiesFromBrowser'),
    openSearchWindow: (query, base) => ipcRenderer.invoke('tiktok:openSearchWindow', query, base),
    // Fires when a download button inside the embedded TikTok window is clicked.
    onEmbedDownload: (cb) => ipcRenderer.on('tiktok-embed:download', (_e, data) => cb(data)),
  },
  // Manual cookies.txt import — workaround for Chrome 127+ DPAPI lock
  cookies: {
    import: (platform) => ipcRenderer.invoke('cookies:import', platform),
  },
  // Reverse image search — paste a product screenshot, get its Google Lens
  // results page opened in the default browser to read the English name.
  image: {
    reverseSearch: (bytes, mime) => ipcRenderer.invoke('image:reverseSearch', bytes, mime),
  },
  // License info (read-only; activation happens at the gate before this window opens)
  license: {
    getStatus: () => ipcRenderer.invoke('license:getStatus'),
    deactivate: () => ipcRenderer.invoke('license:deactivate'),
  },
  // yt-dlp updater
  ytdlp: {
    check: () => ipcRenderer.invoke('ytdlp:check'),
    update: () => ipcRenderer.invoke('ytdlp:update'),
  },
  // Shell — used to open the downloaded file/folder. Avoids spawning
  // explorer.exe from the forked Node server, which mishandles UTF-8
  // paths and detached output.
  shell: {
    showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
    openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  },
});
