import { join, resolve as resolvePath } from 'node:path'
import type { AgentScope, AgentScopePath, AgentScopePreview, Workspace } from '@cockpit/shared'
import * as registry from './registry.js'
import * as features from './features/index.js'
import * as leases from './leases.js'
import { defaultBranch } from './git.js'

/**
 * §7 — the scope table, resolved.
 *
 * | Besoin                          | Portée                |
 * | Agent sur tout le projet        | les N chemins de repos |
 * | Agent sur un repo               | 1 chemin              |
 * | Agent sur un sous-dossier       | 1 sous-chemin         |
 * | Yolo sur le checkout principal  | le chemin du main     |
 * | Agent sur un dossier sans dépôt | 1 chemin, aucun repo  |
 *
 * Every row lands on the same thing: a list of paths. That is deliberate —
 * the lease is taken on paths and never on the scope, so a feature session and
 * a repo session inside it collide exactly as §7 requires, without either of
 * them having to know the other's shape.
 */
export interface ResolvedScope {
  scope: AgentScope
  /** What to call it in a list, and in the journal. */
  label: string
  workspaces: Workspace[]
  paths: string[]
  /** §6 — whose memory gets prepended, when there is one. */
  featureId: string | null
}

export function resolveScope(scope: AgentScope): ResolvedScope {
  switch (scope.kind) {
    case 'feature': {
      const f = registry.getFeature(scope.featureId)
      if (!f) throw new Error('unknown feature: ' + scope.featureId)
      // Its worktrees, in the order the feature lists them; `group` rows are
      // folders holding the others, not places an engine can be pointed at.
      const workspaces = f.workspaceIds
        .map((id) => registry.getWorkspace(id))
        .filter((w): w is Workspace => !!w && w.kind !== 'group')
      return {
        scope,
        label: f.name,
        workspaces,
        paths: workspaces.map((w) => w.path),
        featureId: f.id,
      }
    }

    case 'project': {
      const p = registry.allProjects().find((x) => x.id === scope.projectId)
      if (!p) throw new Error('unknown project: ' + scope.projectId)
      const all = registry.allWorkspaces(p.id).filter((w) => w.kind !== 'group')
      // "les N chemins de repos" — one per repository, at its main checkout.
      // A project with no main checkout at all (every repo opened as a
      // worktree) still has somewhere to run: the workspaces it does have.
      const mains = all.filter((w) => w.kind === 'main')
      const workspaces = mains.length ? mains : all
      return {
        scope,
        label: p.name,
        workspaces,
        paths: workspaces.map((w) => w.path),
        featureId: null,
      }
    }

    case 'workspace': {
      const w = registry.requireWorkspace(scope.workspaceId)
      return { scope, label: w.name, workspaces: [w], paths: [w.path], featureId: w.featureId }
    }

    case 'folder': {
      const w = registry.requireWorkspace(scope.workspaceId)
      const sub = normaliseSubpath(w.path, scope.subpath)
      return {
        scope,
        label: w.name + '/' + scope.subpath,
        workspaces: [w],
        paths: [sub],
        featureId: w.featureId,
      }
    }
  }
}

/**
 * A subpath is a smaller blast radius, so it must not be usable as a larger
 * one: `..` out of the workspace would hand the engine the whole disk with the
 * lease still reading as one folder.
 */
function normaliseSubpath(root: string, subpath: string): string {
  const abs = resolvePath(join(root, subpath))
  const base = resolvePath(root)
  if (abs !== base && !abs.startsWith(base + '/')) {
    throw new Error('subpath escapes its workspace: ' + subpath)
  }
  return abs
}

/**
 * §7 — what this scope would do, before it is asked to do it.
 *
 * The composer shows it under the prompt, so the two refusals that used to
 * arrive *after* a prompt had been written — an overlapping lease, and a path
 * that turned out to be the main checkout — are visible while there is still
 * something to change about them.
 */
export async function preview(scope: AgentScope): Promise<AgentScopePreview> {
  const r = resolveScope(scope)
  const paths: AgentScopePath[] = []
  const blocked: string[] = []

  for (const [i, w] of r.workspaces.entries()) {
    const path = r.paths[i] ?? w.path
    const branch = w.git?.branch ?? null
    // §4 — allowed, and the reason the caller captures a restore point first.
    const onProtectedBranch = !!w.repo && !!branch && branch === (await defaultBranch(w.path))
    const held = leases.leaseCovering(path)
    // Its own session's lease is not a reason to say a new one cannot start —
    // but any other holder is, and start would refuse on exactly this.
    const leasedBy = held ? held.holder : null
    if (leasedBy) blocked.push(w.name + ' — held by ' + leasedBy)
    paths.push({
      workspaceId: w.id,
      name: w.name,
      path,
      branch,
      kind: w.kind,
      onProtectedBranch,
      leasedBy,
    })
  }

  return {
    scope,
    label: r.label,
    paths,
    blocked,
    preamble: r.featureId
      ? features.preambleParts(r.featureId, r.paths)
      : { memory: false, context: false },
  }
}
