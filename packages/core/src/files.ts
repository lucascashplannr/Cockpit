import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { MANIFEST_FILENAMES } from '@cockpit/shared'
import type { FileEntry, Workspace } from '@cockpit/shared'
import { safeResolve } from './config.js'
import { allProjects, allWorkspaces, requireWorkspace, workspaceForPath } from './registry.js'
import { statusMap, trackedFiles } from './git.js'
import { recordTouch } from './journal.js'

/**
 * §13 rule 1 — the interface has no filesystem. Everything it can see about
 * files, it sees through here, which is also why remote execution is only an
 * address change.
 */

const HIDDEN = new Set(['node_modules', '.git', 'vendor', 'dist', '.next', '.turbo', '.DS_Store'])
const MAX_READ = 2 * 1024 * 1024

const MANIFESTS = new Set<string>(MANIFEST_FILENAMES)

/**
 * Cockpit's own files, never shown in a tree nor found by a search: `.cockpit/`
 * (memory, setup) wherever it is, the manifest at a project's root, and the
 * folder topics' worktrees are made in — a topic's repositories are reached as
 * the topic, not as folders of the project. Read once per listing or search:
 * `owned(rel)` then answers for paths under `wsPath`.
 */
export function cockpitOwned(wsPath: string): (rel: string) => boolean {
  const roots = new Set(allProjects().map((p) => p.root))
  const bases = new Set<string>()
  for (const p of allProjects()) bases.add(join(p.root, 'worktrees'))
  for (const w of allWorkspaces()) if (w.kind === 'group' && w.topicId) bases.add(dirname(w.path))
  // Only a base inside this workspace hides anything: from a topic's own
  // folder, every path is under the base, and all of them are the topic.
  const inside = [...bases].filter((b) => b.startsWith(wsPath + '/'))
  return (rel) => {
    const parts = rel.split('/')
    if (parts.includes('.cockpit')) return true
    const full = join(wsPath, rel)
    if (MANIFESTS.has(parts[parts.length - 1]!) && roots.has(dirname(full))) return true
    return inside.some((b) => full === b || full.startsWith(b + '/'))
  }
}

/**
 * The repository a path is in: the workspace itself when it is one; read from
 * a folder above several (a topic's, a group's, the project's root), the
 * deepest checkout holding it. Null for a path outside every repository.
 */
export function repoOf(ws: Workspace, full: string): Workspace | null {
  if (ws.repo) return ws
  const own = workspaceForPath(full)
  return own?.repo ? own : null
}

export async function list(workspaceId: string, rel: string): Promise<FileEntry[]> {
  const ws = requireWorkspace(workspaceId)
  const dir = safeResolve(ws.path, rel || '.')
  // From a folder, the marks of whichever repository this directory is in.
  const repo = repoOf(ws, dir)
  const status = repo ? await statusMap(repo.path) : new Map<string, string>()
  const owned = cockpitOwned(ws.path)

  const entries = readdirSync(dir, { withFileTypes: true })
  const out: FileEntry[] = []
  for (const e of entries) {
    if (HIDDEN.has(e.name)) continue
    const full = join(dir, e.name)
    let size = 0
    let mtimeMs = 0
    try {
      const st = statSync(full)
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      continue
    }
    const relPath = relative(ws.path, full)
    if (owned(relPath)) continue
    out.push({
      name: e.name,
      path: relPath,
      kind: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : 'file',
      size,
      mtimeMs,
      gitStatus: repo ? (status.get(relative(repo.path, full)) ?? null) : null,
    })
  }
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function read(workspaceId: string, rel: string) {
  const ws = requireWorkspace(workspaceId)
  const full = safeResolve(ws.path, rel)
  const st = statSync(full)
  const buf = readFileSync(full)
  if (looksBinary(buf)) {
    return { content: '', mtimeMs: st.mtimeMs, truncated: false, binary: true }
  }
  const truncated = buf.length > MAX_READ
  return {
    content: buf.subarray(0, MAX_READ).toString('utf8'),
    mtimeMs: st.mtimeMs,
    truncated,
    binary: false,
  }
}

/**
 * The raster formats a window can draw, by extension. SVG is not here: it is
 * text, read by `read` and drawn from the editor's own document.
 */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}
/** Over this the bytes stay on disk: a base64 frame this size stalls the socket. */
const MAX_IMAGE = 20 * 1024 * 1024

export function readImage(workspaceId: string, rel: string) {
  const ws = requireWorkspace(workspaceId)
  const full = safeResolve(ws.path, rel)
  const mediaType = IMAGE_TYPES[rel.split('.').pop()?.toLowerCase() ?? '']
  if (!mediaType) throw new Error('not an image: ' + rel)
  const st = statSync(full)
  const data = st.size > MAX_IMAGE ? null : readFileSync(full).toString('base64')
  return { data, mediaType, bytes: st.size, mtimeMs: st.mtimeMs }
}

/**
 * §16 — "Vérification de la date de modification avant toute écriture."
 * Without it a manual edit silently overwrites an agent's work, or the reverse.
 */
export function write(
  workspaceId: string,
  rel: string,
  content: string,
  expectMtimeMs: number | null,
) {
  const ws = requireWorkspace(workspaceId)
  const full = safeResolve(ws.path, rel)

  if (expectMtimeMs !== null) {
    let actual: number | null = null
    try {
      actual = statSync(full).mtimeMs
    } catch {
      actual = null
    }
    if (actual !== null && Math.abs(actual - expectMtimeMs) > 1) {
      return { ok: false, conflict: true, mtimeMs: actual }
    }
  }

  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
  const mtimeMs = statSync(full).mtimeMs
  // Attributed to the repository it is in, by its path there, not to a folder above it.
  const own = repoOf(ws, full)
  if (own) recordTouch(own.id, relative(own.path, full), { kind: 'human' })
  else recordTouch(workspaceId, rel, { kind: 'human' })
  return { ok: true, mtimeMs }
}

/** §12 — fuzzy file open runs over git-tracked files, not a crawl of disk. */
export async function tracked(workspaceId: string): Promise<string[]> {
  const ws = requireWorkspace(workspaceId)
  if (!ws.repo) return []
  const owned = cockpitOwned(ws.path)
  return (await trackedFiles(ws.path)).filter((f) => !owned(f))
}

/**
 * §16 — "Corbeille à durée de vie plutôt que suppression immédiate." The one
 * rule that holds everywhere in this app: user data leaves via the Trash, so
 * a wrong click is an undo rather than a loss.
 */
export async function moveToTrash(path: string): Promise<void> {
  const { existsSync } = await import('node:fs')
  const { run } = await import('./exec.js')
  if (!existsSync(path)) return
  const r =
    process.platform === 'darwin'
      ? await run('osascript', [
          '-e',
          'tell application "Finder" to delete POSIX file "' + path.replace(/"/g, '\\"') + '"',
        ])
      : await run('gio', ['trash', path])
  if (!r.ok) throw new Error('could not move to Trash: ' + (r.stderr || r.stdout).trim())
}
