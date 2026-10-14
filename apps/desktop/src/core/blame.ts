import { ref } from 'vue'
import { Decoration, EditorView, GutterMarker, gutter } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { RangeSet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import type { BlameCommit, FileBlame } from '@cockpit/shared'

/**
 * §2 — who wrote each line, beside the line. Not something read every day,
 * so it is off until asked for; asked for, it stays on from one file to the
 * next until it is turned off again, and is forgotten with the window.
 */
export const blameOn = ref(false)

/** Rounded as the Commits tool rounds, so a commit says the same age in both. */
export function ago(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000))
  if (m < 1) return 'now'
  if (m < 60) return m + 'm'
  const h = Math.round(m / 60)
  if (h < 24) return h + 'h'
  const d = Math.round(h / 24)
  if (d < 30) return d + 'd'
  const at = new Date(ts)
  return at.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  })
}

function when(ts: number): string {
  return new Date(ts).toLocaleString([], {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** How recent, in four steps: the stripe's strength. */
function recency(ts: number): number {
  const d = (Date.now() - ts) / 86_400_000
  return d < 2 ? 0 : d < 14 ? 1 : d < 90 ? 2 : 3
}

function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean)
  return ((w[0]?.[0] ?? '') + (w.length > 1 ? w[w.length - 1]![0] : (w[0]?.[1] ?? ''))).toUpperCase()
}

/**
 * One commit's run of lines says what and when on its first line only: the
 * lines under it are the same answer. What the commit was for says more than
 * a name repeated down the column, so the subject leads and who comes as
 * initials beside it. The full name is in the tooltip.
 *
 * Every line carries the stripe: one run reads as one bar, and how strong it
 * is says how recent — the lines that just moved stand out from the ones
 * that have not in months.
 */
class Mark extends GutterMarker {
  constructor(
    readonly c: BlameCommit,
    readonly first: boolean,
    readonly hot = false,
  ) {
    super()
  }
  override eq(o: Mark): boolean {
    return o.c === this.c && o.first === this.first && o.hot === this.hot
  }
  override toDOM(): Node {
    const c = this.c
    const el = document.createElement('div')
    el.className = 'cm-blame-mark r' + recency(c.ts) + (this.first ? ' first' : '') + (c.committed ? '' : ' pending')
      + (this.hot ? ' hot' : '')
    el.title = c.committed
      ? c.subject + '\n' + c.hash.slice(0, 7) + ' · ' + c.author + ' · ' + when(c.ts)
        + (c.agent ? '\nCo-authored by an agent' : '')
      : 'Not committed yet'
    const span = (cls: string, text: string) => {
      const s = document.createElement('span')
      s.className = cls
      s.textContent = text
      el.append(s)
    }
    if (!this.first) return el
    if (!c.committed) {
      span('what', 'Not committed')
      return el
    }
    span('mono', initials(c.author))
    span('what', c.subject)
    if (c.agent) span('agent', '✦')
    span('age', ago(c.ts))
    return el
  }
}

const setBlame = StateEffect.define<RangeSet<Mark>>()
/** The commit under the pointer: its whole run lights up, in the column and in the code. */
const setHot = StateEffect.define<string | null>()
const hotField = StateField.define<string | null>({
  create: () => null,
  update(h, tr) {
    for (const e of tr.effects) {
      if (e.is(setHot)) h = e.value
      if (e.is(setBlame)) h = null
    }
    return h
  },
})

/**
 * Marks sit at line starts and ride along with edits, so typing above a line
 * does not hand it to the commit above. A line made by the edit has none; two
 * lines joined keep the first's.
 */
const field = StateField.define<RangeSet<Mark>>({
  create: () => RangeSet.empty,
  update(marks, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return e.value
    if (!tr.docChanged) return marks
    const moved = marks.map(tr.changes)
    const b = new RangeSetBuilder<Mark>()
    let last = -1
    for (let it = moved.iter(); it.value; it.next()) {
      const line = tr.state.doc.lineAt(it.from)
      if (line.number === last) continue
      last = line.number
      b.add(line.from, line.from, it.value)
    }
    return b.finish()
  },
})

/** What the column draws: the marks, with the hot commit's lit. */
const shown = StateField.define<RangeSet<Mark>>({
  create: () => RangeSet.empty,
  update(_v, tr) {
    const hot = tr.state.field(hotField)
    const marks = tr.state.field(field)
    if (!hot) return marks
    const b = new RangeSetBuilder<Mark>()
    for (let it = marks.iter(); it.value; it.next()) {
      const m = it.value
      b.add(it.from, it.from, m.c.hash === hot ? new Mark(m.c, m.first, true) : m)
    }
    return b.finish()
  },
})

const hotLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_v, tr) {
    const hot = tr.state.field(hotField)
    if (!hot) return Decoration.none
    const b = new RangeSetBuilder<Decoration>()
    const line = Decoration.line({ class: 'cm-blame-hot' })
    for (let it = tr.state.field(field).iter(); it.value; it.next()) {
      if (it.value.c.hash === hot) b.add(it.from, it.from, line)
    }
    return b.finish()
  },
  provide: (f) => EditorView.decorations.from(f),
})

function markAt(view: EditorView, pos: number): Mark | null {
  let hit: Mark | null = null
  view.state.field(field).between(pos, pos, (_f, _t, m) => {
    hit = m
    return false
  })
  return hit
}

export function blameMarks(view: EditorView, blame: FileBlame): void {
  const doc = view.state.doc
  const b = new RangeSetBuilder<Mark>()
  let prev = -1
  for (let n = 1; n <= doc.lines; n++) {
    const i = blame.lines[n - 1]
    const c = i === undefined ? undefined : blame.commits[i]
    if (!c) {
      prev = -1
      continue
    }
    const at = doc.line(n).from
    b.add(at, at, new Mark(c, i !== prev))
    prev = i!
  }
  view.dispatch({ effects: setBlame.of(b.finish()) })
}

/** The column, and what a click on it asks for: that commit, or the changes. */
export function blameGutter(open: (c: BlameCommit) => void): Extension {
  return [
    field,
    hotField,
    shown,
    hotLines,
    gutter({
      class: 'cm-blame',
      markers: (v) => v.state.field(shown),
      domEventHandlers: {
        click(view, line) {
          const hit = markAt(view, line.from)
          if (!hit) return false
          open(hit.c)
          return true
        },
        mouseover(view, line) {
          const hash = markAt(view, line.from)?.c.hash ?? null
          if (hash !== view.state.field(hotField)) view.dispatch({ effects: setHot.of(hash) })
          return false
        },
      },
    }),
    EditorView.domEventHandlers({
      mouseover(e, view) {
        if (view.state.field(hotField) && !(e.target as HTMLElement).closest?.('.cm-blame')) {
          view.dispatch({ effects: setHot.of(null) })
        }
      },
      mouseleave(_e, view) {
        if (view.state.field(hotField)) view.dispatch({ effects: setHot.of(null) })
      },
    }),
    EditorView.theme({
      '.cm-gutter.cm-blame': { width: '224px', borderRight: '1px solid var(--line)' },
      '.cm-blame .cm-gutterElement': { padding: '0', cursor: 'pointer' },
      '.cm-blame-mark': {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        height: '100%',
        position: 'relative',
        padding: '0 10px 0 14px',
        fontFamily: 'var(--font)',
        whiteSpace: 'nowrap',
      },
      '.cm-blame-mark.first': { boxShadow: 'inset 0 1px 0 var(--line)' },
      '.cm-blame .cm-gutterElement:first-child .cm-blame-mark.first': { boxShadow: 'none' },
      '.cm-blame-mark .what': { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-muted)' },
      '.cm-blame-mark.pending .what': { color: 'var(--warn)' },
      '.cm-blame-mark .agent': { flex: 'none', color: 'var(--accent)' },
      '.cm-blame-mark .age': { flex: 'none', fontVariantNumeric: 'tabular-nums', color: 'var(--text-dim)' },
      // A tag shorter than the line, so the runs of one-line commits, stacked,
      // keep a gap between their initials rather than reading as one column.
      '.cm-blame-mark .mono': {
        flex: 'none',
        display: 'grid',
        placeItems: 'center',
        height: '14px',
        padding: '0 4px',
        borderRadius: '4px',
        background: 'var(--active)',
        color: 'var(--text-muted)',
        fontSize: '9px',
        fontWeight: '600',
        letterSpacing: '0.02em',
      },
      '.cm-blame-mark::before': {
        content: '""',
        position: 'absolute',
        left: '4px',
        top: '0',
        bottom: '0',
        width: '3px',
        background: 'var(--accent)',
      },
      '.cm-blame-mark.r0::before': { opacity: '1' },
      '.cm-blame-mark.r1::before': { opacity: '0.6' },
      '.cm-blame-mark.r2::before': { opacity: '0.32' },
      '.cm-blame-mark.r3::before': { opacity: '0.14' },
      '.cm-blame-mark.pending::before': { background: 'var(--warn)', opacity: '0.8' },
      '.cm-blame-mark.hot': { backgroundColor: 'var(--hover)' },
      '.cm-blame-mark.hot .what': { color: 'var(--text)' },
      '.cm-line.cm-blame-hot': { backgroundColor: 'var(--hover)' },
    }),
  ]
}
