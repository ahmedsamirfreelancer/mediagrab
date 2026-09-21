/**
 * Preload for the main MediaGrab window (the one that loads http://127.0.0.1:3456).
 * Exposes the Electron side — opening platform popups, the per-platform
 * logins, updates and shell helpers — to the web UI as window.electronAPI.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // The popups: one door for every platform. `open` shows the real site in
  // its own window with the download toolbar injected; `onDownload` fires
  // whenever something in one of those windows is queued.
  embed: {
    open: (platform, opts) => ipcRenderer.invoke('embed:open', platform, opts),
    onDownload: (cb) => ipcRenderer.on('embed:download', (_e, data) => cb(data)),
    setBaseDir: (base) => ipcRenderer.invoke('embed:setBaseDir', base),
  },

  // Per-platform logins. The popup can log you in by itself, but these give
  // the UI the current state (and a way out).
  instagram: {
    status: () => ipcRenderer.invoke('instagram:status'),
    login: () => ipcRenderer.invoke('instagram:login'),
    logout: () => ipcRenderer.invoke('instagram:logout'),
  },
  facebook: {
    status: () => ipcRenderer.invoke('facebook:status'),
    login: () => ipcRenderer.invoke('facebook:login'),
    logout: () => ipcRenderer.invoke('facebook:logout'),
    // Ad Library (spy tool): opens facebook.com/ads/library with filters, and
    // forwards per-ad creative downloads back here.
    openAdLibrary: (opts) => ipcRenderer.invoke('facebook:openAdLibrary', opts),
    onAdLibDownload: (cb) => ipcRenderer.on('fb-adlib:download', (_e, data) => cb(data)),
  },
  // TikTok and Pinterest have no login screen of their own here: you log in
  // inside their popup, or the toolbar's «سجّل دخول من جديد» resets the
  // session for you. Nothing to expose.
  // Manual cookies.txt import — workaround for the Chrome 127+ DPAPI lock.
  cookies: {
    import: (platform) => ipcRenderer.invoke('cookies:import', platform),
  },
  // Reverse image search — paste a product screenshot, get its Google Lens
  // results page opened in the default browser to read the English name.
  image: {
    reverseSearch: (bytes, mime) => ipcRenderer.invoke('image:reverseSearch', bytes, mime),
  },
  app: {
    version: () => ipcRenderer.invoke('app:getVersion'),
    checkForUpdate: () => ipcRenderer.invoke('app:checkForUpdate'),
    updateState: () => ipcRenderer.invoke('app:updateState'),
    installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
    onUpdateStatus: (cb) => ipcRenderer.on('app-update:status', (_e, data) => cb(data)),
  },
  ytdlp: {
    check: () => ipcRenderer.invoke('ytdlp:check'),
    update: () => ipcRenderer.invoke('ytdlp:update'),
  },
  // Opening the downloaded file/folder. Avoids spawning explorer.exe from the
  // forked Node server, which mishandles UTF-8 paths and detached output.
  shell: {
    showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
    openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  },
});
