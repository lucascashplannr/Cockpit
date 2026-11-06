<script lang="ts">
import { Compartment, type EditorState as CMState } from '@codemirror/state'
import type { BlameCommit } from '@cockpit/shared'
import { blameGutter } from '../../core/blame.js'

/**
 * One open file. Off screen it keeps the editor as it was left — text, caret,
 * undo — and how far down it was, so coming back to it is coming back, not
 * opening it again. Only a tab with an edit not saved trusts what it kept; a
 * clean one reads the disk again on the way back, since an agent may have
 * written there meanwhile.
 */
interface OpenFile {
  path: string
  /** When the disk's copy was read: a save refuses if the file moved since. */
  mtime: number | null
  dirty: boolean
  es: CMState | null
  scroll: number
}

/**
 * Per workspace: the files open in the Code tab, in the order of their tabs,
 * and the one on screen. Leaving the tab or the workspace is looking
 * elsewhere, not closing them. Kept for as long as the window, not past it.
 */
const opened = new Map<string, { files: OpenFile[]; active: string | null }>()

/**
 * A kept editor outlives the mount that made it — the Code tab closes when
 * the Diff is looked at — so its keys and its gutter reach whichever mount is
 * on screen now, not the one they were built in.
 */
const live: {
  save?: () => void
  edited?: (path: string) => void
  blamed?: (c: BlameCommit) => void
} = {}
const langCompartment = new Compartment()
const blameCompartment = new Compartment()
const blameExt = blameGutter((c) => live.blamed?.(c))

/** Per workspace: which folders of the tree were open, and how far down it was. */
const trees = new Map<string, { open: Set<string>; scroll: number }>()
</script>

<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, toRaw, watch, type Ref } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import type { FileEntry, Workspace } from '@cockpit/shared'
import {
  ArrowLeft, ChevronDown, ChevronRight, Code, Copy, Eye, FileCode, Folder, FolderOpen, GitCommitVertical, Info, Save, Search,
  SquareArrowOutUpRight, UserPen, X,
} from '@lucide/vue'
import MarkdownPreview from '../MarkdownPreview.vue'
import Splitter from '../Splitter.vue'
import {
  LAYOUT_DEFAULTS, LAYOUT_LIMITS, changeCount, client, goTo, guard, layout, openCommits, resetPlaceWidth,
  savePlaceWidth, setColumnWidth, state, stopSaveOnProtected, toast,
} from '../../core/store.js'
import { buildMarks, changeMarks, noMarks, setMarks } from '../../core/changeMarks.js'
import { cockpitTheme, languageFor } from '../../core/editor.js'
import { editorFind, findInEditor, useFindKey } from '../../core/find.js'
import { blameMarks, blameOn } from '../../core/blame.js'
import FileIcon from '../FileIcon.vue'

/**
 * §12 — "Périmètre assumé : voir, naviguer, éditer manuellement. Pas de
 * complétion, pas de navigation sémantique."
 * §12 — "l'arbre de fichiers n'est pas la navigation principale" — it is here
 * for occasional exploration; ⇧⇧ and search do the real work.
 */

const props = defineProps<{ workspace: Workspace }>()

/* ── the tree against the editor ──────────────────────────────────────────
 *
 * Beside it when there is room, with a handle between them whose place
 * belongs to the place (see `savePlaceWidth`). Under 620px there is no beside
 * left, and the panel does what the Diff does: the tree is the screen, a file
 * opens over it, and the back arrow returns. Stacking them instead left the
 * file a few clipped lines under a tree you were done with.
 *
 * Measured here rather than by a container query: opening a file has to know
 * which of the two it is doing.
 */
const root = ref<HTMLElement | null>(null)
const narrow = ref(false)
/** Narrow only: the file is open over the tree. */
const drilled = ref(false)
const panelW = ref(0)
const treeMax = computed(() => Math.max(LAYOUT_LIMITS.tree.min, Math.min(LAYOUT_LIMITS.tree.max, panelW.value - 320)))
const treeW = computed(() => Math.min(layout.tree, treeMax.value))
/** Where the line holds on the way past: half, and the default. */
const treeSnaps = computed(() => [Math.round(panelW.value / 2), LAYOUT_DEFAULTS.tree])

let ro: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver(([e]) => {
    if (!e) return
    narrow.value = e.contentRect.width < 620
    panelW.value = e.contentRect.width
  })
  if (root.value) ro.observe(root.value)
})
onBeforeUnmount(() => ro?.disconnect())

interface Node {
  entry: FileEntry
  depth: number
  expanded: boolean
  children: Node[] | null
}

const roots = ref<Node[]>([])
const treeScroll = ref<HTMLElement | null>(null)
/** The workspace `roots` was read for — none until the first read lands. */
let treeFor: string | null = null
/** The tabs of this workspace, in order. */
// Cast: the kept editor is marked raw, so it is not unwrapped as the type says.
const files = ref<OpenFile[]>([]) as Ref<OpenFile[]>
/** The one on screen. */
const openPath = ref<string | null>(null)
const cur = computed(() => files.value.find((f) => f.path === openPath.value) ?? null)
const openMtime = computed({
  get: () => cur.value?.mtime ?? null,
  set: (v) => cur.value && (cur.value.mtime = v),
})
const dirty = computed({
  get: () => cur.value?.dirty ?? false,
  set: (v) => cur.value && (cur.value.dirty = v),
})
const host = ref<HTMLElement | null>(null)
const view = shallowRef<EditorView | null>(null)
useFindKey(() => editorFind(view.value))
/** Bumped on every edit and every open, so what reads the document follows it. */
const docTick = ref(0)


async function loadDir(rel: string): Promise<FileEntry[]> {
  const r = await guard(() => client.call('fs.list', { workspaceId: props.workspace.id, rel }))
  return r ?? []
}

/** Where this workspace's tree and tabs were left, kept for the way back. */
function leave(workspaceId: string) {
  const open = new Set<string>()
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (!n.expanded) continue
      open.add(n.entry.path)
      if (n.children) walk(n.children)
    }
  }
  walk(roots.value)
  // Left before the tree came in: what was kept still stands.
  if (treeFor === workspaceId) trees.set(workspaceId, { open, scroll: treeScroll.value?.scrollTop ?? 0 })
  if (filesFor !== workspaceId) return
  stash()
  opened.set(workspaceId, { files: toRaw(files.value).map((f) => toRaw(f)), active: openPath.value })
}

/** The workspace `files` belongs to — none while another one's are coming in. */
let filesFor: string | null = null

async function loadRoot() {
  treeFor = null
  filesFor = null
  openPath.value = null
  image.value = null
  view.value?.destroy()
  view.value = null
  const id = props.workspace.id
  const kept = opened.get(id)
  files.value = kept?.files ?? []
  filesFor = id
  drilled.value = false
  // Back where it was left, while the tree is still being read — once
  // mounted: on the way into the tool the editor has nowhere to go yet.
  const active = kept?.active
  if (active) {
    drilled.value = true
    void nextTick(() => show(active))
  }
  const entries = await loadDir('.')
  const tree = trees.get(id)
  const nodes = entries.map((e): Node => ({ entry: e, depth: 0, expanded: false, children: null }))
  if (tree) await reopen(nodes, tree.open)
  if (props.workspace.id !== id) return
  roots.value = nodes
  treeFor = props.workspace.id
  if (tree) void nextTick(() => treeScroll.value && (treeScroll.value.scrollTop = tree.scroll))
  takeRequest()
}

/** A file the palette asked for, once this is the workspace it is in. */
function takeRequest() {
  const r = state.codeRequest
  if (!r || r.workspaceId !== props.workspace.id || filesFor !== props.workspace.id) return
  state.codeRequest = null
  goToFile(r.path, r.line)
}

/**
 * Every way of opening a file comes through here. A file already open is
 * turned to, not read again — that would put the disk's copy over what was
 * typed; any other gets a tab of its own at the end, as a browser does.
 */
function goToFile(path: string, line: number | null = null) {
  drill(true)
  if (path === openPath.value && view.value) {
    if (line) toLine(view.value, line)
    return
  }
  if (!files.value.some((f) => f.path === path)) {
    files.value.push({ path, mtime: null, dirty: false, es: null, scroll: 0 })
  }
  void show(path, line)
}

/** What is on screen, kept in its tab while another one is looked at. */
function stash() {
  const v = view.value
  const f = cur.value
  if (!v || !f) return
  f.es = markRaw(v.state)
  f.scroll = v.scrollDOM.scrollTop
}

/** A tab, closed. An edit not saved in it is asked for first: nothing else
 *  keeps it, as the Diff's question says. */
function closeFile(path: string) {
  const f = files.value.find((x) => x.path === path)
  if (!f) return
  if (!f.dirty) return drop(path)
  state.pendingConfirm = {
    title: 'Drop your edit?',
    body: ['What you typed in ' + baseName(path) + ' is not saved, and nothing keeps a copy of it.'],
    verb: 'Drop the edit',
    cancel: 'Keep editing',
    done: 'Edit dropped',
    danger: true,
    run: async () => {
      drop(path)
      return true
    },
  }
}

/** Gone from the bar; the one on screen gives way to its right-hand
 *  neighbour, or its left when it was the last. */
function drop(path: string) {
  const i = files.value.findIndex((x) => x.path === path)
  if (i < 0) return
  files.value.splice(i, 1)
  if (openPath.value !== path) return
  const next = files.value[i] ?? files.value[i - 1]
  if (next) return void show(next.path)
  openPath.value = null
  image.value = null
  view.value?.destroy()
  view.value = null
  drill(false)
}

/** Over the tree, or back to it. Hidden, the editor measured nothing; shown
 *  again, it has to find its size. */
function drill(on: boolean) {
  drilled.value = on
  if (on) requestAnimationFrame(() => view.value?.requestMeasure())
}
// Narrowed with a file on screen, that file stays the screen.
watch(narrow, (n) => {
  if (n) drill(!!openPath.value)
})

/** A search hit is a line, not a file: land on it, in the middle of the
 *  screen, where the eye is already going. */
function toLine(v: EditorView, line: number) {
  const at = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines))
  v.dispatch({ selection: { anchor: at.from }, effects: EditorView.scrollIntoView(at.from, { y: 'center' }) })
  v.focus()
}

async function toggle(node: Node) {
  if (node.entry.kind !== 'dir') {
    goToFile(node.entry.path)
    return
  }
  node.expanded = !node.expanded
  if (node.expanded && !node.children) {
    const entries = await loadDir(node.entry.path)
    node.children = entries.map((e) => ({ entry: e, depth: node.depth + 1, expanded: false, children: null }))
  }
}

/** The folders that were open, open again — gone ones are simply not there. */
async function reopen(nodes: Node[], open: Set<string>): Promise<void> {
  await Promise.all(
    nodes.map(async (n) => {
      if (n.entry.kind !== 'dir' || !open.has(n.entry.path)) return
      const entries = await loadDir(n.entry.path)
      n.children = entries.map((e) => ({ entry: e, depth: n.depth + 1, expanded: false, children: null }))
      n.expanded = true
      await reopen(n.children, open)
    }),
  )
}

function flatten(nodes: Node[]): Node[] {
  const out: Node[] = []
  for (const n of nodes) {
    out.push(n)
    if (n.expanded && n.children) out.push(...flatten(n.children))
  }
  return out
}

/**
 * An image is looked at, not edited: its bytes come over as they are and it
 * opens straight into the same stage an SVG's preview uses, with no editor
 * behind it and nothing to save.
 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'])
const image = ref<{ url: string | null; bytes: number } | null>(null)

function isImage(path: string): boolean {
  return IMAGE_EXT.has(path.split('.').pop()?.toLowerCase() ?? '')
}

/** Everything an editor of `path` is made of. */
function extensionsFor(path: string) {
  return [
    // Before the numbers: who, then which line, then the line.
    blameCompartment.of(blameOn.value ? blameExt : []),
    lineNumbers(),
    history(),
    highlightActiveLine(),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
      { key: 'Mod-s', preventDefault: true, run: () => (live.save?.(), true) },
    ]),
    langCompartment.of(languageFor(path)),
    cockpitTheme,
    findInEditor,
    changeMarks,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) live.edited?.(path)
    }),
  ]
}

/**
 * A tab, put on screen. The one it replaces stays on screen until this one is
 * ready, and is kept in its own tab only then — so a quick second click wins
 * over a slow first one, and nothing typed meanwhile is lost.
 */
let showSeq = 0
async function show(path: string, line: number | null = null) {
  const id = props.workspace.id
  const seq = ++showSeq
  const f = files.value.find((x) => x.path === path)
  if (!f) return
  const ready = () => seq === showSeq && props.workspace.id === id && files.value.includes(f)

  if (isImage(path)) {
    const r = await guard(() => client.call('fs.readImage', { workspaceId: id, rel: path }))
    if (!ready()) return
    if (!r) return void drop(path)
    stash()
    openPath.value = path
    f.mtime = r.mtimeMs
    view.value?.destroy()
    view.value = null
    image.value = { url: r.data ? 'data:' + r.mediaType + ';base64,' + r.data : null, bytes: r.bytes }
    return
  }

  // An edit not saved comes back as it was left, with the mtime it was
  // opened at — so a save still refuses if the file moved since.
  let es = f.dirty ? f.es : null
  if (!es) {
    const r = await guard(() => client.call('fs.read', { workspaceId: id, rel: path }))
    if (!ready()) return
    if (!r) return void drop(path)
    const doc = r.binary ? '' : r.content
    f.mtime = r.mtimeMs
    // The disk as it was left: the same editor, its undo with it.
    if (f.es && f.es.doc.toString() === doc) es = f.es
    else {
      const anchor = Math.min(f.es?.selection.main.head ?? 0, doc.length)
      es = EditorState.create({ doc, selection: { anchor }, extensions: extensionsFor(path) })
    }
  }
  const el = host.value
  if (!el) return
  stash()
  openPath.value = path
  image.value = null
  view.value?.destroy()
  const v = new EditorView({ parent: el, state: es })
  view.value = v
  // Authors may have been switched while this one was off screen.
  v.dispatch({ effects: blameCompartment.reconfigure(blameOn.value ? blameExt : []) })
  docTick.value++
  // Blame reads the disk; over a kept edit its lines would be off by what was typed.
  if (!f.dirty) {
    if (blameOn.value) void loadBlame()
    void loadMarks()
  }
  if (line) toLine(v, line)
  else {
    const top = f.scroll
    requestAnimationFrame(() => {
      if (view.value === v) v.scrollDOM.scrollTop = top
    })
  }
}

/** §16 — the mtime check is what stops a manual edit and an agent edit from
 *  silently overwriting one another. */
async function save() {
  const v = view.value
  const f = cur.value
  if (!v || !f) return
  // §16 — asked before the write, so the edit is still in the editor after.
  if (stopSaveOnProtected(props.workspace)) return
  const path = f.path
  const res = await guard(() =>
    client.call('fs.write', {
      workspaceId: props.workspace.id,
      rel: path,
      content: v.state.doc.toString(),
      expectMtimeMs: f.mtime,
    }),
  )
  if (!res) return
  if (res.conflict) {
    toast('error', 'File changed on disk since it was opened — reload before saving')
    return
  }
  f.mtime = res.mtimeMs
  f.dirty = false
  toast('ok', 'saved ' + path, { icon: 'save' })
  if (view.value !== v) return
  // What was saved is what the next blame reads: the edited lines become
  // not committed, and the ones around them find their commits again.
  if (blameOn.value) void loadBlame()
  void loadMarks()
}

live.save = save
live.edited = (path) => {
  const f = files.value.find((x) => x.path === path)
  if (f) f.dirty = true
  docTick.value++
}
live.blamed = (c) => openBlamed(c)

/* ── what changed ──────────────────────────────────────────────────────────
 *
 * The file is read as the Diff's File view reads it: what is not committed is
 * marked on it — added lines tinted, removed ones drawn back in where they
 * were. The marks come from the same diff, so the two agree. They are laid
 * only on the disk's copy: over an edit, or over a file that moved on disk
 * since it was opened, the lines would not be the diff's lines.
 */
let marksSeq = 0
async function loadMarks() {
  const path = openPath.value
  const v = view.value
  if (!path || !v || image.value) return
  const mine = ++marksSeq
  if (!props.workspace.repo) {
    v.dispatch({ effects: setMarks.of(noMarks) })
    return
  }
  const [d, r] = await Promise.all([
    guard(() => client.call('diff.file', { workspaceId: props.workspace.id, path })),
    guard(() => client.call('fs.read', { workspaceId: props.workspace.id, rel: path })),
  ])
  if (mine !== marksSeq || view.value !== v || openPath.value !== path || dirty.value || !d || !r) return
  if (d.binary || r.binary || r.content !== v.state.doc.toString()) return
  v.dispatch({ effects: setMarks.of(buildMarks(v.state.doc, d.lines).marks) })
}

/* ── who wrote it ──────────────────────────────────────────────────────────
 *
 * §2 — git's answer, beside each line: the commit that last touched it. A
 * click on it opens this file's commits on that one, where the change it made
 * can be read; on a line not committed yet, the changes themselves.
 */
/** False when git knows nothing of the file — the toggle says so and draws nothing. */
const blameTracked = ref(true)

let blameSeq = 0
async function loadBlame() {
  const path = openPath.value
  const v = view.value
  if (!path || !v || image.value) return
  const mine = ++blameSeq
  const r = await guard(() => client.call('git.blame', { workspaceId: props.workspace.id, path }))
  if (mine !== blameSeq || view.value !== v || openPath.value !== path || !r) return
  blameTracked.value = r.tracked
  blameMarks(v, r)
}

function setBlame(on: boolean) {
  if (blameOn.value === on) return
  blameOn.value = on
  view.value?.dispatch({ effects: blameCompartment.reconfigure(on ? blameExt : []) })
  if (on) void loadBlame()
}

/**
 * One switch for the three ways a file is read: as code, as code with who
 * wrote each line beside it, and drawn. Authors is code with a column more,
 * so it takes Preview's place when chosen and gives it back to Code.
 */
type Reading = 'code' | 'authors' | 'preview'
const reading = computed<Reading>(() => (previewing.value ? 'preview' : blameOn.value ? 'authors' : 'code'))
function read(r: Reading) {
  if (r === 'preview') return setPreviewView('preview')
  if (previewKind.value) setPreviewView('code')
  setBlame(r === 'authors')
}

function openBlamed(c: BlameCommit) {
  if (!c.committed) {
    goTo('diff')
    return
  }
  if (openPath.value) openCommits(c.hash, openPath.value)
}

function fileCommits() {
  if (!openPath.value) return
  detailOpen.value = false
  openCommits(null, openPath.value)
}

// A commit moves the lines it took from not committed to its own; a switch
// of branch can move every one of them.
// Both keyed by the workspace too: another workspace is not a commit here.
// Its file is not open yet, and asking it for this one's fails — `loadRoot`
// reads what belongs there.
watch(
  [() => props.workspace.id, () => [props.workspace.git?.lastCommit?.hash, props.workspace.git?.branch].join('|')],
  ([id], [was]) => {
    if (id === was && blameOn.value && !dirty.value) void loadBlame()
  },
)
// A commit, a discard or an agent's edit moves what is marked.
watch(
  [
    () => props.workspace.id,
    () => [props.workspace.git?.lastCommit?.hash, props.workspace.git?.branch, changeCount(props.workspace)].join('|'),
  ],
  ([id], [was]) => {
    if (id === was && !dirty.value) void loadMarks()
  },
)

watch(
  () => props.workspace.id,
  (_id, old) => {
    if (old) leave(old)
    void loadRoot()
  },
  { immediate: true },
)
watch(() => state.codeRequest, takeRequest)

/* ── a file that is drawn, read as it is drawn ───────────────────────────
 *
 * The same switch the Diff has, for the same reason: a doc or an image is
 * written as source and read rendered. Here the preview is the editor's own
 * document, unsaved edits included — what you would save is what you see.
 * Code is the default because this is an editor first; Preview is remembered,
 * apart from the Diff's, since the two are asked for different things.
 */
type PreviewView = 'code' | 'preview'
const PREVIEW_KEY = 'cockpit.codePreviewView'
function readPreviewView(): PreviewView {
  try {
    return localStorage.getItem(PREVIEW_KEY) === 'preview' ? 'preview' : 'code'
  } catch {
    return 'code'
  }
}
const previewView = ref<PreviewView>(readPreviewView())
function setPreviewView(v: PreviewView): void {
  previewView.value = v
  try {
    localStorage.setItem(PREVIEW_KEY, v)
  } catch {
    /* remembered for this session only */
  }
  // Hidden, the editor measured nothing; it has to find its size again.
  if (v === 'code') requestAnimationFrame(() => view.value?.requestMeasure())
}

/** What the open file can be previewed as, if anything. */
const previewKind = computed<'markdown' | 'svg' | null>(() => {
  const ext = openPath.value?.split('.').pop()?.toLowerCase()
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'svg') return 'svg'
  return null
})
const previewing = computed(() => previewKind.value !== null && previewView.value === 'preview')
const docSource = computed(() => {
  void docTick.value
  return view.value?.state.doc.toString() ?? ''
})

/**
 * An SVG goes through an <img>, never into the page: as an image it cannot run
 * a script or fetch anything, whatever the file holds. Sized to fit — it is a
 * vector, so a 24px icon is as sharp at the size it can be looked at — with
 * the size it asks for said underneath.
 */
const svgUrl = computed(() =>
  previewKind.value === 'svg' && previewing.value
    ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(docSource.value)
    : '',
)
/** What the stage draws: an image as it is, or an SVG's preview. */
const drawUrl = computed(() => image.value?.url ?? svgUrl.value)
const drawSize = ref<{ w: number; h: number } | null>(null)
const drawBroken = ref(false)
watch(drawUrl, () => {
  drawSize.value = null
  drawBroken.value = false
})
function onDrawLoad(e: Event) {
  const img = e.target as HTMLImageElement
  drawSize.value = { w: img.naturalWidth, h: img.naturalHeight }
}

/* ── about the file ───────────────────────────────────────────────────────
 *
 * As in the Diff: the header carries the name, and the rest — where it lives,
 * how long it is, when it last moved — is one click away. The numbers are
 * read off the editor when the panel opens, so they count what is on screen,
 * unsaved edits included.
 */
const detailRoot = ref<HTMLElement | null>(null)
const detailOpen = ref(false)
const detail = ref<{ lines: number; bytes: number } | null>(null)

/** Last separator in a tree path — `\` on a Windows core, `/` elsewhere. */
function lastSep(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
}

function baseName(path: string): string {
  return path.slice(lastSep(path) + 1)
}

function toggleDetail() {
  detailOpen.value = !detailOpen.value
  const doc = view.value?.state.doc
  detail.value = detailOpen.value && doc
    ? { lines: doc.lines, bytes: new TextEncoder().encode(doc.toString()).length }
    : null
}

function bytes(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function since(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.round(m / 60)
  if (h < 24) return h + 'h ago'
  return Math.round(h / 24) + 'd ago'
}

async function copyPath() {
  if (!openPath.value) return
  await navigator.clipboard.writeText(openPath.value)
  detailOpen.value = false
  toast('info', 'Path copied', { icon: 'copy', lines: [openPath.value] })
}

async function openInIde() {
  const path = openPath.value
  if (!path) return
  detailOpen.value = false
  await guard(() =>
    client.call('workspace.openIn', { workspaceId: props.workspace.id, target: 'ide', path }),
  )
}

async function revealFolder() {
  const path = openPath.value
  if (!path) return
  detailOpen.value = false
  const cut = lastSep(path)
  const dir = cut > 0 ? path.slice(0, cut) : undefined
  await guard(() =>
    client.call('workspace.openIn', {
      workspaceId: props.workspace.id,
      target: 'finder',
      ...(dir ? { path: dir } : {}),
    }),
  )
}

watch(openPath, () => {
  detailOpen.value = false
  detail.value = null
})

function onDocDown(e: MouseEvent) {
  if (detailRoot.value && !detailRoot.value.contains(e.target as globalThis.Node)) detailOpen.value = false
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') detailOpen.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDocDown)
  document.addEventListener('keydown', onDocKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onDocKey)
})

/* ── the tabs ──────────────────────────────────────────────────────────────
 *
 * The agents' bar, without the pairs: one tab per open file, the newest at
 * the end, the one on screen in the selected tint. Two of the same name say
 * which folder each is in. A file with an edit not saved carries the dot
 * where its × will be, as every editor's tab does.
 */
const tabsEl = ref<HTMLElement | null>(null)

/** The name, and the folder it is in only when another tab has the same name. */
function tabLabel(path: string): { name: string; dir: string } {
  const name = baseName(path)
  const twin = files.value.some((f) => f.path !== path && baseName(f.path) === name)
  if (!twin) return { name, dir: '' }
  const cut = lastSep(path)
  return { name, dir: cut > 0 ? baseName(path.slice(0, cut)) : '' }
}

function pick(path: string) {
  if (fileDrag.ended) return
  goToFile(path)
}

// The tab on screen is always in sight, however many there are.
watch(openPath, (p) => {
  if (!p) return
  void nextTick(() => {
    const el = tabsEl.value?.querySelector<HTMLElement>('[data-path="' + CSS.escape(p) + '"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
})

/**
 * Grabbed and moved along the bar, as the agents' tabs are: the tab follows
 * the cursor and a caret marks the gap it will land in.
 */
const fileDrag = reactive({
  path: null as string | null,
  moved: false,
  ended: false,
  dx: 0,
  /** The index it would land at, in the bar without it; null when nowhere new. */
  to: null as number | null,
  caret: 0,
})
let dragX = 0
let dragRects: { path: string; left: number; right: number }[] = []

function tabDown(ev: PointerEvent, path: string) {
  if (ev.button !== 0 || (ev.target as HTMLElement).closest('.fx')) return
  dragX = ev.clientX
  fileDrag.path = path
  fileDrag.moved = false
  fileDrag.dx = 0
  fileDrag.to = null
  window.addEventListener('pointermove', tabMove)
  window.addEventListener('pointerup', tabUp)
}

function tabMove(ev: PointerEvent) {
  const dx = ev.clientX - dragX
  if (!fileDrag.moved) {
    if (Math.abs(dx) < 4) return
    fileDrag.moved = true
    dragRects = [...(tabsEl.value?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].map((el) => {
      const r = el.getBoundingClientRect()
      return { path: el.dataset.path!, left: r.left, right: r.right }
    })
  }
  fileDrag.dx = dx
  const from = dragRects.findIndex((r) => r.path === fileDrag.path)
  const x = ev.clientX
  // The gap it is over: before the first tab whose middle is past the cursor.
  let gap = dragRects.findIndex((r) => x < (r.left + r.right) / 2)
  if (gap < 0) gap = dragRects.length
  if (gap === from || gap === from + 1 || !dragRects.length) {
    fileDrag.to = null
    return
  }
  fileDrag.to = gap > from ? gap - 1 : gap
  const bar = tabsEl.value?.getBoundingClientRect().left ?? 0
  const scroll = tabsEl.value?.scrollLeft ?? 0
  const edge = gap < dragRects.length ? dragRects[gap]!.left - 2 : dragRects[dragRects.length - 1]!.right + 2
  fileDrag.caret = edge - bar + scroll
}

function tabUp() {
  window.removeEventListener('pointermove', tabMove)
  window.removeEventListener('pointerup', tabUp)
  if (fileDrag.moved && fileDrag.to !== null) {
    const i = files.value.findIndex((f) => f.path === fileDrag.path)
    if (i >= 0) {
      const [f] = files.value.splice(i, 1)
      files.value.splice(fileDrag.to, 0, f!)
    }
  }
  if (fileDrag.moved) {
    // The click a drag ends on is the end of the drag, not a choice of tab.
    fileDrag.ended = true
    setTimeout(() => (fileDrag.ended = false), 0)
  }
  fileDrag.path = null
  fileDrag.moved = false
  fileDrag.dx = 0
  fileDrag.to = null
}
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', tabMove)
  window.removeEventListener('pointerup', tabUp)
})

/** The palette, opened on files — the button says what ⌘P does. */
function openFinder() {
  state.paletteSeed = '/'
  state.paletteOpen = true
}
onBeforeUnmount(() => {
  leave(props.workspace.id)
  view.value?.destroy()
  if (live.save === save) {
    live.save = undefined
    live.edited = undefined
    live.blamed = undefined
  }
})
</script>

<template>
  <div
    ref="root"
    class="code"
    :class="{ narrow, drilled: narrow && drilled }"
    :style="{ '--tree-w': treeW + 'px' }"
  >
    <aside class="tree">
      <div class="ttop">
        <span class="section-label">files</span>
        <button class="icon-btn small" title="Open a file (⌘P)" @click="openFinder">
          <Search class="sm" />
        </button>
      </div>
      <div ref="treeScroll" class="scroll">
        <button
          v-for="n in flatten(roots)"
          :key="n.entry.path"
          class="node"
          :class="{ on: n.entry.path === openPath, dir: n.entry.kind === 'dir' }"
          :style="{ paddingLeft: 6 + n.depth * 13 + 'px' }"
          @click="toggle(n)"
        >
          <span class="tw">
            <component
              v-if="n.entry.kind === 'dir'"
              :is="n.expanded ? ChevronDown : ChevronRight"
              class="sm"
            />
          </span>
          <Folder v-if="n.entry.kind === 'dir'" class="fi sm" />
          <!-- The open file keeps the accent; every other wears its language. -->
          <FileIcon v-else class="fi" :name="n.entry.name" :plain="n.entry.path === openPath" />
          <span class="nm">{{ n.entry.name }}</span>
          <span v-if="n.entry.gitStatus" class="gs" :class="n.entry.gitStatus">{{ n.entry.gitStatus }}</span>
        </button>
      </div>
    </aside>

    <Splitter
      v-if="!narrow"
      :style="{ left: treeW - 4 + 'px' }"
      :size="treeW"
      :min="LAYOUT_LIMITS.tree.min"
      :max="treeMax"
      grows="right"
      :snap="treeSnaps"
      label="Width of the file tree"
      @resize="setColumnWidth('tree', $event)"
      @done="savePlaceWidth('tree')"
      @reset="resetPlaceWidth('tree')"
    />

    <div class="editor">
      <div class="ehead" v-if="files.length">
        <button v-if="narrow" class="icon-btn back" title="Back to the files" @click="drill(false)">
          <ArrowLeft class="sm" />
        </button>
        <!-- One tab per open file, as the agents' bar has them: the newest at
             the end, the one on screen tinted. -->
        <div ref="tabsEl" class="ftabs" role="tablist" aria-label="Open files" :class="{ dragging: fileDrag.moved }">
          <span v-if="fileDrag.moved && fileDrag.to !== null" class="caret" :style="{ left: fileDrag.caret + 'px' }" />
          <TransitionGroup name="ftab">
            <div
              v-for="f in files"
              :key="f.path"
              class="ftab"
              role="tab"
              :data-path="f.path"
              :aria-selected="f.path === openPath"
              :class="{ on: f.path === openPath, dirty: f.dirty, lifted: fileDrag.moved && fileDrag.path === f.path }"
              :style="fileDrag.moved && fileDrag.path === f.path ? { transform: 'translateX(' + fileDrag.dx + 'px)' } : undefined"
              :title="f.path + (f.dirty ? ' — not saved' : '')"
              @pointerdown="tabDown($event, f.path)"
              @click="pick(f.path)"
              @mousedown.middle.prevent="closeFile(f.path)"
            >
              <FileIcon class="fi" :name="baseName(f.path)" :plain="f.path === openPath" />
              <span class="pt">
                {{ tabLabel(f.path).name }}<span v-if="tabLabel(f.path).dir" class="pd">{{ tabLabel(f.path).dir }}</span>
              </span>
              <!-- Unsaved is a mark on the tab it is about, where its × is. -->
              <button class="fx" :title="f.dirty ? 'Close — not saved' : 'Close tab'" aria-label="Close tab" @click.stop="closeFile(f.path)">
                <span class="fdot" /><X class="xs" />
              </button>
            </div>
          </TransitionGroup>
        </div>
        <div class="etools">
        <div v-if="openPath" ref="detailRoot" class="ename">
          <button
            class="icon-btn einfo"
            :class="{ on: detailOpen }"
            title="About this file"
            aria-label="About this file"
            :aria-expanded="detailOpen"
            @click="toggleDetail"
          >
            <Info />
          </button>
          <div v-if="detailOpen" class="menu edetail" role="dialog" aria-label="About this file">
            <div class="dpath mono selectable">{{ openPath }}</div>
            <dl class="dfacts">
              <template v-if="image">
                <template v-if="drawSize">
                  <dt>Dimensions</dt>
                  <dd class="num">{{ drawSize.w }} × {{ drawSize.h }}</dd>
                </template>
                <dt>Size</dt>
                <dd class="num">{{ bytes(image.bytes) }}</dd>
              </template>
              <template v-if="detail">
                <dt>Lines</dt>
                <dd class="num">{{ detail.lines }}</dd>
                <dt>Size</dt>
                <dd class="num">{{ bytes(detail.bytes) }}</dd>
              </template>
              <template v-if="openMtime">
                <dt>Modified</dt>
                <dd>{{ since(openMtime) }}</dd>
              </template>
            </dl>
            <div class="rule" />
            <button v-if="workspace.repo && !image" @click="fileCommits"><GitCommitVertical />Commits</button>
            <button @click="copyPath"><Copy />Copy path</button>
            <button @click="openInIde"><SquareArrowOutUpRight />Open in IDE</button>
            <button @click="revealFolder"><FolderOpen />Open folder</button>
          </div>
        </div>
        <div v-if="openPath && !image && (previewKind || workspace.repo)" class="seg" role="group" aria-label="File view">
          <button :class="{ on: reading === 'code' }" title="Code" aria-label="Code" @click="read('code')">
            <Code /><span class="vlabel">Code</span>
          </button>
          <button
            v-if="workspace.repo"
            :class="{ on: reading === 'authors' }"
            :title="reading === 'authors' && !blameTracked ? 'Not committed yet — git has no history for it' : 'Who wrote each line'"
            aria-label="Authors"
            @click="read('authors')"
          >
            <UserPen /><span class="vlabel">Authors</span>
          </button>
          <button v-if="previewKind" :class="{ on: reading === 'preview' }" title="Preview" aria-label="Preview" @click="read('preview')">
            <Eye /><span class="vlabel">Preview</span>
          </button>
        </div>
        <!-- Only when there is something to write: the dot on the tab already
             says so, and ⌘S works either way. -->
        <button
          v-if="!image && dirty"
          class="icon-btn esave due"
          title="Save (⌘S)"
          aria-label="Save"
          @click="save"
        >
          <Save />
        </button>
        </div>
      </div>
      <div v-show="openPath && !previewing && !image" ref="host" class="cm" />
      <div v-if="openPath && previewing && previewKind === 'markdown' && !image" class="preview">
        <MarkdownPreview :source="docSource" />
      </div>
      <div v-else-if="openPath && (image || (previewing && previewKind === 'svg'))" class="preview drawview">
        <p v-if="image && !image.url" class="drawnote">
          Too large to show here ({{ bytes(image.bytes) }}) — open the folder to look at it.
        </p>
        <p v-else-if="drawBroken" class="drawnote bad">
          {{ image ? 'This image does not draw — the file may be damaged.' : 'This SVG does not draw — the source has an error in it.' }}
        </p>
        <template v-else>
          <div class="drawstage">
            <img :src="drawUrl" alt="" @load="onDrawLoad" @error="drawBroken = true" />
          </div>
          <span v-if="drawSize" class="drawsize num">{{ drawSize.w }} × {{ drawSize.h }}</span>
        </template>
      </div>
      <div v-if="!files.length" class="empty">
        <FileCode />
        <strong>No file open</strong>
        <span>Pick one on the left, or press <span class="kbd">⌘P</span> to jump straight to it.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.code { position: relative; display: flex; height: 100%; }
/* Narrow, one of the two is the screen: the tree, or the file opened over it. */
.code.narrow .tree { flex: 1; width: auto; border-right: none; }
.code.narrow .editor { display: none; }
.code.narrow.drilled .tree { display: none; }
.code.narrow.drilled .editor { display: flex; }

.tree {
  flex: none;
  width: var(--tree-w, 272px);
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
  background: var(--surface-review);
  min-height: 0;
}
.ttop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 8px 8px 14px;
}
.icon-btn.small { width: 24px; height: 24px; }
.scroll { flex: 1; overflow: auto; padding: 0 8px 10px; }

.node {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  padding-right: 9px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--text-muted);
  white-space: nowrap;
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.node:hover { background: var(--hover); }
.node.on { background: var(--selected); color: var(--text); }
.tw {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  color: var(--text-dim);
}
.tw .lucide { width: 12px; height: 12px; }
.fi { color: var(--text-dim); }
.node.dir .fi { color: var(--text-muted); }
.node.on .fi { color: var(--accent); }
.nm { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.gs { flex: none; font-size: 11px; font-weight: 700; color: var(--warn); }
.gs\?\? { color: var(--text-dim); }

.editor { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; container: editor / inline-size; }
.ehead {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  /* The right edge matches the tree's header, so Save and the file search
     line up across the two. */
  padding: 0 8px 0 6px;
  border-bottom: 1px solid var(--line);
}
/* As the Diff's: the arrow, then the file it is the way back from. */
.ehead .back { flex: none; width: 26px; height: 26px; margin: 0 -4px 0 2px; }

/* ── the tabs — the agents' bar, one box per file ───────────────────────── */
.ftabs {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 100%;
  overflow-x: auto;
  scrollbar-width: none;
}
.ftabs::-webkit-scrollbar { display: none; }
/* Equal widths that give way together, down to a name still readable; past
   that the bar scrolls, and the one on screen is kept in sight. */
.ftab {
  position: relative;
  flex: 0 1 184px;
  width: 184px;
  min-width: 108px;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 6px 0 10px;
  border-radius: var(--radius-sm);
  background: var(--tab-rest);
  color: var(--text-muted);
  font-size: var(--fs-xs);
  cursor: default;
  user-select: none;
  touch-action: none;
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.ftab:hover { background: var(--tab-rest-hover); color: var(--text); }
.ftab.on, .ftab.on:hover { background: var(--selected); color: var(--text); font-weight: 600; }
.ftab .fi { flex: none; }
.ftab.on .fi { color: var(--accent); }
.pt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Which folder, only when two tabs share a name. */
.pd { margin-left: 6px; font-weight: 400; color: var(--text-dim); }
/* Always there, seen only on the tab on screen or under the cursor — or as
   the dot of an edit not saved, which the × takes the place of on hover. */
.fx {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  color: var(--text-dim);
  visibility: hidden;
}
.ftab:hover .fx, .ftab.on .fx, .ftab.dirty .fx { visibility: visible; }
.fx:hover { background: var(--active); color: var(--text); }
.fx .xs { width: 11px; height: 11px; }
.fdot { display: none; width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }
.ftab.dirty .fdot { display: block; }
.ftab.dirty .fx .xs { display: none; }
.ftab.dirty .fx:hover .fdot { display: none; }
.ftab.dirty .fx:hover .xs { display: block; }
/* Grabbed: it lifts and follows the cursor. */
.ftab.lifted {
  z-index: 3;
  background: var(--tab-on);
  color: var(--text);
  box-shadow: var(--shadow-md), inset 0 0 0 1px var(--line);
  cursor: grabbing;
  transition: none;
}
/* Dropped here, it goes in this gap. */
.caret {
  position: absolute;
  z-index: 4;
  top: 10px;
  bottom: 10px;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--accent);
  pointer-events: none;
}
/* A tab arriving or leaving, and the others closing up — short, and only
   about the tab itself. */
.ftab-enter-active, .ftab-leave-active { transition: opacity 140ms var(--ease-soft), transform 140ms var(--ease-soft); }
.ftab-enter-from, .ftab-leave-to { opacity: 0; transform: translateY(3px); }
.ftab-leave-active { position: absolute; }
.ftab-move { transition: transform 160ms var(--ease-soft); }
.ftabs.dragging .ftab-move { transition: none; }

.ename { position: relative; flex: none; display: flex; align-items: center; }
.einfo { width: 24px; height: 24px; }
.einfo .lucide { width: 13px; height: 13px; }
.einfo.on { background: var(--active); color: var(--text); }
.edetail {
  top: calc(100% + 6px);
  right: -4px;
  left: auto;
  width: 300px;
  max-width: calc(100cqw - 16px);
  padding: 10px 5px 5px;
}
.dpath {
  padding: 0 9px;
  font-size: var(--fs-xs);
  color: var(--text);
  overflow-wrap: anywhere;
}
.dfacts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 5px 14px;
  margin: 10px 0 4px;
  padding: 0 9px;
  font-size: var(--fs-xs);
}
.dfacts dt { color: var(--text-dim); }
.dfacts dd { margin: 0; color: var(--text-muted); }
/* The switch and Save are one set, closer to each other than to the name. */
.etools { flex: none; display: flex; align-items: center; gap: 4px; }
.esave { width: 26px; height: 26px; }
.esave .lucide { width: 14px; height: 14px; }
/* Shown only when there is something to write, and then it says so. */
.esave.due { color: var(--accent); }
.cm { flex: 1; min-height: 0; overflow: hidden; }
.preview { flex: 1; min-height: 0; overflow: auto; }

.drawview {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
}
/* A checkerboard behind it, so what is transparent reads as transparent and
   not as the panel's own colour. */
.drawstage {
  display: flex;
  width: 100%;
  max-width: 720px;
  height: min(480px, calc(100% - 30px));
  min-height: 120px;
  padding: 24px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background-color: var(--bg-sunken);
  background-image:
    linear-gradient(45deg, var(--hover) 25%, transparent 25%, transparent 75%, var(--hover) 75%),
    linear-gradient(45deg, var(--hover) 25%, transparent 25%, transparent 75%, var(--hover) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 8px 8px;
}
.drawstage img { width: 100%; height: 100%; object-fit: contain; }
.drawsize, .drawnote { font-size: var(--fs-xs); color: var(--text-dim); }
.drawnote.bad { color: var(--warn); }

.ehead .seg { flex: none; }
.ehead .seg > button { height: 20px; padding: 0 8px; }
.ehead .seg .lucide { width: 12px; height: 12px; flex: none; }
/* As in the Diff: the words come back only when the editor is wide enough
   that they cost nothing. */
@container editor (max-width: 1100px) {
  .vlabel { display: none; }
  .ehead .seg > button { padding: 0 6px; }
}
</style>
