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
const SCHEMA_VERSION = 5

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
  // v3 → v4, and it has to run before the CREATE TABLEs below: those would
  // otherwise make an empty `topics` beside the populated `features` and
  // orphan every record in it. The rename is the vocabulary pass — a feature
  // is a topic, its ceremony is its setup, and its three states say what they
  // mean — so nothing here changes shape, only names.
  renameTable(d, 'features', 'topics')
  renameColumn(d, 'topics', 'ceremony', 'setup')
  renameColumn(d, 'agent_sessions', 'feature_id', 'topic_id')
  // The index follows the table through a rename, under its old name; the
  // CREATE below would then make a second one over the same column.
  d.exec('DROP INDEX IF EXISTS features_project')

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

    -- §7 — leases are on paths, never on topics.
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
      -- Vestigial: nothing writes or reads it since the cost display was
      -- dropped. Kept so an existing database still opens unmodified.
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

    -- §4 — the durable half of the model. Worktrees, branches and running
    -- processes are all probed; what cannot be probed is the intent that
    -- grouped them, and that is the only thing this table holds.
    CREATE TABLE IF NOT EXISTS topics (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      name         TEXT NOT NULL,
      slug         TEXT NOT NULL,
      root_path    TEXT,
      state        TEXT NOT NULL,
      setup     TEXT NOT NULL,
      ticket       TEXT,
      review       TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS topics_project ON topics(project_id, updated_at DESC);
  `)

  // Added in v2. `CREATE TABLE IF NOT EXISTS` cannot add a column to a table
  // that already exists, and an adopted v1 database has agent_sessions in it.
  addColumn(d, 'agent_sessions', 'topic_id', 'TEXT')
  addColumn(d, 'agent_sessions', 'engine_session_id', 'TEXT')
  addColumn(d, 'agent_sessions', 'prompt', "TEXT NOT NULL DEFAULT ''")

  // Added in v3 — §7's scope, and §6's conversation.
  //
  // `scope_kind` defaults to 'workspace' because that is what every v2 session
  // actually was: a set of paths under one checkout, or a topic's worktrees
  // with `topic_id` set. `backfillScopes` below reads the latter back into a
  // topic scope rather than leaving old sessions mislabelled.
  addColumn(d, 'agent_sessions', 'scope_kind', "TEXT NOT NULL DEFAULT 'workspace'")
  addColumn(d, 'agent_sessions', 'scope_id', "TEXT NOT NULL DEFAULT ''")
  addColumn(d, 'agent_sessions', 'scope_subpath', 'TEXT')
  addColumn(d, 'agent_sessions', 'title', "TEXT NOT NULL DEFAULT ''")

  // Added in v5 — §16's refusals, kept rather than merely logged. A session
  // that stopped because the allow-list said no looks exactly like one that
  // finished, and the window has no way to tell them apart without this.
  addColumn(d, 'agent_sessions', 'denials', "TEXT NOT NULL DEFAULT '[]'")

  d.exec(`
    -- §6 — the conversation. Append-only: a resume adds a row, it never
    -- overwrites the question that opened the thread.
    CREATE TABLE IF NOT EXISTS agent_turns (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      prompt     TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER,
      cost_usd   REAL NOT NULL DEFAULT 0,  -- vestigial, see agent_sessions
      status     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_turn_session ON agent_turns(session_id, seq);
  `)

  remapVocabulary(d)
  backfillScopes(d)
}

/**
 * v3 → v4 — the same rename, carried into the values. A topic that was `live`
 * is `running`, one that was `parked` is `stopped`, one that was `archived` is
 * `closed`; the setup levels drop the C-codes for what they actually do.
 *
 * Idempotent, because every one of these is a no-op once it has run.
 */
function remapVocabulary(d: Db): void {
  if (!hasTable(d, 'topics')) return
  const state = d.prepare('UPDATE topics SET state = ? WHERE state = ?')
  state.run('running', 'live')
  state.run('stopped', 'parked')
  state.run('closed', 'archived')

  const setup = d.prepare('UPDATE topics SET setup = ? WHERE setup = ?')
  setup.run('none', 'C0')
  setup.run('branch', 'C1')
  setup.run('isolated', 'C2')
  setup.run('full', 'C3')

  if (hasColumn(d, 'agent_sessions', 'scope_kind')) {
    d.prepare("UPDATE agent_sessions SET scope_kind = 'topic' WHERE scope_kind = 'feature'").run()
  }
}

function hasTable(d: Db, table: string): boolean {
  return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table)
}

function hasColumn(d: Db, table: string, column: string): boolean {
  if (!hasTable(d, table)) return false
  const cols = d.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[]
  return cols.some((c) => c.name === column)
}

/** Idempotent rename: absent source, or a target already there, is a no-op. */
function renameTable(d: Db, from: string, to: string): void {
  if (!hasTable(d, from) || hasTable(d, to)) return
  d.exec('ALTER TABLE ' + from + ' RENAME TO ' + to)
}

function renameColumn(d: Db, table: string, from: string, to: string): void {
  if (!hasColumn(d, table, from) || hasColumn(d, table, to)) return
  d.exec('ALTER TABLE ' + table + ' RENAME COLUMN ' + from + ' TO ' + to)
}

/**
 * v2 → v3. Every existing session becomes a conversation with one turn, so the
 * history view is not empty for work that predates it, and a session that ran
 * under a topic is labelled as a topic scope rather than as a workspace
 * one. Idempotent: `scope_id` is only empty before this has run.
 */
function backfillScopes(d: Db): void {
  const rows = d
    .prepare("SELECT id, topic_id, workspace_ids, prompt, started_at, ended_at, cost_usd, status FROM agent_sessions WHERE scope_id = ''")
    .all() as Record<string, unknown>[]
  if (!rows.length) return

  const setScope = d.prepare('UPDATE agent_sessions SET scope_kind = ?, scope_id = ?, title = ? WHERE id = ?')
  const addTurn = d.prepare(
    'INSERT OR IGNORE INTO agent_turns (id, session_id, seq, prompt, started_at, ended_at, cost_usd, status) VALUES (?,?,?,?,?,?,?,?)',
  )
  const tx = d.transaction(() => {
    for (const r of rows) {
      const id = String(r.id)
      const topicId = r.topic_id == null ? '' : String(r.topic_id)
      let wsId = ''
      try {
        wsId = (JSON.parse(String(r.workspace_ids)) as string[])[0] ?? ''
      } catch {
        wsId = ''
      }
      const kind = topicId ? 'topic' : 'workspace'
      const scopeId = topicId || wsId
      // A session whose only workspace is gone has nothing to point at; it
      // keeps its journal and its cost, and reads as scopeless in the list.
      const prompt = r.prompt == null ? '' : String(r.prompt)
      setScope.run(kind, scopeId, prompt.slice(0, 200), id)
      const status = String(r.status)
      addTurn.run(
        'turn_' + id + '_1',
        id,
        1,
        prompt,
        Number(r.started_at),
        r.ended_at === null ? null : Number(r.ended_at),
        Number(r.cost_usd ?? 0),
        status === 'failed' ? 'failed' : status === 'ended' ? 'done' : 'running',
      )
    }
  })
  tx()
}

/** Idempotent ALTER, so migrating an adopted database never loses its journal. */
function addColumn(d: Db, table: string, column: string, decl: string): void {
  const cols = d.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[]
  if (cols.some((c) => c.name === column)) return
  d.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + decl)
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
