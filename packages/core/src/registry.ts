import { basename, dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { stableId } from '@cockpit/shared'
import type { Capability, Ceremony, Feature, Project, Workspace } from '@cockpit/shared'
import * as featureStore from './features/store.js'
import { loadConfig, updateConfig } from './config.js'
import { childRepos, detectCapabilities, findManifest, projectNameFor, readManifest } from './detect.js'
import { isRepo, isWorktree, listWorktrees, probeGit } from './git.js'
import { run } from './exec.js'
import { append } from './journal.js'
import { leaseCovering } from './leases.js'
import { runtimeStateFor } from './runtime/index.js'
import { sessionsTouching } from './agents.js'

/**
 * §13 — "Réconciliation plutôt que mutation." Desired state is the manifest;
 * real state is probed; the difference is what the UI shows. Nothing that git,
 * the filesystem or the process table already knows is persisted (§3.4).
 */

const projects = new Map<string, Project>()
const workspaces = new Map<string, Workspace>()
const features = new Map<string, Feature>()

export function allProjects(): Project[] {
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function allWorkspaces(projectId?: string): Workspace[] {
  const list = [...workspaces.values()]
  const filtered = projectId ? list.filter((w) => w.projectId === projectId) : list
  return filtered.sort((a, b) => {
    if (a.projectId !== b.projectId) return a.projectId.localeCompare(b.projectId)
    // main checkouts first: they are workspaces in their own right (§4).
    if (a.kind !== b.kind) return a.kind === 'main' ? -1 : b.kind === 'main' ? 1 : 0
    return a.name.localeCompare(b.name)
  })
}

/**
 * §4 — persisted features first, inferred ones after. A feature Cockpit merely
 * guessed from matching branch names is real enough to display, but it is
 * never allowed to shadow one the user actually opened.
 */
export function allFeatures(projectId?: string, includeArchived = false): Feature[] {
  const list = [...features.values()].map(withRecord)
  // An archived feature has no workspaces left to derive it from, so it never
  // enters the map. Without this it was a row nobody could see, reopen or
  // remove — invisible state, which §3.4 exists to prevent.
  if (includeArchived) {
    for (const rec of featureStore.list(projectId)) {
      if (rec.state !== 'archived' || list.some((f) => f.id === rec.id)) continue
      list.push({
        id: rec.id,
        projectId: rec.projectId,
        name: rec.name,
        slug: rec.slug,
        rootPath: rec.rootPath,
        workspaceIds: [],
        state: 'archived',
        ticket: rec.ticket,
        review: rec.review,
        ceremony: rec.ceremony,
        derived: false,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        costUsd: featureStore.costFor(rec.id),
      })
    }
  }
  const filtered = projectId ? list.filter((f) => f.projectId === projectId) : list
  return filtered.sort((a, b) => {
    if ((a.state === 'archived') !== (b.state === 'archived')) return a.state === 'archived' ? 1 : -1
    if (a.derived !== b.derived) return a.derived ? 1 : -1
    return b.updatedAt - a.updatedAt
  })
}

export function getFeature(id: string): Feature | null {
  const f = features.get(id)
  if (f) return withRecord(f)
  return allFeatures(undefined, true).find((x) => x.id === id) ?? null
}

/**
 * §3.4 applied to the feature itself: membership is probed and cached in the
 * map, but the mutable half — its name, its live/parked state, what it has
 * cost — lives in the table and is read back on every call. Activating a
 * feature must not have to trigger a full reconcile to become true.
 */
function withRecord(f: Feature): Feature {
  if (f.derived) return f
  const rec = featureStore.get(f.id)
  if (!rec) return f
  return {
    ...f,
    name: rec.name,
    state: rec.state,
    ticket: rec.ticket,
    review: rec.review,
    updatedAt: rec.updatedAt,
    costUsd: featureStore.costFor(f.id),
  }
}

export function getWorkspace(id: string): Workspace | null {
  return workspaces.get(id) ?? null
}

export function requireWorkspace(id: string): Workspace {
  const w = workspaces.get(id)
  if (!w) throw new Error('unknown workspace: ' + id)
  return w
}

export function workspaceForPath(path: string): Workspace | null {
  const p = resolve(path)
  let best: Workspace | null = null
  for (const w of workspaces.values()) {
    if (p === w.path || p.startsWith(w.path + '/')) {
      if (!best || w.path.length > best.path.length) best = w
    }
  }
  return best
}

export function addProject(root: string): Project {
  const abs = resolve(root)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error('not a directory: ' + abs)
  }
  updateConfig((c) => {
    if (!c.projects.some((p) => p.root === abs)) c.projects.push({ root: abs, addedAt: Date.now() })
  })
  return buildProject(abs)
}

/** The machine-local display override, if the user set one. */
function configNameFor(root: string): string | null {
  const entry = loadConfig().projects.find((p) => p.root === root)
  const n = entry?.name?.trim()
  return n ? n : null
}

function requireProject(projectId: string): Project {
  const p = projects.get(projectId)
  if (!p) throw new Error('unknown project: ' + projectId)
  return p
}

/** Forget everything derived from a root, so it can be rebuilt from scratch. */
function dropProject(p: Project): void {
  for (const wid of p.workspaceIds) workspaces.delete(wid)
  for (const fid of p.featureIds) features.delete(fid)
  projects.delete(p.id)
}

/**
 * §16 — what would be pulled out from under someone. Moving or trashing a
 * folder while a dev server writes to it or an agent is mid-turn corrupts both,
 * so both operations refuse rather than warn.
 */
function liveWork(p: Project): string[] {
  const out: string[] = []
  for (const wid of p.workspaceIds) {
    const w = workspaces.get(wid)
    if (!w) continue
    if (w.runtime && (w.runtime.status === 'up' || w.runtime.status === 'starting')) {
      out.push(w.name + ': runtime is ' + w.runtime.status)
    }
    if (w.agentSessions.length) {
      out.push(w.name + ': ' + w.agentSessions.length + ' agent session(s) open')
    }
  }
  return out
}

export function renameProject(projectId: string, name: string | null): Project {
  const p = requireProject(projectId)
  const next = name?.trim() ?? ''
  updateConfig((c) => {
    const entry = c.projects.find((x) => x.root === p.root)
    if (!entry) return
    if (next) entry.name = next
    else delete entry.name
  })
  append({ type: 'project.renamed', projectId, payload: { root: p.root, name: next || null } })
  return buildProject(p.root)
}

/**
 * The project id is `stableId('prj', root)`, so a move is not a mutation: the
 * old project and its workspaces cease to exist and a new set is built at the
 * new path. The caller gets the new project and must re-select it.
 */
export function moveProject(projectId: string, root: string, moveFiles: boolean): Project {
  const p = requireProject(projectId)
  const abs = resolve(root)
  if (abs === p.root) return p

  const live = liveWork(p)
  if (live.length) throw new Error('stop these first — ' + live.join('; '))

  if (moveFiles) {
    if (!existsSync(p.root)) throw new Error('nothing at ' + p.root + ' to move')
    if (existsSync(abs)) throw new Error('already exists: ' + abs)
    mkdirSync(dirname(abs), { recursive: true })
    try {
      renameSync(p.root, abs)
    } catch (e) {
      // EXDEV: rename cannot cross a filesystem, and copying a repo tree behind
      // the user's back is worse than saying so.
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        throw new Error(abs + ' is on another volume — move it yourself, then point Cockpit at it')
      }
      throw e
    }
  } else if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error('not a directory: ' + abs)
  }

  const name = configNameFor(p.root)
  updateConfig((c) => {
    c.projects = c.projects.filter((x) => x.root !== abs && x.root !== p.root)
    c.projects.push({ root: abs, addedAt: Date.now(), ...(name ? { name } : {}) })
  })

  dropProject(p)
  append({ type: 'project.moved', projectId, payload: { from: p.root, to: abs, moveFiles } })
  return buildProject(abs)
}

/**
 * To the system Trash, never `rm -rf`: this is the one action in the app that
 * touches somebody's source tree, and it has to stay recoverable.
 */
export async function trashProject(projectId: string): Promise<string> {
  const p = requireProject(projectId)

  const live = liveWork(p)
  if (live.length) throw new Error('stop these first — ' + live.join('; '))

  const unpushed = p.workspaceIds
    .map((id) => workspaces.get(id))
    .filter((w): w is Workspace => !!w && !!w.git?.hasUnpushedWork)
    .map((w) => w.name)
  if (unpushed.length) {
    throw new Error('unpushed commits in ' + unpushed.join(', ') + ' — push or drop them first')
  }

  const root = p.root
  if (existsSync(root)) {
    const r =
      process.platform === 'darwin'
        ? await run('osascript', [
            '-e',
            'tell application "Finder" to delete POSIX file "' + root.replace(/"/g, '\\"') + '"',
          ])
        : await run('gio', ['trash', root])
    if (!r.ok) throw new Error('could not move to Trash: ' + (r.stderr || r.stdout).trim())
  }

  updateConfig((c) => {
    c.projects = c.projects.filter((x) => x.root !== root)
  })
  dropProject(p)
  append({ type: 'project.trashed', projectId, payload: { root } })
  return root
}

export function forgetProject(projectId: string): void {
  const p = projects.get(projectId)
  if (!p) return
  updateConfig((c) => {
    c.projects = c.projects.filter((x) => x.root !== p.root)
  })
  for (const wid of p.workspaceIds) workspaces.delete(wid)
  for (const fid of p.featureIds) features.delete(fid)
  projects.delete(projectId)
  append({ type: 'workspace.forgotten', projectId, payload: { root: p.root } })
}

/**
 * Reads the desired state (manifest, or nothing) and enumerates the real
 * workspaces on disk. Pure structure — no probing yet, that is a second pass.
 */
function buildProject(root: string): Project {
  const projectId = stableId('prj', root)
  const manifestPath = findManifest(root)
  const parsed = manifestPath ? readManifest(manifestPath) : { manifest: null, issues: [] }
  const manifest = parsed.manifest

  const name = configNameFor(root) ?? projectNameFor(root, manifest)
  const defaultCeremony = (manifest?.ceremony ?? 'C1') as Ceremony
  const caps = detectCapabilities(root, manifest)

  // Which folders hold repos: declared, or discovered one level down, or the
  // root itself for the plain mono-repo case.
  let repoPaths: string[]
  if (manifest?.repos?.length) {
    repoPaths = manifest.repos.map((r) => resolve(root, r.path))
  } else if (isRepo(root)) {
    repoPaths = [root]
  } else {
    repoPaths = childRepos(root)
  }

  const project: Project = {
    id: projectId,
    name,
    root,
    manifestPath,
    capabilities: caps,
    defaultCeremony,
    workspaceIds: [],
    featureIds: [],
  }

  const seen = new Set<string>()

  const addWorkspace = (path: string, kind: Workspace['kind'], displayName?: string) => {
    const id = stableId('ws', path)
    if (seen.has(id)) return
    seen.add(id)
    const wsCaps: Capability[] = detectCapabilities(path, manifest)
    const prev = workspaces.get(id)
    const ws: Workspace = {
      id,
      projectId,
      kind,
      name: displayName ?? basename(path),
      path,
      repo: isRepo(path) ? path : null,
      git: prev?.git ?? null,
      runtime: prev?.runtime ?? null,
      featureId: prev?.featureId ?? null,
      capabilities: wsCaps,
      agentSessions: [],
      lease: null,
      hasMemory: existsSync(join(path, '.cockpit', 'memory.md')),
      lastProbedAt: prev?.lastProbedAt ?? 0,
      diskBytes: prev?.diskBytes ?? null,
    }
    workspaces.set(id, ws)
    project.workspaceIds.push(id)
    if (!prev) append({ type: 'workspace.discovered', projectId, workspaceId: id, payload: { path, kind } })
  }

  // The root is a group when it holds several repos rather than being one.
  if (repoPaths.length > 1 || (!isRepo(root) && repoPaths.length > 0)) {
    addWorkspace(root, 'group', name)
  }

  for (const rp of repoPaths) {
    if (!existsSync(rp)) continue
    addWorkspace(rp, 'main')
  }

  if (repoPaths.length === 0 && !isRepo(root)) {
    // A folder with no repo at all is still a workspace (§7, dernier cas).
    addWorkspace(root, 'external', name)
  }

  projects.set(projectId, project)
  return project
}

/** Second pass: worktrees have to be listed from a live repo. */
async function discoverWorktrees(project: Project): Promise<void> {
  const mains = project.workspaceIds
    .map((id) => workspaces.get(id)!)
    .filter((w) => w && w.kind === 'main' && w.repo)

  for (const main of mains) {
    const entries = await listWorktrees(main.path)
    for (const entry of entries) {
      if (resolve(entry.path) === resolve(main.path)) continue
      if (!existsSync(entry.path)) continue
      const id = stableId('ws', entry.path)
      if (workspaces.has(id)) {
        project.workspaceIds.includes(id) || project.workspaceIds.push(id)
        continue
      }
      const ws: Workspace = {
        id,
        projectId: project.id,
        kind: 'worktree',
        name: entry.branch ?? basename(entry.path),
        path: entry.path,
        repo: entry.path,
        git: null,
        runtime: null,
        featureId: null,
        capabilities: detectCapabilities(entry.path, null),
        agentSessions: [],
        lease: null,
        hasMemory: existsSync(join(entry.path, '.cockpit', 'memory.md')),
        lastProbedAt: 0,
        diskBytes: null,
      }
      workspaces.set(id, ws)
      project.workspaceIds.push(id)
      append({
        type: 'workspace.discovered',
        projectId: project.id,
        workspaceId: id,
        payload: { path: entry.path, kind: 'worktree', branch: entry.branch },
      })
    }
  }
}

/**
 * §4 — a feature is a decoration over workspaces, and it comes from two places.
 *
 * Persisted: the user opened it, so its identity, name and live/parked state
 * outlive the daemon (that is the whole point of the table). Its membership is
 * still probed — matched by branch — because a worktree deleted by hand must
 * drop out of the feature rather than linger in a list.
 *
 * Inferred: several worktrees happen to share a branch name. Nothing is
 * invented when there is no match, and an inferred feature has no root folder,
 * so it can hold neither a memory nor a cross-repo context.
 */
function deriveFeatures(project: Project): void {
  // Keyed on the project, not on the previous `featureIds`: buildProject hands
  // back a fresh Project whose list is already empty, so trusting it left every
  // stale feature — an archived one above all — in the map for good.
  for (const [fid, f] of [...features]) {
    if (f.projectId === project.id) features.delete(fid)
  }
  project.featureIds = []

  const claimed = new Set<string>()
  const byBranch = new Map<string, Workspace[]>()
  for (const id of project.workspaceIds) {
    const w = workspaces.get(id)
    if (!w || w.kind !== 'worktree') continue
    w.featureId = null
    const branch = w.git?.branch ?? w.name
    if (!branch) continue
    const arr = byBranch.get(branch) ?? []
    arr.push(w)
    byBranch.set(branch, arr)
  }

  for (const rec of featureStore.list(project.id)) {
    if (rec.state === 'archived') continue

    // Membership is probed, never stored: the worktrees on that branch, plus
    // the feature's own root folder when it has one.
    const group = byBranch.get(rec.slug) ?? []
    const rootWs = rec.rootPath ? workspaces.get(stableId('ws', rec.rootPath)) : undefined

    const feature: Feature = {
      id: rec.id,
      projectId: project.id,
      name: rec.name,
      slug: rec.slug,
      rootPath: rec.rootPath,
      workspaceIds: [...(rootWs ? [rootWs.id] : []), ...group.map((w) => w.id)],
      state: rec.state,
      ticket: rec.ticket,
      review: rec.review,
      ceremony: rec.ceremony,
      derived: false,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      costUsd: featureStore.costFor(rec.id),
    }
    features.set(feature.id, feature)
    project.featureIds.push(feature.id)
    for (const w of group) {
      w.featureId = feature.id
      // Inside a feature every worktree is on the same branch by construction,
      // so the branch name distinguishes nothing. The repository does.
      w.name = basename(w.path)
      claimed.add(w.id)
    }
    if (rootWs) {
      rootWs.featureId = feature.id
      claimed.add(rootWs.id)
    }
    if (rec.state === 'live' && !group.length) {
      // The worktrees are gone from under it; a live feature with nothing in it
      // is a lie, and parking it is the honest reading.
      featureStore.patch(rec.id, (x) => {
        x.state = 'parked'
      })
      feature.state = 'parked'
    }
  }

  // Branches a persisted record already owns — including a closed one, whose
  // worktrees may still be on disk. Without this the leftovers of a closed
  // feature are re-derived as an "inferred" feature under the same stable id,
  // which resurrects it under its branch name and hides the real record.
  const owned = new Set(featureStore.list(project.id).map((r) => r.slug))

  for (const [branch, group] of byBranch) {
    if (owned.has(branch)) continue
    if (group.every((w) => claimed.has(w.id))) continue
    const rest = group.filter((w) => !claimed.has(w.id))
    const id = stableId('feat', project.id, branch)
    if (features.has(id)) continue
    const existing = features.get(id)
    const feature: Feature = {
      id,
      projectId: project.id,
      name: branch,
      slug: branch,
      rootPath: null,
      workspaceIds: rest.map((w) => w.id),
      state: 'parked',
      ticket: existing?.ticket ?? null,
      review: existing?.review ?? null,
      ceremony: rest.length > 1 ? 'C3' : 'C2',
      derived: true,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      costUsd: 0,
    }
    features.set(id, feature)
    project.featureIds.push(id)
    for (const w of rest) w.featureId = id
  }
}

/**
 * A feature's folder sits in `worktrees/<slug>/`, outside the project root, so
 * no amount of scanning finds it. It is registered explicitly: it is the group
 * workspace that holds the memory and the cross-repo CONTEXT.md (§7), and an
 * agent can be scoped to it to reach every repository at once.
 */
function addFeatureRoots(project: Project): void {
  for (const rec of featureStore.list(project.id)) {
    if (rec.state === 'archived' || !rec.rootPath || !existsSync(rec.rootPath)) continue
    const id = stableId('ws', rec.rootPath)
    if (workspaces.has(id)) {
      if (!project.workspaceIds.includes(id)) project.workspaceIds.push(id)
      continue
    }
    const ws: Workspace = {
      id,
      projectId: project.id,
      kind: 'group',
      name: rec.name,
      path: rec.rootPath,
      repo: null,
      git: null,
      runtime: null,
      featureId: rec.id,
      capabilities: detectCapabilities(rec.rootPath, null),
      agentSessions: [],
      lease: null,
      hasMemory: existsSync(join(rec.rootPath, '.cockpit', 'memory.md')),
      lastProbedAt: 0,
      diskBytes: null,
    }
    workspaces.set(id, ws)
    project.workspaceIds.push(id)
    append({
      type: 'workspace.discovered',
      projectId: project.id,
      workspaceId: id,
      payload: { path: rec.rootPath, kind: 'group', featureId: rec.id },
    })
  }
}

export async function probeWorkspace(id: string): Promise<Workspace> {
  const ws = requireWorkspace(id)
  ws.git = ws.repo ? await probeGit(ws.path) : null
  if (ws.kind === 'main' && (await isWorktree(ws.path))) ws.kind = 'worktree'
  ws.runtime = await runtimeStateFor(ws)
  ws.lease = leaseCovering(ws.path)
  ws.agentSessions = sessionsTouching(ws.path).map((s) => s.id)
  ws.hasMemory = existsSync(join(ws.path, '.cockpit', 'memory.md'))
  ws.lastProbedAt = Date.now()
  workspaces.set(id, ws)
  return ws
}

let reconciling = false

/** The single entry point that brings the in-memory view back in line with
 *  reality. Idempotent and replayable, so it doubles as diagnostics (§13). */
export async function reconcile(projectId?: string): Promise<number> {
  if (reconciling) return 0
  reconciling = true
  try {
    const cfg = loadConfig()
    const roots = projectId
      ? [projects.get(projectId)?.root].filter((x): x is string => !!x)
      : cfg.projects.map((p) => p.root)

    // Drop workspaces whose folder no longer exists — a manual `rm -rf` must
    // not leave the UI lying (§3.4).
    for (const [id, w] of [...workspaces]) {
      if (!existsSync(w.path)) {
        workspaces.delete(id)
        append({ type: 'workspace.forgotten', projectId: w.projectId, workspaceId: id, payload: { path: w.path } })
      }
    }

    let changed = 0
    for (const root of roots) {
      if (!existsSync(root)) continue
      const project = buildProject(root)
      addFeatureRoots(project)
      await discoverWorktrees(project)
      for (const wid of project.workspaceIds) {
        await probeWorkspace(wid)
        changed++
      }
      deriveFeatures(project)
    }
    append({ type: 'core.reconciled', payload: { projects: roots.length, workspaces: changed } })
    return changed
  } finally {
    reconciling = false
  }
}

/** Cheap refresh used by the watcher: git + lease only, no runtime probing. */
export async function refreshGit(id: string): Promise<Workspace | null> {
  const ws = workspaces.get(id)
  if (!ws || !ws.repo) return null
  ws.git = await probeGit(ws.path)
  ws.lease = leaseCovering(ws.path)
  ws.lastProbedAt = Date.now()
  return ws
}
