import { WebSocketServer, WebSocket } from 'ws'
import { PROTOCOL_VERSION } from '@cockpit/shared'
import type { CockpitEvent, RpcRequest, RpcResponse, ServerPush } from '@cockpit/shared'
import { DEFAULT_PORT, loadConfig } from './config.js'
import { bus, countEvents, tail } from './journal.js'
import * as registry from './registry.js'
import * as files from './files.js'
import * as search from './search.js'
import * as diff from './diff.js'
import * as plans from './plans.js'
import * as memory from './memory.js'
import * as leases from './leases.js'
import * as agents from './agents.js'
import * as terminals from './terminals.js'
import * as runtime from './runtime/index.js'
import * as supervisor from './supervisor.js'
import { portMap } from './ports.js'
import { defaultBranch } from './git.js'
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

export function broadcast(msg: ServerPush): void {
  const text = JSON.stringify(msg)
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(text)
  }
}

export function pushWorkspaces(): void {
  broadcast({ t: 'workspaces', workspaces: registry.allWorkspaces() })
}

export function pushAgents(): void {
  broadcast({ t: 'agents', sessions: agents.list() })
}

/** Opens a path in the configured editor / Finder / browser (§2: the cockpit
 *  opens the IDE at the right place, it is not the IDE). */
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

type Handler = (params: never) => unknown | Promise<unknown>

const handlers: Record<string, Handler> = {
  'core.status': () => status(),
  'core.reconcile': async (p: { projectId?: string }) => {
    const changed = await registry.reconcile(p?.projectId)
    pushWorkspaces()
    return { changed }
  },
  'core.shutdown': () => {
    setTimeout(() => process.exit(0), 100)
    return { ok: true }
  },

  'project.list': () => registry.allProjects(),
  'project.add': async (p: { root: string }) => {
    const project = registry.addProject(p.root)
    await registry.reconcile(project.id)
    pushWorkspaces()
    return registry.allProjects().find((x) => x.id === project.id) ?? project
  },
  'project.forget': (p: { projectId: string }) => {
    registry.forgetProject(p.projectId)
    pushWorkspaces()
    return { ok: true }
  },
  'project.rescan': async (p: { projectId: string }) => {
    await registry.reconcile(p.projectId)
    pushWorkspaces()
    return registry.allProjects().find((x) => x.id === p.projectId)
  },
  'project.rename': async (p: { projectId: string; name: string | null }) => {
    const project = registry.renameProject(p.projectId, p.name)
    await registry.reconcile(project.id)
    pushWorkspaces()
    return registry.allProjects().find((x) => x.id === project.id) ?? project
  },
  'project.move': async (p: { projectId: string; root: string; moveFiles: boolean }) => {
    const project = registry.moveProject(p.projectId, p.root, p.moveFiles)
    await registry.reconcile(project.id)
    pushWorkspaces()
    return registry.allProjects().find((x) => x.id === project.id) ?? project
  },
  'project.trash': async (p: { projectId: string }) => {
    const trashed = await registry.trashProject(p.projectId)
    pushWorkspaces()
    return { ok: true, trashed }
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

  'feature.list': (p: { projectId?: string }) => registry.allFeatures(p?.projectId),
  'feature.create': async (p: { projectId: string; name: string; ceremony: string; repos?: string[] }) => {
    // C1 creates a branch, C2/C3 create worktrees. Both go through a plan (§3.7).
    const project = registry.allProjects().find((x) => x.id === p.projectId)
    if (!project) throw new Error('unknown project')
    const mains = registry
      .allWorkspaces(p.projectId)
      .filter((w) => w.kind === 'main' && (!p.repos?.length || p.repos.includes(w.name)))
    const target = mains[0]
    if (!target) throw new Error('no repository in this project')
    const op = p.ceremony === 'C1' ? 'branch' : 'worktree'
    return { plan: await plans.plan(target.id, op, { name: p.name }) }
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

  'git.plan': (p: { workspaceId: string; operation: plans.Operation; args?: Record<string, string> }) =>
    plans.plan(p.workspaceId, p.operation, p.args ?? {}),
  'git.apply': async (p: { planId: string }) => {
    const res = await plans.apply(p.planId)
    await registry.reconcile()
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

  'ports.map': () => portMap(),

  'agent.engines': () => agents.engines(),
  'agent.start': async (p: { engine: string; workspaceIds: string[]; prompt: string }) => {
    const wss = p.workspaceIds.map((id) => registry.requireWorkspace(id))
    const first = wss[0]
    if (!first) throw new Error('no workspace given')
    const protectedBranch = first.repo ? await defaultBranch(first.path) : null
    const res = agents.startAgent({
      engine: p.engine,
      workspaceIds: p.workspaceIds,
      paths: wss.map((w) => w.path),
      prompt: p.prompt,
      protectedBranch,
      currentBranch: first.git?.branch ?? null,
    })
    pushAgents()
    pushWorkspaces()
    return res
  },
  'agent.list': () => agents.list(),
  'agent.stop': (p: { sessionId: string }) => {
    agents.stop(p.sessionId)
    pushAgents()
    return { ok: true }
  },
  'agent.send': (p: { sessionId: string; text: string }) => {
    agents.send(p.sessionId, p.text)
    return { ok: true }
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
    ws.send(JSON.stringify({ t: 'workspaces', workspaces: registry.allWorkspaces() } satisfies ServerPush))

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
        respond({ t: 'res', id: req.id, ok: false, error: { code: 'unknown_method', message: req.method } })
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
  termBus.on('data', ({ termId, data }) => broadcast({ t: 'term', termId, data }))
  termBus.on('exit', ({ termId, code }) => broadcast({ t: 'term-exit', termId, code }))

  return wss
}

export function connectedClients(): number {
  return clients.size
}

export { supervisor }
