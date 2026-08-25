import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { GitState } from '@cockpit/shared'
import { run, serialize } from './exec.js'

/** §3.4 — we probe, we do not remember. Nothing here is cached to disk. */
export function git(cwd: string, args: string[], timeoutMs = 30_000) {
  return serialize('git:' + cwd, () => run('git', args, { cwd, timeoutMs }))
}

export function isRepo(path: string): boolean {
  const dotGit = join(path, '.git')
  if (!existsSync(dotGit)) return false
  // §10 — a worktree's .git is a FILE, not a directory. Both are valid repos.
  const st = statSync(dotGit)
  return st.isDirectory() || st.isFile()
}

export async function repoRoot(path: string): Promise<string | null> {
  const r = await git(path, ['rev-parse', '--show-toplevel'])
  return r.ok ? r.stdout.trim() : null
}

export async function isWorktree(path: string): Promise<boolean> {
  const dotGit = join(path, '.git')
  if (!existsSync(dotGit)) return false
  return statSync(dotGit).isFile()
}

/** Parses `git status --porcelain=v2 --branch`, the only format worth trusting. */
export async function probeGit(cwd: string): Promise<GitState | null> {
  if (!isRepo(cwd)) return null

  const [status, head, unpushed] = await Promise.all([
    git(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
    git(cwd, ['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%at']),
    git(cwd, ['log', '--branches', '--not', '--remotes', '--format=%H', '-1']),
  ])

  if (!status.ok) return null

  const state: GitState = {
    branch: null,
    headState: 'attached',
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    lastCommit: null,
    hasUnpushedWork: unpushed.ok && unpushed.stdout.trim().length > 0,
  }

  for (const line of status.stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const v = line.slice('# branch.head '.length).trim()
      state.branch = v === '(detached)' ? null : v
      if (v === '(detached)') state.headState = 'detached'
    } else if (line.startsWith('# branch.upstream ')) {
      state.upstream = line.slice('# branch.upstream '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        state.ahead = Number(m[1])
        state.behind = Number(m[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4)
      if (xy[0] !== '.') state.staged++
      if (xy[1] !== '.') state.unstaged++
    } else if (line.startsWith('u ')) {
      state.conflicted++
    } else if (line.startsWith('? ')) {
      state.untracked++
    }
  }

  if (head.ok && head.stdout.trim()) {
    const [hash, subject, author, at] = head.stdout.trim().split('\u001f')
    state.lastCommit = {
      hash: hash ?? '',
      subject: subject ?? '',
      author: author ?? '',
      ts: Number(at ?? 0) * 1000,
    }
  }

  // In-progress operations, so the UI never offers a rebase mid-rebase.
  const gitDir = (await git(cwd, ['rev-parse', '--git-dir'])).stdout.trim()
  const abs = gitDir.startsWith('/') ? gitDir : join(cwd, gitDir)
  if (existsSync(join(abs, 'rebase-merge')) || existsSync(join(abs, 'rebase-apply'))) {
    state.headState = 'rebasing'
  } else if (existsSync(join(abs, 'MERGE_HEAD'))) {
    state.headState = 'merging'
  } else if (existsSync(join(abs, 'BISECT_LOG'))) {
    state.headState = 'bisecting'
  }

  return state
}

export interface WorktreeEntry {
  path: string
  head: string
  branch: string | null
  bare: boolean
  detached: boolean
}

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const r = await git(cwd, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return []
  const out: WorktreeEntry[] = []
  let cur: Partial<WorktreeEntry> = {}
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur.path) out.push(finishWorktree(cur))
      cur = { path: line.slice(9).trim() }
    } else if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim()
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace('refs/heads/', '')
    else if (line === 'bare') cur.bare = true
    else if (line === 'detached') cur.detached = true
  }
  if (cur.path) out.push(finishWorktree(cur))
  return out
}

function finishWorktree(c: Partial<WorktreeEntry>): WorktreeEntry {
  return {
    path: c.path!,
    head: c.head ?? '',
    branch: c.branch ?? null,
    bare: c.bare ?? false,
    detached: c.detached ?? false,
  }
}

export async function defaultBranch(cwd: string): Promise<string> {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (r.ok && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '')
  for (const cand of ['main', 'master', 'develop']) {
    const v = await git(cwd, ['rev-parse', '--verify', '--quiet', cand])
    if (v.ok && v.stdout.trim()) return cand
  }
  return 'main'
}

export async function trackedFiles(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard'])
  if (!r.ok) return []
  return r.stdout.split('\n').filter(Boolean)
}

export async function statusMap(cwd: string): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  const r = await git(cwd, ['status', '--porcelain', '--untracked-files=all'])
  if (!r.ok) return m
  for (const line of r.stdout.split('\n')) {
    if (line.length < 4) continue
    m.set(line.slice(3).trim(), line.slice(0, 2).trim())
  }
  return m
}

export async function log(cwd: string, limit = 40) {
  const r = await git(cwd, [
    'log',
    '-n',
    String(limit),
    '--format=%H%x1f%s%x1f%an%x1f%at%x1f%D',
  ])
  if (!r.ok) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, author, at, refs] = l.split('\u001f')
      return {
        hash: hash ?? '',
        subject: subject ?? '',
        author: author ?? '',
        ts: Number(at ?? 0) * 1000,
        refs: refs ?? '',
      }
    })
}
