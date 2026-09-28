import { matchesBranch } from '@cockpit/shared'
import type { PermissionMode, Workspace } from '@cockpit/shared'
import { git } from './git.js'
import { protectedBranches } from './registry.js'

/**
 * §16 — a protected branch, and what Cockpit will and will not do to one.
 *
 * Protection is per repository (`ProjectSettings.protectedBranches`), and it
 * means three things, all refused here rather than in the window so that the
 * palette, the bar and a plan built from anywhere all hit the same wall:
 *
 * - **No commit on it.** The commit is refused in `commit.ts`.
 * - **No push of a commit made on it directly.** What Send to lands on the
 *   branch is a `--no-ff` merge, and those go: Send is the door the branch is
 *   protected *for*, and refusing to push its result would leave every Send
 *   stranded on this machine. A commit made on the branch itself — in a
 *   terminal, or before it was protected — is what the protection exists to
 *   keep off origin, and a push carrying one is refused whole.
 *
 * - **No writing on it.** A file saved from the window and an agent run
 *   outside Plan mode are both refused (`writeRefusal`): work meant for a
 *   protected branch is done on another one and Sent. Plan mode only reads,
 *   so it is the one way an agent may still be asked about the code there.
 *
 * Agents never commit or push at all (§16, `DEFAULT_DENY`), protected or not.
 */

export function isProtected(w: Workspace, branch: string | null): boolean {
  return matchesBranch(branch, protectedBranches(w))
}

/**
 * Why a push of `branch` from `w` is refused, or null when it may go.
 *
 * "Made directly" is read off the first-parent line: every commit on it that
 * is not a merge was committed on the branch itself, since a Send only ever
 * adds merges there. A branch origin does not have yet is let through — that
 * is publishing it, not pushing onto it, and a new repository has to be able
 * to put its first `main` somewhere.
 *
 * Fails closed: a protection that waves a push through because git could not
 * be asked is not one.
 */
export async function pushRefusal(w: Workspace, branch: string): Promise<string | null> {
  if (!isProtected(w, branch)) return null
  const remote = await git(w.path, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + branch])
  if (!remote.ok) return null
  const direct = await git(w.path, [
    'rev-list', '--first-parent', '--no-merges', 'refs/remotes/origin/' + branch + '..refs/heads/' + branch,
  ])
  if (!direct.ok) {
    return branch + ' is protected in ' + w.repoName + ', and git could not say what the push would carry.'
  }
  const n = direct.stdout.split('\n').filter(Boolean).length
  if (!n) return null
  return (
    branch + ' is protected in ' + w.repoName + ': ' +
    (n === 1 ? '1 commit on it was' : n + ' commits on it were') +
    ' made directly rather than through Send to ' + branch + '. ' +
    'Unprotect it from the branch menu to push ' + (n === 1 ? 'it' : 'them') + '.'
  )
}

/**
 * Why writing into these checkouts is refused, or null when none of them is
 * on a protected branch.
 *
 * Read off the cached branch rather than a fresh probe: the watcher moves it
 * on every HEAD change, and a save is not the moment to spend a git call.
 */
export function writeRefusal(ws: Workspace[], doing: 'save' | 'agent'): string | null {
  const hits = ws.filter((w) => w.repo && isProtected(w, w.git?.branch ?? null))
  if (!hits.length) return null
  const where = hits.map((w) => w.git!.branch + ' in ' + w.repoName).join(', ')
  return (
    where + (hits.length === 1 ? ' is' : ' are') + ' protected — ' +
    (doing === 'save'
      ? 'Cockpit does not write files there.'
      : 'an agent may only read there, in Plan mode.')
  )
}

/** An agent in Plan mode reads and never writes, so protection lets it through. */
export function agentRefusal(ws: Workspace[], mode: PermissionMode | null): string | null {
  return mode === 'plan' ? null : writeRefusal(ws, 'agent')
}
