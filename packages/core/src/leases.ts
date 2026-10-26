import { resolve } from 'node:path'
import { newId } from '@cockpit/shared'
import type { LeaseInfo } from '@cockpit/shared'
import { getDb } from './db.js'
import { append } from './journal.js'

/**
 * §7 — "Une session prend un bail sur un ensemble de sous-arbres."
 * The lock is on PATHS, never on topics, so it behaves identically in a
 * structured C3 and in a C0 yolo on the main checkout.
 *
 * A lock is exclusive unless it is held Alongside (`shared`). Two shared locks
 * may overlap; an exclusive one overlaps nothing. A shared request may turn an
 * overlapping exclusive lock into a shared one, but only when the caller says
 * that lock may be shared — a running conversation, never a leftover.
 */

interface Row {
  id: string
  holder: string
  paths: string
  acquired_at: number
  expires_at: number | null
  reason: string
  shared?: number
}

function hydrate(r: Row): LeaseInfo {
  return {
    id: r.id,
    holder: r.holder,
    paths: JSON.parse(r.paths) as string[],
    acquiredAt: r.acquired_at,
    expiresAt: r.expires_at,
    reason: r.reason,
    shared: !!r.shared,
  }
}

function overlaps(a: string, b: string): boolean {
  const pa = resolve(a)
  const pb = resolve(b)
  return pa === pb || pa.startsWith(pb + '/') || pb.startsWith(pa + '/')
}

export function list(): LeaseInfo[] {
  expireStale()
  const rows = getDb().prepare('SELECT * FROM leases ORDER BY acquired_at DESC').all() as Row[]
  return rows.map(hydrate)
}

function expireStale(): void {
  getDb().prepare('DELETE FROM leases WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now())
}

export interface AcquireResult {
  ok: boolean
  lease?: LeaseInfo
  conflict?: { lease: LeaseInfo; path: string }
  /** The exclusive locks this request turned into shared ones. */
  sharedWith?: string[]
}

/** Refuses any scope that overlaps a live lease. Silent corruption is the
 *  failure mode this exists to prevent. */
export function acquire(opts: {
  holder: string
  paths: string[]
  reason: string
  ttlMs?: number | null
  /** Alongside: overlaps other shared locks, and may share an exclusive one `share` allows. */
  shared?: boolean
  share?: (lease: LeaseInfo) => boolean
}): AcquireResult {
  expireStale()
  const current = list()
  // Only once every overlap has been judged: a request that is refused on its
  // third path must not have shared the lock on its first.
  const toShare = new Set<string>()
  for (const p of opts.paths) {
    for (const lease of current) {
      const hit = lease.paths.find((lp) => overlaps(p, lp))
      if (hit && opts.shared && lease.shared) continue
      if (hit && opts.shared && opts.share?.(lease)) {
        toShare.add(lease.id)
        continue
      }
      if (hit) {
        append({
          type: 'lease.denied',
          level: 'warn',
          payload: { requested: opts.paths, holder: opts.holder, conflictsWith: lease.id, path: hit },
        })
        return { ok: false, conflict: { lease, path: hit } }
      }
    }
  }

  const lease: LeaseInfo = {
    id: newId('lease_'),
    holder: opts.holder,
    paths: opts.paths.map((p) => resolve(p)),
    acquiredAt: Date.now(),
    expiresAt: opts.ttlMs ? Date.now() + opts.ttlMs : null,
    reason: opts.reason,
    shared: !!opts.shared,
  }
  const db = getDb()
  for (const id of toShare) db.prepare('UPDATE leases SET shared = 1 WHERE id = ?').run(id)
  db.prepare('INSERT INTO leases (id, holder, paths, acquired_at, expires_at, reason, shared) VALUES (?,?,?,?,?,?,?)').run(
    lease.id,
    lease.holder,
    JSON.stringify(lease.paths),
    lease.acquiredAt,
    lease.expiresAt,
    lease.reason,
    lease.shared ? 1 : 0,
  )
  append({
    type: 'lease.acquired',
    payload: { id: lease.id, paths: lease.paths, holder: lease.holder, shared: !!lease.shared, ...(toShare.size ? { sharedWith: [...toShare] } : {}) },
  })
  return { ok: true, lease, sharedWith: [...toShare] }
}

export function release(id: string): void {
  const row = getDb().prepare('SELECT * FROM leases WHERE id = ?').get(id) as Row | undefined
  getDb().prepare('DELETE FROM leases WHERE id = ?').run(id)
  if (row) append({ type: 'lease.released', payload: { id, paths: JSON.parse(row.paths) } })
}

export function leaseCovering(path: string): LeaseInfo | null {
  return leasesCovering(path)[0] ?? null
}

/** Every lock on a path: more than one only Alongside. */
export function leasesCovering(path: string): LeaseInfo[] {
  return list().filter((l) => l.paths.some((lp) => overlaps(path, lp)))
}

/** §13 — the core must survive its own death; stale leases go at boot. */
export function releaseAll(reason: string): number {
  const n = list().length
  getDb().prepare('DELETE FROM leases').run()
  if (n) append({ type: 'lease.released', payload: { reason, count: n } })
  return n
}
