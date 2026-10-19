import { resolveLink } from '@cockpit/shared'
import type { Conversation, DocsPage } from '@cockpit/shared'
import * as docs from './docs.js'
import * as signals from './docsSignals.js'
import { getWorkspace } from './registry.js'

/**
 * §9 — the docs, as tools the agent reads them with.
 *
 * Its own `Read` reaches the files already. What these add is what a file read
 * cannot: a page found by its name, an alias or a `[[link]]` the way the docs
 * themselves resolve one; one section of it instead of the whole page, which is
 * what keeps a 1,500-word page from costing 2,000 tokens to answer one
 * question; and the pages around it — what it links to and what links to it —
 * which is how an agent finds the page it did not know to ask for.
 *
 * Read-only, on purpose: the docs change only through a documentation step a
 * person accepts. `docs_flag` is the one write, and it is not to the docs: a
 * note that a page is wrong or missing, kept until the work is final and then
 * offered for an update (docsSignals.ts). Served on the same `cockpit` server
 * as the memory tools.
 */

const READ = 'docs_read'
const SEARCH = 'docs_search'
const FLAG = 'docs_flag'

export const NAMES = [READ, SEARCH, FLAG]

/** As the engine names them — what `--tools` and `--allowedTools` list. */
export const TOOL_NAMES = NAMES.map((n) => 'mcp__cockpit__' + n)

/** Past this a page is answered with its outline, and a section is asked for. */
const WHOLE_MAX = 16_000

export const TOOLS = [
  {
    name: READ,
    description:
      "Read a page of this project's documentation — by its path, its name, an alias, or a [[link]] as written in another page. " +
      'Pass `section` (a heading) to read only that part: it is the cheap way to answer one question from a long page. ' +
      'The answer ends with the pages it links to and the pages that link to it.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'A path from the docs\' root, a page name, an alias, or `name#Heading`.' },
        section: { type: 'string', description: 'Optional: a heading of the page. Only that section is returned.' },
      },
      required: ['page'],
    },
  },
  {
    name: FLAG,
    description:
      'Note that a page of the documentation is out of date, incomplete or wrong — or that a page should exist and does not. ' +
      'Do not edit the docs: the note is kept, and when this work is sent or handed off the page is offered for an update with your note as the reason. ' +
      'Flag when what you just did or learned makes a page untrue, or when you looked for a page that should have answered you.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'The page — a path, a name or a [[link]] — or the name a missing page should have.' },
        what: { type: 'string', description: 'One short line: what is wrong or missing, exactly.' },
      },
      required: ['page', 'what'],
    },
  },
  {
    name: SEARCH,
    description:
      "Find pages of this project's documentation by words — a term, a feature, an endpoint, a file name. " +
      'Answers the best pages first, with their summary and the lines that matched under their heading.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A few words.' } },
      required: ['query'],
    },
  },
]

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }

const text = (t: string, isError = false): Result => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

function projectOf(c: Conversation): string | null {
  return c.workspaceIds.map((id) => getWorkspace(id)?.projectId).find(Boolean) ?? null
}

/** Whether a conversation's project has docs to read. */
export function available(c: Conversation): boolean {
  const pid = projectOf(c)
  return !!pid && !!docs.docsOf(pid)
}

/** The longest flag kept: the reason it is offered, not the draft. */
const FLAG_MAX = 300

export function call(c: Conversation, name: string, args: Record<string, unknown>): Result {
  const str = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
  const projectId = projectOf(c)
  if (!projectId || !docs.docsOf(projectId)) return text('This project has no documentation linked.', true)

  if (name === FLAG) {
    const page = str('page')
    const what = str('what')
    if (!page || !what) return text('Say which page and what is wrong: `page` and `what` are both needed.', true)
    if (what.length > FLAG_MAX) return text('Not flagged: ' + what.length + ' characters, and a flag is at most ' + FLAG_MAX + '. Say it as one short line.', true)
    const f = signals.flag(c, page, what, { kind: 'agent', engine: c.engine, sessionId: c.id })
    return text(
      (f.missing ? 'Flagged a missing page, "' + f.page + '".' : 'Flagged ' + f.page + '.') +
        ' It will be offered for an update when this work is sent or handed off.',
    )
  }

  if (name === SEARCH) {
    const q = str('query')
    if (!q) return text('Nothing to search for: `query` is empty.', true)
    const hits = docs.search(projectId, q)
    if (!hits.length) return text('No page mentions ' + JSON.stringify(q) + '.')
    return text(
      hits
        .map((h) =>
          [
            '## ' + h.path + ' — ' + h.title,
            ...(h.summary ? [h.summary] : []),
            ...h.lines.map((l) => '  ' + (l.heading ? '[' + l.heading + '] ' : '') + l.text),
          ].join('\n'),
        )
        .join('\n\n'),
    )
  }

  if (name === READ) {
    let ref = str('page').replace(/^\[\[|\]\]$/g, '')
    let section = str('section')
    const hash = ref.indexOf('#')
    if (hash >= 0) {
      section ||= ref.slice(hash + 1)
      ref = ref.slice(0, hash)
    }
    ref = ref.split('|')[0]!.trim()
    if (!ref) return text('Name a page: `page` is empty.', true)
    const index = docs.indexOf(projectId)
    const path = index.some((p) => p.path === ref) ? ref : resolveLink(ref, '', index)
    const body = path ? docs.pageText(projectId, path) : null
    if (!path || body === null) {
      const near = docs.search(projectId, ref, 5)
      return text(
        'No page answers to ' + JSON.stringify(ref) + '.' +
          (near.length ? ' Closest: ' + near.map((h) => h.path).join(', ') + '.' : ''),
        true,
      )
    }
    const page = index.find((p) => p.path === path)!
    if (section) {
      const part = docs.sectionOf(body, section)
      if (part === null) {
        return text('No heading ' + JSON.stringify(section) + ' in ' + path + '. Its headings:\n' + docs.headingsOf(body).join('\n'), true)
      }
      return text('# ' + path + ' › ' + section + '\n\n' + part + around(page, index))
    }
    if (body.length > WHOLE_MAX) {
      return text(
        path + ' is long (' + page.words + ' words). Read it a section at a time — its headings:\n' +
          docs.headingsOf(body).join('\n') +
          '\n\nIts opening:\n\n' + body.slice(0, 2500).trimEnd() + '\n…' + around(page, index),
      )
    }
    return text('# ' + path + '\n\n' + body.trimEnd() + around(page, index))
  }

  return text('Unknown tool: ' + name, true)
}

/** What a page links to and what links to it — the way to the next page. */
function around(page: DocsPage, index: DocsPage[]): string {
  const back = index.filter((p) => p.links.includes(page.path)).map((p) => p.path)
  const lines: string[] = []
  if (page.links.length) lines.push('Links to: ' + page.links.join(', '))
  if (back.length) lines.push('Linked from: ' + back.join(', '))
  return lines.length ? '\n\n---\n' + lines.join('\n') : ''
}
