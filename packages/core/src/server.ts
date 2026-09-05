import { resolve } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { PROTOCOL_VERSION } from '@cockpit/shared'
import type {
  AgentScope, AttachmentInput, CockpitEvent, CockpitSettings, ConfigView, RpcRequest, RpcResponse,
  ProjectSettings, ServerBoardRow, ServerPush,
} from '@cockpit/shared'
import { DEFAULT_PORT, loadConfig, updateConfig } from './config.js'
import { bus, countEvents, forSession, tail } from './journal.js'
import * as registry from './registry.js'
import * as scaffold from './scaffold.js'
import * as files from './files.js'
import * as search from './search.js'
import * as diff from './diff.js'
import * as plans from './plans.js'
import * as memory from './memory.js'
import * as leases from './leases.js'
import * as agents from './agents.js'
import * as attachments from './attachments.js'
import * as topics from './topics/index.js'
import * as conflict from './conflict.js'
import * as seed from './seed.js'
import * as database from './database.js'
import * as commit from './commit.js'
import * as stash from './stash.js'
import * as terminals from './terminals.js'
import * as runtime from './runtime/index.js'
import * as supervisor from './supervisor.js'
import { portMap } from './ports.js'
import { defaultBranch } from './git.js'
import * as restore from './restore.js'
import * as checkpoints from './checkpoints.js'
import * as scope from './scope.js'
import { readManifest } from './detect.js'
import { run } from './exec.js'
import { termBus } from './terminals.js'

/**
 * §13 — "Transport : WebSocket local, schéma validé. Seule l'adresse change
 * en distant." Nothing below this line knows whether the client is the
 * Electron window, the CLI, or a machine across a network.
 */

const clients = new Set<WebSocket>()
const startedAt = Date.now()

function status() {
  return {
    version: '0.1.0',
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    startedAt,
    journalEvents: countEvents(),
    projects: registry.allProjects().length,
    workspaces: registry.allWorkspaces().length,
    activeLeases: leases.list().length,
    activeProcesses: registry.allWorkspaces().reduce(
      (n, w) => n + (w.runtime?.processes.length ?? 0),
      0,
    ),
  }
}

/** §15 — the machine-local settings, plus what the registry can suggest. */
function configView(): ConfigView {
  const c = loadConfig()
  const settings: CockpitSettings = { devRoot: c.devRoot ?? null, ide: c.ide }
  return { settings, suggestedDevRoot: scaffold.suggestedDevRoot() }
}

export function broadcast(msg: ServerPush): void {
  const text = JSON.stringify(msg)
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(text)
  }
}

export function pushWorkspaces(): void {
  broadcast({ t: 'workspaces', workspaces: registry.allWorkspaces() })
}

/**
 * §3.3 — the UI is a view over what the core pushes, never a source of truth
 * of its own. Without this a window that adds a project sees its own rail go
 * stale, and every other window never learns at all.
 */
export function pushProjects(): void {
  broadcast({ t: 'projects', projects: registry.allProjects() })
}

export function pushTopics(): void {
  broadcast({ t: 'topics', topics: registry.allTopics() })
}

/** Everything derived from the registry, after a change that could move any of it. */
function pushAll(): void {
  pushProjects()
  pushWorkspaces()
  pushTopics()
}

export function pushAgents(): void {
  broadcast({ t: 'agents', sessions: agents.list() })
}

/**
 * A conversation starting, speaking or ending changes two things at once: the
 * session list, and the `lease` / `agentSessions` the workspace rows draw their
 * badges from. Pushing only the first is what made the list say "no agent here"
 * while one was plainly running (§3.3 — the window shows the last push, so the
 * last push has to be complete).
 */
function pushAgentActivity(): void {
  registry.refreshAgentActivity()
  pushAgents()
  pushWorkspaces()
}

/** Opens a path in the configured editor / Finder / browser (§2: the cockpit
 *  opens the IDE at the right place, it is not the IDE). */
/**
 * §11 — every checkout with a runtime, and what it is doing right now.
 *
 * Deliberately across *all* projects rather than the active one: the question
 * this answers is "which of the things I have running is on which port", and
 * that question does not stop at the project boundary — running two topics of
 * two different projects at once is the case the global allocator exists for.
 */
function serverBoard(): ServerBoardRow[] {
  const projects = new Map(registry.allProjects().map((pr) => [pr.id, pr.name]))
  const topics = new Map(registry.allTopics(undefined, true).map((t) => [t.id, t.name]))

  return registry
    .allWorkspaces()
    .filter((w) => w.runtime)
    .map((w) => ({
      workspaceId: w.id,
      workspace: w.name,
      projectId: w.projectId,
      project: projects.get(w.projectId) ?? w.projectId,
      topic: w.topicId ? (topics.get(w.topicId) ?? null) : null,
      branch: w.git?.branch ?? null,
      impl: w.runtime!.impl,
      status: w.runtime!.status,
      url: w.runtime!.preview?.kind === 'url' ? (w.runtime!.preview.value ?? null) : null,
      ports: w.runtime!.ports.map((x) => ({ name: x.name, port: x.port })),
      processes: w.runtime!.processes.length,
    }))
    // Up first, then starting, then the rest: the board is read top-down and
    // what is actually serving is what it is being read for.
    .sort((a, b) => rank(a.status) - rank(b.status) || a.project.localeCompare(b.project))
}

const STATUS_RANK: Record<string, number> = { up: 0, starting: 1, unhealthy: 2, down: 3, unknown: 4 }
const rank = (st: string) => STATUS_RANK[st] ?? 5

async function openIn(workspaceId: string, target: string, path?: string) {
  const ws = registry.requireWorkspace(workspaceId)
  const cfg = loadConfig()
  const full = path ? ws.path + '/' + path : ws.path

  if (target === 'finder') {
    const r = await run('open', [full], { timeoutMs: 10_000 })
    return { ok: r.ok, detail: r.stderr }
  }
  if (target === 'browser') {
    const p = await runtime.preview(ws)
    if (p.kind !== 'url' || !p.value) return { ok: false, detail: 'no preview URL for this workspace' }
    const r = await run('open', [p.value], { timeoutMs: 10_000 })
    return { ok: r.ok, detail: p.value }
  }
  const r = await run(cfg.ide, [full], { timeoutMs: 10_000 })
  if (!r.ok) {
    const fallback = await run('open', ['-a', 'Visual Studio Code', full], { timeoutMs: 10_000 })
    return { ok: fallback.ok, detail: fallback.ok ? '' : 'editor "' + cfg.ide + '" not found on PATH' }
  }
  return { ok: true, detail: '' }
}

/**
 * §5 — `agents.allow` in the manifest, or the built-in set when it is absent.
 *
 * Read as the *tool set* the session is confined to, which is what it always
 * meant — it simply could not be enforced as one until the engine was given a
 * replacement list rather than an addition to its own (§16).
 */
function allowFor(projectId?: string): string[] | undefined {
  if (!projectId) return undefined
  const project = registry.allProjects().find((x) => x.id === projectId)
  if (!project?.manifestPath) return undefined
  const { manifest } = readManifest(project.manifestPath)
  const allow = manifest?.agents?.allow
  return allow?.length ? allow : undefined
}

type Handler = (params: never) => unknown | Promise<unknown>

const handlers: Record<string, Handler> = {
  'core.status': () => status(),
  /**
   * Refresh, and a person pressing it means "go and look now" — so this is the
   * one caller that fetches whatever the throttle says. Pressing it and being
   * told nothing changed, because origin had last been asked 90 seconds ago,
   * is the failure this button exists to not have.
   */
  'core.reconcile': async (p: { projectId?: string }) => {
    const changed = await registry.reconcile(p?.projectId, { fetch: 'force' })
    pushAll()
    return { changed }
  },
  'core.shutdown': () => {
    // Through the signal handler, not straight to process.exit: that is where
    // the terminals get closed and `core.stopping` reaches the journal. A
    // permanent service that vanishes without a trace is a debugging problem.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100)
    return { ok: true }
  },

  'project.list': () => registry.allProjects(),
  'project.add': async (p: { root: string }) => {
    const project = registry.addProject(p.root)
    await registry.reconcile(project.id)
    pushAll()
    return registry.allProjects().find((x) => x.id === project.id) ?? project
  },
  'project.forget': (p: { projectId: string }) => {
    registry.forgetProject(p.projectId)
    pushAll()
    return { ok: true }
  },
  'project.rescan': async (p: { projectId: string }) => {
    await registry.reconcile(p.projectId)
    pushAll()
    return registry.allProjects().find((x) => x.id === p.projectId)
  },
  'project.settings': async (p: { projectId: string; patch: Partial<ProjectSettings> }) => {
    const project = registry.setSettings(p.projectId, p.patch)
    // The base a workspace reports is probed, and a new override only reaches
    // it on the next probe — so a base changed here would have been true in the
    // config and stale on every badge until something else moved.
    await registry.reconcile(project.id)
    pushAll()
    return registry.allProjects().find((x) => x.id === project.id) ?? project
  },
  'project.rename': async (p: { projectId: string; name: string | null }) => {
    const project = registry.renameProject(p.projectId, p.name)
    await registry.reconcile(project.id)
    pushAll()
    return registry.allProjects().find((x) => x.id === project.id) ?? project
  },
  'project.move': async (p: { projectId: string; root: string; moveFiles: boolean }) => {
    const project = registry.moveProject(p.projectId, p.root, p.moveFiles)
    await registry.reconcile(project.id)
    pushAll()
    return registry.allProjects().find((x) => x.id === project.id) ?? project
  },
  'project.trash': async (p: { projectId: string }) => {
    const trashed = await registry.trashProject(p.projectId)
    pushAll()
    return { ok: true, trashed }
  },
  /** §7 — creates the folder layout first, then registers what it created. */
  'project.create': async (p: scaffold.CreateProjectInput) => {
    const project = await scaffold.createProject(p)
    await registry.reconcile(project.id)
    pushAll()
    return registry.allProjects().find((x) => x.id === project.id) ?? project
  },

  /**
   * §7 — the second repository, and every one after it. The layout is kept
   * true after creation, not only at it.
   */
  'project.addRepo': async (p: scaffold.AddRepoInput) => {
    const added = await scaffold.addRepo(p)
    await registry.reconcile(p.projectId)
    pushAll()
    const project = registry.allProjects().find((x) => x.id === p.projectId)
    if (!project) throw new Error('the project went missing while its repository was added')
    return { ...added, project }
  },

  'project.inspect': (p: { path: string }) => scaffold.inspectFolder(p.path),

  'config.get': () => configView(),
  'config.set': (p: Partial<CockpitSettings>) => {
    updateConfig((c) => {
      if ('devRoot' in p) c.devRoot = p.devRoot?.trim() ? resolve(p.devRoot.trim()) : null
      if (p.ide?.trim()) c.ide = p.ide.trim()
    })
    return configView()
  },

  'workspace.list': (p: { projectId?: string }) => registry.allWorkspaces(p?.projectId),
  'workspace.get': (p: { workspaceId: string }) => registry.getWorkspace(p.workspaceId),
  'workspace.probe': async (p: { workspaceId: string }) => {
    const w = await registry.probeWorkspace(p.workspaceId)
    pushWorkspaces()
    return w
  },
  'workspace.openIn': (p: { workspaceId: string; target: string; path?: string }) =>
    openIn(p.workspaceId, p.target, p.path),

  'topic.list': (p: { projectId?: string; includeArchived?: boolean }) =>
    registry.allTopics(p?.projectId, p?.includeArchived ?? false),
  'topic.get': (p: { topicId: string }) => registry.getTopic(p.topicId),
  /** §3.7 — one plan across every repository, applied through `git.apply`. */
  'topic.open': (p: Parameters<typeof topics.openPlan>[0]) => topics.openPlan(p),
  'topic.start': async (p: { topicId: string; force?: boolean }) => {
    const res = await topics.start(p.topicId, p.force ?? false)
    pushWorkspaces()
    pushTopics()
    return res
  },
  'topic.stop': async (p: { topicId: string }) => {
    const res = await topics.stop(p.topicId)
    pushWorkspaces()
    pushTopics()
    return res
  },
  'topic.rename': async (p: { topicId: string; name: string }) => {
    topics.rename(p.topicId, p.name)
    const f = registry.getTopic(p.topicId)
    await registry.reconcile(f?.projectId)
    pushWorkspaces()
    return registry.getTopic(p.topicId)
  },
  'topic.reopen': async (p: { topicId: string }) => {
    const res = topics.reopen(p.topicId)
    const f = registry.getTopic(p.topicId)
    await registry.reconcile(f?.projectId)
    pushAll()
    return res
  },
  'topic.delete': async (p: Parameters<typeof topics.deletePlan>[0]) => {
    const res = await topics.deletePlan(p)
    if (!res.plan) pushAll()
    return res
  },
  /**
   * §7 — what `git worktree add` will not carry, shown before it is carried.
   * Cheap enough to call on every keystroke of the topic name: it stats a
   * handful of root-level files and asks git which of them it tracks.
   */
  'worktree.seedPreview': async (p: {
    projectId: string
    repoWorkspaceIds?: string[]
    slug: string
  }) => {
    const only = p.repoWorkspaceIds?.length ? new Set(p.repoWorkspaceIds) : null
    const repos = registry
      .allWorkspaces(p.projectId)
      .filter((w) => w.kind === 'main' && w.repo && (!only || only.has(w.id)))
    return Promise.all(
      repos.map((w) => seed.propose({ projectId: p.projectId, repoPath: w.path, slug: p.slug })),
    )
  },

  /**
   * §10 — "une base par workspace". Read out of each repository's own `.env`,
   * because that is where the connection already is (§3.5).
   */
  'database.preview': async (p: {
    projectId: string
    repoWorkspaceIds?: string[]
    slug: string
  }) => {
    const only = p.repoWorkspaceIds?.length ? new Set(p.repoWorkspaceIds) : null
    const repos = registry
      .allWorkspaces(p.projectId)
      .filter((w) => w.kind === 'main' && w.repo && (!only || only.has(w.id)))
    const out = []
    for (const w of repos) {
      // Not gated on a full connection: a checkout that names a database
      // without declaring an engine still has one, and `preview` reports it as
      // `unknown` rather than saying nothing at all.
      const baseDb = database.connectionOf(w.path)?.database ?? database.namedDatabase(w.path)
      if (!baseDb) continue
      const target = (
        await seed.contextFor({
          projectId: p.projectId,
          repoPath: w.path,
          slug: p.slug,
          tld: 'test',
          baseDb,
        })
      ).db
      const view = await database.preview(w.path, target)
      if (view) out.push(view)
    }
    return out
  },

  /** §4 — the topic is the unit of work, so catching up is one act. */
  'topic.rebase': (p: { topicId: string; base?: string }) =>
    topics.rebasePlan(p.topicId, p.base),
  /** §4 — and landing it is the act that makes the work count. */
  'topic.merge': (p: { topicId: string; push?: boolean; base?: string }) =>
    topics.mergePlan(p.topicId, { push: p.push, base: p.base }),
  'topic.push': (p: { topicId: string }) => topics.pushPlan(p.topicId),
  'topic.close': async (p: { topicId: string; removeWorktrees: boolean }) => {
    const res = await topics.closePlan(p.topicId, p.removeWorktrees)
    if (!res.plan) {
      const f = registry.getTopic(p.topicId)
      await registry.reconcile(f?.projectId)
      pushWorkspaces()
    }
    return res
  },

  'fs.list': (p: { workspaceId: string; rel: string }) => files.list(p.workspaceId, p.rel),
  'fs.read': (p: { workspaceId: string; rel: string }) => files.read(p.workspaceId, p.rel),
  'fs.write': (p: { workspaceId: string; rel: string; content: string; expectMtimeMs: number | null }) =>
    files.write(p.workspaceId, p.rel, p.content, p.expectMtimeMs),
  'fs.tracked': (p: { workspaceId: string }) => files.tracked(p.workspaceId),

  'search.text': (p: Parameters<typeof search.text>[0]) => search.text(p),

  'diff.files': (p: { workspaceId: string; base?: string }) => diff.files(p.workspaceId, p.base),
  'diff.file': (p: { workspaceId: string; path: string; base?: string }) =>
    diff.file(p.workspaceId, p.path, p.base),

  'git.commitPreview': (p: commit.CommitInput) => commit.preview(p),
  'git.commit': (p: commit.CommitInput) => commit.plan(p),
  /** §16 — a draft for the box, never a commit. See `commit.draftMessage`. */
  'git.draftMessage': (p: commit.DraftInput) => commit.draftMessage(p),

  'git.stashList': (p: stash.StashScope) => stash.list(p),
  'git.stash': (p: stash.StashInput) => stash.plan(p),

  /**
   * §2 — every branch this checkout could be put on. Probed, never cached
   * (§3.4): a branch created in the terminal tab has to appear in the picker
   * the moment it is asked for.
   */
  'git.branches': async (p: { workspaceId: string }) => {
    const ws = registry.requireWorkspace(p.workspaceId)
    if (!ws.repo) return []
    const { listBranches } = await import('./git.js')
    return listBranches(ws.path)
  },
  'git.plan': (p: { workspaceId: string; operation: plans.Operation; args?: Record<string, string> }) =>
    plans.plan(p.workspaceId, p.operation, p.args ?? {}),
  'git.apply': async (p: { planId: string }) => {
    const res = await plans.apply(p.planId)
    await registry.reconcile()
    pushAll()
    return res
  },
  /** §3.7 — re-probed on every call, so a rebase advanced in the terminal tab
   *  and one advanced by the button are the same thing to the window. */
  'git.state': (p: { workspaceId: string }) => conflict.state(p.workspaceId),
  'git.resolve': async (p: { workspaceId: string; action: conflict.ResolveAction }) => {
    const res = await conflict.resolve(p.workspaceId, p.action)
    await registry.probeWorkspace(p.workspaceId)
    pushWorkspaces()
    return res
  },
  'git.stage': async (p: { workspaceId: string; paths: string[] }) => {
    const res = await conflict.stage(p.workspaceId, p.paths)
    await registry.probeWorkspace(p.workspaceId)
    pushWorkspaces()
    return res
  },
  'git.undo': async (p: { workspaceId: string }) => {
    const res = await plans.undo(p.workspaceId)
    await registry.probeWorkspace(p.workspaceId)
    pushWorkspaces()
    return res
  },
  'git.log': async (p: { workspaceId: string; limit?: number }) => {
    const ws = registry.requireWorkspace(p.workspaceId)
    if (!ws.repo) return []
    const { log } = await import('./git.js')
    return log(ws.path, p.limit ?? 40)
  },

  'runtime.up': async (p: { workspaceId: string }) => {
    const ws = registry.requireWorkspace(p.workspaceId)
    const res = await runtime.up(ws)
    await registry.probeWorkspace(p.workspaceId)
    pushWorkspaces()
    return res
  },
  'runtime.down': async (p: { workspaceId: string }) => {
    const ws = registry.requireWorkspace(p.workspaceId)
    const res = await runtime.down(ws)
    await registry.probeWorkspace(p.workspaceId)
    pushWorkspaces()
    return res
  },
  'runtime.health': async (p: { workspaceId: string }) =>
    runtime.health(registry.requireWorkspace(p.workspaceId)),
  'runtime.preview': async (p: { workspaceId: string }) =>
    runtime.preview(registry.requireWorkspace(p.workspaceId)),
  'runtime.logs': (p: { workspaceId: string }) =>
    runtime.logs(registry.requireWorkspace(p.workspaceId)),

  'ports.map': () => portMap(),
  'runtime.board': () => serverBoard(),

  'agent.engines': () => agents.engines(),
  'agent.preview': (p: { scope: AgentScope }) => scope.preview(p.scope),

  'agent.start': async (p: {
    engine: string
    scope?: AgentScope
    workspaceIds?: string[]
    prompt: string
    topicId?: string
    options?: agents.EngineOptions
    attachments?: AttachmentInput[]
  }) => {
    // §7 — the scope says what this is for. A caller that only knows where it
    // is standing may still pass workspaces, and that reads as a workspace
    // scope; more than one of them is a scope nothing can name, so it keeps
    // the first and the rest come along as paths under it.
    const requested: AgentScope =
      p.scope ??
      (p.topicId
        ? { kind: 'topic', topicId: p.topicId }
        : { kind: 'workspace', workspaceId: p.workspaceIds?.[0] ?? '' })
    const r = scope.resolveScope(requested)
    if (!r.paths.length) {
      return { denied: true as const, reason: 'this scope resolves to no path to run in' }
    }

    // §4 — "un point de restauration est capturé avant toute écriture d'agent",
    // and C0 on the main checkout is where there is most to lose. One anchor
    // per repository in scope: a two-repo run that goes wrong needs two.
    const restorePoints: { workspaceId: string; head: string }[] = []
    for (const w of r.workspaces) {
      if (!w.repo) continue
      const rp = await restore.capture(w.id, w.path, 'agent:' + requested.kind + ' — ' + r.label)
      if (rp) restorePoints.push({ workspaceId: w.id, head: rp.head })
    }

    const res = await agents.startAgent({
      engine: p.engine,
      scope: requested,
      workspaceIds: r.workspaces.map((w) => w.id),
      paths: r.paths,
      prompt: p.prompt,
      topicId: r.topicId,
      preamble: r.topicId ? topics.promptPreamble(r.topicId, r.paths) : '',
      // §5 + §16 — the manifest already has a place to widen the allow-list;
      // absent, the built-in one applies.
      allow: allowFor(r.workspaces[0]?.projectId),
      options: p.options,
      attachments: p.attachments,
    })
    pushAgentActivity()
    return 'denied' in res ? res : { ...res, restorePoints }
  },
  'agent.resume': async (p: {
    sessionId: string
    prompt: string
    options?: agents.EngineOptions
    attachments?: AttachmentInput[]
  }) => {
    const prev = agents.get(p.sessionId)
    if (!prev) throw new Error('unknown session: ' + p.sessionId)
    const res = await agents.resumeAgent(
      p.sessionId,
      p.prompt,
      // The memory has moved on since; the conversation has not. Re-reading it
      // is what keeps a resumed session from acting on a stale understanding.
      prev.topicId ? topics.promptPreamble(prev.topicId, prev.paths) : '',
      allowFor(registry.getWorkspace(prev.workspaceIds[0] ?? '')?.projectId),
      p.options,
      p.attachments,
    )
    pushAgentActivity()
    return 'denied' in res ? res : { ...res, restorePoints: [] }
  },
  'agent.attachment': (p: { path: string }) => attachments.readAttachment(p.path),
  'agent.list': () => agents.list(),
  'agent.stop': (p: { sessionId: string }) => {
    agents.stop(p.sessionId)
    pushAgentActivity()
    return { ok: true }
  },
  'agent.delete': (p: { sessionId: string }) => {
    const r = agents.remove(p.sessionId)
    if (r.ok) pushAgentActivity()
    return r
  },
  'agent.send': async (p: {
    sessionId: string
    prompt: string
    attachments?: AttachmentInput[]
  }) => {
    const r = await agents.send(p.sessionId, p.prompt, p.attachments)
    if (r.ok) pushAgentActivity()
    return r
  },
  'agent.unqueue': (p: { sessionId: string; prompt: string }) => {
    const r = agents.unqueue(p.sessionId, p.prompt)
    if (r.ok) pushAgentActivity()
    return r
  },
  /**
   * §3.3 — the transcript, which is the journal filtered by conversation.
   *
   * A whole thread in one call rather than a page at a time: a conversation is
   * read from the top, and paging one would mean deciding what "the top" is
   * before the person has scrolled.
   */
  'agent.transcript': (p: { sessionId: string }) => forSession(p.sessionId),
  /**
   * §3.7 — what reverting to a turn would throw away, before it is thrown.
   */
  'agent.revertPreview': (p: { sessionId: string; turnId: string }) =>
    checkpoints.preview(
      p.sessionId,
      p.turnId,
      (id) => registry.getWorkspace(id)?.name ?? id,
    ),
  /**
   * §16 — the working tree as it stood before that turn, put back.
   *
   * Pushes both the workspaces and the conversation afterwards: the git counts
   * in the list are now wrong by exactly the size of what was undone, and the
   * thread has gained the snapshot that makes this reversible in turn.
   */
  'agent.revert': async (p: { sessionId: string; turnId: string }) => {
    const r = await checkpoints.revert(p.sessionId, p.turnId, 'undo of a turn')
    if (r.ok) {
      pushWorkspaces()
      pushAgentActivity()
    }
    return r
  },

  'memory.read': (p: { workspaceId: string }) => memory.read(p.workspaceId),
  'memory.write': (p: { workspaceId: string; content: string }) => {
    memory.write(p.workspaceId, p.content)
    pushWorkspaces()
    return { ok: true }
  },
  'memory.promote': (p: { workspaceId: string; section: string; text: string }) => {
    memory.promote(p.workspaceId, p.section, p.text)
    pushWorkspaces()
    return { ok: true }
  },
  'memory.sessions': (p: { workspaceId: string }) => memory.sessions(p.workspaceId),

  'journal.tail': (p: { workspaceId?: string; projectId?: string; limit?: number; types?: string[] }) =>
    tail(p ?? {}),

  'lease.list': () => leases.list(),
  'lease.release': (p: { leaseId: string }) => {
    leases.release(p.leaseId)
    pushWorkspaces()
    return { ok: true }
  },

  'terminal.open': (p: { workspaceId: string; cols: number; rows: number; shell?: string }) => ({
    termId: terminals.open(p.workspaceId, p.cols, p.rows, p.shell),
  }),
  'terminal.write': (p: { termId: string; data: string }) => {
    terminals.write(p.termId, p.data)
    return { ok: true }
  },
  'terminal.resize': (p: { termId: string; cols: number; rows: number }) => {
    terminals.resize(p.termId, p.cols, p.rows)
    return { ok: true }
  },
  'terminal.close': (p: { termId: string }) => {
    terminals.close(p.termId)
    return { ok: true }
  },
}

export function startServer(port = DEFAULT_PORT): WebSocketServer {
  const wss = new WebSocketServer({ host: '127.0.0.1', port })

  wss.on('connection', (ws) => {
    clients.add(ws)
    // §13 — version handshake, first message, before anything else.
    const hello: ServerPush = { t: 'hello', protocol: PROTOCOL_VERSION, core: status() }
    ws.send(JSON.stringify(hello))
    ws.send(JSON.stringify({ t: 'projects', projects: registry.allProjects() } satisfies ServerPush))
    ws.send(JSON.stringify({ t: 'workspaces', workspaces: registry.allWorkspaces() } satisfies ServerPush))
    ws.send(JSON.stringify({ t: 'topics', topics: registry.allTopics() } satisfies ServerPush))

    ws.on('message', async (raw) => {
      let req: RpcRequest
      try {
        req = JSON.parse(String(raw)) as RpcRequest
      } catch {
        return
      }
      if (req.t !== 'req') return

      const handler = handlers[req.method]
      const respond = (res: RpcResponse) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res))
      }

      if (!handler) {
        // The bare method name here read as a mystery error in the UI. It has
        // exactly one cause worth naming: a core older than the window.
        respond({
          t: 'res',
          id: req.id,
          ok: false,
          error: {
            code: 'unknown_method',
            message:
              'this core does not implement "' +
              req.method +
              '" — it is an older build than this window. Restart the core (pnpm daemon).',
          },
        })
        return
      }
      try {
        const result = await (handler as (p: unknown) => unknown)(req.params)
        respond({ t: 'res', id: req.id, ok: true, result })
      } catch (e) {
        respond({
          t: 'res',
          id: req.id,
          ok: false,
          error: { code: 'handler_error', message: e instanceof Error ? e.message : String(e) },
        })
      }
    })

    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  // Every journal entry reaches every connected client. The UI is a view over
  // the log, never a separate source of truth (§3.3).
  bus.on('event', (event: CockpitEvent) => broadcast({ t: 'event', event }))
  // §3.3 — a session that ends on its own has to reach the window; nothing
  // else was going to call this until the user happened to click something.
  agents.agentBus.on('changed', () => pushAgentActivity())
  /**
   * §3.3 — deltas are pushed, not journalled, and they are pushed *raw*: a
   * refresh of the whole session list per token would cost more than the text
   * it carries, and would still arrive after it.
   */
  agents.agentBus.on('delta', (sessionId, messageId, text) => {
    broadcast({ t: 'agent-delta', sessionId, messageId, text })
  })
  agents.agentBus.on('progress', (sessionId, outputTokens) => {
    broadcast({ t: 'agent-progress', sessionId, outputTokens })
  })
  /**
   * §8 — a dev server's output reaches the window as it is written, beside the
   * journal rather than through it. Without this the supervisor's ring buffer
   * was write-only and a server that failed to boot said nothing at all.
   */
  supervisor.onOutput(({ procId, workspaceId, label, chunk }) => {
    broadcast({ t: 'runtime-log', workspaceId, procId, label, chunk })
  })
  termBus.on('data', ({ termId, data }) => broadcast({ t: 'term', termId, data }))
  termBus.on('exit', ({ termId, code }) => broadcast({ t: 'term-exit', termId, code }))

  return wss
}

export function connectedClients(): number {
  return clients.size
}

export { supervisor }
