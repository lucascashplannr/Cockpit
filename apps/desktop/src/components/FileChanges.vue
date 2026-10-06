<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  Decoration, EditorView, GutterMarker, WidgetType, gutterLineClass, highlightActiveLine, keymap, lineNumbers,
} from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { Compartment, EditorState, RangeSet, StateEffect, StateField, Transaction } from '@codemirror/state'
import type { Range, Text } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import type { DiffHunkLine, Workspace } from '@cockpit/shared'
import { client, guard, stopSaveOnProtected, toast } from '../core/store.js'
import { cockpitTheme, languageFor } from '../core/editor.js'

/**
 * The Diff's third reading: the file as it stands, whole, with what changed
 * marked on it. Unified and Split show the change and a few lines around it;
 * this shows where the change lives — the function it is in, what comes after.
 *
 * The file is read from disk and the marks come from the same diff the other
 * two views draw, so the three never disagree about what changed. Added lines
 * are tinted; removed lines are not in the file any more, so they are drawn
 * back in where they were, as rows that are not part of the document.
 *
 * It is the Code tool's editor underneath, read-only until asked: a review
 * that finds a typo can fix it here, but nothing is typed into by accident.
 */

const props = defineProps<{
  workspace: Workspace
  path: string
  lines: DiffHunkLine[]
  editing: boolean
  /** Where to land when the file opens, instead of on its first change. */
  startLine?: number | null
}>()
const emit = defineEmits<{ saved: [] }>()

const host = ref<HTMLElement | null>(null)
const view = shallowRef<EditorView | null>(null)
const dirty = ref(false)
/** Only the start of the file came over: shown, never written back. */
const truncated = ref(false)
const unreadable = ref(false)
/** Where the first change starts: where the file opens. */
let first: number | undefined

let mtime: number | null = null
let loadedPath: string | null = null
/** A change the panel made to the document itself — a reload, not an edit. */
let quiet = false

class Removed extends WidgetType {
  constructor(readonly lines: string[]) {
    super()
  }
  eq(other: Removed): boolean {
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
  elementClass = 'cm-added-gutter'
})()

interface Marks {
  deco: DecorationSet
  gutter: RangeSet<GutterMarker>
}
const setMarks = StateEffect.define<Marks>()
/**
 * Kept in the state and carried through edits, so a mark stays on the line it
 * was put on while the text above it grows. It goes stale against the diff as
 * you type — the next save reads the diff again and puts that right.
 */
const marksField = StateField.define<Marks>({
  create: () => ({ deco: Decoration.none, gutter: RangeSet.empty }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value
    return tr.docChanged ? { deco: value.deco.map(tr.changes), gutter: value.gutter.map(tr.changes) } : value
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    gutterLineClass.from(f, (v) => v.gutter),
  ],
})

/** The diff, laid onto the new file. */
function build(doc: Text, lines: DiffHunkLine[]): { marks: Marks; stops: number[] } {
  const deco: Range<Decoration>[] = []
  const gutter: Range<GutterMarker>[] = []
  const at: number[] = []
  {
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
  }
  return { marks: { deco: Decoration.set(deco, true), gutter: RangeSet.of(gutter, true) }, stops: at }
}

const diffTheme = EditorView.theme({
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

const mode = new Compartment()
function modeFor(editing: boolean) {
  return editing
    ? [highlightActiveLine()]
    : [EditorState.readOnly.of(true), EditorView.editable.of(false)]
}

function canEdit(): boolean {
  return props.editing && !truncated.value
}

function create(doc: string): EditorView {
  return new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        history(),
        mode.of(modeFor(canEdit())),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: () => (void save(), true) },
        ]),
        languageFor(props.path),
        cockpitTheme,
        diffTheme,
        marksField,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !quiet) dirty.value = true
        }),
      ],
    }),
  })
}

/**
 * Read the file and lay the diff on it. Called when the file changes and every
 * time the diff does — except over an edit in progress, which is the one thing
 * on screen that exists nowhere else.
 */
async function refresh(force = false) {
  const path = props.path
  if (dirty.value && loadedPath === path && !force) return
  const r = await guard(() => client.call('fs.read', { workspaceId: props.workspace.id, rel: path }))
  if (props.path !== path || !host.value) return
  unreadable.value = !r || r.binary
  if (!r || r.binary) return
  truncated.value = r.truncated
  mtime = r.mtimeMs

  let v = view.value
  const fresh = !v || loadedPath !== path
  if (fresh) {
    v?.destroy()
    v = view.value = create(r.content)
  } else if (v!.state.doc.toString() !== r.content) {
    quiet = true
    v!.dispatch({
      changes: { from: 0, to: v!.state.doc.length, insert: r.content },
      annotations: Transaction.addToHistory.of(false),
    })
    quiet = false
  }
  loadedPath = path
  dirty.value = false
  const built = build(v!.state.doc, props.lines)
  first = built.stops[0]
  // Opened on the line that was asked for, or else on the first thing that
  // changed: either way, the line the reader came for.
  const doc = v!.state.doc
  const asked = fresh && props.startLine ? doc.line(Math.min(Math.max(props.startLine, 1), doc.lines)).from : null
  const land = asked ?? (fresh ? first : undefined)
  v!.dispatch({
    ...(asked !== null ? { selection: { anchor: asked } } : {}),
    effects: [
      setMarks.of(built.marks),
      mode.reconfigure(modeFor(canEdit())),
      ...(land !== undefined ? [EditorView.scrollIntoView(land, { y: 'center' })] : []),
    ],
  })
  if (fresh && canEdit()) v!.focus()
}

/** §16 — the mtime check is what stops a manual edit and an agent edit from
 *  silently overwriting one another. */
async function save() {
  const v = view.value
  if (!v || !dirty.value || truncated.value) return
  // §16 — asked before the write, so the edit is still in the editor after.
  if (stopSaveOnProtected(props.workspace)) return
  const path = props.path
  const res = await guard(() =>
    client.call('fs.write', {
      workspaceId: props.workspace.id,
      rel: path,
      content: v.state.doc.toString(),
      expectMtimeMs: mtime,
    }),
  )
  if (!res) return
  if (res.conflict) {
    toast('error', 'File changed on disk since it was opened — drop your edit to see it')
    return
  }
  mtime = res.mtimeMs
  dirty.value = false
  toast('ok', 'saved ' + path, { icon: 'save' })
  emit('saved')
}

/** The file as it is on disk again, whatever was typed. */
function revert() {
  return refresh(true)
}

watch(() => [props.path, props.lines], () => void refresh())
watch(
  () => props.editing,
  (on) => {
    const v = view.value
    if (!v) return
    v.dispatch({ effects: mode.reconfigure(modeFor(canEdit())) })
    if (on && canEdit()) v.focus()
  },
)
onMounted(() => void refresh())
onBeforeUnmount(() => view.value?.destroy())

defineExpose({ dirty, truncated, save, revert })
</script>

<template>
  <div class="whole">
    <p v-if="truncated" class="note">
      Only the start of this file is shown — it is too large to read in full here, and cannot be edited here.
    </p>
    <div v-if="unreadable" class="empty"><span>This file cannot be read as text.</span></div>
    <div v-show="!unreadable" ref="host" class="cm" />
  </div>
</template>

<style scoped>
.whole { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.cm { flex: 1; min-height: 0; overflow: hidden; }
.note {
  flex: none;
  margin: 0;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line-soft);
  font-size: var(--fs-xs);
  color: var(--warn);
}
</style>
