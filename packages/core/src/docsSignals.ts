import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { coversPath, newId, resolveLink } from '@cockpit/shared'
import type { Actor, Conversation, DocsFlag, DocsOffer, DocsOfferPage, DocsSignals, DocumentScope } from '@cockpit/shared'
import { attachmentsRoot } from './attachments.js'
import * as docs from './docs.js'
import { append } from './journal.js'
import * as memory from './memory.js'
import { getWorkspace } from './registry.js'

/**
 * §9 — knowing *which* pages to update, and saying so at the right moment.
 *
 * A docs folder goes stale one forgotten page at a time, and asking an agent
 * to "update the docs" from a copy of all of them is how three hundred pages
 * get read to change none. So what may be out of date is gathered as the work
 * happens, without anyone thinking about it, from four places:
 *
 * - **the code**: a page's `covers:` names the code it describes; when that
 *   code is what a branch changed, the page may no longer be true;
 * - **the agent**: `docs_flag` — a page it read and found wrong, or a page
 *   that should exist — a note, never an edit;
 * - **the memory**: Decisions, Contracts and Constraints are lasting by nature,
 *   and the docs may not say them yet;
 * - **the links**: a page in the set that links to no page gets that fixed too.
 *
 * Nothing is drafted then. The moment is when the work is final — after Send
 * to the base, and in a `/next` handoff — and even then it is an *offer*: one
 * line in the conversation that did the work, one click to draft only those
 * pages in it. (Lucas, 2026-10-19: "Offer, one click drafts".)
 *
 * Flags and offers are this machine's, per project, beside the drafts; the
 * code and memory signals are worked out at the moment, never stored, so they
 * cannot go stale themselves.
 */

/** The memory sections that hold what lasts. State and Open questions do not. */
const LASTING = new Set(['Decisions', 'Contracts', 'Constraints'])
/** Offers kept once decided, for the thread's line to say what became of them. */
const KEEP_DONE = 60

function file(projectId: string): string {
  const dir = join(attachmentsRoot(), 'docs-signals')
  mkdirSync(dir, { recursive: true })
  return join(dir, projectId + '.json')
}

function load(projectId: string): DocsSignals {
  try {
    const raw = JSON.parse(readFileSync(file(projectId), 'utf8')) as Partial<DocsSignals>
    return { flags: raw.flags ?? [], offers: raw.offers ?? [] }
  } catch {
    return { flags: [], offers: [] }
  }
}

function save(projectId: string, s: DocsSignals): void {
  const open = s.offers.filter((o) => o.state === 'open' || o.state === 'drafting')
  const done = s.offers.filter((o) => o.state !== 'open' && o.state !== 'drafting').slice(-KEEP_DONE)
  writeFileSync(file(projectId), JSON.stringify({ flags: s.flags, offers: [...done, ...open] }), 'utf8')
}

export function projectOf(c: Pick<Conversation, 'workspaceIds'>): string | null {
  return c.workspaceIds.map((id) => getWorkspace(id)?.projectId).find(Boolean) ?? null
}

/**
 * Everything waiting, with every drafting offer brought up to date: once its
 * set is decided — or the agent found nothing worth changing — the flags it
 * carried are done with. A draft that failed is offered again.
 */
export function signals(projectId: string): DocsSignals {
  const s = load(projectId)
  let changed = false
  for (const o of s.offers) {
    if (o.state !== 'drafting' || !o.setId) continue
    const st = docs.setStatus(o.setId)
    if (st === 'done' || st === null) {
      o.state = 'done'
      s.flags = s.flags.filter((f) => !o.flagIds.includes(f.id))
      changed = true
    } else if (st === 'failed') {
      o.state = 'open'
      o.setId = null
      changed = true
    }
  }
  if (changed) save(projectId, s)
  return s
}

/* ── the agent's flag ─────────────────────────────────────────────────── */

export function flag(c: Conversation, page: string, text: string, actor: Actor): DocsFlag {
  const projectId = projectOf(c)
  if (!projectId) throw new Error('this conversation is in no project')
  const index = docs.indexOf(projectId)
  const ref = page.replace(/^\[\[|\]\]$/g, '').split(/[#|]/)[0]!.trim()
  const path = index.some((p) => p.path === ref) ? ref : resolveLink(ref, '', index)
  const s = load(projectId)
  const f: DocsFlag = {
    id: newId('dflag_'),
    page: path ?? ref.replace(/\.md$/i, ''),
    missing: !path,
    text: text.trim(),
    sessionId: c.id,
    topicId: c.topicId ?? null,
    createdAt: Date.now(),
  }
  s.flags.push(f)
  save(projectId, s)
  append({ type: 'docs.flagged', actor, projectId, payload: { flagId: f.id, page: f.page, missing: f.missing } })
  return f
}

export function dropFlag(projectId: string, flagId: string): void {
  const s = load(projectId)
  s.flags = s.flags.filter((f) => f.id !== flagId)
  save(projectId, s)
}

/* ── what may be out of date ──────────────────────────────────────────── */

/** A path as `covers:` names it: from the project root, the repository's folder first. */
export function projectPath(workspaceId: string, rel: string): string {
  const ws = getWorkspace(workspaceId)
  const clean = rel.replace(/^\.?\/+/, '')
  return ws?.repoName ? ws.repoName + '/' + clean : clean
}

/** The memory's lasting entries, without their signatures. */
function lastingEntries(home: memory.MemoryHome | null): string[] {
  if (!home) return []
  const text = memory.contentAt(home.file, home.kind)
  if (!text) return []
  const out: string[] = []
  let section = ''
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      section = h[1]!
      continue
    }
    if (!LASTING.has(section) || !/^\s*[-*+]\s+/.test(line)) continue
    out.push(line.replace(/^\s*[-*+]\s+/, '').replace(/\s*_\([^()]{1,60}\)_\s*$/, '').trim())
  }
  return out.filter(Boolean)
}

interface Gathered {
  pages: DocsOfferPage[]
  memory: string[]
  flagIds: string[]
}

/**
 * The pages to offer, every reason beside each: `changed` are project paths
 * the work changed, `flags` the agents' notes that belong to it.
 */
function gather(projectId: string, changed: readonly string[], flags: readonly DocsFlag[], lasting: string[]): Gathered {
  const index = docs.indexOf(projectId)
  const pages = new Map<string, DocsOfferPage>()
  const add = (path: string, missing: boolean, reason: string) => {
    const p = pages.get(path) ?? { path, missing, reasons: [] }
    if (!p.reasons.includes(reason)) p.reasons.push(reason)
    pages.set(path, p)
  }
  for (const page of index) {
    for (const pattern of page.covers) {
      const hit = changed.filter((c) => coversPath(pattern, c))
      if (!hit.length) continue
      const names = hit.slice(0, 3).map((h) => h.slice(h.lastIndexOf('/') + 1))
      add(page.path, false, 'covers ' + pattern + ', changed: ' + names.join(', ') + (hit.length > 3 ? ' (+' + (hit.length - 3) + ')' : ''))
    }
  }
  for (const f of flags) add(f.page, f.missing, 'flagged: ' + f.text)
  // A page already being opened gets its dead links mended in the same pass.
  for (const p of pages.values()) {
    const page = index.find((x) => x.path === p.path)
    if (page?.broken.length) p.reasons.push('links to no page: ' + page.broken.map((b) => '[[' + b + ']]').join(', '))
  }
  return { pages: [...pages.values()], memory: lasting, flagIds: flags.map((f) => f.id) }
}

function worthOffering(g: Gathered): boolean {
  return g.pages.length > 0 || g.memory.length > 0
}

/**
 * After Send to the base: what the topic changed, the flags its conversations
 * left, and its memory's lasting entries. Saved and journalled on the
 * conversation that did the work, where the line is drawn. Null when there is
 * nothing to say — no line beats a line that says "nothing".
 */
export function offerAfterSend(input: {
  projectId: string
  topicId: string
  /** The topic's conversations, newest first; the first drafts. */
  conversations: Conversation[]
  changed: string[]
  label: string
}): DocsOffer | null {
  if (!docs.docsOf(input.projectId)) return null
  const s = signals(input.projectId)
  const ids = new Set(input.conversations.map((c) => c.id))
  const flags = s.flags.filter((f) => f.topicId === input.topicId || (f.sessionId && ids.has(f.sessionId)))
  const drafter = input.conversations.find((c) => c.engine === 'claude') ?? null
  const g = gather(input.projectId, input.changed, flags, lastingEntries(drafter ? memory.homeOf(drafter) : null))
  if (!worthOffering(g)) return null
  // One open offer per topic: a second Send replaces the first, it does not stack.
  for (const o of s.offers) if (o.topicId === input.topicId && o.state === 'open') o.state = 'dismissed'
  const offer: DocsOffer = {
    id: newId('doffer_'),
    projectId: input.projectId,
    sessionId: drafter?.id ?? null,
    topicId: input.topicId,
    moment: 'send',
    label: input.label,
    createdAt: Date.now(),
    ...g,
    state: 'open',
    setId: null,
  }
  s.offers.push(offer)
  save(input.projectId, s)
  append({
    type: 'docs.offered',
    // On the conversation's thread, where it is drawn as a line.
    actor: drafter ? { kind: 'agent', engine: drafter.engine, sessionId: drafter.id } : { kind: 'system' },
    projectId: input.projectId,
    payload: { offerId: offer.id, pages: offer.pages.length, memory: offer.memory.length },
  })
  return offer
}

/**
 * In a `/next` handoff: what this conversation's agent changed and flagged,
 * and its memory's lasting entries. Not offered — `/next` is already the
 * moment, and its turn drafts — but recorded the same way, so the flags go
 * once the draft is decided.
 */
export function forHandoff(c: Conversation, touched: string[]): DocsOffer | null {
  const projectId = projectOf(c)
  if (!projectId || !docs.docsOf(projectId)) return null
  const s = signals(projectId)
  const flags = s.flags.filter((f) => f.sessionId === c.id)
  const g = gather(projectId, touched, flags, lastingEntries(memory.homeOf(c)))
  if (!worthOffering(g)) return null
  return {
    id: newId('doffer_'),
    projectId,
    sessionId: c.id,
    topicId: c.topicId ?? null,
    moment: 'next',
    label: '/next',
    createdAt: Date.now(),
    ...g,
    state: 'open',
    setId: null,
  }
}

export function getOffer(offerId: string, projectId?: string): DocsOffer | null {
  if (projectId) return load(projectId).offers.find((o) => o.id === offerId) ?? null
  // The offer's id does not carry its project: look in each file there is.
  const dir = join(attachmentsRoot(), 'docs-signals')
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir)) {
    const hit = load(name.replace(/\.json$/, '')).offers.find((o) => o.id === offerId)
    if (hit) return hit
  }
  return null
}

/** The offer is being drafted, in set `setId`. Saved even for a handoff's, which was never shown. */
export function drafting(offer: DocsOffer, setId: string): void {
  const s = load(offer.projectId)
  const at = s.offers.findIndex((o) => o.id === offer.id)
  const next = { ...offer, state: 'drafting' as const, setId }
  if (at >= 0) s.offers[at] = next
  else s.offers.push(next)
  save(offer.projectId, s)
}

/** "Not now": the offer goes, and its flags with it — they were seen and let go. */
export function dismiss(offerId: string): void {
  const o = getOffer(offerId)
  if (!o) return
  const s = load(o.projectId)
  for (const x of s.offers) if (x.id === offerId) x.state = 'dismissed'
  s.flags = s.flags.filter((f) => !o.flagIds.includes(f.id))
  save(o.projectId, s)
}

/** The Document step's scope, for the prompt. */
export function scopeOf(offer: DocsOffer, docsRoot: string): DocumentScope {
  return { docsRoot, pages: offer.pages, memory: offer.memory }
}

/** The pages to copy: those that exist. A missing one is written into the copy fresh. */
export function pagesToCopy(offer: DocsOffer): string[] {
  return offer.pages.filter((p) => !p.missing).map((p) => p.path)
}
