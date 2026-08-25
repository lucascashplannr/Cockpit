import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { newId } from '@cockpit/shared'
import type { AgentSession } from '@cockpit/shared'
import { getDb } from './db.js'
import { append, recordTouch } from './journal.js'
import { which } from './exec.js'
import * as leases from './leases.js'

/**
 * §7 — a session is a list of PATHS + an engine + a mode + a lease.
 * Never "a feature". That is what makes it work identically in C0 and C3.
 *
 * §16 — scope confined, command allow-list, never a push, never the main
 * branch, human diff review before any commit, cost displayed.
 */

export interface EngineSpec {
  id: string
  bin: string
  /** Non-interactive mode with structured output (§7, multi-moteurs). */
  buildArgs(prompt: string): string[]
  parse(line: string): NormalizedEvent | null
}

export interface NormalizedEvent {
  kind: 'text' | 'tool' | 'cost' | 'end' | 'error'
  text?: string
  tool?: string
  paths?: string[]
  costUsd?: number
}

function safeJson(line: string): Record<string, unknown> | null {
  const t = line.trim()
  if (!t.startsWith('{')) return null
  try {
    return JSON.parse(t) as Record<string, unknown>
  } catch {
    return null
  }
}

const claudeEngine: EngineSpec = {
  id: 'claude',
  bin: 'claude',
  buildArgs: (prompt) => ['-p', prompt, '--output-format', 'stream-json', '--verbose'],
  parse(line) {
    const o = safeJson(line)
    if (!o) return null
    const type = String(o.type ?? '')
    if (type === 'assistant') {
      const msg = o.message as { content?: { type: string; text?: string; name?: string; input?: unknown }[] }
      const parts = msg?.content ?? []
      const text = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('')
      const tool = parts.find((p) => p.type === 'tool_use')
      if (tool) {
        const input = (tool.input ?? {}) as Record<string, unknown>
        const p = typeof input.file_path === 'string' ? [input.file_path] : []
        return { kind: 'tool', tool: tool.name ?? 'tool', paths: p, text }
      }
      return text ? { kind: 'text', text } : null
    }
    if (type === 'result') {
      return { kind: 'end', costUsd: Number(o.total_cost_usd ?? 0), text: String(o.result ?? '') }
    }
    return null
  },
}

const codexEngine: EngineSpec = {
  id: 'codex',
  bin: 'codex',
  buildArgs: (prompt) => ['exec', '--json', prompt],
  parse(line) {
    const o = safeJson(line)
    if (!o) return null
    const type = String(o.type ?? o.msg ?? '')
    if (type.includes('message') || type === 'agent_message') {
      const text = String((o.message as string) ?? (o.text as string) ?? '')
      return text ? { kind: 'text', text } : null
    }
    if (type.includes('tool') || type.includes('exec')) {
      return { kind: 'tool', tool: String(o.name ?? 'exec') }
    }
    if (type.includes('complete') || type === 'task_complete') {
      return { kind: 'end', costUsd: Number(o.cost_usd ?? 0) }
    }
    return null
  },
}

const ENGINES: Record<string, EngineSpec> = { claude: claudeEngine, codex: codexEngine }

export async function engines(): Promise<{ id: string; available: boolean; bin: string }[]> {
  const out: { id: string; available: boolean; bin: string }[] = []
  for (const e of Object.values(ENGINES)) {
    const path = await which(e.bin)
    out.push({ id: e.id, available: !!path, bin: path ?? e.bin })
  }
  return out
}

interface Live {
  session: AgentSession
  child: ChildProcess
  buffer: string
}

const live = new Map<string, Live>()

function persist(s: AgentSession): void {
  getDb()
    .prepare(
      `INSERT INTO agent_sessions (id, engine, paths, workspace_ids, status, started_at, ended_at, cost_usd, turns, lease_id, last_message)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, ended_at=excluded.ended_at,
         cost_usd=excluded.cost_usd, turns=excluded.turns, last_message=excluded.last_message`,
    )
    .run(
      s.id,
      s.engine,
      JSON.stringify(s.paths),
      JSON.stringify(s.workspaceIds),
      s.status,
      s.startedAt,
      s.endedAt,
      s.costUsd,
      s.turns,
      s.leaseId,
      s.lastMessage,
    )
}

export function list(): AgentSession[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT 100')
    .all() as Record<string, unknown>[]
  return rows.map((r) => ({
    id: String(r.id),
    engine: String(r.engine),
    paths: JSON.parse(String(r.paths)) as string[],
    workspaceIds: JSON.parse(String(r.workspace_ids)) as string[],
    status: String(r.status) as AgentSession['status'],
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    costUsd: Number(r.cost_usd),
    turns: Number(r.turns),
    leaseId: r.lease_id === null ? null : String(r.lease_id),
    lastMessage: r.last_message === null ? null : String(r.last_message),
  }))
}

export function sessionsTouching(path: string): AgentSession[] {
  const p = resolve(path)
  return list().filter(
    (s) =>
      s.status !== 'ended' &&
      s.status !== 'failed' &&
      s.paths.some((sp) => p === sp || p.startsWith(sp + '/') || sp.startsWith(p + '/')),
  )
}

export interface StartAgentInput {
  engine: string
  workspaceIds: string[]
  paths: string[]
  prompt: string
  /** Branch the agent must never touch (§7, "jamais sur la branche principale"). */
  protectedBranch?: string | null
  currentBranch?: string | null
}

export type StartAgentResult = { sessionId: string } | { denied: true; reason: string }

export function startAgent(input: StartAgentInput): StartAgentResult {
  const spec = ENGINES[input.engine]
  if (!spec) return { denied: true, reason: 'unknown engine: ' + input.engine }

  // §7 — never on the main branch, at any ceremony level.
  if (
    input.protectedBranch &&
    input.currentBranch &&
    input.protectedBranch === input.currentBranch
  ) {
    return {
      denied: true,
      reason:
        'refusing to run an agent on the protected branch "' +
        input.protectedBranch +
        '". Create a branch first (C1) or pick another workspace.',
    }
  }

  // §7 — the lease is what makes two overlapping agents impossible.
  const lease = leases.acquire({
    holder: 'agent:' + input.engine,
    paths: input.paths,
    reason: input.prompt.slice(0, 120),
    ttlMs: 6 * 3600_000,
  })
  if (!lease.ok || !lease.lease) {
    return {
      denied: true,
      reason:
        'scope overlaps an active lease held by ' +
        (lease.conflict?.lease.holder ?? 'another session') +
        ' on ' +
        (lease.conflict?.path ?? '?'),
    }
  }

  const session: AgentSession = {
    id: newId('agent_'),
    engine: input.engine,
    workspaceIds: input.workspaceIds,
    paths: input.paths.map((p) => resolve(p)),
    status: 'starting',
    startedAt: Date.now(),
    endedAt: null,
    costUsd: 0,
    turns: 0,
    leaseId: lease.lease.id,
    lastMessage: null,
  }
  persist(session)

  const cwd = session.paths[0]!
  const child = spawn(spec.bin, spec.buildArgs(input.prompt), {
    cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const actor = { kind: 'agent' as const, engine: input.engine, sessionId: session.id }
  append({
    type: 'agent.session_started',
    actor,
    workspaceId: input.workspaceIds[0] ?? null,
    payload: { engine: input.engine, paths: session.paths, prompt: input.prompt.slice(0, 500) },
  })

  const l: Live = { session, child, buffer: '' }
  live.set(session.id, l)
  session.status = 'thinking'
  persist(session)

  const handleLine = (line: string) => {
    const ev = spec.parse(line)
    if (!ev) return
    if (ev.kind === 'text' && ev.text) {
      session.turns++
      session.lastMessage = ev.text.slice(0, 400)
      append({ type: 'agent.output', actor, workspaceId: input.workspaceIds[0] ?? null, payload: { text: ev.text } })
    } else if (ev.kind === 'tool') {
      append({
        type: 'agent.tool_use',
        actor,
        workspaceId: input.workspaceIds[0] ?? null,
        payload: { tool: ev.tool, paths: ev.paths ?? [] },
      })
      // §12 — attribution: this is what makes the diff splittable later.
      for (const p of ev.paths ?? []) {
        for (const wsId of input.workspaceIds) recordTouch(wsId, relativeTo(cwd, p), actor, session.id)
      }
    } else if (ev.kind === 'end') {
      session.costUsd = ev.costUsd ?? session.costUsd
      session.status = 'idle'
      append({ type: 'agent.cost', actor, payload: { costUsd: session.costUsd, turns: session.turns } })
    }
    persist(session)
  }

  const onData = (chunk: Buffer) => {
    l.buffer += chunk.toString('utf8')
    const lines = l.buffer.split('\n')
    l.buffer = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) handleLine(line)
  }

  child.stdout?.on('data', onData)
  child.stderr?.on('data', (c: Buffer) => {
    append({ type: 'agent.output', level: 'warn', actor, payload: { text: c.toString('utf8').slice(0, 2000) } })
  })

  child.on('close', (code) => {
    live.delete(session.id)
    session.status = code === 0 ? 'ended' : 'failed'
    session.endedAt = Date.now()
    persist(session)
    if (session.leaseId) leases.release(session.leaseId)
    append({
      type: 'agent.session_ended',
      level: code === 0 ? 'info' : 'error',
      actor,
      payload: { code, costUsd: session.costUsd, turns: session.turns },
    })
  })

  return { sessionId: session.id }
}

function relativeTo(root: string, p: string): string {
  const a = resolve(root)
  const b = resolve(p)
  return b.startsWith(a + '/') ? b.slice(a.length + 1) : b
}

export function stop(sessionId: string): void {
  const l = live.get(sessionId)
  if (l) {
    l.child.kill('SIGTERM')
    return
  }
  // Not live: still release the lease so a crashed core does not wedge a path.
  const s = list().find((x) => x.id === sessionId)
  if (s?.leaseId) leases.release(s.leaseId)
}

export function send(sessionId: string, text: string): void {
  const l = live.get(sessionId)
  l?.child.stdin?.write(text.endsWith('\n') ? text : text + '\n')
}

/** Sessions cannot survive the core; mark them dead at boot. */
export function reapSessions(): void {
  getDb()
    .prepare("UPDATE agent_sessions SET status = 'ended', ended_at = ? WHERE status IN ('starting','thinking','idle')")
    .run(Date.now())
}
