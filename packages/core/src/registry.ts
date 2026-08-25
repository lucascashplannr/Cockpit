import { basename, join, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { stableId } from '@cockpit/shared'
import type { Capability, Ceremony, Feature, Project, Workspace } from '@cockpit/shared'
import { loadConfig, updateConfig } from './config.js'
import { childRepos, detectCapabilities, findManifest, projectNameFor, readManifest } from './detect.js'
import { isRepo, isWorktree, listWorktrees, probeGit } from './git.js'
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

export function allFeatures(projectId?: string): Feature[] {
  const list = [...features.values()]
  return projectId ? list.filter((f) => f.projectId === projectId) : list
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

  const name = projectNameFor(root, manifest)
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
 * §4 — a feature is a decoration over workspaces. We infer it from the branch
 * name shared by several worktrees; nothing is invented when there is no match.
 */
function deriveFeatures(project: Project): void {
  const byBranch = new Map<string, Workspace[]>()
  for (const id of project.workspaceIds) {
    const w = workspaces.get(id)
    if (!w || w.kind !== 'worktree') continue
    const branch = w.git?.branch ?? w.name
    if (!branch) continue
    const arr = byBranch.get(branch) ?? []
    arr.push(w)
    byBranch.set(branch, arr)
  }

  project.featureIds = []
  for (const [branch, group] of byBranch) {
    const id = stableId('feat', project.id, branch)
    const existing = features.get(id)
    const feature: Feature = {
      id,
      projectId: project.id,
      name: branch,
      workspaceIds: group.map((w) => w.id),
      ticket: existing?.ticket ?? null,
      review: existing?.review ?? null,
      ceremony: group.length > 1 ? 'C3' : 'C2',
      createdAt: existing?.createdAt ?? Date.now(),
      archived: false,
    }
    features.set(id, feature)
    project.featureIds.push(id)
    for (const w of group) w.featureId = id
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
