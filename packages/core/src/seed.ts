import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import { scopedName, slugify, stableId } from '@cockpit/shared'
import type { SeedContext, SeedKeyChange, SeedProposal, WorktreeSeed } from '@cockpit/shared'
import { findManifest, readManifest } from './detect.js'
import { git } from './git.js'
import { append } from './journal.js'
import { allocate, portKey } from './ports.js'
import * as plans from './plans.js'

/**
 * §7 — the half of "create a worktree" that git does not do.
 *
 * `git worktree add` checks out *tracked* files. Everything git ignores is
 * absent: `.env`, `auth.json`, a local sqlite file. So a worktree Cockpit
 * created for a Laravel or Vite app boots into "no application key" and the
 * feature is unusable before anyone opens it — which made the worktree feature
 * decorative rather than useful.
 *
 * Copying is only half of it. Three worktrees whose `.env` all say
 * `APP_URL=https://cp.test` and `DB_DATABASE=app` are three checkouts fighting
 * over one hostname and one database, which is the exact collision §11 already
 * solves for ports. So every copied value that is per-worktree gets rewritten.
 *
 * §5's rule decides the shape: detection covers what is guessable, the
 * manifest covers what is not. Cockpit proposes, the user approves once, and
 * the approved answer is written into `cockpit.yaml` so the second feature
 * needs no approval at all.
 */

/** Config a checkout needs and git will not give it. Root-level only:
 *  walking the tree for gitignored files finds `node_modules` and 40k others. */
const CANDIDATES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.dev',
  '.env.testing',
  'auth.json',
  '.npmrc',
  '.yarnrc.yml',
  '.tool-versions',
]

/** A stray database dump is not configuration. */
const MAX_SEED_BYTES = 256 * 1024

/** Files whose `KEY=value` lines are worth reading for per-worktree values. */
function isEnvShaped(rel: string): boolean {
  return basename(rel).startsWith('.env')
}

/**
 * Which of these paths a fresh worktree will NOT have.
 *
 * The question is "does git track it", not "does .gitignore mention it": a
 * worktree is a checkout of the index, so a force-added file that .gitignore
 * also lists is present, and a stray file no rule mentions is absent. Asking
 * about tracking answers both; asking about ignore rules answers neither.
 */
async function absentFromWorktree(repoPath: string, rels: string[]): Promise<Set<string>> {
  const out = new Set(rels)
  if (!rels.length) return out
  const r = await git(repoPath, ['ls-files', '-z', '--', ...rels], 20_000)
  if (!r.ok) return out
  for (const p of r.stdout.split('\0')) if (p) out.delete(p)
  return out
}

/* ── the rules ───────────────────────────────────────────────────────────
 * Deliberately few, and value-driven rather than key-driven wherever it can
 * be: "this value points at the hostname the main checkout serves on" is a
 * fact about the file, while "keys named APP_URL are URLs" is a guess about
 * the framework. The user approves the result either way (§5), but a proposal
 * that is right the first time is the difference between reviewing and
 * rewriting.
 */

interface EnvLine {
  key: string
  value: string
}

/** A change before it is resolved: the rule, without the value it produces. */
type SeedRule = Omit<SeedKeyChange, 'to'>

function parseEnv(text: string): EnvLine[] {
  const out: EnvLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    out.push({ key, value: unquote(line.slice(eq + 1).trim()) })
  }
  return out
}

function unquote(v: string): string {
  const m = /^(['"])([\s\S]*)\1$/.exec(v)
  return m ? m[2]! : v
}

/** The hostname the main checkout answers on, read out of its own config. */
function currentHost(lines: EnvLine[], repoFolder: string, tld: string): string | null {
  for (const key of ['APP_URL', 'ASSET_URL', 'VITE_APP_URL', 'API_PROXY']) {
    const v = lines.find((l) => l.key === key)?.value
    const host = v ? hostOf(v) : null
    if (host) return host
  }
  // Nothing declared it, but Herd serves the folder name by convention.
  return repoFolder + '.' + tld
}

function hostOf(value: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/:\s]+)/i.exec(value.trim())
  if (m?.[1]) return m[1]
  // A bare hostname, which is what SESSION_DOMAIN and friends hold.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value.trim())) return value.trim()
  return null
}

/**
 * Ports the checkout binds, keyed by the service §11 should allocate them
 * under. Everything else — anything belonging to a service the app connects
 * *to* — is left exactly as it is.
 */
const DIALS_OUT = /^(DB|DATABASE|REDIS|MEMCACHED|MAIL|SMTP|MYSQL|POSTGRES|PGSQL|MONGO|ELASTIC|MEILI|TYPESENSE|RABBITMQ|AMQP|KAFKA|S3|AWS|MINIO|PUSHER|SOKETI|LDAP|SENTRY)_/

const LISTENS: { re: RegExp; service: string }[] = [
  { re: /^(APP_PORT|PORT|SERVER_PORT|HTTP_PORT)$/, service: 'web' },
  { re: /^(VITE_PORT|VITE_DEV_PORT)$/, service: 'vite' },
  { re: /^(HMR_PORT|VITE_HMR_PORT)$/, service: 'hmr' },
  { re: /^(DEV_SERVER_PORT|WEBPACK_PORT)$/, service: 'devserver' },
  { re: /^(WS_PORT|WEBSOCKET_PORT|REVERB_PORT)$/, service: 'ws' },
]

function listenPort(key: string, value: string): string | null {
  if (!/^\d{2,5}$/.test(value)) return null
  if (DIALS_OUT.test(key)) return null
  return LISTENS.find((r) => r.re.test(key))?.service ?? null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * What in this file is per-worktree. Returns templates, not values: the
 * template is what goes in the manifest and stays true for the next feature.
 */
function changesFor(rel: string, text: string, repoFolder: string, tld: string): SeedRule[] {
  if (!isEnvShaped(rel)) return []
  const lines = parseEnv(text)
  const host = currentHost(lines, repoFolder, tld)
  const out: SeedRule[] = []

  for (const { key, value } of lines) {
    // 1. Anything pointing at the hostname this checkout already serves on.
    //    The strongest rule, because it is read off the file rather than
    //    assumed about the framework.
    if (host && value.includes(host)) {
      out.push({
        key,
        from: value,
        template: value.replace(new RegExp(escapeRe(host), 'g'), '{{host}}'),
        reason: 'points at ' + host + ', which is the main checkout — every worktree needs its own',
      })
      continue
    }
    // 2. The database. Without this, agent A's migration breaks agent B, which
    //    no amount of folder isolation prevents.
    if (/^(DB_DATABASE|DB_NAME|DATABASE_NAME)$/.test(key) && value) {
      out.push({
        key,
        from: value,
        template: '{{db}}',
        reason: 'one database per worktree, or a migration in one breaks the others',
      })
      continue
    }
    // 3. A port this checkout *listens on*, which §11 allocates globally.
    //
    //    Narrow on purpose, and the exclusion is the important half: DB_PORT,
    //    REDIS_PORT and MAIL_PORT are ports of services the app dials out to.
    //    Rewriting one points the worktree at a database that does not exist —
    //    a silent breakage far worse than leaving a listen port alone, which
    //    the user can add during approval.
    const service = listenPort(key, value)
    if (service) {
      out.push({
        key,
        from: value,
        template: '{{port:' + service + '}}',
        reason: 'a port this worktree listens on; §11 allocates one per service so two features can run at once',
      })
      continue
    }
  }
  return out
}

/* ── resolution ──────────────────────────────────────────────────────── */

export function resolveTemplate(template: string, ctx: SeedContext): string {
  return template.replace(/\{\{(\w+)(?::(\w+))?\}\}/g, (whole, name: string, arg?: string) => {
    switch (name) {
      case 'slug': return ctx.slug
      case 'repo': return ctx.repo
      case 'scoped': return ctx.scoped
      case 'host': return ctx.host
      case 'db': return ctx.db
      case 'path': return ctx.path
      // `{{port}}` is the web port; `{{port:vite}}` is a second listener, and
      // it must be a *different* number — two servers on one port is the
      // collision §11 exists to prevent, not a thing to reintroduce here.
      case 'port': {
        const got = ctx.ports[arg ?? 'web']
        return got === undefined ? whole : String(got)
      }
      default: return whole
    }
  })
}

/** Every `{{port:x}}` a set of rules asks for, `web` included. */
function portServices(rules: { template: string }[]): string[] {
  const out = new Set<string>()
  for (const r of rules) {
    for (const m of r.template.matchAll(/\{\{port(?::(\w+))?\}\}/g)) out.add(m[1] ?? 'web')
  }
  return [...out]
}

/**
 * The values a worktree's own config must carry. Computed before the worktree
 * exists: the workspace id is derived from its path (`stableId`), so the port
 * allocated here is the same one the runtime will bind later.
 */
export async function contextFor(input: {
  projectId: string
  repoPath: string
  slug: string
  tld: string
  /** The database the main checkout uses, when one was found. */
  baseDb: string | null
  /** Which listeners need a port. Always includes `web`. */
  services?: string[]
  override?: string
}): Promise<SeedContext> {
  const repo = basename(input.repoPath)
  const target = plans.featureWorktreePath(input.repoPath, input.slug, input.override)
  const scoped = scopedName(repo, input.slug)
  // The workspace id is derived from the path, so the port allocated here —
  // before the worktree exists — is the same one the runtime binds later.
  const futureWorkspaceId = stableId('ws', target)

  const ports: Record<string, number> = {}
  for (const service of new Set(['web', ...(input.services ?? [])])) {
    try {
      ports[service] = await allocate(portKey(input.projectId, futureWorkspaceId, service))
    } catch {
      // No free port in the range. The template stays unresolved rather than
      // being written as a wrong number, and the UI shows it that way.
    }
  }

  return {
    slug: input.slug,
    repo,
    scoped,
    host: scoped + '.' + input.tld,
    ports,
    // Underscores: MySQL and Postgres both take them, hyphens need quoting
    // everywhere and someone will eventually forget the quotes.
    db: ((input.baseDb ?? repo) + '_' + slugify(input.slug)).replace(/-/g, '_').slice(0, 60),
    path: target,
  }
}

/* ── proposing ───────────────────────────────────────────────────────── */

export interface ProposeInput {
  projectId: string
  repoPath: string
  slug: string
  override?: string
}

/**
 * §5 — what the manifest says, or failing that what disk suggests. The
 * `source` field is the honest half: the UI shows a detected proposal for
 * approval and a declared one as settled.
 */
export async function propose(input: ProposeInput): Promise<SeedProposal> {
  const repo = basename(input.repoPath)
  const manifestPath = findManifest(input.repoPath) ?? findManifest(dirname(input.repoPath))
  const manifest = manifestPath ? readManifest(manifestPath).manifest : null
  const tld = String(
    (manifest?.herd as { tld?: unknown } | undefined)?.tld ?? 'test',
  )

  const declared = (manifest?.worktrees?.seed ?? []).filter((e) => !e.repo || e.repo === repo)
  const fromManifest = declared.length > 0

  const files: SeedProposal['files'] = []
  const skipped: SeedProposal['skipped'] = []

  const wanted = fromManifest
    ? [...new Set(declared.flatMap((e) => e.copy ?? []))]
    : CANDIDATES

  const present = wanted.filter((rel) => existsSync(join(input.repoPath, rel)))
  // A manifest that names a file has already decided; detection still checks,
  // because copying a tracked file over the branch's own version is a bug.
  const absent = await absentFromWorktree(input.repoPath, present)

  // Read DB_DATABASE first: the per-worktree database name is derived from it,
  // and the context has to be built before any value can be resolved.
  let baseDb: string | null = null
  for (const rel of present) {
    if (!isEnvShaped(rel)) continue
    try {
      const found = parseEnv(readFileSync(join(input.repoPath, rel), 'utf8')).find((l) =>
        /^(DB_DATABASE|DB_NAME|DATABASE_NAME)$/.test(l.key),
      )
      if (found?.value) {
        baseDb = found.value
        break
      }
    } catch {
      // Unreadable here means unreadable below too; it is reported there.
    }
  }

  // Two passes: the rules name which listeners need a port, and the context
  // cannot be built until they are known. Resolving comes after both.
  const rulesFor = new Map<string, SeedRule[]>()
  for (const rel of present) {
    if (!isEnvShaped(rel) || fromManifest) continue
    try {
      rulesFor.set(rel, changesFor(rel, readFileSync(join(input.repoPath, rel), 'utf8'), repo, tld))
    } catch {
      // Reported per file below, where the path is already being walked.
    }
  }
  const declaredTemplates = declared.flatMap((e) =>
    Object.values(e.set ?? {}).flatMap((keys) => Object.values(keys).map((template) => ({ template }))),
  )
  const services = portServices([
    ...[...rulesFor.values()].flat(),
    ...declaredTemplates,
  ])

  const ctx = await contextFor({
    projectId: input.projectId,
    repoPath: input.repoPath,
    slug: input.slug,
    tld,
    baseDb,
    services,
    override: input.override,
  })

  for (const rel of present) {
    const abs = join(input.repoPath, rel)
    let size = 0
    try {
      const st = statSync(abs)
      if (!st.isFile()) {
        skipped.push({ path: rel, reason: 'not a plain file' })
        continue
      }
      size = st.size
    } catch {
      skipped.push({ path: rel, reason: 'could not be read' })
      continue
    }
    if (size > MAX_SEED_BYTES) {
      skipped.push({ path: rel, reason: 'larger than 256 KB — config files are not this big' })
      continue
    }
    // A file git tracks is already in the worktree; copying it over would
    // silently replace the branch's own version with the main checkout's.
    if (!absent.has(rel)) {
      skipped.push({ path: rel, reason: 'tracked by git — the worktree checks it out already' })
      continue
    }

    let text = ''
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      skipped.push({ path: rel, reason: 'could not be read' })
      continue
    }

    const declaredSet = fromManifest
      ? Object.assign({}, ...declared.map((e) => e.set?.[rel] ?? {})) as Record<string, string>
      : null

    const changes: SeedRule[] = declaredSet
      ? Object.entries(declaredSet).map(([key, template]) => ({
          key,
          from: parseEnv(text).find((l) => l.key === key)?.value ?? null,
          template,
          reason: 'declared in cockpit.yaml',
        }))
      : (rulesFor.get(rel) ?? [])

    files.push({
      path: rel,
      bytes: size,
      reason: 'git ignores it, so the worktree would not have it',
      changes: changes.map((c) => ({ ...c, to: resolveTemplate(c.template, ctx) })),
    })
  }

  return {
    repo,
    repoPath: input.repoPath,
    target: ctx.path,
    source: fromManifest ? 'manifest' : 'detected',
    manifestPath,
    context: ctx,
    files,
    skipped,
  }
}

/* ── applying ────────────────────────────────────────────────────────── */

/**
 * Runs after the worktree exists. Never overwrites: a file already there was
 * put there by someone, and §16's rule about not destroying work does not stop
 * at git.
 */
export function applySeed(
  proposal: SeedProposal,
  workspaceId: string | null = null,
): { copied: string[]; rewritten: number; skipped: string[]; errors: string[] } {
  const copied: string[] = []
  const skipped: string[] = []
  const errors: string[] = []
  let rewritten = 0

  for (const file of proposal.files) {
    const from = join(proposal.repoPath, file.path)
    const to = join(proposal.target, file.path)
    try {
      if (existsSync(to)) {
        skipped.push(file.path + ' (already there)')
        continue
      }
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      copied.push(file.path)

      if (file.changes.length) {
        const before = readFileSync(to, 'utf8')
        const after = rewriteKeys(before, file.changes)
        if (after !== before) {
          writeFileSync(to, after, 'utf8')
          rewritten += file.changes.length
        }
      }
    } catch (e) {
      errors.push(file.path + ': ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  append({
    type: 'worktree.seeded',
    level: errors.length ? 'warn' : 'info',
    workspaceId,
    payload: { repo: proposal.repo, target: proposal.target, copied, rewritten, skipped, errors },
  })
  return { copied, rewritten, skipped, errors }
}

/**
 * Rewrites in place: the line keeps its position, its comment neighbours and
 * its quoting style. A `.env` is read by people as often as by machines, and
 * reordering it turns every future diff into noise.
 */
export function rewriteKeys(text: string, changes: { key: string; to: string }[]): string {
  const byKey = new Map(changes.map((c) => [c.key, c.to]))
  const seen = new Set<string>()

  const lines = text.split('\n').map((raw) => {
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(raw)
    if (!m) return raw
    const indent = m[1] ?? ''
    const key = m[2] ?? ''
    const eq = m[3] ?? '='
    const rest = m[4] ?? ''
    if (!byKey.has(key)) return raw
    seen.add(key)
    const value = byKey.get(key)!
    // Quote only when the value needs it, and keep the quotes it already had.
    const wasQuoted = /^(['"])[\s\S]*\1\s*$/.test(rest.trim())
    const needsQuote = /[\s#'"]/.test(value)
    return indent + key + eq + (wasQuoted || needsQuote ? JSON.stringify(value) : value)
  })

  // A key the file does not have yet is appended rather than dropped: a
  // manifest may declare a value the main checkout never needed.
  const missing = changes.filter((c) => !seen.has(c.key))
  if (missing.length) {
    if (lines[lines.length - 1] !== '') lines.push('')
    lines.push('# added by cockpit for this worktree')
    for (const c of missing) {
      lines.push(c.key + '=' + (/[\s#'"]/.test(c.to) ? JSON.stringify(c.to) : c.to))
    }
    lines.push('')
  }
  return lines.join('\n')
}

/* ── remembering the answer ──────────────────────────────────────────── */

/**
 * §5 — approve once, never again. Written through the yaml Document API so the
 * comments in a hand-written manifest (§11) survive.
 */
export function saveToManifest(manifestPath: string, entries: WorktreeSeed[]): boolean {
  if (!entries.length) return false
  let doc
  try {
    doc = parseDocument(readFileSync(manifestPath, 'utf8'))
  } catch {
    return false
  }

  let worktrees = doc.get('worktrees')
  if (!isMap(worktrees)) {
    doc.set('worktrees', doc.createNode({}))
    worktrees = doc.get('worktrees')
    if (!isMap(worktrees)) return false
  }

  const existing = worktrees.get('seed')
  const seeds: WorktreeSeed[] = isSeq(existing)
    ? (existing.toJSON() as WorktreeSeed[])
    : []

  // Replace the entry for a repo rather than stacking a second one: two
  // entries for the same repo is a file that quietly seeds twice.
  for (const entry of entries) {
    const at = seeds.findIndex((s) => (s.repo ?? null) === (entry.repo ?? null))
    if (at >= 0) seeds[at] = entry
    else seeds.push(entry)
  }

  worktrees.set('seed', doc.createNode(seeds))
  writeFileSync(manifestPath, doc.toString(), 'utf8')
  return true
}

/** The manifest form of an approved proposal: templates, never resolved values. */
export function toManifestEntry(proposal: SeedProposal): WorktreeSeed {
  const set: Record<string, Record<string, string>> = {}
  for (const f of proposal.files) {
    if (!f.changes.length) continue
    set[f.path] = Object.fromEntries(f.changes.map((c) => [c.key, c.template]))
  }
  return {
    repo: proposal.repo,
    copy: proposal.files.map((f) => f.path),
    ...(Object.keys(set).length ? { set } : {}),
  }
}
