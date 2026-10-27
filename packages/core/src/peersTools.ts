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
 * And `tell`: a message to one of them. It never starts a turn — a working
 * agent reads it after its next tool call, an idle one when the person next
 * talks to it — so two agents cannot keep each other running.
 *
 * Served on the same `cockpit` server as the memory and docs tools; what they
 * read and write lives in agents.ts, handed over through `provide` so this
 * file does not import the driver that imports it.
 */

const PEERS = 'peers'
const TELL = 'tell'

export const NAMES = [PEERS, TELL]

/** As the engine names them — what `--tools` and `--allowedTools` list. */
export const TOOL_NAMES = NAMES.map((n) => 'mcp__cockpit__' + n)

/** One other conversation in this one's folders, as the tool reports it. */
export interface Peer {
  id: string
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

type Send = (c: Conversation, to: string, text: string) => { ok: boolean; text: string }

let source: (c: Conversation) => Peer[] = () => []
let send: Send = () => ({ ok: false, text: 'not available' })

export function provide(fn: (c: Conversation) => Peer[], tell: Send): void {
  source = fn
  send = tell
}

/** At most this long: a message is a note between colleagues, not a hand-over. */
const TELL_MAX = 2000

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
  {
    name: TELL,
    description:
      'Send a short message to another conversation working in your folders (its ref comes from `peers`). ' +
      'Use it to coordinate: say you are about to change a file it is working on, ask it to hold off, or answer a message it sent you. ' +
      'It does not wake an agent that is not working: a working one reads it after its next step, an idle one when the person next talks to it. ' +
      'Do not wait for a reply.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The ref of the conversation, as `peers` lists it.' },
        message: { type: 'string', description: 'What to say, in a few sentences.' },
      },
      required: ['to', 'message'],
    },
  },
]

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }

export function call(c: Conversation, name: string, args: Record<string, unknown> = {}): Result {
  const text = (t: string, isError = false): Result => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })
  if (name === TELL) {
    const to = typeof args.to === 'string' ? args.to.trim() : ''
    const message = typeof args.message === 'string' ? args.message.trim() : ''
    if (!to || !message) return text('Not sent: both `to` and `message` are needed.', true)
    if (message.length > TELL_MAX)
      return text('Not sent: ' + message.length + ' characters, and a message is at most ' + TELL_MAX + '. Say it shorter.', true)
    const r = send(c, to, message)
    return text(r.text, !r.ok)
  }
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

/** Messages from other conversations, as the agent reads them — mid-turn or at the top of one. */
export function mail(msgs: { ref: string; title: string; text: string }[]): string {
  if (!msgs.length) return ''
  const one = msgs.length === 1
  return [
    one ? '# A message from another conversation' : '# Messages from other conversations',
    'Sent with `mcp__cockpit__tell` by an agent working in the same folders.',
    '',
    ...msgs.flatMap((m) => ['From “' + m.title + '” (' + m.ref + '):', ...m.text.split('\n').map((l) => '> ' + l), '']),
    'If it needs an answer, reply with `mcp__cockpit__tell` (to: its ref). Then carry on with what you were asked.',
    '',
    '---',
    '',
    '',
  ].join('\n')
}
