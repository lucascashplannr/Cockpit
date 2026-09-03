import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * §13 — the core is a service, not a library of the window. A packaged app has
 * no repository to run it from and no `npx`, so the source tree the dev core is
 * spawned from (`packages/core/src/index.ts`) has to become one file that ships
 * inside the bundle.
 *
 * ESM on purpose, and this is not a preference: `terminals.ts` reaches for
 * `createRequire(import.meta.url)` to load node-pty, and `import.meta` does not
 * survive a CommonJS bundle. Emitting ESM keeps that line meaning what it says
 * and keeps the core's source free of packaging concessions.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')
const ENTRY = resolve(APP, '..', '..', 'packages', 'core', 'src', 'index.ts')
const OUT = resolve(APP, 'resources', 'core.mjs')

/**
 * The two modules that cannot be bundled: they are compiled C++, not JavaScript.
 * They stay `require`-able names in the output and are shipped unpacked beside
 * it (electron-builder's `asarUnpack`) — a .node file inside an asar archive is
 * not a file the loader can dlopen.
 */
const NATIVE = ['better-sqlite3', 'node-pty']

rmSync(OUT, { force: true })
mkdirSync(dirname(OUT), { recursive: true })

const result = await build({
  entryPoints: [ENTRY],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Electron 33 embeds Node 20. Targeting it rather than the host's Node keeps
  // the bundle honest about the runtime it will actually be run under.
  target: 'node20',
  external: NATIVE,
  /**
   * An ESM bundle has no `require`, and esbuild's stand-in for it throws on
   * every call. That is fatal here for a reason that has nothing to do with our
   * code: dependencies that are still CommonJS (`yaml`) reach for `require` at
   * load time, and `terminals.ts` reaches for it on purpose to load node-pty.
   * Handing the bundle a real one built from its own URL satisfies both, and
   * esbuild's shim defers to it rather than throwing.
   */
  banner: {
    js: [
      "import { createRequire as __cockpitCreateRequire } from 'node:module'",
      'const require = __cockpitCreateRequire(import.meta.url)',
    ].join('\n'),
  },
  sourcemap: true,
  // Not minified deliberately: this file is the thing a crash report will point
  // at, and it is shipped once per release rather than fetched over a network.
  minify: false,
  logLevel: 'info',
  metafile: true,
})

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0
console.log(`[bundle-core] ${OUT} — ${(bytes / 1024).toFixed(0)} KB, externals: ${NATIVE.join(', ')}`)
