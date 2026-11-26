import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BranchRef, GitOperation, GitState } from '@cockpit/shared'
import { run, serialize } from './exec.js'
import type { RunResult } from './exec.js'
import { lockIn, lockState, removeLock } from './gitlock.js'
import { append } from './journal.js'

/** §3.4 — we probe, we do not remember. Nothing here is cached to disk. */
export function git(cwd: string, args: string[], timeoutMs = 30_000) {
  return gitWith(cwd, args, { timeoutMs })
}

/**
 * `git()` for the calls that need more than a timeout — a private index, input
 * on stdin. Same queue, same lock healing.
 */
export function gitWith(
  cwd: string,
  args: string[],
  opts: {
    timeoutMs?: number
    env?: Record<string, string>
    input?: string
    /**
     * Work nobody is waiting for (the periodic fetch). It queues like any
     * write, but an `urgent` call in the same folder calls it off.
     */
    background?: boolean
    /**
     * A step of a plan a person confirmed. Background work queued or running
     * in this folder is stopped first, so a Commit or a Push never waits for
     * a fetch over the network. Only background work: two writes still never
     * overlap, and the stopped git is waited for until it has gone.
     */
    urgent?: boolean
  } = {},
): Promise<RunResult> {
  if (opts.input === undefined && isReadOnly(args)) {
    // Off the queue: a reader cannot collide with anything, and queued it waited
    // behind every other git of the repository — a fetch over the network
    // included. One git start costs ~150 ms on Windows, so the Diff tab's dozen
    // reads in a row were seconds where side by side they are a fraction of one.
    // GIT_OPTIONAL_LOCKS=0 is what makes "a reader" true of `status` and `diff`
    // too: without it they may take index.lock to refresh the stat cache.
    return readSlot(() =>
      run('git', args, {
        cwd,
        timeoutMs: opts.timeoutMs ?? 30_000,
        env: { ...opts.env, GIT_OPTIONAL_LOCKS: '0' },
      }),
    )
  }
  const key = 'git:' + cwd
  if (opts.urgent) for (const c of backgroundIn.get(key) ?? []) c.abort()
  let ctl: AbortController | null = null
  if (opts.background) {
    ctl = new AbortController()
    const set = backgroundIn.get(key) ?? new Set()
    set.add(ctl)
    backgroundIn.set(key, set)
  }
  const once = () =>
    run('git', args, {
      cwd,
      timeoutMs: opts.timeoutMs ?? 30_000,
      env: opts.env,
      input: opts.input,
      signal: ctl?.signal,
      waitOnAbort: true,
    })
  const queued = serialize(key, async () => {
    // Called off before its turn came: nothing was started, nothing to undo.
    if (ctl?.signal.aborted) return { code: 130, stdout: '', stderr: '[cockpit] cancelled', ok: false }
    const r = await once()
    if (ctl?.signal.aborted) return r
    if (r.ok) return r
    // A lock left by a git that died stops every write in the repository
    // until someone deletes it. When nobody is using it, that someone is us —
    // then the call is made again, once. See gitlock.ts.
    const lock = lockIn(r.stderr, cwd)
    if (!lock) return r
    const { state, ageMs } = await lockState(lock, cwd)
    if (state === 'held') return r
    if (state === 'stale') {
      if (!removeLock(lock)) return r
      try {
        append({
          type: 'git.lock_cleared',
          level: 'warn',
          payload: { lock, ageMs, command: 'git ' + args.join(' ') },
        })
      } catch {
        /* no journal (a CLI call): the retry is what matters */
      }
    }
    return once()
  })
  if (!ctl) return queued
  const mine = ctl
  return queued.finally(() => {
    const set = backgroundIn.get(key)
    set?.delete(mine)
    if (set && !set.size) backgroundIn.delete(key)
  })
}

/** Background git by queue key, so an urgent call can stop it (`gitWith`). */
const backgroundIn = new Map<string, Set<AbortController>>()

/**
 * §16 — the per-repository queue exists so two git commands never fight over a
 * lock. Only a command that may write takes one, so only those need the queue.
 *
 * An allow-list, by subcommand and — where one subcommand both reads and
 * writes — by its verb. Anything not on it is queued as before: a command
 * missing from here is only slower, never unsafe. A leading global option
 * (`--git-dir`, `-c`) is queued too rather than parsed.
 */
const READS = new Set([
  'diff', 'log', 'show', 'status', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'cat-file',
  'merge-base', 'for-each-ref', 'name-rev', 'blame', 'grep', 'describe', 'check-ignore',
  'check-ref-format', 'show-ref', 'diff-tree', 'diff-index', 'diff-files', 'count-objects',
])

export function isReadOnly(args: string[]): boolean {
  const [cmd, ...rest] = args
  if (!cmd || cmd.startsWith('-')) return false
  if (READS.has(cmd)) return true
  const verb = rest[0]
  switch (cmd) {
    case 'stash':
      return verb === 'list' || verb === 'show'
    case 'worktree':
      return verb === 'list'
    case 'reflog':
      return verb === 'show'
    case 'remote':
      return verb === undefined || verb === '-v' || verb === 'get-url'
    case 'branch':
      return verb === '--show-current' || verb === '--list'
    case 'symbolic-ref':
      // Reading names one ref; two is setting it, and -d deletes it.
      return !rest.includes('-d') && !rest.includes('--delete') && rest.filter((a) => !a.startsWith('-')).length === 1
    default:
      return false
  }
}

/**
 * Readers run side by side, but not without limit: a Diff over every
 * repository of a topic, a probe and the watcher landing together would
 * otherwise start dozens of processes at once on a machine where each start
 * is the expensive part.
 */
const READ_LIMIT = 8
let readsRunning = 0
const readsWaiting: (() => void)[] = []

async function readSlot<T>(fn: () => Promise<T>): Promise<T> {
  // A slot freed is handed straight to the next in line, never put back for
  // grabs: a caller arriving in between would otherwise make it nine.
  if (readsRunning >= READ_LIMIT) await new Promise<void>((go) => readsWaiting.push(go))
  else readsRunning++
  try {
    return await fn()
  } finally {
    const next = readsWaiting.shift()
    if (next) next()
    else readsRunning--
  }
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

  const [status, head, unpushed, remotes, base, abs] = await Promise.all([
    git(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
    git(cwd, ['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%at']),
    // `HEAD`, not `--branches`: the latter answers for the whole repository,
    // so one unpushed commit on any branch made every worktree of every topic
    // report unpushed work — and refused to close or delete topics holding
    // nothing at all. A checkout speaks for its own branch and no other.
    git(cwd, ['log', 'HEAD', '--not', '--remotes', '--format=%H', '-1']),
    git(cwd, ['remote']),
    // Reads a ref file in the common case, so it costs about nothing to probe
    // it every time rather than resolving it at the moment of the action.
    baseOverride ? Promise.resolve(baseOverride) : defaultBranch(cwd),
    // Asked now rather than at the end: the in-progress checks below only
    // need it, and one more round trip was one more git start in a row.
    gitDir(cwd),
  ])

  if (!status.ok) return null

  const state: GitState = {
    branch: null,
    headState: 'attached',
    upstream: null,
    base,
    ahead: 0,
    behind: 0,
    incoming: 0,
    aheadOfBase: null,
    behindBase: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    conflictedPaths: [],
    lastCommit: null,
    // Unreadable is not "none": hiding Push on a failed probe would be a guess.
    hasRemote: !remotes.ok || remotes.stdout.trim().length > 0,
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

  // Everything that needed only the branch name, asked side by side. Each
  // answer is read exactly as it was when these ran one after another; asking
  // one whose answer turns out not to be needed costs a git start, not a wait.
  const own = state.branch ? 'origin/' + state.branch : null
  const onRemote = !!(state.branch && state.hasRemote)
  const againstBase = !!(state.base && state.branch && state.branch !== state.base)
  const [ownRef, ownAb, neverPushed, baseAb] = await Promise.all([
    onRemote ? git(cwd, ['rev-parse', '--verify', '--quiet', 'refs/remotes/' + own], 10_000) : null,
    // Only read when the ref above exists; when it does not, this fails and
    // is ignored, as the call it replaces was never made.
    onRemote && state.upstream !== own ? git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...' + own], 15_000) : null,
    onRemote && state.hasUnpushedWork ? git(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], 15_000) : null,
    againstBase ? countBase(cwd, state.base!) : null,
  ])

  // The branch's own remote is what Push is measured against, whatever the
  // tracking config says. A topic branch tracks `origin/<base>` until a push
  // with `-u`, and one pushed from a terminal without it stays that way for
  // good: its counts kept answering for the base, so a branch that was behind
  // its own remote read as level and Push went dark.
  state.published = false
  if (onRemote && ownRef) {
    if (ownRef.ok && ownRef.stdout.trim()) {
      state.published = true
      if (state.upstream !== own && ownAb) {
        const m = /^(\d+)\s+(\d+)/.exec(ownAb.stdout.trim())
        if (ownAb.ok && m) {
          state.upstream = own
          state.ahead = Number(m[1])
          state.behind = Number(m[2])
        }
      }
    }
  }

  // Never pushed: `ahead` answered for whatever the branch happened to track —
  // nothing at all for a branch made without an upstream, so Push stood there
  // with no count. What its first push sends is every commit no remote has.
  if (onRemote && !state.published) {
    if (state.hasUnpushedWork) {
      if (neverPushed?.ok && /^\d+$/.test(neverPushed.stdout.trim())) state.ahead = Number(neverPushed.stdout.trim())
    } else if (unpushed.ok) {
      state.ahead = 0
    }
  }

  // Only against the branch's own remote: until the first push `behind` is the
  // base's distance, and Catch up already counts that.
  if (state.branch && state.behind > 0 && state.upstream === 'origin/' + state.branch) {
    state.incoming = await countIncoming(cwd, state.branch, state.upstream, state.behind)
  }

  // §4 — what Send would land, which is not what `ahead` counts. Skipped
  // when there is nothing to compare against, and when the branch *is* the
  // base: a base branch has nothing to send to itself.
  //
  // §4 — and what Catch up would replay this branch on top of, which is not
  // what `behind` counts either.
  //
  // Skipped when the branch *is* the base, and that is the whole rule: you
  // cannot catch up with yourself. Being behind `origin/main` while standing
  // on `main` is not a rebase with nothing to replay, it is a pull — a
  // different verb, already counted by `behind`. Answering both left the
  // window offering two buttons for one act, each with the same number on it.
  if (againstBase) {
    state.aheadOfBase = baseAb?.ahead ?? null
    state.behindBase = baseAb?.behind ?? null
  } else if (state.branch && state.branch === state.base) {
    state.aheadOfBase = 0
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
    if (state.operation) {
      // Mid-merge every file that merged cleanly sits staged for the commit
      // Continue makes; mid-rebase the same is true of the commit being
      // replayed. Said as what it is, so the window need not count it as work.
      state.operation.merged = state.staged
      state.operation.held =
        existsSync(join(abs, 'rebase-merge', 'autostash')) ||
        existsSync(join(abs, 'rebase-apply', 'autostash')) ||
        existsSync(join(abs, 'MERGE_AUTOSTASH'))
    }
    // Mid-rebase HEAD is detached, so `status` reported no branch. The rebase
    // state knows which branch is being replayed; without this the window says
    // "(detached)" for the whole conflict, which is true and useless.
    state.branch ??= state.operation?.branch ?? null
  }

  return state
}

/**
 * §3.4 — the one thing the probe could not learn by looking at the disk.
 *
 * Every "behind" in this app — `behind`, `behindBase`, and so the Catch up
 * count, the Pull entry and the ↓ on every row — is measured against a
 * remote-tracking ref, and those refs move only when something fetches. The
 * only fetches Cockpit had were *inside plans*: `git fetch origin <base>` as
 * the first step of a Catch up. So a commit pushed to origin was invisible
 * until you ran the very operation whose count was supposed to tell you to run
 * it, and Refresh — which re-probed everything faithfully — re-read the same
 * stale refs and reported no change. The window was not wrong; it was reading
 * a photograph of the remote taken the last time a plan ran.
 *
 * Throttled rather than free: `reconcile` runs on a 60s timer and after every
 * apply, and none of those are worth a network round trip per repository.
 * `force` is the Refresh button, which is a person asking on purpose.
 *
 * Failure is not an error. Offline, no `origin`, credentials not loaded — all
 * of them mean the counts stay as they were, which is what they would have
 * done anyway. The timestamp is written *before* the fetch so a hanging one
 * does not queue another behind it on the next tick.
 */
const FETCH_MIN_INTERVAL = 120_000
/** By repository (its common `.git`), not by folder: see `fetchRemote`. */
const lastFetch = new Map<string, number>()

/**
 * Keyed by repository, because every worktree of a repository shares its
 * remote-tracking refs: one fetch in any of its checkouts moves `origin/*` for
 * all of them. Keyed by folder, a repository with eight topics went to origin
 * eight times every two minutes, and the eight fetches fought over the same
 * refs.
 *
 * `background`: a Commit, a Push or any other confirmed step in the same
 * folder calls it off rather than waiting behind it (`gitWith`). A fetch that
 * was called off is not counted as done, so the next pass tries again.
 */
export async function fetchRemote(
  cwd: string,
  opts: { force?: boolean; background?: boolean } = {},
): Promise<boolean> {
  const repo = commonDirOf(cwd) ?? cwd
  const now = Date.now()
  if (!opts.force && now - (lastFetch.get(repo) ?? 0) < FETCH_MIN_INTERVAL) return false
  lastFetch.set(repo, now)
  const r = await gitWith(cwd, ['fetch', '--prune', 'origin'], { timeoutMs: 30_000, background: opts.background })
  if (r.code === 130 && lastFetch.get(repo) === now) lastFetch.delete(repo)
  return r.ok
}

/**
 * The repository's own `.git` folder, which every worktree of it shares, read
 * off the disk rather than asked of git: a main checkout's `.git` is that
 * folder; a worktree's is a file naming its private folder, whose `commondir`
 * points back to the shared one. Null when the layout is anything else.
 */
export function commonDirOf(cwd: string): string | null {
  const dotGit = join(cwd, '.git')
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return dotGit
    if (!st.isFile()) return null
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
    if (!m) return null
    const own = resolve(cwd, m[1]!.trim())
    const common = join(own, 'commondir')
    return existsSync(common) ? resolve(own, readFileSync(common, 'utf8').trim()) : own
  } catch {
    return null
  }
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
  const r = await git(cwd, ['name-rev', '--name-only', '--exclude=*/HEAD', '--refs=refs/remotes/*', sha], 10_000)
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
    // Mid-rebase HEAD is detached and `worktree list` names no branch, though
    // the branch is still that folder's: git refuses to check it out anywhere
    // else until the rebase ends. Read without it, the folder had no branch,
    // and the registry filed it under a topic of its own named after the folder.
    branch: c.branch ?? (c.detached && c.path ? rebasingBranch(c.path) : null),
    bare: c.bare ?? false,
    detached: c.detached ?? false,
  }
}

/** The branch a rebase stopped in this checkout is replaying, or null. */
function rebasingBranch(path: string): string | null {
  let dir = join(path, '.git')
  try {
    // A worktree's `.git` is a file pointing at its own git dir.
    if (statSync(dir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dir, 'utf8'))
      if (!m) return null
      dir = resolve(path, m[1]!.trim())
    }
  } catch {
    return null
  }
  for (const sub of ['rebase-merge', 'rebase-apply']) {
    const head = readTrimmed(join(dir, sub, 'head-name'))
    if (head?.startsWith('refs/heads/')) return head.slice('refs/heads/'.length)
  }
  return null
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

/**
 * One `git status` per folder at a time, shared. Opening a tree asks for every
 * folder that was left open at once, and each asked for the whole repository's
 * status: the same command, queued behind itself once per folder.
 */
const statusInFlight = new Map<string, Promise<Map<string, string>>>()

export function statusMap(cwd: string): Promise<Map<string, string>> {
  const running = statusInFlight.get(cwd)
  if (running) return running
  const p = readStatusMap(cwd).finally(() => statusInFlight.delete(cwd))
  statusInFlight.set(cwd, p)
  return p
}

async function readStatusMap(cwd: string): Promise<Map<string, string>> {
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


/** The other direction, and the same two refs tried in the same order. */
export async function countBehind(cwd: string, base: string): Promise<number | null> {
  return countRange(cwd, base, (ref) => 'HEAD..' + ref)
}

/**
 * Commits on `upstream` this branch has never pointed at — see
 * `GitState.incoming`.
 *
 * Capped, because the tips go on a command line: a reflog cut short forgets
 * the oldest of them, which can only overcount, and overcounting is the safe
 * direction — it offers a pull and refuses a force-push. So is the fallback
 * when the reflog cannot be read at all.
 */
const REFLOG_TIPS = 1000

async function countIncoming(
  cwd: string,
  branch: string,
  upstream: string,
  behind: number,
): Promise<number> {
  const log = await git(cwd, ['reflog', 'show', '--format=%H', '-n', String(REFLOG_TIPS), 'refs/heads/' + branch])
  if (!log.ok) return behind
  const seen = [...new Set(log.stdout.split('\n').filter(Boolean))]
  const r = await git(cwd, ['rev-list', '--count', upstream, '--not', 'HEAD', ...seen], 15_000)
  const n = r.ok ? Number(r.stdout.trim()) : NaN
  return Number.isFinite(n) ? n : behind
}

/**
 * `countAhead` and `countBehind` in one git call: `<ref>...HEAD` counted
 * left/right is "on the base, not here" then "here, not on the base". The same
 * two refs in the same order, and null for both when neither resolves.
 */
async function countBase(cwd: string, base: string): Promise<{ ahead: number; behind: number } | null> {
  for (const ref of ['origin/' + base, base]) {
    const r = await git(cwd, ['rev-list', '--left-right', '--count', ref + '...HEAD'], 15_000)
    const m = /^(\d+)\s+(\d+)/.exec(r.stdout.trim())
    if (r.ok && m) return { behind: Number(m[1]), ahead: Number(m[2]) }
  }
  return null
}

async function countRange(
  cwd: string,
  base: string,
  range: (ref: string) => string,
): Promise<number | null> {
  for (const ref of ['origin/' + base, base]) {
    const r = await git(cwd, ['rev-list', '--count', range(ref)], 15_000)
    if (r.ok) {
      const n = Number(r.stdout.trim())
      if (Number.isFinite(n)) return n
    }
  }
  // Neither ref resolved: a repository with no remote and no local base, or a
  // base that has never existed here. Unknown, and unknown is not zero.
  return null
}
