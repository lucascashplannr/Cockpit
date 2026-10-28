import { Decoration, EditorView, GutterMarker, WidgetType, gutterLineClass } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { RangeSet, StateEffect, StateField } from '@codemirror/state'
import type { Range, Text } from '@codemirror/state'
import type { DiffHunkLine } from '@cockpit/shared'

/**
 * What changed, laid on the file as it stands: added lines are tinted, and
 * removed ones — no longer in the file — are drawn back in where they were, as
 * rows that are not part of the document. The Diff's File view and the Code
 * tool's editor both read a file this way, so the two never disagree.
 */

class Removed extends WidgetType {
  constructor(readonly lines: string[]) {
    super()
  }
  override eq(other: Removed): boolean {
    return other.lines.length === this.lines.length && other.lines.every((l, i) => l === this.lines[i])
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-removed'
    el.setAttribute('aria-label', 'Removed')
    for (const text of this.lines) {
      // An empty row would collapse to nothing; a removed blank line is a line.
      el.appendChild(document.createElement('div')).textContent = text || ' '
    }
    return el
  }
}

const addedLine = Decoration.line({ class: 'cm-added' })
const addedGutter = new (class extends GutterMarker {
  override elementClass = 'cm-added-gutter'
})()

export interface Marks {
  deco: DecorationSet
  gutter: RangeSet<GutterMarker>
}
export const setMarks = StateEffect.define<Marks>()
export const noMarks: Marks = { deco: Decoration.none, gutter: RangeSet.empty }

/**
 * Kept in the state and carried through edits, so a mark stays on the line it
 * was put on while the text above it grows. It goes stale against the diff as
 * you type — the next save reads the diff again and puts that right.
 */
const marksField = StateField.define<Marks>({
  create: () => noMarks,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value
    return tr.docChanged ? { deco: value.deco.map(tr.changes), gutter: value.gutter.map(tr.changes) } : value
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    gutterLineClass.from(f, (v) => v.gutter),
  ],
})

const marksTheme = EditorView.theme({
  '.cm-line.cm-added, .cm-line.cm-added.cm-activeLine': { backgroundColor: 'var(--diff-add-bg)' },
  '.cm-gutterElement.cm-added-gutter': { backgroundColor: 'var(--diff-add-bg)', color: 'var(--diff-add-text)' },
  '.cm-removed': {
    // The same inset a line of the document has, so the columns agree.
    padding: '0 2px 0 6px',
    backgroundColor: 'var(--diff-del-bg)',
    color: 'var(--diff-del-text)',
    whiteSpace: 'pre',
    tabSize: '4',
  },
})

/** The field and its look: what an editor needs to carry change marks. */
export const changeMarks = [marksField, marksTheme]

/** The diff, laid onto the new file. `stops` are where each change starts. */
export function buildMarks(doc: Text, lines: DiffHunkLine[]): { marks: Marks; stops: number[] } {
  const deco: Range<Decoration>[] = []
  const gutter: Range<GutterMarker>[] = []
  const at: number[] = []
  let pending: string[] = []
  let last = 0
  let inRun = false
  /** The removed rows waiting, drawn above the line that took their place. */
  const flush = (before: number): boolean => {
    if (!pending.length) return false
    const inside = before <= doc.lines
    const pos = inside ? doc.line(before).from : doc.length
    deco.push(Decoration.widget({ widget: new Removed(pending), block: true, side: inside ? -1 : 1 }).range(pos))
    at.push(pos)
    pending = []
    return true
  }
  for (const l of lines) {
    if (l.kind === 'meta') {
      flush(last + 1)
      inRun = false
    } else if (l.kind === 'del') {
      pending.push(l.text)
    } else {
      const n = l.newLine!
      const replaced = flush(n)
      if (l.kind === 'add' && n <= doc.lines) {
        const from = doc.line(n).from
        deco.push(addedLine.range(from))
        gutter.push(addedGutter.range(from))
        if (!inRun && !replaced) at.push(from)
      }
      inRun = l.kind === 'add'
      last = n
    }
  }
  flush(last + 1)
  return { marks: { deco: Decoration.set(deco, true), gutter: RangeSet.of(gutter, true) }, stops: at }
}
