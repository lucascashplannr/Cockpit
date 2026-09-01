import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { MANIFEST_FILENAMES, validateManifest } from '@cockpit/shared'
import type { Capability, ManifestV1 } from '@cockpit/shared'
import { isRepo } from './git.js'

/**
 * §5 — "Défaut sain : sans manifest, le cockpit fonctionne quand même."
 * Detection covers what is guessable; the manifest only covers what is not.
 */

export function findManifest(root: string): string | null {
  for (const name of MANIFEST_FILENAMES) {
    const p = join(root, name)
    if (existsSync(p)) return p
  }
  return null
}

export function readManifest(path: string): { manifest: ManifestV1 | null; issues: string[] } {
  try {
    const raw = migrateVocabulary(parseYaml(readFileSync(path, 'utf8')) as unknown)
    const { manifest, issues } = validateManifest(raw)
    return { manifest, issues: issues.map((i) => (i.path ? i.path + ': ' : '') + i.message) }
  } catch (e) {
    return { manifest: null, issues: ['could not parse: ' + String(e)] }
  }
}

/**
 * A manifest is a file the user wrote and versioned, so the vocabulary pass
 * cannot simply stop reading the old words: `ceremony: C2` still means
 * `setup: isolated`, and silently ignoring it would change what a project does
 * without saying so. Accepted on the way in; never written back.
 */
const SETUP_ALIASES: Record<string, string> = { C0: 'none', C1: 'branch', C2: 'isolated', C3: 'full' }

function migrateVocabulary(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const o = raw as Record<string, unknown>
  if (o.setup === undefined && typeof o.ceremony === 'string') o.setup = o.ceremony
  if (typeof o.setup === 'string' && SETUP_ALIASES[o.setup]) o.setup = SETUP_ALIASES[o.setup]
  return o
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Detects the runtime from disk. Order matters: most specific first. */
export function detectRuntime(dir: string): { impl: string; detail: Record<string, unknown> } | null {
  if (existsSync(join(dir, 'app.json')) || existsSync(join(dir, 'app.config.js'))) {
    const app = readJson(join(dir, 'app.json'))
    const pkg = readJson(join(dir, 'package.json'))
    const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) }
    if (app?.expo || 'expo' in deps) return { impl: 'expo', detail: {} }
  }
  if (existsSync(join(dir, '.devcontainer', 'devcontainer.json'))) {
    return { impl: 'devcontainer', detail: {} }
  }
  for (const f of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']) {
    if (existsSync(join(dir, f))) return { impl: 'compose', detail: { file: f } }
  }
  // Laravel Herd serves any folder linked into it; the marker is the artisan file.
  if (existsSync(join(dir, 'artisan')) && existsSync(join(dir, 'composer.json'))) {
    return { impl: 'herd', detail: {} }
  }
  const pkg = readJson(join(dir, 'package.json'))
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>
    const script = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve ? 'serve' : null
    if (script) {
      const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) }
      return { impl: 'node', detail: { script, framework: detectFramework(scripts[script] ?? '', deps) } }
    }
  }
  return null
}

/**
 * Which dev server this is, and therefore how it must be told its port (§11).
 *
 * This exists because `PORT` in the environment is a convention rather than a
 * rule, and the most common dev server on this machine does not follow it:
 * Vite reads `--port` and otherwise binds 5173 whatever the environment says.
 * A server that ignores the port Cockpit allocated does not fail — it *runs*,
 * on a number nothing in the window knows, so health reports `starting`
 * forever and Preview opens a URL with nothing behind it. That is the failure
 * mode this identification prevents.
 *
 * The script's own text is the first signal and the strongest: a package that
 * merely *depends* on vite may well run something else, while a `dev` script
 * that says `vite` is running vite. Dependencies are the fallback for a
 * script that hides behind a wrapper.
 */
export type Framework = 'vite' | 'quasar' | 'next' | 'nuxt' | 'astro' | 'angular' | null

function detectFramework(scriptBody: string, deps: object): Framework {
  // Quasar before Vite: it is built on Vite and would match both, but its CLI
  // is what receives the flag and it does not take Vite's own options.
  const byScript: [RegExp, Framework][] = [
    [/\bquasar\b/, 'quasar'],
    [/\bvite\b/, 'vite'],
    [/\bnext\b/, 'next'],
    [/\bnuxt\b/, 'nuxt'],
    [/\bastro\b/, 'astro'],
    [/\bng\s+serve\b/, 'angular'],
  ]
  for (const [re, id] of byScript) if (re.test(scriptBody)) return id

  const has = (name: string) => name in deps
  if (has('@quasar/app-vite') || has('@quasar/app-webpack')) return 'quasar'
  if (has('next')) return 'next'
  if (has('nuxt')) return 'nuxt'
  if (has('astro')) return 'astro'
  if (has('@angular/cli')) return 'angular'
  if (has('vite')) return 'vite'
  return null
}

function detectDocs(dir: string): string | null {
  for (const cand of ['docs', 'doc', 'documentation']) {
    const p = join(dir, cand)
    if (existsSync(p) && statSync(p).isDirectory()) return cand
  }
  return null
}

function gitRemoteProvider(dir: string): { provider: string; repo: string } | null {
  const cfg = join(dir, '.git', 'config')
  if (!existsSync(cfg)) return null
  try {
    const text = readFileSync(cfg, 'utf8')
    const m = /url\s*=\s*(\S+)/.exec(text)
    if (!m?.[1]) return null
    const url = m[1]
    const host = /github\.com/.test(url)
      ? 'github'
      : /bitbucket\.org/.test(url)
        ? 'bitbucket'
        : /gitlab\./.test(url)
          ? 'gitlab'
          : null
    if (!host) return null
    const repo = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? ''
    return { provider: host, repo }
  } catch {
    return null
  }
}

/**
 * §3.9 / §5 — anything not returned here simply does not exist in the UI.
 * A capability is never emitted in a disabled state.
 */
export function detectCapabilities(dir: string, manifest: ManifestV1 | null): Capability[] {
  const caps: Capability[] = []
  const push = (c: Capability) => {
    if (!caps.some((x) => x.id === c.id)) caps.push(c)
  }

  if (manifest?.runtime) {
    push({
      id: 'runtime',
      impl: String(manifest.runtime),
      source: 'manifest',
      detail: (manifest[String(manifest.runtime)] as Record<string, unknown>) ?? {},
    })
  }
  if (manifest?.tickets?.provider) {
    push({ id: 'tickets', impl: manifest.tickets.provider, source: 'manifest', detail: { ...manifest.tickets } })
  }
  if (manifest?.review?.provider) {
    push({ id: 'review', impl: manifest.review.provider, source: 'manifest', detail: { ...manifest.review } })
  }
  if (manifest?.docs) {
    const p = typeof manifest.docs === 'string' ? manifest.docs : manifest.docs.path
    push({ id: 'docs', impl: 'folder', source: 'manifest', detail: { path: p } })
  }

  if (isRepo(dir)) push({ id: 'vcs', impl: 'git', source: 'detected' })

  const rt = detectRuntime(dir)
  if (rt) push({ id: 'runtime', impl: rt.impl, source: 'detected', detail: rt.detail })

  const docs = detectDocs(dir)
  if (docs) push({ id: 'docs', impl: 'folder', source: 'detected', detail: { path: docs } })

  const remote = gitRemoteProvider(dir)
  if (remote) {
    push({ id: 'review', impl: remote.provider, source: 'detected', detail: { repo: remote.repo } })
    if (remote.provider === 'github') {
      push({ id: 'tickets', impl: 'github', source: 'detected', detail: { repo: remote.repo } })
    }
  }

  if (existsSync(join(dir, '.github', 'workflows'))) {
    push({ id: 'ci', impl: 'github-actions', source: 'detected' })
  } else if (existsSync(join(dir, '.gitlab-ci.yml'))) {
    push({ id: 'ci', impl: 'gitlab-ci', source: 'detected' })
  } else if (existsSync(join(dir, 'bitbucket-pipelines.yml'))) {
    push({ id: 'ci', impl: 'bitbucket-pipelines', source: 'detected' })
  }

  if (existsSync(join(dir, '.cockpit', 'memory.md'))) {
    push({ id: 'memory', impl: 'files', source: 'detected' })
  }

  return caps
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'out', '.next', '.nuxt',
  'target', '.venv', 'venv', '__pycache__', '.turbo', '.cache', 'Pods',
  // Worktrees are discovered from the repo that owns them, never by scanning.
  // Without this a flat layout re-registers every worktree as a main checkout.
  'worktrees',
])

/** Finds candidate repo folders one level down — the multi-repo group case. */
export function childRepos(root: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const p = join(root, name)
    try {
      if (!statSync(p).isDirectory()) continue
    } catch {
      continue
    }
    if (isRepo(p)) out.push(p)
  }
  return out
}

export function projectNameFor(root: string, manifest: ManifestV1 | null): string {
  return manifest?.name ?? basename(root)
}
