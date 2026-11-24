import { parseTicketRef } from '@cockpit/shared'
import type { TicketDetail, TicketPhase, TicketSummary } from '@cockpit/shared'
import { adfToMarkdown } from './adf.js'
import type { TrackerCredential } from './credential.js'

/**
 * Jira Cloud over its REST API, v3: the issue, the search, and who you are.
 * Read only: slice 1 changes nothing on the tracker.
 */

export class TrackerError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
  }
}

export interface JiraSite {
  /** `https://<site>.atlassian.net` */
  site: string
  /** The project key lists are narrowed to, or null for every project. */
  project: string | null
}

const FIELDS = ['summary', 'status', 'issuetype', 'assignee']
const DETAIL_FIELDS = [...FIELDS, 'priority', 'labels', 'description', 'parent', 'subtasks', 'comment']
const COMMENTS = 5

async function call(at: JiraSite, cred: TrackerCredential, method: string, path: string, body?: unknown): Promise<any> {
  let res: Response
  try {
    res = await fetch(at.site + path, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(cred.email + ':' + cred.token).toString('base64'),
        Accept: 'application/json',
        'User-Agent': 'cockpit',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    const why = ((e as Error).cause as Error | undefined)?.message ?? (e as Error).message
    throw new TrackerError('Jira did not answer at ' + host(at) + ': ' + why)
  }
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (res.ok) return data
  if (res.status === 401) {
    throw new TrackerError('Jira refused ' + cred.email + ' at ' + host(at) + '. Connect again with a current API token.', 401)
  }
  if (res.status === 403) {
    throw new TrackerError(cred.email + ' may not read this on ' + host(at) + '.', 403)
  }
  const why = data?.errorMessages?.[0] ?? Object.values(data?.errors ?? {})[0] ?? text.slice(0, 200)
  throw new TrackerError('Jira: ' + (why || 'answered ' + res.status), res.status)
}

function host(at: JiraSite): string {
  return at.site.replace(/^https?:\/\//, '')
}

/** Who the token answers to: the check before a credential is kept. */
export async function whoAmI(at: JiraSite, cred: TrackerCredential): Promise<{ email: string; name: string }> {
  const me = await call(at, cred, 'GET', '/rest/api/3/myself')
  return { email: me?.emailAddress ?? cred.email, name: me?.displayName ?? cred.email }
}

export async function get(at: JiraSite, cred: TrackerCredential, key: string): Promise<TicketDetail | null> {
  try {
    const raw = await call(at, cred, 'GET', '/rest/api/3/issue/' + encodeURIComponent(key) + '?fields=' + DETAIL_FIELDS.join(','))
    return detail(at, raw)
  } catch (e) {
    if (e instanceof TrackerError && e.status === 404) return null
    throw e
  }
}

/**
 * Your open tickets when `q` is empty: assigned to you, or in a sprint now
 * running. A key typed or pasted goes to that ticket; anything else is a
 * text match, the summary by prefix so a half-typed word already finds it.
 */
export async function search(at: JiraSite, cred: TrackerCredential, q: string): Promise<TicketSummary[]> {
  const scope = at.project ? 'project = "' + jql(at.project) + '" AND ' : ''
  const typed = q.trim()
  const key = parseTicketRef(typed) ?? (at.project && /^\d+$/.test(typed) ? at.project + '-' + typed : null)
  const order = ' ORDER BY updated DESC'

  const asked = async (where: string) => {
    const r = await call(at, cred, 'POST', '/rest/api/3/search/jql', { jql: where + order, fields: FIELDS, maxResults: 50 })
    return ((r?.issues ?? []) as any[]).map((i) => summary(at, i))
  }

  if (typed) {
    const text = '(summary ~ "' + jql(typed) + '*" OR text ~ "' + jql(typed) + '")'
    const hits = await asked(scope + (key ? '(key = "' + jql(key) + '" OR ' + text + ')' : text)).catch((e) => {
      // A key on a project that does not exist is an error to Jira, not an empty list.
      if (key && e instanceof TrackerError && e.status === 400) return asked(scope + text)
      throw e
    })
    return key ? [...hits.filter((t) => t.key === key), ...hits.filter((t) => t.key !== key)] : hits
  }

  const open = scope + 'statusCategory != Done AND '
  try {
    return await asked(open + '(assignee = currentUser() OR sprint in openSprints())')
  } catch (e) {
    // A site with no Scrum board has no `sprint` field, and Jira refuses the
    // whole query for naming it.
    if (e instanceof TrackerError && e.status === 400) return asked(open + 'assignee = currentUser()')
    throw e
  }
}

/** Inside a JQL string literal. */
function jql(s: string): string {
  return s.replace(/(["\\])/g, '\\$1')
}

function phase(status: any): TicketPhase {
  const k = status?.statusCategory?.key
  return k === 'done' ? 'done' : k === 'indeterminate' ? 'doing' : 'todo'
}

function summary(at: JiraSite, raw: any): TicketSummary {
  const f = raw?.fields ?? {}
  return {
    key: String(raw?.key ?? ''),
    title: String(f.summary ?? ''),
    status: String(f.status?.name ?? ''),
    phase: phase(f.status),
    type: String(f.issuetype?.name ?? ''),
    assignee: f.assignee?.displayName ?? null,
    url: at.site + '/browse/' + raw?.key,
  }
}

function detail(at: JiraSite, raw: any): TicketDetail {
  const f = raw?.fields ?? {}
  const comments = ((f.comment?.comments ?? []) as any[])
    .slice(-COMMENTS)
    .reverse()
    .map((c) => ({
      author: String(c.author?.displayName ?? 'someone'),
      at: Date.parse(c.created) || 0,
      body: adfToMarkdown(c.body),
    }))
  return {
    ...summary(at, raw),
    priority: f.priority?.name ?? null,
    labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
    description: adfToMarkdown(f.description),
    parent: f.parent ? summary(at, f.parent) : null,
    subtasks: ((f.subtasks ?? []) as any[]).map((s) => summary(at, s)),
    comments,
  }
}

// ── writing back (slice 2): a status, and a link ────────────────────────────

export interface Transition {
  id: string
  name: string
  to: string
  phase: TicketPhase
}

/** Where the ticket is, and every move its workflow allows from there. */
export async function transitions(
  at: JiraSite,
  cred: TrackerCredential,
  key: string,
): Promise<{ status: string; phase: TicketPhase; moves: Transition[] }> {
  const path = '/rest/api/3/issue/' + encodeURIComponent(key)
  const [issue, t] = await Promise.all([
    call(at, cred, 'GET', path + '?fields=status'),
    call(at, cred, 'GET', path + '/transitions'),
  ])
  return {
    status: String(issue?.fields?.status?.name ?? ''),
    phase: phase(issue?.fields?.status),
    moves: ((t?.transitions ?? []) as any[]).map((x) => ({
      id: String(x.id),
      name: String(x.name ?? ''),
      to: String(x.to?.name ?? x.name ?? ''),
      phase: phase(x.to),
    })),
  }
}

export async function transition(at: JiraSite, cred: TrackerCredential, key: string, id: string): Promise<void> {
  await call(at, cred, 'POST', '/rest/api/3/issue/' + encodeURIComponent(key) + '/transitions', { transition: { id } })
}

/**
 * A link on the ticket, under its links rather than in its comments: a pull
 * request is a fact about the ticket, not a remark on it. Keyed by its URL,
 * so linking the same one twice updates it instead of adding a second.
 */
export async function link(at: JiraSite, cred: TrackerCredential, key: string, url: string, title: string): Promise<void> {
  await call(at, cred, 'POST', '/rest/api/3/issue/' + encodeURIComponent(key) + '/remotelink', {
    globalId: url,
    object: { url, title },
  })
}
