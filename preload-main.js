/**
 * Preload for the main MediaGrab window (the one that loads http://127.0.0.1:3456).
 * Exposes Electron-side functionality (Instagram login, license info) to the
 * web UI through window.electronAPI.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Instagram in-app login
  instagram: {
    status: () => ipcRenderer.invoke('instagram:status'),
    login: () => ipcRenderer.invoke('instagram:login'),
    logout: () => ipcRenderer.invoke('instagram:logout'),
  },
  // Facebook in-app login (same pattern as Instagram)
  facebook: {
    status: () => ipcRenderer.invoke('facebook:status'),
    login: () => ipcRenderer.invoke('facebook:login'),
    logout: () => ipcRenderer.invoke('facebook:logout'),
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
