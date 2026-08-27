import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DatabasePlan, PlanStep } from '@cockpit/shared'
import { which } from './exec.js'

/**
 * §10 — "une base par workspace", the third thing that is global and will
 * collide.
 *
 * Ports are solved (§11) and hostnames are solved (§8, scoped names), but two
 * worktrees still share one database, so an agent running a migration in one
 * breaks the other. Folder isolation cannot help with this: the collision is
 * on the server, not on disk.
 *
 * Everything here is read out of the repository's own `.env`, because that is
 * where the answer already is — asking the user to restate a connection they
 * have already configured is exactly what §3.5 forbids.
 */

export type Engine = 'mysql' | 'pgsql' | 'sqlite'

export interface Connection {
  engine: Engine
  host: string
  port: string
  user: string
  /** Never rendered into a command; passed through the environment (§16). */
  password: string
  database: string
  /** For sqlite, the file — which the worktree seed already carries (§7). */
  file: string | null
}

const ENV_FILES = ['.env', '.env.local']

function parseEnv(text: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    const v = line.slice(eq + 1).trim()
    const unq = /^(['"])([\s\S]*)\1$/.exec(v)
    m.set(key, unq ? unq[2]! : v)
  }
  return m
}

/** The `.env` a checkout actually uses, if it has one. */
function envOf(repoPath: string): Map<string, string> | null {
  for (const f of ENV_FILES) {
    const p = join(repoPath, f)
    if (!existsSync(p)) continue
    try {
      return parseEnv(readFileSync(p, 'utf8'))
    } catch {
      return null
    }
  }
  return null
}

/**
 * A database the checkout names without saying which engine serves it —
 * common enough, since frameworks have a default. Cockpit will not guess the
 * engine, but it must not stay quiet either: the worktree's `.env` was just
 * pointed at a database that does not exist yet, and the user needs to know.
 */
export function namedDatabase(repoPath: string): string | null {
  const env = envOf(repoPath)
  if (!env) return null
  return env.get('DB_DATABASE') ?? env.get('DB_NAME') ?? null
}

/** Reads the connection a checkout actually uses. Null when it uses none. */
export function connectionOf(repoPath: string): Connection | null {
  const env = envOf(repoPath)
  if (!env) return null

  const raw = (env.get('DB_CONNECTION') ?? '').toLowerCase()
  const database = env.get('DB_DATABASE') ?? env.get('DB_NAME') ?? ''
  if (!raw && !database) return null

  const engine: Engine | null =
    raw === 'mysql' || raw === 'mariadb'
      ? 'mysql'
      : raw === 'pgsql' || raw === 'postgres' || raw === 'postgresql'
        ? 'pgsql'
        : raw === 'sqlite'
          ? 'sqlite'
          : null
  if (!engine) return null

  return {
    engine,
    host: env.get('DB_HOST') ?? '127.0.0.1',
    port: env.get('DB_PORT') ?? (engine === 'mysql' ? '3306' : '5432'),
    user: env.get('DB_USERNAME') ?? env.get('DB_USER') ?? 'root',
    password: env.get('DB_PASSWORD') ?? env.get('DB_PASS') ?? '',
    database,
    file: engine === 'sqlite' ? (database || join(repoPath, 'database', 'database.sqlite')) : null,
  }
}

/**
 * §16 — the password goes here and nowhere else. Both clients read it from
 * the environment, which keeps it out of the previewed plan, out of the
 * journal, and out of anyone else's `ps` output.
 */
export function envFor(conn: Connection): Record<string, string> {
  if (!conn.password) return {}
  return conn.engine === 'mysql' ? { MYSQL_PWD: conn.password } : { PGPASSWORD: conn.password }
}

function mysqlAuth(conn: Connection): string {
  return '--host=' + conn.host + ' --port=' + conn.port + ' --user=' + conn.user
}

function pgAuth(conn: Connection): string {
  return '--host=' + conn.host + ' --port=' + conn.port + ' --username=' + conn.user
}

/** Which client binaries this engine needs, and whether they are installed. */
export async function tooling(engine: Engine): Promise<{ bin: string; found: boolean }[]> {
  const needed =
    engine === 'mysql'
      ? ['mysql', 'mysqldump']
      : engine === 'pgsql'
        ? ['createdb', 'dropdb', 'psql']
        : []
  return Promise.all(needed.map(async (bin) => ({ bin, found: !!(await which(bin)) })))
}

/**
 * The steps that give a worktree its own copy of the main checkout's data.
 *
 * No pipes anywhere: a plan step is an argv, not a shell line, so the MySQL
 * path dumps to a file and loads it with the client's own `source` rather than
 * `mysqldump | mysql`. That is also what keeps the command in the preview the
 * literal command that runs.
 */
export function clonePlan(conn: Connection, target: string, cwd: string): PlanStep[] {
  if (conn.engine === 'sqlite') return []
  if (!conn.database) return []

  if (conn.engine === 'pgsql') {
    return [
      {
        title: 'Clone ' + conn.database + ' → ' + target,
        // Postgres clones a database natively. It refuses while anyone is
        // connected to the source, and that refusal is worth surfacing as-is:
        // silently falling back to a dump would hide an open psql session.
        command:
          'createdb ' + pgAuth(conn) + ' --template=' + conn.database + ' ' + target,
        cwd,
        destructive: false,
        run: 'createdb',
        undo: [
          {
            title: 'Drop ' + target,
            command: 'dropdb ' + pgAuth(conn) + ' --if-exists ' + target,
            cwd,
            run: 'dropdb',
          },
        ],
      },
    ]
  }

  const dump = join(tmpdir(), 'cockpit-' + target + '.sql')
  return [
    {
      title: 'Create database ' + target,
      command: 'mysql ' + mysqlAuth(conn) + ' "--execute=CREATE DATABASE IF NOT EXISTS `' + target + '`"',
      cwd,
      destructive: false,
      run: 'mysql',
      undo: [
        {
          title: 'Drop ' + target,
          command: 'mysql ' + mysqlAuth(conn) + ' "--execute=DROP DATABASE IF EXISTS `' + target + '`"',
          cwd,
          run: 'mysql',
        },
      ],
    },
    {
      title: 'Dump ' + conn.database,
      command:
        'mysqldump ' + mysqlAuth(conn) +
        ' --single-transaction --routines --events --result-file=' + dump + ' ' + conn.database,
      cwd,
      destructive: false,
      run: 'mysqldump',
    },
    {
      title: 'Load it into ' + target,
      command: 'mysql ' + mysqlAuth(conn) + ' --database=' + target + ' "--execute=SOURCE ' + dump + '"',
      cwd,
      destructive: false,
      run: 'mysql',
    },
  ]
}

/** §16 — dropping data is the one thing nothing brings back, so it is red. */
export function dropPlan(conn: Connection, target: string, cwd: string): PlanStep[] {
  if (conn.engine === 'sqlite' || !target) return []
  if (conn.engine === 'pgsql') {
    return [
      {
        title: 'Drop database ' + target,
        command: 'dropdb ' + pgAuth(conn) + ' --if-exists ' + target,
        cwd,
        destructive: true,
        run: 'dropdb',
      },
    ]
  }
  return [
    {
      title: 'Drop database ' + target,
      command: 'mysql ' + mysqlAuth(conn) + ' "--execute=DROP DATABASE IF EXISTS `' + target + '`"',
      cwd,
      destructive: true,
      run: 'mysql',
    },
  ]
}

/** What the UI shows before any of this runs. */
export async function preview(
  repoPath: string,
  target: string,
): Promise<DatabasePlan | null> {
  const conn = connectionOf(repoPath)
  if (!conn) {
    const named = namedDatabase(repoPath)
    if (!named) return null
    return {
      repo: basename(repoPath),
      engine: 'unknown',
      from: named,
      to: null,
      detail:
        'this checkout names ' + named + ' but no DB_CONNECTION, so Cockpit will not guess the ' +
        'engine. The worktree gets its own name in .env — create that database yourself.',
      missingTools: [],
    }
  }
  const missing = (await tooling(conn.engine)).filter((t) => !t.found).map((t) => t.bin)
  return {
    repo: basename(repoPath),
    engine: conn.engine,
    from: conn.database,
    to: conn.engine === 'sqlite' ? null : target,
    // sqlite needs nothing: its database is a file in the repository, and the
    // worktree seed (§7) already carries it across with the rest of the
    // gitignored config. One mechanism, not two.
    detail:
      conn.engine === 'sqlite'
        ? 'sqlite — the file is carried by the worktree seed, no server involved'
        : conn.database
          ? 'a copy of ' + conn.database + ', so a migration here cannot break the others'
          : 'no DB_DATABASE in this checkout',
    missingTools: missing,
  }
}
