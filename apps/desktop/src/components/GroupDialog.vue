<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { FolderTree } from '@lucide/vue'
import DialogShell from './DialogShell.vue'
import { groupMembers, groupRepos, renameGroup, state } from '../core/store.js'

/**
 * §4 — a group: a folder of repositories inside the project, drawn in the list
 * the way a topic is and stood on the same way. Made here, or edited here —
 * its name and which repositories are in it. Both move folders on disk, so
 * the sheet says where they will be.
 */

const d = computed(() => state.groupDialog)
const project = computed(() => state.projects.find((p) => p.id === d.value?.projectId) ?? null)
const group = computed(() => (d.value?.groupId ? (state.workspaces.find((w) => w.id === d.value!.groupId) ?? null) : null))

/** Every repository of the project but the project's own folder. */
const repos = computed(() =>
  state.workspaces
    .filter((w) => w.projectId === d.value?.projectId && w.kind === 'main' && w.path !== project.value?.root)
    .sort((a, b) => a.name.localeCompare(b.name)),
)

const name = ref('')
const selected = ref<string[]>([])
const busy = ref(false)
const nameInput = ref<HTMLInputElement | null>(null)

watch(
  d,
  async (v) => {
    if (!v) return
    name.value = group.value?.name ?? ''
    selected.value = v.groupId ? groupMembers(v.groupId).map((w) => w.id) : [...v.pick]
    busy.value = false
    await nextTick()
    nameInput.value?.focus()
    nameInput.value?.select()
  },
  { immediate: true },
)

/** Where a repository is now, when it is somewhere other than this group. */
function whereNow(id: string): string | null {
  const w = state.workspaces.find((x) => x.id === id)
  if (!w?.groupId || w.groupId === d.value?.groupId) return null
  return state.workspaces.find((x) => x.id === w.groupId)?.name ?? null
}

const trimmed = computed(() => name.value.trim())
const problem = computed(() => {
  const n = trimmed.value
  if (!n) return null
  if (/[/\\:]/.test(n)) return 'A folder name cannot hold / \\ or :'
  if (n.startsWith('.')) return 'A folder name cannot start with a dot'
  const clash = state.workspaces.find(
    (w) => w.projectId === d.value?.projectId && w.kind === 'main' && w.name === n && w.path !== project.value?.root,
  )
  if (clash) return 'A repository is already called ' + n
  return null
})
const otherGroup = computed(() =>
  state.workspaces.find(
    (w) => w.projectId === d.value?.projectId && w.kind === 'group' && !w.topicId && w.name === trimmed.value && w.id !== d.value?.groupId && w.path !== project.value?.root,
  ) ?? null,
)

const canSave = computed(() => !!trimmed.value && !problem.value && selected.value.length > 0 && !busy.value)

function close(): void {
  if (busy.value) return
  state.groupDialog = null
}

async function submit(): Promise<void> {
  const v = d.value
  if (!v || !canSave.value) return
  busy.value = true
  try {
    const target = trimmed.value
    if (!v.groupId) {
      if (await groupRepos(v.projectId, selected.value, target)) state.groupDialog = null
      return
    }
    // Edited: the name first — every repository in it moves with the folder —
    // then whoever joined, then whoever left.
    const was = groupMembers(v.groupId).map((w) => w.id)
    const left = was.filter((id) => !selected.value.includes(id))
    const joined = selected.value.filter((id) => !was.includes(id))
    if (target !== group.value?.name && !(await renameGroup(v.groupId, target))) return
    // Renamed, the ids under it are new: find the ones that left by name.
    const names = new Map(was.map((id) => [id, state.workspaces.find((w) => w.id === id)?.name]))
    const now = (id: string) => state.workspaces.find((w) => w.projectId === v.projectId && w.kind === 'main' && w.name === names.get(id))?.id
    if (joined.length && !(await groupRepos(v.projectId, joined, target))) return
    const out = left.map(now).filter((x): x is string => !!x)
    if (out.length && !(await groupRepos(v.projectId, out, null))) return
    state.groupDialog = null
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <DialogShell
    v-if="d && project"
    :title="d.groupId ? 'Edit ' + (group?.name ?? 'group') : 'New group'"
    variant="question"
    :width="440"
    :dismissible="!busy"
    @close="close"
  >
    <template #lead><FolderTree class="sm gi" /></template>

    <div class="form">
      <div class="field">
        <div class="lblrow">
          <label class="lbl" for="group-name">Name</label>
          <code v-if="trimmed" class="mono made" title="The folder the repositories move into">{{ project.name }}/{{ trimmed }}/</code>
        </div>
        <input
          id="group-name"
          ref="nameInput"
          v-model="name"
          class="input hero"
          placeholder="SchoolGen"
          spellcheck="false"
          @keydown.enter="submit"
        />
        <span v-if="problem" class="help bad">{{ problem }}</span>
        <span v-else-if="otherGroup && !d.groupId" class="help">Already a group — these join it.</span>
      </div>

      <div class="field">
        <span class="lbl">Repositories</span>
        <div v-if="repos.length" class="list">
          <label v-for="r in repos" :key="r.id" class="check lrow" :class="{ off: !selected.includes(r.id) }">
            <input v-model="selected" type="checkbox" :value="r.id" />
            <span class="rname">{{ r.name }}</span>
            <span v-if="whereNow(r.id)" class="rnote" :title="'In ' + whereNow(r.id) + ' now — ticking it moves it here'">in {{ whereNow(r.id) }}</span>
          </label>
        </div>
        <span v-else class="help">No repository in this project.</span>
      </div>
    </div>

    <template #foot>
      <span class="grow" />
      <button class="btn ghost" :disabled="busy" @click="close">Cancel</button>
      <button class="btn primary" :disabled="!canSave" @click="submit">
        {{ busy ? 'Moving…' : d.groupId ? 'Save' : 'Create group' }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
/* TopicDialog's form, to the pixel: the two sheets sit side by side in the list. */
.gi { color: var(--text-dim); }
.grow { flex: 1; }
.form { display: flex; flex-direction: column; gap: 20px; padding: 2px 0 16px; --well: var(--bg-sunken); --well-shadow: none; }
.field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.lbl { font-size: var(--fs-xs); color: var(--text-muted); }
.lbl[for] { cursor: text; }
.lblrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.made {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--accent);
}
.help { font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.55; }
.help.bad { color: var(--danger); }
.input.hero { padding: 10px 12px; font-size: var(--fs-md); font-weight: 520; letter-spacing: -0.005em; }
.input.hero::placeholder { font-weight: 400; }
.list {
  display: flex;
  flex-direction: column;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--well);
  box-shadow: var(--well-shadow);
}
.check { display: flex; align-items: center; gap: 9px; font-size: var(--fs-sm); color: var(--text-muted); }
.lrow { padding: 0 12px; min-height: 36px; transition: background var(--dur-1) var(--ease-soft); cursor: pointer; }
.lrow + .lrow { border-top: 1px solid var(--line-soft); }
.lrow:hover { background: var(--hover); }
.rname { flex: 1; min-width: 0; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lrow.off .rname { color: var(--text-dim); }
.rnote { flex: none; font-size: var(--fs-xs); color: var(--text-dim); }
</style>
