import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { relative } from 'node:path'
import { allWorkspaces, refreshGit } from './registry.js'
import { recordTouch } from './journal.js'
import { sessionsTouching } from './agents.js'

/**
 * §14 — "chokidar, avec exclusions agressives." A watcher that follows
 * node_modules will eat the machine, and on a multi-repo group it will do it
 * three times over.
 */

const IGNORED = [
  /(^|[/\\])\../,
  /node_modules/,
  /vendor\//,
  /\/dist\//,
  /\/build\//,
  /\/target\//,
  /\.log$/,
  /\/storage\/(logs|framework)\//,
]

let watcher: FSWatcher | null = null
let timer: NodeJS.Timeout | null = null
const dirty = new Set<string>()

export function start(onChange: (workspaceIds: string[]) => void): void {
  stop()

  const paths = allWorkspaces()
    .filter((w) => w.kind !== 'group')
    .map((w) => w.path)
  if (!paths.length) return

  watcher = chokidar.watch(paths, {
    ignored: IGNORED,
    ignoreInitial: true,
    persistent: true,
    depth: 8,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 60 },
  })

  const onEvent = (file: string) => {
    const ws = owner(file)
    if (!ws) return
    dirty.add(ws.id)

    // §12 — if an agent holds this subtree, the edit is attributed to it.
    // Otherwise it is a human edit. This is what fills the diff's author split.
    const rel = relative(ws.path, file)
    const agent = sessionsTouching(file)[0]
    recordTouch(
      ws.id,
      rel,
      agent ? { kind: 'agent', engine: agent.engine, sessionId: agent.id } : { kind: 'human' },
      agent?.id,
    )

    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      const ids = [...dirty]
      dirty.clear()
      for (const id of ids) await refreshGit(id)
      onChange(ids)
    }, 400)
  }

  watcher.on('add', onEvent)
  watcher.on('change', onEvent)
  watcher.on('unlink', onEvent)
}

/**
 * The workspace a changed file belongs to: the *deepest* one containing it,
 * never merely the first that matches.
 *
 * Workspaces nest. A project's group workspace sits at the project root, and
 * every repository and every worktree lives under it — so a plain `find` on
 * "does the path start with this one" answered `Ledger` for a file in
 * `Ledger/worktrees/2fa/api`. The group has no repository, so `refreshGit`
 * did nothing and the worktree's state only ever caught up on the 60-second
 * reconcile. The same mistake attributed the edit to the wrong workspace,
 * which is what fills the diff's human/agent split (§12).
 */
function owner(file: string) {
  let best: ReturnType<typeof allWorkspaces>[number] | null = null
  for (const w of allWorkspaces()) {
    if (!file.startsWith(w.path + '/')) continue
    if (!best || w.path.length > best.path.length) best = w
  }
  return best
}

export function stop(): void {
  if (timer) clearTimeout(timer)
  timer = null
  void watcher?.close()
  watcher = null
  dirty.clear()
}
