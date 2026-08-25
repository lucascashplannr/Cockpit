import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DiffFile, DiffHunkLine, FileDiff } from '@cockpit/shared'
import { git } from './git.js'
import { attributionFor } from './journal.js'
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

  const [numstat, status] = await Promise.all([
    git(ws.path, [...diffArgs(base), '--numstat']),
    git(ws.path, [...diffArgs(base), '--name-status']),
  ])

  const statusByPath = new Map<string, { status: DiffFile['status']; oldPath: string | null }>()
  for (const line of status.stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const code = (parts[0] ?? '').trim()
    if (code.startsWith('R') && parts.length >= 3) {
      statusByPath.set(parts[2]!, { status: 'R', oldPath: parts[1]! })
    } else if (parts[1]) {
      statusByPath.set(parts[1], { status: (code[0] ?? 'M') as DiffFile['status'], oldPath: null })
    }
  }

  // Untracked files never appear in `git diff`, but they are unmistakably
  // part of the work in progress and must be reviewable.
  if (!base) {
    const untracked = await git(ws.path, ['ls-files', '--others', '--exclude-standard'])
    for (const p of untracked.stdout.split('\n').filter(Boolean)) {
      if (!statusByPath.has(p)) statusByPath.set(p, { status: 'A', oldPath: null })
    }
  }

  const counts = new Map<string, { add: number; del: number; binary: boolean }>()
  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue
    const [a, d, p] = line.split('\t')
    if (!p) continue
    const binary = a === '-' || d === '-'
    counts.set(p, { add: binary ? 0 : Number(a), del: binary ? 0 : Number(d), binary })
  }

  // Untracked files carry no numstat entry, but showing them as +0/-0 makes
  // brand-new work look empty in the review. Count their lines directly.
  for (const [p, s] of statusByPath) {
    if (counts.has(p)) continue
    counts.set(p, countNewFile(join(ws.path, p)))
    void s
  }

  const paths = [...statusByPath.keys()]
  const attribution = attributionFor(workspaceId, paths)

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
    const r = await git(ws.path, [...diffArgs(base), '--unified=3', '--', path])
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

function parseUnified(text: string): DiffHunkLine[] {
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
    } else if (raw.startsWith('\\')) {
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
