import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DiffFile, DiffHunkLine, FileDiff } from '@cockpit/shared'
import { git } from './git.js'
import { attributionFor } from './journal.js'
import { changedBy } from './agents.js'
import { requireWorkspace } from './registry.js'

/**
 * §12 — "La distinction humain / agent est le garde-fou principal : elle rend
 * visible, donc contrôlable, la part de code jamais relue."
 * Attribution comes from the journal, not from guessing at the diff.
 */

function diffArgs(base?: string): string[] {
  // No base: everything not yet committed, staged included.
  return base ? ['diff', base + '...HEAD'] : ['diff', 'HEAD']
}

export async function files(workspaceId: string, base?: string): Promise<DiffFile[]> {
  const ws = requireWorkspace(workspaceId)
  if (!ws.repo) return []

  // `-z` throughout. Without it git quotes any path outside ASCII
  // (`"\303\251.txt"`) and writes a rename's numstat as `old => new`, so the
  // keys never met: a renamed file was counted as new from top to bottom.
  const [numstat, status] = await Promise.all([
    git(ws.path, [...diffArgs(base), '--numstat', '-z']),
    git(ws.path, [...diffArgs(base), '--name-status', '-z']),
  ])

  const statusByPath = new Map<string, { status: DiffFile['status']; oldPath: string | null }>()
  for (const s of parseNameStatus(status.stdout)) statusByPath.set(s.path, { status: s.status, oldPath: s.oldPath })

  // Untracked files never appear in `git diff`, but they are unmistakably
  // part of the work in progress and must be reviewable.
  if (!base) {
    const untracked = await git(ws.path, ['ls-files', '--others', '--exclude-standard', '-z'])
    for (const p of untracked.stdout.split('\0').filter(Boolean)) {
      if (!statusByPath.has(p)) statusByPath.set(p, { status: 'A', oldPath: null })
    }
  }

  const counts = parseNumstat(numstat.stdout)

  // Untracked files carry no numstat entry, but showing them as +0/-0 makes
  // brand-new work look empty in the review. Count their lines directly.
  for (const p of statusByPath.keys()) {
    if (!counts.has(p)) counts.set(p, countNewFile(join(ws.path, p)))
  }

  const paths = [...statusByPath.keys()]
  const attribution = attributionFor(workspaceId, paths)
  // §7 — who among the conversations, since the last commit: what was
  // committed before is not this change, whoever made it.
  let by = new Map<string, { id: string; title: string }[]>()
  if (!base) {
    const head = await git(ws.path, ['log', '-1', '--format=%ct', 'HEAD'])
    by = changedBy(workspaceId, paths, (Number(head.stdout.trim()) || 0) * 1000)
  }

  return paths
    .map((p) => {
      const s = statusByPath.get(p)!
      const c = counts.get(p) ?? { add: 0, del: 0, binary: false }
      return {
        path: p,
        oldPath: s.oldPath,
        status: s.status,
        additions: c.add,
        deletions: c.del,
        attribution: (attribution.get(p) ?? 'unknown') as DiffFile['attribution'],
        binary: c.binary,
        ...(by.get(p) || (s.oldPath && by.get(s.oldPath)) ? { by: by.get(p) ?? by.get(s.oldPath!) } : {}),
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

export async function file(workspaceId: string, path: string, base?: string): Promise<FileDiff> {
  const ws = requireWorkspace(workspaceId)
  if (!ws.repo) return { path, binary: false, lines: [] }

  let text = ''
  const tracked = await git(ws.path, ['ls-files', '--error-unmatch', '--', path])
  if (tracked.ok) {
    // A renamed file is diffed against the name it had, or it reads as new.
    const names = await git(ws.path, [...diffArgs(base), '--name-status', '-z'])
    const from = parseNameStatus(names.stdout).find((s) => s.path === path)?.oldPath
    const r = await git(ws.path, [...diffArgs(base), '--unified=3', '--', ...(from ? [from] : []), path])
    text = r.stdout
  } else {
    // Untracked: show it as an all-addition diff against nothing.
    const r = await git(ws.path, ['diff', '--no-index', '--unified=3', '--', '/dev/null', path])
    text = r.stdout
  }

  if (!text.trim()) return { path, binary: false, lines: [] }
  if (/^Binary files /m.test(text)) return { path, binary: true, lines: [] }

  return { path, binary: false, lines: parseUnified(text) }
}

/** `git diff --name-status -z`: a code, then one path — two for a rename or copy. */
export function parseNameStatus(out: string): { path: string; oldPath: string | null; status: DiffFile['status'] }[] {
  const parts = out.split('\0')
  const list: { path: string; oldPath: string | null; status: DiffFile['status'] }[] = []
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++] ?? ''
    if (!code) continue
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = parts[i++] ?? ''
      const path = parts[i++] ?? ''
      if (path) list.push(code[0] === 'R' ? { path, oldPath, status: 'R' } : { path, oldPath: null, status: 'A' })
    } else {
      const path = parts[i++] ?? ''
      if (path) list.push({ path, oldPath: null, status: code[0] as DiffFile['status'] })
    }
  }
  return list
}

/**
 * `git diff --numstat -z`: `add<TAB>del<TAB>path` — or, for a rename,
 * `add<TAB>del<TAB>` followed by the old and the new path. Keyed by the new one.
 */
export function parseNumstat(out: string): Map<string, { add: number; del: number; binary: boolean }> {
  const counts = new Map<string, { add: number; del: number; binary: boolean }>()
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; ) {
    const head = parts[i++] ?? ''
    if (!head) continue
    const [a, d, inline] = head.split('\t')
    let path = inline ?? ''
    if (!path) {
      i++ // the old path
      path = parts[i++] ?? ''
    }
    if (!path) continue
    const binary = a === '-' || d === '-'
    counts.set(path, { add: binary ? 0 : Number(a), del: binary ? 0 : Number(d), binary })
  }
  return counts
}

export function parseUnified(text: string): DiffHunkLine[] {
  const out: DiffHunkLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const raw of text.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(raw)
      if (m) {
        oldLine = Number(m[1])
        newLine = Number(m[2])
        inHunk = true
        out.push({ kind: 'meta', oldLine: null, newLine: null, text: (m[3] ?? '').trim() || raw })
      }
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', oldLine: null, newLine: newLine++, text: raw.slice(1) })
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', oldLine: oldLine++, newLine: null, text: raw.slice(1) })
    } else if (raw.startsWith('\\') || raw === '') {
      // A context line is at least its leading space; an empty string is the
      // split after the diff's final newline, not a blank line of the file.
      continue
    } else {
      out.push({ kind: 'context', oldLine: oldLine++, newLine: newLine++, text: raw.slice(1) })
    }
  }
  return out
}

const COUNT_LIMIT = 2 * 1024 * 1024

function countNewFile(full: string): { add: number; del: number; binary: boolean } {
  try {
    if (statSync(full).size > COUNT_LIMIT) return { add: 0, del: 0, binary: false }
    const buf = readFileSync(full)
    for (let i = 0; i < Math.min(buf.length, 4096); i++) {
      if (buf[i] === 0) return { add: 0, del: 0, binary: true }
    }
    const text = buf.toString('utf8')
    if (!text.length) return { add: 0, del: 0, binary: false }
    const lines = text.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    return { add: lines.length, del: 0, binary: false }
  } catch {
    return { add: 0, del: 0, binary: false }
  }
}
