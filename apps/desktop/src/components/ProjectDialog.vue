<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { FolderOpen, ImagePlus, Plus, ShieldCheck, ShieldPlus, SlidersHorizontal, Trash2, TriangleAlert, X } from '@lucide/vue'
import DialogShell from './DialogShell.vue'
import ProtectMenu from './ProtectMenu.vue'
import {
  addRepoTo, askTrashProject, askUntrackProject, askUntrackRepo, editingProject, loadDeclarations, moveProject, openProjectDeclarations, pickFolder,
  derivedRepoMark, monogram, refreshDocs, renameProject, setDocsHome, setProjectSettings, state, toast, trackRepo,
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
/** §16 — per repository, keyed by its name. */
const guarded = ref<Record<string, string[]>>({})
/** How the project and its repositories are drawn where their names have no room — see `ProjectSettings.mark`. */
const mark = ref('')
/** The rail's logo, which wins over the initials — see `ProjectSettings.logo`. */
const logo = ref<string | null>(null)
const repoMarks = ref<Record<string, string>>({})
/** §9 — the Docs home, as a folder: the core writes it as `{ repo, folder }`. */
const docsPath = ref('')
/** Stepped out to add a repository — see `addRepository`. Up here because the watch below runs at once. */
let addingRepo = false

watch(
  p,
  (proj, prev) => {
    // The same project re-sent while the sheet stepped into from here is on
    // top — writing `cockpit.yaml` does that — is not a reason to throw away
    // what was typed before stepping in.
    if ((state.declareOpen || addingRepo) && proj && proj.id === prev?.id) return
    addingRepo = false
    name.value = proj?.name ?? ''
    root.value = proj?.root ?? ''
    baseBranch.value = proj?.settings.defaultBranch ?? ''
    mark.value = proj?.settings.mark ?? ''
    logo.value = proj?.settings.logo ?? null
    repoMarks.value = Object.fromEntries(
      Object.entries(proj?.settings.repoMarks ?? {}).map(([k, v]) => [k, v.toLowerCase()]),
    )
    docsPath.value = linkedDocs(proj?.id)
    guarded.value = Object.fromEntries(
      Object.entries(proj?.settings.protectedBranches ?? {}).map(([k, v]) => [k, [...v]]),
    )
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
 * So protection is opt-in and per repository: a project of an API on `main`
 * and a front on `dev` has a different branch to guard in each.
 */
/** What git says, so the field can show it rather than describe it. */
const probedBase = computed(
  () => workspaces.value.find((w) => w.git?.base)?.git?.base ?? null,
)

/** The repositories themselves — a topic's branch of one answers to its list. */
const repos = computed(() => workspaces.value.filter((w) => w.kind === 'main' && w.repo))

function protect(repo: string, branch: string) {
  const v = branch.trim()
  const list = guarded.value[repo] ?? []
  if (!v || list.includes(v)) return
  guarded.value = { ...guarded.value, [repo]: [...list, v] }
}


function unprotect(repo: string, branch: string) {
  guarded.value = { ...guarded.value, [repo]: (guarded.value[repo] ?? []).filter((b) => b !== branch) }
}

/** Order- and empty-insensitive, so adding and removing the same one is not a change. */
const normal = (m: Record<string, string[]>) =>
  JSON.stringify(Object.entries(m).filter(([, v]) => v.length).sort(([a], [b]) => a.localeCompare(b)))

const settingsChanged = computed(() => {
  const s = p.value?.settings
  if (!s) return false
  return (
    (baseBranch.value.trim() || null) !== s.defaultBranch ||
    normal(guarded.value) !== normal(s.protectedBranches ?? {}) ||
    (mark.value.trim() || null) !== (s.mark ?? null) ||
    logo.value !== (s.logo ?? null) ||
    marksKey(repoMarks.value) !== marksKey(s.repoMarks ?? {})
  )
})

const marksKey = (m: Record<string, string>) =>
  JSON.stringify(Object.entries(m).map(([k, v]) => [k, v.trim().toLowerCase()]).filter(([, v]) => v).sort(([a], [b]) => a!.localeCompare(b!)))

/** The letters a repository gets when none are set — the field's placeholder. */
const derivedMark = (r: (typeof repos.value)[number]) => derivedRepoMark(r, repos.value)

/**
 * A logo, scaled to a tile's size here rather than stored as picked: the
 * settings travel to the window with every project update, and a 2 MB photo
 * would ride along each time. Read as a `data:` URL because that is what the
 * window's content policy lets an `<img>` show; a `blob:` URL is refused.
 */
const logoInput = ref<HTMLInputElement | null>(null)
/** An image held over the tile. */
const dropping = ref(false)
/** What the tile says without a logo: the initials as typed, or the ones they default to. */
const tileMark = computed(() => mark.value.trim() || monogram(name.value.trim() || p.value?.name || ''))

function pickLogo(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void readLogo(file)
}
function dropLogo(e: DragEvent) {
  dropping.value = false
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'))
  if (file) void readLogo(file)
}
async function readLogo(file: File) {
  try {
    const src = await new Promise<string>((ok, fail) => {
      const r = new FileReader()
      r.onload = () => ok(String(r.result))
      r.onerror = () => fail(r.error)
      r.readAsDataURL(file)
    })
    const img = new Image()
    img.src = src
    await img.decode()
    const size = 96
    const c = document.createElement('canvas')
    c.width = c.height = size
    const ctx = c.getContext('2d')!
    const w = img.naturalWidth
    const h = img.naturalHeight
    // Cropped to its middle square; an SVG with no size of its own is drawn whole.
    if (w && h) {
      const side = Math.min(w, h)
      ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size)
    } else {
      ctx.drawImage(img, 0, 0, size, size)
    }
    logo.value = c.toDataURL('image/png')
  } catch {
    toast('error', 'Could not read that image', { lines: [file.name] })
  }
}

/** The folder the docs are linked to on purpose — found ones are a placeholder. */
function linkedDocs(projectId: string | undefined): string {
  const info = projectId ? state.docsInfo[projectId] : null
  return info && info.source !== 'detected' ? info.path : ''
}
// The docs are fetched per project, and a sheet opened on another one than the
// active project gets its answer after it opened: the field follows it until
// something is typed into it.
watch(
  () => (p.value ? linkedDocs(p.value.id) : ''),
  (now, was) => {
    if (docsPath.value.trim() === (was ?? '')) docsPath.value = now
  },
)
watch(p, (proj) => {
  if (proj && !(proj.id in state.docsInfo)) void refreshDocs(proj.id)
}, { immediate: true })
const docsChanged = computed(() => !!p.value && docsPath.value.trim() !== linkedDocs(p.value.id))

const nameChanged = computed(() => !!p.value && name.value.trim() !== p.value.name)
const rootChanged = computed(() => !!p.value && root.value.trim() !== p.value.root)
const dirty = computed(() => nameChanged.value || rootChanged.value || settingsChanged.value || docsChanged.value)

/** A project holds repositories and branches of them; the count is what makes
 *  the danger real. */
const workspaces = computed(() =>
  p.value ? state.workspaces.filter((w) => w.projectId === p.value!.id && w.kind !== 'group') : [],
)
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

/**
 * §7 — a repository joining the project, from the place that says what the
 * project is. It was a button at the foot of the list, and before that in the
 * list's header: both put a thing you do once a month among the things you do
 * all day.
 *
 * Its own sheet opens in this one's place and hands back to it, the way the
 * commands sheet does. The flag is for the hand-back: adding a repository
 * re-sends this same project, and that must not throw away a name or a path
 * typed here before stepping out.
 */
function addRepository(): void {
  if (!p.value) return
  addingRepo = true
  addRepoTo(p.value.id)
}
const steppedIntoAddRepo = computed(() => !!p.value && state.addRepoProjectId === p.value.id)
/** The project's own folder, when it is the repository: untracking that is untracking the project. */
const isRoot = (path: string) => path === p.value?.root
const untracked = computed(() => p.value?.settings.untrackedRepos ?? [])

// Back from the sheet: the dialog is drawn again, and focus goes with it so
// Escape still has somewhere to land.
watch(
  () => state.declareOpen || steppedIntoAddRepo.value,
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
          protectedBranches: guarded.value,
          mark: mark.value.trim() || null,
          logo: logo.value,
          repoMarks: Object.fromEntries(
            Object.entries(repoMarks.value).map(([k, v]) => [k, v.trim().toLowerCase()]).filter(([, v]) => v),
          ),
        }))
      ) {
        return
      }
    }
    if (docsChanged.value) {
      if (!(await setDocsHome(proj.id, docsPath.value.trim() || null))) return
    }
    if (rootChanged.value) {
      if (!(await moveProject(proj.id, root.value.trim(), moveFiles.value))) return
    }
  } finally {
    busy.value = false
  }
}

/** A `docs/` folder found at the root, used until something else is said. */
const docsFallback = computed(() => {
  const info = p.value ? state.docsInfo[p.value.id] : null
  return info && info.source === 'detected' ? info : null
})
/** Where the link is kept, said on hover rather than under the field. */
const docsWhere = computed(() => {
  const info = p.value ? state.docsInfo[p.value.id] : null
  if (!info || info.source === 'detected') return 'A folder of one of the repositories is saved in cockpit.yaml'
  if (info.source === 'manifest' && info.repo) {
    return 'cockpit.yaml — docs: { repo: ' + info.repo + (info.folder ? ', folder: ' + info.folder : '') + ' }'
  }
  return info.source === 'settings' ? 'Saved on this machine only' : 'cockpit.yaml'
})

async function browseDocs() {
  const picked = await pickFolder({
    title: 'Documentation for ' + (p.value?.name ?? 'the project'),
    message: 'A folder inside one of its repositories, or a repository of its own',
    buttonLabel: 'Use this folder',
    defaultPath: docsPath.value || p.value?.root || '',
  })
  if (picked) docsPath.value = picked
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
    v-if="p && !(state.declareOpen && state.declareFromProject) && !steppedIntoAddRepo"
    :title="p.name"
    :dismissible="!busy"
    @close="close"
  >
    <div class="form">
      <!-- Who the project is: the tile as the rail will draw it, then its name
           and its initials. The tile is the logo's control, the way an avatar
           is: click it or drop an image on it. -->
      <div class="ident">
        <span class="tilewrap">
          <button
            class="tile"
            :class="{ drop: dropping }"
            :title="logo ? 'Change the logo' : 'Add a logo'"
            @click="logoInput?.click()"
            @dragover.prevent="dropping = true"
            @dragleave="dropping = false"
            @drop.prevent="dropLogo"
          >
            <img v-if="logo" :src="logo" alt="" />
            <span v-else class="gram">{{ tileMark }}</span>
            <span class="over"><ImagePlus /></span>
          </button>
          <button v-if="logo" class="unlogo" title="Remove the logo" @click="logo = null"><X /></button>
          <input ref="logoInput" type="file" accept="image/*" hidden @change="pickLogo" />
        </span>
        <label class="field grow">
          <span class="lbl">Name</span>
          <input
            ref="nameInput"
            v-model="name"
            class="input hero"
            type="text"
            spellcheck="false"
            :title="'Only on this machine. Empty uses the ' + (p.manifestPath ? 'manifest' : 'folder') + ' name.'"
            :placeholder="p.manifestPath ? 'from the manifest' : 'the folder name'"
            @keydown.enter="save"
          />
        </label>
        <label class="field">
          <span class="lbl">Initials</span>
          <input
            v-model="mark"
            class="input hero markin"
            type="text"
            maxlength="3"
            spellcheck="false"
            :title="logo ? 'Shown where the logo is not' : 'Shown on the rail'"
            :placeholder="monogram(name.trim() || p.name)"
            @keydown.enter="save"
          />
        </label>
      </div>

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

      <!-- §7 — what the project holds, and the one place a repository is
           added to it. -->
      <!-- One row per repository: its name, its initials (what the repository
           menu shows when the tool strip has no room for the name, so only
           when there is more than one), and the way out. Then the ones left
           out on this machine, and the way in. -->
      <div class="field">
        <div class="lblrow">
          <span class="lbl">Repositories</span>
          <span v-if="repos.length > 1" class="lbl colhead" title="Shown in the repository menu when there is no room for the name">Initials</span>
        </div>
        <div class="list">
          <div v-for="r in repos" :key="r.id" class="lrow">
            <span class="rn mono" :title="r.path">{{ r.repoName }}</span>
            <input
              v-if="repos.length > 1"
              :value="repoMarks[r.repoName] ?? ''"
              class="input markin"
              type="text"
              maxlength="3"
              spellcheck="false"
              :aria-label="'Initials for ' + r.repoName"
              :placeholder="derivedMark(r)"
              @input="repoMarks[r.repoName] = ($event.target as HTMLInputElement).value.toLowerCase()"
              @keydown.enter="save"
            />
            <button
              class="icon-btn rowact del"
              :class="{ ghost: isRoot(r.path) }"
              :disabled="busy || isRoot(r.path)"
              :title="isRoot(r.path) ? '' : 'Remove from Cockpit. The files stay.'"
              @click="askUntrackRepo(p.id, r.id)"
            >
              <Trash2 />
            </button>
          </div>
          <div v-for="u in untracked" :key="u" class="lrow off">
            <span class="rn mono">{{ u }}</span>
            <button class="btn sm" :disabled="busy" title="Add it back" @click="trackRepo(p.id, u)">Add back</button>
          </div>
          <button class="lrow addrow" @click="addRepository">
            <Plus />Add a repository
          </button>
        </div>
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
        <span class="lbl" title="What topics fork from and Send lands on. Empty asks git.">Base branch</span>
        <input
          v-model="baseBranch"
          class="input mono"
          type="text"
          spellcheck="false"
          :placeholder="probedBase ? probedBase + ' (from git)' : 'from git'"
        />
      </label>

      <!-- §9 — the lasting layer. Agents read it; they only ever propose to it. -->
      <div class="field">
        <span class="lbl">Documentation</span>
        <div class="row">
          <input
            v-model="docsPath"
            class="input mono"
            type="text"
            spellcheck="false"
            :placeholder="docsFallback ? docsFallback.path + ' (found)' : 'a docs folder, or a repository'"
            :title="docsWhere"
          />
          <button class="btn" title="Choose a folder" @click="browseDocs">
            <FolderOpen />Browse
          </button>
        </div>
      </div>

      <!-- §16 — the rule that used to be hardcoded, handed back, one
           repository at a time: the same list as above, a row each, with
           what is protected on it and + for another, picked from the
           repository's branches as the branch chip picks one. The base, when it is
           not protected yet, is offered as a dashed chip, one click. -->
      <div v-if="repos.length" class="field">
        <span class="lbl" title="Cockpit won't commit on these, and only pushes to them what arrives through Send to.">Protected branches</span>
        <div class="list">
          <div v-for="r in repos" :key="r.id" class="lrow prow">
            <span class="rn mono">{{ r.repoName }}</span>
            <div class="pchips">
              <span v-for="b in guarded[r.repoName] ?? []" :key="b" class="pchip mono">
                <ShieldCheck />{{ b }}
                <button class="px" :title="'Unprotect ' + b" @click="unprotect(r.repoName, b)"><X /></button>
              </span>
              <button
                v-if="r.git?.base && !(guarded[r.repoName] ?? []).includes(r.git.base)"
                class="pchip offer mono"
                :title="'Protect ' + r.git.base"
                @click="protect(r.repoName, r.git.base)"
              >
                <ShieldPlus />{{ r.git.base }}
              </button>
            </div>
            <!-- The branch chip's search, over this repository's branches. -->
            <ProtectMenu
              :workspace-id="r.id"
              :repo="r.repoName"
              :protected="guarded[r.repoName] ?? []"
              @add="protect(r.repoName, $event)"
            />
          </div>
        </div>
      </div>

      <!-- tokens.css: colour is for meaning. The ground stays neutral; the red
           is spent on the label and the one button that earns it. -->
      <section class="zone">
        <span class="section-label">Danger zone</span>

        <div class="drow">
          <div class="dtext">
            <strong>Remove from Cockpit</strong>
            <span>Cockpit forgets it. Files stay put.</span>
          </div>
          <button class="btn" :disabled="busy" @click="askUntrackProject(p.id)">Remove</button>
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
.grow { flex: 1; }

/* TopicDialog's form, to the pixel, as GroupDialog's is: sentence-case
   labels in the muted ink, the name as the hero field, lists in a well. */
.form { display: flex; flex-direction: column; gap: 20px; padding: 2px 0 16px; }
.field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.lbl { font-size: var(--fs-xs); color: var(--text-muted); }
.input.hero { padding: 10px 12px; font-size: var(--fs-md); font-weight: 520; letter-spacing: -0.005em; }
.input.hero::placeholder { font-weight: 400; }
.summary { font-size: var(--fs-sm); color: var(--text-muted); }

.row { display: flex; align-items: center; gap: 8px; }
.row .input { flex: 1; min-width: 0; }
.row .btn { flex: none; }

/* ── Who the project is ──────────────────────────────────────────────────
   The tile on the left is the rail's, at the rail's size, so it lines up
   with the fields beside it: what you type there shows on it as you type. */
.ident { display: flex; align-items: flex-end; gap: 12px; }
.ident .markin { width: 64px; text-align: center; }
.tilewrap { position: relative; flex: none; }
.tile {
  position: relative;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: var(--radius);
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--text-muted);
  cursor: pointer;
}
.tile .gram { font-size: var(--fs-sm); font-weight: 650; letter-spacing: 0.02em; line-height: 1; }
.tile img { width: 24px; height: 24px; border-radius: 6px; object-fit: cover; display: block; }
/* The way to change it, on hover only: at rest the tile is the preview. */
.tile .over {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg-sunken) 72%, transparent);
  color: var(--text);
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft);
}
.tile .over .lucide { width: 16px; height: 16px; }
.tile:hover .over,
.tile:focus-visible .over,
.tile.drop .over { opacity: 1; }
.tile.drop { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.unlogo {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 50%;
  background: var(--panel-raised);
  border: 1px solid var(--line-strong);
  color: var(--text-muted);
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft);
}
.unlogo:hover { color: var(--text); }
.unlogo :deep(svg) { width: 10px; height: 10px; }
.tilewrap:hover .unlogo,
.unlogo:focus-visible { opacity: 1; }

/* ── Lists ───────────────────────────────────────────────────────────────
   GroupDialog's list: a well, a row each. Repositories and protected
   branches are the same shape, one under the other. */
.lblrow { display: flex; align-items: baseline; }
.lblrow .lbl:first-child { flex: 1; }
/* Over the 56px initials column: 28px button + 10px gap + 6px row padding + the list's 1px border. */
.colhead { width: 56px; margin-right: 45px; text-align: center; }
.list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  overflow: hidden;
}
.lrow {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 0 6px 0 12px;
  font-size: var(--fs-sm);
  color: var(--text);
}
.lrow + .lrow { border-top: 1px solid var(--line-soft); }
.lrow .rn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lrow .markin {
  flex: none;
  width: 56px;
  padding: 3px 6px;
  text-align: center;
  text-transform: lowercase;
  background: none;
}
.lrow .markin:focus { background: var(--panel-raised); }
.rowact .lucide { width: 14px; height: 14px; }
.rowact.ghost { visibility: hidden; }
.rowact.del:not(:disabled):hover { color: var(--danger); }
/* Left out on this machine: still on disk, so still named, but quiet. */
.lrow.off .rn { color: var(--text-dim); }
.lrow .btn.sm { height: 26px; padding: 0 10px; font-size: var(--fs-xs); }
.addrow { width: 100%; gap: 8px; color: var(--text-muted); text-align: left; }
.addrow .lucide { width: 14px; height: 14px; }
.addrow:hover { background: var(--hover); color: var(--text); }

/* A protected branch: a shield, its name, and the way to take it off. */
.prow { padding-top: 6px; padding-bottom: 6px; }
/* The name keeps its width; the chips take what is left and wrap in it. */
.prow .rn { flex: none; max-width: 50%; }
.pchips { flex: 1; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; min-width: 0; }
.pchip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 4px 0 8px;
  border-radius: 999px;
  background: var(--hover);
  color: var(--text);
  font-size: var(--fs-xs);
}
.pchip > .lucide { width: 12px; height: 12px; color: var(--accent); }
.px {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  color: var(--text-dim);
}
.px .lucide { width: 11px; height: 11px; }
.px:hover { background: var(--active); color: var(--text); }
/* The base, offered: dashed until it is taken. */
.pchip.offer {
  padding: 0 9px 0 8px;
  background: none;
  border: 1px dashed var(--line-strong);
  color: var(--text-dim);
}
.pchip.offer > .lucide { color: inherit; }
.pchip.offer:hover { border-color: var(--accent); color: var(--text); }


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
