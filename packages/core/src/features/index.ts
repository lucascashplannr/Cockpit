import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { newId, stableId } from '@cockpit/shared'
import type {
  Ceremony, DatabasePlan, Feature, PlanPreview, PlanStep, SeedProposal, Workspace,
} from '@cockpit/shared'
import { append } from '../journal.js'
import { defaultBranch, git } from '../git.js'
import * as plans from '../plans.js'
import * as registry from '../registry.js'
import { moveToTrash } from '../files.js'
import * as runtime from '../runtime/index.js'
import * as database from '../database.js'
import * as seed from '../seed.js'
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
  /**
   * §7 — the gitignored local config to carry into each worktree, as approved.
   * Absent means "whatever the manifest declares, or nothing" — never the
   * detected proposal, because a detected proposal has not been seen yet.
   */
  seed?: SeedProposal[]
  /** §5 — write the approved answer into cockpit.yaml so the next one is free. */
  rememberSeed?: boolean
  /**
   * §10 — give each worktree its own copy of the data. Off unless asked: it
   * copies a whole database, which is slow and takes real disk.
   */
  cloneDatabase?: boolean
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

  // §10 — the third global thing. Ports and hostnames are already scoped per
  // feature; without this the worktrees still share one database, so a
  // migration run by an agent in one breaks the other two.
  const dbEnv: Record<string, string> = {}
  if (input.cloneDatabase && input.ceremony !== 'C1') {
    for (const repo of repos) {
      const conn = database.connectionOf(repo.path)
      if (!conn || conn.engine === 'sqlite') continue
      const target = (await seed.contextFor({
        projectId: project.id,
        repoPath: repo.path,
        slug,
        tld: 'test',
        baseDb: conn.database,
      })).db
      const cloneSteps = database.clonePlan(conn, target, repo.path)
      if (!cloneSteps.length) continue
      steps.push(...cloneSteps)
      Object.assign(dbEnv, database.envFor(conn))
      const missing = (await database.tooling(conn.engine)).filter((t) => !t.found)
      if (missing.length) {
        warnings.push(
          repo.name + ': ' + missing.map((t) => t.bin).join(', ') +
            ' not on PATH — the clone will fail and the plan will stop there.',
        )
      } else {
        warnings.push(
          repo.name + ': ' + conn.database + ' is copied into ' + target +
            '. A large database makes this slow and costs the same disk again.',
        )
      }
    }
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
    // §16 — the database password reaches the client through here and nowhere
    // else: not in the previewed command, not in the journal, not in `ps`.
    ...(Object.keys(dbEnv).length ? { env: dbEnv } : {}),
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

      // §7 — only now do the worktrees exist to be seeded. Before this point
      // there is nowhere to put a `.env`; after it, the feature is bootable
      // rather than a checkout missing every file git refuses to track.
      if (input.ceremony !== 'C1') await runSeed(input, repos, slug, project.id)

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

/**
 * §5 — the approved proposal if the caller supplied one, otherwise whatever
 * the manifest already declares. Never the detected proposal on its own: a
 * detection nobody has seen must not write into someone's `.env`.
 */
async function runSeed(
  input: OpenFeatureInput,
  repos: Workspace[],
  slug: string,
  projectId: string,
): Promise<void> {
  const approved = new Map((input.seed ?? []).map((p) => [p.repo, p]))

  for (const repo of repos) {
    const name = basename(repo.path)
    let proposal = approved.get(name) ?? null

    if (!proposal) {
      const detected = await seed.propose({ projectId, repoPath: repo.path, slug })
      // Declared in the manifest is an answer already given; detected is a
      // question nobody was asked, and acting on it unasked is exactly the
      // guessing §5 warns about.
      if (detected.source !== 'manifest') continue
      proposal = detected
    }
    if (!proposal.files.length) continue

    const res = seed.applySeed(proposal)
    if (res.errors.length) {
      // Not fatal: a feature with three of four files carried is workable and
      // fixable, while unwinding three worktrees over one unreadable `.env`
      // is not. The journal has the detail either way.
      append({
        type: 'worktree.seeded',
        level: 'warn',
        payload: { repo: name, errors: res.errors },
      })
    }
  }

  // §5 — approve once. Written after the copies so a manifest is only updated
  // by something that actually worked.
  if (input.rememberSeed) {
    for (const proposal of input.seed ?? []) {
      if (!proposal.manifestPath || !proposal.files.length) continue
      seed.saveToManifest(proposal.manifestPath, [seed.toManifestEntry(proposal)])
    }
  }
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

/**
 * §4 + §3.7 — the feature is the unit of work, so bringing it up to date is
 * one act, not one per repository.
 *
 * `onFailure: 'halt'` is the whole difference from every other multi-repo plan
 * here. Opening a feature is all-or-nothing because a half-created feature is
 * unusable; a half-rebased one is not — the repositories that replayed cleanly
 * are genuinely done, and rolling them back to "recover" from a conflict in
 * the third would be throwing away good work to tidy up.
 *
 * Re-running it is the way forward after a conflict is resolved: a branch
 * already replayed answers "up to date" and costs a fetch.
 */
export async function rebasePlan(
  featureId: string,
  base?: string,
): Promise<{ ok: boolean; detail: string; plan: PlanPreview | null }> {
  const f = store.get(featureId)
  if (!f) throw new Error('unknown feature: ' + featureId)
  if (f.state === 'archived') return { ok: false, detail: 'this feature is closed; re-open it first', plan: null }

  const repos = workspacesOf(featureId).filter((w) => w.repo)
  if (!repos.length) return { ok: false, detail: 'no repository in this feature', plan: null }

  // A repository mid-conflict cannot take another rebase, and saying so up
  // front beats a plan whose second step is guaranteed to fail.
  const blocked = repos.filter((w) => w.git?.headState === 'rebasing' || w.git?.headState === 'merging')
  if (blocked.length) {
    return {
      ok: false,
      plan: null,
      detail:
        blocked.map((w) => w.name + ' is mid-' + w.git!.headState).join(', ') +
        '. Finish or abort that first — the conflict panel has both.',
    }
  }

  const steps: PlanStep[] = []
  const warnings: string[] = []
  const names: string[] = []

  for (const w of repos) {
    const onto = base ?? (await defaultBranch(w.path))
    const branch = w.git?.branch ?? f.slug
    names.push(w.name)
    steps.push({
      title: w.name + ': fetch ' + onto,
      command: 'git fetch origin ' + onto,
      cwd: w.path,
      destructive: false,
    })
    steps.push(...plans.rebaseStep(w.path, branch, onto))
    if ((w.git?.ahead ?? 0) > 0 && w.git?.upstream) {
      warnings.push(
        w.name + ' is ' + w.git.ahead + ' commit(s) ahead of ' + w.git.upstream +
          '; the rebase rewrites them and pushing will need --force-with-lease.',
      )
    }
  }

  if (repos.some((w) => (w.git?.staged ?? 0) + (w.git?.unstaged ?? 0) > 0)) {
    warnings.push(
      'Uncommitted changes are set aside by --autostash and put back when each rebase ends, abort included. Git holds that stash, so a conflict cannot strand it.',
    )
  }
  warnings.push(
    'Repositories are rebased in order and it stops at the first conflict — what already replayed is kept, not rolled back. Resolve, then run this again: a branch already up to date costs only a fetch.',
  )

  const preview: PlanPreview = {
    planId: newId('plan_'),
    operation: 'feature.rebase',
    steps,
    warnings,
    capturesRestorePoint: true,
    repos: names,
    onFailure: 'halt',
  }

  plans.register(preview, { workspaceIds: repos.map((w) => w.id) })
  return { ok: true, detail: 'plan ready', plan: preview }
}

/**
 * §4 — the verb the lifecycle was missing.
 *
 * A feature could be opened, worked in, rebased and closed, and nothing in
 * Cockpit ever put it back on the main branch. `merge` goes the other way —
 * it brings the base *into* the branch to catch it up — so the last step,
 * the one that makes the work count, was "go to a terminal". This is that
 * step: for every repository the feature spans, take its main checkout to the
 * base branch, fast-forward it, and merge the feature branch into it.
 *
 * It runs in the MAIN checkout, never in the worktree. Git will not have one
 * branch checked out twice, and the main checkout is already sitting on the
 * base — which is precisely what the worktree layout buys.
 */
export async function landPlan(
  featureId: string,
  opts: { push?: boolean; base?: string } = {},
): Promise<{ ok: boolean; detail: string; plan: PlanPreview | null }> {
  const f = store.get(featureId)
  if (!f) throw new Error('unknown feature: ' + featureId)
  if (f.state === 'archived') return { ok: false, detail: 'this feature is closed; re-open it first', plan: null }

  const trees = workspacesOf(featureId).filter((w) => w.repo && w.kind !== 'group')
  if (!trees.length) return { ok: false, detail: 'no repository in this feature', plan: null }

  const mains = registry.allWorkspaces(f.projectId).filter((w) => w.kind === 'main' && w.repo)
  const steps: PlanStep[] = []
  const warnings: string[] = []
  const names: string[] = []
  const blockers: string[] = []

  for (const tree of trees) {
    // A worktree's own main checkout is the one with the same folder name; for
    // a C1 feature the "tree" IS the main checkout and the two coincide.
    const main = mains.find((m) => basename(m.path) === basename(tree.path)) ?? null
    if (!main) {
      blockers.push(tree.name + ': cannot find its main checkout')
      continue
    }

    // Everything that would make the merge lie about what it merged.
    if ((tree.git?.staged ?? 0) + (tree.git?.unstaged ?? 0) > 0) {
      blockers.push(tree.name + ': uncommitted changes — commit them first')
    }
    if (tree.git?.headState === 'rebasing' || tree.git?.headState === 'merging') {
      blockers.push(tree.name + ': mid-' + tree.git.headState + ', finish or abort it first')
    }
    if (main !== tree && (main.git?.staged ?? 0) + (main.git?.unstaged ?? 0) > 0) {
      // The merge happens in the main checkout; uncommitted work there would
      // be caught up in it, or block the switch.
      blockers.push(main.name + ' (main checkout): uncommitted changes')
    }

    const base = opts.base ?? (await defaultBranch(main.path))
    const branch = tree.git?.branch ?? f.slug
    if (branch === base) {
      warnings.push(tree.name + ' is already on ' + base + ' — nothing to land.')
      continue
    }
    names.push(main.name)

    steps.push({
      title: main.name + ': fetch ' + base,
      command: 'git fetch origin ' + base,
      cwd: main.path,
      destructive: false,
    })
    // Only when it is not already there: switching a checkout that is already
    // on the base is a no-op that still shows up as a step, and a plan whose
    // steps do nothing is a plan nobody reads.
    if (main.git?.branch !== base) {
      steps.push({
        title: main.name + ': switch to ' + base,
        command: 'git switch ' + base,
        cwd: main.path,
        destructive: false,
        undo: [{ title: main.name + ': switch back', command: 'git switch -', cwd: main.path }],
      })
    }
    steps.push({
      title: main.name + ': fast-forward ' + base,
      command: 'git merge --ff-only origin/' + base,
      cwd: main.path,
      destructive: false,
    })
    steps.push({
      title: main.name + ': merge ' + branch + ' into ' + base,
      command: 'git merge --no-ff ' + branch + ' -m "Merge ' + f.name.replace(/"/g, '') + '"',
      cwd: main.path,
      destructive: true,
    })
    if (opts.push) {
      steps.push({
        title: main.name + ': push ' + base,
        command: 'git push origin ' + base,
        cwd: main.path,
        destructive: true,
      })
    }
  }

  if (blockers.length) return { ok: false, detail: blockers.join('; '), plan: null }
  if (!steps.length) {
    return { ok: false, detail: warnings.join(' ') || 'nothing to land', plan: null }
  }

  warnings.push(
    '--no-ff, so the feature stays one identifiable merge in the history of ' +
      (opts.base ?? 'the base branch') + ' rather than a scatter of commits.',
  )
  warnings.push(
    'Repositories land in order and it stops at the first conflict, keeping what already merged. Resolve it in the conflict panel, then run this again.',
  )
  if (!opts.push) {
    warnings.push('Nothing is pushed. The merge is local until you push it yourself.')
  }

  const preview: PlanPreview = {
    planId: newId('plan_'),
    operation: 'feature.land',
    steps,
    warnings,
    capturesRestorePoint: true,
    repos: names,
    // A half-landed feature is two repositories genuinely merged and one
    // conflicted, which is a state to finish — not one to undo.
    onFailure: 'halt',
  }
  plans.register(preview, { workspaceIds: mains.map((m) => m.id) })
  return { ok: true, detail: 'plan ready', plan: preview }
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
/**
 * What `promptPreamble` would find, without building it — so the composer can
 * say "this run carries the feature memory" before a run costs anything (§7,
 * coût affiché).
 */
export function preambleParts(
  featureId: string,
  scopePaths: string[],
): { memory: boolean; context: boolean } {
  const f = store.get(featureId)
  if (!f?.rootPath) return { memory: false, context: false }
  return {
    memory: !!readIfPresent(join(f.rootPath, '.cockpit', 'memory.md')),
    context: !!readIfPresent(join(f.rootPath, 'CONTEXT.md')) && scopePaths.length > 1,
  }
}

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
  /**
   * §10 — drop the per-worktree databases. Off by default and destructive:
   * a database has no Trash to go to, so unlike the folder this one is gone.
   */
  dropDatabases?: boolean
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

  // §10 — a database left behind after the feature is gone is the silent
  // accumulation §16 warns about: nothing lists it and nobody remembers it.
  const dbEnv: Record<string, string> = {}
  if (input.dropDatabases) {
    for (const w of wss.filter((x) => x.kind === 'worktree')) {
      const conn = database.connectionOf(w.path)
      if (!conn || conn.engine === 'sqlite' || !conn.database) continue
      // The worktree's own `.env` names the database it actually uses, which
      // is the only trustworthy answer: recomputing the name from the slug
      // would drop the wrong one if anybody edited it.
      const owner = repos.find((m) => basename(m.path) === basename(w.path))
      const main = owner ? database.connectionOf(owner.path) : null
      if (main && main.database === conn.database) {
        warnings.push(
          w.name + ': its .env still points at ' + conn.database +
            ', which is the main checkout\'s own database. It will NOT be dropped.',
        )
        continue
      }
      steps.push(...database.dropPlan(conn, conn.database, w.path))
      Object.assign(dbEnv, database.envFor(conn))
      warnings.push(
        w.name + ': the database ' + conn.database + ' is dropped for good. There is no Trash for it.',
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
    ...(Object.keys(dbEnv).length ? { env: dbEnv } : {}),
    onApplied: finish,
  })
  return { ok: true, detail: 'plan ready', warnings, plan: preview }
}
