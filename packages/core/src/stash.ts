import { newId } from '@cockpit/shared'
import type { PlanPreview, PlanStep, StashEntry } from '@cockpit/shared'
import { git } from './git.js'
import * as plans from './plans.js'
import * as registry from './registry.js'

/**
 * §16 — setting work aside, where you can see you set it aside.
 *
 * `plans.ts` already explains why the rebase uses `--autostash` rather than a
 * push/pop pair: "the work was then sitting in a stash nothing in the app
 * mentioned". That is the whole hazard of this feature, and the reason it is
 * built the way it is — the list comes before the verb. Every entry Cockpit
 * makes is shown in the Diff tab, in the repository it was taken from, with
 * the branch it came off and the number of files it holds, until someone
 * brings it back or throws it away.
 *
 * A stash is not a commit and does not pretend to be one: no attribution, no
 * restore point, no undo button. What makes it safe is that it is visible.
 */

export interface StashScope {
  topicId?: string
  workspaceIds?: string[]
}

export interface StashInput extends StashScope {
  action: 'push' | 'pop' | 'apply' | 'drop'
  message?: string
  includeUntracked?: boolean
  /** pop/apply/drop act on one entry, in the repository that holds it. */
  workspaceId?: string
  ref?: string
}

/** How many entries per repository are described. Past this it is a landfill,
 *  and the answer is to empty it rather than to render it. */
const LIST_CAP = 25

/** The separator `--format` writes between fields; no message contains it. */
const SEP = '\u001f'

function resolveTargets(scope: StashScope) {
  if (scope.workspaceIds?.length) {
    return scope.workspaceIds.map((id) => registry.requireWorkspace(id)).filter((w) => w.repo)
  }
  if (!scope.topicId) throw new Error('stash needs a topic or a set of workspaces')
  const f = registry.getTopic(scope.topicId)
  if (!f) throw new Error('unknown topic: ' + scope.topicId)
  return registry
    .allWorkspaces(f.projectId)
    .filter((w) => w.topicId === scope.topicId && w.repo && w.kind !== 'group')
}

/**
 * `stash@{0}` and nothing else. The ref is interpolated into a previewed
 * command, so it is matched against a shape rather than trusted: a ref from
 * somewhere other than this list has no business reaching a shell argument.
 */
const REF = /^stash@\{\d+\}$/

export async function list(scope: StashScope): Promise<StashEntry[]> {
  const out: StashEntry[] = []
  for (const w of resolveTargets(scope)) {
    const r = await git(w.path, ['stash', 'list', '--format=%gd%x1f%gs%x1f%at'], 15_000)
    if (!r.ok) continue
    const lines = r.stdout.split('\n').filter(Boolean).slice(0, LIST_CAP)
    for (const line of lines) {
      const [ref, subject, at] = line.split(SEP)
      if (!ref || !REF.test(ref)) continue
      // git writes "WIP on main: 1a2b3c subject" or "On main: message".
      const m = /^(?:WIP on|On) ([^:]+):\s*(.*)$/.exec(subject ?? '')
      // `stash show` leaves untracked files out unless asked, and an entry that
      // holds only new files would otherwise be listed as holding nothing.
      // The flag is git 2.32 and later; older gits refuse it, hence the retry.
      let files = await git(w.path, ['stash', 'show', '--include-untracked', '--name-only', ref], 15_000)
      if (!files.ok) files = await git(w.path, ['stash', 'show', '--name-only', ref], 15_000)
      const held = files.ok ? files.stdout.split('\n').filter(Boolean) : []
      out.push({
        workspaceId: w.id,
        repo: w.name,
        ref,
        subject: (m?.[2] ?? subject ?? '').trim() || ref,
        // "On <branch>:" is git's form when it was given a message; "WIP on"
        // is what it writes when it was not.
        titled: /^On /.test(subject ?? ''),
        paths: held.slice(0, 3),
        branch: m?.[1] ?? null,
        ts: Number(at ?? 0) * 1000,
        files: held.length,
      })
    }
  }
  return out
}

export async function plan(input: StashInput): Promise<{
  ok: boolean
  detail: string
  plan: PlanPreview | null
}> {
  return input.action === 'push' ? push(input) : single(input)
}

/**
 * Setting aside is topic-wide, like committing: the work was done across the
 * repositories the topic spans, so it comes out of all of them at once and
 * goes back the same way. Repositories with a clean tree are skipped — an
 * empty stash entry is a row in a list that means nothing.
 */
async function push(input: StashInput) {
  const message = (input.message ?? '').trim()
  if (message.includes('"')) {
    return {
      ok: false,
      detail: 'the message cannot contain a double quote — the plan shows the exact command it runs',
      plan: null,
    }
  }

  const steps: PlanStep[] = []
  const warnings: string[] = []
  const repos: string[] = []
  const ids: string[] = []

  for (const w of resolveTargets(input)) {
    const fresh = (await registry.refreshGit(w.id)) ?? w
    const g = fresh.git
    if (!g) continue

    if (g.conflicted > 0) {
      return {
        ok: false,
        detail: w.name + ' has ' + g.conflicted + ' unresolved conflict(s); finish that first',
        plan: null,
      }
    }
    // Mid-rebase, git's own autostash already holds work: a second stash on
    // top of it is how a tree ends up in two places at once.
    if (g.operation) {
      return {
        ok: false,
        detail: w.name + ' is mid-' + g.operation.kind + '; finish or abort that before stashing',
        plan: null,
      }
    }

    const untracked = input.includeUntracked ?? true
    const count = g.staged + g.unstaged + (untracked ? g.untracked : 0)
    if (count === 0) continue

    steps.push({
      title: fresh.name + ': set aside ' + count + ' file(s)',
      command:
        'git stash push' +
        (untracked ? ' --include-untracked' : '') +
        (message ? ' -m "' + message + '"' : ''),
      cwd: fresh.path,
      // Nothing is lost — the entry is listed in the Diff tab the moment this
      // finishes, which is the whole design of this feature.
      destructive: false,
    })
    repos.push(fresh.name)
    ids.push(fresh.id)
    if (!untracked && g.untracked > 0) {
      warnings.push(
        fresh.name + ': ' + g.untracked + ' untracked file(s) stay in the working tree — ' +
          'git stash leaves them behind unless untracked files are included.',
      )
    }
  }

  if (!steps.length) return { ok: false, detail: 'nothing to set aside', plan: null }

  warnings.push(
    'The working tree goes back to its last commit. What was taken is listed in the Diff tab, ' +
      'one entry per repository, until you put it back.',
  )

  const p: PlanPreview = {
    planId: newId('plan_'),
    operation: 'stash',
    steps,
    warnings,
    // A restore point anchors HEAD, and stashing does not move HEAD; the entry
    // this creates is the recovery, so claiming an anchor would be theatre.
    capturesRestorePoint: false,
    repos,
    // One repository refusing to stash is no reason to force back the work
    // already set aside in the others — that would be a second write undoing
    // a write that succeeded.
    onFailure: 'halt',
  }
  plans.register(p, { workspaceIds: ids })
  return { ok: true, detail: repos.join(', '), plan: p }
}

/**
 * pop, apply and drop act on one entry. A stash ref belongs to the repository
 * that holds it — `stash@{0}` in two repositories is two unrelated things —
 * so these are never topic-wide, however much the push that made them was.
 */
async function single(input: StashInput) {
  if (!input.workspaceId) return { ok: false, detail: 'which repository?', plan: null }
  if (!input.ref || !REF.test(input.ref)) {
    return { ok: false, detail: 'not a stash ref: ' + (input.ref ?? '(none)'), plan: null }
  }
  const w = registry.requireWorkspace(input.workspaceId)
  const fresh = (await registry.refreshGit(w.id)) ?? w
  const g = fresh.git

  if (input.action !== 'drop' && g?.conflicted) {
    return {
      ok: false,
      detail: fresh.name + ' has unresolved conflicts; a stash cannot be applied over them',
      plan: null,
    }
  }

  const verb = input.action
  const warnings: string[] = []
  if (verb === 'pop' || verb === 'apply') {
    warnings.push(
      'This replays a change onto the current tree. It can conflict — if it does, git leaves the ' +
        'markers in the files' +
        (verb === 'pop' ? ' and keeps the entry until it applies cleanly' : '') + '.',
    )
    if (g?.branch) warnings.push('Applying onto ' + g.branch + '.')
  } else {
    warnings.push('Dropping an entry throws its changes away. There is no undo for this one.')
  }

  const p: PlanPreview = {
    planId: newId('plan_'),
    // Space, not a hyphen: the plan dialog capitalizes the operation for its
    // heading, and "Stash-Drop" is not a thing anyone calls it.
    operation: 'stash ' + verb,
    steps: [
      {
        title: fresh.name + ': ' + verb + ' ' + input.ref,
        command: 'git stash ' + verb + ' ' + input.ref,
        cwd: fresh.path,
        // §3.7 — the red mark is for the one that cannot be taken back.
        destructive: verb === 'drop',
      },
    ],
    warnings,
    capturesRestorePoint: false,
    repos: [fresh.name],
    onFailure: 'halt',
  }
  plans.register(p, { workspaceIds: [fresh.id] })
  return { ok: true, detail: fresh.name, plan: p }
}
