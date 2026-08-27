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

/**
 * Waits for Vite on either address family.
 *
 * The config now pins Vite to 127.0.0.1, but probing only that was how this
 * broke: `localhost` resolves to ::1 first on macOS, Vite bound [::1]:5273,
 * and this script sat dialling 127.0.0.1 for eighteen seconds and then
 * declared that Vite "never came up" — seconds after Vite had printed
 * "ready". Trying both costs one extra socket and removes the whole class.
 */
function wait(port, tries = 60) {
  const dial = (host) =>
    new Promise((res) => {
      const s = createConnection({ host, port })
      s.once('connect', () => {
        s.destroy()
        res(true)
      })
      s.once('error', () => {
        s.destroy()
        res(false)
      })
    })

  return new Promise((res, rej) => {
    const attempt = async (n) => {
      const [v4, v6] = await Promise.all([dial('127.0.0.1'), dial('::1')])
      if (v4 || v6) return res(v4 ? '127.0.0.1' : '::1')
      if (n <= 0) return rej(new Error('vite never came up on 127.0.0.1 or [::1]:' + port))
      setTimeout(() => attempt(n - 1), 300)
    }
    void attempt(tries)
  })
}

try {
  const on = await wait(5273)
  // If Vite ended up on IPv6 anyway, say so: main.cjs loads 127.0.0.1, so the
  // window would open on a blank page and the reason would be invisible.
  if (on !== '127.0.0.1') {
    process.stderr.write(
      '[cockpit] vite is on [' + on + ']:5273, but the window loads http://127.0.0.1:5273 — ' +
        'set server.host in vite.config.ts\n',
    )
  }
} catch (e) {
  // Without this the failed run leaves vite holding 5273, and the next
  // `pnpm dev` dies on strictPort instead — a different error for the same
  // cause, which is the worst way to debug anything.
  vite.kill()
  throw e
}
const electron = spawn('npx', ['electron', '.'], { cwd: root, stdio: 'inherit', env })

const bye = () => {
  vite.kill()
  electron.kill()
  process.exit(0)
}
electron.on('exit', bye)
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
