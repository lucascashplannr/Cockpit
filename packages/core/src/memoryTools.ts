import { STATE_SECTION } from '@cockpit/shared'
import type { Actor, Conversation } from '@cockpit/shared'
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

/** As the engine names them — what `--tools` and `--allowedTools` list. */
export const TOOL_NAMES = [NOTE, STATE, READ].map((n) => 'mcp__' + SERVER + '__' + n)

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
  `${NOTE}: one line, written for a colleague who has not seen this conversation —`,
  'a decision and its reason (Decisions); an approach tried or considered and dropped, and why (Ruled out);',
  'something that must not break (Constraints); an interface other code relies on — endpoint, payload,',
  'event, file — and where it lives (Contracts).',
  `${STATE}: replace where the work stands — done, half-done, next. Call it when you finish a piece of work.`,
  'Before you end a turn in which a decision was made — by you or by the person — or an interface',
  'was created or changed, note it: that is the moment it is still in front of you.',
  'Do not log steps, restate the code, or note what git already shows. Note only what would change',
  'what the next agent does.',
].join(' ')

const NOTE_SECTIONS = memory.SECTIONS.filter((s) => s !== STATE_SECTION)

const TOOLS = [
  {
    name: NOTE,
    description:
      'Add one line to the shared memory of this topic or project. Other agents and the next conversation read it. ' +
      'Use for decisions with their reason, rejected approaches with why, constraints, and contracts other code relies on (with where they live).',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: NOTE_SECTIONS, description: 'Where it belongs.' },
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
      'Replace the "State" section of the shared memory: where the work stands now — what is done, what is half-done, what is next. ' +
      'A few lines, not a log.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The state, as short markdown (a few bullets). Cockpit signs it — add no name or date.' },
      },
      required: ['text'],
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
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call':
      return reply(call(c, own, msg.params?.name ?? '', msg.params?.arguments ?? {}))
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
  const home = memory.homeOf(c)
  if (!home) return text('This conversation has no topic or project to keep a memory in.', true)
  const actor: Actor = { kind: 'agent', engine: c.engine, sessionId: c.id }
  const str = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')

  switch (name) {
    case NOTE: {
      const line = str('text')
      if (!line) return text('Nothing to note: `text` is empty.', true)
      const entry = memory.note(home, str('section') || 'Decisions', line, signature(c), actor)
      own.add(entry)
      return text('Noted in the ' + home.kind + ' memory.')
    }
    case STATE: {
      const body = str('text')
      if (!body) return text('Nothing to set: `text` is empty.', true)
      for (const l of memory.setState(home, body, signature(c), actor)) own.add(l)
      return text('State replaced in the ' + home.kind + ' memory.')
    }
    case READ:
      return text(memory.contentAt(home.file) ?? 'The memory is empty.')
    default:
      return text('Unknown tool: ' + name, true)
  }
}
