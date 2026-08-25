import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// A terminal spawned from inside another Electron app (VS Code, Claude Code)
// inherits ELECTRON_RUN_AS_NODE=1, which silently makes `electron .` run as
// plain Node — `require('electron')` then returns a path string instead of the
// API, and the main process dies on the first property access.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const vite = spawn('npx', ['vite'], { cwd: root, stdio: 'inherit', env })

function wait(port, tries = 60) {
  return new Promise((res, rej) => {
    const attempt = (n) => {
      const s = createConnection({ host: '127.0.0.1', port })
      s.once('connect', () => {
        s.destroy()
        res()
      })
      s.once('error', () => {
        s.destroy()
        if (n <= 0) rej(new Error('vite never came up'))
        else setTimeout(() => attempt(n - 1), 300)
      })
    }
    attempt(tries)
  })
}

await wait(5273)
const electron = spawn('npx', ['electron', '.'], { cwd: root, stdio: 'inherit', env })

const bye = () => {
  vite.kill()
  electron.kill()
  process.exit(0)
}
electron.on('exit', bye)
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
