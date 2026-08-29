import { basename, dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { newId } from '@cockpit/shared'
import type { ApplyResult, PlanPreview, PlanStep } from '@cockpit/shared'
import { getDb } from './db.js'
import { defaultBranch, git, probeOperation } from './git.js'
import * as restore from './restore.js'
import { run } from './exec.js'
import { append } from './journal.js'
import { getWorkspace, requireWorkspace } from './registry.js'
import { readManifest, findManifest } from './detect.js'

/**
 * §3.7 — "Toute opération affiche son plan avant de s'exécuter et laisse une
 * trace annulable." The plan is built, shown, and only then applied; the
 * restore point is captured by apply(), never by the caller.
 *
 * §17 — this is palier 4 territory, where reliability is expensive:
 * "Un outil Git en qui on n'a pas confiance est pire que pas d'outil."
 */

interface StoredPlan extends PlanPreview {
  /** Every workspace the plan touches; the first is the one `undo` targets. */
  workspaceIds: string[]
  cwd: string
  createdAt: number
  /** Which workspace each step runs in, so a halt can name the one that stopped. */
  stepOwner: (string | null)[]
  /** §16 — secrets for the steps that need them. Never sent, never journaled. */
  env?: Record<string, string>
  /**
   * Run once every step succeeded. This is what keeps a feature from being
   * recorded before its worktrees actually exist on disk (§3.4: never remember
   * what can be probed, and never remember something that is not there).
   */
  onApplied?: (res: { output: string }) => void | Promise<void>
}

const plans = new Map<string, StoredPlan>()
const PLAN_TTL = 10 * 60_000

function gc(): void {
  const now = Date.now()
  for (const [id, p] of plans) if (now - p.createdAt > PLAN_TTL) plans.delete(id)
}

export interface RegisterOptions {
  workspaceIds: string[]
  onApplied?: StoredPlan['onApplied']
  /**
   * §16 — "Aucun environnement de process journalisé." Passed to every step and
   * never serialized: this is how a database password reaches `mysql` without
   * appearing in the previewed command, in the journal, or on anyone's `ps`.
   */
  env?: Record<string, string>
}

/**
 * Which workspace a step belongs to, matched by the cwd it runs in. A halted
 * plan has to name the repository that stopped, and `cwd` is the only thing a
 * step carries that identifies one.
 */
function ownersFor(steps: PlanStep[], workspaceIds: string[]): (string | null)[] {
  const byPath = new Map<string, string>()
  for (const id of workspaceIds) {
    const ws = getWorkspace(id)
    if (ws) byPath.set(ws.path, id)
  }
  return steps.map((s) => byPath.get(s.cwd) ?? null)
}

/**
 * Stores a preview built elsewhere — a feature spans several repositories, so
 * its plan cannot be produced by a function keyed on a single workspace.
 */
export function register(preview: PlanPreview, opts: RegisterOptions): PlanPreview {
  gc()
  plans.set(preview.planId, {
    ...preview,
    workspaceIds: opts.workspaceIds,
    cwd: preview.steps[0]?.cwd ?? process.cwd(),
    createdAt: Date.now(),
    stepOwner: ownersFor(preview.steps, opts.workspaceIds),
    env: opts.env,
    onApplied: opts.onApplied,
  })
  append({
    type: 'git.plan',
    workspaceId: opts.workspaceIds[0] ?? null,
    payload: { operation: preview.operation, steps: preview.steps, warnings: preview.warnings },
  })
  return preview
}

export type Operation = 'rebase' | 'merge' | 'branch' | 'worktree' | 'push' | 'sync'

export async function plan(
  workspaceId: string,
  operation: Operation,
  args: Record<string, string> = {},
): Promise<PlanPreview> {
  gc()
  const ws = requireWorkspace(workspaceId)
  if (!ws.repo) throw new Error('workspace has no repository')

  const steps: PlanStep[] = []
  const warnings: string[] = []
  const base = args.base ?? (await defaultBranch(ws.path))
  const branch = ws.git?.branch ?? '(detached)'

  if (ws.git?.headState === 'rebasing' || ws.git?.headState === 'merging') {
    warnings.push('This repository is in the middle of a ' + ws.git.headState + '. Finish or abort it first.')
  }

  // Rebasing or merging a branch onto itself is a no-op the user did not mean;
  // say so rather than printing a plan that does nothing.
  if ((operation === 'rebase' || operation === 'merge') && branch === base) {
    warnings.push('Already on "' + base + '" — there is nothing to ' + operation + ' onto.')
  }

  switch (operation) {
    case 'rebase': {
      steps.push({ title: 'Fetch ' + base, command: 'git fetch origin ' + base, cwd: ws.path, destructive: false })
      steps.push(...rebaseStep(ws.path, branch, base))
      if ((ws.git?.unstaged ?? 0) + (ws.git?.staged ?? 0) > 0) {
        warnings.push('Uncommitted changes are set aside by --autostash and put back when the rebase ends — including when it is aborted. Git owns that stash, so a conflict cannot strand it.')
      }
      if ((ws.git?.ahead ?? 0) > 0 && ws.git?.upstream) {
        warnings.push('This branch is ' + ws.git.ahead + ' commit(s) ahead of ' + ws.git.upstream + '; a rebase rewrites them and a force-push will be required.')
      }
      break
    }

    case 'merge': {
      steps.push({ title: 'Fetch ' + base, command: 'git fetch origin ' + base, cwd: ws.path, destructive: false })
      steps.push({ title: 'Merge ' + base + ' into ' + branch, command: 'git merge --no-ff origin/' + base, cwd: ws.path, destructive: true })
      break
    }

    case 'branch': {
      const name = args.name
      if (!name) throw new Error('branch requires a name')
      steps.push({ title: 'Create branch ' + name, command: 'git switch -c ' + name, cwd: ws.path, destructive: false })
      break
    }

    /** §4 — "monter de niveau après coup" : C1 → C2 without losing work. */
    case 'worktree': {
      const name = args.name
      if (!name) throw new Error('worktree requires a branch name')
      const root = worktreeRoot(ws.path, { override: args.root })
      const target = join(root, name)
      if (existsSync(target)) warnings.push('Target folder already exists: ' + target)
      steps.push({ title: 'Fetch origin', command: 'git fetch origin', cwd: ws.path, destructive: false })
      steps.push({
        title: 'Create worktree ' + name,
        command: 'git worktree add -b ' + name + ' ' + target + ' origin/' + base,
        cwd: ws.path,
        destructive: false,
      })
      warnings.push('A worktree costs disk space; the cockpit will list it under the same project.')
      break
    }

    case 'push': {
      if (!ws.git?.branch) {
        warnings.push('Detached HEAD: nothing to push.')
        break
      }
      const force = ws.git.behind > 0 && ws.git.ahead > 0
      steps.push({
        title: force ? 'Force-push (with lease) ' + branch : 'Push ' + branch,
        command: force
          ? 'git push --force-with-lease origin ' + branch
          : 'git push -u origin ' + branch,
        cwd: ws.path,
        destructive: force,
      })
      if (force) warnings.push('History diverged; this rewrites the remote branch. --force-with-lease is used so a concurrent push aborts it.')
      break
    }

    case 'sync': {
      steps.push({ title: 'Fetch all', command: 'git fetch --all --prune', cwd: ws.path, destructive: false })
      steps.push({ title: 'Fast-forward if possible', command: 'git merge --ff-only', cwd: ws.path, destructive: false })
      break
    }
  }

  const preview: PlanPreview = {
    planId: newId('plan_'),
    operation,
    steps,
    warnings,
    capturesRestorePoint: steps.some((s) => s.destructive),
    repos: [ws.name],
    // A rebase or merge that stops has stopped on a conflict, and the conflict
    // is the point: rolling it back would undo the work the user is about to
    // resolve. Everything else is still all-or-nothing.
    onFailure: operation === 'rebase' || operation === 'merge' ? 'halt' : 'rollback',
  }
  plans.set(preview.planId, {
    ...preview,
    workspaceIds: [workspaceId],
    cwd: ws.path,
    createdAt: Date.now(),
    stepOwner: steps.map(() => workspaceId),
  })
  append({ type: 'git.plan', workspaceId, payload: { operation, steps, warnings } })
  return preview
}

/**
 * The one rebase step, shared by the single-repo plan and the feature-wide one
 * so both get `--autostash`.
 *
 * `--autostash` rather than a stash push before and a pop after: those were two
 * separate steps, and a conflict in between meant the pop never ran. The work
 * was then sitting in a stash nothing in the app mentioned. Handing the stash
 * to git makes it git's problem — it pops it when the rebase finishes, when it
 * is aborted, and never leaves it behind.
 */
export function rebaseStep(cwd: string, branch: string, base: string): PlanStep[] {
  return [
    {
      title: 'Rebase ' + branch + ' onto ' + base,
      command: 'git rebase --autostash origin/' + base,
      cwd,
      destructive: true,
    },
  ]
}

export interface WorktreeRootOptions {
  override?: string
  /**
   * §21.4, now decided: when a feature slug is given the layout is GROUPED —
   * `worktrees/<feature>/<repo>` — because one folder per feature is the only
   * place a cross-repo CONTEXT.md and a shared memory can live (§7). Without a
   * slug the old per-repo layout stands, which is right for a C2 one-off.
   */
  featureSlug?: string
}

export function worktreeRoot(repoPath: string, opts: WorktreeRootOptions = {}): string {
  if (opts.override) return resolve(repoPath, opts.override)

  const manifestPath = findManifest(repoPath) ?? findManifest(dirname(repoPath))
  const manifest = manifestPath ? readManifest(manifestPath).manifest : null
  const base = manifest?.worktrees?.root
    ? resolve(dirname(manifestPath!), manifest.worktrees.root)
    : resolve(dirname(repoPath), 'worktrees')

  if (opts.featureSlug) return join(base, opts.featureSlug)
  if (manifest?.worktrees?.strategy === 'flat') return base
  return join(base, basename(repoPath))
}

/** Where a given repo's worktree lands inside a feature (§21.4, grouped). */
export function featureWorktreePath(repoPath: string, featureSlug: string, override?: string): string {
  return join(worktreeRoot(repoPath, { featureSlug, override }), basename(repoPath))
}

/** The feature's own folder — parent of every repo worktree it owns. */
export function featureRootPath(repoPath: string, featureSlug: string, override?: string): string {
  return worktreeRoot(repoPath, { featureSlug, override })
}

export async function apply(planId: string): Promise<ApplyResult> {
  gc()
  const stored = plans.get(planId)
  if (!stored) return { ok: false, output: 'plan expired or unknown; build a new one', restorePoint: null }
  plans.delete(planId)

  let restorePoint: string | null = null
  if (stored.capturesRestorePoint) {
    // One per repository the plan touches: a multi-repo plan that rewrites two
    // histories needs two anchors, not one.
    for (const wsId of stored.workspaceIds) {
      const ws = requireWorkspace(wsId)
      if (!ws.repo) continue
      const rp = await restore.capture(wsId, ws.path, stored.operation)
      restorePoint ??= rp?.head ?? null
    }
  }

  const lines: string[] = []
  /** Steps that already ran, newest last — the rollback order is their reverse. */
  const done: PlanStep[] = []

  for (let i = 0; i < stored.steps.length; i++) {
    const step = stored.steps[i]!
    const r = await exec(step, stored.env)
    lines.push('$ ' + step.command)
    if (r.stdout.trim()) lines.push(r.stdout.trim())
    if (r.stderr.trim()) lines.push(r.stderr.trim())

    if (!r.ok) {
      const remaining = stored.steps.length - i - 1

      // The one failure that is not one. Git exits non-zero on a conflict
      // exactly as it does on a real error, so the exit code cannot tell them
      // apart — the repository can: an operation is now in progress there.
      const operation = await probeOperation(step.cwd)
      if (operation) {
        const workspaceId = stored.stepOwner[i] ?? stored.workspaceIds[0] ?? null
        const repo = workspaceId ? (getWorkspace(workspaceId)?.name ?? basename(step.cwd)) : basename(step.cwd)
        append({
          type: 'git.conflict',
          level: 'warn',
          workspaceId,
          payload: { operation: stored.operation, kind: operation.kind, repo, paths: operation.conflictedPaths },
        })
        lines.push('')
        lines.push(
          '[cockpit] ' + repo + ': ' + operation.conflictedPaths.length +
            ' conflicted file(s). Resolve them and continue — nothing was rolled back.' +
            // Only a rebase has an autostash to reassure anyone about; saying it
            // during a merge is noise that describes a mechanism not in play.
            (operation.kind === 'rebase'
              ? ' Your uncommitted work is held by git\'s autostash until the rebase ends.'
              : ''),
        )
        if (remaining) lines.push('[cockpit] ' + remaining + ' step(s) not run; re-run the plan once this is resolved.')
        return {
          ok: false,
          output: lines.join('\n'),
          restorePoint,
          conflict: { workspaceId: workspaceId ?? '', repo, kind: operation.kind },
          remaining,
        }
      }

      append({
        type: 'git.failed',
        level: 'error',
        workspaceId: stored.stepOwner[i] ?? stored.workspaceIds[0] ?? null,
        payload: { operation: stored.operation, step: step.title, code: r.code, output: r.stderr.slice(-2000) },
      })
      lines.push('')
      lines.push('[cockpit] stopped at "' + step.title + '" (exit ' + r.code + ').')

      // §3.7 — a plan spanning several repositories is all-or-nothing. Leaving
      // two of three worktrees behind is worse than not starting: the feature
      // would look opened and be unusable. A plan that says `halt` has opted
      // out: what already succeeded there is worth keeping.
      if ((stored.onFailure ?? 'rollback') === 'rollback') {
        const rolled = await rollback(done, lines, stored.env)
        if (rolled) lines.push('[cockpit] rolled back ' + rolled + ' step(s); nothing was left behind.')
      } else if (remaining) {
        lines.push('[cockpit] ' + remaining + ' step(s) not run; what succeeded before this was kept.')
      }
      if (restorePoint) lines.push('[cockpit] restore point ' + restorePoint.slice(0, 8) + ' is available via undo.')
      return { ok: false, output: lines.join('\n'), restorePoint, remaining }
    }
    done.push(step)
  }

  append({
    type: 'git.applied',
    workspaceId: stored.workspaceIds[0] ?? null,
    payload: { operation: stored.operation, steps: stored.steps.length, restorePoint },
  })

  const output = lines.join('\n')
  // Only now is the intent real enough to record (§3.4).
  if (stored.onApplied) await stored.onApplied({ output })
  return { ok: true, output, restorePoint }
}

/**
 * Runs one step. Git goes through the per-repository queue (§16), so two git
 * commands in one repo never overlap; anything else runs directly.
 *
 * A step that names a non-git binary without declaring `run` is refused rather
 * than executed: that is what keeps "a plan can only run git" true by default,
 * so a command string assembled from a manifest cannot become an exec.
 */
async function exec(
  step: { command: string; cwd: string; run?: string },
  env?: Record<string, string>,
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  const parts = tokenize(step.command)
  const bin = parts[0] ?? 'git'
  const args = parts.slice(1)

  if (bin === 'git' && !step.run) return git(step.cwd, args, 180_000)

  if (!step.run || step.run !== bin) {
    return {
      ok: false,
      code: 126,
      stdout: '',
      stderr:
        'refusing to run "' + bin + '": a step that is not git must declare run: "' + bin + '"',
    }
  }
  return run(bin, args, { cwd: step.cwd, timeoutMs: 600_000, env })
}

/** Undoes completed steps in reverse. Best effort: a failed undo is reported,
 *  never thrown, because the caller is already handling a failure. */
async function rollback(
  done: PlanStep[],
  lines: string[],
  env?: Record<string, string>,
): Promise<number> {
  let n = 0
  for (const step of [...done].reverse()) {
    for (const u of step.undo ?? []) {
      // Its own binary when it names one — the undo of `createdb` is `dropdb`
      // — and its step's otherwise, which keeps every git undo unchanged.
      const r = await exec({ ...u, run: u.run ?? step.run }, env)
      lines.push('$ ' + u.command + (r.ok ? '' : '   # failed: ' + r.stderr.trim().slice(-200)))
      if (r.ok) n++
    }
  }
  return n
}

/**
 * Splits a previewed command into argv, honouring quotes.
 *
 * Written out longhand because the regex it replaces only stripped quotes at
 * the very ends of a token, so a quoted argument that was not the last one
 * kept a stray quote: `--a="one two" --b=three` yielded `--a="one two`. The
 * last argument happened to survive, which is why every command here worked
 * while they all ended in their quoted part — a trap for the next one that
 * does not. Nothing could hit it while every step was git with no spaces in
 * any argument; cloning a database is the first step that needs one.
 */
function tokenize(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  /** A token can be legitimately empty — `--flag=""` — but only if quoted. */
  let quoted = false

  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      quoted = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (cur || quoted) out.push(cur)
      cur = ''
      quoted = false
      continue
    }
    cur += ch
  }
  if (cur || quoted) out.push(cur)
  return out
}

/** §16 — "Bouton d'annulation alimenté par le reflog." */
export async function undo(workspaceId: string): Promise<{ ok: boolean; detail: string }> {
  const ws = requireWorkspace(workspaceId)
  if (!ws.repo) return { ok: false, detail: 'workspace has no repository' }

  const row = getDb()
    .prepare('SELECT * FROM restore_points WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(workspaceId) as { id: string; head: string; reason: string; created_at: number } | undefined
  if (!row) return { ok: false, detail: 'no restore point recorded for this workspace' }

  const dirty = (ws.git?.staged ?? 0) + (ws.git?.unstaged ?? 0) > 0
  if (dirty) {
    return {
      ok: false,
      detail: 'working tree has uncommitted changes; commit or stash them before undoing (refusing to discard work)',
    }
  }

  const r = await git(ws.path, ['reset', '--hard', row.head], 60_000)
  if (!r.ok) return { ok: false, detail: r.stderr.slice(-500) }

  getDb().prepare('DELETE FROM restore_points WHERE id = ?').run(row.id)
  append({ type: 'git.undone', workspaceId, payload: { head: row.head, reason: row.reason } })
  return { ok: true, detail: 'restored to ' + row.head.slice(0, 8) + ' (' + row.reason + ')' }
}

export function hasRestorePoint(workspaceId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM restore_points WHERE workspace_id = ? LIMIT 1')
    .get(workspaceId)
  return !!row
}
