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
    const ws = allWorkspaces().find((w) => file.startsWith(w.path + '/'))
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

export function stop(): void {
  if (timer) clearTimeout(timer)
  timer = null
  void watcher?.close()
  watcher = null
  dirty.clear()
}
