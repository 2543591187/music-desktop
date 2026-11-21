/* preload for the mini player window (2026-10-25) */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mini', {
  onState: (cb) => ipcRenderer.on('mini:state', (_e, s) => cb(s)),
  cmd: (c) => ipcRenderer.send('mini:cmd:from-mini', c),
});
