import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { COMMIT_RULES_DEFAULTS, normalizeCommitRules } from '@cockpit/shared'
import type { CommitRules, ProjectSettings } from '@cockpit/shared'

/**
 * §15 — what lives on the machine, as opposed to in the repo: which workspaces
 * exist, allocated ports, tokens, UI state, the local journal.
 */
export const COCKPIT_HOME = process.env.COCKPIT_HOME ?? join(homedir(), '.cockpit')
export const DEFAULT_PORT = Number(process.env.COCKPIT_PORT ?? 7717)

export const PROJECT_DEFAULTS: ProjectSettings = {
  // Nothing is protected until someone protects it. The rule that used to
  // refuse a commit on the default branch was a guess about how people work,
  // and a repository with one owner who commits to main directly is not a
  // mistake. A new project asks instead (see `project.defaultBranches`).
  defaultBranch: null,
  protectedBranches: {},
  docsPath: null,
  untrackedRepos: [],
  mark: null,
  repoMarks: {},
}

/**
 * What a config written by an older build may still hold: one list for the
 * whole project, from before protection moved to the repository. Read once by
 * `migrateLegacyLocks` and never written again.
 */
type StoredSettings = Partial<ProjectSettings> & { lockedBranches?: string[] }

export interface LocalConfig {
  /**
   * Roots the user has pointed the cockpit at. `name` is a machine-local
   * display override (§15 — UI state lives here, not in the repo): renaming a
   * project must not write a file into someone else's checkout. Absent means
   * the manifest's name, or the folder's.
   */
  projects: {
    root: string
    addedAt: number
    name?: string
    /** §15 — this machine's settings for the project. See `ProjectSettings`. */
    settings?: StoredSettings
  }[]
  /**
   * §7 — the folder holding one folder per project. New projects are created
   * inside it. Null until the user names one; nothing is ever created at a
   * guessed path.
   */
  devRoot: string | null
  /** §11 — port allocation is global across projects, so it lives here. */
  portAssignments: Record<string, number>
  portRange: [number, number]
  /** Reserved because something else on the machine already owns them. */
  portBlocklist: number[]
  ide: string
  /** §16 — the house style for commit messages, read by the drafter. */
  commitRules: CommitRules
  shell: string | null
  journalRetentionDays: number
}

const DEFAULTS: LocalConfig = {
  projects: [],
  devRoot: null,
  portAssignments: {},
  portRange: [7800, 8799],
  portBlocklist: [8081],
  ide: process.env.COCKPIT_IDE ?? 'code',
  commitRules: COMMIT_RULES_DEFAULTS,
  shell: null,
  journalRetentionDays: 30,
}

export function ensureHome(): string {
  if (!existsSync(COCKPIT_HOME)) mkdirSync(COCKPIT_HOME, { recursive: true })
  return COCKPIT_HOME
}

const CONFIG_PATH = () => join(COCKPIT_HOME, 'config.json')

let cache: LocalConfig | null = null

export function loadConfig(): LocalConfig {
  if (cache) return cache
  ensureHome()
  const p = CONFIG_PATH()
  if (!existsSync(p)) {
    cache = { ...DEFAULTS }
    saveConfig(cache)
    return cache
  }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<LocalConfig>
    cache = { ...DEFAULTS, ...parsed }
    // Read through the normalizer: a config from the free-text version holds a string.
    cache.commitRules = normalizeCommitRules(parsed.commitRules)
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function saveConfig(next: LocalConfig): void {
  ensureHome()
  cache = next
  writeFileSync(CONFIG_PATH(), JSON.stringify(next, null, 2), 'utf8')
}

export function updateConfig(fn: (c: LocalConfig) => void): LocalConfig {
  const c = loadConfig()
  fn(c)
  saveConfig(c)
  return c
}

/**
 * Whether `p` is `root` or somewhere under it.
 *
 * Through `relative` rather than a `startsWith(root + '/')`: on Windows
 * `resolve` hands back backslashes, so the prefix test refused every path
 * including the root's own children.
 */
export function isInside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** Guards every path that arrives over the wire (§13 rule 1). */
export function safeResolve(root: string, rel: string): string {
  const full = resolve(root, rel)
  if (!isInside(root, full)) {
    throw new Error('path escapes workspace: ' + rel)
  }
  return full
}


/**
 * §15 — one project's settings, filled in with the defaults.
 *
 * Keyed by root rather than by id: ids are derived from the path and a project
 * that is forgotten and added back should not lose the branch someone protected.
 */
export function projectSettings(root: string): ProjectSettings {
  const row = loadConfig().projects.find((x) => x.root === root)
  // Field by field rather than spread wholesale: a config written by an older
  // build has neither field, and `undefined` would defeat the defaults.
  return {
    defaultBranch: row?.settings?.defaultBranch ?? PROJECT_DEFAULTS.defaultBranch,
    protectedBranches: row?.settings?.protectedBranches ?? PROJECT_DEFAULTS.protectedBranches,
    docsPath: row?.settings?.docsPath ?? PROJECT_DEFAULTS.docsPath,
    untrackedRepos: row?.settings?.untrackedRepos ?? PROJECT_DEFAULTS.untrackedRepos,
    mark: row?.settings?.mark ?? PROJECT_DEFAULTS.mark,
    repoMarks: row?.settings?.repoMarks ?? PROJECT_DEFAULTS.repoMarks,
  }
}

/** Up to three letters or digits, as typed — case is kept, so "v2" can stay "v2". */
function cleanMark(s: string | null | undefined): string | null {
  const m = (s ?? '').replace(/\s+/g, '').slice(0, 3)
  return m || null
}

export function setProjectSettings(root: string, patch: Partial<ProjectSettings>): ProjectSettings {
  let out = PROJECT_DEFAULTS
  updateConfig((c) => {
    const row = c.projects.find((x) => x.root === root)
    if (!row) return
    const next: ProjectSettings = { ...projectSettings(root), ...patch }
    // An empty list and an unset default are the defaults; storing them would
    // write noise into the config file for every project ever opened.
    const guarded: Record<string, string[]> = {}
    for (const [repo, list] of Object.entries(next.protectedBranches)) {
      const clean = [...new Set(list.map((b) => b.trim()).filter(Boolean))]
      if (clean.length) guarded[repo] = clean
    }
    next.protectedBranches = guarded
    next.untrackedRepos = [...new Set(next.untrackedRepos)]
    next.mark = cleanMark(next.mark)
    const marks: Record<string, string> = {}
    for (const [repo, m] of Object.entries(next.repoMarks)) {
      const clean = cleanMark(m)
      if (clean) marks[repo] = clean
    }
    next.repoMarks = marks
    row.settings = {
      ...(next.defaultBranch ? { defaultBranch: next.defaultBranch } : {}),
      ...(Object.keys(guarded).length ? { protectedBranches: guarded } : {}),
      ...(next.docsPath ? { docsPath: next.docsPath } : {}),
      ...(next.untrackedRepos.length ? { untrackedRepos: next.untrackedRepos } : {}),
      ...(next.mark ? { mark: next.mark } : {}),
      ...(Object.keys(marks).length ? { repoMarks: marks } : {}),
    }
    if (!Object.keys(row.settings!).length) delete row.settings
    out = next
  })
  return out
}

/**
 * The project-wide list an older build kept, handed to every repository the
 * project holds — the one reading of it that locks nothing it did not lock
 * before. Written once and the old field dropped, so it never runs twice.
 */
export function migrateLegacyLocks(root: string, repoNames: string[]): void {
  const row = loadConfig().projects.find((x) => x.root === root)
  const legacy = row?.settings?.lockedBranches
  if (!row?.settings || legacy === undefined) return
  updateConfig(() => {
    const settings = row.settings!
    delete settings.lockedBranches
    if (legacy.length && repoNames.length) {
      const map = { ...(settings.protectedBranches ?? {}) }
      for (const repo of repoNames) map[repo] = [...new Set([...(map[repo] ?? []), ...legacy])]
      settings.protectedBranches = map
    }
    if (!Object.keys(settings).length) delete row.settings
  })
}
