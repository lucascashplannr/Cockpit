/**
 * §11 — the only hard constraint on this format: it must be hand-writable in
 * five minutes. If a field cannot be guessed from disk it belongs here; if it
 * can, it does not (§5, "défaut sain").
 */
import type { Ceremony } from './model.js'

export interface RepoDecl {
  /** Relative to the manifest, or absolute. */
  path: string
  name?: string
  /** Branch treated as protected: agents never work on it (§7). */
  mainBranch?: string
}

export interface ManifestV1 {
  version: 1
  name: string
  /** §4 — the manifest only declares the project default. */
  ceremony?: Ceremony
  repos?: RepoDecl[]
  worktrees?: {
    /** §21.4 — resolved here per project rather than globally. */
    strategy?: 'grouped' | 'flat'
    root?: string
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

const CEREMONIES = new Set(['C0', 'C1', 'C2', 'C3'])

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
  if (o.ceremony !== undefined && !CEREMONIES.has(String(o.ceremony))) {
    issues.push({ path: 'ceremony', message: 'must be one of C0, C1, C2, C3', severity: 'warning' })
    delete o.ceremony
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
  'ceremony: C1',
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
  '# tickets: { provider: github, repo: owner/name }',
  '# docs: docs/',
  '',
].join('\n')
