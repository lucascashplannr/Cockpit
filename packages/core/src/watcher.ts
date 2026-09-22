import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join, relative } from 'node:path'
import { allWorkspaces, refreshGit } from './registry.js'
import { recordTouch } from './journal.js'
import { sessionsTouching } from './agents.js'

/**
 * §14 — "chokidar, avec exclusions agressives." A watcher that follows
 * node_modules will eat the machine, and on a multi-repo group it will do it
 * three times over.
 *
 * It is no longer chokidar. chokidar 4 dropped fsevents, so on macOS it walks
 * the tree and calls `fs.watch` on every entry it finds — and every one of
 * those costs a kqueue file descriptor. Five repositories and their worktrees
 * came to ~15 000 watched paths against a 10 240 soft limit, and the core ran
 * out of descriptors.
 *
 * The failure was invisible and total: with no descriptors left, libuv's
 * `posix_spawn` path cannot open the child's pipes and reports **EBADF**, not
 * EMFILE. So every `git` the core ran died with "spawn EBADF" and the window
 * showed stale state for everything at once.
 *
 * `fs.watch(root, { recursive: true })` is FSEvents on macOS and one handle
 * per workspace — a dozen descriptors for the whole machine. What that costs
 * is done here instead of by the library: the ignore list, the depth bound,
 * and the settling that `awaitWriteFinish` used to do.
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

/** Directories below the workspace root, as chokidar's `depth: 8` counted them. */
const MAX_DEPTH = 8

/**
 * What `awaitWriteFinish: { stabilityThreshold: 250 }` was for. A save fires
 * more than one event for one file, and every event used to INSERT a row into
 * `touches` (§12) — so the attribution table grew with the noise rather than
 * with the work. Leading-edge, unlike chokidar's trailing: the first write is
 * the one that dates the touch.
 */
const SETTLE_MS = 250

let watchers: FSWatcher[] = []
let timer: NodeJS.Timeout | null = null
const dirty = new Set<string>()
const recent = new Map<string, number>()

function settled(file: string, now: number): boolean {
  const last = recent.get(file)
  if (last !== undefined && now - last < SETTLE_MS) return false
  recent.set(file, now)
  // The map is the only thing here that grows without bound; anything older
  // than the window can never suppress again.
  if (recent.size > 4096) {
    for (const [k, t] of recent) if (now - t >= SETTLE_MS) recent.delete(k)
  }
  return true
}

/**
 * Tested against the path *relative to its watched root*, never the absolute
 * one. `/(^|[/\\])\../` against an absolute path means a single dotted segment
 * anywhere above the workspace — a checkout under `~/.local/src`, say — turns
 * every event in it into a non-event, silently.
 */
function ignored(rel: string): boolean {
  const probe = '/' + rel
  return IGNORED.some((re) => re.test(probe))
}

export function start(onChange: (workspaceIds: string[]) => void): void {
  stop()

  // A recursive watch already covers everything under it, so a workspace
  // inside another watched one would report every change twice. `owner()`
  // still attributes to the deepest workspace, so dropping the nested root
  // costs nothing.
  const roots = allWorkspaces()
    .filter((w) => w.kind !== 'group')
    .map((w) => w.path)
    .sort((a, b) => a.length - b.length)
    .filter((p, _i, all) => !all.some((other) => other.length < p.length && p.startsWith(other + '/')))
  if (!roots.length) return

  /** Coalesces a burst into one refresh, whatever raised it. */
  const schedule = (workspaceId: string) => {
    dirty.add(workspaceId)
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      const ids = [...dirty]
      dirty.clear()
      for (const id of ids) await refreshGit(id)
      onChange(ids)
    }, 400)
  }

  const onEvent = (file: string) => {
    const ws = owner(file)
    if (!ws) return

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
    schedule(ws.id)
  }

  for (const root of roots) {
    try {
      // `rename` covers add, unlink and the rename itself; `change` covers a
      // write. All three were one handler under chokidar and still are — what
      // the watcher does with them is "this workspace moved", not "this file
      // was created".
      const w = watch(root, { recursive: true, persistent: true }, (_type, name) => {
        // Null on a platform that cannot name the file, and on an overflow
        // where FSEvents gives up on the detail. Neither is nothing happening:
        // refresh the workspace, and skip the per-file attribution — there is
        // no path to attribute.
        if (!name) {
          const ws = allWorkspaces().find((w) => w.path === root)
          if (ws) schedule(ws.id)
          return
        }
        const rel = String(name)
        if (ignored(rel)) return
        if (rel.split('/').length - 1 > MAX_DEPTH) return
        const file = join(root, rel)
        if (!settled(file, Date.now())) return
        onEvent(file)
      })
      // A worktree removed under us ends its own watch; that is the plan
      // doing its job, not a fault to report.
      w.on('error', () => w.close())
      watchers.push(w)
    } catch {
      // A path that has gone since `allWorkspaces` read it. The next
      // reconcile restarts the watcher with whatever is actually there.
    }
  }
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
  for (const w of watchers) {
    try {
      w.close()
    } catch {
      /* already gone with its directory */
    }
  }
  watchers = []
  dirty.clear()
  recent.clear()
}
