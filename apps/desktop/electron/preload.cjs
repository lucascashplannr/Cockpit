const { contextBridge, ipcRenderer } = require('electron')

/**
 * §13 rule 1 — deliberately tiny. The renderer talks to the core over the
 * WebSocket like any other client; this bridge exposes only window chrome.
 */
contextBridge.exposeInMainWorld('cockpitHost', {
  platform: process.platform,
  corePort: Number(process.env.COCKPIT_PORT || 7717),
  isElectron: true,
  /**
   * Resolves to an absolute path, or null when the user cancels. The wording is
   * the caller's: the same dialog picks a Dev folder, a project to register and
   * a place to move one to, and a panel that says "Add a project" every time
   * is a panel nobody reads.
   */
  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),
  /** Spawns a core if none is listening. Resolves true once one answers. */
  restartCore: () => ipcRenderer.invoke('core:restart'),
})
