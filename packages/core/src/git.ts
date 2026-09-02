import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BranchRef, GitOperation, GitState } from '@cockpit/shared'
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
/**
 * `base` is what "Catch up" pulls from and "Send to" lands on, so a project
 * that says its base is `develop` has to be answered here — the badge, the
 * button label and the plan all read this one field.
 */
export async function probeGit(cwd: string, baseOverride?: string | null): Promise<GitState | null> {
  if (!isRepo(cwd)) return null

  const [status, head, unpushed, base] = await Promise.all([
    git(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
    git(cwd, ['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%at']),
    git(cwd, ['log', '--branches', '--not', '--remotes', '--format=%H', '-1']),
    // Reads a ref file in the common case, so it costs about nothing to probe
    // it every time rather than resolving it at the moment of the action.
    baseOverride ? Promise.resolve(baseOverride) : defaultBranch(cwd),
  ])

  if (!status.ok) return null

  const state: GitState = {
    branch: null,
    headState: 'attached',
    upstream: null,
    base,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    conflictedPaths: [],
    lastCommit: null,
    hasUnpushedWork: unpushed.ok && unpushed.stdout.trim().length > 0,
    operation: null,
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
      // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — ten fields
      // before the path, and a path may contain spaces, so the rest is taken
      // whole rather than split.
      const path = line.split(' ').slice(10).join(' ')
      if (path) state.conflictedPaths.push(path)
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

  // In-progress operations, so the UI never offers a rebase mid-rebase — and,
  // when there is one, can offer the only three verbs that end it instead.
  const abs = await gitDir(cwd)
  if (existsSync(join(abs, 'rebase-merge')) || existsSync(join(abs, 'rebase-apply'))) {
    state.headState = 'rebasing'
  } else if (existsSync(join(abs, 'MERGE_HEAD'))) {
    state.headState = 'merging'
  } else if (existsSync(join(abs, 'CHERRY_PICK_HEAD'))) {
    state.headState = 'merging'
  } else if (existsSync(join(abs, 'BISECT_LOG'))) {
    state.headState = 'bisecting'
  }

  if (state.headState === 'rebasing' || state.headState === 'merging') {
    state.operation = await probeOperation(cwd, abs)
    // Mid-rebase HEAD is detached, so `status` reported no branch. The rebase
    // state knows which branch is being replayed; without this the window says
    // "(detached)" for the whole conflict, which is true and useless.
    state.branch ??= state.operation?.branch ?? null
  }

  return state
}

export async function gitDir(cwd: string): Promise<string> {
  const d = (await git(cwd, ['rev-parse', '--git-dir'])).stdout.trim()
  return d.startsWith('/') ? d : join(cwd, d)
}

function readTrimmed(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null
  } catch {
    return null
  }
}

/** The three markers, anchored: a line that merely mentions one does not count. */
const MARKER = /^(<{7}|={7}|>{7})(\s|$)/m

/**
 * §3.7 — what the user has to act on, split from what git merely reports.
 *
 * `conflictedPaths` is every unmerged path; `unresolvedPaths` is the subset
 * that still carries markers. Continue is gated on the second, which is what
 * lets a conflict resolved in an editor be continued from the window without
 * anyone having to remember to `git add`.
 */
export async function probeOperation(cwd: string, abs?: string): Promise<GitOperation | null> {
  const dir = abs ?? (await gitDir(cwd))

  const rebaseDir = existsSync(join(dir, 'rebase-merge'))
    ? join(dir, 'rebase-merge')
    : existsSync(join(dir, 'rebase-apply'))
      ? join(dir, 'rebase-apply')
      : null

  let kind: GitOperation['kind']
  let branch: string | null = null
  let onto: string | null = null
  let step: number | null = null
  let total: number | null = null

  if (rebaseDir) {
    kind = 'rebase'
    branch = readTrimmed(join(rebaseDir, 'head-name'))?.replace(/^refs\/heads\//, '') ?? null
    // `onto_name` is the ref as the user typed it, and far more useful than the
    // sha — but git only writes it for some backends. When it is missing, ask
    // git what that commit is called before falling back to eight hex digits:
    // "onto origin/main" is the sentence, "onto 2af4ab51" is a lookup.
    const ontoSha = readTrimmed(join(rebaseDir, 'onto'))
    onto = readTrimmed(join(rebaseDir, 'onto_name')) ?? (ontoSha ? await nameOf(cwd, ontoSha) : null)
    const num = readTrimmed(join(rebaseDir, 'msgnum')) ?? readTrimmed(join(rebaseDir, 'next'))
    const end = readTrimmed(join(rebaseDir, 'end')) ?? readTrimmed(join(rebaseDir, 'last'))
    step = num ? Number(num) : null
    total = end ? Number(end) : null
  } else if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) {
    kind = 'cherry-pick'
  } else if (existsSync(join(dir, 'REVERT_HEAD'))) {
    kind = 'revert'
  } else if (existsSync(join(dir, 'MERGE_HEAD'))) {
    kind = 'merge'
    onto = readTrimmed(join(dir, 'MERGE_HEAD'))?.slice(0, 8) ?? null
  } else {
    return null
  }

  const conflictedPaths = await unmergedPaths(cwd)
  const unresolvedPaths: string[] = []
  for (const rel of conflictedPaths) {
    try {
      if (MARKER.test(readFileSync(join(cwd, rel), 'utf8'))) unresolvedPaths.push(rel)
    } catch {
      // Unreadable or deleted-by-them: not a marker problem, so not listed here.
      // `git add`/`git rm` still has to happen and `continue` will say so.
    }
  }

  return { kind, branch, onto, step, total, conflictedPaths, unresolvedPaths }
}

/** What a commit is called, preferring a remote branch; the sha if nothing. */
async function nameOf(cwd: string, sha: string): Promise<string> {
  const r = await git(cwd, ['name-rev', '--name-only', '--refs=refs/remotes/*', sha], 10_000)
  const name = r.stdout.trim()
  // name-rev answers "undefined" rather than failing when nothing matches, and
  // it appends "~2" for a commit reached by walking back from a ref — neither
  // is a name worth showing.
  if (!r.ok || !name || name === 'undefined' || /[~^]/.test(name)) return sha.slice(0, 8)
  return name.replace(/^remotes\//, '')
}

/** Paths git itself calls unmerged — the only authority on what is blocking. */
export async function unmergedPaths(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])
  if (!r.ok) return []
  return r.stdout.split('\0').filter(Boolean)
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

/**
 * Every branch this repository could be put on, local and remote alike.
 *
 * One `for-each-ref` rather than `git branch -a` parsed by eye: the porcelain
 * of `branch` is for humans and changes, and the tracking counts are only
 * available here as a field.
 *
 * `checkedOutAt` is the one that matters in this app specifically. Cockpit
 * hands out worktrees (a topic is a branch per repository in its own folder),
 * and **git refuses to check out a branch that is already out somewhere else**.
 * A picker that offers it anyway is a picker whose entries fail on click, so it
 * says where the branch already is instead.
 */
export async function listBranches(cwd: string): Promise<BranchRef[]> {
  const F = [
    '%(refname)', '%(refname:short)', '%(upstream:short)', '%(upstream:track)',
    '%(committerdate:unix)', '%(contents:subject)',
  ].join('%1f')
  const r = await git(cwd, ['for-each-ref', '--format=' + F, 'refs/heads', 'refs/remotes'])
  if (!r.ok) return []

  // Which branch is out where. `%(HEAD)` only marks the ref this *worktree* has
  // out, and a bare-ish main checkout asking about a worktree's branch would
  // get no mark at all — so the answer comes from `worktree list`, which knows
  // about every checkout of this repository at once.
  const worktrees = await listWorktrees(cwd)
  const here = worktrees.find((w) => w.path === cwd)?.branch ?? null
  const elsewhere = new Map<string, string>()
  for (const w of worktrees) {
    if (w.branch && w.path !== cwd) elsewhere.set(w.branch, w.path)
  }

  const local: BranchRef[] = []
  const remote: BranchRef[] = []
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [full = '', name = '', upstream = '', track = '', at = '0', subject = ''] =
      line.split('\u001f')
    // `origin/HEAD` is a symbolic ref pointing at the default branch, not a
    // branch you can be on: checking it out lands you on a detached HEAD.
    if (!name || full.endsWith('/HEAD')) continue
    const ref: BranchRef = {
      name,
      current: name === here,
      remoteOnly: false,
      checkedOutAt: elsewhere.get(name) ?? null,
      upstream: upstream || null,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      ts: Number(at) * 1000,
      subject,
    }
    ;(full.startsWith('refs/heads/') ? local : remote).push(ref)
  }

  // A remote branch is only worth offering while there is no local one for it:
  // once `dev` exists here, `origin/dev` is the same branch said twice.
  const localNames = new Set(local.map((b) => b.name))
  const onlyRemote = remote
    .filter((b) => !localNames.has(b.name.replace(/^[^/]+\//, '')))
    .map((b) => ({ ...b, remoteOnly: true, checkedOutAt: null }))

  const byTime = (a: BranchRef, b: BranchRef) => b.ts - a.ts
  return [...local.sort(byTime), ...onlyRemote.sort(byTime)]
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
