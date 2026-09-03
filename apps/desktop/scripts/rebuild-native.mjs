import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * better-sqlite3 is compiled C++, and it binds to exactly one Node ABI. The
 * core runs under Electron's embedded Node (see `coreLauncher` in
 * electron/main.cjs), so that is the ABI it has to be built for — not the one
 * belonging to whichever Node happens to be on the developer's PATH. A fresh
 * clone installs the module for the latter, which fails at the first query with
 * a NODE_MODULE_VERSION mismatch that reads like a corrupt install.
 *
 * It also runs after `dist` and `pack`, and that is not belt-and-braces. Building
 * the macOS x64 target makes electron-builder rebuild the native modules for
 * Intel *in this repository's node_modules*, so a release built on an Apple
 * Silicon machine leaves the developer's own core unable to start — with an
 * error about ABI that says nothing about architecture.
 *
 * Rebuilding on every install would be minutes of waiting for a thing that is
 * usually already right, so this asks first: it loads the module under Electron
 * exactly as the core will, and only rebuilds when that fails. That probe covers
 * both causes, because a wrong architecture and a wrong ABI fail it the same way.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')
const ELECTRON = join(APP, 'node_modules', '.bin', 'electron')

if (!existsSync(ELECTRON)) {
  // Nothing to align with yet; `pnpm install` has not finished laying out the
  // app's own dependencies. Silent on purpose — this is not a failure.
  process.exit(0)
}

const probe = join(mkdtempSync(join(tmpdir(), 'cockpit-abi-')), 'probe.cjs')
// Opening a database rather than requiring the package: the JavaScript wrapper
// loads fine under any ABI, and it is the dlopen behind the first connection
// that actually refuses.
writeFileSync(probe, "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()\n")

const ok = spawnSync(ELECTRON, [probe], {
  cwd: APP,
  stdio: 'ignore',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
}).status === 0

if (ok) process.exit(0)

console.log('[cockpit] native modules are built for the wrong runtime — rebuilding for Electron')
const rebuilt = spawnSync(
  join(APP, 'node_modules', '.bin', 'electron-rebuild'),
  ['-m', '.', '-o', 'better-sqlite3', '--force'],
  { cwd: APP, stdio: 'inherit' },
)

if (rebuilt.status !== 0) {
  console.error(
    '[cockpit] the rebuild failed. The core will not start until better-sqlite3 matches\n' +
      "[cockpit] Electron's ABI: run `pnpm --filter @cockpit/desktop rebuild:native`.",
  )
  process.exit(1)
}
