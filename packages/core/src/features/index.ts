import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { newId, stableId } from '@cockpit/shared'
import type { Ceremony, Feature, PlanPreview, PlanStep, Workspace } from '@cockpit/shared'
import { append } from '../journal.js'
import { defaultBranch, git } from '../git.js'
import * as plans from '../plans.js'
import * as registry from '../registry.js'
import { moveToTrash } from '../files.js'
import * as runtime from '../runtime/index.js'
import * as store from './store.js'

export * from './store.js'

/**
 * §4 — the feature, promoted from an inference to an object.
 *
 * The rule it must not break: a session is still "a list of paths + an engine
 * + a lease", never "a feature" (§7). The feature decides *where* the paths
 * are and *what the agent should know*; the lease still does the locking, so
 * C0 and C3 behave identically.
 */

export interface OpenFeatureInput {
  projectId: string
  name: string
  ceremony: Ceremony
  /** Main checkouts to span. Empty means every repository in the project. */
  repoWorkspaceIds?: string[]
  base?: string
  ticketUrl?: string
}

function mains(projectId: string, only?: string[]): Workspace[] {
  const all = registry.allWorkspaces(projectId).filter((w) => w.kind === 'main' && w.repo)
  if (!only?.length) return all
  const set = new Set(only)
  return all.filter((w) => set.has(w.id))
}

/**
 * §3.7 — one plan for the whole feature, previewed before anything exists.
 * The feature row is written by `onApplied`, so a plan the user cancels, or one
 * that fails on the third repository, leaves nothing behind to clean up.
 */
export async function openPlan(
  input: OpenFeatureInput,
): Promise<{ plan: PlanPreview; featureId: string }> {
  const project = registry.allProjects().find((p) => p.id === input.projectId)
  if (!project) throw new Error('unknown project: ' + input.projectId)

  const name = input.name.trim()
  if (!name) throw new Error('a feature needs a name')
  const slug = store.slugify(name)

  const existing = store.bySlug(project.id, slug)
  if (existing && existing.state !== 'archived') {
    throw new Error('"' + existing.name + '" already occupies the branch ' + slug)
  }

  const repos = mains(project.id, input.repoWorkspaceIds)
  if (!repos.length) throw new Error('no repository in this project')

  const featureId = stableId('feat', project.id, slug)
  const steps: PlanStep[] = []
  const warnings: string[] = []

  // §21.4, decided: grouped. Every repo's worktree lands under one folder, and
  // that folder is what holds the memory and the cross-repo CONTEXT.md (§7).
  const rootPath =
    input.ceremony === 'C1' ? null : plans.featureRootPath(repos[0]!.path, slug)

  for (const repo of repos) {
    const base = input.base ?? (await defaultBranch(repo.path))
    const branchTaken = await hasBranch(repo.path, slug)
    if (branchTaken) {
      warnings.push(repo.name + ': branch "' + slug + '" already exists and will be reused as-is.')
    }

    steps.push({
      title: repo.name + ': fetch ' + base,
      command: 'git fetch origin ' + base,
      cwd: repo.path,
      destructive: false,
    })

    if (input.ceremony === 'C1') {
      // A branch in the existing checkout. Switching back is the only honest
      // undo: deleting the branch could take a commit the agent already made.
      steps.push({
        title: repo.name + ': create branch ' + slug,
        command: 'git switch -c ' + slug,
        cwd: repo.path,
        destructive: false,
        undo: [{ title: repo.name + ': switch back', command: 'git switch -', cwd: repo.path }],
      })
      continue
    }

    const target = join(rootPath!, basename(repo.path))
    if (existsSync(target)) {
      warnings.push(repo.name + ': ' + target + ' already exists; the plan will stop there.')
    }

    // Two steps rather than `worktree add -b`, so the rollback is exact: the
    // branch and the checkout come undone separately.
    if (!branchTaken) {
      steps.push({
        title: repo.name + ': create branch ' + slug,
        command: 'git branch ' + slug + ' origin/' + base,
        cwd: repo.path,
        destructive: false,
        undo: [{ title: repo.name + ': delete branch ' + slug, command: 'git branch -D ' + slug, cwd: repo.path }],
      })
    }
    steps.push({
      title: repo.name + ': check out into ' + target,
      command: 'git worktree add ' + target + ' ' + slug,
      cwd: repo.path,
      destructive: false,
      undo: [
        { title: repo.name + ': remove worktree', command: 'git worktree remove --force ' + target, cwd: repo.path },
        { title: repo.name + ': prune', command: 'git worktree prune', cwd: repo.path },
      ],
    })
  }

  if (input.ceremony !== 'C1') {
    warnings.push(
      repos.length +
        ' worktree(s) under ' +
        rootPath +
        '. Disk cost is real and accumulates silently (§16) — close the feature when it merges.',
    )
  }
  if (repos.length > 1) {
    warnings.push(
      'A CONTEXT.md describing how these repositories relate will be created at the feature root. ' +
        'Fill it in before letting an agent span more than one of them (§7).',
    )
  }

  const preview: PlanPreview = {
    planId: newId('plan_'),
    operation: 'feature.open',
    steps,
    warnings,
    capturesRestorePoint: false,
    repos: repos.map((r) => r.name),
  }

  plans.register(preview, {
    workspaceIds: repos.map((r) => r.id),
    async onApplied() {
      store.save({
        id: featureId,
        projectId: project.id,
        name,
        slug,
        rootPath,
        state: 'parked',
        ceremony: input.ceremony,
        ticket: input.ticketUrl
          ? { provider: 'url', key: slug, title: name, status: 'open', url: input.ticketUrl }
          : null,
        review: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      if (rootPath) scaffold(rootPath, name, slug, repos)
      append({
        type: 'feature.opened',
        projectId: project.id,
        payload: { featureId, name, slug, ceremony: input.ceremony, repos: repos.map((r) => r.name), rootPath },
      })
      await registry.reconcile(project.id)
    },
  })

  return { plan: preview, featureId }
}

async function hasBranch(repoPath: string, branch: string): Promise<boolean> {
  const r = await git(repoPath, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], 10_000)
  return r.ok && !!r.stdout.trim()
}

/**
 * §6 + §7 — the two files that make a multi-day, multi-repo feature workable:
 * a memory that survives clearing every session, and the instruction file
 * without which "un agent multi-repo est plus dangereux qu'utile".
 */
function scaffold(rootPath: string, name: string, slug: string, repos: Workspace[]): void {
  mkdirSync(join(rootPath, '.cockpit'), { recursive: true })

  const memoryFile = join(rootPath, '.cockpit', 'memory.md')
  if (!existsSync(memoryFile)) {
    writeFileSync(
      memoryFile,
      [
        '# ' + name,
        '',
        '## Objectif',
        '',
        '## Décisions',
        "_(ce qui a été tranché, et pourquoi)_",
        '',
        '## Contraintes',
        "_(ce qu'il ne faut pas casser)_",
        '',
        '## Écarté',
        '_(la section la plus précieuse : sans elle, chaque session fraîche',
        'repropose la solution déjà rejetée pour une bonne raison)_',
        '',
        '## État',
        '',
      ].join('\n'),
      'utf8',
    )
  }

  const contextFile = join(rootPath, 'CONTEXT.md')
  if (!existsSync(contextFile)) {
    writeFileSync(
      contextFile,
      [
        '# ' + name + ' — cross-repository context',
        '',
        'Read by every agent session scoped to more than one of these repositories.',
        'Until it says something true, an agent spanning them is more dangerous than',
        'useful (§7) — so fill it in before widening a session past one repo.',
        '',
        '## Repositories in this feature',
        '',
        ...repos.map((r) => '- `' + basename(r.path) + '/` — _(what it is, what it owns)_'),
        '',
        '## Who calls whom',
        '',
        '_(direction of the dependency, the API surface between them)_',
        '',
        '## Conventions that cross the boundary',
        '',
        '_(shared types, error shapes, naming, versioning)_',
        '',
        '## Do not touch',
        '',
        '_(generated files, vendored code, anything owned by another team)_',
        '',
        '---',
        '',
        'Branch: `' + slug + '` in every repository above.',
      ].join('\n'),
      'utf8',
    )
  }
}

/* ── live / parked ───────────────────────────────────────────────────────
 * The part that decides whether several features can actually be tested at
 * once. Ports are already global and deterministic (§11), so portable
 * runtimes coexist for free. Everything else is arbitrated here.
 */

export interface ActivateResult {
  ok: boolean
  detail: string
  /** Features taken down to make room. */
  parked: string[]
  /** Why it refused, when it did. */
  conflicts: string[]
}

function workspacesOf(featureId: string): Workspace[] {
  return registry.allWorkspaces().filter((w) => w.featureId === featureId)
}

/**
 * §8 — `exclusive` is the flag that says "only one of these at a time on this
 * machine". Two live features sharing an exclusive runtime is not a feature to
 * build, it is a state to refuse — with the offer to park the other one.
 */
function exclusiveConflicts(featureId: string, targets: Workspace[]): { ws: Workspace; holder: Feature | null }[] {
  const out: { ws: Workspace; holder: Feature | null }[] = []
  const impls = new Set(targets.filter((w) => w.runtime?.exclusive).map((w) => w.runtime!.impl))
  if (!impls.size) return out

  for (const w of registry.allWorkspaces()) {
    if (w.featureId === featureId) continue
    if (!w.runtime?.exclusive || !impls.has(w.runtime.impl)) continue
    if (w.runtime.status !== 'up' && w.runtime.status !== 'starting') continue
    out.push({ ws: w, holder: registry.allFeatures().find((f) => f.id === w.featureId) ?? null })
  }
  return out
}

export async function activate(featureId: string, force = false): Promise<ActivateResult> {
  const f = store.get(featureId)
  if (!f) throw new Error('unknown feature: ' + featureId)
  if (f.state === 'archived') {
    return { ok: false, detail: 'this feature is closed; re-open it before running it', parked: [], conflicts: [] }
  }

  const targets = workspacesOf(featureId).filter((w) => w.runtime)
  if (!targets.length) {
    store.patch(featureId, (x) => {
      x.state = 'live'
    })
    return { ok: true, detail: 'no runtime in this feature; nothing to start', parked: [], conflicts: [] }
  }

  const clashes = exclusiveConflicts(featureId, targets)
  if (clashes.length && !force) {
    // One line per holder, not per workspace: three worktrees of the same
    // feature holding the same runtime is one problem, not three.
    const seen = new Set<string>()
    const conflicts: string[] = []
    for (const c of clashes) {
      const key = (c.holder?.id ?? c.ws.id) + '/' + c.ws.runtime!.impl
      if (seen.has(key)) continue
      seen.add(key)
      conflicts.push(
        (c.holder?.name ?? c.ws.name) + ' is holding ' + c.ws.runtime!.impl + ', which runs one at a time',
      )
    }
    return {
      ok: false,
      parked: [],
      conflicts,
      detail: 'park it first, or activate with force to have Cockpit park it for you',
    }
  }

  const parked: string[] = []
  for (const c of clashes) {
    await runtime.down(c.ws)
    await registry.probeWorkspace(c.ws.id)
    const label = c.holder?.name ?? c.ws.name
    if (c.holder && c.holder.state !== 'parked') {
      store.patch(c.holder.id, (x) => {
        x.state = 'parked'
      })
      append({ type: 'feature.parked', payload: { featureId: c.holder.id, reason: 'made room for ' + f.name } })
    }
    if (!parked.includes(label)) parked.push(label)
  }

  const details: string[] = []
  for (const w of targets) {
    const res = await runtime.up(w)
    details.push(w.name + ': ' + res.detail)
    if (!w.runtime!.portable) {
      details.push(w.name + ': ' + w.runtime!.impl + ' is machine-local (§8) — this will not follow you elsewhere')
    }
    await registry.probeWorkspace(w.id)
  }

  store.patch(featureId, (x) => {
    x.state = 'live'
  })
  append({ type: 'feature.activated', projectId: f.projectId, payload: { featureId, workspaces: targets.length, parked } })
  return { ok: true, detail: details.join('\n'), parked, conflicts: [] }
}

/** Servers down, ports freed, worktrees untouched. Picking it back up is one click. */
export async function park(featureId: string): Promise<{ ok: boolean; detail: string }> {
  const f = store.get(featureId)
  if (!f) throw new Error('unknown feature: ' + featureId)

  const details: string[] = []
  for (const w of workspacesOf(featureId).filter((x) => x.runtime)) {
    const res = await runtime.down(w)
    details.push(w.name + ': ' + res.detail)
    await registry.probeWorkspace(w.id)
  }
  store.patch(featureId, (x) => {
    x.state = 'parked'
  })
  append({ type: 'feature.parked', projectId: f.projectId, payload: { featureId } })
  return { ok: true, detail: details.join('\n') || 'nothing was running' }
}

export function rename(featureId: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('a feature needs a name')
  const f = store.patch(featureId, (x) => {
    // The slug is the branch name in N repositories; renaming the display name
    // must not try to rename branches behind the user's back.
    x.name = trimmed
  })
  if (!f) throw new Error('unknown feature: ' + featureId)
  append({ type: 'feature.renamed', projectId: f.projectId, payload: { featureId, name: trimmed } })
}

/**
 * §16 — closing refuses over anything that would lose work, and removing the
 * worktrees is a plan of its own. Nothing here ever runs `rm -rf`.
 */
export async function closePlan(
  featureId: string,
  removeWorktrees: boolean,
): Promise<{ ok: boolean; detail: string; plan: PlanPreview | null }> {
  const f = store.get(featureId)
  if (!f) throw new Error('unknown feature: ' + featureId)

  const wss = workspacesOf(featureId)
  const blockers: string[] = []
  for (const w of wss) {
    if (w.git?.hasUnpushedWork) blockers.push(w.name + ': unpushed commits')
    if ((w.git?.staged ?? 0) + (w.git?.unstaged ?? 0) > 0) blockers.push(w.name + ': uncommitted changes')
    if (w.agentSessions.length) blockers.push(w.name + ': an agent session is open')
    if (w.runtime?.status === 'up' || w.runtime?.status === 'starting') blockers.push(w.name + ': runtime is up')
  }
  if (blockers.length) {
    return { ok: false, detail: blockers.join('; '), plan: null }
  }

  if (!removeWorktrees) {
    store.patch(featureId, (x) => {
      x.state = 'archived'
    })
    append({ type: 'feature.closed', projectId: f.projectId, payload: { featureId, removedWorktrees: false } })
    return { ok: true, detail: 'archived; the worktrees are still on disk', plan: null }
  }

  const steps: PlanStep[] = []
  for (const w of wss.filter((x) => x.kind === 'worktree')) {
    const owner = registry
      .allWorkspaces(f.projectId)
      .find((m) => m.kind === 'main' && m.repo && basename(m.path) === basename(w.path))
    const cwd = owner?.path ?? w.path
    steps.push({
      title: 'Remove worktree ' + w.name,
      command: 'git worktree remove --force ' + w.path,
      cwd,
      destructive: true,
    })
    steps.push({ title: 'Prune ' + basename(cwd), command: 'git worktree prune', cwd, destructive: false })
  }
  if (!steps.length) {
    store.patch(featureId, (x) => {
      x.state = 'archived'
    })
    return { ok: true, detail: 'archived; there was no worktree to remove', plan: null }
  }

  const preview: PlanPreview = {
    planId: newId('plan_'),
    operation: 'feature.close',
    steps,
    warnings: [
      'The branches stay: only the checkouts go. Anything not committed is already refused above.',
      f.rootPath ? 'The memory at ' + f.rootPath + '/.cockpit/memory.md is NOT removed — promote it to the docs first (§9).' : '',
    ].filter(Boolean),
    capturesRestorePoint: false,
    repos: wss.map((w) => w.name),
  }

  plans.register(preview, {
    workspaceIds: wss.map((w) => w.id),
    async onApplied() {
      store.patch(featureId, (x) => {
        x.state = 'archived'
      })
      append({ type: 'feature.closed', projectId: f.projectId, payload: { featureId, removedWorktrees: true } })
      await registry.reconcile(f.projectId)
    },
  })

  return { ok: true, detail: 'plan ready', plan: preview }
}

/**
 * §7 — "Un agent qui embrasse plusieurs repos a besoin d'un fichier
 * d'instructions à la racine du groupe." This is how it gets there: the
 * memory and the cross-repo context are handed to the engine as the opening
 * of the prompt, so clearing a session costs nothing (§6) — the next one
 * starts by reading the same two files.
 */
export function promptPreamble(featureId: string, scopePaths: string[]): string {
  const f = store.get(featureId)
  if (!f?.rootPath) return ''

  const parts: string[] = []
  const memory = readIfPresent(join(f.rootPath, '.cockpit', 'memory.md'))
  const context = readIfPresent(join(f.rootPath, 'CONTEXT.md'))

  if (memory) {
    parts.push(
      '# Feature memory — ' + f.name,
      'Durable understanding of this work. The "Écarté" section lists solutions',
      'already rejected for a reason: do not re-propose them.',
      '',
      memory,
    )
  }
  // Only when the session actually spans more than one repository — a
  // single-repo session does not need the map, and padding the prompt with it
  // costs money for nothing (§7, coût affiché).
  if (context && scopePaths.length > 1) {
    parts.push('', '# Cross-repository context', '', context)
  }
  if (!parts.length) return ''

  return parts.join('\n') + '\n\n---\n\n'
}

function readIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null
  } catch {
    return null
  }
}

/**
 * §4 — "on peut toujours monter de niveau" has a counterpart: a feature closed
 * by mistake, or one picked back up in December, must be reopenable. Archiving
 * is not a one-way door, which is what makes it a safe default for `close`.
 */
export function reopen(featureId: string): { ok: boolean; detail: string } {
  const f = store.get(featureId)
  if (!f) throw new Error('unknown feature: ' + featureId)
  if (f.state !== 'archived') return { ok: true, detail: 'it was never closed' }

  const clash = store.bySlug(f.projectId, f.slug)
  if (clash && clash.id !== f.id && clash.state !== 'archived') {
    return { ok: false, detail: '"' + clash.name + '" has taken the branch ' + f.slug + ' since' }
  }
  store.patch(featureId, (x) => {
    x.state = 'parked'
  })
  append({ type: 'feature.opened', projectId: f.projectId, payload: { featureId, reopened: true } })
  return {
    ok: true,
    detail: f.rootPath
      ? 'reopened, parked. Its worktrees may no longer exist — reconcile will say'
      : 'reopened, parked',
  }
}

/** Is every commit on this branch already reachable from the base? */
async function isMerged(repoPath: string, branch: string, base: string): Promise<boolean | null> {
  const exists = await git(repoPath, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], 10_000)
  if (!exists.ok || !exists.stdout.trim()) return null
  for (const ref of ['origin/' + base, base]) {
    const r = await git(repoPath, ['merge-base', '--is-ancestor', branch, ref], 15_000)
    if (r.ok) return true
    // Exit 1 is a clean "not an ancestor"; anything else means the ref is
    // missing and the next candidate deserves a try.
    if (r.code === 1) return false
  }
  return false
}

export interface DeleteFeatureInput {
  featureId: string
  /** Remove the checkouts. The folder goes to the Trash, never `rm -rf`. */
  removeWorktrees: boolean
  /** Delete the branch in every repository. This is the irreversible half. */
  deleteBranches: boolean
  /** Proceed over unmerged branches. Nothing else can be forced. */
  force?: boolean
}

/**
 * §16 — the difference between this and `close`: close archives and keeps
 * everything, delete drops the record for good. So every refusal here is a
 * refusal to lose work, and the one thing that cannot be undone — deleting a
 * branch holding unmerged commits — needs `force` said out loud.
 */
export async function deletePlan(
  input: DeleteFeatureInput,
): Promise<{ ok: boolean; detail: string; warnings: string[]; plan: PlanPreview | null }> {
  const f = store.get(input.featureId)
  if (!f) throw new Error('unknown feature: ' + input.featureId)

  const wss = workspacesOf(input.featureId)
  const warnings: string[] = []
  const blockers: string[] = []

  for (const w of wss) {
    if (w.agentSessions.length) blockers.push(w.name + ': an agent session is open')
    if (w.runtime?.status === 'up' || w.runtime?.status === 'starting') blockers.push(w.name + ': runtime is up')
    if ((w.git?.staged ?? 0) + (w.git?.unstaged ?? 0) > 0) blockers.push(w.name + ': uncommitted changes')
    if (w.git?.hasUnpushedWork) blockers.push(w.name + ': unpushed commits')
  }
  if (blockers.length) return { ok: false, detail: blockers.join('; '), warnings: [], plan: null }

  const repos = registry.allWorkspaces(f.projectId).filter((w) => w.kind === 'main' && w.repo)
  const steps: PlanStep[] = []

  if (input.removeWorktrees) {
    for (const w of wss.filter((x) => x.kind === 'worktree')) {
      const owner = repos.find((m) => basename(m.path) === basename(w.path)) ?? null
      const cwd = owner?.path ?? w.path
      steps.push({
        title: 'Remove worktree ' + w.name,
        command: 'git worktree remove --force ' + w.path,
        cwd,
        destructive: true,
      })
      steps.push({ title: 'Prune ' + basename(cwd), command: 'git worktree prune', cwd, destructive: false })
    }
  }

  if (input.deleteBranches) {
    const unmerged: string[] = []
    for (const repo of repos) {
      const base = await defaultBranch(repo.path)
      const merged = await isMerged(repo.path, f.slug, base)
      if (merged === null) continue // no such branch here; nothing to delete
      if (!merged) unmerged.push(repo.name)
      steps.push({
        title: repo.name + ': delete branch ' + f.slug + (merged ? '' : ' (UNMERGED)'),
        command: 'git branch -D ' + f.slug,
        cwd: repo.path,
        destructive: true,
      })
    }
    if (unmerged.length && !input.force) {
      return {
        ok: false,
        warnings: [],
        plan: null,
        detail:
          'the branch "' + f.slug + '" holds commits not merged into the base in ' +
          unmerged.join(', ') +
          '. Deleting it loses them for good — merge it first, or delete with force.',
      }
    }
    if (unmerged.length) {
      warnings.push(
        'UNMERGED commits in ' + unmerged.join(', ') + ' will be lost. Nothing can bring them back.',
      )
    }
  }

  if (input.removeWorktrees && f.rootPath) {
    warnings.push(
      'The feature folder goes to the Trash, including its memory at .cockpit/memory.md — ' +
        'promote what is worth keeping to the docs first (§9).',
    )
  }
  if (!input.deleteBranches) {
    warnings.push('The branches stay. Only the record and the checkouts go.')
  }

  const finish = async () => {
    if (input.removeWorktrees && f.rootPath) await moveToTrash(f.rootPath)
    store.remove(input.featureId)
    append({
      type: 'feature.deleted',
      projectId: f.projectId,
      payload: {
        featureId: input.featureId,
        name: f.name,
        slug: f.slug,
        removedWorktrees: input.removeWorktrees,
        deletedBranches: input.deleteBranches,
      },
    })
    await registry.reconcile(f.projectId)
  }

  // Nothing for git to do: the record is the only thing left to remove.
  if (!steps.length) {
    await finish()
    return { ok: true, detail: 'deleted "' + f.name + '"', warnings, plan: null }
  }

  const preview: PlanPreview = {
    planId: newId('plan_'),
    operation: 'feature.delete',
    steps,
    warnings,
    capturesRestorePoint: false,
    repos: repos.map((r) => r.name),
  }
  plans.register(preview, {
    workspaceIds: [...wss.map((w) => w.id), ...repos.map((r) => r.id)],
    onApplied: finish,
  })
  return { ok: true, detail: 'plan ready', warnings, plan: preview }
}
