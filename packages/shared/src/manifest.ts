/**
 * §11 — the only hard constraint on this format: it must be hand-writable in
 * five minutes. If a field cannot be guessed from disk it belongs here; if it
 * can, it does not (§5, "défaut sain").
 */
import type { Setup } from './model.js'

export interface RepoDecl {
  /** Relative to the manifest, or absolute. */
  path: string
  name?: string
  /** Branch treated as protected: agents never work on it (§7). */
  mainBranch?: string
}

/**
 * §7 — what `git worktree add` cannot give you.
 *
 * A worktree is a checkout of *tracked* files. Everything gitignored — `.env`,
 * `auth.json`, a local sqlite file — is simply absent, so a Laravel or Vite
 * worktree created by Cockpit boots into "no APP_KEY" and the topic is dead
 * before anyone types anything. Carrying those files across is the missing
 * half of creating a worktree.
 *
 * Copying them verbatim is not enough either: three worktrees whose `.env` all
 * say `APP_URL=https://cp.test` and `DB_DATABASE=app` are three checkouts
 * fighting over one hostname and one database. `set` is what makes each one
 * its own.
 */
export interface WorktreeSeed {
  /** Repo folder name this applies to. Omit for every repository. */
  repo?: string
  /** Paths relative to the repo root, copied from the main checkout. */
  copy?: string[]
  /**
   * Per-file key rewrites, applied after the copy. Keyed by the copied path,
   * then by the key inside it. Values may use the placeholders below.
   *
   * `{{slug}}`   the topic slug            `{{repo}}`  the repo folder name
   * `{{scoped}}` repo-slug, unique per topic — what Herd and Compose key on
   * `{{host}}`   `{{scoped}}.test`, the per-worktree hostname
   * `{{port}}`   the port §11 allocated for this workspace
   * `{{db}}`     the per-worktree database name
   * `{{path}}`   the absolute worktree path
   */
  set?: Record<string, Record<string, string>>
}

/**
 * §8 — a long-lived process: the thing Start starts.
 *
 * This is the half of "how this project runs" that used to exist nowhere the
 * user could read. A runtime adapter knew the command, the port style and the
 * URL, and none of the three were written down — so "what will Start do?" was
 * answerable only by reading `runtime/index.ts`, and changing it meant editing
 * an adapter. A declared server is that knowledge, in the repository, in one
 * legible line: `pnpm dev --port={{port}}` says what the `PORT_STYLES` table
 * used to decide silently.
 */
export interface ServerDecl {
  /** Repository folder this runs in. Omit in a mono-repo. */
  repo?: string
  /** The command line. `{{port}}` is this server's own allocated port. */
  cmd: string
  /**
   * Where it answers once up. Omit for something with no address of its own —
   * a queue worker runs and is watched like the rest, it simply has no URL.
   *
   * Resolved before anything spawns, and may NOT reference another server:
   * that is what keeps `{{api.url}}` free of cycles and of start ordering.
   */
  url?: string
  /** Path appended to `url` for the health check. Defaults to the URL itself. */
  health?: string
  /**
   * Extra environment for this command, resolved like everything else.
   * `{{api.url}}` here is the whole wiring story: it is injected at spawn, so
   * it is per-run and per-environment, and nothing is written into a file.
   */
  env?: Record<string, string>
}

/** §8 — a one-shot: the thing you press. Same runner, different lifetime. */
export interface CommandDecl {
  /** Repository folder this runs in. Omit to run in the project's own folder. */
  repo?: string
  /** Required unless `runs` is given. */
  cmd?: string
  /**
   * Other declarations to run, in order — the project-level verb.
   *
   * A name here is a command, run to completion, or a server, started and
   * left running. Order is the contract: the list stops at the first command
   * that fails, because "build then publish" must not publish.
   */
  runs?: string[]
  /** Inputs to ask for first; each key is usable as `{{key}}` in `cmd`. */
  ask?: Record<string, string>
  /** A guard before running, for the ones that throw work away. */
  confirm?: boolean | string
}

export interface ManifestV1 {
  version: 1
  name: string
  /** §4 — the manifest only declares the project default. */
  setup?: Setup
  repos?: RepoDecl[]
  worktrees?: {
    /** §21.4 — resolved here per project rather than globally. */
    strategy?: 'grouped' | 'flat'
    root?: string
    /** §7 — the gitignored local config a new worktree cannot check out. */
    seed?: WorktreeSeed[]
  }
  /** §8 — what stays up. The list Start reads. */
  servers?: Record<string, ServerDecl>
  /** §8 — which servers one click starts. Absent means all of them. */
  start?: string[]
  /** §8 — what you press: one-shot commands, in the palette and the Run view. */
  commands?: Record<string, CommandDecl>
  /** The escape hatch, for a stack whose command is not yours to write. */
  runtime?: string
  tickets?: { provider: string; repo?: string; project?: string; baseUrl?: string }
  review?: { provider: string; repo?: string }
  docs?: string | { path: string }
  agents?: { engines?: string[]; instructions?: string; allow?: string[] }
  ports?: Record<string, number | 'auto'>
  /** Runtime-specific block, deliberately not a universal schema (§8). */
  [runtimeKey: string]: unknown
}

export interface ManifestIssue {
  path: string
  message: string
  severity: 'error' | 'warning'
}

export interface ParsedManifest {
  manifest: ManifestV1 | null
  issues: ManifestIssue[]
}

const SETUP_LEVELS = new Set(['none', 'branch', 'isolated', 'full'])

/** Lenient on purpose: a partially wrong manifest degrades, it does not brick. */
export function validateManifest(raw: unknown): ParsedManifest {
  const issues: ManifestIssue[] = []
  if (raw === null || typeof raw !== 'object') {
    return {
      manifest: null,
      issues: [{ path: '', message: 'manifest is not a mapping', severity: 'error' }],
    }
  }
  const o = raw as Record<string, unknown>

  if (o.version !== 1) {
    issues.push({
      path: 'version',
      message: 'expected version: 1, got ' + String(o.version),
      severity: 'error',
    })
  }
  if (typeof o.name !== 'string' || !o.name.trim()) {
    issues.push({ path: 'name', message: 'name is required', severity: 'error' })
  }
  if (o.setup !== undefined && !SETUP_LEVELS.has(String(o.setup))) {
    issues.push({
      path: 'setup',
      message: 'must be one of none, branch, isolated, full',
      severity: 'warning',
    })
    delete o.setup
  }
  if (o.repos !== undefined) {
    if (!Array.isArray(o.repos)) {
      issues.push({ path: 'repos', message: 'must be a list', severity: 'error' })
    } else {
      const repos = o.repos as unknown[]
      repos.forEach((r, i) => {
        if (typeof r === 'string') {
          repos[i] = { path: r }
          return
        }
        const rr = r as Record<string, unknown>
        if (!rr || typeof rr.path !== 'string') {
          issues.push({
            path: 'repos[' + i + '].path',
            message: 'each repo needs a path',
            severity: 'error',
          })
        }
      })
    }
  }
  const wt = o.worktrees as { seed?: unknown } | undefined
  if (wt?.seed !== undefined) {
    if (!Array.isArray(wt.seed)) {
      issues.push({ path: 'worktrees.seed', message: 'must be a list', severity: 'warning' })
      delete wt.seed
    } else {
      // Lenient like the rest: one malformed entry is dropped, the others
      // still seed. A worktree missing one file beats a manifest that bricks.
      wt.seed = (wt.seed as unknown[]).filter((e, i) => {
        const ok = !!e && typeof e === 'object' && !Array.isArray(e)
        if (!ok) {
          issues.push({
            path: 'worktrees.seed[' + i + ']',
            message: 'each entry must be a mapping with copy / set',
            severity: 'warning',
          })
        }
        return ok
      })
    }
  }

  // §8 — servers and commands are the same shape with different lifetimes, so
  // one validator covers both. Lenient like the rest: an entry missing its
  // `cmd` is dropped and named, and every other entry still runs. A project
  // whose fourth server has a typo must still start the first three.
  for (const key of ['servers', 'commands'] as const) {
    const decls = o[key]
    if (decls === undefined) continue
    if (typeof decls !== 'object' || decls === null || Array.isArray(decls)) {
      issues.push({ path: key, message: 'must be a mapping of name -> { cmd }', severity: 'warning' })
      delete o[key]
      continue
    }
    for (const [name, decl] of Object.entries(decls as Record<string, unknown>)) {
      const d = decl as Record<string, unknown> | null
      const hasCmd = !!d && typeof d.cmd === 'string' && !!d.cmd.trim()
      // A command may say what to run, or which others to run; a server only
      // ever says the first, because there is nothing to compose about a
      // process that stays up — `start:` already names that set.
      const hasRuns = key === 'commands' && Array.isArray(d?.runs) && d.runs.length > 0
      if (!d || typeof d !== 'object' || (!hasCmd && !hasRuns)) {
        issues.push({
          path: key + '.' + name,
          message: key === 'commands' ? 'needs a cmd or a runs list' : 'needs a cmd',
          severity: 'warning',
        })
        delete (decls as Record<string, unknown>)[name]
      }
    }
  }

  if (o.start !== undefined) {
    if (!Array.isArray(o.start)) {
      issues.push({ path: 'start', message: 'must be a list of server names', severity: 'warning' })
      delete o.start
    } else {
      const servers = (o.servers ?? {}) as Record<string, unknown>
      // Naming a server that does not exist is the one mistake here that is
      // silent otherwise: Start would simply do less than it was asked to.
      const unknown = (o.start as unknown[]).filter((n) => !(String(n) in servers))
      if (unknown.length) {
        issues.push({
          path: 'start',
          message: 'no server named ' + unknown.map(String).join(', '),
          severity: 'warning',
        })
        o.start = (o.start as unknown[]).filter((n) => String(n) in servers)
      }
    }
  }

  if (o.ports !== undefined && (typeof o.ports !== 'object' || o.ports === null)) {
    issues.push({
      path: 'ports',
      message: 'must be a mapping of name -> port | auto',
      severity: 'warning',
    })
    delete o.ports
  }

  const fatal = issues.some((i) => i.severity === 'error')
  return { manifest: fatal ? null : (o as unknown as ManifestV1), issues }
}

export const MANIFEST_FILENAMES = ['cockpit.yaml', 'cockpit.yml', '.cockpit.yaml'] as const

export const MANIFEST_TEMPLATE = [
  '# cockpit.yaml — desired state of the project (§13)',
  'version: 1',
  'name: my-project',
  '',
  '# Project default only; every action may pick its own level (§4)',
  'setup: branch',
  '',
  '# Omit entirely for a mono-repo: the current folder is enough',
  'repos:',
  '  - path: .',
  '',
  '# What stays up. `{{port}}` is this server\'s own port, allocated per',
  '# environment — so the same lines run on main and in every topic (§8).',
  '# servers:',
  '#   api:',
  '#     repo: api',
  '#     cmd: php artisan serve --port={{port}}',
  '#     url: http://localhost:{{port}}',
  '#   web:',
  '#     repo: web',
  '#     cmd: pnpm dev --port={{port}}',
  '#     url: http://localhost:{{port}}',
  '#     env:',
  '#       VITE_API_URL: "{{api.url}}"   # the wiring, injected at spawn',
  '',
  '# What one click starts. Omit to start every server.',
  '# start: [api, web]',
  '',
  '# What you press: one-shot, in the Run view and the palette (§8)',
  '# commands:',
  '#   build: { repo: web, cmd: pnpm build }',
  '#   release: { cmd: pnpm release {{version}}, ask: { version: Version number } }',
  '',
  '# The escape hatch, when the command is not yours to write',
  '# runtime: compose',
  '# compose:',
  '#   file: compose.yaml',
  '',
  '# What a new worktree cannot check out, because git ignores it (§7)',
  '# worktrees:',
  '#   seed:',
  '#     - copy: [.env, auth.json]',
  '',
  '# tickets: { provider: github, repo: owner/name }',
  '# docs: docs/',
  '',
].join('\n')
