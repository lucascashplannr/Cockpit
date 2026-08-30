import { basename } from 'node:path'
import { newId } from '@cockpit/shared'
import type { CommitPreview, PlanPreview, PlanStep } from '@cockpit/shared'
import { git } from './git.js'
import * as plans from './plans.js'
import * as registry from './registry.js'

/**
 * §16 — "revue humaine du diff avant tout commit."
 *
 * The review was built and the commit was not, which left the loop open at
 * exactly the point it mattered: `topic.close` refuses over uncommitted
 * changes, so Cockpit blocked you on a state it gave you no way to leave. You
 * had to go to a terminal, which is the one thing this window exists to avoid.
 *
 * A topic spans repositories, so committing is one act across all of them
 * with one message — the same shape as opening it and rebasing it. Repos with
 * nothing staged are skipped rather than made to carry an empty commit.
 */

export interface CommitInput {
  /** Commit in every repository of this topic. */
  topicId?: string
  /** Or in exactly these workspaces. One of the two is required. */
  workspaceIds?: string[]
  message: string
  /**
   * Stage everything first, untracked included. Off means "commit what is
   * already staged", which is the answer when the Diff tab was used to pick.
   */
  all: boolean
}

/**
 * What each repository would contribute, before anything is written.
 *
 * Re-probed rather than read off the registry (§3.4). The cached state is
 * refreshed by the watcher and by a 60-second reconcile, and either is too
 * late here: a stale count means offering to commit files that are no longer
 * there, or refusing with "nothing to commit" over work that plainly exists.
 */
export async function preview(input: CommitInput): Promise<CommitPreview[]> {
  const out: CommitPreview[] = []
  for (const target of resolveTargets(input)) {
    const w = (await registry.refreshGit(target.id)) ?? target
    const g = w.git
    if (!g) continue
    const staged = g.staged
    const unstaged = g.unstaged + g.untracked
    out.push({
      workspaceId: w.id,
      repo: w.name,
      branch: g.branch,
      staged,
      unstaged,
      // §16 — a commit on the protected branch is the one this must never make.
      // The branch name check is the window's approximation; `plan` re-checks.
      willCommit: input.all ? staged + unstaged > 0 : staged > 0,
      conflicted: g.conflicted,
    })
  }
  return out
}

function resolveTargets(input: CommitInput) {
  if (input.workspaceIds?.length) {
    return input.workspaceIds.map((id) => registry.requireWorkspace(id)).filter((w) => w.repo)
  }
  if (!input.topicId) throw new Error('commit needs a topic or a set of workspaces')
  const f = registry.getTopic(input.topicId)
  if (!f) throw new Error('unknown topic: ' + input.topicId)
  return registry
    .allWorkspaces(f.projectId)
    .filter((w) => w.topicId === input.topicId && w.repo && w.kind !== 'group')
}

/**
 * §3.7 — a commit is an operation, so it gets a plan like everything else.
 * The message is quoted as one argument; `tokenize` honours quotes, and a
 * message with a space in it was the first thing that needed that to be true.
 */
export async function plan(input: CommitInput): Promise<{
  ok: boolean
  detail: string
  plan: PlanPreview | null
  preview: CommitPreview[]
}> {
  const message = input.message.trim()
  if (!message) return { ok: false, detail: 'a commit needs a message', plan: null, preview: [] }
  if (message.includes('"')) {
    // The plan is a shown command; a double quote in the message would break
    // the argv it is tokenized back into. Refusing beats committing something
    // other than what was previewed.
    return {
      ok: false,
      detail: 'the message cannot contain a double quote — the plan shows the exact command it runs',
      plan: null,
      preview: [],
    }
  }

  // preview() re-probes, so the rows below are current and the targets can be
  // read back from the registry afterwards without a second round of git.
  const rows = await preview(input)
  const targets = resolveTargets(input)
  const steps: PlanStep[] = []
  const warnings: string[] = []
  const repos: string[] = []

  for (const w of targets) {
    const row = rows.find((r) => r.workspaceId === w.id)
    if (!row) continue

    if (row.conflicted > 0) {
      return {
        ok: false,
        detail: w.name + ' has ' + row.conflicted + ' unresolved conflict(s); finish that first',
        plan: null,
        preview: rows,
      }
    }

    // §7 + §16 — never a commit on the protected branch. The same rule agents
    // live under; a human clicking a button is not an exemption.
    const base = await defaultBranchOf(w.path)
    if (row.branch && row.branch === base) {
      warnings.push(w.name + ' is on ' + base + ' and will be skipped — Cockpit does not commit to the protected branch.')
      continue
    }
    if (!row.willCommit) continue

    if (input.all) {
      steps.push({
        title: w.name + ': stage everything',
        command: 'git add -A',
        cwd: w.path,
        destructive: false,
      })
    }
    steps.push({
      title: w.name + ': commit ' + (input.all ? row.staged + row.unstaged : row.staged) + ' file(s)',
      command: 'git commit -m "' + message + '"',
      cwd: w.path,
      destructive: false,
    })
    repos.push(w.name)
  }

  if (!steps.length) {
    return {
      ok: false,
      detail: warnings.length ? warnings.join(' ') : 'nothing to commit',
      plan: null,
      preview: rows,
    }
  }

  if (repos.length > 1) {
    warnings.push(
      'One message, ' + repos.length + ' commits — one per repository. Git has no cross-repo commit; this is as close as it gets.',
    )
  }

  const p: PlanPreview = {
    planId: newId('plan_'),
    operation: 'commit',
    steps,
    warnings,
    capturesRestorePoint: false,
    repos,
    // A commit that fails in the third repo leaves the first two committed,
    // and that is correct: those commits are good work, and `git reset` to
    // "recover" from a hook rejecting one repo would throw them away.
    onFailure: 'halt',
  }
  plans.register(p, { workspaceIds: targets.map((w) => w.id) })
  return { ok: true, detail: repos.length + ' repository(ies)', plan: p, preview: rows }
}

async function defaultBranchOf(cwd: string): Promise<string> {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], 10_000)
  if (r.ok && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '')
  for (const cand of ['main', 'master', 'develop']) {
    const v = await git(cwd, ['rev-parse', '--verify', '--quiet', cand], 10_000)
    if (v.ok && v.stdout.trim()) return cand
  }
  return 'main'
}

export { basename }
