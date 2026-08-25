import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * node-pty ships `spawn-helper` inside its prebuilds. Package extraction does
 * not always preserve the executable bit, and when it is lost every pty spawn
 * fails with a bare "posix_spawnp failed." — which points nowhere near the
 * real cause. Restoring it here keeps the Terminal tab (§2) working on a
 * fresh clone.
 */

function findPrebuilds(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node-pty') out.push(join(p, 'prebuilds'))
        else if (e.name === 'node_modules' || e.name === '.pnpm' || depth < 3) walk(p, depth + 1)
      }
    }
  }
  walk(join(root, 'node_modules'), 0)
  return out.filter((p) => existsSync(p))
}

let fixed = 0
for (const prebuilds of findPrebuilds(process.cwd())) {
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, 'spawn-helper')
    if (!existsSync(helper)) continue
    const mode = statSync(helper).mode
    if (mode & 0o111) continue
    chmodSync(helper, 0o755)
    fixed++
  }
}

if (fixed) console.log('[cockpit] restored the executable bit on ' + fixed + ' node-pty spawn-helper(s)')
