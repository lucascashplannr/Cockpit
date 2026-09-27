import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DatabasePlan, PlanStep } from '@cockpit/shared'
import { run, which } from './exec.js'

const IS_WIN = process.platform === 'win32'

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
  /**
   * Whether the server is on this machine. Only a local one is cloned or
   * dropped: a `DB_HOST` naming a shared or hosted server is somebody else's
   * data, and a topic that quietly created — or at close, dropped — databases
   * there would be the worst thing Cockpit could do with a `.env`.
   */
  local: boolean
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

/** Whether a `DB_HOST` is this machine. An absent one is: every framework defaults to loopback. */
export function isLocalHost(host: string | undefined): boolean {
  return !host || LOCAL_HOSTS.has(host.toLowerCase())
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

  const host = env.get('DB_HOST') ?? '127.0.0.1'
  return {
    engine,
    host,
    port: env.get('DB_PORT') ?? (engine === 'mysql' ? '3306' : '5432'),
    user: env.get('DB_USERNAME') ?? env.get('DB_USER') ?? 'root',
    password: env.get('DB_PASSWORD') ?? env.get('DB_PASS') ?? '',
    database,
    file: engine === 'sqlite' ? (database || join(repoPath, 'database', 'database.sqlite')) : null,
    local: engine === 'sqlite' || isLocalHost(host),
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

/**
 * `--protocol=TCP` because the connection is a host and a port: `localhost`
 * otherwise makes the client look for its compiled-in socket, and DBngin's
 * server listens on `/tmp/mysql_3306.sock`, not the one the client expects.
 */
function mysqlAuth(conn: Connection): string {
  return '--host=' + conn.host + ' --port=' + conn.port + ' --user=' + conn.user + ' --protocol=TCP'
}

function pgAuth(conn: Connection): string {
  return '--host=' + conn.host + ' --port=' + conn.port + ' --username=' + conn.user
}

const NEEDED: Record<Exclude<Engine, 'sqlite'>, string[]> = {
  mysql: ['mysql', 'mysqldump'],
  pgsql: ['createdb', 'dropdb', 'psql'],
}

/** Every `<root>/<version>/bin`, newest version first. */
function versioned(root: string): string[] {
  try {
    return readdirSync(root)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => join(root, v, 'bin'))
  } catch {
    return []
  }
}

/**
 * Where the usual installers put the clients when they leave PATH alone —
 * which the GUI ones all do, so "not on PATH" was the normal case rather
 * than the exception.
 */
function knownDirs(engine: Exclude<Engine, 'sqlite'>): string[] {
  if (IS_WIN) {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    return engine === 'mysql'
      ? readdirSafe(join(pf, 'MySQL')).map((d) => join(pf, 'MySQL', d, 'bin'))
      : versioned(join(pf, 'PostgreSQL'))
  }
  return engine === 'mysql'
    ? [
        ...versioned('/Users/Shared/DBngin/mysql'),
        '/opt/homebrew/opt/mysql-client/bin',
        '/opt/homebrew/opt/mysql/bin',
        '/usr/local/opt/mysql-client/bin',
        '/usr/local/mysql/bin',
      ]
    : [
        ...versioned('/Users/Shared/DBngin/postgresql'),
        '/Applications/Postgres.app/Contents/Versions/latest/bin',
        '/opt/homebrew/opt/libpq/bin',
        '/usr/local/opt/libpq/bin',
      ]
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * The folder of the server actually listening on the port. Its clients sit
 * beside it (DBngin, Postgres.app, Homebrew all ship them together), and they
 * are the right version for that server by construction — which a `mysql`
 * found first on PATH is not.
 */
async function listenerDir(port: string): Promise<string | null> {
  if (IS_WIN) return null
  const l = await run('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], { timeoutMs: 4000 })
  const pid = l.stdout.trim().split('\n')[0]
  if (!l.ok || !pid) return null
  if (process.platform === 'linux') {
    try {
      return dirname(realpathSync('/proc/' + pid + '/exe'))
    } catch {
      return null
    }
  }
  const p = await run('ps', ['-o', 'comm=', '-p', pid], { timeoutMs: 4000 })
  const bin = p.stdout.trim()
  return p.ok && bin.startsWith('/') ? dirname(bin) : null
}

export interface Tools {
  /** Each client binary, as the path that will run. Absent when not found. */
  bins: Record<string, string>
  missing: string[]
  /** MySQL 9 refuses client commands such as `SOURCE` under `--execute` without it. */
  mysqlCommands: boolean
  /** A GTID server otherwise dumps a `GTID_PURGED` its own restore refuses. */
  mysqldumpGtid: boolean
}

/** Which client binaries this connection needs, and where each one is. */
export async function resolveTools(conn: Connection): Promise<Tools> {
  const empty: Tools = { bins: {}, missing: [], mysqlCommands: false, mysqldumpGtid: false }
  if (conn.engine === 'sqlite') return empty
  const exe = IS_WIN ? '.exe' : ''
  const beside = conn.local ? await listenerDir(conn.port) : null
  const dirs = [...(beside ? [beside] : []), ...knownDirs(conn.engine)]

  const bins: Record<string, string> = {}
  for (const bin of NEEDED[conn.engine]) {
    const first = beside && existsSync(join(beside, bin + exe)) ? join(beside, bin + exe) : null
    const found =
      first ??
      (await which(bin)) ??
      dirs.map((d) => join(d, bin + exe)).find((p) => existsSync(p)) ??
      null
    if (found) bins[bin] = found
  }
  const missing = NEEDED[conn.engine].filter((b) => !bins[b])

  // Older clients and MariaDB's do not know these flags and refuse the whole
  // command over one, so each is asked for only where `--help` lists it.
  const helps = async (bin: string, flag: string) =>
    !!bins[bin] && (await run(bins[bin]!, ['--help'], { timeoutMs: 4000 })).stdout.includes(flag)
  return {
    bins,
    missing,
    mysqlCommands: conn.engine === 'mysql' && (await helps('mysql', '--commands')),
    mysqldumpGtid: conn.engine === 'mysql' && (await helps('mysqldump', '--set-gtid-purged')),
  }
}

/**
 * A step's binary and the start of its command. The path is what `run`
 * names, so the plan runner's check that a step executes exactly the binary
 * it declared still holds; quoted, because Herd and Program Files both put
 * a space in it.
 */
function bin(tools: Tools, name: string): { run: string; cmd: string } {
  const path = tools.bins[name] ?? name
  return { run: path, cmd: /\s/.test(path) ? '"' + path + '"' : path }
}

/**
 * The steps that give a worktree its own copy of the main checkout's data.
 *
 * No pipes anywhere: a plan step is an argv, not a shell line, so the MySQL
 * path dumps to a file and loads it with the client's own `source` rather than
 * `mysqldump | mysql`. That is also what keeps the command in the preview the
 * literal command that runs.
 *
 * Empty for a server that is not on this machine — see `Connection.local`.
 */
export function clonePlan(conn: Connection, target: string, cwd: string, tools: Tools): PlanStep[] {
  if (conn.engine === 'sqlite' || !conn.local) return []
  if (!conn.database) return []

  if (conn.engine === 'pgsql') {
    const createdb = bin(tools, 'createdb')
    const dropdb = bin(tools, 'dropdb')
    return [
      {
        title: 'Clone ' + conn.database + ' → ' + target,
        // Postgres clones a database natively. It refuses while anyone is
        // connected to the source, and that refusal is worth surfacing as-is:
        // silently falling back to a dump would hide an open psql session.
        command: createdb.cmd + ' ' + pgAuth(conn) + ' --template=' + conn.database + ' ' + target,
        cwd,
        destructive: false,
        run: createdb.run,
        undo: [
          {
            title: 'Drop ' + target,
            command: dropdb.cmd + ' ' + pgAuth(conn) + ' --if-exists ' + target,
            cwd,
            run: dropdb.run,
          },
        ],
      },
    ]
  }

  const mysql = bin(tools, 'mysql')
  const mysqldump = bin(tools, 'mysqldump')
  const dump = join(tmpdir(), 'cockpit-' + target + '.sql')
  return [
    {
      title: 'Create database ' + target,
      command: mysql.cmd + ' ' + mysqlAuth(conn) + ' "--execute=CREATE DATABASE IF NOT EXISTS `' + target + '`"',
      cwd,
      destructive: false,
      run: mysql.run,
      undo: [
        {
          title: 'Drop ' + target,
          command: mysql.cmd + ' ' + mysqlAuth(conn) + ' "--execute=DROP DATABASE IF EXISTS `' + target + '`"',
          cwd,
          run: mysql.run,
        },
      ],
    },
    {
      title: 'Dump ' + conn.database,
      command:
        mysqldump.cmd + ' ' + mysqlAuth(conn) +
        ' --single-transaction --routines --events' +
        (tools.mysqldumpGtid ? ' --set-gtid-purged=OFF' : '') +
        ' "--result-file=' + dump + '" ' + conn.database,
      cwd,
      destructive: false,
      run: mysqldump.run,
    },
    {
      title: 'Load it into ' + target,
      command:
        mysql.cmd + ' ' + mysqlAuth(conn) + ' --database=' + target +
        (tools.mysqlCommands ? ' --commands' : '') +
        ' "--execute=SOURCE ' + dump + '"',
      cwd,
      destructive: false,
      run: mysql.run,
    },
  ]
}

/**
 * §16 — dropping data is the one thing nothing brings back, so it is red.
 * Never on a server that is not on this machine: what a remote `.env` names
 * was not created by Cockpit, whatever the name looks like.
 */
export function dropPlan(conn: Connection, target: string, cwd: string, tools: Tools): PlanStep[] {
  if (conn.engine === 'sqlite' || !conn.local || !target) return []
  if (conn.engine === 'pgsql') {
    const dropdb = bin(tools, 'dropdb')
    return [
      {
        title: 'Drop database ' + target,
        command: dropdb.cmd + ' ' + pgAuth(conn) + ' --if-exists ' + target,
        cwd,
        destructive: true,
        run: dropdb.run,
      },
    ]
  }
  const mysql = bin(tools, 'mysql')
  return [
    {
      title: 'Drop database ' + target,
      command: mysql.cmd + ' ' + mysqlAuth(conn) + ' "--execute=DROP DATABASE IF EXISTS `' + target + '`"',
      cwd,
      destructive: true,
      run: mysql.run,
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
  if (!conn.local) {
    return {
      repo: basename(repoPath),
      engine: conn.engine,
      from: conn.database,
      to: null,
      detail:
        conn.database + ' is on ' + conn.host + ', not this machine, so Cockpit will not copy it ' +
        '(or drop the copy later). The branch keeps pointing at it.',
      missingTools: [],
    }
  }
  const { missing } = await resolveTools(conn)
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
