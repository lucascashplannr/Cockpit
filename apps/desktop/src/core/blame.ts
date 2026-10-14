import { ref } from 'vue'
import { EditorView, GutterMarker, gutter } from '@codemirror/view'
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

/**
 * One commit's run of lines says who and when on its first line only: the
 * lines under it are the same answer, and a column of the same name repeated
 * is the noise this is meant to cut through. The rest are a quiet rule.
 */
class Mark extends GutterMarker {
  constructor(readonly c: BlameCommit, readonly first: boolean) {
    super()
  }
  override eq(o: Mark): boolean {
    return o.c === this.c && o.first === this.first
  }
  override toDOM(): Node {
    const el = document.createElement('div')
    el.className = 'cm-blame-mark' + (this.first ? ' first' : '') + (this.c.committed ? '' : ' pending')
    el.title = this.c.committed
      ? this.c.subject + '\n' + this.c.hash.slice(0, 7) + ' · ' + this.c.author + ' · ' + when(this.c.ts)
        + (this.c.agent ? '\nCo-authored by an agent' : '')
      : 'Not committed yet'
    if (!this.first) return el
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = this.c.committed ? this.c.author : 'Not committed'
    el.append(who)
    if (this.c.committed) {
      if (this.c.agent) {
        const a = document.createElement('span')
        a.className = 'agent'
        a.textContent = '✦'
        el.append(a)
      }
      const age = document.createElement('span')
      age.className = 'age'
      age.textContent = ago(this.c.ts)
      el.append(age)
    }
    return el
  }
}

const setBlame = StateEffect.define<RangeSet<Mark>>()

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
    gutter({
      class: 'cm-blame',
      markers: (v) => v.state.field(field),
      domEventHandlers: {
        click(view, line) {
          let hit: Mark | null = null
          view.state.field(field).between(line.from, line.from, (_f, _t, m) => {
            hit = m
            return false
          })
          if (!hit) return false
          open((hit as Mark).c)
          return true
        },
      },
    }),
    EditorView.theme({
      '.cm-gutter.cm-blame': { width: '184px', borderRight: '1px solid var(--line)' },
      '.cm-blame .cm-gutterElement': { padding: '0', cursor: 'pointer' },
      '.cm-blame-mark': {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        height: '100%',
        padding: '0 10px 0 12px',
        fontFamily: 'var(--font)',
        whiteSpace: 'nowrap',
      },
      '.cm-blame-mark.first': { boxShadow: 'inset 0 1px 0 var(--line)' },
      '.cm-blame .cm-gutterElement:first-child .cm-blame-mark.first': { boxShadow: 'none' },
      '.cm-blame-mark .who': { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-muted)' },
      '.cm-blame-mark.pending .who': { color: 'var(--warn)' },
      '.cm-blame-mark .agent': { flex: 'none', color: 'var(--accent)' },
      '.cm-blame-mark .age': { flex: 'none', fontVariantNumeric: 'tabular-nums', color: 'var(--text-dim)' },
      '.cm-blame .cm-gutterElement:hover .cm-blame-mark': { backgroundColor: 'var(--hover)' },
    }),
  ]
}
