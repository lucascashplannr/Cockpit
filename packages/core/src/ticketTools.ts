import { parseTicketRef } from '@cockpit/shared'
import type { Conversation } from '@cockpit/shared'
import { getTopic, getWorkspace } from './registry.js'
import * as tickets from './tickets/index.js'

/**
 * §5 — the project's tickets, as a tool the agent reads them with.
 *
 * A conversation on a topic made from a ticket already opens with it
 * (`tickets.preambleBlock`). This is for the rest: the ticket as it is now
 * rather than as it was at launch, its latest comments, and any other ticket
 * the work runs into, by key. Read only, like the capability itself in this
 * slice. Served on the same `cockpit` server as the memory tools.
 */

const READ = 'ticket_read'

export const NAMES = [READ]

/** As the engine names them — what `--tools` and `--allowedTools` list. */
export const TOOL_NAMES = NAMES.map((n) => 'mcp__cockpit__' + n)

export const TOOLS = [
  {
    name: READ,
    description:
      "Read a ticket from this project's tracker (Jira) as it is now: its description, sub-tickets, parent and latest comments. " +
      "Without `key`, the ticket this topic was made from. Read it before deciding what the work should do when the ticket is the brief.",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Optional: a ticket key such as CP-123, or a link to one.' },
      },
    },
  },
]

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }

function text(t: string, isError = false): Result {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) }
}

function projectOf(c: Conversation): string | null {
  return c.workspaceIds.map((id) => getWorkspace(id)?.projectId).find(Boolean) ?? null
}

/** Whether a conversation's project names a tracker this can read. */
export function available(c: Conversation): boolean {
  const p = projectOf(c)
  return !!p && !!tickets.siteOf(p)
}

export async function call(c: Conversation, _name: string, args: Record<string, unknown>): Promise<Result> {
  const projectId = projectOf(c)
  if (!projectId || !tickets.siteOf(projectId)) return text('This project has no ticket tracker linked.', true)
  const asked = typeof args.key === 'string' ? args.key.trim() : ''
  const own = c.topicId ? getTopic(c.topicId)?.ticket ?? null : null
  const key = asked ? parseTicketRef(asked) : own?.key ?? null
  if (!key) {
    return text(asked ? '"' + asked + '" is not a ticket key or a link to one.' : 'This topic was not made from a ticket: pass `key`.', true)
  }
  const r = await tickets.get(projectId, key, own?.key === key ? c.topicId ?? undefined : undefined)
  if (!r.ticket) return text(r.error ?? 'No ticket ' + key + '.', true)
  return text(tickets.full(r.ticket))
}
