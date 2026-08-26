import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { newId } from '@cockpit/shared'
import type { SupervisedProcess } from '@cockpit/shared'
import { getDb } from './db.js'
import { append } from './journal.js'

/**
 * §13 rule 2 — dev servers and agents outlive the window. The supervisor owns
 * them; the UI only ever asks about them.
 * §16 — a persistent registry of processes and ports, reaped at boot.
 */

interface Managed {
  id: string
  child: ChildProcess
  label: string
  workspaceId: string | null
  ring: string[]
}

const live = new Map<string, Managed>()
const RING_MAX = 500

export interface StartOptions {
  workspaceId: string | null
  label: string
  cwd: string
  command: string
  args: string[]
  env?: Record<string, string>
}

export function start(opts: StartOptions): SupervisedProcess {
  const id = newId('proc_')
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, FORCE_COLOR: '1' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const managed: Managed = { id, child, label: opts.label, workspaceId: opts.workspaceId, ring: [] }
  live.set(id, managed)

  const record = (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    managed.ring.push(text)
    if (managed.ring.length > RING_MAX) managed.ring.shift()
    append({
      type: 'runtime.log',
      level: 'debug',
      actor: { kind: 'system' },
      workspaceId: opts.workspaceId,
      payload: { procId: id, label: opts.label, chunk: text.slice(0, 4000) },
    })
  }
  child.stdout?.on('data', record)
  child.stderr?.on('data', record)

  const db = getDb()
  db.prepare(
    'INSERT INTO processes (id, workspace_id, label, pid, cwd, command, started_at, status, exit_code) VALUES (?,?,?,?,?,?,?,?,NULL)',
  ).run(
    id,
    opts.workspaceId,
    opts.label,
    child.pid ?? null,
    opts.cwd,
    [opts.command, ...opts.args].join(' '),
    Date.now(),
    'running',
  )

  append({
    type: 'process.spawned',
    actor: { kind: 'system' },
    workspaceId: opts.workspaceId,
    payload: { id, label: opts.label, pid: child.pid, command: opts.command, cwd: opts.cwd },
  })

  child.on('exit', (code) => {
    live.delete(id)
    getDb().prepare('UPDATE processes SET status = ?, exit_code = ? WHERE id = ?').run(
      code === 0 ? 'exited' : 'failed',
      code ?? -1,
      id,
    )
    append({
      type: 'process.exited',
      level: code === 0 ? 'info' : 'warn',
      actor: { kind: 'system' },
      workspaceId: opts.workspaceId,
      payload: { id, label: opts.label, code },
    })
  })

  return {
    id,
    label: opts.label,
    pid: child.pid ?? null,
    status: 'running',
    startedAt: Date.now(),
    exitCode: null,
    cwd: opts.cwd,
  }
}

export function stop(id: string): boolean {
  const m = live.get(id)
  if (m) {
    killTree(m.child.pid)
    return true
  }
  return stopAdopted([id]) > 0
}

/** §16 — "Arrêt par groupe": every process attached to a workspace at once. */
export function stopWorkspace(workspaceId: string): number {
  let n = 0
  const own = new Set<string>()
  for (const m of [...live.values()]) {
    if (m.workspaceId === workspaceId) {
      own.add(m.id)
      killTree(m.child.pid)
      n++
    }
  }

  // §13 — a process started by a PREVIOUS core is adopted at boot, so it is in
  // the table but not in `live`. Stopping only what this core spawned left it
  // running and unstoppable: the port stayed bound, health kept reporting up,
  // and a parked feature went on holding a resource nobody could release.
  const rows = getDb()
    .prepare("SELECT id FROM processes WHERE workspace_id = ? AND status = 'running'")
    .all(workspaceId) as { id: string }[]
  n += stopAdopted(rows.map((r) => r.id).filter((id) => !own.has(id)))
  return n
}

/** Kills by recorded pid and settles the row; the child emits no exit here. */
function stopAdopted(ids: string[]): number {
  if (!ids.length) return 0
  const db = getDb()
  let n = 0
  for (const id of ids) {
    const row = db.prepare('SELECT pid, workspace_id, label FROM processes WHERE id = ?').get(id) as
      | { pid: number | null; workspace_id: string | null; label: string }
      | undefined
    if (!row) continue
    if (isAlive(row.pid)) {
      killTree(row.pid ?? undefined)
      n++
    }
    db.prepare("UPDATE processes SET status = 'exited', exit_code = -1 WHERE id = ?").run(id)
    append({
      type: 'process.exited',
      level: 'info',
      actor: { kind: 'system' },
      workspaceId: row.workspace_id,
      payload: { id, label: row.label, code: null, adopted: true },
    })
  }
  return n
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    // Negative pid targets the detached process group, so a `npm run dev`
    // wrapper does not leave the real server behind.
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

export function listForWorkspace(workspaceId: string): SupervisedProcess[] {
  const rows = getDb()
    .prepare("SELECT * FROM processes WHERE workspace_id = ? AND status = 'running' ORDER BY started_at DESC")
    .all(workspaceId) as {
    id: string
    label: string
    pid: number | null
    started_at: number
    cwd: string
    status: string
    exit_code: number | null
  }[]
  return rows
    .filter((r) => live.has(r.id) || isAlive(r.pid))
    .map((r) => ({
      id: r.id,
      label: r.label,
      pid: r.pid,
      status: 'running' as const,
      startedAt: r.started_at,
      exitCode: null,
      cwd: r.cwd,
    }))
}

export function logsFor(procId: string): string {
  return live.get(procId)?.ring.join('') ?? ''
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * §13 — "nettoyage des process orphelins au démarrage". Anything the previous
 * core started that is no longer alive is marked dead; anything still alive is
 * adopted rather than duplicated.
 */
export function reapOrphans(): { reaped: number; adopted: number } {
  const db = getDb()
  const rows = db.prepare("SELECT id, pid FROM processes WHERE status = 'running'").all() as {
    id: string
    pid: number | null
  }[]
  let reaped = 0
  let adopted = 0
  for (const r of rows) {
    if (isAlive(r.pid)) {
      adopted++
    } else {
      db.prepare("UPDATE processes SET status = 'exited', exit_code = -1 WHERE id = ?").run(r.id)
      reaped++
    }
  }
  if (reaped || adopted) {
    append({ type: 'core.orphan_reaped', actor: { kind: 'system' }, payload: { reaped, adopted } })
  }
  return { reaped, adopted }
}

export function shutdownAll(): void {
  for (const m of [...live.values()]) killTree(m.child.pid)
}
