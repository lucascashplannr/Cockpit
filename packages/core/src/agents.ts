import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { newId } from '@cockpit/shared'
import type { AgentScope, AgentSession, AgentTurn } from '@cockpit/shared'
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

/**
 * §16 — "périmètre confiné, liste blanche de commandes, jamais de push".
 *
 * Passed to every launch. Without it the engine runs in its default
 * non-interactive posture, which for `claude -p` means every file write waits
 * for an approval that has nowhere to arrive from — so the agent reports that
 * it needs permission and the session ends having changed nothing.
 */
export interface LaunchContext {
  /**
   * §7 — the other repositories in scope. The engine runs in `paths[0]`; every
   * other path has to be handed to it explicitly or a multi-repo session can
   * see exactly one of its repositories.
   */
  extraDirs: string[]
  /** The command allow-list. Anything outside it is refused, never silently run. */
  allow: string[]
}

export interface EngineSpec {
  id: string
  bin: string
  /** Non-interactive mode with structured output (§7, multi-moteurs). */
  buildArgs(prompt: string, ctx: LaunchContext): string[]
  /**
   * §6 — the same conversation, picked back up. Without this a session cannot
   * outlive the daemon, and "work on it over several days" is a fiction: every
   * morning would start from an empty context against a stale memory.
   */
  buildResumeArgs(prompt: string, engineSessionId: string, ctx: LaunchContext): string[]
  parse(line: string): NormalizedEvent | null
}

/**
 * What an agent may do without being asked, when the project does not say.
 *
 * Edits and searches, yes — that is the job. Shell, only the git commands that
 * read: `status`, `diff`, `log`, `show`. Not `commit`, because §16 wants the
 * diff seen by a human first; not `push`, because §16 forbids it outright; not
 * a package manager, because an install is a change to the machine and not to
 * the branch. A project widens this in `cockpit.yaml` under `agents.allow`.
 */
export const DEFAULT_ALLOW = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'NotebookEdit',
  'TodoWrite',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
]

export interface NormalizedEvent {
  kind: 'text' | 'tool' | 'cost' | 'end' | 'error'
  text?: string
  tool?: string
  paths?: string[]
  costUsd?: number
}

/**
 * Both engines announce their own session id on their own event shape; neither
 * is worth a parser branch, because the field name is the only difference.
 */
function engineSessionIdIn(line: string): string | null {
  const o = safeJson(line)
  if (!o) return null
  for (const key of ['session_id', 'sessionId', 'thread_id', 'threadId', 'conversation_id']) {
    const v = o[key]
    if (typeof v === 'string' && v) return v
  }
  return null
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

/** Shared by start and resume, so the two cannot drift apart on permissions. */
function claudeCommon(ctx: LaunchContext): string[] {
  return [
    '--output-format', 'stream-json',
    '--verbose',
    // Without this every Edit waits for an approval that cannot arrive: `-p`
    // has no prompt to answer on, so the write is declined and the session
    // ends having done nothing but explain that it could not.
    '--permission-mode', 'acceptEdits',
    // Comma-joined into one argument on purpose. The flag is variadic, so
    // space-separated values would swallow the flag that follows them.
    '--allowedTools', ctx.allow.join(','),
    ...ctx.extraDirs.flatMap((d) => ['--add-dir', d]),
  ]
}

const claudeEngine: EngineSpec = {
  id: 'claude',
  bin: 'claude',
  buildArgs: (prompt, ctx) => ['-p', prompt, ...claudeCommon(ctx)],
  buildResumeArgs: (prompt, id, ctx) => ['-p', prompt, ...claudeCommon(ctx), '--resume', id],
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

/**
 * Codex takes no allow-list here. Its approval flags were not verified against
 * a real binary — it is not installed on the machine this was written on — and
 * guessing a permission flag is how an agent ends up either blocked or
 * unsandboxed. `extraDirs` is likewise unhandled: `codex exec` is given one
 * directory. Both are marked rather than faked.
 */
const codexEngine: EngineSpec = {
  id: 'codex',
  bin: 'codex',
  buildArgs: (prompt) => ['exec', '--json', prompt],
  buildResumeArgs: (prompt, id) => ['exec', 'resume', id, '--json', prompt],
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

/**
 * §3.3 — the window is a view over what the core pushes, so a session that
 * ends has to say so. It used to persist the new status and stop there, and
 * `pushAgents` was only ever called from the RPC handlers — so a session that
 * finished on its own left the panel reading "thinking" until something else
 * happened to refresh it. An emitter rather than a direct call because
 * `server.ts` already imports this module.
 */
export const agentBus = new EventEmitter<{ changed: [] }>()
agentBus.setMaxListeners(50)

function persist(s: AgentSession): void {
  getDb()
    .prepare(
      `INSERT INTO agent_sessions (id, engine, paths, workspace_ids, status, started_at, ended_at, cost_usd, turns, lease_id, last_message, feature_id, engine_session_id, prompt, scope_kind, scope_id, scope_subpath, title)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, ended_at=excluded.ended_at,
         cost_usd=excluded.cost_usd, turns=excluded.turns, last_message=excluded.last_message,
         lease_id=excluded.lease_id, engine_session_id=excluded.engine_session_id,
         prompt=excluded.prompt`,
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
      s.featureId,
      s.engineSessionId,
      s.prompt,
      s.scope.kind,
      scopeId(s.scope),
      s.scope.kind === 'folder' ? s.scope.subpath : null,
      // Frozen at turn 1: `prompt` moves with the conversation, this does not.
      s.title,
    )
}

function scopeId(scope: AgentScope): string {
  switch (scope.kind) {
    case 'feature':
      return scope.featureId
    case 'project':
      return scope.projectId
    default:
      return scope.workspaceId
  }
}

function readScope(r: Record<string, unknown>): AgentScope {
  const id = String(r.scope_id ?? '')
  switch (String(r.scope_kind ?? 'workspace')) {
    case 'feature':
      return { kind: 'feature', featureId: id }
    case 'project':
      return { kind: 'project', projectId: id }
    case 'folder':
      return { kind: 'folder', workspaceId: id, subpath: String(r.scope_subpath ?? '') }
    default:
      return { kind: 'workspace', workspaceId: id }
  }
}

/* ── the conversation (§6) ───────────────────────────────────────────────
 * Append-only. `agent.resume` used to overwrite the session's single `prompt`
 * column, which destroyed the opening question the first time work was picked
 * back up — the exact state in which a session can no longer be told apart
 * from any other in the list.
 */

export function turnsOf(sessionId: string): AgentTurn[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_turns WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: String(r.id),
    seq: Number(r.seq),
    prompt: String(r.prompt),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    costUsd: Number(r.cost_usd ?? 0),
    status: String(r.status) as AgentTurn['status'],
  }))
}

function openTurn(sessionId: string, prompt: string): void {
  const seq =
    Number(
      (
        getDb()
          .prepare('SELECT MAX(seq) AS n FROM agent_turns WHERE session_id = ?')
          .get(sessionId) as { n: number | null }
      ).n ?? 0,
    ) + 1
  getDb()
    .prepare(
      'INSERT INTO agent_turns (id, session_id, seq, prompt, started_at, ended_at, cost_usd, status) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(newId('turn_'), sessionId, seq, prompt, Date.now(), null, 0, 'running')
}

/** The cost of a turn is what the session gained while it was the open one. */
function closeTurn(sessionId: string, status: AgentTurn['status'], costUsd: number): void {
  const row = getDb()
    .prepare("SELECT id FROM agent_turns WHERE session_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1")
    .get(sessionId) as { id: string } | undefined
  if (!row) return
  getDb()
    .prepare('UPDATE agent_turns SET ended_at = ?, status = ?, cost_usd = ? WHERE id = ?')
    .run(Date.now(), status, costUsd, row.id)
}

function hydrate(r: Record<string, unknown>): AgentSession {
  const engineSessionId = r.engine_session_id == null ? null : String(r.engine_session_id)
  const status = String(r.status) as AgentSession['status']
  return {
    id: String(r.id),
    engine: String(r.engine),
    paths: JSON.parse(String(r.paths)) as string[],
    workspaceIds: JSON.parse(String(r.workspace_ids)) as string[],
    status,
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    costUsd: Number(r.cost_usd),
    turns: Number(r.turns),
    leaseId: r.lease_id === null ? null : String(r.lease_id),
    lastMessage: r.last_message === null ? null : String(r.last_message),
    featureId: r.feature_id == null ? null : String(r.feature_id),
    engineSessionId,
    // §6 — an ended session is not a dead one. As long as the engine still
    // holds the conversation, picking it back up tomorrow is one click.
    resumable: !!engineSessionId && (status === 'ended' || status === 'failed'),
    prompt: r.prompt == null ? '' : String(r.prompt),
    scope: readScope(r),
    title: r.title == null || String(r.title) === '' ? String(r.prompt ?? '') : String(r.title),
    history: turnsOf(String(r.id)),
  }
}

export function list(): AgentSession[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT 100')
    .all() as Record<string, unknown>[]
  return rows.map(hydrate)
}

export function get(sessionId: string): AgentSession | null {
  const row = getDb().prepare('SELECT * FROM agent_sessions WHERE id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined
  return row ? hydrate(row) : null
}

/** §7 — cost per feature, so it stays visible where the work accumulates. */
export function listForFeature(featureId: string): AgentSession[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_sessions WHERE feature_id = ? ORDER BY started_at DESC')
    .all(featureId) as Record<string, unknown>[]
  return rows.map(hydrate)
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
  /** §7 — what the session is for. `paths` is this, resolved by the caller. */
  scope: AgentScope
  workspaceIds: string[]
  paths: string[]
  prompt: string
  /** §4 — the feature this session belongs to, when it belongs to one. */
  featureId?: string | null
  /**
   * §7 — the feature memory and cross-repo context, prepended to the prompt.
   * Kept out of `prompt` so the list shows what the user actually asked.
   */
  preamble?: string
  /** §16 — the project's own allow-list, from `agents.allow`. Defaults apply. */
  allow?: string[]
}

export type StartAgentResult = { sessionId: string } | { denied: true; reason: string }

/**
 * §4 — the main checkout is a workspace of full standing, not a degraded case,
 * and "yolo sur le checkout principal" is the first row of §7's scope table.
 * So this no longer refuses there: what §4 actually requires of C0 is that the
 * traceability is not relaxed, and the caller captures a restore point on every
 * repository in scope before this is reached. The refusals that remain are the
 * ones that protect something a restore point cannot: an overlapping lease,
 * and an engine that is not installed.
 */
export function startAgent(input: StartAgentInput): StartAgentResult {
  const spec = ENGINES[input.engine]
  if (!spec) return { denied: true, reason: 'unknown engine: ' + input.engine }

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
    leaseId: null,
    lastMessage: null,
    featureId: input.featureId ?? null,
    engineSessionId: null,
    resumable: false,
    prompt: input.prompt,
    scope: input.scope,
    title: input.prompt.slice(0, 200),
    history: [],
  }

  return launch(session, spec, (input.preamble ?? '') + input.prompt, false, input.allow)
}

/**
 * §6 — "vider devient gratuit : la conversation part, la mémoire reste."
 * Resuming is the other half: the conversation is still there, and the memory
 * has moved on since. Both are one call away, which is the whole point.
 */
export function resumeAgent(
  sessionId: string,
  prompt: string,
  preamble = '',
  allow?: string[],
): StartAgentResult {
  const prev = get(sessionId)
  if (!prev) return { denied: true, reason: 'unknown session: ' + sessionId }
  if (!prev.engineSessionId) {
    return {
      denied: true,
      reason:
        'this session predates resume support, or the engine never announced an id — start a fresh one against the same memory instead',
    }
  }
  if (live.has(sessionId)) return { denied: true, reason: 'that session is already running' }

  const spec = ENGINES[prev.engine]
  if (!spec) return { denied: true, reason: 'unknown engine: ' + prev.engine }

  // `prompt` is the turn in flight; `title` is turn 1 and never moves. Before
  // turns existed this line was the whole bug: it overwrote the only record of
  // what the conversation had originally been asked to do.
  const session: AgentSession = {
    ...prev,
    status: 'starting',
    endedAt: null,
    leaseId: null,
    lastMessage: null,
    prompt,
  }
  return launch(session, spec, preamble + prompt, true, allow)
}

function launch(
  session: AgentSession,
  spec: EngineSpec,
  fullPrompt: string,
  resuming: boolean,
  allow?: string[],
): StartAgentResult {
  // §7 — the lease is what makes two overlapping agents impossible. It is taken
  // on paths, so a feature-wide session and a repo session inside it collide
  // exactly as they should.
  const lease = leases.acquire({
    holder: 'agent:' + session.engine,
    paths: session.paths,
    reason: session.prompt.slice(0, 120),
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
  session.leaseId = lease.lease.id
  persist(session)
  // After persist: the turn references the session row (§6).
  openTurn(session.id, session.prompt)

  const cwd = session.paths[0]!
  // §7 — the engine runs in the first path; the rest have to be handed over
  // explicitly, or a two-repo scope reaches exactly one repository.
  const ctx: LaunchContext = {
    extraDirs: session.paths.slice(1),
    allow: allow?.length ? allow : DEFAULT_ALLOW,
  }
  const args = resuming
    ? spec.buildResumeArgs(fullPrompt, session.engineSessionId!, ctx)
    : spec.buildArgs(fullPrompt, ctx)
  const child = spawn(spec.bin, args, {
    cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // Both engines are one-shot: the prompt is an argument, and neither reads
  // stdin. Leaving it open costs `claude -p` a three-second wait and a warning
  // on every single launch while it hopes for piped input that never comes.
  child.stdin?.end()

  const actor = { kind: 'agent' as const, engine: session.engine, sessionId: session.id }
  const workspaceId = session.workspaceIds[0] ?? null
  append({
    type: resuming ? 'agent.session_resumed' : 'agent.session_started',
    actor,
    workspaceId,
    payload: {
      engine: session.engine,
      paths: session.paths,
      featureId: session.featureId,
      prompt: session.prompt.slice(0, 500),
      ...(resuming ? { engineSessionId: session.engineSessionId } : {}),
    },
  })

  const l: Live = { session, child, buffer: '' }
  live.set(session.id, l)
  session.status = 'thinking'
  persist(session)

  const handleLine = (line: string) => {
    // Captured before parsing: the id arrives on an init event neither parser
    // cares about, and without it the session dies with this process.
    if (!session.engineSessionId) {
      const eid = engineSessionIdIn(line)
      if (eid) {
        session.engineSessionId = eid
        persist(session)
      }
    }

    const ev = spec.parse(line)
    if (!ev) return
    if (ev.kind === 'text' && ev.text) {
      session.turns++
      session.lastMessage = ev.text.slice(0, 400)
      append({ type: 'agent.output', actor, workspaceId, payload: { text: ev.text } })
    } else if (ev.kind === 'tool') {
      append({
        type: 'agent.tool_use',
        actor,
        workspaceId,
        payload: { tool: ev.tool, paths: ev.paths ?? [] },
      })
      // §12 — attribution: this is what makes the diff splittable later.
      for (const p of ev.paths ?? []) {
        for (const wsId of session.workspaceIds) recordTouch(wsId, relativeTo(cwd, p), actor, session.id)
      }
    } else if (ev.kind === 'end') {
      session.costUsd += ev.costUsd ?? 0
      session.status = 'idle'
      append({ type: 'agent.cost', actor, payload: { costUsd: session.costUsd, turns: session.turns } })
    }
    persist(session)
    agentBus.emit('changed')
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

  const costAtStart = session.costUsd

  child.on('close', (code) => {
    live.delete(session.id)
    session.status = code === 0 ? 'ended' : 'failed'
    session.endedAt = Date.now()
    persist(session)
    // What this turn cost is what the session gained while it was the open one.
    closeTurn(session.id, code === 0 ? 'done' : 'failed', session.costUsd - costAtStart)
    if (session.leaseId) leases.release(session.leaseId)
    append({
      type: 'agent.session_ended',
      level: code === 0 ? 'info' : 'error',
      actor,
      payload: {
        code,
        costUsd: session.costUsd,
        turns: session.turns,
        resumable: !!session.engineSessionId,
      },
    })
    agentBus.emit('changed')
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

/**
 * Both engines are invoked one-shot, with the prompt as an argument, and their
 * stdin is closed at launch. There is no running conversation to write into —
 * the way to say something more is `resumeAgent`, which is what §6 means by
 * the session being disposable and the conversation not.
 */
export function send(sessionId: string): { ok: false; reason: string } {
  return {
    ok: false,
    reason: live.has(sessionId)
      ? 'this engine is running one-shot and does not read stdin; wait for it to finish and resume the session'
      : 'no such live session',
  }
}

/**
 * A child process cannot survive the core, so nothing is left running at boot.
 * The conversation is another matter: `engine_session_id` stays, and that is
 * what makes yesterday's session resumable rather than merely readable (§6).
 */
export function reapSessions(): void {
  const now = Date.now()
  getDb()
    .prepare("UPDATE agent_sessions SET status = 'ended', ended_at = ? WHERE status IN ('starting','thinking','idle')")
    .run(now)
  // Its process died with the core; a turn that still reads "running" would
  // make the conversation look live forever.
  getDb()
    .prepare("UPDATE agent_turns SET status = 'done', ended_at = ? WHERE status = 'running'")
    .run(now)
}
