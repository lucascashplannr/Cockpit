import type { GitOperation } from '@cockpit/shared'
import { git, probeOperation, unmergedPaths } from './git.js'
import { append } from './journal.js'
import { requireWorkspace } from './registry.js'

/**
 * §3.7 — the half of "toute opération laisse une trace annulable" that was
 * missing: what to do once one has stopped.
 *
 * A conflicted rebase is not a failed command, it is a state the user works
 * in, and until this module existed the window detected that state, refused
 * every other git verb over it ("finish or abort it first") and offered no way
 * to do either. Three verbs end it, and they are the same three git has.
 *
 * §3.4 still holds: nothing here is remembered. The operation is re-probed
 * before and after every action, so a rebase the user advances by hand in the
 * terminal tab is indistinguishable from one advanced by the button.
 */

export type ResolveAction = 'continue' | 'abort' | 'skip'

export interface ResolveResult {
  ok: boolean
  detail: string
  /** The operation after the attempt. Null once it is over. */
  operation: GitOperation | null
  /** Why `continue` refused, when it did: paths still carrying markers. */
  unresolved: string[]
  /** Raw git output, for the journal and the plan-style read-out. */
  output: string
}

/** `--continue` wants an editor for the commit message; `true` keeps the old one. */
const NO_EDITOR = ['-c', 'core.editor=true', '-c', 'sequence.editor=true']

const VERB: Record<GitOperation['kind'], string> = {
  rebase: 'rebase',
  merge: 'merge',
  'cherry-pick': 'cherry-pick',
  revert: 'revert',
}

/** Merge is the one that cannot skip a step, because it has no steps. */
function supports(kind: GitOperation['kind'], action: ResolveAction): boolean {
  return !(action === 'skip' && kind === 'merge')
}

export async function state(workspaceId: string): Promise<GitOperation | null> {
  const ws = requireWorkspace(workspaceId)
  if (!ws.repo) return null
  return probeOperation(ws.path)
}

/** Resolves the workspace to the folder its git lives in, or refuses. */
function pathOf(workspaceId: string): string {
  const ws = requireWorkspace(workspaceId)
  if (!ws.repo) throw new Error('workspace has no repository')
  return ws.path
}

/**
 * Marks paths resolved. The escape hatch for the one case `continue` gets
 * wrong on purpose — a file whose *content* is meant to contain the markers.
 */
export async function stage(workspaceId: string, paths: string[]): Promise<ResolveResult> {
  return stageAt(pathOf(workspaceId), paths)
}

export async function stageAt(cwd: string, paths: string[]): Promise<ResolveResult> {
  if (!paths.length) return finish(cwd, true, 'nothing to stage', '')

  // -A rather than plain add: a conflict resolved by deleting the file has to
  // stage the deletion, and `git add <gone path>` fails.
  const r = await git(cwd, ['add', '-A', '--', ...paths], 60_000)
  return finish(cwd, r.ok, r.ok ? paths.length + ' path(s) marked resolved' : r.stderr.slice(-500), r.stdout + r.stderr)
}

export async function resolve(workspaceId: string, action: ResolveAction): Promise<ResolveResult> {
  return resolveAt(pathOf(workspaceId), action, workspaceId)
}

/**
 * Addressed by path so it is testable without a registry, and so the same code
 * serves a workspace and a bare checkout. `workspaceId` is only for the journal.
 */
export async function resolveAt(
  cwd: string,
  action: ResolveAction,
  workspaceId: string | null = null,
): Promise<ResolveResult> {
  const ws = { path: cwd }

  const before = await probeOperation(ws.path)
  if (!before) return finish(ws.path, false, 'nothing is in progress here', '')
  if (!supports(before.kind, action)) {
    return finish(ws.path, false, 'a ' + before.kind + ' has no step to skip — continue or abort it', '')
  }

  const verb = VERB[before.kind]

  if (action === 'abort') {
    const r = await git(ws.path, [verb, '--abort'], 120_000)
    append({
      type: 'git.conflict.aborted',
      level: r.ok ? 'info' : 'error',
      workspaceId,
      payload: { kind: before.kind, onto: before.onto },
    })
    // The autostash git took on the way in comes back here, by git's own hand.
    return finish(ws.path, r.ok, r.ok ? before.kind + ' aborted; the branch is back where it started' : r.stderr.slice(-500), r.stdout + r.stderr)
  }

  if (action === 'continue') {
    // Gate on markers, not on the index: someone who fixed the file in their
    // editor should not have to know that `git add` is still owed.
    if (before.unresolvedPaths.length) {
      return {
        ok: false,
        detail:
          before.unresolvedPaths.length +
          ' file(s) still carry conflict markers. Resolve them, or mark them resolved if the markers belong there.',
        operation: before,
        unresolved: before.unresolvedPaths,
        output: '',
      }
    }
    const pending = await unmergedPaths(ws.path)
    if (pending.length) {
      const add = await git(ws.path, ['add', '-A', '--', ...pending], 60_000)
      if (!add.ok) return finish(ws.path, false, add.stderr.slice(-500), add.stdout + add.stderr)
    }
  }

  const r = await git(ws.path, [...NO_EDITOR, verb, '--' + action], 300_000)
  const after = await probeOperation(ws.path)

  // Exit code alone cannot tell "the next commit conflicted too" from "this
  // went wrong": git returns 1 for both. Progress does — and landing on the
  // next conflict is the operation working, not failing.
  const advanced = !!after && !!before.step && !!after.step && after.step > before.step
  const done = after === null

  if (done || advanced) {
    append({
      type: 'git.conflict.resolved',
      workspaceId,
      payload: { kind: before.kind, action, finished: done, step: after?.step ?? before.total },
    })
    return {
      ok: true,
      detail: done
        ? before.kind + ' finished'
        : 'commit ' + after!.step + ' of ' + (after!.total ?? '?') + ' conflicts too',
      operation: after,
      unresolved: after?.unresolvedPaths ?? [],
      output: r.stdout + r.stderr,
    }
  }

  append({
    type: 'git.failed',
    level: 'error',
    workspaceId,
    payload: { operation: before.kind + ' --' + action, code: r.code, output: r.stderr.slice(-2000) },
  })
  return {
    ok: false,
    detail: r.stderr.trim().split('\n').slice(-3).join(' ').slice(-400) || 'git refused; see the journal',
    operation: after,
    unresolved: after?.unresolvedPaths ?? [],
    output: r.stdout + r.stderr,
  }
}

async function finish(cwd: string, ok: boolean, detail: string, output: string): Promise<ResolveResult> {
  const operation = await probeOperation(cwd)
  return { ok, detail, operation, unresolved: operation?.unresolvedPaths ?? [], output }
}
