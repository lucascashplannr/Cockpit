<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { FolderOpen } from '@lucide/vue'
import type { SkillWhere } from '@cockpit/shared'
import DialogShell from '../DialogShell.vue'
import { createSkill, importSkills, pickFolder } from '../../core/store.js'

/**
 * §6 — a skill added from the composer: written here, or copied in from a
 * folder. Either way it lands where Claude reads skills — a repository's
 * `.claude/skills` (shared with it) or your own `~/.claude/skills` (every
 * project) — so it works in any conversation that starts after it, and `#name`
 * in a message makes that turn use it.
 */
const props = defineProps<{
  sources?: { workspaceId: string; name: string; path: string }[]
  mode?: 'write' | 'import'
}>()
const emit = defineEmits<{ close: [] }>()

const mode = ref<'write' | 'import'>(props.mode ?? 'write')

/* Where it goes: a repository of this scope, or everywhere. */
const places = computed(() => [
  ...(props.sources ?? []).map((s) => ({
    key: s.workspaceId,
    label: s.name,
    title: s.path.replace(/^\/Users\/[^/]+/, '~') + '/.claude/skills — shared with the repository',
    where: { kind: 'repo', workspaceId: s.workspaceId } as SkillWhere,
  })),
  { key: 'user', label: 'Everywhere (yours)', title: '~/.claude/skills — every project, and Claude Code itself', where: { kind: 'user' } as SkillWhere },
])
const place = ref(places.value[0]!.key)
const where = computed(() => places.value.find((p) => p.key === place.value)!.where)

/* Write one */
const name = ref('')
const description = ref('')
const body = ref('')
/** Typed as words, kept as the name Claude accepts: lowercase, hyphens. */
function onName(v: string): void {
  name.value = v.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 64)
}
const writeProblem = computed(() => {
  if (!name.value) return 'Give it a name'
  if (!/^[a-z0-9]/.test(name.value)) return 'A name starts with a letter or a digit'
  if (!description.value.trim()) return 'Say when to use it: Claude only reads that to decide'
  return null
})

/* Import a folder */
const from = ref<string | null>(null)
async function choose(): Promise<void> {
  const picked = await pickFolder({
    title: 'Import skills',
    message: 'A skill’s folder (it holds a SKILL.md), or a folder of skills',
    buttonLabel: 'Choose',
  })
  if (picked) from.value = picked
}

const busy = ref(false)
async function go(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    if (mode.value === 'write') {
      if (writeProblem.value) return
      const made = await createSkill({ name: name.value, description: description.value, body: body.value, where: where.value })
      if (made) emit('close')
    } else if (from.value) {
      if (await importSkills(from.value, where.value)) emit('close')
    }
  } finally {
    busy.value = false
  }
}

const nameField = ref<HTMLInputElement | null>(null)
onMounted(() => void nextTick(() => nameField.value?.focus()))
</script>

<template>
  <DialogShell title="Add a skill" :width="560" @close="emit('close')">
    <div class="seg modes">
      <button :class="{ on: mode === 'write' }" @click="mode = 'write'">Write one</button>
      <button :class="{ on: mode === 'import' }" @click="mode = 'import'">Import a folder</button>
    </div>

    <template v-if="mode === 'write'">
      <label class="field">
        <span class="lbl">Name</span>
        <input
          ref="nameField"
          :value="name"
          class="input mono"
          spellcheck="false"
          autocomplete="off"
          placeholder="release-notes"
          @input="onName(($event.target as HTMLInputElement).value)"
        >
      </label>
      <label class="field">
        <span class="lbl" title="The only part Claude reads before deciding to use it">When to use it</span>
        <textarea
          v-model="description"
          class="input"
          rows="2"
          placeholder="Use when writing release notes for Cashplannr: what changed, for whom, in our tone."
        />
      </label>
      <label class="field">
        <span class="lbl" title="Read once the skill is used. Markdown.">What to do</span>
        <textarea
          v-model="body"
          class="input mono"
          rows="9"
          spellcheck="false"
          placeholder="1. Read the merged pull requests since the last tag.&#10;2. Group them by feature…"
        />
      </label>
    </template>

    <label v-else class="field">
      <span class="lbl">Folder</span>
      <span class="pickrow">
        <span class="input path" :class="{ empty: !from }" :title="from ?? undefined">{{ from ? from.replace(/^\/Users\/[^/]+/, '~') : 'A skill’s folder, or a folder of skills' }}</span>
        <button class="btn" @click="choose"><FolderOpen class="sm" />Choose…</button>
      </span>
    </label>

    <label class="field">
      <span class="lbl">Where</span>
      <select v-model="place" class="input" :title="places.find((p) => p.key === place)?.title">
        <option v-for="p in places" :key="p.key" :value="p.key" :title="p.title">{{ p.label }}</option>
      </select>
    </label>

    <template #foot>
      <span class="grow" />
      <button class="btn ghost" @click="emit('close')">Cancel</button>
      <button
        class="btn primary"
        :disabled="busy || (mode === 'write' ? !!writeProblem : !from)"
        :title="mode === 'write' ? writeProblem ?? undefined : from ? undefined : 'Choose a folder first'"
        @click="go"
      >
        {{ mode === 'write' ? 'Add' : 'Import' }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
.grow { flex: 1; }
.sm { width: 14px; height: 14px; }
.modes { margin-bottom: 16px; }
.field { display: block; margin-bottom: 14px; }
.lbl { display: block; font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: 6px; }
.field .input { width: 100%; }
textarea.input { resize: vertical; line-height: 1.5; padding-top: 7px; padding-bottom: 7px; }
.mono { font-family: var(--mono); font-size: 12px; }
.pickrow { display: flex; gap: 8px; }
.path { flex: 1; min-width: 0; display: flex; align-items: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.path.empty { color: var(--text-dim); }
</style>
