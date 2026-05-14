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
});
