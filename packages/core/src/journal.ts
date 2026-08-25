import { EventEmitter } from 'node:events'
import { newId } from '@cockpit/shared'
import type { Actor, CockpitEvent, EventLevel, EventType } from '@cockpit/shared'
import { getDb } from './db.js'

/**
 * §3.3 — the single append-only log the whole system derives from.
 * Nothing in the cockpit writes to the UI directly; it writes an event.
 */
export const bus = new EventEmitter<{ event: [CockpitEvent] }>()
bus.setMaxListeners(200)

export interface AppendInput<T = unknown> {
  type: EventType
  payload: T
  actor?: Actor
  level?: EventLevel
  projectId?: string | null
  workspaceId?: string | null
}

const HUMAN: Actor = { kind: 'human' }

export function append<T>(input: AppendInput<T>): CockpitEvent<T> {
  const db = getDb()
  const id = newId('ev_')
  const ts = Date.now()
  const actor = input.actor ?? HUMAN
  const level = input.level ?? 'info'
  const info = db
    .prepare(
      'INSERT INTO events (id, ts, type, level, actor, project_id, workspace_id, payload) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      ts,
      input.type,
      level,
      JSON.stringify(actor),
      input.projectId ?? null,
      input.workspaceId ?? null,
      JSON.stringify(input.payload ?? null),
    )

  const event: CockpitEvent<T> = {
    seq: Number(info.lastInsertRowid),
    id,
    ts,
    type: input.type,
    level,
    actor,
    projectId: input.projectId ?? null,
    workspaceId: input.workspaceId ?? null,
    payload: input.payload,
  }
  bus.emit('event', event as CockpitEvent)
  return event
}

interface Row {
  seq: number
  id: string
  ts: number
  type: string
  level: string
  actor: string
  project_id: string | null
  workspace_id: string | null
  payload: string
}

function hydrate(r: Row): CockpitEvent {
  return {
    seq: r.seq,
    id: r.id,
    ts: r.ts,
    type: r.type as EventType,
    level: r.level as EventLevel,
    actor: JSON.parse(r.actor) as Actor,
    projectId: r.project_id,
    workspaceId: r.workspace_id,
    payload: JSON.parse(r.payload) as unknown,
  }
}

export function tail(opts: {
  workspaceId?: string
  projectId?: string
  limit?: number
  types?: string[]
}): CockpitEvent[] {
  const db = getDb()
  const where: string[] = []
  const args: unknown[] = []
  if (opts.workspaceId) {
    where.push('workspace_id = ?')
    args.push(opts.workspaceId)
  }
  if (opts.projectId) {
    where.push('project_id = ?')
    args.push(opts.projectId)
  }
  if (opts.types?.length) {
    where.push('type IN (' + opts.types.map(() => '?').join(',') + ')')
    args.push(...opts.types)
  }
  const limit = Math.min(opts.limit ?? 200, 2000)
  const sql =
    'SELECT * FROM events' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY seq DESC LIMIT ?'
  args.push(limit)
  const rows = db.prepare(sql).all(...args) as Row[]
  return rows.map(hydrate).reverse()
}

export function countEvents(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
  return row.n
}

/**
 * §12 — records who last touched a path so the diff can be split
 * human / agent. Written by the file watcher and by the agent runner.
 */
export function recordTouch(
  workspaceId: string,
  path: string,
  actor: Actor,
  sessionId?: string,
): void {
  getDb()
    .prepare('INSERT INTO touches (workspace_id, path, actor, session_id, ts) VALUES (?,?,?,?,?)')
    .run(workspaceId, path, actor.kind, sessionId ?? null, Date.now())
}

export function attributionFor(workspaceId: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (!paths.length) return out
  const db = getDb()
  const q = db.prepare(
    'SELECT path, actor, COUNT(*) AS n FROM touches WHERE workspace_id = ? AND path = ? GROUP BY actor',
  )
  for (const p of paths) {
    const rows = q.all(workspaceId, p) as { path: string; actor: string; n: number }[]
    if (!rows.length) {
      out.set(p, 'unknown')
      continue
    }
    const kinds = new Set(rows.map((r) => r.actor))
    if (kinds.size > 1) out.set(p, 'mixed')
    else out.set(p, kinds.has('agent') ? 'agent' : 'human')
  }
  return out
}
