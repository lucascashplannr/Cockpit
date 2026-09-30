import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { newId } from '@cockpit/shared'
import type { Actor, DocsInfo, DocsProposal, DocsProposalSet, Project } from '@cockpit/shared'
import { allWorkspaces, getProject } from './registry.js'
import { attachmentsRoot } from './attachments.js'
import { isInside } from './config.js'
import { append } from './journal.js'

/**
 * §9 — "Un wiki alimenté séparément meurt en trois mois, toujours. Un wiki
 * alimenté par le résidu naturel du travail survit."
 *
 * Two directions, and a gate on only one of them:
 *
 * - **In**: every conversation is told where the docs are and handed the page
 *   that says how they are organised, so it reads the relevant one instead of
 *   having it re-explained. It is not handed the docs themselves — a vault of
 *   six hundred notes is not a preamble.
 * - **Out**: the Document step. The agent that did the work, with the whole
 *   conversation still in front of it, edits a *working copy* of the docs; what
 *   differs from the docs becomes proposals, and a person accepts or rejects
 *   each one. The memory is disposable and written freely. The docs are
 *   forever, so nothing reaches them unseen.
 *
 * The working copy lives under the attachments folder because that folder is
 * handed to every engine at launch — the only directory a conversation that
 * is already running can write to without being restarted.
 */

/** What counts as a page: text a person reads. Pictures and exports stay put. */
const PAGE = /\.(md|mdx|markdown|txt|rst|adoc)$/i
/** Folders that are tooling or history, never pages. */
const SKIP = new Set(['node_modules', '.git', '.obsidian', '.trash', '.cockpit', 'dist', 'build'])
/** Past this the copy is a backup job, not a working copy. */
const MAX_PAGES = 5000
const MAX_BYTES = 64 * 1024 * 1024
const GUIDES = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'index.md', '_index.md', 'INDEX.md', 'Home.md']
const GUIDE_CAP = 3000

/**
 * Where a project's docs are: this machine's setting, then the manifest's
 * `docs:`, then a `docs/` folder found at the root. Null when none of the
 * three names a folder that exists.
 */
export function docsOf(projectId: string): DocsInfo | null {
  const p = getProject(projectId)
  if (!p) return null
  const found = locate(p)
  if (!found) return null
  const ws = allWorkspaces(p.id)
    .filter((w) => w.kind !== 'group' && isInside(w.path, found.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return { ...found, workspaceId: ws?.id ?? null, guide: guideIn(found.path) }
}

function locate(p: Project): { path: string; source: DocsInfo['source'] } | null {
  const at = (raw: string) => (isAbsolute(raw) ? raw : resolve(p.root, raw))
  const ok = (path: string) => existsSync(path) && statSync(path).isDirectory()
  if (p.settings.docsPath && ok(p.settings.docsPath)) return { path: p.settings.docsPath, source: 'settings' }
  for (const c of p.capabilities) {
    if (c.id !== 'docs' || typeof c.detail?.path !== 'string') continue
    const path = at(c.detail.path)
    if (ok(path)) return { path, source: c.source === 'manifest' ? 'manifest' : 'detected' }
  }
  return null
}

/** The page that explains the rest, by the names such a page is given. */
function guideIn(root: string): string | null {
  for (const name of GUIDES) if (existsSync(join(root, name))) return name
  // A vault names its guide after itself — `AGENTS-vault-guide.md`.
  try {
    const hit = readdirSync(root).find((f) => /^(agents|guide|readme)[-_ .].*\.md$/i.test(f))
    if (hit) return hit
  } catch {
    /* unreadable: no guide */
  }
  return null
}

/**
 * The docs, as the engine is told about them at launch. The guide's opening
 * rather than the docs: enough to know where things are and how pages are
 * written, and a pointer to read the rest with the tools it already has.
 */
export function preambleBlock(info: DocsInfo | null): string {
  if (!info) return ''
  const lines = [
    '# Documentation — ' + info.path,
    "This project's lasting documentation. Read the relevant pages before changing documented behaviour.",
    'Do not edit it while you work: changes to it are proposed in a documentation step, and a person',
    'accepts each one.',
  ]
  if (info.guide) {
    let guide = ''
    try {
      guide = readFileSync(join(info.path, info.guide), 'utf8').trim()
    } catch {
      /* gone since: no excerpt */
    }
    if (guide) {
      const cut = guide.length > GUIDE_CAP ? guide.slice(0, GUIDE_CAP).trimEnd() + '\n…' : guide
      lines.push('', '## ' + info.guide + (guide.length > GUIDE_CAP ? ' (opening)' : ''), '', cut)
    }
  }
  return lines.join('\n')
}

/* ── the working copy ─────────────────────────────────────────────────── */

function stagingRoot(): string {
  const dir = join(attachmentsRoot(), 'docs')
  mkdirSync(dir, { recursive: true })
  return dir
}

function setDir(id: string): string {
  return join(stagingRoot(), id)
}

/** Where the agent writes — what the prompt names. */
export function copyDir(id: string): string {
  return join(setDir(id), 'copy')
}

interface Stored extends DocsProposalSet {
  /** Each page's hash when the copy was taken: what "changed" is measured from. */
  base: Record<string, string>
}

function save(set: Stored): void {
  writeFileSync(join(setDir(set.id), 'set.json'), JSON.stringify(set), 'utf8')
}

function load(id: string): Stored | null {
  try {
    return JSON.parse(readFileSync(join(setDir(id), 'set.json'), 'utf8')) as Stored
  } catch {
    return null
  }
}

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

function pagesUnder(root: string): string[] {
  const out: string[] = []
  let bytes = 0
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.isDirectory()) continue
      if (SKIP.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && PAGE.test(e.name)) {
        out.push(relative(root, p))
        bytes += statSync(p).size
        if (out.length > MAX_PAGES || bytes > MAX_BYTES) {
          throw new Error('the docs are too large to copy (' + out.length + ' pages, ' + Math.round(bytes / 1e6) + ' MB)')
        }
      }
    }
  }
  walk(root)
  return out
}

/**
 * A fresh working copy of the project's docs, for one Document step. Answers
 * the set, still `drafting`: it becomes proposals once the turn has landed.
 */
export function stage(projectId: string, sessionId: string, title: string): Stored {
  const info = docsOf(projectId)
  if (!info) throw new Error('this project has no documentation linked — set one in the project settings')
  const id = newId('docs_')
  const copy = copyDir(id)
  mkdirSync(copy, { recursive: true })
  const base: Record<string, string> = {}
  for (const rel of pagesUnder(info.path)) {
    const text = readFileSync(join(info.path, rel), 'utf8')
    mkdirSync(dirname(join(copy, rel)), { recursive: true })
    writeFileSync(join(copy, rel), text, 'utf8')
    base[rel] = hash(text)
  }
  const set: Stored = {
    id,
    projectId,
    docsPath: info.path,
    sessionId,
    title,
    createdAt: Date.now(),
    status: 'drafting',
    detail: null,
    files: [],
    base,
  }
  save(set)
  return set
}

/**
 * What the agent changed in the copy, as proposals. `reply` is its closing
 * message, read for the "path — why" lines the prompt asked it to end with.
 */
export function collect(id: string, reply: string, actor?: Actor): DocsProposalSet {
  const set = load(id)
  if (!set) throw new Error('unknown proposal set: ' + id)
  const copy = copyDir(id)
  const why = reasonsIn(reply)
  const files: DocsProposal[] = []
  let now: string[]
  try {
    now = pagesUnder(copy)
  } catch {
    now = []
  }
  const seen = new Set<string>()
  for (const rel of now) {
    seen.add(rel)
    const after = readFileSync(join(copy, rel), 'utf8')
    const was = set.base[rel]
    if (was && was === hash(after)) continue
    const real = join(set.docsPath, rel)
    const before = existsSync(real) ? readFileSync(real, 'utf8') : null
    files.push({
      path: rel,
      kind: was ? 'changed' : 'new',
      before,
      after,
      why: why.get(rel) ?? null,
      state: 'pending',
      drifted: !!was && before !== null && hash(before) !== was,
    })
  }
  for (const rel of Object.keys(set.base)) {
    if (seen.has(rel)) continue
    const real = join(set.docsPath, rel)
    files.push({
      path: rel,
      kind: 'deleted',
      before: existsSync(real) ? readFileSync(real, 'utf8') : null,
      after: null,
      why: why.get(rel) ?? null,
      state: 'pending',
      drifted: false,
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  set.files = files
  set.status = 'ready'
  set.detail = files.length ? null : 'nothing worth documenting'
  save(set)
  append({
    type: 'docs.proposed',
    // Drafted by the agent; only what a person accepts is theirs (§12).
    actor,
    projectId: set.projectId,
    payload: { setId: id, sessionId: set.sessionId, pages: files.map((f) => f.path) },
  })
  return strip(set)
}

export function fail(id: string, detail: string): void {
  const set = load(id)
  if (!set) return
  set.status = 'failed'
  set.detail = detail
  save(set)
}

/** "`api/invoices.md` — why" and the plainer spellings of it. */
function reasonsIn(reply: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of reply.split('\n')) {
    const m = /^\s*(?:[-*•]|\d+\.)?\s*\**`?([^`*\s][^`*]*?\.(?:md|mdx|markdown|txt|rst|adoc))`?\**\s*(?:—|–|-|:)\s*(.+)$/i.exec(line)
    if (m) out.set(m[1]!.replace(/^\.?\//, '').replace(/^copy\//, ''), m[2]!.trim())
  }
  return out
}

function strip(s: Stored): DocsProposalSet {
  const { base: _base, ...rest } = s
  return rest
}

/** Sets still waiting on someone, newest first. Resolved ones fall away. */
export function pending(projectId: string): DocsProposalSet[] {
  let ids: string[] = []
  try {
    ids = readdirSync(stagingRoot())
  } catch {
    return []
  }
  return ids
    .map(load)
    .filter((s): s is Stored => !!s && s.projectId === projectId)
    .filter(
      (s) => s.status !== 'dismissed' && (s.status !== 'ready' || s.files.some((f) => f.state === 'pending')),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(strip)
}

/**
 * One page, decided. Accepting writes it into the docs — `content` when the
 * person edited the proposal first — and is journalled as theirs: the agent
 * drafted it, a person put it in the docs.
 */
export function resolvePage(
  id: string,
  path: string,
  accept: boolean,
  content?: string,
): DocsProposalSet {
  const set = load(id)
  if (!set) throw new Error('unknown proposal set: ' + id)
  const f = set.files.find((x) => x.path === path)
  if (!f) throw new Error('no proposal for ' + path)
  if (accept) write(set, f, content)
  f.state = accept ? 'accepted' : 'rejected'
  save(set)
  append({
    type: accept ? 'docs.accepted' : 'docs.rejected',
    projectId: set.projectId,
    payload: { setId: id, path, kind: f.kind, edited: content !== undefined && content !== f.after },
  })
  finishIfDone(set)
  return strip(set)
}

export function dismiss(id: string): void {
  const set = load(id)
  if (!set) return
  for (const f of set.files) if (f.state === 'pending') f.state = 'rejected'
  set.status = 'dismissed'
  save(set)
  finishIfDone(set, true)
}

function write(set: Stored, f: DocsProposal, content?: string): void {
  const real = resolve(set.docsPath, f.path)
  if (!isInside(set.docsPath, real)) throw new Error('outside the docs: ' + f.path)
  if (f.kind === 'deleted') {
    if (existsSync(real)) unlinkSync(real)
    return
  }
  mkdirSync(dirname(real), { recursive: true })
  writeFileSync(real, content ?? f.after ?? '', 'utf8')
}

/** The working copy goes once nothing in it is waiting; the record stays. */
function finishIfDone(set: Stored, force = false): void {
  if (!force && set.files.some((f) => f.state === 'pending')) return
  rmSync(copyDir(set.id), { recursive: true, force: true })
}
