import { ticketMoveLine } from '@cockpit/shared'
import type { TicketDetail, TicketEvent, TicketMove, TicketRef, TicketSummary, TicketsStatus } from '@cockpit/shared'
import { git } from '../git.js'
import * as registry from '../registry.js'
import * as store from '../topics/store.js'
import * as credential from './credential.js'
import * as jira from './jira.js'
import type { JiraSite, Transition } from './jira.js'

/**
 * §5 — the `tickets` capability: the tracker a project's `cockpit.yaml` names,
 * reached with the account this machine holds for it.
 *
 * Jira is the only tracker so far. A project with `tickets:` naming another
 * one gets nothing from here, as if it had none: absent is invisible.
 */

export { TrackerError } from './jira.js'

/** The Jira site and project a project's manifest names, or null. */
export function siteOf(projectId: string): JiraSite | null {
  const p = registry.getProject(projectId)
  const c = p?.capabilities.find((c) => c.id === 'tickets' && c.impl === 'jira')
  const base = c?.detail?.baseUrl
  if (typeof base !== 'string' || !base.trim()) return null
  let site: string
  try {
    // People paste a board's URL as often as the site's: only the origin counts.
    site = new URL(/^https?:\/\//i.test(base.trim()) ? base.trim() : 'https://' + base.trim()).origin
  } catch {
    return null
  }
  const key = typeof c?.detail?.project === 'string' ? c.detail.project.trim().toUpperCase() : ''
  return { site, project: key || null }
}

export async function status(projectId: string): Promise<TicketsStatus | null> {
  const at = siteOf(projectId)
  if (!at) return null
  const cred = await credential.read(at.site)
  return {
    provider: 'jira',
    site: at.site,
    project: at.project,
    connected: !!cred,
    email: cred?.email ?? null,
    suggestedEmail: cred ? null : await gitEmail(projectId),
  }
}

/** The repository's own git email: an Atlassian account's, far more often than not. */
async function gitEmail(projectId: string): Promise<string | null> {
  const main = registry.allWorkspaces(projectId).find((w) => w.kind === 'main' && w.repo)
  if (!main) return null
  const r = await git(main.path, ['config', 'user.email'], 5_000)
  return r.stdout.trim() || null
}

/** Asked of Jira before it is kept: a token that does not work is not saved. */
export async function connect(
  projectId: string,
  email: string,
  token: string,
): Promise<{ ok: true; status: TicketsStatus } | { ok: false; reason: string }> {
  const at = siteOf(projectId)
  if (!at) return { ok: false, reason: 'This project names no Jira site in cockpit.yaml.' }
  const cred = { email: email.trim(), token: token.trim() }
  if (!cred.email || !cred.token) return { ok: false, reason: 'An email and an API token are both needed.' }
  try {
    const me = await jira.whoAmI(at, cred)
    await credential.save(at.site, { ...cred, email: me.email || cred.email })
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
  cache.clear()
  return { ok: true, status: (await status(projectId))! }
}

export async function disconnect(projectId: string): Promise<TicketsStatus | null> {
  const at = siteOf(projectId)
  if (at) await credential.forget(at.site)
  cache.clear()
  return status(projectId)
}

async function reach(projectId: string): Promise<{ at: JiraSite; cred: credential.TrackerCredential }> {
  const at = siteOf(projectId)
  if (!at) throw new jira.TrackerError('This project names no Jira site in cockpit.yaml.')
  const cred = await credential.read(at.site)
  if (!cred) throw new jira.TrackerError('Connect Jira first.')
  return { at, cred }
}

export async function search(projectId: string, q = ''): Promise<{ tickets: TicketSummary[]; error: string | null }> {
  try {
    const { at, cred } = await reach(projectId)
    return { tickets: await jira.search(at, cred, q), error: null }
  } catch (e) {
    return { tickets: [], error: (e as Error).message }
  }
}

/**
 * One ticket, read now. With a topic, what the topic keeps of it (title and
 * status, for its row and its Details) follows, without moving the topic in
 * the list: a status read is not work on it.
 */
export async function get(
  projectId: string,
  key: string,
  topicId?: string,
): Promise<{ ticket: TicketDetail | null; error: string | null; changed: boolean }> {
  try {
    const { at, cred } = await reach(projectId)
    const ticket = await jira.get(at, cred, key)
    if (!ticket) return { ticket: null, error: 'No ticket ' + key + ' on ' + at.site.replace(/^https?:\/\//, '') + ', or this account cannot see it.', changed: false }
    remember(ticket)
    return { ticket, error: null, changed: topicId ? follow(topicId, ticket) : false }
  } catch (e) {
    return { ticket: null, error: (e as Error).message, changed: false }
  }
}

function follow(topicId: string, t: TicketDetail): boolean {
  const f = store.get(topicId)
  if (!f?.ticket || f.ticket.key !== t.key) return false
  if (f.ticket.title === t.title && f.ticket.status === t.status && f.ticket.url === t.url) return false
  f.ticket = { ...f.ticket, title: t.title, status: t.status, url: t.url }
  store.save(f)
  return true
}

export function refOf(t: TicketSummary): TicketRef {
  return { provider: 'jira', key: t.key, title: t.title, status: t.status, url: t.url }
}

// ── writing back: the status an act moves its ticket to ────────────────────

/** `tickets.moves` from cockpit.yaml: a status by name, `false` for none, absent for the workflow's. */
function wanted(projectId: string, event: TicketEvent): string | false | undefined {
  const c = registry.getProject(projectId)?.capabilities.find((x) => x.id === 'tickets' && x.impl === 'jira')
  const v = (c?.detail?.moves as Record<string, unknown> | undefined)?.[event]
  return v === false ? false : typeof v === 'string' && v.trim() ? v.trim() : undefined
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * The move an event makes, from where the ticket is.
 *
 * Named in cockpit.yaml, that status, if the workflow allows it from here.
 * Otherwise only forward, and only by what a status is rather than what it is
 * called, since every team names theirs: creating the topic starts a ticket
 * that has not started; opening the pull request puts one that is not done
 * into a status with "review" in its name, where the workflow has one;
 * merging finishes it. A ticket already there, or past it, stays.
 */
export function choose(
  now: { status: string; phase: 'todo' | 'doing' | 'done' },
  moves: Transition[],
  event: TicketEvent,
  named?: string | false,
): Transition | null {
  if (named === false) return null
  if (named) {
    if (same(now.status, named)) return null
    return moves.find((t) => same(t.to, named)) ?? moves.find((t) => same(t.name, named)) ?? null
  }
  const prefer = (list: Transition[], re: RegExp) => list.find((t) => re.test(t.to)) ?? list[0] ?? null
  if (event === 'open') {
    if (now.phase !== 'todo') return null
    return prefer(moves.filter((t) => t.phase === 'doing'), /progress/i)
  }
  if (event === 'pr') {
    if (now.phase === 'done' || /review/i.test(now.status)) return null
    return moves.find((t) => t.phase !== 'done' && /review/i.test(t.to)) ?? null
  }
  if (now.phase === 'done') return null
  return prefer(moves.filter((t) => t.phase === 'done'), /^done$/i)
}

/**
 * What `event` would do to the ticket, asked of Jira now. Null when nothing,
 * and when Jira cannot be asked: the act it rides on goes ahead regardless.
 * A pull request is linked even when the status stays, so `pr` always answers.
 */
export async function plan(projectId: string, key: string, event: TicketEvent): Promise<TicketMove | null> {
  try {
    const { at, cred } = await reach(projectId)
    const now = await jira.transitions(at, cred, key)
    const t = choose(now, now.moves, event, wanted(projectId, event))
    if (!t && event !== 'pr') return null
    return { key, from: now.status, to: t?.to ?? null, transitionId: t?.id ?? null }
  } catch {
    return null
  }
}

/** Makes the move, links what it names, and keeps the topic's copy of the status in step. */
export async function move(projectId: string, m: TicketMove, topicId?: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const { at, cred } = await reach(projectId)
    if (m.transitionId) await jira.transition(at, cred, m.key, m.transitionId)
    for (const l of m.links ?? []) await jira.link(at, cred, m.key, l.url, l.title)
    cache.delete(m.key)
    if (m.to && topicId) {
      const f = store.get(topicId)
      if (f?.ticket?.key === m.key) {
        f.ticket = { ...f.ticket, status: m.to }
        store.save(f)
      }
    }
    return { ok: true, detail: ticketMoveLine(m) }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}

// ── what a conversation opens with ──────────────────────────────────────────

/**
 * Tickets read lately, by key. The opening of a conversation is built before
 * every turn sent (`agent.resume`), and most of those turns go to a process
 * already running that never reads it: a network call each time would be
 * latency for nothing. So a ticket read in the last few minutes is used as it
 * is, an older one is used and read again behind it, and only a ticket never
 * read is waited for, briefly.
 */
const cache = new Map<string, { at: number; ticket: TicketDetail }>()
const FRESH_MS = 3 * 60_000
const WAIT_MS = 4_000

function remember(t: TicketDetail): void {
  cache.set(t.key, { at: Date.now(), ticket: t })
}

/** The block a conversation on a topic made from a ticket opens with. Empty otherwise. */
export async function preambleBlock(topicId: string | null): Promise<string> {
  if (!topicId) return ''
  const f = store.get(topicId)
  const ref = f?.ticket
  if (!f || !ref || ref.provider !== 'jira') return ''
  const hit = cache.get(ref.key)
  if (hit) {
    if (Date.now() - hit.at > FRESH_MS) void get(f.projectId, ref.key, topicId)
    return block(hit.ticket)
  }
  const read = await Promise.race([
    get(f.projectId, ref.key, topicId).then((r) => r.ticket),
    new Promise<null>((r) => setTimeout(() => r(null), WAIT_MS)),
  ])
  return read ? block(read) : stub(ref)
}

const DESCRIPTION_MAX = 4_000

export function block(t: TicketDetail): string {
  const facts = [t.type, t.status, t.priority].filter(Boolean).join(' · ')
  const description =
    t.description.length > DESCRIPTION_MAX
      ? t.description.slice(0, DESCRIPTION_MAX).replace(/\s+\S*$/, '') + '\n\n[cut here: `ticket_read` has the rest]'
      : t.description
  return [
    '# Ticket ' + t.key + ': ' + t.title,
    facts + ' · ' + t.url,
    ...(t.parent ? ['Parent: ' + line(t.parent)] : []),
    ...(t.labels.length ? ['Labels: ' + t.labels.join(', ')] : []),
    '',
    'This topic was made from this ticket: it is what the work is for.',
    '',
    description || '(No description.)',
    ...(t.subtasks.length ? ['', '## Sub-tickets', ...t.subtasks.map((s) => '- ' + line(s))] : []),
    '',
    '`ticket_read` reads it again as it is now, with its latest comments, and reads any other ticket by key.',
  ].join('\n')
}

/** What is said when Jira cannot be reached at launch: what the topic kept. */
function stub(ref: TicketRef): string {
  return [
    '# Ticket ' + ref.key + ': ' + ref.title,
    ref.status + ' · ' + ref.url,
    '',
    'This topic was made from this ticket. Jira did not answer when this conversation started; `ticket_read` tries again.',
  ].join('\n')
}

export function line(t: TicketSummary): string {
  return t.key + ' [' + t.status + '] ' + t.title
}

/** The whole ticket, as `ticket_read` answers. */
export function full(t: TicketDetail): string {
  const comments = t.comments.length
    ? ['', '## Latest comments', ...t.comments.map((c) => '**' + c.author + '**, ' + new Date(c.at).toISOString().slice(0, 10) + '\n\n' + c.body)]
    : []
  return [
    '# ' + t.key + ': ' + t.title,
    [t.type, t.status, t.priority, t.assignee ? 'assigned to ' + t.assignee : 'unassigned'].filter(Boolean).join(' · ') + ' · ' + t.url,
    ...(t.parent ? ['Parent: ' + line(t.parent)] : []),
    ...(t.labels.length ? ['Labels: ' + t.labels.join(', ')] : []),
    '',
    t.description || '(No description.)',
    ...(t.subtasks.length ? ['', '## Sub-tickets', ...t.subtasks.map((s) => '- ' + line(s))] : []),
    ...comments,
  ].join('\n')
}
