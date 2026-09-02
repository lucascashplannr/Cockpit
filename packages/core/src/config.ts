import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { ProjectSettings } from '@cockpit/shared'

/**
 * §15 — what lives on the machine, as opposed to in the repo: which workspaces
 * exist, allocated ports, tokens, UI state, the local journal.
 */
export const COCKPIT_HOME = process.env.COCKPIT_HOME ?? join(homedir(), '.cockpit')
export const DEFAULT_PORT = Number(process.env.COCKPIT_PORT ?? 7717)

export const PROJECT_DEFAULTS: ProjectSettings = {
  // Nothing is locked until someone locks it. The rule that used to refuse a
  // commit on the default branch was a guess about how people work, and a
  // repository with one owner who commits to main directly is not a mistake.
  defaultBranch: null,
  lockedBranches: [],
}

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
    settings?: Partial<ProjectSettings>
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

/** Guards every path that arrives over the wire (§13 rule 1). */
export function safeResolve(root: string, rel: string): string {
  const full = resolve(root, rel)
  const normRoot = resolve(root)
  if (full !== normRoot && !full.startsWith(normRoot + '/')) {
    throw new Error('path escapes workspace: ' + rel)
  }
  return full
}


/**
 * §15 — one project's settings, filled in with the defaults.
 *
 * Keyed by root rather than by id: ids are derived from the path and a project
 * that is forgotten and added back should not lose the branch someone locked.
 */
export function projectSettings(root: string): ProjectSettings {
  const row = loadConfig().projects.find((x) => x.root === root)
  return {
    ...PROJECT_DEFAULTS,
    ...(row?.settings ?? {}),
    // Merged rather than spread wholesale: a config written by an older build
    // has neither field, and `undefined` here would defeat the default above.
    lockedBranches: row?.settings?.lockedBranches ?? PROJECT_DEFAULTS.lockedBranches,
    defaultBranch: row?.settings?.defaultBranch ?? PROJECT_DEFAULTS.defaultBranch,
  }
}

export function setProjectSettings(root: string, patch: Partial<ProjectSettings>): ProjectSettings {
  let out = PROJECT_DEFAULTS
  updateConfig((c) => {
    const row = c.projects.find((x) => x.root === root)
    if (!row) return
    const next: ProjectSettings = { ...projectSettings(root), ...patch }
    // An empty list and an unset default are the defaults; storing them would
    // write noise into the config file for every project ever opened.
    row.settings = {
      ...(next.defaultBranch ? { defaultBranch: next.defaultBranch } : {}),
      ...(next.lockedBranches.length ? { lockedBranches: next.lockedBranches } : {}),
    }
    if (!Object.keys(row.settings).length) delete row.settings
    out = next
  })
  return out
}

/**
 * Does `branch` match one of the locked patterns? `*` is the only wildcard,
 * which covers `release/*` and stops short of asking anyone to write a regex
 * into a settings field.
 */
export function isLocked(branch: string | null, patterns: string[]): boolean {
  if (!branch) return false
  return patterns.some((raw) => {
    const pattern = raw.trim()
    if (!pattern) return false
    if (!pattern.includes('*')) return pattern === branch
    const rx = new RegExp(
      '^' + pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    )
    return rx.test(branch)
  })
}
