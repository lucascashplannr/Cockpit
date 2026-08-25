import Database from 'better-sqlite3'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { COCKPIT_HOME, ensureHome } from './config.js'

/**
 * §13 rule 3 — the core persists the journal, not the state. Everything in
 * here is either append-only history or a cache that may be thrown away and
 * rebuilt by probing.
 */
export type Db = Database.Database

/**
 * Bump on any incompatible change to the tables below. `CREATE TABLE IF NOT
 * EXISTS` alone is not a migration strategy: against a database written by a
 * different schema it silently no-ops on the tables and then fails on the
 * indexes, which is exactly the kind of opaque breakage §13 rule 3 exists to
 * avoid.
 */
const SCHEMA_VERSION = 1

export type SchemaOutcome =
  | { kind: 'fresh' }
  | { kind: 'current' }
  | { kind: 'adopted' }
  | { kind: 'replaced'; movedTo: string }

let db: Db | null = null
let outcome: SchemaOutcome = { kind: 'current' }

/** What happened to the schema at open time, so the daemon can report it. */
export function schemaOutcome(): SchemaOutcome {
  return outcome
}

const DB_NAME = 'cockpit.db'
/** SQLite keeps its journal beside the file; all three move together. */
const SIDECARS = ['', '-wal', '-shm']

export function getDb(): Db {
  if (db) return db
  ensureHome()
  const path = join(COCKPIT_HOME, DB_NAME)

  let d = open(path)
  const decision = inspect(d)

  if (decision === 'replace') {
    // §16 — a bin with a lifetime, never an immediate delete. The old journal
    // belongs to the user even when this core cannot read it.
    d.close()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const movedTo = path + '.' + stamp + '.bak'
    for (const ext of SIDECARS) {
      const from = path + ext
      if (existsSync(from)) renameSync(from, movedTo + ext)
    }
    d = open(path)
    migrate(d)
    d.pragma('user_version = ' + SCHEMA_VERSION)
    outcome = { kind: 'replaced', movedTo }
  } else {
    migrate(d)
    d.pragma('user_version = ' + SCHEMA_VERSION)
    outcome =
      decision === 'fresh' ? { kind: 'fresh' } : decision === 'adopt' ? { kind: 'adopted' } : { kind: 'current' }
  }

  db = d
  return db
}

function open(path: string): Db {
  const d = new Database(path)
  d.pragma('journal_mode = WAL')
  d.pragma('synchronous = NORMAL')
  return d
}

type Decision = 'fresh' | 'current' | 'adopt' | 'replace'

function inspect(d: Db): Decision {
  const version = Number(d.pragma('user_version', { simple: true }) ?? 0)

  if (version > SCHEMA_VERSION) {
    throw new Error(
      'this ~/.cockpit database was written by a newer core (schema v' +
        version +
        ', this core speaks v' +
        SCHEMA_VERSION +
        '). Refusing to downgrade it — upgrade the core, or move the file aside.',
    )
  }
  if (version === SCHEMA_VERSION) return 'current'

  // version 0: either a brand-new file, a database this core wrote before
  // versioning existed, or one belonging to an entirely different program.
  const tables = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[]
  if (!tables.length) return 'fresh'

  const events = tables.find((t) => t.name === 'events')
  if (!events) return 'replace'

  // The discriminator: our journal keys events by workspace_id / project_id.
  const columns = d.prepare('PRAGMA table_info(events)').all() as { name: string }[]
  const ours = columns.some((c) => c.name === 'workspace_id') && columns.some((c) => c.name === 'project_id')
  return ours ? 'adopt' : 'replace'
}

function migrate(d: Db): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      id          TEXT NOT NULL UNIQUE,
      ts          INTEGER NOT NULL,
      type        TEXT NOT NULL,
      level       TEXT NOT NULL,
      actor       TEXT NOT NULL,
      project_id  TEXT,
      workspace_id TEXT,
      payload     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_ts       ON events(ts DESC);
    CREATE INDEX IF NOT EXISTS events_ws       ON events(workspace_id, ts DESC);
    CREATE INDEX IF NOT EXISTS events_type     ON events(type, ts DESC);

    -- Cache only. Dropping this table must never lose information (§3.4).
    CREATE TABLE IF NOT EXISTS workspace_cache (
      id      TEXT PRIMARY KEY,
      json    TEXT NOT NULL,
      updated INTEGER NOT NULL
    );

    -- Which process/port we started, so orphans can be reaped at boot (§13).
    CREATE TABLE IF NOT EXISTS processes (
      id          TEXT PRIMARY KEY,
      workspace_id TEXT,
      label       TEXT NOT NULL,
      pid         INTEGER,
      cwd         TEXT NOT NULL,
      command     TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      status      TEXT NOT NULL,
      exit_code   INTEGER
    );

    -- §7 — leases are on paths, never on features.
    CREATE TABLE IF NOT EXISTS leases (
      id          TEXT PRIMARY KEY,
      holder      TEXT NOT NULL,
      paths       TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at  INTEGER,
      reason      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id          TEXT PRIMARY KEY,
      engine      TEXT NOT NULL,
      paths       TEXT NOT NULL,
      workspace_ids TEXT NOT NULL,
      status      TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      cost_usd    REAL NOT NULL DEFAULT 0,
      turns       INTEGER NOT NULL DEFAULT 0,
      lease_id    TEXT,
      last_message TEXT
    );

    -- Restore points, so undo is backed by something real (§16).
    CREATE TABLE IF NOT EXISTS restore_points (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      ref          TEXT NOT NULL,
      head         TEXT NOT NULL,
      strategy     TEXT NOT NULL,
      reason       TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS restore_ws ON restore_points(workspace_id, created_at DESC);

    -- §12 — attribution of a diff to human vs agent, keyed by path.
    CREATE TABLE IF NOT EXISTS touches (
      workspace_id TEXT NOT NULL,
      path         TEXT NOT NULL,
      actor        TEXT NOT NULL,
      session_id   TEXT,
      ts           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS touches_ws ON touches(workspace_id, path);
  `)
}

/** §13 — log rotation: a permanent service fills a disk in weeks. */
export function pruneJournal(retentionDays: number): number {
  const d = getDb()
  const cutoff = Date.now() - retentionDays * 86_400_000
  const res = d
    .prepare("DELETE FROM events WHERE ts < ? AND type NOT IN ('git.applied','git.restore_point','memory.promoted')")
    .run(cutoff)
  d.prepare('DELETE FROM touches WHERE ts < ?').run(cutoff)
  return res.changes
}
