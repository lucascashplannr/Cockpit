import { readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { run } from './exec.js'

/**
 * A lock git left behind, and whether anyone is still using it.
 *
 * Git takes `.git/index.lock` (or `HEAD.lock`, `refs/heads/x.lock`, …) with
 * O_EXCL and removes it when it is done, on SIGTERM included. A git that is
 * SIGKILLed, crashes, or dies with the machine cannot, and from then on every
 * git that writes in that repository stops with "Unable to create
 * '…/index.lock': File exists" until someone deletes the file by hand. Nothing
 * tells them it is safe to, so they don't, and Pull, Commit, Switch… all fail
 * on a file from weeks ago.
 *
 * Cockpit's own git never overlaps itself in a repository (the per-repository
 * queue), so when one of its calls hits a lock, the holder is someone else: a
 * terminal, an agent's shell, an editor — or nobody. Nobody is what this finds
 * out, and only then is the lock removed.
 */

const LOCK = /Unable to create '([^']+\.lock)': File exists/

/** A lock younger than this may belong to a git that has only just started. */
const MIN_AGE_MS = 5_000

/**
 * Long-lived git processes that sit in a repository without ever taking its
 * locks. Counting them as "a git is working here" would keep a stale lock
 * forever in every repository that has `core.fsmonitor` on.
 */
const DAEMON = /fsmonitor|credential|daemon/

/** The lock git complained about, when it is one of git's own. */
export function lockIn(stderr: string, cwd: string): string | null {
  const m = LOCK.exec(stderr)
  if (!m) return null
  const path = isAbsolute(m[1]!) ? m[1]! : resolve(cwd, m[1]!)
  // Only files under a `.git` directory: the message is git's, but the path
  // is about to be unlinked, and nothing outside git's own folder qualifies.
  if (!path.split(sep).includes('.git')) return null
  return path
}

export type LockState =
  /** Gone by the time we looked: whoever held it finished. Just retry. */
  | 'gone'
  /** Old, unopened, and no git is working in the repository. Safe to remove. */
  | 'stale'
  /** In use, too recent, or we could not tell. Leave it. */
  | 'held'

export async function lockState(lock: string, cwd: string): Promise<{ state: LockState; ageMs: number }> {
  let mtime: number
  try {
    mtime = statSync(lock).mtimeMs
  } catch {
    return { state: 'gone', ageMs: 0 }
  }
  const ageMs = Date.now() - mtime
  if (ageMs < MIN_AGE_MS) return { state: 'held', ageMs }

  // No lsof to ask: only a lock old enough that no git could still be on it.
  if (process.platform === 'win32') return { state: ageMs > 10 * 60_000 ? 'stale' : 'held', ageMs }

  // Someone has the file open: the git that is writing it.
  const open = await run('lsof', ['-t', '--', lock], { timeoutMs: 5_000 })
  if (open.stdout.trim()) return { state: 'held', ageMs }
  // lsof answers 1 for "nothing found"; anything else is lsof not working,
  // and not knowing is not permission.
  if (open.code !== 0 && open.code !== 1) return { state: 'held', ageMs }

  // A git can hold a lock with the file closed (a commit running its hooks),
  // so also: is any git working in this repository at all?
  const procs = await run('lsof', ['-a', '+c', '0', '-c', 'git', '-d', 'cwd', '-Fcn'], { timeoutMs: 10_000 })
  if (procs.code !== 0 && procs.code !== 1) return { state: 'held', ageMs }
  const roots = repoRoots(lock, cwd)
  let command = ''
  for (const line of procs.stdout.split('\n')) {
    if (line.startsWith('c')) command = line.slice(1)
    else if (line.startsWith('n') && !DAEMON.test(command)) {
      const dir = line.slice(1)
      if (roots.some((r) => dir === r || dir.startsWith(r + sep))) return { state: 'held', ageMs }
    }
  }
  return { state: 'stale', ageMs }
}

/**
 * Every folder a git working on this lock could be sitting in: the folder the
 * call ran in, the checkout that owns the `.git`, and — for a linked
 * worktree's lock under `.git/worktrees/<name>/` — that worktree's folder.
 */
function repoRoots(lock: string, cwd: string): string[] {
  const roots = new Set<string>()
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  roots.add(real(cwd))
  const at = lock.indexOf(sep + '.git' + sep)
  if (at > 0) roots.add(real(lock.slice(0, at)))
  const wt = new RegExp('\\' + sep + '\\.git\\' + sep + 'worktrees\\' + sep + '[^\\' + sep + ']+').exec(lock)
  if (wt) {
    try {
      const gitdir = readFileSync(lock.slice(0, wt.index + wt[0].length) + sep + 'gitdir', 'utf8').trim()
      roots.add(real(dirname(gitdir)))
    } catch {
      /* no record of the worktree: the other roots stand */
    }
  }
  return [...roots]
}

export function removeLock(lock: string): boolean {
  try {
    unlinkSync(lock)
    return true
  } catch (err) {
    // Someone else removed it in between: as good as removed.
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}
