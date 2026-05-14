const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenseAPI', {
  activate: (key) => ipcRenderer.invoke('license:activate', key),
  deactivate: () => ipcRenderer.invoke('license:deactivate'),
  getStatus: () => ipcRenderer.invoke('license:getStatus'),
  getFingerprint: () => ipcRenderer.invoke('license:getFingerprint'),
  quit: () => ipcRenderer.invoke('license:quit'),
  openExternal: (url) => ipcRenderer.invoke('license:openExternal', url),
});
