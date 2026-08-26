import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { FileEntry } from '@cockpit/shared'
import { safeResolve } from './config.js'
import { requireWorkspace } from './registry.js'
import { statusMap, trackedFiles } from './git.js'
import { recordTouch } from './journal.js'

/**
 * §13 rule 1 — the interface has no filesystem. Everything it can see about
 * files, it sees through here, which is also why remote execution is only an
 * address change.
 */

const HIDDEN = new Set(['node_modules', '.git', 'vendor', 'dist', '.next', '.turbo', '.DS_Store'])
const MAX_READ = 2 * 1024 * 1024

export async function list(workspaceId: string, rel: string): Promise<FileEntry[]> {
  const ws = requireWorkspace(workspaceId)
  const dir = safeResolve(ws.path, rel || '.')
  const status = ws.repo ? await statusMap(ws.path) : new Map<string, string>()

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
    out.push({
      name: e.name,
      path: relPath,
      kind: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : 'file',
      size,
      mtimeMs,
      gitStatus: status.get(relPath) ?? null,
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
  recordTouch(workspaceId, rel, { kind: 'human' })
  return { ok: true, mtimeMs }
}

/** §12 — fuzzy file open runs over git-tracked files, not a crawl of disk. */
export async function tracked(workspaceId: string): Promise<string[]> {
  const ws = requireWorkspace(workspaceId)
  if (!ws.repo) return []
  return trackedFiles(ws.path)
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
