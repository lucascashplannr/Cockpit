/**
 * §9 — what a page of the docs is, shared by the core that indexes and checks
 * the pages, the agent that reads and drafts them, and the window that shows
 * them. One definition, so the three cannot disagree about what a page is.
 *
 * The memory is short-lived and written freely. The docs are the opposite: a
 * page is read by a person *and* handed to an agent, again and again, so it has
 * to be clear enough to need no interpretation and small enough to be worth its
 * place in a context. The contract below is how: a page says what it is in one
 * line, holds one subject, states what is true rather than how it came to be,
 * and links instead of repeating.
 *
 * Cockpit's rules are the floor, not the whole house. A project adds its own in
 * `cockpit.yaml` — the kinds of page it has and where they live, the fields its
 * pages carry, the language they are written in, rules of its own — and can
 * loosen the size budget. It cannot drop the floor.
 */

/** A kind of page — `concept`, `howto` — as a project declares it. */
export interface DocsKind {
  /** Where pages of this kind live, relative to the docs. */
  folder?: string
  /** One line: what a page of this kind is for. */
  is?: string
  /** The headings a page of this kind has, in order. */
  sections?: string[]
}

/** A frontmatter field beyond Cockpit's own, as a project declares it. */
export interface DocsField {
  /** The values it may take. Absent: free. */
  values?: string[]
  required?: boolean
  /** One line, for whoever writes the page. */
  is?: string
}

export interface DocsContract {
  /** What the pages are written in — "Dutch". Null: whatever the docs already are. */
  language: string | null
  /** Past this a page is split into linked pages. */
  maxWords: number
  /** Declared kinds by name. Empty: `type:` is free. */
  kinds: Record<string, DocsKind>
  /** Declared fields beyond Cockpit's own, by name. */
  fields: Record<string, DocsField>
  /** The project's own rules, one line each, said after Cockpit's. */
  rules: string[]
}

/** Cockpit's own fields. A project may describe them further, never redefine them. */
export const DOCS_FIELDS = ['title', 'type', 'summary', 'covers', 'aliases', 'tags', 'updated'] as const

/**
 * About ten minutes of reading, and about 2,000 tokens handed to an agent. A
 * page past it is almost always two subjects, or a subject and its history.
 */
export const DOCS_MAX_WORDS = 1500

export const DOCS_CONTRACT: DocsContract = {
  language: null,
  maxWords: DOCS_MAX_WORDS,
  kinds: {},
  fields: {},
  rules: [],
}

/**
 * The floor, as an agent reads it. Each line is a rule a reviewer can check a
 * page against — not advice.
 */
export const DOCS_RULES: readonly string[] = [
  'One subject per page, named by its `title:` and its `# heading`.',
  'Open with what the page answers, in one sentence: the `summary:` field, or a quote right under the heading. It is the page\'s line in the index every agent is handed.',
  'State what is true now, plainly, one fact per sentence. Name files, endpoints, fields and values exactly. No history — git keeps it. No progress, plans or status — the memory keeps those.',
  'Define a term on one page and link to it everywhere else — `[[page]]`, `[[page#Heading]]`, `[[page|label]]`. Never restate what another page says.',
  'Headings are anchors other pages link to: rename one only together with its links.',
  '`covers:` lists the code the page describes — paths from the project root, globs allowed. It is how Cockpit tells that a page may be out of date.',
  'Do not write `updated:`: Cockpit sets it when a change is accepted.',
]

/**
 * A project's contract over Cockpit's. Kinds, fields and rules add up; the
 * budget is the project's when it gives one. Anything malformed is dropped
 * rather than refused: a typo in `cockpit.yaml` must not take the docs away.
 */
export function contractFrom(raw: unknown): DocsContract {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter((s): s is string => !!s) : undefined)
  const map = (v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>) : []

  const kinds: Record<string, DocsKind> = {}
  for (const [name, v] of map(o.kinds)) {
    const k = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
    kinds[name] = { folder: str(k.folder)?.replace(/^\.?\/+|\/+$/g, ''), is: str(k.is), sections: list(k.sections) }
  }
  const fields: Record<string, DocsField> = {}
  for (const [name, v] of map(o.fields)) {
    const f = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
    fields[name] = { values: list(f.values), required: f.required === true, is: str(f.is) }
  }
  const max = typeof o.maxWords === 'number' && o.maxWords >= 100 ? Math.round(o.maxWords) : DOCS_MAX_WORDS
  return {
    language: str(o.language) ?? null,
    maxWords: max,
    kinds,
    fields,
    rules: list(o.rules) ?? [],
  }
}

/** The contract as an agent is told it: Cockpit's rules, then the project's. */
export function contractText(c: DocsContract): string {
  const out: string[] = ['How a page is written:']
  const rules = [
    ...DOCS_RULES,
    'At most ' + c.maxWords + ' words; past that, split it into pages that link to each other.',
    c.language ? 'Write in ' + c.language + '.' : 'Write in the language the docs are already written in.',
  ]
  for (const r of rules) out.push('- ' + r)
  const kinds = Object.entries(c.kinds)
  if (kinds.length) {
    out.push('', 'Kinds of page — `type:` is one of these, and the page lives in its folder:')
    for (const [name, k] of kinds) {
      const bits = [k.folder ? '`' + k.folder + '/`' : null, k.is ?? null].filter(Boolean)
      out.push('- `' + name + '`' + (bits.length ? ' — ' + bits.join(' — ') : ''))
      if (k.sections?.length) out.push('  sections: ' + k.sections.map((s) => '`## ' + s + '`').join(', '))
    }
  }
  const fields = Object.entries(c.fields)
  if (fields.length) {
    out.push('', 'Fields this project\'s pages carry, beside `title`, `type`, `summary`, `covers`, `aliases`, `tags`:')
    for (const [name, f] of fields) {
      const bits = [
        f.required ? 'required' : null,
        f.values?.length ? 'one of ' + f.values.map((v) => '`' + v + '`').join(', ') : null,
        f.is ?? null,
      ].filter(Boolean)
      out.push('- `' + name + '`' + (bits.length ? ' — ' + bits.join('; ') : ''))
    }
  }
  if (c.rules.length) {
    out.push('', 'This project\'s own rules:')
    for (const r of c.rules) out.push('- ' + r)
  }
  return out.join('\n')
}

/* ── links ────────────────────────────────────────────────────────────────
 *
 * Obsidian's: `[[target]]`, `[[target#Heading]]`, `[[target|label]]`, where the
 * target is a page's name, a path from the docs' root, or a path relative to
 * the page — with or without `.md`. Resolved the way Obsidian resolves them, so
 * a vault that already works there works here.
 */

export const WIKILINK = /\[\[([^[\]|#\n]*)(?:#([^[\]|\n]+))?(?:\|([^[\]\n]+))?\]\]/g

export interface WikiLink {
  target: string
  anchor: string | null
  label: string | null
}

export function linksIn(text: string): WikiLink[] {
  const out: WikiLink[] = []
  for (const m of text.matchAll(WIKILINK)) {
    out.push({ target: m[1]!.trim(), anchor: m[2]?.trim() || null, label: m[3]?.trim() || null })
  }
  return out
}

const stem = (p: string) => p.replace(/\.(md|mdx|markdown)$/i, '')
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** `a/b/../c` → `a/c`, with no leading `./` or `/`. Null when it climbs out. */
export function normalPath(p: string): string | null {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(seg)
  }
  return out.join('/')
}

/**
 * The page a link names, as a path from the docs' root, or null when no page
 * answers to it. `from` is the linking page; an empty target is that page.
 */
export function resolveLink(
  target: string,
  from: string,
  pages: readonly { path: string; aliases?: readonly string[] }[],
): string | null {
  const t = stem(target.trim().replace(/^<|>$/g, ''))
  if (!t) return from
  const byStem = new Map<string, string>()
  for (const p of pages) byStem.set(stem(p.path).toLowerCase(), p.path)
  if (t.includes('/')) {
    for (const c of [normalPath(dirOf(from) + '/' + t), normalPath(t)]) {
      const hit = c !== null ? byStem.get(c.toLowerCase()) : undefined
      if (hit) return hit
    }
    // Obsidian accepts a partial path: `frontend/naming` from anywhere — and a
    // relative one left behind when its folder moved still names its page.
    const tail = '/' + t.toLowerCase().replace(/^(\.\.?\/)+/, '')
    const hits = pages.filter((p) => ('/' + stem(p.path).toLowerCase()).endsWith(tail))
    return hits.length ? nearest(hits, from) : null
  }
  const name = t.toLowerCase()
  const hits = pages.filter((p) => stem(baseOf(p.path)).toLowerCase() === name)
  if (hits.length) return nearest(hits, from)
  const aliased = pages.filter((p) => p.aliases?.some((a) => a.toLowerCase() === name))
  return aliased.length ? nearest(aliased, from) : null
}

/** Of several pages by one name: the one beside the linking page, else the shallowest. */
function nearest(hits: readonly { path: string }[], from: string): string {
  const here = dirOf(from)
  const beside = hits.find((h) => dirOf(h.path) === here)
  if (beside) return beside.path
  return [...hits].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))[0]!.path
}

/** A heading as an anchor: what `[[page#Heading]]` and the reader agree on. */
export function headingAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/* ── covers ───────────────────────────────────────────────────────────────
 *
 * `covers:` names code by its path from the project root — the repository's
 * folder first: `cashplannr-v2/app/Billing/**`. A bare folder covers what is
 * under it; `*` stays inside one folder, `**` crosses them.
 */

const coverCache = new Map<string, RegExp>()

export function coversPath(pattern: string, path: string): boolean {
  const pat = pattern.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '')
  if (!pat) return false
  let re = coverCache.get(pat)
  if (!re) {
    let src = ''
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i]!
      if (ch === '*' && pat[i + 1] === '*') {
        src += '.*'
        i++
        if (pat[i + 1] === '/') i++
      } else if (ch === '*') src += '[^/]*'
      else if (ch === '?') src += '[^/]'
      else src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    // No wildcard: a file, or a folder and everything under it.
    re = new RegExp('^' + src + (/[*?]/.test(pat) ? '$' : '(?:/.*)?$'))
    coverCache.set(pat, re)
  }
  return re.test(path.replace(/^\.?\/+/, ''))
}
