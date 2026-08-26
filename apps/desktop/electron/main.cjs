const { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } = require('electron')
const { spawn } = require('node:child_process')
const { join, resolve } = require('node:path')
const { existsSync } = require('node:fs')
const { createConnection } = require('node:net')

/**
 * §13 — "Le noyau tourne en permanence, indépendamment de l'interface."
 * Electron's main process is NOT the core. It only makes sure a core exists
 * and opens a window pointed at it; closing the window kills neither the dev
 * servers nor the agents.
 *
 * CommonJS on purpose: Electron's ESM entry path is still fragile, and this
 * file is pure plumbing with nothing to gain from modules.
 */

const DEV = !app.isPackaged
const CORE_PORT = Number(process.env.COCKPIT_PORT || 7717)

function probeCore(port) {
  return new Promise((res) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    const done = (v) => {
      sock.destroy()
      res(v)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    setTimeout(() => done(false), 800)
  })
}

async function ensureCore() {
  if (await probeCore(CORE_PORT)) {
    console.log('[cockpit] core already running on ' + CORE_PORT)
    return
  }
  const entry = resolve(__dirname, '..', '..', '..', 'packages', 'core', 'src', 'index.ts')
  if (!existsSync(entry)) {
    console.error('[cockpit] core entry not found at ' + entry)
    return
  }
  // Detached: the core outlives this window, and this app on quit.
  const child = spawn('npx', ['tsx', entry], {
    detached: true,
    stdio: 'ignore',
    env: Object.assign({}, process.env, { COCKPIT_PORT: String(CORE_PORT) }),
  })
  child.unref()
  for (let i = 0; i < 40; i++) {
    if (await probeCore(CORE_PORT)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  console.error('[cockpit] core did not come up in time')
}

/**
 * The one thing the renderer genuinely cannot do for itself. §13 rule 1 keeps
 * the bridge tiny, but `window.prompt` does not exist in Electron at all, so
 * "add a project" needs a real dialog or it is a button that throws.
 */
ipcMain.handle('dialog:pickFolder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const res = await dialog.showOpenDialog(win, {
    title: 'Add a project',
    message: 'Pick the folder Cockpit should watch',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Add',
  })
  return res.canceled ? null : (res.filePaths[0] ?? null)
})

/**
 * §13 — `ensureCore` only ran at launch, so a core stopped mid-session stayed
 * stopped until the app was quit and reopened. That is the one thing the
 * renderer cannot do for itself: it has no child processes (rule 1).
 */
ipcMain.handle('core:restart', async () => {
  // The core is asked to stop over its own socket before this point; wait for
  // the port to clear so `ensureCore` does not adopt the dying one.
  for (let i = 0; i < 40; i++) {
    if (!(await probeCore(CORE_PORT))) break
    await new Promise((r) => setTimeout(r, 250))
  }
  await ensureCore()
  return probeCore(CORE_PORT)
})

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // Raycast-style chrome: the traffic lights float over the rail.
    titleBarStyle: 'hiddenInset',
    // 10px in from the left of the 72px rail (--rail-w), 16px down so the
    // 12px buttons centre in the 44px title band (--titlebar-h).
    trafficLightPosition: { x: 10, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0b0d' : '#f7f7f8',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // §13 rule 1 — external links leave the app rather than navigating it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (DEV) {
    win.loadURL('http://127.0.0.1:5273')
  } else {
    win.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  }
  return win
}

app.whenReady().then(async () => {
  await ensureCore()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
