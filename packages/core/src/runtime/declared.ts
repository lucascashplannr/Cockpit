import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { slugify } from '@cockpit/shared'
import type { ManifestV1, ServerDecl, Workspace } from '@cockpit/shared'
import { findManifest, readManifest } from '../detect.js'
import { allocate, portKey } from '../ports.js'
import { allWorkspaces, getProject } from '../registry.js'
import * as topicStore from '../topics/store.js'
import { fill, splitArgs } from './template.js'

/**
 * §8 — the declared model: what runs is written in `cockpit.yaml`, not decided
 * by an adapter.
 *
 * The whole point of this file is that the *same* declaration resolves
 * differently per environment and identically everywhere else. A server's port
 * is allocated against the workspace it will run in, so `servers.web` gets one
 * number in the main checkout and another in every topic, from one line the
 * user wrote once. `{{api.url}}` then reads that table rather than a file.
 *
 * Two properties fall out of allocating before spawning, and both are worth
 * naming because they are what make this simpler than what it replaces:
 *
 * 1. **No start ordering.** `{{api.url}}` is known while `api` is still
 *    booting, so every server of an environment starts in parallel. There is
 *    no dependency graph here and there does not need to be one.
 * 2. **Nothing is written to disk.** The wiring is process environment handed
 *    to the child at spawn, so it is per-run: no file to clean up, no value
 *    left behind in a worktree, nothing to drift.
 */

/**
 * The environment `ws` belongs to: one checkout per repository, as seen from
 * where you pressed Start.
 *
 * Keyed by repository, and `ws` always wins its own, because that is the
 * question being asked: starting the `web` worktree of a topic means *this*
 * web, not the main one — and the two are indistinguishable by topic id alone
 * for a branch worktree, which carries none. Repositories with no checkout of
 * their own here are left out and picked up by the fallback below.
 */
function environmentOf(ws: Workspace): Map<string, Workspace> {
  const byRepo = new Map<string, Workspace>()
  if (ws.repoName) byRepo.set(ws.repoName, ws)
  for (const w of allWorkspaces(ws.projectId)) {
    if (w.kind !== 'main' && w.kind !== 'worktree') continue
    if (!w.repoName || byRepo.has(w.repoName)) continue
    // A topic's environment is its own worktrees; the main checkouts' is the
    // main checkouts. A branch worktree has no topic, so it borrows the mains
    // for every repository but its own — which is what it actually runs against.
    const sameEnvironment = ws.topicId ? w.topicId === ws.topicId : w.kind === 'main' && !w.topicId
    if (sameEnvironment) byRepo.set(w.repoName, w)
  }
  return byRepo
}

function manifestFor(ws: Workspace): ManifestV1 | null {
  const project = getProject(ws.projectId)
  const path = project?.manifestPath ?? (project ? findManifest(project.root) : null)
  return path ? readManifest(path).manifest : null
}

/**
 * Which workspace a declared server runs in, for this environment.
 *
 * The fallback is deliberate and is the answer to "my topic only branches the
 * frontend": a server whose repository has no worktree in this topic resolves
 * to the main checkout, so the branched frontend talks to the unbranched API
 * rather than to nothing. `fellBack` is carried so the window can say so.
 */
function hostFor(
  decl: { repo?: string },
  env: Map<string, Workspace>,
  mains: Workspace[],
  root: Workspace | null,
): { ws: Workspace; fellBack: boolean } | null {
  const wanted = decl.repo ? basename(decl.repo) : null

  // §8 — no `repo:` means the project, and the project has a folder: the one
  // holding the repositories. In a topic that folder is the topic's own, so
  // `start-all` declared once runs across the main checkouts and across each
  // topic's worktrees without naming either.
  if (!wanted) return root ? { ws: root, fellBack: false } : null

  const here = env.get(wanted)
  if (here) return { ws: here, fellBack: false }
  const main = mains.find((w) => w.repoName === wanted)
  return main ? { ws: main, fellBack: true } : null
}

/**
 * The folder a project-level declaration runs in.
 *
 * Inside a topic that is the topic's own folder — the one holding its
 * worktrees and its memory (§7) — because a project-level command asked for
 * from a topic means *this* topic. Outside one it is the project root. A
 * mono-repo whose root is itself the checkout answers with that checkout,
 * which is the same folder by another name.
 */
function rootWorkspaceOf(ws: Workspace): Workspace | null {
  const all = allWorkspaces(ws.projectId)
  if (ws.topicId) {
    const topicRoot = all.find((w) => w.kind === 'group' && w.topicId === ws.topicId)
    if (topicRoot) return topicRoot
  }
  const root = getProject(ws.projectId)?.root
  return all.find((w) => w.path === root) ?? null
}

/**
 * What distinguishes this checkout from every other checkout of the same repo.
 *
 * Per host rather than per environment: starting a branch worktree of the
 * frontend runs the API from the main checkout, and calling both "2fa" would
 * be a lie in whatever the user built out of `{{slug}}` — a database name, a
 * log prefix, a cache key.
 */
function slugOf(ws: Workspace): string {
  const recorded = ws.topicId ? topicStore.get(ws.topicId)?.slug : null
  if (recorded) return recorded
  // An inferred topic carries an id before it carries a record, so a worktree
  // that has not been adopted yet must still answer with something true about
  // itself: its branch, which is where the inferred topic got its name too.
  return ws.kind === 'worktree' ? slugify(ws.name) : 'main'
}

/** §8 — where a declared thing runs, servers and commands alike. */
export function hostWorkspaceFor(
  ws: Workspace,
  repo?: string,
): { ws: Workspace; fellBack: boolean } | null {
  const mains = allWorkspaces(ws.projectId).filter((w) => w.kind === 'main')
  return hostFor(repo ? { repo } : {}, environmentOf(ws), mains, rootWorkspaceOf(ws))
}

/** The placeholders every declared line can use, whatever its lifetime. */
export function baseLookup(ws: Workspace): (key: string) => string | null {
  return (key) => {
    switch (key) {
      case 'repo': return ws.repoName
      case 'slug': return slugOf(ws)
      case 'path': return ws.path
      default: return null
    }
  }
}

export interface ResolvedServer {
  name: string
  /** The workspace it runs in, in this environment. */
  workspaceId: string
  cwd: string
  /** Resolved, ready to spawn. */
  command: string
  args: string[]
  /** The line as a person reads it, for the journal and the log header. */
  cmd: string
  url: string | null
  /** The absolute URL to poll, which is `url` unless `health` narrowed it. */
  probe: string | null
  env: Record<string, string>
  port: number | null
  /** True when its repository has no worktree here and main was used. */
  fellBack: boolean
  /** Placeholders that resolved to nothing; written, never guessed. */
  unresolved: string[]
}

function templatesOf(decl: ServerDecl): string[] {
  return [decl.cmd, decl.url ?? '', ...Object.values(decl.env ?? {})]
}

/**
 * Resolve every server of the environment `ws` belongs to.
 *
 * All of them, not just this workspace's: `{{api.url}}` in the frontend needs
 * the API's number, and that is only knowable by resolving the API too. The
 * caller filters to what it is starting.
 */
export async function resolveEnvironment(ws: Workspace): Promise<ResolvedServer[]> {
  const manifest = manifestFor(ws)
  const declared = manifest?.servers
  if (!declared || !Object.keys(declared).length) return []

  const env = environmentOf(ws)
  const mains = allWorkspaces(ws.projectId).filter((w) => w.kind === 'main')
  const root = rootWorkspaceOf(ws)

  const hosted: { name: string; decl: ServerDecl; ws: Workspace; fellBack: boolean }[] = []
  for (const [name, decl] of Object.entries(declared)) {
    const host = hostFor(decl, env, mains, root)
    if (host) hosted.push({ name, decl, ws: host.ws, fellBack: host.fellBack })
  }

  // 1. Ports first, for everything that asks for one. A server that never
  //    writes `{{port}}` is not given a number: the allocation is persisted,
  //    and handing one to a queue worker would burn it for good.
  const ports = new Map<string, number>()
  for (const h of hosted) {
    if (!templatesOf(h.decl).some((t) => t.includes('{{port}}'))) continue
    ports.set(h.name, await allocate(portKey(h.ws.projectId, h.ws.id, h.name)))
  }

  // 2. Each server's own URL, from its own values only. `url` may not name
  //    another server — that restriction is what makes this one pass instead
  //    of a graph, and it costs nothing anyone has wanted.
  const selfOnly = (h: (typeof hosted)[number]) => (key: string): string | null => {
    switch (key) {
      case 'port': return ports.has(h.name) ? String(ports.get(h.name)) : null
      case 'repo': return h.ws.repoName
      case 'slug': return slugOf(h.ws)
      case 'path': return h.ws.path
      case 'name': return h.name
      default: return null
    }
  }

  const urls = new Map<string, string>()
  for (const h of hosted) {
    if (!h.decl.url) continue
    const { text, missing } = fill(h.decl.url, selfOnly(h))
    if (!missing.length) urls.set(h.name, text)
  }

  // 3. Everything else, with the cross-server table in scope.
  const out: ResolvedServer[] = []
  for (const h of hosted) {
    const lookup = (key: string): string | null => {
      const own = selfOnly(h)(key)
      if (own !== null) return own
      const dot = key.indexOf('.')
      if (dot < 0) return null
      const [other, field] = [key.slice(0, dot), key.slice(dot + 1)]
      if (field === 'url') return urls.get(other) ?? null
      if (field === 'port') return ports.has(other) ? String(ports.get(other)) : null
      return null
    }

    const unresolved: string[] = []
    const cmd = fill(h.decl.cmd, lookup)
    unresolved.push(...cmd.missing)

    const resolvedEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(h.decl.env ?? {})) {
      const r = fill(v, lookup)
      unresolved.push(...r.missing)
      resolvedEnv[k] = r.text
    }

    const url = urls.get(h.name) ?? null
    const argv = splitArgs(cmd.text)
    out.push({
      name: h.name,
      workspaceId: h.ws.id,
      cwd: h.ws.path,
      command: argv[0] ?? '',
      args: argv.slice(1),
      cmd: cmd.text,
      url,
      probe: probeUrl(url, h.decl.health),
      env: resolvedEnv,
      port: ports.get(h.name) ?? null,
      fellBack: h.fellBack,
      unresolved: [...new Set(unresolved)],
    })
  }
  return out
}

/**
 * Every server this workspace itself runs, `start:` or not.
 *
 * `start:` says what *one press* starts, which is a different question from
 * what exists here — and conflating the two is how a server left off the list
 * became unstartable rather than merely not-automatic. This is the list the
 * window offers by name; `serversOf` below is the one press.
 */
export async function hostedServersOf(ws: Workspace): Promise<ResolvedServer[]> {
  const all = await resolveEnvironment(ws)
  return all.filter((s) => s.workspaceId === ws.id)
}

/**
 * Whether one press of Start would start this name — i.e. whether it is on
 * `start:`, an absent list meaning every server (§8).
 */
export function startsOnPress(ws: Workspace): (name: string) => boolean {
  const start = manifestFor(ws)?.start
  const set = start?.length ? new Set(start) : null
  return (name) => !set || set.has(name)
}

/** The servers this workspace itself runs, which is what Start starts. */
export async function serversOf(ws: Workspace): Promise<ResolvedServer[]> {
  const manifest = manifestFor(ws)
  const set = manifest?.start?.length ? new Set(manifest.start) : null
  const hosted = await hostedServersOf(ws)
  return set ? hosted.filter((s) => set.has(s.name)) : hosted
}

function probeUrl(url: string | null, health: string | undefined): string | null {
  if (!health) return url
  if (/^https?:\/\//i.test(health)) return health
  if (!url) return null
  return url.replace(/\/+$/, '') + (health.startsWith('/') ? health : '/' + health)
}

/** Node projects still need their dependencies; nothing else is assumed. */
export function needsInstall(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) && !existsSync(join(dir, 'node_modules'))
}
