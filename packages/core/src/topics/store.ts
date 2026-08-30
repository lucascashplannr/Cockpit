import type { Setup, TopicState, ReviewRef, TicketRef } from '@cockpit/shared'
import { getDb } from '../db.js'

/**
 * §3.4 — "Sonder, ne jamais se souvenir." Worktrees, branches, ports and
 * processes are all probed on demand, so none of them belong in a table.
 *
 * What cannot be probed is the *intent* that grouped them: that these three
 * worktrees are one piece of work, that it is called "Two-factor auth", that
 * it is parked rather than abandoned. That is the whole of this table, and the
 * reason a topic survives a reboot when a session does not (§6).
 */
export interface TopicRecord {
  id: string
  projectId: string
  name: string
  slug: string
  rootPath: string | null
  state: TopicState
  setup: Setup
  ticket: TicketRef | null
  review: ReviewRef | null
  createdAt: number
  updatedAt: number
}

interface Row {
  id: string
  project_id: string
  name: string
  slug: string
  root_path: string | null
  state: string
  setup: string
  ticket: string | null
  review: string | null
  created_at: number
  updated_at: number
}

function parse<T>(json: string | null): T | null {
  if (!json) return null
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

function hydrate(r: Row): TopicRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    slug: r.slug,
    rootPath: r.root_path,
    state: r.state as TopicState,
    setup: r.setup as Setup,
    ticket: parse<TicketRef>(r.ticket),
    review: parse<ReviewRef>(r.review),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function list(projectId?: string): TopicRecord[] {
  const rows = projectId
    ? (getDb()
        .prepare('SELECT * FROM topics WHERE project_id = ? ORDER BY updated_at DESC')
        .all(projectId) as Row[])
    : (getDb().prepare('SELECT * FROM topics ORDER BY updated_at DESC').all() as Row[])
  return rows.map(hydrate)
}

export function get(id: string): TopicRecord | null {
  const row = getDb().prepare('SELECT * FROM topics WHERE id = ?').get(id) as Row | undefined
  return row ? hydrate(row) : null
}

export function bySlug(projectId: string, slug: string): TopicRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM topics WHERE project_id = ? AND slug = ?')
    .get(projectId, slug) as Row | undefined
  return row ? hydrate(row) : null
}

export function save(f: TopicRecord): TopicRecord {
  getDb()
    .prepare(
      `INSERT INTO topics (id, project_id, name, slug, root_path, state, setup, ticket, review, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, slug=excluded.slug, root_path=excluded.root_path,
         state=excluded.state, setup=excluded.setup, ticket=excluded.ticket, review=excluded.review,
         updated_at=excluded.updated_at`,
    )
    .run(
      f.id,
      f.projectId,
      f.name,
      f.slug,
      f.rootPath,
      f.state,
      f.setup,
      f.ticket ? JSON.stringify(f.ticket) : null,
      f.review ? JSON.stringify(f.review) : null,
      f.createdAt,
      f.updatedAt,
    )
  return f
}

export function patch(id: string, fn: (f: TopicRecord) => void): TopicRecord | null {
  const f = get(id)
  if (!f) return null
  fn(f)
  f.updatedAt = Date.now()
  return save(f)
}

export function remove(id: string): void {
  getDb().prepare('DELETE FROM topics WHERE id = ?').run(id)
}

/**
 * Branch- and folder-safe, and stable: the same name always yields the same
 * slug, so re-opening a topic after a crash lands on the same worktrees.
 * Git refuses names with `..`, a trailing `.lock`, and a leading `-`.
 */
export { slugify } from '@cockpit/shared'
