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
  '# Block specific to the chosen runtime, not a universal schema (§8)',
  '# runtime: compose',
  '# compose:',
  '#   file: compose.yaml',
  '',
  '# What a new worktree cannot check out, because git ignores it (§7)',
  '# worktrees:',
  '#   seed:',
  '#     - copy: [.env, auth.json]',
  '#       set:',
  '#         .env:',
  '#           APP_URL: https://{{host}}',
  '#           DB_DATABASE: "{{db}}"',
  '',
  '# tickets: { provider: github, repo: owner/name }',
  '# docs: docs/',
  '',
].join('\n')
