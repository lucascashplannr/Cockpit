<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { FolderOpen, Lock, Plus, SlidersHorizontal, Trash2, TriangleAlert, X } from '@lucide/vue'
import DialogShell from './DialogShell.vue'
import {
  askTrashProject, askUntrackProject, editingProject, loadDeclarations, moveProject, openProjectDeclarations, pickFolder,
  renameProject, setProjectSettings, state,
} from '../core/store.js'

/**
 * Everything you can do to a project as a project, rather than to the code in
 * it. Untrack and Move to Trash are asked in the app's one confirmation
 * dialog; Trash is the only place that touches somebody's source tree, so it
 * asks for the name typed back and goes to the Trash rather than being deleted.
 */

const p = computed(() => editingProject.value)

watch(p, (proj) => {
  if (proj) void loadDeclarations(proj.id)
})

const name = ref('')
const root = ref('')
const moveFiles = ref(true)
const busy = ref(false)
const nameInput = ref<HTMLInputElement | null>(null)
/** §15 — see the block below `nameChanged`. Declared up here because the watch
 *  that fills them runs immediately, and a ref read before its `const` is a
 *  blank dialog and a console nobody was looking at. */
const baseBranch = ref('')
const locked = ref<string[]>([])
const lockDraft = ref('')

watch(
  p,
  (proj, prev) => {
    // The same project re-sent while the sheet stepped into from here is on
    // top — writing `cockpit.yaml` does that — is not a reason to throw away
    // what was typed before stepping in.
    if (state.declareOpen && proj && proj.id === prev?.id) return
    name.value = proj?.name ?? ''
    root.value = proj?.root ?? ''
    baseBranch.value = proj?.settings.defaultBranch ?? ''
    locked.value = [...(proj?.settings.lockedBranches ?? [])]
    lockDraft.value = ''
    moveFiles.value = true
    if (proj) void nextTick(() => nameInput.value?.focus())
  },
  { immediate: true },
)

/* ── §15 — what this machine has been told about the project ─────────────
 *
 * Both of these used to be decided for you. The base was whatever `origin/HEAD`
 * said, and the default branch was refused a commit outright — §16's rule for
 * agents, applied to the person using the app. The first is right nearly always
 * and now has an escape hatch; the second was a guess about how people work,
 * and plenty of repositories are committed to directly by whoever owns them.
 *
 * So locking is opt-in, per project, and empty until someone sets it.
 */
/** What git says, so the field can show it rather than describe it. */
const probedBase = computed(
  () => workspaces.value.find((w) => w.git?.base)?.git?.base ?? null,
)

function addLock(branch?: string) {
  const v = (branch ?? lockDraft.value).trim()
  if (!v || locked.value.includes(v)) {
    lockDraft.value = ''
    return
  }
  locked.value = [...locked.value, v]
  lockDraft.value = ''
}

function removeLock(branch: string) {
  locked.value = locked.value.filter((b) => b !== branch)
}

const settingsChanged = computed(() => {
  const s = p.value?.settings
  if (!s) return false
  return (
    (baseBranch.value.trim() || null) !== s.defaultBranch ||
    locked.value.join('\u0000') !== s.lockedBranches.join('\u0000')
  )
})

const nameChanged = computed(() => !!p.value && name.value.trim() !== p.value.name)
const rootChanged = computed(() => !!p.value && root.value.trim() !== p.value.root)
const dirty = computed(() => nameChanged.value || rootChanged.value || settingsChanged.value)

/** A project holds repositories and branches of them; the count is what makes
 *  the danger real. */
const workspaces = computed(() =>
  p.value ? state.workspaces.filter((w) => w.projectId === p.value!.id && w.kind !== 'group') : [],
)
const repoCount = computed(() => workspaces.value.filter((w) => w.kind !== 'worktree').length)
const branchCount = computed(() => workspaces.value.filter((w) => w.kind === 'worktree').length)
const running = computed(() => workspaces.value.filter((w) => w.runtime?.status === 'up'))

function close() {
  if (busy.value) return
  state.editingProjectId = null
}

/**
 * §8 — what the project declares, counted rather than listed.
 *
 * The list belongs to the editor; this line exists so the section says
 * something true before it is opened, including when the answer is nothing.
 */
const declaredSummary = computed(() => {
  // This project's answer only: the one in the store may be the active
  // project's, and a double-click on the rail opens any project's settings.
  const all = state.declarationsFor === p.value?.id ? (state.declarations?.declarations ?? []) : []
  if (!all.length) return 'Nothing declared yet.'
  const servers = all.filter((d) => d.kind === 'server').length
  const commands = all.length - servers
  const say = (n: number, one: string) => n + ' ' + (n === 1 ? one : one + 's')
  return [servers && say(servers, 'server'), commands && say(commands, 'command')]
    .filter(Boolean)
    .join(', ')
})

/**
 * One sheet at a time, but this one is stepped *into*: it stays mounted
 * beneath, hidden, so the way back finds it as it was left — typed name and
 * all — and the sheet leads with that way back.
 */
function editDeclarations(): void {
  if (p.value) openProjectDeclarations(p.value.id)
}

// Back from the sheet: the dialog is drawn again, and focus goes with it so
// Escape still has somewhere to land.
watch(
  () => state.declareOpen,
  (open) => {
    if (!open && p.value) void nextTick(() => nameInput.value?.focus())
  },
)

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
    if (settingsChanged.value) {
      // Before the move: moving rebuilds the project under a new id derived
      // from its path, and settings are keyed by the path they were saved at.
      if (
        !(await setProjectSettings(proj.id, {
          defaultBranch: baseBranch.value.trim() || null,
          lockedBranches: [...locked.value],
        }))
      ) {
        return
      }
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

</script>

<template>
  <DialogShell
    v-if="p && !(state.declareOpen && state.declareFromProject)"
    :title="p.name"
    :dismissible="!busy"
    @close="close"
  >
    <template #head>
      <span class="count num">
        {{ repoCount }} {{ repoCount === 1 ? 'repository' : 'repositories' }}
        <template v-if="branchCount">
          · {{ branchCount }} {{ branchCount === 1 ? 'branch' : 'branches' }}
        </template>
      </span>
    </template>

    <div class="form">
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
        <span class="help">Only on this machine. Empty uses the {{ p.manifestPath ? 'manifest' : 'folder' }} name.</span>
      </label>

      <div class="field">
        <span class="lbl">Location</span>
        <div class="row">
          <input v-model="root" class="input mono" type="text" spellcheck="false" />
          <button class="btn" title="Choose a folder" @click="browse">
            <FolderOpen />Browse
          </button>
        </div>
        <label v-if="rootChanged" class="check">
          <input v-model="moveFiles" type="checkbox" />
          <span>Move the folder there too</span>
        </label>
        <!-- §16 — a move pulls the ground out from under anything still running. -->
        <p v-if="rootChanged && running.length" class="note warn">
          <TriangleAlert class="sm" />
          Stop the {{ running.length === 1 ? 'server' : running.length + ' servers' }} still up first.
        </p>
      </div>

      <!-- §8 — what this project runs, written into cockpit.yaml. The only
           place a project with nothing declared yet gets its first server. -->
      <div class="field">
        <span class="lbl">Commands &amp; servers</span>
        <div class="row">
          <span class="summary grow">{{ declaredSummary }}</span>
          <button class="btn" @click="editDeclarations">
            <SlidersHorizontal />Manage
          </button>
        </div>
      </div>

      <label class="field">
        <span class="lbl">Base branch</span>
        <input
          v-model="baseBranch"
          class="input mono"
          type="text"
          spellcheck="false"
          :placeholder="probedBase ? probedBase + ' (from git)' : 'from git'"
        />
        <span class="help">What topics fork from and Send lands on. Empty asks git.</span>
      </label>

      <!-- §16 — the rule that used to be hardcoded, handed back. -->
      <div class="field">
        <span class="lbl">Locked branches</span>
        <div v-if="locked.length" class="chips">
          <button
            v-for="b in locked"
            :key="b"
            class="chip lockchip mono"
            title="Unlock this branch"
            @click="removeLock(b)"
          >
            <Lock class="sm" />{{ b }}<X class="sm x" />
          </button>
        </div>
        <div class="row">
          <input
            v-model="lockDraft"
            class="input mono"
            type="text"
            spellcheck="false"
            placeholder="main, or release/*"
            @keydown.enter.prevent="addLock()"
          />
          <button class="btn" :disabled="!lockDraft.trim()" @click="addLock()">
            <Plus />Lock
          </button>
        </div>
        <span class="help">
          Cockpit won't commit on these.
          <button
            v-if="probedBase && !locked.includes(probedBase)"
            class="linkish"
            @click="addLock(probedBase)"
          >
            Lock {{ probedBase }}
          </button>
        </span>
      </div>

      <!-- tokens.css: colour is for meaning. The ground stays neutral; the red
           is spent on the label and the one button that earns it. -->
      <section class="zone">
        <span class="section-label">Danger zone</span>

        <div class="drow">
          <div class="dtext">
            <strong>Untrack</strong>
            <span>Cockpit forgets it. Files stay put.</span>
          </div>
          <button class="btn" :disabled="busy" @click="askUntrackProject(p.id)">Untrack</button>
        </div>

        <div class="drow">
          <div class="dtext">
            <strong>Move to Trash</strong>
            <span>Recoverable from the system Trash.</span>
          </div>
          <button class="btn danger" :disabled="busy" @click="askTrashProject(p.id)">
            <Trash2 />Move to Trash
          </button>
        </div>
      </section>
    </div>

    <template #foot>
      <span class="grow" />
      <button class="btn ghost" :disabled="busy" @click="close">Close</button>
      <button class="btn primary" :disabled="busy || !dirty" @click="save">
        {{ busy ? 'Working…' : 'Save' }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
.count { font-size: var(--fs-xs); color: var(--text-dim); white-space: nowrap; }
.grow { flex: 1; }

.form { display: flex; flex-direction: column; gap: 20px; padding-bottom: 14px; }
.field { display: flex; flex-direction: column; gap: 7px; }
.lbl {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.help { font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.5; }
.summary { font-size: var(--fs-sm); color: var(--text-muted); }

/* A locked branch is one short token and a way to take it back off. */
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.lockchip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-xs);
}
.lockchip .lucide { width: 11px; height: 11px; }
.lockchip .x { opacity: 0.55; }
.lockchip:hover .x { opacity: 1; }

/* A sentence that ends in an action, rather than a button sitting under one. */
.linkish {
  margin-left: 4px;
  color: var(--accent);
  font-size: var(--fs-xs);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.row { display: flex; align-items: center; gap: 8px; }
.row .input { flex: 1; min-width: 0; }
.row .btn { flex: none; }

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}

.note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  font-size: var(--fs-xs);
  line-height: 1.5;
}
.note .lucide { flex: none; margin-top: 2px; }
.note.warn { color: var(--warn); }

/* Named `zone`, not `danger`: scoped styles reach every element in this
   component, and `.danger` also matched the red buttons inside it. */
.zone {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 4px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.zone > .section-label { color: var(--danger); }
.drow { display: flex; align-items: center; gap: 16px; }
.drow > .btn { flex: none; }
.dtext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dtext strong { font-size: var(--fs-sm); font-weight: 600; }
.dtext span { font-size: var(--fs-xs); color: var(--text-dim); }
</style>
