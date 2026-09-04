import { PROTOCOL_VERSION, coreIsBehind, protocolCompatible } from '@cockpit/shared'
import type {
  CockpitEvent, Topic, Project, RpcMethod, RpcParams, RpcResult, ServerMessage, Workspace,
  Conversation,
} from '@cockpit/shared'

/**
 * §13 rule 1 — the renderer has no filesystem, no child processes and no git.
 * Everything it knows arrives through this socket, which is why moving the
 * core to another machine is an address change and not a rewrite.
 */

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  /** Major mismatch: refuse to talk rather than mis-decode. */
  | 'incompatible'
  /** Same major, older minor: usable, but methods added since are missing. */
  | 'outdated'

interface Handlers {
  onProjects(p: Project[]): void
  onTopics(f: Topic[]): void
  onWorkspaces(w: Workspace[]): void
  onAgents(s: Conversation[]): void
  onAgentDelta(sessionId: string, messageId: string, text: string): void
  /** How far into the answer the turn in flight is. See the `agent-progress` push. */
  onAgentProgress(sessionId: string, outputTokens: number): void
  onEvent(e: CockpitEvent): void
  onTerm(termId: string, data: string): void
  onTermExit(termId: string, code: number): void
  /** §8 — a dev server's output, as it is written. See the `runtime-log` push. */
  onRuntimeLog(workspaceId: string | null, procId: string, label: string, chunk: string): void
  onState(state: ConnectionState, detail?: string): void
}

export class CoreClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private retry = 0
  private timer: number | null = null
  private closed = false
  /**
   * Why the last socket was hung up, when it was us who hung it up. A major
   * mismatch closes the socket on purpose, and `onclose` would otherwise
   * overwrite that verdict with "unreachable" a millisecond later — telling
   * you to check whether the service is running when it is running fine and
   * the actual instruction is "restart it".
   */
  private rejected: string | null = null

  constructor(
    private url: string,
    private h: Handlers,
  ) {}

  connect(): void {
    this.closed = false
    this.h.onState('connecting')
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.onmessage = (ev) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage
      } catch {
        return
      }
      if (!('t' in msg)) return

      switch (msg.t) {
        case 'hello':
          // §13 — the version handshake. A major mismatch is a hard stop, not
          // a best-effort degrade: mis-decoding the core is worse than no core.
          if (!protocolCompatible(msg.protocol, PROTOCOL_VERSION)) {
            this.rejected =
              'the service speaks protocol v' + msg.protocol.major +
              ', this window speaks v' + PROTOCOL_VERSION.major +
              '. Restart the service — it is running an older build.'
            this.h.onState('incompatible', this.rejected)
            ws.close()
            return
          }
          this.rejected = null
          this.retry = 0
          // Compatible but incomplete. Saying so here is the difference between
          // "restart your daemon" and hunting a phantom bug in a new topic.
          if (coreIsBehind(msg.protocol, PROTOCOL_VERSION)) {
            this.h.onState(
              'outdated',
              'the core is running an older build (protocol v' +
                msg.protocol.major + '.' + msg.protocol.minor +
                ' against this window\'s v' + PROTOCOL_VERSION.major + '.' + PROTOCOL_VERSION.minor +
                '). Restart it to get the newer commands.',
            )
            break
          }
          this.h.onState('connected')
          break
        case 'res': {
          const p = this.pending.get(msg.id)
          if (!p) break
          this.pending.delete(msg.id)
          if (msg.ok) p.resolve(msg.result)
          else p.reject(new Error(msg.error?.message ?? 'rpc error'))
          break
        }
        case 'projects':
          this.h.onProjects(msg.projects)
          break
        case 'topics':
          this.h.onTopics(msg.topics)
          break
        case 'workspaces':
          this.h.onWorkspaces(msg.workspaces)
          break
        case 'agents':
          this.h.onAgents(msg.sessions)
          break
        case 'agent-delta':
          this.h.onAgentDelta(msg.sessionId, msg.messageId, msg.text)
          break
        case 'agent-progress':
          this.h.onAgentProgress(msg.sessionId, msg.outputTokens)
          break
        case 'event':
          this.h.onEvent(msg.event)
          break
        case 'term':
          this.h.onTerm(msg.termId, msg.data)
          break
        case 'term-exit':
          this.h.onTermExit(msg.termId, msg.code)
          break
        case 'runtime-log':
          this.h.onRuntimeLog(msg.workspaceId, msg.procId, msg.label, msg.chunk)
          break
      }
    }

    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('core disconnected'))
      this.pending.clear()
      if (this.closed) return
      // A socket we closed ourselves keeps its verdict: the banner has to say
      // "restart it", not "it is unreachable". Still retried, but slowly — a
      // restarted service should be picked up without a click.
      if (this.rejected) {
        this.h.onState('incompatible', this.rejected)
        this.timer = window.setTimeout(() => this.connect(), 3000)
        return
      }
      this.h.onState('disconnected')
      // §13 — "état « noyau injoignable » visible dans l'interface avec relance".
      const delay = Math.min(500 * 2 ** this.retry++, 8000)
      this.timer = window.setTimeout(() => this.connect(), delay)
    }

    ws.onerror = () => {
      /* onclose always follows; the retry lives there. */
    }
  }

  /** Manual retry from the disconnected banner. */
  reconnectNow(): void {
    if (this.timer) window.clearTimeout(this.timer)
    this.retry = 0
    this.rejected = null
    try {
      this.ws?.close()
    } catch {
      /* already closed */
    }
    this.connect()
  }

  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    return new Promise((resolve, reject) => {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('core is not connected'))
        return
      }
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      ws.send(JSON.stringify({ t: 'req', id, method, params }))
      window.setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(method + ' timed out'))
        }
      }, 120_000)
    })
  }

  dispose(): void {
    this.closed = true
    if (this.timer) window.clearTimeout(this.timer)
    this.ws?.close()
  }
}
