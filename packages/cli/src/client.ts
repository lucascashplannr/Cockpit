import WebSocket from 'ws'
import { PROTOCOL_VERSION, protocolCompatible } from '@cockpit/shared'
import type { RpcMethod, RpcParams, RpcResult, ServerMessage } from '@cockpit/shared'

/**
 * §3.2 — "Le noyau est un outil en ligne de commande ; l'interface n'est
 * qu'un client." This client and the renderer's speak the same protocol; the
 * only difference is which WebSocket implementation they hold.
 */
export class CoreClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(private url: string) {}

  connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      const timer = setTimeout(() => reject(new Error('timed out connecting to ' + this.url)), timeoutMs)

      ws.on('open', () => undefined)
      ws.on('error', (e) => {
        clearTimeout(timer)
        reject(new Error('core unreachable at ' + this.url + ' (' + String(e) + ')'))
      })
      ws.on('message', (raw) => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(String(raw)) as ServerMessage
        } catch {
          return
        }
        if ('t' in msg && msg.t === 'hello') {
          clearTimeout(timer)
          // §13 — version handshake before anything is trusted.
          if (!protocolCompatible(msg.protocol, PROTOCOL_VERSION)) {
            reject(
              new Error(
                'protocol mismatch: core speaks v' + msg.protocol.major + ', cli speaks v' + PROTOCOL_VERSION.major,
              ),
            )
            return
          }
          resolve()
          return
        }
        if ('t' in msg && msg.t === 'res') {
          const p = this.pending.get(msg.id)
          if (!p) return
          this.pending.delete(msg.id)
          if (msg.ok) p.resolve(msg.result)
          else p.reject(new Error(msg.error?.message ?? 'rpc error'))
        }
      })
      ws.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('connection closed'))
        this.pending.clear()
      })
    })
  }

  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    return new Promise((resolve, reject) => {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'))
        return
      }
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      ws.send(JSON.stringify({ t: 'req', id, method, params }))
    })
  }

  close(): void {
    this.ws?.close()
  }
}
