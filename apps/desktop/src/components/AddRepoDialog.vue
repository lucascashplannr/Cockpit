<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { CloudDownload, FolderGit2, FolderOpen, FolderPlus, TriangleAlert } from '@lucide/vue'
import type { AddRepoSource, FolderInfo, NewProjectSource } from '@cockpit/shared'
import { folderSafe, parseRemote } from '@cockpit/shared'
import DialogShell from './DialogShell.vue'
import { addRepo, addingRepoTo, client, pickFolder, state } from '../core/store.js'

/**
 * §7 — the second repository, and every one after it.
 *
 *     <Dev>/<Project>/web/     ← already there
 *     <Dev>/<Project>/api/     ← this
 *
 * The new-project sheet lays that layout down once; this is the half that
 * keeps it true afterwards, and it is the answer to "where does the backend
 * go" that is not "somewhere else on the disk, and Cockpit will never see it".
 *
 * One project cannot take a second repository as it stands: the one whose root
 * is itself a repository. That is not an error to report, it is a move to
 * offer — the repository already there goes down a level, which frees the root
 * for both of them. It moves nobody's checkout without being told to, so the
 * folder it moves into is a field rather than a default.
 */

type Mode = NewProjectSource['kind']

const project = computed(() => addingRepoTo.value)

const mode = ref<Mode>('scratch')
const busy = ref(false)
const nameInput = ref<HTMLInputElement | null>(null)

/** The folder the repository lands in, under the project root. */
const repoName = ref('')
const repoTouched = ref(false)
/* folder */
const folder = ref('')
/* clone */
const url = ref('')
const branch = ref('')
/** Where the repository at the project root moves, when there is one. */
const wrapAs = ref('')

const remote = computed(() => (mode.value === 'clone' ? parseRemote(url.value) : null))

/* ── what the core says is on disk ───────────────────────────────────────
 * §13 rule 1 — the window has no filesystem. It asks about the project root
 * and about the folder being adopted, and asks again whenever they change.
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

const base = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

const defaultRepoName = computed(() => {
  if (mode.value === 'clone') return remote.value?.repo ?? ''
  if (mode.value === 'folder') return folder.value ? base(folder.value) : ''
  return ''
})
const dir = computed(() =>
  folderSafe(repoTouched.value && repoName.value ? repoName.value : defaultRepoName.value),
)

/** §7 — a repository at the project root leaves no room beside it. */
const needsWrap = computed(() => !!rootInfo.value?.isRepo)
const wrapFolder = computed(() => folderSafe(wrapAs.value))
/** A worktree belongs to the repository that made it and cannot move alone. */
const wrappable = computed(() => !rootInfo.value?.isWorktree)

/** What is already one level down, so a name that is taken can be said so. */
const siblings = computed(() => rootInfo.value?.childRepos ?? [])

const problem = computed<string | null>(() => {
  if (!project.value) return null
  if (mode.value === 'clone' && url.value.trim() && !remote.value) {
    return 'That is not a repository URL. Try owner/repo, an https URL, or an SSH remote.'
  }
  if (mode.value === 'folder' && folderInfo.value && !folderInfo.value.exists) {
    return 'No folder at ' + folder.value + '.'
  }
  if (mode.value === 'folder' && folderInfo.value?.isWorktree) {
    return base(folder.value) + ' is a git worktree. It belongs to the repository that made it and cannot move on its own.'
  }
  if (!dir.value) return null
  if (needsWrap.value) {
    if (!wrappable.value) {
      return project.value.name + ' is a git worktree, so it cannot be moved down a level. Add the repository that owns it as a project instead.'
    }
    if (!wrapFolder.value) return 'The repository already there needs a folder name of its own.'
    if (wrapFolder.value === dir.value) {
      return 'Both would be called ' + dir.value + '. Pick another name for one of them.'
    }
  } else if (siblings.value.includes(dir.value)) {
    return project.value.name + ' already has a ' + dir.value + '/.'
  }
  return null
})

const canAdd = computed(() => {
  if (busy.value || problem.value || !project.value || !dir.value) return false
  if (mode.value === 'clone') return !!remote.value
  if (mode.value === 'folder') return !!folder.value.trim()
  return true
})

/* ── the tree, which is the actual explanation ───────────────────────── */

interface Row {
  depth: number
  label: string
  note?: string
  kind: 'project' | 'repo' | 'new' | 'file'
}

const tree = computed<Row[]>(() => {
  if (!project.value) return []
  const rows: Row[] = [
    { depth: 0, label: base(project.value.root) + '/', note: 'the project', kind: 'project' },
  ]
  if (needsWrap.value) {
    rows.push({
      depth: 1,
      label: (wrapFolder.value || 'repo') + '/',
      note: 'moved down from the root',
      kind: 'repo',
    })
  } else {
    for (const r of siblings.value) rows.push({ depth: 1, label: r + '/', kind: 'repo' })
  }
  rows.push({
    depth: 1,
    label: (dir.value || 'repo') + '/',
    note:
      mode.value === 'clone'
        ? 'the clone lands here'
        : mode.value === 'folder'
          ? 'the folder moves here'
          : 'git init, one commit',
    kind: 'new',
  })
  return rows
})

/* ── the small courtesies ────────────────────────────────────────────── */

watch(folder, (f) => {
  if (!f) {
    folderInfo.value = null
    return
  }
  void inspect(f).then((info) => {
    if (info) folderInfo.value = info
  })
})

watch(
  project,
  (p) => {
    if (!p) return
    mode.value = 'scratch'
    repoName.value = ''
    repoTouched.value = false
    folder.value = ''
    url.value = ''
    branch.value = ''
    // The repository at the root keeps its own name when it moves: it is the
    // one thing about this that should not change.
    wrapAs.value = base(p.root)
    folderInfo.value = null
    rootInfo.value = null
    busy.value = false
    void inspect(p.root).then((info) => {
      if (info) rootInfo.value = info
    })
    void nextTick(() => nameInput.value?.focus())
  },
  { immediate: true },
)

async function browseFolder() {
  const picked = await pickFolder({
    title: 'Add a repository',
    message: 'Pick the folder to move into ' + (project.value?.name ?? 'the project'),
    buttonLabel: 'Choose',
    ...(project.value ? { defaultPath: project.value.root } : {}),
  })
  if (picked) folder.value = picked
}

function close() {
  if (!busy.value) state.addRepoProjectId = null
}

function sourceOf(): AddRepoSource {
  if (mode.value === 'clone') {
    return { kind: 'clone', url: url.value.trim(), repoName: dir.value, branch: branch.value.trim() || null }
  }
  if (mode.value === 'folder') return { kind: 'folder', folder: folder.value.trim(), repoName: dir.value }
  return { kind: 'scratch', repoName: dir.value }
}

async function submit() {
  if (!canAdd.value || !project.value) return
  busy.value = true
  await addRepo({
    projectId: project.value.id,
    source: sourceOf(),
    wrapRootAs: needsWrap.value ? wrapFolder.value : null,
  })
  busy.value = false
}

/**
 * The three ways in, as Topic's "New branch / Existing branch": one segmented
 * choice, its meaning on hover. They were three cards with a sentence each,
 * which wrapped and said again what the tree below already shows.
 */
const MODES: { kind: Mode; label: string; icon: typeof FolderPlus; tip: string }[] = [
  { kind: 'scratch', label: 'New', icon: FolderPlus, tip: 'A new folder, git init, one commit' },
  { kind: 'folder', label: 'From this machine', icon: FolderOpen, tip: 'Move a folder already on this machine in' },
  { kind: 'clone', label: 'Clone', icon: CloudDownload, tip: 'Clone it in beside the others' },
]
</script>

<template>
  <DialogShell v-if="project" title="Add a repository" :dismissible="!busy" @close="close">
    <template #title>
      Add a repository <span class="to">to {{ project.name }}</span>
    </template>

    <div class="form">
      <div class="seg wide">
        <button v-for="m in MODES" :key="m.kind" :class="{ on: mode === m.kind }" :title="m.tip" @click="mode = m.kind">
          <component :is="m.icon" />{{ m.label }}
        </button>
      </div>

      <!-- The one question each way in asks first. -->
      <div v-if="mode === 'clone'" class="field">
        <label class="lbl" for="add-url" title="Private ones use the credentials this machine already has">Repository</label>
        <input
          id="add-url"
          v-model="url"
          class="input mono"
          spellcheck="false"
          autocomplete="off"
          placeholder="owner/repo, or any git URL"
          @keydown.enter="submit"
        />
        <span v-if="remote" class="hint">
          <FolderGit2 />
          <code class="mono">{{ remote.owner ? remote.owner + '/' : '' }}{{ remote.repo }}</code>
          <span>on {{ remote.host }}</span>
        </span>
      </div>

      <div v-else-if="mode === 'folder'" class="field">
        <span class="lbl" title="It moves into the project folder; nothing is copied">Folder</span>
        <div class="row">
          <input v-model="folder" class="input mono" spellcheck="false" placeholder="/Users/you/somewhere/api" />
          <button class="btn" @click="browseFolder"><FolderOpen />Browse</button>
        </div>
        <span v-if="folderInfo?.exists && !folderInfo.isRepo" class="hint">
          Not a repository yet: <code class="mono">git init</code> and one commit on arrival.
        </span>
      </div>

      <!-- The layout's one hard case. -->
      <div v-if="needsWrap" class="wrap-block">
        <p class="note warn">
          <TriangleAlert />
          <span>
            <strong>{{ project.name }} is itself a repository.</strong>
            It moves down a level first, with its history and branches.
          </span>
        </p>
        <div class="field">
          <label class="lbl" for="add-wrap" title="Stop its servers and conversations first: a folder is not moved out from under something running in it">It moves into</label>
          <input id="add-wrap" v-model="wrapAs" class="input mono" spellcheck="false" :placeholder="base(project.root)" />
        </div>
      </div>

      <div class="pair">
        <div class="field">
          <label class="lbl" for="add-name">Folder name</label>
          <input
            id="add-name"
            ref="nameInput"
            v-model="repoName"
            class="input hero mono"
            spellcheck="false"
            :placeholder="defaultRepoName || 'api'"
            @input="repoTouched = true"
            @keydown.enter="submit"
          />
        </div>
        <div v-if="mode === 'clone'" class="field">
          <label class="lbl" for="add-branch">Branch <span class="dim">optional</span></label>
          <input id="add-branch" v-model="branch" class="input hero mono" spellcheck="false" placeholder="default" />
        </div>
      </div>

      <!-- The layout, before it exists: the explanation is the picture. -->
      <div class="field">
        <span class="lbl" title="One folder per repository, one level down. An agent on the project reaches all of them; one on a folder reaches only that one.">On disk</span>
        <div class="tree mono">
          <div v-for="(r, i) in tree" :key="i" class="trow" :class="r.kind">
            <span class="tlabel" :style="{ paddingLeft: r.depth * 16 + 'px' }">{{ r.label }}</span>
            <span v-if="r.note" class="tnote">{{ r.note }}</span>
          </div>
        </div>
      </div>

      <p v-if="problem" class="note bad"><TriangleAlert />{{ problem }}</p>
    </div>

    <template #foot>
      <span class="grow" />
      <button class="btn ghost" :disabled="busy" @click="close">Cancel</button>
      <button
        class="btn primary"
        :disabled="!canAdd"
        :title="mode === 'clone' ? 'Nothing is kept if the clone fails' : needsWrap ? 'If any step fails, the move is taken back' : ''"
        @click="submit"
      >
        {{ busy ? (mode === 'clone' ? 'Cloning…' : 'Adding…') : 'Add' }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
/* TopicDialog's form, as ProjectDialog's and GroupDialog's are. */
.form { display: flex; flex-direction: column; gap: 20px; padding: 2px 0 16px; }
.field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.lbl { font-size: var(--fs-xs); color: var(--text-muted); }
.lbl .dim { margin-left: 4px; color: var(--text-dim); }
.lbl[for] { cursor: text; }
.input.hero { padding: 10px 12px; font-size: var(--fs-md); font-weight: 520; letter-spacing: -0.005em; }
.input.hero::placeholder { font-weight: 400; }
.to { font-size: var(--fs-sm); font-weight: 400; letter-spacing: 0; color: var(--text-dim); }
.grow { flex: 1; }

.seg.wide { display: flex; }
.seg.wide > button { flex: 1; justify-content: center; gap: 7px; height: 28px; font-size: var(--fs-sm); }
.seg.wide > button .lucide { width: 14px; height: 14px; }

.pair { display: flex; gap: 12px; }
.pair > .field { flex: 1; min-width: 0; }
.row { display: flex; align-items: center; gap: 8px; }
.row .input { flex: 1; min-width: 0; }
.row .btn { flex: none; }
.hint { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--text-dim); }
.hint .lucide { width: 13px; height: 13px; }
.hint code { color: var(--accent); }

/* The one case the layout cannot take as it stands, and its answer. */
.wrap-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 13px 13px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
}
.wrap-block strong { color: var(--text); font-weight: 620; }

.note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.6;
}
.note .lucide { width: 13px; height: 13px; margin-top: 3px; flex: none; }
.note.warn { color: var(--warn); }
.note.bad { color: var(--danger); }

/* The list's well, as in the Project and Group sheets. */
.tree {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 11px 13px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  font-size: var(--fs-sm);
  overflow-x: auto;
}
.trow { display: flex; align-items: baseline; gap: 12px; }
.tlabel { white-space: nowrap; }
.tnote {
  flex: 1;
  min-width: 0;
  font-family: var(--font);
  font-size: var(--fs-xs);
  color: var(--text-dim);
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trow.project .tlabel { color: var(--text); font-weight: 600; }
.trow.repo .tlabel { color: var(--text-muted); }
.trow.new .tlabel { color: var(--accent); font-weight: 600; }
.trow.file .tlabel { color: var(--text-muted); }
</style>
