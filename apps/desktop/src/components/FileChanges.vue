<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import type { DiffHunkLine, Workspace } from '@cockpit/shared'
import { client, guard, stopSaveOnProtected, toast } from '../core/store.js'
import { cockpitTheme, languageFor } from '../core/editor.js'
import { buildMarks, changeMarks, setMarks } from '../core/changeMarks.js'
import { editorFind, findInEditor, useFindKey } from '../core/find.js'

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
useFindKey(() => editorFind(view.value))
/** Only the start of the file came over: shown, never written back. */
const truncated = ref(false)
const unreadable = ref(false)
/** Where the first change starts: where the file opens. */
let first: number | undefined

let mtime: number | null = null
let loadedPath: string | null = null
/** A change the panel made to the document itself — a reload, not an edit. */
let quiet = false

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
        findInEditor,
        changeMarks,
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
  const built = buildMarks(v!.state.doc, props.lines)
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
