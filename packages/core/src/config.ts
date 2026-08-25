import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * §15 — what lives on the machine, as opposed to in the repo: which workspaces
 * exist, allocated ports, tokens, UI state, the local journal.
 */
export const COCKPIT_HOME = process.env.COCKPIT_HOME ?? join(homedir(), '.cockpit')
export const DEFAULT_PORT = Number(process.env.COCKPIT_PORT ?? 7717)

export interface LocalConfig {
  /** Roots the user has pointed the cockpit at. */
  projects: { root: string; addedAt: number }[]
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
