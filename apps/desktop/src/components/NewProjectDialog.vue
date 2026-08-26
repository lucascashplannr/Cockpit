<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { FolderGit2, FolderOpen, FolderPlus, TriangleAlert, X } from '@lucide/vue'
import type { FolderInfo, NewProjectSource } from '@cockpit/shared'
import { folderSafe, parseRemote } from '@cockpit/shared'
import NewProjectSources from './NewProjectSources.vue'
import { client, createProject, devRoot, pickFolder, state } from '../core/store.js'

/**
 * §7 — where a project comes from. Three answers, one layout:
 *
 *     <Dev>/<Project>/<repo>/.git
 *
 * and never `<Dev>/<Project>/.git`. The project folder is kept free of any
 * repository so a second one is a folder added beside the first rather than a
 * migration, so the manifest and the shared memory have somewhere to live (§7),
 * and so an agent pointed at the project reaches every repository at once.
 *
 * The sheet's job is to make that layout visible before it exists: the tree at
 * the bottom is the folders that will be on disk, not an illustration.
 */

type Mode = NewProjectSource['kind']

const mode = ref<Mode>('scratch')
const name = ref('')
const parent = ref('')
const busy = ref(false)
const nameInput = ref<HTMLInputElement | null>(null)

/* scratch */
const initRepo = ref(true)
/* folder */
const folder = ref('')
const wrap = ref(true)
/* clone */
const url = ref('')
const branch = ref('')

/** The repo folder's name, once someone has typed one of their own. */
const repoName = ref('')
const repoTouched = ref(false)
const nameTouched = ref(false)

const remote = computed(() => (mode.value === 'clone' ? parseRemote(url.value) : null))

/* ── what the core says is on disk ───────────────────────────────────────
 * §13 rule 1 — the window has no filesystem. It asks about the two paths it
 * is about to use, and asks again whenever they change.
 */
const rootInfo = ref<FolderInfo | null>(null)
const folderInfo = ref<FolderInfo | null>(null)

let seq = 0
async function inspect(path: string): Promise<FolderInfo | null> {
  if (!path.trim()) return null
  const mine = ++seq
  try {
    const info = await client.call('project.inspect', { path })
    // A slower answer to an older question must not overwrite a newer one.
    return mine === seq ? info : null
  } catch {
    return null
  }
}

/* ── the layout, computed the way the core computes it ───────────────── */

const folderName = computed(() => folderSafe(name.value))
const root = computed(() =>
  parent.value.trim() && folderName.value
    ? parent.value.trim().replace(/\/+$/, '') + '/' + folderName.value
    : '',
)

/** What the repository folder is called, before anyone overrides it. */
const defaultRepoName = computed(() => {
  if (mode.value === 'clone') return remote.value?.repo ?? ''
  if (mode.value === 'folder') return folder.value.split('/').filter(Boolean).pop() ?? ''
  return folderName.value
})
const repoFolder = computed(() =>
  folderSafe(repoTouched.value && repoName.value ? repoName.value : defaultRepoName.value),
)

/** Registering a folder as it stands creates nothing and moves nothing. */
const registering = computed(() => mode.value === 'folder' && !wrap.value)

/** A worktree belongs to the repository that made it and cannot move alone. */
const wrappable = computed(() => !!folderInfo.value?.isRepo && !folderInfo.value.isWorktree)

const rootTaken = computed(
  () => !registering.value && !!rootInfo.value?.exists && !rootInfo.value.empty,
)
const alreadyRegistered = computed(() => !!folderInfo.value?.projectId)

const problem = computed<string | null>(() => {
  if (!name.value.trim()) return null
  if (!registering.value && !folderName.value) {
    return '“' + name.value + '” leaves nothing usable as a folder name.'
  }
  if (rootTaken.value) return root.value + ' already exists and is not empty.'
  if (mode.value === 'clone' && url.value.trim() && !remote.value) {
    return 'That is not a repository URL. Try owner/repo, an https URL, or an SSH remote.'
  }
  if (registering.value && alreadyRegistered.value) return 'That folder is already a project.'
  if (registering.value && folderInfo.value && !folderInfo.value.exists) {
    return 'No folder at ' + folder.value + '.'
  }
  return null
})

const canCreate = computed(() => {
  if (busy.value || problem.value || !name.value.trim()) return false
  if (mode.value === 'clone') return !!remote.value
  if (mode.value === 'folder') return !!folder.value.trim()
  return !!folderName.value
})

/* ── the tree, which is the actual explanation ───────────────────────── */

interface Row {
  depth: number
  label: string
  note?: string
  kind: 'parent' | 'project' | 'repo' | 'file'
}

const tree = computed<Row[]>(() => {
  if (registering.value) {
    const base = folder.value.split('/').filter(Boolean).pop() ?? folder.value
    const rows: Row[] = [{ depth: 0, label: base + '/', note: 'watched where it is', kind: 'project' }]
    for (const r of folderInfo.value?.childRepos ?? []) {
      rows.push({ depth: 1, label: r + '/', kind: 'repo' })
    }
    if (!rows[1] && folderInfo.value?.isRepo) {
      rows.push({ depth: 1, label: '.git', note: 'a repository at the root — it can never gain a second', kind: 'file' })
    }
    return rows
  }

  const parentName = parent.value.trim().split('/').filter(Boolean).pop() ?? '/'
  const rows: Row[] = [
    { depth: 0, label: parentName + '/', kind: 'parent' },
    { depth: 1, label: (folderName.value || 'Project') + '/', note: 'the project — no repository here', kind: 'project' },
    { depth: 2, label: 'cockpit.yaml', note: 'names it; the repo list stays open', kind: 'file' },
  ]
  if (mode.value === 'clone') {
    rows.push({ depth: 2, label: (repoFolder.value || 'repo') + '/', note: 'the clone lands here', kind: 'repo' })
  } else if (mode.value === 'folder') {
    rows.push({ depth: 2, label: (repoFolder.value || 'repo') + '/', note: 'the folder moves here', kind: 'repo' })
  } else if (initRepo.value) {
    rows.push({ depth: 2, label: (repoFolder.value || 'repo') + '/', note: 'git init, one commit', kind: 'repo' })
  }
  return rows
})

/* ── the small courtesies ────────────────────────────────────────────── */

// A URL carries the name of what it points at; typing it twice is a click the
// budget in §12 does not have. Anything typed by hand wins for good.
watch(remote, (r) => {
  if (r && !nameTouched.value) name.value = r.repo
})

watch(folder, (f) => {
  if (!f) {
    folderInfo.value = null
    return
  }
  void inspect(f).then((info) => {
    if (!info) return
    folderInfo.value = info
    // Wrapping is for the shape the layout rules out; a folder that already
    // holds its repositories one level down is registered as it stands.
    wrap.value = info.isRepo && !info.isWorktree
    if (!nameTouched.value) name.value = f.split('/').filter(Boolean).pop() ?? ''
  })
})

watch([root, registering], () => {
  if (registering.value || !root.value) {
    rootInfo.value = null
    return
  }
  void inspect(root.value).then((info) => {
    if (info) rootInfo.value = info
  })
})

watch(
  () => state.newProjectOpen,
  (open) => {
    if (!open) return
    // The card clicked on the start page is the card lit here (§12: the first
    // click already said something, and repeating it would be a click wasted).
    mode.value = state.newProjectMode
    name.value = ''
    parent.value = devRoot.value
    initRepo.value = true
    folder.value = ''
    wrap.value = true
    url.value = ''
    branch.value = ''
    repoName.value = ''
    repoTouched.value = false
    nameTouched.value = false
    rootInfo.value = null
    folderInfo.value = null
    busy.value = false
    void nextTick(() => nameInput.value?.focus())
  },
)

async function browseParent() {
  const picked = await pickFolder({
    title: 'Where projects live',
    message: 'Pick the folder that holds one folder per project',
    buttonLabel: 'Use this folder',
    ...(parent.value ? { defaultPath: parent.value } : {}),
  })
  if (picked) parent.value = picked
}

async function browseFolder() {
  const picked = await pickFolder({
    title: 'Add a project',
    message: 'Pick the folder Cockpit should watch',
    buttonLabel: 'Choose',
    ...(devRoot.value ? { defaultPath: devRoot.value } : {}),
  })
  if (picked) folder.value = picked
}

function close() {
  if (!busy.value) state.newProjectOpen = false
}

function sourceOf(): NewProjectSource {
  const repo = repoFolder.value || null
  if (mode.value === 'clone') {
    return {
      kind: 'clone',
      url: url.value.trim(),
      repoName: repo,
      branch: branch.value.trim() || null,
    }
  }
  if (mode.value === 'folder') {
    return { kind: 'folder', folder: folder.value.trim(), wrap: wrap.value, repoName: repo }
  }
  return { kind: 'scratch', repoName: initRepo.value ? repo : null }
}

async function submit() {
  if (!canCreate.value) return
  busy.value = true
  await createProject({
    name: name.value.trim(),
    // Registering a folder ignores the parent, but the core still wants a
    // string; the folder itself is the honest answer.
    parent: registering.value ? folder.value.trim() : parent.value.trim(),
    source: sourceOf(),
  })
  busy.value = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}
</script>

<template>
  <div v-if="state.newProjectOpen" class="scrim" @mousedown.self="close" @keydown="onKey">
    <div class="dlg" role="dialog" aria-label="New project">
      <header class="head">
        <FolderPlus class="sm gi" />
        <h2>New project</h2>
        <span class="grow" />
        <button class="icon-btn" title="Close (esc)" @click="close"><X class="sm" /></button>
      </header>

      <div class="body">
        <NewProjectSources :selected="mode" @pick="mode = $event" />

        <!-- ── source-specific: the one question each mode actually asks ── -->

        <label v-if="mode === 'clone'" class="field">
          <span class="lbl">Repository</span>
          <input
            v-model="url"
            class="input mono"
            spellcheck="false"
            autocomplete="off"
            placeholder="owner/repo · https://github.com/owner/repo · git@github.com:owner/repo.git"
            @keydown.enter="submit"
          />
          <span v-if="remote" class="hint">
            <FolderGit2 class="sm" />
            <code class="mono">{{ remote.owner ? remote.owner + '/' : '' }}{{ remote.repo }}</code>
            <span>on {{ remote.host }}</span>
          </span>
          <span v-else class="help">
            Cloned into the project folder, never over it. Private repositories use the
            credentials this machine already has.
          </span>
        </label>

        <div v-else-if="mode === 'folder'" class="field">
          <span class="lbl">Folder</span>
          <div class="row">
            <input
              v-model="folder"
              class="input mono"
              spellcheck="false"
              placeholder="/Users/you/somewhere/a-repo"
            />
            <button class="btn" @click="browseFolder"><FolderOpen />Browse</button>
          </div>

          <!-- The choice only exists for the shape the layout rules out. -->
          <div v-if="folderInfo?.isRepo" class="choice">
            <label class="opt" :class="{ on: wrap }">
              <input v-model="wrap" type="radio" :value="true" :disabled="!wrappable" />
              <span class="otext">
                <strong>Give it a project folder</strong>
                <span>
                  Creates <code class="mono">{{ folderName || 'Project' }}/</code> and moves this
                  repository inside it, so a second one has somewhere to go.
                </span>
              </span>
            </label>
            <label class="opt" :class="{ on: !wrap }">
              <input v-model="wrap" type="radio" :value="false" />
              <span class="otext">
                <strong>Register it as it is</strong>
                <span>
                  Nothing moves. The repository stays at the project root, where a second one
                  can never join it.
                </span>
              </span>
            </label>
          </div>

          <p v-else-if="folderInfo?.exists" class="note">
            <template v-if="folderInfo.childRepos.length">
              Already the right shape — {{ folderInfo.childRepos.length }}
              {{ folderInfo.childRepos.length === 1 ? 'repository' : 'repositories' }} one level
              down. It is registered where it stands.
            </template>
            <template v-else>
              No repository in there yet. It is registered where it stands, and anything cloned
              into it later is picked up on its own.
            </template>
          </p>

          <p v-if="folderInfo?.isWorktree" class="note warn">
            <TriangleAlert class="sm" />
            This is a git worktree. It belongs to the repository that created it, so it cannot be
            moved out on its own — register it as it is, or add the repository that owns it.
          </p>
        </div>

        <label v-else class="check big">
          <input v-model="initRepo" type="checkbox" />
          <span class="otext">
            <strong>Start a repository inside it</strong>
            <span>
              <code class="mono">git init</code> in
              <code class="mono">{{ repoFolder || 'repo' }}/</code>, with one commit so it has a
              branch to fork. Leave it off to create the project folder alone.
            </span>
          </span>
        </label>

        <!-- ── name, place, repo folder ───────────────────────────────── -->

        <div class="pair">
          <label class="field">
            <span class="lbl">Project name</span>
            <input
              ref="nameInput"
              v-model="name"
              class="input"
              spellcheck="false"
              placeholder="Cashplannr"
              @input="nameTouched = true"
              @keydown.enter="submit"
            />
          </label>

          <label v-if="!registering && (mode !== 'scratch' || initRepo)" class="field">
            <span class="lbl">Repository folder</span>
            <input
              v-model="repoName"
              class="input mono"
              spellcheck="false"
              :placeholder="defaultRepoName || 'repo'"
              @input="repoTouched = true"
            />
          </label>
        </div>

        <label v-if="!registering" class="field">
          <span class="lbl">Dev folder</span>
          <div class="row">
            <input v-model="parent" class="input mono" spellcheck="false" placeholder="/Users/you/Dev" />
            <button class="btn" @click="browseParent"><FolderOpen />Browse</button>
          </div>
          <span class="help">
            One folder per project lives here.
            <template v-if="!state.settings?.devRoot">Chosen once — it becomes the default.</template>
          </span>
        </label>

        <label v-if="mode === 'clone'" class="field">
          <span class="lbl">Branch <span class="dim">optional</span></span>
          <input
            v-model="branch"
            class="input mono"
            spellcheck="false"
            placeholder="the repository's default branch"
          />
        </label>

        <!-- ── the layout, before it exists ───────────────────────────── -->

        <div class="field">
          <span class="lbl">On disk</span>
          <div class="tree mono">
            <div v-for="(r, i) in tree" :key="i" class="trow" :class="r.kind">
              <span class="tlabel" :style="{ paddingLeft: r.depth * 16 + 'px' }">{{ r.label }}</span>
              <span v-if="r.note" class="tnote">{{ r.note }}</span>
            </div>
          </div>
          <span v-if="!registering" class="help">
            The project folder holds no repository of its own — that is what lets a second one
            join it later, and what an agent is pointed at to reach all of them at once.
          </span>
        </div>

        <p v-if="problem" class="note bad">
          <TriangleAlert class="sm" />{{ problem }}
        </p>
      </div>

      <footer class="foot">
        <span class="rp">
          <template v-if="mode === 'clone'">Nothing is kept if the clone fails.</template>
          <template v-else-if="registering">Nothing is created or moved.</template>
        </span>
        <span class="grow" />
        <button class="btn ghost" :disabled="busy" @click="close">Cancel</button>
        <button class="btn primary" :disabled="!canCreate" @click="submit">
          {{ busy ? (mode === 'clone' ? 'Cloning…' : 'Creating…') : registering ? 'Add it' : 'Create' }}
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
  width: min(620px, 94vw);
  max-height: 88vh;
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
  gap: 9px;
  padding: 16px 14px 14px 20px;
  border-bottom: 1px solid var(--line);
}
.head h2 { margin: 0; font-size: var(--fs-lg); font-weight: 640; letter-spacing: -0.01em; }
.gi { color: var(--text-dim); }
.grow { flex: 1; }

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px 6px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* ── fields ──────────────────────────────────────────────────────────── */
.field { display: flex; flex-direction: column; gap: 7px; }
.pair { display: flex; gap: 12px; }
.pair > .field { flex: 1; min-width: 0; }
.lbl {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.lbl .dim { font-weight: 500; letter-spacing: 0; text-transform: none; opacity: 0.7; }
.help { font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.55; }
.row { display: flex; align-items: center; gap: 8px; }
.row .input { flex: 1; min-width: 0; }
.row .btn { flex: none; }
.hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.hint code { color: var(--accent); }

/* ── the wrap choice, and the scratch checkbox ───────────────────────── */
.choice { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
.opt,
.check.big {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  transition: border-color var(--dur-1) var(--ease-soft), background var(--dur-1) var(--ease-soft);
}
.opt input,
.check.big input { margin-top: 2px; accent-color: var(--accent); flex: none; }
.opt.on { border-color: var(--accent); background: var(--accent-soft); }
.otext { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.otext strong { font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.otext > span { font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.55; }
.otext code { color: var(--text); }

.note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.6;
}
.note .lucide { margin-top: 2px; flex: none; }
.note.warn { color: var(--warn); }
.note.bad { color: var(--danger); }

/* ── the tree ────────────────────────────────────────────────────────── */
.tree {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 11px 13px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  font-size: var(--fs-xs);
  overflow-x: auto;
}
.trow { display: flex; align-items: baseline; gap: 12px; }
.tlabel { white-space: nowrap; }
.tnote {
  flex: 1;
  min-width: 0;
  font-family: var(--font);
  color: var(--text-dim);
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trow.parent .tlabel { color: var(--text-dim); }
.trow.project .tlabel { color: var(--text); font-weight: 600; }
.trow.repo .tlabel { color: var(--accent); }
.trow.file .tlabel { color: var(--text-muted); }

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
.rp { font-size: var(--fs-xs); color: var(--text-dim); }
</style>
