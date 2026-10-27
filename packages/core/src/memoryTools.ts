import { MEMORY_NEW, MEMORY_OFF, STATE_SECTION, conversationRef } from '@cockpit/shared'
import type { Actor, Conversation } from '@cockpit/shared'
import * as docsTools from './docsTools.js'
import * as peersTools from './peersTools.js'
import * as memory from './memory.js'
import { getWorkspace } from './registry.js'

/**
 * §6 — the memory, as tools the agent holds.
 *
 * The memory existed and only a person ever wrote it: the agent was never told
 * it was there, and a topic's root is outside the directories it is handed, so
 * it could not have written it if it had wanted to. §6 names that exact
 * failure — "si écrire la mémoire est un effort séparé, elle ne sera jamais
 * écrite" — and the fix is to make it the agent's effort, as it works.
 *
 * Tools rather than the file: `claude` hosts an MCP server declared as `sdk`
 * by sending its JSON-RPC over the control channel this core already holds
 * (`mcp_message` requests), so the call lands *here*, in the process that
 * knows which conversation made it. That buys three things a file edit could
 * not: the note is signed with where it came from, two agents writing at once
 * cannot overwrite each other (the core is one thread), and it is journalled
 * as the agent's, the same human/agent line the diff keeps (§12).
 *
 * No approval, on purpose. The memory is disposable — it lives the topic's
 * life, or the project's until it is documented — and a gate on it is the
 * separate effort that stops it being written. The gate belongs on the docs,
 * which are forever.
 */

export const SERVER = 'cockpit'

const NOTE = 'memory_note'
const STATE = 'memory_state'
const READ = 'memory_read'
const OUTDATE = 'memory_outdate'

/** As the engine names them — what `--tools` and `--allowedTools` list. */
export const TOOL_NAMES = [NOTE, STATE, READ, OUTDATE].map((n) => 'mcp__' + SERVER + '__' + n)

/**
 * The longest note taken. Every entry is pasted into every conversation that
 * opens on this memory, and a paragraph per entry is how one reached 26 KB:
 * four in five entries over 400 characters, read again on every start. A line
 * that will not fit is two facts, or a fact and its history.
 */
export const NOTE_MAX = 300

/** The `--mcp-config` that declares the server as hosted by this process. */
export const MCP_CONFIG = JSON.stringify({ mcpServers: { [SERVER]: { type: 'sdk', name: SERVER } } })

/**
 * When to write, said once at launch. What it leaves out matters as much: a
 * memory that logs every step is a second transcript, grows every preamble,
 * and buries the three lines the next agent needed.
 */
export const MEMORY_RULES = [
  'This conversation shares a memory with every other conversation on the same topic or project —',
  'other agents, possibly in other repositories, read it when they start, and so does the conversation',
  'that picks up after this one is cleared. Its content, when it has any, opens your first message.',
  'Keep it true with the cockpit memory tools, as you work, without being asked:',
  'The memory is a short picture of what is true now, not a log: everything in it is read again by',
  'every conversation that opens on it. What stops being true is not deleted — it moves to its Past',
  'section, with why, which is kept for the person and left out of what conversations are handed.',
  `${NOTE}: one short line (at most ${NOTE_MAX} characters), for a colleague who has not seen this conversation —`,
  'a decision and its reason (Decisions); an approach tried or considered and dropped, and why (Ruled out);',
  'something that must not break (Constraints); an interface other code relies on — endpoint, payload,',
  'event, file — and where it lives (Contracts); a question only the person can answer, and what hangs',
  'on it (Open questions). When a note supersedes one already there — a question answered, a contract',
  'changed, a decision revisited — pass the old one as `replaces` so the memory says one thing about one fact;',
  'the old one moves to Past.',
  `${OUTDATE}: move an entry that is no longer true, is done with, or that the code or git now shows to Past,`,
  'with one short line on why — what was tested, what changed, why the work switched.',
  `${READ} shows Past too, when you need the history.`,
  `${STATE}: replace where the work stands against its goal — done, in progress, next. Call it when you finish a piece of work.`,
  'Not the repository\'s status — committed or not, pushed or not, which files changed: Cockpit shows that live,',
  'and written down it is wrong at the next commit. A choice made along the way is a decision, noted with its reason.',
  'Before you end a turn in which a decision was made — by you or by the person — or an interface',
  'was created or changed, note it: that is the moment it is still in front of you.',
  'Do not log steps or review rounds, restate the code, note what git already shows, or copy a fact',
  'that belongs to the whole project into a topic memory. Note only what would change what the next agent does.',
].join(' ')

const NOTE_SECTIONS = memory.SECTIONS.filter((s) => s !== STATE_SECTION)

const TOOLS = [
  {
    name: NOTE,
    description:
      'Add one line to the shared memory of this topic or project. Other agents and the next conversation read it. ' +
      'Use for decisions with their reason, rejected approaches with why, constraints, contracts other code relies on (with where they live), ' +
      'and open questions waiting on the person. One short line, at most ' + NOTE_MAX + ' characters. ' +
      'Pass `replaces` when this supersedes an existing entry.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: NOTE_SECTIONS, description: 'Where it belongs.' },
        replaces: {
          type: 'string',
          description: 'Optional: the words of an existing entry this one supersedes. It moves to Past.',
        },
        text: {
          type: 'string',
          description: 'One self-contained line. Name files, endpoints and payloads exactly. Cockpit signs it — add no name or date.',
        },
      },
      required: ['section', 'text'],
    },
  },
  {
    name: STATE,
    description:
      'Replace the "State" section of the shared memory: where the work stands against its goal — what is done, what is half-done, what is next. ' +
      'A few lines, not a log. Leave out the repository\'s status (committed, pushed, changed files): it is shown live and goes stale. ' +
      'A choice made along the way (a colour, a library, a layout) is a decision: note it in Decisions with its reason.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The state, as short markdown (a few bullets). Cockpit signs it — add no name or date.' },
      },
      required: ['text'],
    },
  },
  {
    name: OUTDATE,
    description:
      'Move one entry of the shared memory to its Past section: one that is no longer true, is done with, or that the code or git now shows. ' +
      'Nothing is deleted — Past keeps the history, out of what conversations are handed. ' +
      'When a new entry takes its place, use ' + NOTE + ' with `replaces` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        entry: {
          type: 'string',
          description: 'The words of the entry — enough of them to pick out one entry. Its signature does not count.',
        },
        why: {
          type: 'string',
          description: 'One short line: why it no longer holds — what was tested, what changed, what the work switched to.',
        },
      },
      required: ['entry', 'why'],
    },
  },
  {
    name: READ,
    description:
      'Read the shared memory as it stands now, including what other conversations wrote since this one started.',
    inputSchema: { type: 'object', properties: {} },
  },
]

interface JsonRpc {
  jsonrpc?: string
  id?: number | string
  method: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

/**
 * Who a note says it is from: the repositories the conversation stands in.
 * "cashplannr-frontend" is the whole of what the backend's agent needs to know
 * about where an endpoint's caller lives.
 */
export function signature(c: Conversation): string {
  const names = [
    ...new Set(
      c.workspaceIds
        .map((id) => getWorkspace(id))
        .filter((w) => !!w)
        .map((w) => w!.repoName || w!.name),
    ),
  ]
  if (!names.length) return 'agent'
  return names.length > 2 ? names.length + ' repositories' : names.join(' + ')
}

/**
 * One JSON-RPC message from the engine, answered. Null for a notification,
 * which the control channel still acknowledges with an empty result.
 *
 * `own` collects the lines this conversation wrote, so that what is passed on
 * to it later as "new since your last turn" is only what *others* wrote.
 */
export function handle(c: Conversation, own: Set<string>, msg: JsonRpc): Record<string, unknown> | null {
  if (msg.id === undefined) return null
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (message: string): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32602, message },
  })

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER, version: '1' },
      })
    // §9 — the docs tools ride on the same server: one channel, one process
    // that knows which conversation is asking.
    case 'tools/list':
      return reply({
        tools: [
          ...(c.memory !== MEMORY_OFF ? TOOLS : []),
          ...(docsTools.available(c) ? docsTools.TOOLS : []),
          // §7 — always: a conversation alone in its folder today may be
          // joined by another one tomorrow, and its tool list is fixed at launch.
          ...peersTools.TOOLS,
        ],
      })
    case 'tools/call': {
      const name = msg.params?.name ?? ''
      if (docsTools.NAMES.includes(name)) return reply(docsTools.call(c, name, msg.params?.arguments ?? {}))
      if (peersTools.NAMES.includes(name)) return reply(peersTools.call(c, name, msg.params?.arguments ?? {}))
      return reply(call(c, own, name, msg.params?.arguments ?? {}))
    }
    default:
      return fail('not supported: ' + msg.method)
  }
}

function call(
  c: Conversation,
  own: Set<string>,
  name: string,
  args: Record<string, unknown>,
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError } : {}) })
  const str = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
  // Refused before anything is touched: a note too long to keep must not be
  // what brings a "new" memory into being.
  if ((name === NOTE || name === OUTDATE) && str(name === NOTE ? 'text' : 'why').length > NOTE_MAX) {
    return text(
      'Not noted: ' + str(name === NOTE ? 'text' : 'why').length + ' characters, and a line is at most ' + NOTE_MAX + '. ' +
        'Say it again as one short line — the fact and its reason, not its history; ' +
        'if it is two facts, note them separately.',
      true,
    )
  }
  let home = memory.homeOf(c)
  // §6 — "new": the memory comes into being with the first thing worth
  // keeping, named after the conversation, and the conversation is pointed at
  // it from then on (the driver persists the change).
  if (!home && c.memory === MEMORY_NEW && name !== READ && name !== OUTDATE) {
    const projectId = c.workspaceIds.map((id) => getWorkspace(id)?.projectId).find(Boolean)
    if (projectId) {
      c.memory = memory.createNamed(projectId, c.title || c.prompt.slice(0, 60) || 'Memory')
      home = memory.homeOf(c)
    }
  }
  if (!home && (name === READ || name === OUTDATE)) return text('Nothing is written in this memory yet.')
  if (!home) return text('This conversation has no memory to write to.', true)
  const actor: Actor = { kind: 'agent', engine: c.engine, sessionId: c.id }

  switch (name) {
    case NOTE: {
      const line = str('text')
      if (!line) return text('Nothing to note: `text` is empty.', true)
      const r = memory.note(
        home, str('section') || 'Decisions', line, signature(c), actor, conversationRef(c.id), str('replaces') || undefined,
      )
      own.add(r.entry)
      if (r.past) own.add(r.past)
      if (str('replaces') && !r.replaced) return text('Noted — but no entry matched `replaces`, so nothing moved to Past.')
      return text('Noted in the ' + home.kind + ' memory' + (r.replaced ? '; the old entry moved to Past.' : '.'))
    }
    case STATE: {
      const body = str('text')
      if (!body) return text('Nothing to set: `text` is empty.', true)
      for (const l of memory.setState(home, body, signature(c), actor, conversationRef(c.id))) own.add(l)
      return text('State replaced in the ' + home.kind + ' memory.')
    }
    case OUTDATE: {
      const words = str('entry')
      if (!words) return text('Nothing to move: `entry` is empty.', true)
      if (!str('why')) return text('Say why it no longer holds: `why` is empty.', true)
      const past = memory.outdateEntry(home, words, str('why'), actor)
      if (!past) return text('No entry matched those words, so nothing moved. Read the memory and quote the entry.', true)
      own.add(past)
      return text('Moved to Past: ' + past.replace(/^\s*[-*+]\s+/, ''))
    }
    case READ:
      return text(memory.forEngine(memory.contentAt(home.file, home.kind) ?? '', true) || 'The memory is empty.')
    default:
      return text('Unknown tool: ' + name, true)
  }
}
