<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { FolderOpen, Trash2, TriangleAlert, X } from '@lucide/vue'
import {
  editingProject, forgetProject, moveProject, pickFolder, renameProject, state, trashProject,
} from '../core/store.js'

/**
 * Everything you can do to a project as a project, rather than to the code in
 * it. Three of the four actions are cheap and reversible; the fourth is the
 * only place in the app that touches somebody's source tree, so it sits behind
 * its own confirmation and goes to the Trash rather than being deleted.
 */

const p = computed(() => editingProject.value)

const name = ref('')
const root = ref('')
const moveFiles = ref(true)
const busy = ref(false)
/** 'trash' asks for the project's name to be typed back before it will run. */
const confirming = ref<null | 'forget' | 'trash'>(null)
const typed = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

watch(
  p,
  (proj) => {
    name.value = proj?.name ?? ''
    root.value = proj?.root ?? ''
    moveFiles.value = true
    confirming.value = null
    typed.value = ''
    if (proj) void nextTick(() => nameInput.value?.focus())
  },
  { immediate: true },
)

const nameChanged = computed(() => !!p.value && name.value.trim() !== p.value.name)
const rootChanged = computed(() => !!p.value && root.value.trim() !== p.value.root)
const dirty = computed(() => nameChanged.value || rootChanged.value)

/** A project holds its workspaces; the count is what makes the danger real. */
const workspaces = computed(() =>
  p.value ? state.workspaces.filter((w) => w.projectId === p.value!.id && w.kind !== 'group') : [],
)
const unpushed = computed(() => workspaces.value.filter((w) => w.git?.hasUnpushedWork))
const running = computed(() => workspaces.value.filter((w) => w.runtime?.status === 'up'))

function close() {
  if (busy.value) return
  state.editingProjectId = null
}

async function save() {
  const proj = p.value
  if (!proj || busy.value) return
  busy.value = true
  try {
    // Rename first: a move rebuilds the project under a new id, and the name
    // override travels with it.
    if (nameChanged.value) {
      const next = name.value.trim()
      if (!(await renameProject(proj.id, next || null))) return
    }
    if (rootChanged.value) {
      if (!(await moveProject(proj.id, root.value.trim(), moveFiles.value))) return
    }
  } finally {
    busy.value = false
  }
}

async function browse() {
  const picked = await pickFolder({
    title: 'Move ' + (p.value?.name ?? 'the project'),
    message: 'Pick where the project folder should live',
    buttonLabel: 'Use this folder',
    ...(root.value ? { defaultPath: root.value } : {}),
  })
  if (picked) root.value = picked
}

async function doForget() {
  const proj = p.value
  if (!proj) return
  busy.value = true
  await forgetProject(proj.id)
  busy.value = false
}

async function doTrash() {
  const proj = p.value
  if (!proj || typed.value.trim() !== proj.name) return
  busy.value = true
  await trashProject(proj.id)
  busy.value = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    if (confirming.value) confirming.value = null
    else close()
  }
}
</script>

<template>
  <div v-if="p" class="scrim" @mousedown.self="close" @keydown="onKey">
    <div class="dlg" role="dialog" aria-label="Project settings">
      <header class="head">
        <h2>{{ p.name }}</h2>
        <span class="grow" />
        <span class="count num">
          {{ workspaces.length }} {{ workspaces.length === 1 ? 'workspace' : 'workspaces' }}
        </span>
        <button class="icon-btn" title="Close (esc)" @click="close"><X class="sm" /></button>
      </header>

      <div class="body">
        <label class="field">
          <span class="lbl">Name</span>
          <input
            ref="nameInput"
            v-model="name"
            class="input"
            type="text"
            spellcheck="false"
            :placeholder="p.manifestPath ? 'from the manifest' : 'the folder name'"
            @keydown.enter="save"
          />
          <span class="help">
            Kept on this machine only — renaming never writes into the repository.
            Empty falls back to
            {{ p.manifestPath ? 'the name in the manifest' : 'the folder name' }}.
          </span>
        </label>

        <label class="field">
          <span class="lbl">Location</span>
          <div class="row">
            <input v-model="root" class="input mono" type="text" spellcheck="false" />
            <button class="btn" title="Choose a folder" @click="browse">
              <FolderOpen />Browse
            </button>
          </div>

          <label v-if="rootChanged" class="check">
            <input v-model="moveFiles" type="checkbox" />
            <span>
              Move the folder there too.
              <em v-if="!moveFiles">Off: Cockpit just looks at the new path instead.</em>
            </span>
          </label>
          <span v-else class="help">Where the project lives on disk.</span>
        </label>

        <!-- §16 — a move pulls the ground out from under anything still running. -->
        <p v-if="rootChanged && running.length" class="note warn">
          <TriangleAlert class="sm" />
          {{ running.length }} runtime{{ running.length === 1 ? '' : 's' }} still up — moving will
          be refused until {{ running.length === 1 ? 'it is' : 'they are' }} stopped.
        </p>
      </div>

      <div class="danger">
        <span class="section-label">Danger zone</span>

        <div class="drow">
          <div class="dtext">
            <strong>Untrack</strong>
            <span>Cockpit forgets this project. Every file stays exactly where it is.</span>
          </div>
          <button
            v-if="confirming !== 'forget'"
            class="btn"
            :disabled="busy"
            @click="confirming = 'forget'"
          >
            Untrack
          </button>
          <span v-else class="confirm">
            <button class="btn ghost" @click="confirming = null">Cancel</button>
            <button class="btn danger" :disabled="busy" @click="doForget">Untrack it</button>
          </span>
        </div>

        <div class="drow">
          <div class="dtext">
            <strong>Move to Trash</strong>
            <span>
              The folder goes to the system Trash, recoverable from there. Refused while
              anything is running or holds unpushed commits.
            </span>
          </div>
          <button
            v-if="confirming !== 'trash'"
            class="btn danger"
            :disabled="busy"
            @click="confirming = 'trash'"
          >
            <Trash2 />Move to Trash
          </button>
        </div>

        <div v-if="confirming === 'trash'" class="confirm-box">
          <p v-if="unpushed.length" class="note bad">
            <TriangleAlert class="sm" />
            Unpushed commits in {{ unpushed.map((w) => w.name).join(', ') }}. Push or drop them
            first — the core will refuse.
          </p>
          <p v-if="running.length" class="note bad">
            <TriangleAlert class="sm" />
            {{ running.length }} runtime{{ running.length === 1 ? '' : 's' }} still up. Stop
            {{ running.length === 1 ? 'it' : 'them' }} first — the core will refuse.
          </p>
          <p class="prose">
            Type <strong>{{ p.name }}</strong> to confirm. This moves
            <code class="mono">{{ p.root }}</code> to the Trash.
          </p>
          <div class="row">
            <input
              v-model="typed"
              class="input"
              type="text"
              spellcheck="false"
              :placeholder="p.name"
              @keydown.enter="doTrash"
            />
            <button class="btn ghost" @click="confirming = null">Cancel</button>
            <button
              class="btn danger"
              :disabled="busy || typed.trim() !== p.name"
              @click="doTrash"
            >
              Move to Trash
            </button>
          </div>
        </div>
      </div>

      <footer class="foot">
        <span class="grow" />
        <button class="btn ghost" :disabled="busy" @click="close">Close</button>
        <button class="btn primary" :disabled="busy || !dirty" @click="save">
          {{ busy ? 'Working…' : 'Save' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  backdrop-filter: blur(6px) saturate(1.1);
  animation: fade var(--dur-2) var(--ease-soft);
}
@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
.dlg {
  width: min(560px, 92vw);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  background: var(--overlay);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg), var(--inset-top);
  overflow: hidden;
  animation: rise var(--dur-3) var(--ease);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to { opacity: 1; transform: none; }
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 14px 14px 20px;
  border-bottom: 1px solid var(--line);
}
.head h2 {
  margin: 0;
  min-width: 0;
  font-size: var(--fs-lg);
  font-weight: 640;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.grow { flex: 1; }
.count { font-size: var(--fs-xs); color: var(--text-dim); }

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px 6px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.field { display: flex; flex-direction: column; gap: 7px; }
.lbl {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.help { font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.55; }
.row { display: flex; align-items: center; gap: 8px; }
.row .input { flex: 1; min-width: 0; }
.row .btn { flex: none; }

.check {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin-top: 2px;
  font-size: var(--fs-sm);
  color: var(--text-muted);
  line-height: 1.5;
}
.check input { margin-top: 2px; }
.check em { color: var(--text-dim); font-style: normal; }

.note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.6;
}
.note .lucide { margin-top: 2px; }
.note.warn { color: var(--warn); }

/* Prose, not a flex row: `.note` lays its children out as flex items, which
   turns a sentence containing <strong> and <code> into columns. */
.prose {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.7;
}
.prose strong { color: var(--text); font-weight: 600; }
.prose code {
  color: var(--text);
  word-break: break-all;
}
.note.bad { color: var(--danger); }
.note code { color: var(--text); }

/* tokens.css: colour is for meaning, not decoration. A permanently red panel
   shouts before anything dangerous is happening — the ground stays neutral and
   the red is spent on the label and the one button that earns it. */
.danger {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 12px 20px 0;
  padding: 14px 16px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-sunken);
}
.danger > .section-label { color: var(--danger); }
.drow { display: flex; align-items: center; gap: 16px; }
/* Without this the button shrinks under the description and wraps its own
   icon onto a second line. */
.drow > .btn,
.drow > .confirm { flex: none; }
.dtext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dtext strong { font-size: var(--fs-sm); font-weight: 600; }
.dtext span { font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
.confirm { display: flex; gap: 6px; flex: none; }
.confirm-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.confirm-box .row .btn { flex: none; }

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 20px 16px;
}
</style>
