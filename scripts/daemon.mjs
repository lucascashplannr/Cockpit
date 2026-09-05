import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The core, standalone, on the runtime it actually ships on.
 *
 * `tsx watch` under the shell's own Node was the obvious way to run this and it
 * no longer works: the core loads better-sqlite3, which is built for the Node
 * that Electron embeds rather than the one on PATH (see
 * apps/desktop/scripts/rebuild-native.mjs). Borrowing the desktop app's Electron
 * binary and telling it to behave as Node keeps this script and the app running
 * the same core the same way.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const electron = join(ROOT, 'apps', 'desktop', 'node_modules', '.bin', 'electron')
// `tsx/cli`, not the file behind it: tsx 4.23 stopped exporting `./dist/*`,
// so resolving the path made this script die on its first line with an
// ERR_PACKAGE_PATH_NOT_EXPORTED that says nothing about the daemon.
const tsx = require.resolve('tsx/cli')
const entry = join(ROOT, 'packages', 'core', 'src', 'index.ts')

const child = spawn(electron, [tsx, 'watch', entry], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})

child.on('exit', (code) => process.exit(code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
