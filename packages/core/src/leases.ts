import { resolve } from 'node:path'
import { newId } from '@cockpit/shared'
import type { LeaseInfo } from '@cockpit/shared'
import { getDb } from './db.js'
import { append } from './journal.js'

/**
 * §7 — "Une session prend un bail sur un ensemble de sous-arbres."
 * The lock is on PATHS, never on features, so it behaves identically in a
 * structured C3 and in a C0 yolo on the main checkout.
 */

interface Row {
  id: string
  holder: string
  paths: string
  acquired_at: number
  expires_at: number | null
  reason: string
}

function hydrate(r: Row): LeaseInfo {
  return {
    id: r.id,
    holder: r.holder,
    paths: JSON.parse(r.paths) as string[],
    acquiredAt: r.acquired_at,
    expiresAt: r.expires_at,
    reason: r.reason,
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
}

/** Refuses any scope that overlaps a live lease. Silent corruption is the
 *  failure mode this exists to prevent. */
export function acquire(opts: {
  holder: string
  paths: string[]
  reason: string
  ttlMs?: number | null
}): AcquireResult {
  expireStale()
  const current = list()
  for (const p of opts.paths) {
    for (const lease of current) {
      const hit = lease.paths.find((lp) => overlaps(p, lp))
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
  }
  getDb()
    .prepare('INSERT INTO leases (id, holder, paths, acquired_at, expires_at, reason) VALUES (?,?,?,?,?,?)')
    .run(lease.id, lease.holder, JSON.stringify(lease.paths), lease.acquiredAt, lease.expiresAt, lease.reason)
  append({ type: 'lease.acquired', payload: { id: lease.id, paths: lease.paths, holder: lease.holder } })
  return { ok: true, lease }
}

export function release(id: string): void {
  const row = getDb().prepare('SELECT * FROM leases WHERE id = ?').get(id) as Row | undefined
  getDb().prepare('DELETE FROM leases WHERE id = ?').run(id)
  if (row) append({ type: 'lease.released', payload: { id, paths: JSON.parse(row.paths) } })
}

export function leaseCovering(path: string): LeaseInfo | null {
  return list().find((l) => l.paths.some((lp) => overlaps(path, lp))) ?? null
}

/** §13 — the core must survive its own death; stale leases go at boot. */
export function releaseAll(reason: string): number {
  const n = list().length
  getDb().prepare('DELETE FROM leases').run()
  if (n) append({ type: 'lease.released', payload: { reason, count: n } })
  return n
}
