import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { newId } from '@cockpit/shared'
import type { AgentScope, Conversation, AgentTurn } from '@cockpit/shared'
import { getDb } from './db.js'
import { append, recordTouch } from './journal.js'
import { which } from './exec.js'
import * as leases from './leases.js'

/**
 * §7 — a session is a list of PATHS + an engine + a mode + a lease.
 * Never "a topic". That is what makes it work identically in C0 and C3.
 *
 * §16 — scope confined, command allow-list, never a push, never the main
 * branch, human diff review before any commit.
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
  /**
   * §16 — "périmètre confiné", in the only form the engine actually enforces.
   *
   * This was an allow-list, and an allow-list does not confine: the flag it
   * was passed to is additive, so naming four tools left every other one
   * exactly as available as before. A session meant to read could still shell
   * out. Naming the set *outright* is what holds — the tools left out are not
   * refused at the call, they are absent from the list the model is given, and
   * it never reaches for them.
   */
  tools: string[]
  /**
   * §16 — "jamais de push", and no commit before a person has seen the diff.
   *
   * Command-level, and genuinely enforced: a call matching one of these is
   * refused as it is made and reported on the turn. This is the guard-rail
   * that has to hold even when the tool itself is allowed, because `Bash` is
   * one tool and `git push` is one command.
   */
  deny: string[]
  /**
   * Which model, and how hard it is asked to think. Both are the engine's own
   * flags; neither is persisted on the conversation, because the window is
   * where the choice is made and remembered — passing it on resume as well
   * keeps a thread on the model it was started with without a schema change.
   */
  model?: string
  effort?: string
  /**
   * §3.7 — "toute opération affiche son plan avant de s'exécuter", applied to
   * the agent itself: plan mode reads and proposes, and writes nothing.
   */
  plan?: boolean
}

/**
 * What an agent can reach when the project does not say otherwise.
 *
 * Editing, searching, and running commands — the job. `Bash` is in the set
 * because an agent that cannot run the test suite is a worse tool than the
 * terminal it replaces; what keeps it inside §16 is `DEFAULT_DENY`, not its
 * absence. A project narrows or widens this in `cockpit.yaml` under
 * `agents.allow`.
 */
export const DEFAULT_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'NotebookEdit',
  'TodoWrite',
  'Bash',
]

/**
 * §16's red lines. Push, because the doc forbids it outright. Commit, because
 * §7 requires the diff to be seen by a person first, and an agent that commits
 * its own work has taken that decision away.
 *
 * Refused at the call rather than hidden from the model: it is told no, and
 * the turn carries what it asked for, so the thread can say which line was
 * crossed instead of merely that something was.
 */
export const DEFAULT_DENY = ['Bash(git push:*)', 'Bash(git commit:*)']

/**
 * The historical name. `agents.allow` in a manifest is read as the tool set,
 * because that is what it was always meant to be — it simply could not be
 * enforced as one.
 */
export const DEFAULT_ALLOW = DEFAULT_TOOLS

export interface NormalizedEvent {
  kind: 'ready' | 'message_start' | 'delta' | 'text' | 'tool' | 'tool_result' | 'end' | 'error'
  /** `delta` / `text`: what was written. `end`: the closing message. */
  text?: string
  /** Which message this belongs to, so two in flight cannot be merged (§3.3). */
  messageId?: string
  /** `tool` / `tool_result`: what pairs a call with what it did. */
  toolUseId?: string
  tool?: string
  /** The tool's own arguments, whole. */
  input?: Record<string, unknown>
  paths?: string[]
  stdout?: string
  stderr?: string
  isError?: boolean
  interrupted?: boolean
  /** `end` only: the invocations §16 refused during this turn. */
  denials?: string[]
}

export interface EngineSpec {
  id: string
  bin: string
  /**
   * §6 — whether one process serves the whole conversation.
   *
   * A one-shot engine is spawned per turn with the prompt as an argument and
   * its stdin closed, so nothing can be said to it until it has finished. A
   * streaming engine is spawned once and holds its stdin open; every later
   * turn is a line written into it. That is what makes queueing the next
   * question — and watching the answer form — possible at all.
   */
  streaming: boolean
  /**
   * The process's arguments. For a streaming engine the prompt is *not* among
   * them: it goes over stdin through `encodeTurn`. It is still passed here so
   * that a one-shot engine can keep the same signature.
   */
  buildArgs(prompt: string, ctx: LaunchContext): string[]
  /**
   * §6 — the same conversation, picked back up. Without this a session cannot
   * outlive the daemon, and "work on it over several days" is a fiction: every
   * morning would start from an empty context against a stale memory.
   */
  buildResumeArgs(prompt: string, engineSessionId: string, ctx: LaunchContext): string[]
  /** Streaming engines: one turn, as the line to write on stdin. */
  encodeTurn?(prompt: string): string
  /** One line of output, as the zero or more things that happened in it. */
  parse(line: string): NormalizedEvent[]
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

/** The files a call names, for §12's human/agent attribution on the diff. */
function pathsIn(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = input[key]
    if (typeof v === 'string' && v) out.push(v)
  }
  return out
}

/** Shared by start and resume, so the two cannot drift apart on permissions. */
function claudeCommon(ctx: LaunchContext): string[] {
  return [
    '--output-format', 'stream-json',
    '--verbose',
    // The turn is watched as it is written rather than reported once it is
    // over. Without this a three-minute turn is a spinner followed by a wall
    // of text, which is the whole of what made this feel like a batch job.
    '--include-partial-messages',
    // §16 — the tool set, replaced rather than added to. Comma-joined into one
    // argument on purpose: the flag is variadic, so space-separated values
    // would swallow the flag that follows them.
    '--tools', ctx.tools.join(','),
    ...(ctx.deny.length ? ['--disallowedTools', ctx.deny.join(',')] : []),
    // Edits do not wait for an approval that has nowhere to arrive: print mode
    // has no prompt to answer on. What keeps that honest is that the tool set
    // above is now a boundary rather than a suggestion.
    // §3.7 — plan mode reads and proposes without writing, which is the one
    // posture where an agent on the main checkout costs nothing to be wrong.
    '--permission-mode', ctx.plan ? 'plan' : 'acceptEdits',
    ...(ctx.model ? ['--model', ctx.model] : []),
    ...(ctx.effort ? ['--effort', ctx.effort] : []),
    ...ctx.extraDirs.flatMap((d) => ['--add-dir', d]),
  ]
}

const claudeEngine: EngineSpec = {
  id: 'claude',
  bin: 'claude',
  streaming: true,
  buildArgs: (_prompt, ctx) => ['-p', '--input-format', 'stream-json', ...claudeCommon(ctx)],
  buildResumeArgs: (_prompt, id, ctx) => [
    '-p', '--input-format', 'stream-json', ...claudeCommon(ctx), '--resume', id,
  ],
  encodeTurn: (prompt) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }),
  parse(line) {
    const o = safeJson(line)
    if (!o) return []
    const type = String(o.type ?? '')

    if (type === 'system' && o.subtype === 'init') return [{ kind: 'ready' }]

    if (type === 'stream_event') {
      const ev = o.event as
        | { type?: string; message?: { id?: string }; delta?: { type?: string; text?: string } }
        | undefined
      // A delta carries no message id of its own, so the one opened here is
      // what the driver hangs the next run of tokens on.
      if (ev?.type === 'message_start')
        return [{ kind: 'message_start', messageId: String(ev.message?.id ?? '') }]
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text)
        return [{ kind: 'delta', text: ev.delta.text }]
      return []
    }

    if (type === 'assistant') {
      const msg = o.message as
        | { id?: string; content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[] }
        | undefined
      const messageId = String(msg?.id ?? '')
      const out: NormalizedEvent[] = []
      // Every block, not the first one that matches: an assistant message
      // routinely carries a sentence and two calls, and returning one of them
      // is how a transcript loses half of what happened.
      for (const p of msg?.content ?? []) {
        if (p.type === 'text' && p.text) out.push({ kind: 'text', text: p.text, messageId })
        else if (p.type === 'tool_use') {
          const input = (p.input ?? {}) as Record<string, unknown>
          out.push({
            kind: 'tool',
            toolUseId: String(p.id ?? ''),
            tool: p.name ?? 'tool',
            input,
            paths: pathsIn(input),
          })
        }
      }
      return out
    }

    // A tool's outcome comes back as a user message carrying the result
    // blocks, with the raw stdout and stderr beside them.
    if (type === 'user') {
      const content = (o.message as { content?: unknown })?.content
      if (!Array.isArray(content)) return []
      const r = o.tool_use_result as
        | { stdout?: string; stderr?: string; interrupted?: boolean }
        | undefined
      const out: NormalizedEvent[] = []
      for (const b of content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
        if (b?.type !== 'tool_result') continue
        out.push({
          kind: 'tool_result',
          toolUseId: String(b.tool_use_id ?? ''),
          stdout: String(r?.stdout ?? (typeof b.content === 'string' ? b.content : '')),
          stderr: String(r?.stderr ?? ''),
          isError: !!b.is_error,
          interrupted: !!r?.interrupted,
        })
      }
      return out
    }

    // In a streaming session this fires at the end of every *turn*, not of the
    // process — which is exactly the boundary a turn should be closed on.
    if (type === 'result') {
      return [{ kind: 'end', text: String(o.result ?? ''), denials: denialsIn(o) }]
    }
    return []
  },
}

/**
 * `claude` reports every refused call on its result event, as
 * `permission_denials: [{ tool_name, tool_use_id, tool_input }]`. Read
 * defensively: an engine that does not send the field is not an error, it
 * simply has nothing to say about permission.
 *
 * The command is kept, not just the tool name. "Bash was refused" says nothing
 * a person can act on; "git push" says exactly which of §16's lines it crossed.
 */
function denialsIn(o: Record<string, unknown>): string[] {
  const raw = o.permission_denials
  if (!Array.isArray(raw)) return []
  const names = raw.map((d) => {
    const e = d as { tool_name?: unknown; name?: unknown; tool_input?: Record<string, unknown> }
    const tool = String(e?.tool_name ?? e?.name ?? 'tool')
    const cmd = e?.tool_input?.command
    return typeof cmd === 'string' && cmd ? tool + '(' + cmd.slice(0, 120) + ')' : tool
  })
  return [...new Set(names)]
}

/**
 * Codex takes no tool set here. Its approval flags were not verified against a
 * real binary — it is not installed on the machine this was written on — and
 * guessing a permission flag is how an agent ends up either blocked or
 * unsandboxed. `extraDirs` is likewise unhandled: `codex exec` is given one
 * directory. Both are marked rather than faked, and it stays one-shot: writing
 * turns into the stdin of a process that does not read it would hang the
 * conversation rather than fail it.
 */
const codexEngine: EngineSpec = {
  id: 'codex',
  bin: 'codex',
  streaming: false,
  buildArgs: (prompt) => ['exec', '--json', prompt],
  buildResumeArgs: (prompt, id) => ['exec', 'resume', id, '--json', prompt],
  parse(line) {
    const o = safeJson(line)
    if (!o) return []
    const type = String(o.type ?? o.msg ?? '')
    if (type.includes('message') || type === 'agent_message') {
      const text = String((o.message as string) ?? (o.text as string) ?? '')
      return text ? [{ kind: 'text', text }] : []
    }
    if (type.includes('tool') || type.includes('exec')) {
      return [{ kind: 'tool', tool: String(o.name ?? 'exec'), input: {}, paths: [] }]
    }
    if (type.includes('complete') || type === 'task_complete') return [{ kind: 'end' }]
    return []
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
  session: Conversation
  spec: EngineSpec
  child: ChildProcess
  buffer: string
  /** Where the tokens arriving right now belong (§3.3). */
  streamingId: string | null
  /**
   * §6 — the questions asked while it was still answering the last one.
   *
   * Typing the next thing before the current turn lands is the normal way to
   * work; refusing it was the reason the composer had to grey itself out. A
   * streaming engine reads one turn at a time, so they wait here and go in as
   * each turn closes.
   */
  queue: string[]
  /** A turn is in flight: the next one queues instead of being written. */
  busy: boolean
  /** What a tool was called with, kept until its result comes back. */
  calls: Map<string, { tool: string; input: Record<string, unknown> }>
  /** §6 — the countdown to letting the process go. See `armIdleTimer`. */
  idle: NodeJS.Timeout | null
}

/**
 * §6 — "la session est jetable, la conversation ne l'est pas."
 *
 * A streaming engine only exits when its stdin closes, so left alone it would
 * hold a process and — far worse — a §7 lease on its paths for as long as the
 * core is up. One conversation answered and walked away from would lock its
 * repository against every other session indefinitely.
 *
 * So an idle conversation is let go: stdin closes, the process exits, the lease
 * is released. Nothing is lost, because the engine's own session id is
 * persisted — the next turn is a `--resume` and reads as the same thread. What
 * is disposable is the process; the conversation outlives it.
 */
const IDLE_MS = 5 * 60_000

function armIdleTimer(l: Live): void {
  clearIdleTimer(l)
  l.idle = setTimeout(() => {
    if (l.busy || l.queue.length) return
    l.child.stdin?.end()
  }, IDLE_MS)
  // Never a reason to hold the core open by itself.
  l.idle.unref?.()
}

function clearIdleTimer(l: Live): void {
  if (l.idle) clearTimeout(l.idle)
  l.idle = null
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
export const agentBus = new EventEmitter<{
  changed: []
  /**
   * §3.3 — beside the journal, never in it. A token is not something that
   * happened; the message it ends up in is. Carried as
   * `(sessionId, messageId, text)` so the window can hang a run of tokens on
   * the right message and throw the lot away when the real one arrives.
   */
  delta: [sessionId: string, messageId: string, text: string]
}>()
agentBus.setMaxListeners(50)

function persist(s: Conversation): void {
  getDb()
    .prepare(
      `INSERT INTO agent_sessions (id, engine, paths, workspace_ids, status, started_at, ended_at, turns, lease_id, last_message, topic_id, engine_session_id, prompt, scope_kind, scope_id, scope_subpath, title, denials)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, ended_at=excluded.ended_at,
         turns=excluded.turns, last_message=excluded.last_message,
         lease_id=excluded.lease_id, engine_session_id=excluded.engine_session_id,
         prompt=excluded.prompt, denials=excluded.denials`,
    )
    .run(
      s.id,
      s.engine,
      JSON.stringify(s.paths),
      JSON.stringify(s.workspaceIds),
      s.status,
      s.startedAt,
      s.endedAt,
      s.turns,
      s.leaseId,
      s.lastMessage,
      s.topicId,
      s.engineSessionId,
      s.prompt,
      s.scope.kind,
      scopeId(s.scope),
      s.scope.kind === 'folder' ? s.scope.subpath : null,
      // Frozen at turn 1: `prompt` moves with the conversation, this does not.
      s.title,
      JSON.stringify(s.denials),
    )
}

function scopeId(scope: AgentScope): string {
  switch (scope.kind) {
    case 'topic':
      return scope.topicId
    case 'project':
      return scope.projectId
    default:
      return scope.workspaceId
  }
}

function readScope(r: Record<string, unknown>): AgentScope {
  const id = String(r.scope_id ?? '')
  switch (String(r.scope_kind ?? 'workspace')) {
    case 'topic':
      return { kind: 'topic', topicId: id }
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
      'INSERT INTO agent_turns (id, session_id, seq, prompt, started_at, ended_at, status) VALUES (?,?,?,?,?,?,?)',
    )
    .run(newId('turn_'), sessionId, seq, prompt, Date.now(), null, 'running')
}

function closeTurn(sessionId: string, status: AgentTurn['status']): void {
  const row = getDb()
    .prepare("SELECT id FROM agent_turns WHERE session_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1")
    .get(sessionId) as { id: string } | undefined
  if (!row) return
  getDb()
    .prepare('UPDATE agent_turns SET ended_at = ?, status = ? WHERE id = ?')
    .run(Date.now(), status, row.id)
}

function readDenials(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return []
  try {
    const a = JSON.parse(v) as unknown
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}

function hydrate(r: Record<string, unknown>): Conversation {
  const engineSessionId = r.engine_session_id == null ? null : String(r.engine_session_id)
  const status = String(r.status) as Conversation['status']
  return {
    id: String(r.id),
    engine: String(r.engine),
    paths: JSON.parse(String(r.paths)) as string[],
    workspaceIds: JSON.parse(String(r.workspace_ids)) as string[],
    status,
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    turns: Number(r.turns),
    leaseId: r.lease_id === null ? null : String(r.lease_id),
    lastMessage: r.last_message === null ? null : String(r.last_message),
    topicId: r.topic_id == null ? null : String(r.topic_id),
    engineSessionId,
    // §6 — an ended session is not a dead one. As long as the engine still
    // holds the conversation, picking it back up tomorrow is one click.
    resumable: !!engineSessionId && (status === 'ended' || status === 'failed'),
    prompt: r.prompt == null ? '' : String(r.prompt),
    scope: readScope(r),
    title: r.title == null || String(r.title) === '' ? String(r.prompt ?? '') : String(r.title),
    history: turnsOf(String(r.id)),
    denials: readDenials(r.denials),
    // Live only, and correctly empty for a conversation whose process is gone.
    queued: queuedIn(String(r.id)),
  }
}

export function list(): Conversation[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT 100')
    .all() as Record<string, unknown>[]
  return rows.map(hydrate)
}

export function get(sessionId: string): Conversation | null {
  const row = getDb().prepare('SELECT * FROM agent_sessions WHERE id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined
  return row ? hydrate(row) : null
}

/** §7 — cost per topic, so it stays visible where the work accumulates. */
export function listForTopic(topicId: string): Conversation[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_sessions WHERE topic_id = ? ORDER BY started_at DESC')
    .all(topicId) as Record<string, unknown>[]
  return rows.map(hydrate)
}

/** Every conversation whose process is still up — the ones a badge is about. */
export function liveSessions(): Conversation[] {
  return list().filter((s) => s.status !== 'ended' && s.status !== 'failed')
}

/** Whether a session's scope and a path overlap, either way round. */
export function covers(session: Conversation, path: string): boolean {
  const p = resolve(path)
  return session.paths.some((sp) => p === sp || p.startsWith(sp + '/') || sp.startsWith(p + '/'))
}

export function sessionsTouching(path: string): Conversation[] {
  return liveSessions().filter((s) => covers(s, path))
}

export interface StartAgentInput {
  engine: string
  /** §7 — what the session is for. `paths` is this, resolved by the caller. */
  scope: AgentScope
  workspaceIds: string[]
  paths: string[]
  prompt: string
  /** §4 — the topic this session belongs to, when it belongs to one. */
  topicId?: string | null
  /**
   * §7 — the topic memory and cross-repo context, prepended to the prompt.
   * Kept out of `prompt` so the list shows what the user actually asked.
   */
  preamble?: string
  /** §16 — the project's own tool set, from `agents.allow`. Defaults apply. */
  allow?: string[]
  /** Model, effort and plan mode, as chosen in the composer. */
  options?: EngineOptions
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

  const session: Conversation = {
    id: newId('agent_'),
    engine: input.engine,
    workspaceIds: input.workspaceIds,
    paths: input.paths.map((p) => resolve(p)),
    status: 'starting',
    startedAt: Date.now(),
    endedAt: null,
    turns: 0,
    leaseId: null,
    lastMessage: null,
    topicId: input.topicId ?? null,
    engineSessionId: null,
    resumable: false,
    prompt: input.prompt,
    scope: input.scope,
    title: input.prompt.slice(0, 200),
    history: [],
    denials: [],
    queued: [],
  }

  return launch(session, spec, (input.preamble ?? '') + input.prompt, false, input.allow, input.options)
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
  opts?: EngineOptions,
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
  // §6 — a live streaming conversation is not something to relaunch: the
  // process is right there with its stdin open, and the next question is a
  // line written into it. Relaunching would fork the conversation in two and
  // collide with its own lease.
  const running = live.get(sessionId)
  if (running) {
    if (running.spec.streaming && running.spec.encodeTurn) {
      const r = send(sessionId, prompt)
      return r.ok ? { sessionId } : { denied: true, reason: r.reason }
    }
    return { denied: true, reason: 'that conversation is already running' }
  }

  const spec = ENGINES[prev.engine]
  if (!spec) return { denied: true, reason: 'unknown engine: ' + prev.engine }

  // `prompt` is the turn in flight; `title` is turn 1 and never moves. Before
  // turns existed this line was the whole bug: it overwrote the only record of
  // what the conversation had originally been asked to do.
  const session: Conversation = {
    ...prev,
    status: 'starting',
    endedAt: null,
    leaseId: null,
    lastMessage: null,
    prompt,
    // The refusals belong to a turn, not to the conversation: carrying the
    // last one's forward would leave the thread flagged for help it has
    // already been given.
    denials: [],
  }
  return launch(session, spec, preamble + prompt, true, allow, opts)
}

/** How the engine is asked to run, chosen per conversation by the window. */
export interface EngineOptions {
  model?: string
  effort?: string
  plan?: boolean
}

function launch(
  session: Conversation,
  spec: EngineSpec,
  fullPrompt: string,
  resuming: boolean,
  allow?: string[],
  opts?: EngineOptions,
): StartAgentResult {
  // §7 — the lease is what makes two overlapping agents impossible. It is taken
  // on paths, so a topic-wide session and a repo session inside it collide
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
    tools: allow?.length ? allow : DEFAULT_TOOLS,
    deny: DEFAULT_DENY,
    model: opts?.model,
    effort: opts?.effort,
    plan: opts?.plan,
  }
  const args = resuming
    ? spec.buildResumeArgs(fullPrompt, session.engineSessionId!, ctx)
    : spec.buildArgs(fullPrompt, ctx)
  const child = spawn(spec.bin, args, {
    cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const l: Live = {
    session,
    spec,
    child,
    buffer: '',
    streamingId: null,
    queue: [],
    busy: true,
    calls: new Map(),
    idle: null,
  }
  live.set(session.id, l)

  if (spec.streaming && spec.encodeTurn) {
    // The process serves the whole conversation, so its stdin stays open: it
    // is the channel every later turn arrives on.
    child.stdin?.write(spec.encodeTurn(fullPrompt) + '\n')
  } else {
    // One-shot: the prompt was an argument. Leaving stdin open costs `claude
    // -p` a three-second wait and a warning on every launch while it hopes for
    // piped input that never comes.
    child.stdin?.end()
  }

  const actor = { kind: 'agent' as const, engine: session.engine, sessionId: session.id }
  const workspaceId = session.workspaceIds[0] ?? null
  append({
    type: resuming ? 'agent.session_resumed' : 'agent.session_started',
    actor,
    workspaceId,
    payload: {
      engine: session.engine,
      paths: session.paths,
      topicId: session.topicId,
      prompt: session.prompt.slice(0, 500),
      ...(resuming ? { engineSessionId: session.engineSessionId } : {}),
    },
  })

  session.status = 'thinking'
  persist(session)

  const handleLine = (line: string) => {
    // Captured before parsing: the id arrives on an init event no parser cares
    // about, and without it the session dies with this process.
    if (!session.engineSessionId) {
      const eid = engineSessionIdIn(line)
      if (eid) {
        session.engineSessionId = eid
        persist(session)
      }
    }

    let changed = false
    for (const ev of spec.parse(line)) {
      switch (ev.kind) {
        case 'message_start':
          l.streamingId = ev.messageId ?? null
          break

        // §3.3 — a token is not a journal entry. Deltas go beside the journal,
        // and the window drops them the moment the finished message lands.
        case 'delta':
          if (ev.text && l.streamingId) {
            agentBus.emit('delta', session.id, l.streamingId, ev.text)
          }
          break

        case 'text':
          if (!ev.text) break
          session.turns++
          session.lastMessage = ev.text.slice(0, 400)
          append({
            type: 'agent.output',
            actor,
            workspaceId,
            payload: { text: ev.text, messageId: ev.messageId ?? null },
          })
          changed = true
          break

        case 'tool': {
          const id = ev.toolUseId ?? ''
          const input = ev.input ?? {}
          l.calls.set(id, { tool: ev.tool ?? 'tool', input })
          append({
            type: 'agent.tool_use',
            actor,
            workspaceId,
            payload: {
              toolUseId: id,
              tool: ev.tool ?? 'tool',
              input,
              paths: (ev.paths ?? []).map((x) => relativeTo(cwd, x)),
            },
          })
          // §12 — attribution: this is what makes the diff splittable later.
          for (const path of ev.paths ?? []) {
            for (const wsId of session.workspaceIds)
              recordTouch(wsId, relativeTo(cwd, path), actor, session.id)
          }
          changed = true
          break
        }

        case 'tool_result': {
          const id = ev.toolUseId ?? ''
          const call = l.calls.get(id)
          l.calls.delete(id)
          append({
            type: 'agent.tool_result',
            level: ev.isError ? 'warn' : 'info',
            actor,
            workspaceId,
            payload: {
              toolUseId: id,
              tool: call?.tool ?? 'tool',
              // Capped here rather than in the window: the journal is durable,
              // and a `find /` belongs in a terminal, not in it.
              stdout: (ev.stdout ?? '').slice(0, 4000),
              stderr: (ev.stderr ?? '').slice(0, 2000),
              isError: !!ev.isError,
              interrupted: !!ev.interrupted,
            },
          })
          changed = true
          break
        }

        case 'end': {
          session.denials = ev.denials ?? []
          if (session.denials.length) {
            append({
              type: 'agent.denied',
              level: 'warn',
              actor,
              workspaceId,
              payload: { tools: session.denials },
            })
          }
          // A streaming engine ends a *turn* here, not the process. Closing the
          // turn and letting the next one in is what the queue is waiting for.
          closeTurn(session.id, 'done')
          l.streamingId = null
          l.busy = false
          session.status = 'idle'
          changed = true
          if (spec.streaming) {
            flushQueue(l)
            // Only when nothing followed it in: a conversation being worked
            // through is not idle between two of its own turns.
            if (!l.busy) armIdleTimer(l)
          }
          break
        }

        default:
          break
      }
    }

    if (changed) {
      persist(session)
      agentBus.emit('changed')
    }
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
    clearIdleTimer(l)
    live.delete(session.id)
    session.status = code === 0 ? 'ended' : 'failed'
    session.endedAt = Date.now()
    persist(session)
    // Only a turn still open needs closing: a streaming conversation has been
    // closing its own on every `end`, and marking the last one failed because
    // the process was later shut down would be a lie about the work.
    closeTurn(session.id, code === 0 ? 'done' : 'failed')
    if (session.leaseId) leases.release(session.leaseId)
    append({
      type: 'agent.session_ended',
      level: code === 0 ? 'info' : 'error',
      actor,
      payload: { code, turns: session.turns, resumable: !!session.engineSessionId },
    })
    agentBus.emit('changed')
  })

  return { sessionId: session.id }
}

/**
 * §6 — the next queued question, once the engine is free to read it.
 *
 * One at a time and in order: writing two turns into stdin at once would have
 * the engine answer them as a single muddled question, which is exactly the
 * failure a queue exists to prevent.
 */
function flushQueue(l: Live): void {
  if (l.busy || !l.queue.length) return
  clearIdleTimer(l)
  const prompt = l.queue.shift()!
  const encode = l.spec.encodeTurn
  if (!encode) return
  l.busy = true
  l.session.status = 'thinking'
  openTurn(l.session.id, prompt)
  persist(l.session)
  l.child.stdin?.write(encode(prompt) + '\n')
  agentBus.emit('changed')
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
 * §6 — another turn in a conversation that is already open.
 *
 * A streaming engine holds its stdin for the life of the conversation, so this
 * is a line written into a running process rather than a new one spawned. Said
 * while it is still working, the turn is *queued*: that is the normal way to
 * work, and refusing it is what forced the composer to grey itself out between
 * question and answer.
 *
 * A one-shot engine has nothing to write into and says so, pointing at the
 * `agent.resume` that does work for it.
 */
export function send(sessionId: string, prompt: string): { ok: true; queued: boolean } | { ok: false; reason: string } {
  const l = live.get(sessionId)
  if (!l) return { ok: false, reason: 'no such live session — resume it instead' }
  if (!l.spec.streaming || !l.spec.encodeTurn) {
    return {
      ok: false,
      reason:
        l.session.engine +
        ' runs one-shot and does not read stdin; wait for it to finish and resume the conversation',
    }
  }
  const text = prompt.trim()
  if (!text) return { ok: false, reason: 'nothing to say' }

  if (l.busy) {
    l.queue.push(text)
    agentBus.emit('changed')
    return { ok: true, queued: true }
  }
  clearIdleTimer(l)
  l.queue.push(text)
  flushQueue(l)
  return { ok: true, queued: false }
}

/** What is waiting to be asked, for a window that has to show it. */
export function queuedIn(sessionId: string): string[] {
  return [...(live.get(sessionId)?.queue ?? [])]
}

/**
 * Taking a queued turn back before the engine ever sees it.
 *
 * Matched on its text and not on its index: the queue moves on its own as
 * turns are flushed, so an index chosen in the window can name a different
 * question by the time it arrives. The first match goes, which is the one that
 * was shown as first.
 */
export function unqueue(sessionId: string, prompt: string): { ok: boolean; reason?: string } {
  const l = live.get(sessionId)
  if (!l) return { ok: false, reason: 'no such live session' }
  const i = l.queue.indexOf(prompt)
  if (i === -1) return { ok: false, reason: 'it has already gone in' }
  l.queue.splice(i, 1)
  agentBus.emit('changed')
  return { ok: true }
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
