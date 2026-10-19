import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseYaml, isMap, parseDocument } from 'yaml'
import { contractFrom, headingAnchor, linksIn, newId, resolveLink } from '@cockpit/shared'
import type { Actor, DocsContract, DocsInfo, DocsIssue, DocsPage, DocsProposal, DocsProposalSet, Project } from '@cockpit/shared'
import { readManifest } from './detect.js'
import { allWorkspaces, getProject, setSettings } from './registry.js'
import { attachmentsRoot } from './attachments.js'
import { isInside } from './config.js'
import { append } from './journal.js'
import * as memory from './memory.js'

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
const GUIDES = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'START-HERE.md', 'index.md', '_index.md', 'INDEX.md', 'Home.md']
/**
 * What the index may take of an opening. A line per page is ~30 tokens, so
 * this is a docs of about seventy pages in full; past it the index is said a
 * folder at a time, and `docs_search` finds the rest.
 */
const INDEX_CAP = 9000

/**
 * Where a project's docs are: the manifest's `docs:` (a repository, or a
 * folder inside one), then this machine's setting, then a `docs/` folder found
 * at the root. Null when none of them names a folder that exists.
 *
 * The manifest first: it is the one the whole team reads, and the one that
 * still means something in a fresh clone on another machine.
 */
export function docsOf(projectId: string): DocsInfo | null {
  const p = getProject(projectId)
  if (!p) return null
  const found = locate(p)
  if (!found) return null
  const ws = allWorkspaces(p.id)
    .filter((w) => w.kind !== 'group' && isInside(w.path, found.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  const repo = found.repo ?? (ws && ws.kind === 'main' ? ws.repoName || null : null)
  const folder = found.folder ?? (ws ? relative(ws.path, found.path) : '')
  return {
    path: found.path,
    source: found.source,
    workspaceId: ws?.id ?? null,
    repo,
    folder,
    exclude: found.exclude,
    guide: found.guide && existsSync(join(found.path, found.guide)) ? found.guide : guideIn(found.path),
    contract: contractFrom(found.contract),
  }
}

interface Found {
  path: string
  source: DocsInfo['source']
  repo?: string
  folder?: string
  exclude: string[]
  guide?: string
  contract?: unknown
}

function locate(p: Project): Found | null {
  const at = (raw: string) => (isAbsolute(raw) ? raw : resolve(p.root, raw))
  const ok = (path: string) => existsSync(path) && statSync(path).isDirectory()
  const m = p.manifestPath ? readManifest(p.manifestPath).manifest : null
  const d = m?.docs
  if (d) {
    const o = typeof d === 'string' ? { path: d } : d
    const extra = {
      exclude: Array.isArray(o.exclude) ? o.exclude.filter((x): x is string => typeof x === 'string') : [],
      guide: typeof o.guide === 'string' ? o.guide : undefined,
      contract: o.contract,
    }
    if (typeof o.repo === 'string' && o.repo.trim()) {
      const name = o.repo.trim()
      const ws = allWorkspaces(p.id).find(
        (w) => w.kind === 'main' && (w.repoName === name || (name === '.' && w.path === p.root)),
      )
      const folder = (o.folder ?? '').replace(/^\.?\/+|\/+$/g, '')
      const base = ws?.path ?? (name === '.' ? p.root : join(p.root, name))
      const path = folder ? join(base, folder) : base
      if (ok(path)) return { path, source: 'manifest', repo: name, folder, ...extra }
    } else if (typeof o.path === 'string' && ok(at(o.path))) {
      return { path: at(o.path), source: 'manifest', ...extra }
    }
  }
  if (p.settings.docsPath && ok(p.settings.docsPath)) return { path: p.settings.docsPath, source: 'settings', exclude: [] }
  for (const c of p.capabilities) {
    if (c.id !== 'docs' || c.source !== 'detected' || typeof c.detail?.path !== 'string') continue
    const path = at(c.detail.path)
    if (ok(path)) return { path, source: 'detected', exclude: [] }
  }
  return null
}

/**
 * Point the project at its docs — or at none. Into `cockpit.yaml` when the
 * folder is in one of the project's repositories and the project has a
 * manifest, as `{ repo, folder }`, so the next clone finds them too; what the
 * manifest's `docs:` already says beside that (`exclude`, `contract`) is kept.
 * Otherwise this machine's setting, as before.
 */
export function setHome(projectId: string, path: string | null): DocsInfo | null {
  const p = getProject(projectId)
  if (!p) throw new Error('unknown project: ' + projectId)
  const ws = path
    ? allWorkspaces(p.id)
        .filter((w) => w.kind === 'main' && isInside(w.path, path))
        .sort((a, b) => b.path.length - a.path.length)[0]
    : undefined
  if (p.manifestPath && (!path || ws)) {
    const doc = parseDocument(readFileSync(p.manifestPath, 'utf8'))
    if (!path) doc.delete('docs')
    else {
      const repo = ws!.path === p.root && !ws!.repoName ? '.' : ws!.repoName
      const folder = relative(ws!.path, path)
      const was = doc.get('docs', true)
      if (!isMap(was)) doc.set('docs', doc.createNode({}))
      doc.deleteIn(['docs', 'path'])
      doc.setIn(['docs', 'repo'], repo)
      if (folder) doc.setIn(['docs', 'folder'], folder)
      else doc.deleteIn(['docs', 'folder'])
    }
    writeFileSync(p.manifestPath, String(doc), 'utf8')
    append({ type: 'manifest.written', projectId, actor: { kind: 'human' }, payload: { section: 'docs' } })
    if (p.settings.docsPath) setSettings(projectId, { docsPath: null })
  } else {
    setSettings(projectId, { docsPath: path })
  }
  return docsOf(projectId)
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

/* ── the index ────────────────────────────────────────────────────────────
 *
 * One line per page — its path and what it answers — is what lets an agent
 * know the docs without being handed them, and what the reader lists. Read
 * from the files every time it is asked, with a page re-parsed only when its
 * file changed: the docs are a folder anybody edits, not a store Cockpit owns.
 */

interface Parsed {
  mtime: number
  size: number
  meta: Record<string, unknown> | null
  title: string
  summary: string | null
  words: number
  targets: string[]
  text: string
}

const parsedCache = new Map<string, Parsed>()

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** The frontmatter, when there is one that parses, and what follows it. */
export function splitPage(text: string): { meta: Record<string, unknown> | null; body: string } {
  const m = FRONTMATTER.exec(text)
  if (!m) return { meta: null, body: text }
  try {
    const meta = parseYaml(m[1]!) as unknown
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      return { meta: meta as Record<string, unknown>, body: text.slice(m[0].length) }
    }
  } catch {
    /* not YAML: the page has no frontmatter, and says so as an issue */
  }
  return { meta: null, body: text.slice(m[0].length) }
}

const strOf = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : v instanceof Date ? v.toISOString().slice(0, 10) : null
const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(strOf).filter((s): s is string => !!s) : strOf(v) ? [strOf(v)!] : []

/**
 * The quote right under the heading — `> **In one sentence**: …` — when the
 * page says what it answers that way instead of in `summary:`. A callout
 * (`> [!warning]`) is not a summary.
 */
function leadingQuote(body: string): string | null {
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && !lines[i]!.trim()) i++
  if (/^#\s/.test(lines[i] ?? '')) i++
  while (i < lines.length && !lines[i]!.trim()) i++
  if (!/^>/.test(lines[i] ?? '') || /^>\s*\[!/.test(lines[i]!)) return null
  const out: string[] = []
  while (i < lines.length && /^>/.test(lines[i]!)) {
    const l = lines[i]!.replace(/^>\s?/, '').trim()
    if (!l) break
    out.push(l)
    i++
  }
  const text = out
    .join(' ')
    .replace(/^\*\*[^*]{1,40}\*\*\s*:?\s*/, '')
    .replace(/\*\*/g, '')
    .trim()
  return text ? clip(text, 220) : null
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s
}

function parse(file: string, rel: string): Parsed {
  const st = statSync(file)
  const hit = parsedCache.get(file)
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit
  const text = readFileSync(file, 'utf8')
  const { meta, body } = splitPage(text)
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
  const stemName = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
  const parsed: Parsed = {
    mtime: st.mtimeMs,
    size: st.size,
    meta,
    title: strOf(meta?.title) ?? h1 ?? stemName,
    summary: strOf(meta?.summary) ?? strOf(meta?.description) ?? leadingQuote(body),
    words: body.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length,
    targets: [...new Set(linksIn(body).map((l) => l.target))],
    text,
  }
  parsedCache.set(file, parsed)
  return parsed
}

/**
 * Whether a page is left out by `exclude:`. A pattern without a slash matches
 * a name anywhere (`Clippings`, `Untitled*`); one with a slash matches from the
 * docs' root (`archive/2024`).
 */
function excluded(rel: string, patterns: readonly string[]): boolean {
  if (!patterns.length) return false
  const segs = rel.split('/')
  return patterns.some((raw) => {
    const pat = raw.replace(/^\.?\/+|\/+$/g, '')
    if (!pat) return false
    const re = new RegExp('^' + pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$', 'i')
    if (!pat.includes('/')) return segs.some((s) => re.test(s) || re.test(s.replace(/\.[^.]+$/, '')))
    const depth = pat.split('/').length
    return re.test(segs.slice(0, depth).join('/'))
  })
}

/** Every page of the project's docs, checked against the contract. */
export function indexOf(projectId: string): DocsPage[] {
  const info = docsOf(projectId)
  return info ? indexAt(info.path, info) : []
}

function indexAt(root: string, info: Pick<DocsInfo, 'exclude' | 'contract' | 'guide'>): DocsPage[] {
  let rels: string[]
  try {
    rels = pagesUnder(root).filter((r) => /\.(md|mdx|markdown)$/i.test(r) && !excluded(r, info.exclude))
  } catch {
    return []
  }
  const parsed = rels.map((rel) => ({ rel, p: parse(join(root, rel), rel) }))
  const refs = parsed.map(({ rel, p }) => ({ path: rel, aliases: listOf(p.meta?.aliases) }))
  return parsed
    .map(({ rel, p }) => {
      const links: string[] = []
      const broken: string[] = []
      for (const t of p.targets) {
        const to = resolveLink(t, rel, refs)
        if (to) {
          if (to !== rel && !links.includes(to)) links.push(to)
        } else if (!/^https?:/i.test(t)) broken.push(t)
      }
      const page: DocsPage = {
        path: rel,
        title: p.title,
        kind: strOf(p.meta?.type),
        summary: p.summary,
        aliases: listOf(p.meta?.aliases),
        covers: listOf(p.meta?.covers),
        updated: strOf(p.meta?.updated),
        words: p.words,
        links,
        broken,
        issues: [],
      }
      page.issues = check(page, p.meta, info.contract, rel === info.guide)
      return page
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * What a page does not do that the contract asks. The guide is the page about
 * the pages: it is held to the size and the links, not to the frontmatter.
 */
function check(page: DocsPage, meta: Record<string, unknown> | null, c: DocsContract, guide: boolean): DocsIssue[] {
  const out: DocsIssue[] = []
  if (!guide) {
    if (!meta) out.push({ code: 'frontmatter', text: 'No frontmatter: the index has only its file name and first heading.' })
    else if (!strOf(meta.title)) out.push({ code: 'title', text: 'No `title:`.' })
    if (!page.summary) out.push({ code: 'summary', text: 'Says nowhere what it answers — no `summary:`, no quote under the heading.' })
    const kinds = Object.keys(c.kinds)
    if (meta && kinds.length) {
      if (!page.kind) out.push({ code: 'type', text: '`type:` is missing — one of ' + kinds.join(', ') + '.' })
      else if (!c.kinds[page.kind]) out.push({ code: 'type', text: '`type: ' + page.kind + '` is not one of ' + kinds.join(', ') + '.' })
      else {
        const folder = c.kinds[page.kind]!.folder
        if (folder && !(page.path + '/').startsWith(folder + '/')) {
          out.push({ code: 'folder', text: 'A ' + page.kind + ' lives in `' + folder + '/`.' })
        }
      }
    }
    if (meta) {
      for (const [name, f] of Object.entries(c.fields)) {
        const vals = listOf(meta[name])
        if (!vals.length) {
          if (f.required) out.push({ code: 'field', text: '`' + name + ':` is missing.' })
          continue
        }
        const bad = f.values?.length ? vals.filter((v) => !f.values!.includes(v)) : []
        if (bad.length) out.push({ code: 'field', text: '`' + name + ': ' + bad.join(', ') + '` is not one of ' + f.values!.join(', ') + '.' })
      }
    }
  }
  if (page.words > c.maxWords) {
    out.push({ code: 'size', text: page.words + ' words, over ' + c.maxWords + ': two subjects, or one and its history.' })
  }
  if (page.broken.length) {
    out.push({ code: 'link', text: 'Links to no page: ' + page.broken.map((b) => '[[' + b + ']]').join(', ') + '.' })
  }
  return out
}

/** One page's text, by its path from the docs' root. */
export function pageText(projectId: string, rel: string): string | null {
  const info = docsOf(projectId)
  if (!info) return null
  const file = resolve(info.path, rel)
  if (!isInside(info.path, file) || !existsSync(file)) return null
  return readFileSync(file, 'utf8')
}

/** The block under one heading, down to the next heading as high or higher. */
export function sectionOf(text: string, heading: string): string | null {
  const want = headingAnchor(heading.replace(/^#+\s*/, ''))
  const lines = text.split('\n')
  let start = -1
  let level = 0
  let fence = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    if (fence) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l)
    if (!m) continue
    if (start < 0) {
      if (headingAnchor(m[2]!) === want) {
        start = i
        level = m[1]!.length
      }
    } else if (m[1]!.length <= level) {
      return lines.slice(start, i).join('\n').trimEnd()
    }
  }
  return start < 0 ? null : lines.slice(start).join('\n').trimEnd()
}

/** The headings of a page, for saying which sections there are to read. */
export function headingsOf(text: string): string[] {
  const out: string[] = []
  let fence = false
  for (const l of splitPage(text).body.split('\n')) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    const m = !fence && /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(l)
    if (m) out.push((m[1] === '###' ? '  ' : '') + m[2])
  }
  return out
}

export interface SearchHit {
  path: string
  title: string
  summary: string | null
  lines: { heading: string | null; text: string }[]
}

/**
 * Pages about some words, best first. Plain word matching, weighted toward the
 * title and summary: the docs are a few hundred pages, and an agent asking for
 * "credit notes" wants the page called that before the ten that mention one.
 */
export function search(projectId: string, query: string, limit = 8): SearchHit[] {
  const info = docsOf(projectId)
  if (!info) return []
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length > 1))]
  if (!terms.length) return []
  const hits: (SearchHit & { score: number })[] = []
  for (const page of indexAt(info.path, info)) {
    const p = parsedCache.get(join(info.path, page.path))
    if (!p) continue
    const head = (page.title + ' ' + page.path + ' ' + page.aliases.join(' ')).toLowerCase()
    const sum = (page.summary ?? '').toLowerCase()
    let score = 0
    for (const t of terms) {
      if (head.includes(t)) score += 6
      if (sum.includes(t)) score += 3
    }
    const lines: SearchHit['lines'] = []
    let heading: string | null = null
    let bodyScore = 0
    for (const l of splitPage(p.text).body.split('\n')) {
      const h = /^#{1,6}\s+(.+)$/.exec(l)
      if (h) {
        heading = h[1]!.trim()
        continue
      }
      const low = l.toLowerCase()
      const n = terms.filter((t) => low.includes(t)).length
      if (!n) continue
      bodyScore += n === terms.length ? 2 : 1
      if (lines.length < 3 && l.trim().length > 2) lines.push({ heading, text: clip(l.trim(), 180) })
    }
    score += Math.min(bodyScore, 12)
    if (score) hits.push({ path: page.path, title: page.title, summary: page.summary, lines, score })
  }
  return hits
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(({ score: _s, ...h }) => h)
}

/**
 * The docs, as the engine is told about them at launch: where they are, how a
 * page is written, and the index — the map, not the territory. `tools` is
 * whether this engine holds `docs_read` / `docs_search`.
 */
export function preambleBlock(info: DocsInfo | null, tools = true): string {
  if (!info) return ''
  const lines = [
    '# Documentation — ' + info.path,
    "This project's lasting documentation: how things work, the contracts between parts, the decisions",
    'and their reasons. Read the pages that touch what you change before you change it' +
      (tools ? ' — `docs_read` takes one section at a time, `docs_search` finds pages by words.' : '.'),
    'Do not edit it while you work: changes to it are proposed in a documentation step, and a person',
    'accepts each one.' +
      (tools ? ' When what you do or learn makes a page untrue, or a page you needed does not exist, say so with `docs_flag`.' : ''),
  ]
  if (info.guide) lines.push('Its guide is `' + info.guide + '`: read it before you write a page.')
  const pages = indexAt(info.path, info)
  if (pages.length) lines.push('', '## Index', '', indexLines(pages))
  return lines.join('\n')
}

/** One line per page while that fits; past it, a folder at a time. */
function indexLines(pages: DocsPage[]): string {
  const full = pages.map((p) => '- ' + p.path + ' — ' + (p.summary ? p.title + ': ' + p.summary : p.title))
  const all = full.join('\n')
  if (all.length <= INDEX_CAP) return all
  const folders = new Map<string, DocsPage[]>()
  for (const p of pages) {
    const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '.'
    folders.set(dir, [...(folders.get(dir) ?? []), p])
  }
  const out = ['(' + pages.length + ' pages — one line per folder; `docs_search` finds a page by its words.)']
  for (const [dir, ps] of folders) {
    out.push(clip('- ' + dir + '/ (' + ps.length + '): ' + ps.map((p) => p.title).join(' · '), 300))
  }
  return clip(out.join('\n'), INDEX_CAP * 2)
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
  /** The memory the copy was taken of, and its entries then — what a deletion is measured from. */
  memory: { id: string; file: string; kind: memory.MemoryHome['kind']; entries: string[] } | null
}

/** Where the agent prunes — beside the docs copy, never inside it. */
export function memoryCopy(id: string): string {
  return join(setDir(id), 'memory.md')
}

const ENTRY = /^\s*[-*+]\s+/

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
export function stage(
  projectId: string,
  sessionId: string,
  title: string,
  home?: memory.MemoryHome | null,
  only?: readonly string[] | null,
): Stored {
  const info = docsOf(projectId)
  if (!info) throw new Error('this project has no documentation linked — set one in the project settings')
  const id = newId('docs_')
  const copy = copyDir(id)
  mkdirSync(copy, { recursive: true })
  const base: Record<string, string> = {}
  // §9 — scoped to the pages an offer named: a copy of six hundred pages to
  // change three is slow to take and slower for the agent to find its way in.
  const want = only ? new Set(only) : null
  for (const rel of want ? [...want].filter((r) => existsSync(join(info.path, r))) : pagesUnder(info.path)) {
    if (excluded(rel, info.exclude)) continue
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
    forget: null,
    base,
    memory: null,
  }
  const mem = home ? memory.contentAt(home.file, home.kind) : null
  if (home && mem && memory.hasEntries(mem)) {
    writeFileSync(memoryCopy(id), mem, 'utf8')
    set.memory = { id: home.id, file: home.file, kind: home.kind, entries: mem.split('\n').filter((l) => ENTRY.test(l)) }
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
    if (!was && before === after) continue
    files.push({
      path: rel,
      // A page the copy did not hold — a scoped copy holds only some — that
      // the docs do: the agent copied it in to change it.
      kind: was || before !== null ? 'changed' : 'new',
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
  // Checked as the docs would be with every proposal in: a link to a page
  // proposed beside it is not broken.
  const info = docsOf(set.projectId)
  if (info) {
    const after = new Map(indexAt(copy, info).map((p) => [p.path, p.issues]))
    for (const f of files) if (f.after !== null) f.issues = after.get(f.path) ?? []
  }
  set.files = files
  // Entries deleted from the memory copy: proposed for removal, but only
  // alongside pages — pruning what no page now says would lose it.
  if (set.memory && files.length && existsSync(memoryCopy(id))) {
    const left = new Set(readFileSync(memoryCopy(id), 'utf8').split('\n'))
    const gone = set.memory.entries.filter((l) => !left.has(l))
    if (gone.length) set.forget = { entries: gone, state: 'pending' }
  }
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

/**
 * Where a set stands, for whoever made it: still being written, waiting on a
 * person, decided — or gone wrong, or unknown.
 */
export function setStatus(id: string): 'drafting' | 'waiting' | 'done' | 'failed' | null {
  const set = load(id)
  if (!set) return null
  if (set.status === 'drafting') return 'drafting'
  if (set.status === 'failed') return 'failed'
  if (set.status === 'dismissed') return 'done'
  return set.files.some((f) => f.state === 'pending') || set.forget?.state === 'pending' ? 'waiting' : 'done'
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
  const { base: _base, memory: _memory, ...rest } = s
  return { ...rest, forget: rest.forget ?? null }
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
      (s) =>
        s.status !== 'dismissed' &&
        (s.status !== 'ready' || s.files.some((f) => f.state === 'pending') || s.forget?.state === 'pending'),
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

/**
 * The memory's pruning, decided — after the pages. `keep` is what the person
 * unticked: those stay. Removed lines are matched exactly, so an entry
 * rewritten in the meantime is never taken.
 */
export function resolveForget(id: string, accept: boolean, keep: string[] = []): DocsProposalSet {
  const set = load(id)
  if (!set?.forget) throw new Error('nothing to forget in ' + id)
  if (set.files.some((f) => f.state === 'pending')) throw new Error('decide the pages first')
  if (accept && set.memory) {
    const drop = set.forget.entries.filter((l) => !keep.includes(l))
    memory.forget({ id: set.memory.id, file: set.memory.file, kind: set.memory.kind, label: '', workspaceId: null }, drop, {
      kind: 'human',
    })
  }
  set.forget.state = accept ? 'accepted' : 'rejected'
  save(set)
  return strip(set)
}

export function dismiss(id: string): void {
  const set = load(id)
  if (!set) return
  for (const f of set.files) if (f.state === 'pending') f.state = 'rejected'
  if (set.forget?.state === 'pending') set.forget.state = 'rejected'
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
  // A single place that writes an accepted page — where a commit (and a push)
  // of the docs will go once they are automatic.
  writeFileSync(real, stamped(content ?? f.after ?? ''), 'utf8')
}

/**
 * `updated:` is Cockpit's to write, on the day a person accepts the change:
 * an agent asked to keep it right gets it wrong in one page in three. Only in
 * a page that has frontmatter — a page without any is not given one for a date.
 */
export function stamped(text: string, day = new Date()): string {
  const m = FRONTMATTER.exec(text)
  if (!m) return text
  const date = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0')
  const block = m[1]!
  const next = /^updated:.*$/m.test(block) ? block.replace(/^updated:.*$/m, 'updated: ' + date) : block + '\nupdated: ' + date
  return text.slice(0, m.index) + m[0].replace(block, () => next) + text.slice(m.index + m[0].length)
}

/** The working copy goes once nothing in it is waiting; the record stays. */
function finishIfDone(set: Stored, force = false): void {
  // Every page decided and not one kept: nothing says the notes for good, so
  // they stay in the memory.
  if (set.forget?.state === 'pending' && set.files.every((f) => f.state === 'rejected')) {
    set.forget.state = 'rejected'
    save(set)
  }
  if (!force && set.files.some((f) => f.state === 'pending')) return
  rmSync(copyDir(set.id), { recursive: true, force: true })
}
