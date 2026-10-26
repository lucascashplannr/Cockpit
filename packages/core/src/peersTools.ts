import type { Conversation } from '@cockpit/shared'

/**
 * §7 — Alongside: the other conversations working in the same folder, as a
 * tool the agent asks.
 *
 * Two agents sharing a checkout each see the other's edits land on disk and
 * nothing else: not who made them, not what that agent was asked, not which
 * files it is in the middle of. That is how one agent "fixes" the other's
 * half-written change. This answers the question before it is acted on.
 *
 * Read-only. Served on the same `cockpit` server as the memory and docs tools;
 * what it reads lives in agents.ts, handed over through `provide` so this file
 * does not import the driver that imports it.
 */

const PEERS = 'peers'

export const NAMES = [PEERS]

/** As the engine names them — what `--tools` and `--allowedTools` list. */
export const TOOL_NAMES = NAMES.map((n) => 'mcp__cockpit__' + n)

/** One other conversation in this one's folders, as the tool reports it. */
export interface Peer {
  /** Its short reference, the one memory notes are signed with. */
  ref: string
  title: string
  /** working — a turn in flight; open — running, waiting for a person; stopped — not running. */
  status: 'working' | 'open' | 'stopped'
  /** The repositories it shares with this conversation, by name. */
  repositories: string[]
  /** Files it changed in those repositories, relative to each, newest first. */
  files: string[]
  /** The last thing it said, cut short. */
  lastMessage: string | null
}

let source: (c: Conversation) => Peer[] = () => []

export function provide(fn: (c: Conversation) => Peer[]): void {
  source = fn
}

export function peersOf(c: Conversation): Peer[] {
  return source(c)
}

export const TOOLS = [
  {
    name: PEERS,
    description:
      'List the other conversations (other agents) working in the same folders as you right now, or recently: what each was asked, ' +
      'whether it is working, the files it has changed, and the last thing it said. ' +
      'Call it before editing a file you did not write in this conversation, when a file changed under you, ' +
      'or when tests fail in code you did not touch — another agent may be halfway through a change there.',
    inputSchema: { type: 'object', properties: {} },
  },
]

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }

export function call(c: Conversation, name: string): Result {
  const text = (t: string, isError = false): Result => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })
  if (name !== PEERS) return text('unknown tool: ' + name, true)
  const peers = peersOf(c)
  if (!peers.length) return text('No other conversation is working in your folders.')
  return text(describe(peers, true))
}

/** The list in words, for the tool's answer and for the note at the top of a turn. */
export function describe(peers: Peer[], full: boolean): string {
  const lines: string[] = []
  for (const p of peers) {
    lines.push('- “' + p.title + '” (' + p.ref + ') — ' + p.status + ', in ' + p.repositories.join(', '))
    const files = full ? p.files.slice(0, 40) : p.files.slice(0, 8)
    if (files.length)
      lines.push('  files changed: ' + files.join(', ') + (p.files.length > files.length ? ', and ' + (p.files.length - files.length) + ' more' : ''))
    if (full && p.lastMessage) lines.push('  last said: ' + p.lastMessage)
  }
  return lines.join('\n')
}

/** What the agent is told at the top of a turn when who is beside it has changed. */
export function news(peers: Peer[]): string {
  if (!peers.length) return ''
  return [
    '# Working alongside you',
    'Other conversations are working in the same folders. Their edits land in the files you are reading.',
    'Do not undo or rewrite their changes; if you need to change a file they are working on, say so in your answer.',
    'Call `mcp__cockpit__peers` for the current list.',
    '',
    describe(peers, false),
    '',
    '---',
    '',
    '',
  ].join('\n')
}
