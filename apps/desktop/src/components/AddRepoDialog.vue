<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { FolderGit2, FolderOpen, FolderPlus, GitBranch, TriangleAlert, X } from '@lucide/vue'
import type { AddRepoSource, FolderInfo, NewProjectSource } from '@cockpit/shared'
import { folderSafe, parseRemote } from '@cockpit/shared'
import NewProjectSources from './NewProjectSources.vue'
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
    return base(folder.value) + ' is a git worktree — it belongs to the repository that created it and cannot be moved out on its own.'
  }
  if (!dir.value) return null
  if (needsWrap.value) {
    if (!wrappable.value) {
      return project.value.name + ' is a git worktree, so it cannot be moved down a level. Add the repository that owns it as a project instead.'
    }
    if (!wrapFolder.value) return 'The repository already there needs a folder name of its own.'
    if (wrapFolder.value === dir.value) {
      return 'Both would be called ' + dir.value + ' — pick another name for one of them.'
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
    { depth: 0, label: base(project.value.root) + '/', note: 'the project — no repository here', kind: 'project' },
  ]
  if (needsWrap.value) {
    rows.push({
      depth: 1,
      label: (wrapFolder.value || 'repo') + '/',
      note: 'what is at the root today, moved down',
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

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}
</script>

<template>
  <div v-if="project" class="scrim" @mousedown.self="close" @keydown="onKey">
    <div class="dlg" role="dialog" aria-label="Add a repository">
      <header class="head">
        <FolderGit2 class="sm gi" />
        <h2>Add a repository</h2>
        <span class="to">to {{ project.name }}</span>
        <span class="grow" />
        <button class="icon-btn" title="Close (esc)" @click="close"><X class="sm" /></button>
      </header>

      <div class="body">
        <NewProjectSources :selected="mode" of="repo" @pick="mode = $event" />

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
            Cloned into the project folder, beside the repositories already there. Private ones use
            the credentials this machine already has.
          </span>
        </label>

        <div v-else-if="mode === 'folder'" class="field">
          <span class="lbl">Folder</span>
          <div class="row">
            <input
              v-model="folder"
              class="input mono"
              spellcheck="false"
              placeholder="/Users/you/somewhere/api"
            />
            <button class="btn" @click="browseFolder"><FolderOpen />Browse</button>
          </div>
          <span v-if="folderInfo?.exists && !folderInfo.isRepo" class="help">
            Not a repository yet — <code class="mono">git init</code> runs on arrival, with one
            commit, so a topic has something to branch from.
          </span>
          <span v-else class="help">It moves into the project folder; nothing is copied.</span>
        </div>

        <!-- ── the layout's one hard case ─────────────────────────────── -->

        <div v-if="needsWrap" class="wrap-block">
          <p class="note warn">
            <TriangleAlert class="sm" />
            <span>
              <strong>{{ project.name }} is itself a repository.</strong>
              There is nowhere beside it for a second one, so it moves down a level first. Nothing
              is lost — the folder keeps its contents, its history and its branches, and every
              branch checked out elsewhere is repaired to point at where it went.
            </span>
          </p>
          <label class="field">
            <span class="lbl">It moves into</span>
            <input v-model="wrapAs" class="input mono" spellcheck="false" :placeholder="base(project.root)" />
            <span class="help">
              Stop the servers and any running conversation inside it first — a folder is not
              moved out from under something running in it.
            </span>
          </label>
        </div>

        <!-- ── the folder it lands in ─────────────────────────────────── -->

        <div class="pair">
          <label class="field">
            <span class="lbl">Repository folder</span>
            <input
              ref="nameInput"
              v-model="repoName"
              class="input mono"
              spellcheck="false"
              :placeholder="defaultRepoName || 'api'"
              @input="repoTouched = true"
              @keydown.enter="submit"
            />
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
        </div>

        <!-- ── the layout, before it exists ───────────────────────────── -->

        <div class="field">
          <span class="lbl">On disk</span>
          <div class="tree mono">
            <div v-for="(r, i) in tree" :key="i" class="trow" :class="r.kind">
              <span class="tlabel" :style="{ paddingLeft: r.depth * 16 + 'px' }">{{ r.label }}</span>
              <span v-if="r.note" class="tnote">{{ r.note }}</span>
            </div>
          </div>
          <span class="help">
            One folder per repository, one level down. An agent pointed at the project reaches all
            of them at once; one pointed at a folder reaches only that one.
          </span>
        </div>

        <p v-if="problem" class="note bad"><TriangleAlert class="sm" />{{ problem }}</p>
      </div>

      <footer class="foot">
        <span class="rp">
          <template v-if="mode === 'clone'">Nothing is kept if the clone fails.</template>
          <template v-else-if="needsWrap">
            <GitBranch class="sm" />If any step fails, the move is taken back.
          </template>
        </span>
        <span class="grow" />
        <button class="btn ghost" :disabled="busy" @click="close">Cancel</button>
        <button class="btn primary" :disabled="!canAdd" @click="submit">
          {{ busy ? (mode === 'clone' ? 'Cloning…' : 'Adding…') : 'Add' }}
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
  align-items: baseline;
  gap: 9px;
  padding: 16px 14px 14px 20px;
  border-bottom: 1px solid var(--line);
}
.head h2 { margin: 0; font-size: var(--fs-lg); font-weight: 640; letter-spacing: -0.01em; }
.head .gi { color: var(--text-dim); align-self: center; }
.to { font-size: var(--fs-xs); color: var(--text-dim); }
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
.help code { color: var(--text-muted); }
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
.wrap-block .note { align-items: flex-start; }
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
.note .lucide { margin-top: 2px; flex: none; }
.note.warn { color: var(--warn); }
.note.bad { color: var(--danger); }

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
.trow.project .tlabel { color: var(--text); font-weight: 600; }
.trow.repo .tlabel { color: var(--text-muted); }
.trow.new .tlabel { color: var(--accent); font-weight: 600; }
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
.rp { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--text-dim); }
</style>
