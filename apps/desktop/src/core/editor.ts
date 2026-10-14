import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from '@codemirror/language'
import { highlightTree, tags as t } from '@lezer/highlight'
import { StyleModule } from 'style-mod'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { php } from '@codemirror/lang-php'
import { vue } from '@codemirror/lang-vue'

/**
 * What the Code tool and the Diff's whole-file view have in common: one editor,
 * dressed the same, wherever a file is shown as itself.
 */

export function languageFor(path: string): Extension {
  return languageSupport(path) ?? []
}

function languageSupport(path: string): LanguageSupport | null {
  // A trailing NUL marks a piece already given its section (see `paintLines`).
  const ext = path.replace(/\u0000$/, '').split('.').pop()?.toLowerCase() ?? ''
  // A single-file component is three languages; read as TSX its template
  // half-parses and its style not at all.
  if (ext === 'vue') return vue({ base: html({ selfClosingTags: true }) })
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return javascript({ typescript: true, jsx: true })
  if (ext === 'json') return json()
  if (['md', 'markdown'].includes(ext)) return markdown()
  if (['yaml', 'yml'].includes(ext)) return yaml()
  if (ext === 'css') return css()
  if (['html', 'htm'].includes(ext)) return html()
  if (ext === 'php') return php()
  return null
}

/**
 * Syntax colour, from the app's own inks: the accent for what the language
 * says (keywords), and for the rest the muted hues the Commits tool draws its
 * lanes with — none of them semantic, so a green string is never read as
 * "added" over a diff's green. Punctuation steps back to let the words carry.
 * Each is a pair, picked for its own ground in each theme.
 */
const ink = (light: string, dark: string) => `light-dark(${light}, ${dark})`
const STRING = ink('#23879a', '#5cc3d4')
const LITERAL = ink('#86772a', '#d2bf61')
const FUNCTION = ink('#51709f', '#92b0e0')
const TYPE = ink('#b0487b', '#ee8cba')
const PROPERTY = ink('#98603a', '#dea27a')

const cockpitHighlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword, t.self],
    color: 'var(--accent)',
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.attributeValue, t.character, t.monospace], color: STRING },
  { tag: [t.number, t.bool, t.null, t.atom], color: LITERAL },
  {
    tag: [
      t.function(t.variableName), t.function(t.propertyName),
      t.function(t.definition(t.variableName)), t.function(t.definition(t.propertyName)),
    ],
    color: FUNCTION,
  },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: TYPE },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], color: PROPERTY },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--text-dim)', fontStyle: 'italic' },
  { tag: [t.punctuation, t.bracket, t.angleBracket, t.separator, t.operator], color: 'var(--text-muted)' },
  { tag: [t.meta, t.processingInstruction, t.documentMeta], color: 'var(--text-dim)' },
  // Markdown.
  { tag: t.heading, color: 'var(--accent)', fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: STRING, textDecoration: 'underline' },
  { tag: t.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.invalid, color: 'var(--danger)' },
])

/** A theme built from the same tokens as the rest of the app, so the editor
 *  does not look like a different product embedded in this one. */
const cockpitChrome = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text)', height: '100%' },
  '.cm-content': { fontFamily: 'var(--mono)', fontSize: 'var(--fs-sm)', padding: '8px 0 40px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-dim)',
    border: 'none',
    fontFamily: 'var(--mono)',
    fontSize: 'var(--fs-xs)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft) !important' },
  '.cm-scroller': { overflow: 'auto', lineHeight: '1.55' },
})

/** The chrome and the colour together: what every editor in the window wears. */
export const cockpitTheme: Extension = [cockpitChrome, syntaxHighlighting(cockpitHighlight)]

/* ── colour outside an editor ─────────────────────────────────────────────
 *
 * The Diff's Unified and Split views and the Commits card draw lines as
 * plain rows, not as an editor. They are coloured by the same parser and the
 * same style: each run of lines is parsed as one text, so a string or a
 * comment that spans lines is read as one, and cut back into lines.
 */

export interface Seg {
  text: string
  cls: string
}

let mounted = false
/** Over this a run is left plain: parsing it costs more than its colour is worth. */
const MAX_PAINT = 400_000

/**
 * A hunk of a `.vue` or `.html` file is a piece cut out of one of its
 * sections, without the tag that opens it — and read bare, a script reads as
 * template text. The section is told by a closing tag inside the piece, or
 * else by what its lines look like, and the piece is read under that opening.
 */
const CSS_LINE = /^\s*(?:[-\w.#:>*\[\]="'\s,()@&~+]+\{|[-\w]+\s*:[^;{}]*;|\})\s*$/
const TAG_LINE = /^\s*(?:<\/?[a-zA-Z][\w-]*|\{\{)|^\s*[:@#]?[a-zA-Z-]+(?:\.[\w-]+)*="[^"]*"\s*\/?>?\s*$/
function sectionOf(lines: string[]): string | null {
  for (const l of lines) {
    if (/<(script|style|template)\b/.test(l)) return null
    if (/<\/script>/.test(l)) return '<script setup lang="ts">'
    if (/<\/style>/.test(l)) return '<style>'
  }
  const real = lines.filter((l) => l.trim())
  if (!real.length) return null
  const css = real.filter((l) => CSS_LINE.test(l)).length
  const tag = real.filter((l) => TAG_LINE.test(l)).length
  if (css / real.length >= 0.6) return '<style>'
  if (tag / real.length >= 0.5) return null
  return '<script setup lang="ts">'
}

/** One run of consecutive lines, coloured; `null` when the language has no parser here. */
export function paintLines(path: string, lines: string[]): Seg[][] | null {
  const support = languageSupport(path)
  if (!support) return null
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const opener = ext === 'vue' || ext === 'html' || ext === 'htm' ? sectionOf(lines) : null
  if (opener) return paintLines(path + '\u0000', [opener, ...lines])?.slice(1) ?? null
  const text = lines.join('\n')
  if (text.length > MAX_PAINT) return null
  if (!mounted && cockpitHighlight.module) {
    StyleModule.mount(document, cockpitHighlight.module)
    mounted = true
  }
  const marks: { from: number; to: number; cls: string }[] = []
  highlightTree(support.language.parser.parse(text), cockpitHighlight, (from, to, cls) => marks.push({ from, to, cls }))
  const out: Seg[][] = []
  let start = 0
  let m = 0
  for (const line of lines) {
    const end = start + line.length
    const segs: Seg[] = []
    let at = start
    while (m < marks.length && marks[m]!.to <= start) m++
    for (let k = m; k < marks.length && marks[k]!.from < end; k++) {
      const from = Math.max(marks[k]!.from, start)
      const to = Math.min(marks[k]!.to, end)
      if (from > at) segs.push({ text: text.slice(at, from), cls: '' })
      if (to > from) segs.push({ text: text.slice(from, to), cls: marks[k]!.cls })
      at = Math.max(at, to)
    }
    if (at < end) segs.push({ text: text.slice(at, end), cls: '' })
    out.push(segs)
    start = end + 1
  }
  return out
}

/**
 * A diff's lines, coloured: per hunk, the old side (context and deletions) and
 * the new side (context and additions) are each parsed as the file they were
 * part of. Indexed like the lines given; meta lines get nothing.
 */
export function paintDiff(
  path: string,
  lines: readonly { kind: string; text: string }[],
): (Seg[] | null)[] | null {
  if (!languageSupport(path)) return null
  const out: (Seg[] | null)[] = lines.map(() => null)
  let i = 0
  while (i < lines.length) {
    if (lines[i]!.kind === 'meta') {
      i++
      continue
    }
    const hunk: number[] = []
    while (i < lines.length && lines[i]!.kind !== 'meta') hunk.push(i++)
    for (const side of ['del', 'add'] as const) {
      const idx = hunk.filter((k) => lines[k]!.kind === 'context' || lines[k]!.kind === side)
      const painted = paintLines(path, idx.map((k) => lines[k]!.text))
      if (!painted) continue
      idx.forEach((k, n) => {
        // A context line is on both sides; the new side's reading wins.
        if (lines[k]!.kind === side || side === 'add') out[k] = painted[n]!
      })
    }
  }
  return out
}
