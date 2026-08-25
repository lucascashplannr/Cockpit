const { contextBridge, ipcRenderer } = require('electron')

/**
 * §13 rule 1 — deliberately tiny. The renderer talks to the core over the
 * WebSocket like any other client; this bridge exposes only window chrome.
 */
contextBridge.exposeInMainWorld('cockpitHost', {
  platform: process.platform,
  corePort: Number(process.env.COCKPIT_PORT || 7717),
  isElectron: true,
})
void ipcRenderer
