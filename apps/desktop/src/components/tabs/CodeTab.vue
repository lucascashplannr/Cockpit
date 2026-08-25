<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
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
import { client, guard, state, toast } from '../../core/store.js'

/**
 * §12 — "Périmètre assumé : voir, naviguer, éditer manuellement. Pas de
 * complétion, pas de navigation sémantique."
 * §12 — "l'arbre de fichiers n'est pas la navigation principale" — it is here
 * for occasional exploration; ⌘K and search do the real work.
 */

const props = defineProps<{ workspace: Workspace }>()

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

async function openFile(path: string) {
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
}

/** §16 — the mtime check is what stops a manual edit and an agent edit from
 *  silently overwriting one another. */
async function save() {
  const v = view.value
  if (!v || !openPath.value) return
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
  toast('ok', 'saved ' + openPath.value)
}

watch(() => props.workspace.id, loadRoot, { immediate: true })
onBeforeUnmount(() => view.value?.destroy())
</script>

<template>
  <div class="code">
    <aside class="tree">
      <div class="ttop">
        <span class="section-label">files</span>
        <button class="btn ghost tiny" title="Fuzzy open (⌘K)" @click="state.paletteOpen = true">⌕</button>
      </div>
      <div class="scroll">
        <button
          v-for="n in flatten(roots)"
          :key="n.entry.path"
          class="node"
          :class="{ on: n.entry.path === openPath }"
          :style="{ paddingLeft: 8 + n.depth * 12 + 'px' }"
          @click="toggle(n)"
        >
          <span class="tw">{{ n.entry.kind === 'dir' ? (n.expanded ? '▾' : '▸') : '' }}</span>
          <span class="nm">{{ n.entry.name }}</span>
          <span v-if="n.entry.gitStatus" class="gs" :class="n.entry.gitStatus">{{ n.entry.gitStatus }}</span>
        </button>
      </div>
    </aside>

    <div class="editor">
      <div class="ehead" v-if="openPath">
        <span class="mono ep">{{ openPath }}</span>
        <span v-if="dirty" class="chip warn">unsaved</span>
        <span class="grow" />
        <button class="btn ghost" @click="save" :disabled="!dirty">Save <span class="kbd">⌘S</span></button>
      </div>
      <div v-show="openPath" ref="host" class="cm" />
      <div v-if="!openPath" class="empty">
        <strong>No file open</strong>
        <span>Pick one on the left, or press <span class="kbd">⌘K</span> to jump straight to it.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.code { display: grid; grid-template-columns: 260px minmax(0, 1fr); height: 100%; }

.tree {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
  background: var(--panel);
  min-height: 0;
}
.ttop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 8px 6px 12px;
}
.btn.tiny { height: 20px; width: 22px; padding: 0; font-size: 12px; }
.scroll { flex: 1; overflow: auto; padding: 0 6px 8px; }

.node {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  height: 24px;
  padding-right: 8px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--text-muted);
  white-space: nowrap;
}
.node:hover { background: var(--hover); }
.node.on { background: var(--selected); color: var(--text); }
.tw { flex: none; width: 11px; font-size: 9px; color: var(--text-dim); }
.nm { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.gs { flex: none; font-size: 10px; font-weight: 700; color: var(--warn); }
.gs\?\? { color: var(--text-dim); }

.editor { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ehead {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
}
.ep {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grow { flex: 1; }
.ehead .btn { height: 22px; padding: 0 8px; font-size: var(--fs-xs); }
.cm { flex: 1; min-height: 0; overflow: hidden; }
</style>
