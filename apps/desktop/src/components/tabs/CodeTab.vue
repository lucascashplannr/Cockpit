<script lang="ts">
/**
 * Per workspace: the file the Code tab had open, where the caret and the
 * scroll were, and — if it was not saved — what had been typed. Leaving the
 * tab or the workspace is looking elsewhere, not closing the file: it is all
 * there on the way back. Kept for as long as the window, not past it.
 */
interface Left {
  path: string
  anchor: number
  scroll: number
  draft: { content: string; mtimeMs: number | null } | null
}
const left = new Map<string, Left>()
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import type { BlameCommit, FileEntry, Workspace } from '@cockpit/shared'
import {
  ChevronDown, ChevronRight, Code, Copy, Eye, FileCode, Folder, FolderOpen, GitCommitVertical, Info, Save, Search,
  SquareArrowOutUpRight, UserPen,
} from '@lucide/vue'
import MarkdownPreview from '../MarkdownPreview.vue'
import Splitter from '../Splitter.vue'
import {
  LAYOUT_DEFAULTS, LAYOUT_LIMITS, client, goTo, guard, layout, openCommits, resetPlaceWidth, savePlaceWidth,
  setColumnWidth, state, stopSaveOnProtected, toast,
} from '../../core/store.js'
import { cockpitTheme, languageFor } from '../../core/editor.js'
import { editorFind, findInEditor, useFindKey } from '../../core/find.js'
import { blameGutter, blameMarks, blameOn } from '../../core/blame.js'
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
 * Beside it when there is room, above it when there is not — under 620px a
 * tree column would leave the editor too little to be worth opening. Either
 * way the line between them is a handle, and where it was left belongs to the
 * place (see `savePlaceWidth`): the width and the height are kept apart, since
 * the one says nothing about the other.
 *
 * Measured here rather than by the container query in ReviewTools that used
 * to stack it: the handle has to know which of the two it is moving.
 */
const root = ref<HTMLElement | null>(null)
const stacked = ref(false)
const panelW = ref(0)
const panelH = ref(0)
const treeMax = computed(() => Math.max(LAYOUT_LIMITS.tree.min, Math.min(LAYOUT_LIMITS.tree.max, panelW.value - 320)))
const treeHMax = computed(() =>
  Math.max(LAYOUT_LIMITS.treeHeight.min, Math.min(LAYOUT_LIMITS.treeHeight.max, panelH.value - 140)),
)
const treeW = computed(() => Math.min(layout.tree, treeMax.value))
const treeH = computed(() => Math.min(layout.treeHeight, treeHMax.value))
/** Where the line holds on the way past: half, and the default. */
const treeSnaps = computed(() => [Math.round(panelW.value / 2), LAYOUT_DEFAULTS.tree])
const treeHSnaps = computed(() => [Math.round(panelH.value / 2), LAYOUT_DEFAULTS.treeHeight])

let ro: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver(([e]) => {
    if (!e) return
    stacked.value = e.contentRect.width < 620
    panelW.value = e.contentRect.width
    panelH.value = e.contentRect.height
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
const openPath = ref<string | null>(null)
const openMtime = ref<number | null>(null)
const dirty = ref(false)
const host = ref<HTMLElement | null>(null)
const view = shallowRef<EditorView | null>(null)
const langCompartment = new Compartment()
useFindKey(() => editorFind(view.value))
const blameCompartment = new Compartment()
/** Bumped on every edit and every open, so what reads the document follows it. */
const docTick = ref(0)


async function loadDir(rel: string): Promise<FileEntry[]> {
  const r = await guard(() => client.call('fs.list', { workspaceId: props.workspace.id, rel }))
  return r ?? []
}

/** Where this workspace's file was left, kept for the way back. */
function leave(workspaceId: string) {
  const v = view.value
  const path = openPath.value
  if (!path) return
  left.set(workspaceId, {
    path,
    anchor: v?.state.selection.main.head ?? 0,
    scroll: v?.scrollDOM.scrollTop ?? 0,
    draft: v && dirty.value ? { content: v.state.doc.toString(), mtimeMs: openMtime.value } : null,
  })
}

async function loadRoot() {
  openPath.value = null
  dirty.value = false
  image.value = null
  view.value?.destroy()
  view.value = null
  const entries = await loadDir('.')
  roots.value = entries.map((e) => ({ entry: e, depth: 0, expanded: false, children: null }))
  // Back where it was left — first, so that an edit kept there is on screen
  // before anything asked for meanwhile can ask to replace it.
  const was = left.get(props.workspace.id)
  if (was) await openFile(was.path)
  takeRequest()
}

/** A file the palette asked for, once this is the workspace it is in. */
function takeRequest() {
  const r = state.codeRequest
  if (!r || r.workspaceId !== props.workspace.id) return
  state.codeRequest = null
  goToFile(r.path, r.line)
}

/**
 * Every way of opening a file comes through here. The file already open is
 * not read again — that would put the disk's copy over what was typed — and
 * another one, over an edit not saved, is asked for first: nothing else keeps
 * that edit, as the Diff's question says.
 */
function goToFile(path: string, line: number | null = null) {
  if (path === openPath.value && view.value) {
    if (line) toLine(view.value, line)
    return
  }
  if (!dirty.value) return void openFile(path, line)
  state.pendingConfirm = {
    title: 'Drop your edit?',
    body: ['What you typed in ' + baseName(openPath.value ?? '') + ' is not saved, and nothing keeps a copy of it.'],
    verb: 'Drop the edit',
    cancel: 'Keep editing',
    done: 'Edit dropped',
    danger: true,
    run: async () => {
      void openFile(path, line)
      return true
    },
  }
}

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

async function openImage(path: string) {
  const r = await guard(() => client.call('fs.readImage', { workspaceId: props.workspace.id, rel: path }))
  if (!r) return
  if (!left.get(props.workspace.id)?.draft) left.delete(props.workspace.id)
  openPath.value = path
  openMtime.value = r.mtimeMs
  dirty.value = false
  view.value?.destroy()
  view.value = null
  image.value = { url: r.data ? 'data:' + r.mediaType + ';base64,' + r.data : null, bytes: r.bytes }
}

async function openFile(path: string, line: number | null = null) {
  if (isImage(path)) return openImage(path)
  const r = await guard(() => client.call('fs.read', { workspaceId: props.workspace.id, rel: path }))
  if (!r) return
  // What was left here unsaved goes back over the disk's copy, with the
  // mtime it was opened at — so a save still refuses if the file moved since.
  const was = left.get(props.workspace.id)
  const kept = was?.path === path ? was : null
  // Another file's kept edit is not this one to drop.
  if (kept || !was?.draft) left.delete(props.workspace.id)
  openPath.value = path
  openMtime.value = kept?.draft ? kept.draft.mtimeMs : r.mtimeMs
  dirty.value = false
  image.value = null

  const doc = kept?.draft ? kept.draft.content : r.binary ? '' : r.content
  const el = host.value
  if (!el) return
  view.value?.destroy()
  view.value = new EditorView({
    parent: el,
    state: EditorState.create({
      doc,
      extensions: [
        // Before the numbers: who, then which line, then the line.
        blameCompartment.of(blameOn.value ? blameExt : []),
        lineNumbers(),
        history(),
        highlightActiveLine(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: () => (void save(), true) },
        ]),
        langCompartment.of(languageFor(path)),
        cockpitTheme,
        findInEditor,
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return
          dirty.value = true
          docTick.value++
        }),
      ],
    }),
  })
  docTick.value++
  if (kept?.draft) dirty.value = true
  // Blame reads the disk; over a kept edit its lines would be off by what was typed.
  if (blameOn.value && !dirty.value) void loadBlame()
  if (line) toLine(view.value, line)
  else if (kept) {
    const v = view.value
    v.dispatch({ selection: { anchor: Math.min(kept.anchor, v.state.doc.length) } })
    requestAnimationFrame(() => {
      if (view.value === v) v.scrollDOM.scrollTop = kept.scroll
    })
  }
}

/** §16 — the mtime check is what stops a manual edit and an agent edit from
 *  silently overwriting one another. */
async function save() {
  const v = view.value
  if (!v || !openPath.value) return
  // §16 — asked before the write, so the edit is still in the editor after.
  if (stopSaveOnProtected(props.workspace)) return
  const res = await guard(() =>
    client.call('fs.write', {
      workspaceId: props.workspace.id,
      rel: openPath.value!,
      content: v.state.doc.toString(),
      expectMtimeMs: openMtime.value,
    }),
  )
  if (!res) return
  if (res.conflict) {
    toast('error', 'File changed on disk since it was opened — reload before saving')
    return
  }
  openMtime.value = res.mtimeMs
  dirty.value = false
  toast('ok', 'saved ' + openPath.value, { icon: 'save' })
  // What was saved is what the next blame reads: the edited lines become
  // not committed, and the ones around them find their commits again.
  if (blameOn.value) void loadBlame()
}

/* ── who wrote it ──────────────────────────────────────────────────────────
 *
 * §2 — git's answer, beside each line: the commit that last touched it. A
 * click on it opens this file's commits on that one, where the change it made
 * can be read; on a line not committed yet, the changes themselves.
 */
const blameExt = blameGutter(openBlamed)
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
watch(
  () => [props.workspace.git?.lastCommit?.hash, props.workspace.git?.branch].join('|'),
  () => {
    if (blameOn.value && !dirty.value) void loadBlame()
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
  toast('info', 'Path copied')
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

/** The palette, opened on files — the button says what ⌘P does. */
function openFinder() {
  state.paletteSeed = '/'
  state.paletteOpen = true
}
onBeforeUnmount(() => {
  leave(props.workspace.id)
  view.value?.destroy()
})
</script>

<template>
  <div
    ref="root"
    class="code"
    :class="{ stacked }"
    :style="{ '--tree-w': treeW + 'px', '--tree-h': treeH + 'px' }"
  >
    <aside class="tree">
      <div class="ttop">
        <span class="section-label">files</span>
        <button class="icon-btn small" title="Open a file (⌘P)" @click="openFinder">
          <Search class="sm" />
        </button>
      </div>
      <div class="scroll">
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
      v-if="!stacked"
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
    <Splitter
      v-else
      :size="treeH"
      :min="LAYOUT_LIMITS.treeHeight.min"
      :max="treeHMax"
      grows="down"
      :snap="treeHSnaps"
      label="Height of the file tree"
      @resize="setColumnWidth('treeHeight', $event)"
      @done="savePlaceWidth('treeHeight')"
      @reset="resetPlaceWidth('treeHeight')"
    />

    <div class="editor">
      <div class="ehead" v-if="openPath">
        <!-- The name alone, as in the Diff: the folders are in the tree beside
             it, and the rest is one click away. -->
        <div ref="detailRoot" class="ename">
          <span class="mono ep" :title="openPath">{{ baseName(openPath) }}</span>
          <!-- Unsaved is a mark on the name it is about, as every editor tab
               has it — not a badge floating somewhere in the header. -->
          <span v-if="dirty" class="edirty" title="Unsaved changes" aria-label="Unsaved changes" />
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
        <span class="grow" />
        <div class="etools">
        <div v-if="!image && (previewKind || workspace.repo)" class="seg" role="group" aria-label="File view">
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
        <!-- Only when there is something to write: the dot on the name already
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
      <div v-if="!openPath" class="empty">
        <FileCode />
        <strong>No file open</strong>
        <span>Pick one on the left, or press <span class="kbd">⌘P</span> to jump straight to it.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.code { position: relative; display: flex; height: 100%; }
/* Stacked, the tree is a band across the top and the line under it is the
   boundary — a border the eye can find, with the handle over it. */
.code.stacked { flex-direction: column; }

.tree {
  flex: none;
  width: var(--tree-w, 272px);
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
  background: var(--surface-review);
  min-height: 0;
}
.code.stacked .tree {
  width: auto;
  height: var(--tree-h, 240px);
  border-right: none;
  border-bottom: 1px solid var(--line);
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
     line up when the two are stacked. */
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--line);
}
.ep {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ename { position: relative; min-width: 0; display: flex; align-items: center; gap: 2px; }
.einfo { width: 24px; height: 24px; }
.einfo .lucide { width: 13px; height: 13px; }
.einfo.on { background: var(--active); color: var(--text); }
.edetail {
  top: calc(100% + 6px);
  left: -6px;
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
.grow { flex: 1; }
.edirty {
  flex: none;
  width: 7px;
  height: 7px;
  margin: 0 3px 0 5px;
  border-radius: 50%;
  background: var(--warn);
}
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
