<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { php } from '@codemirror/lang-php'
import type { FileEntry, Workspace } from '@cockpit/shared'
import {
  ChevronDown, ChevronRight, Copy, File, FileCode, Folder, FolderOpen, Info, Save, Search,
} from '@lucide/vue'
import Splitter from '../Splitter.vue'
import {
  LAYOUT_DEFAULTS, LAYOUT_LIMITS, client, guard, layout, resetPlaceWidth, savePlaceWidth, setColumnWidth, state,
  stopSaveOnProtected, toast,
} from '../../core/store.js'

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

function languageFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue'].includes(ext)) return javascript({ typescript: true, jsx: true })
  if (ext === 'json') return json()
  if (['md', 'markdown'].includes(ext)) return markdown()
  if (['yaml', 'yml'].includes(ext)) return yaml()
  if (ext === 'css') return css()
  if (['html', 'htm'].includes(ext)) return html()
  if (ext === 'php') return php()
  return []
}

const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'json', 'css', 'html', 'php', 'yml', 'yaml',
])

/** Files that hold code get the marked icon; everything else stays quiet. */
function fileIcon(name: string) {
  return CODE_EXT.has(name.split('.').pop()?.toLowerCase() ?? '') ? FileCode : File
}

/** A theme built from the same tokens as the rest of the app, so the editor
 *  does not look like a different product embedded in this one. */
const cockpitTheme = EditorView.theme({
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

async function loadDir(rel: string): Promise<FileEntry[]> {
  const r = await guard(() => client.call('fs.list', { workspaceId: props.workspace.id, rel }))
  return r ?? []
}

async function loadRoot() {
  openPath.value = null
  dirty.value = false
  view.value?.destroy()
  view.value = null
  const entries = await loadDir('.')
  roots.value = entries.map((e) => ({ entry: e, depth: 0, expanded: false, children: null }))
  takeRequest()
}

/** A file the palette asked for, once this is the workspace it is in. */
function takeRequest() {
  const r = state.codeRequest
  if (!r || r.workspaceId !== props.workspace.id) return
  state.codeRequest = null
  void openFile(r.path, r.line)
}

async function toggle(node: Node) {
  if (node.entry.kind !== 'dir') {
    await openFile(node.entry.path)
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

async function openFile(path: string, line: number | null = null) {
  const r = await guard(() => client.call('fs.read', { workspaceId: props.workspace.id, rel: path }))
  if (!r) return
  openPath.value = path
  openMtime.value = r.mtimeMs
  dirty.value = false

  const doc = r.binary ? '' : r.content
  const el = host.value
  if (!el) return
  view.value?.destroy()
  view.value = new EditorView({
    parent: el,
    state: EditorState.create({
      doc,
      extensions: [
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
        EditorView.updateListener.of((u) => {
          if (u.docChanged) dirty.value = true
        }),
      ],
    }),
  })
  // A search hit is a line, not a file: land on it, in the middle of the
  // screen, where the eye is already going.
  if (line) {
    const v = view.value
    const at = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines))
    v.dispatch({ selection: { anchor: at.from }, effects: EditorView.scrollIntoView(at.from, { y: 'center' }) })
    v.focus()
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
}

watch(() => props.workspace.id, loadRoot, { immediate: true })
watch(() => state.codeRequest, takeRequest)

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

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
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

async function revealFolder() {
  const path = openPath.value
  if (!path) return
  detailOpen.value = false
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined
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
onBeforeUnmount(() => view.value?.destroy())
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
          <component
            :is="n.entry.kind === 'dir' ? Folder : fileIcon(n.entry.name)"
            class="fi sm"
          />
          <span class="nm">{{ n.entry.name }}</span>
          <span v-if="n.entry.gitStatus" class="gs" :class="n.entry.gitStatus">{{ n.entry.gitStatus }}</span>
        </button>
      </div>
    </aside>

    <Splitter
      v-if="!stacked"
      :style="{ left: treeW - 3 + 'px' }"
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
            <button @click="copyPath"><Copy />Copy path</button>
            <button @click="revealFolder"><FolderOpen />Open folder</button>
          </div>
        </div>
        <span class="grow" />
        <button
          class="icon-btn esave"
          :class="{ due: dirty }"
          :disabled="!dirty"
          title="Save (⌘S)"
          aria-label="Save"
          @click="save"
        >
          <Save />
        </button>
      </div>
      <div v-show="openPath" ref="host" class="cm" />
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
.esave { width: 26px; height: 26px; }
.esave .lucide { width: 14px; height: 14px; }
/* Only worth pressing when there is something to write; then it says so. */
.esave.due { color: var(--accent); }
.cm { flex: 1; min-height: 0; overflow: hidden; }
</style>
