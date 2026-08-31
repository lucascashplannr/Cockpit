<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { FileCode, Map as MapIcon } from '@lucide/vue'
import { agentDraft, client, guard, saveComposer, state } from '../../core/store.js'
import { fuzzyFilter } from '../../core/fuzzy.js'
import Picker from './Picker.vue'
import type { Option } from './Picker.vue'

/**
 * Where the question is written, and everything that shapes the answer.
 *
 * It used to be a bare textarea and two engine buttons, so the three decisions
 * that most change what comes back — which model, how hard it thinks, and
 * whether it may write at all — could only be made by editing the core. They
 * are one row under the box now, because that is where they are decided: per
 * question, not per project.
 */
const props = defineProps<{
  /** The big centred one on an empty conversation, or the one in the footer. */
  big?: boolean
  disabled?: boolean
  /** Which workspace `@` completes files from. */
  workspaceId?: string | null
  engines?: { id: string; available: boolean; bin: string }[]
  engine?: string
  /** `start` opens a conversation, `continue` adds a turn, `queue` waits. */
  mode: 'start' | 'continue' | 'queue'
  placeholder: string
}>()
const emit = defineEmits<{ send: []; 'update:engine': [string] }>()

const box = ref<HTMLTextAreaElement | null>(null)

/* ── model and effort ─────────────────────────────────────────────────── */

/**
 * Aliases rather than pinned ids: the engine resolves `opus` to whatever the
 * current Opus is, and a hard-coded model string is a thing that silently
 * rots.
 */
const MODELS = [
  { id: 'opus', label: 'Opus', hint: 'the most capable' },
  { id: 'sonnet', label: 'Sonnet', hint: 'faster, cheaper' },
  { id: 'haiku', label: 'Haiku', hint: 'quick and small' },
]
const EFFORTS = [
  { id: 'low', label: 'Low', hint: 'quick passes' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High', hint: 'the default' },
  { id: 'xhigh', label: 'X-high' },
  { id: 'max', label: 'Max', hint: 'when correctness beats cost' },
]

function pickModel(id: string): void {
  state.engineOptions.model = id
  saveComposer()
}
function pickEffort(id: string): void {
  state.engineOptions.effort = id
  saveComposer()
}

/** An engine that is not on PATH is shown and unpickable, never hidden: its
 *  absence is a thing to install, not a thing to wonder about. */
const engineOptions = computed<Option[]>(() =>
  (props.engines ?? []).map((e) => ({
    id: e.id,
    label: e.id,
    hint: e.available ? undefined : 'not installed',
    disabled: !e.available,
  })),
)

/* ── @ mentions ───────────────────────────────────────────────────────────
 *
 * The repository's tracked files, fetched once per workspace and kept: an
 * agent is pointed at code under version control, and offering `node_modules`
 * would bury the three files anyone actually means.
 */
const tracked = ref<string[]>([])
const loadedFor = ref<string | null>(null)

watch(
  () => props.workspaceId,
  async (id) => {
    if (!id || loadedFor.value === id) return
    loadedFor.value = id
    tracked.value = (await guard(() => client.call('fs.tracked', { workspaceId: id }))) ?? []
  },
  { immediate: true },
)

/**
 * The `@token` the caret is currently inside, if any. The caret position is
 * tracked rather than read on demand: a computed that reaches into the DOM
 * does not re-evaluate when only the selection moves.
 */
const caret = ref(0)
const mention = computed(() => {
  const upto = agentDraft.value.slice(0, caret.value)
  const m = /(^|\s)@([^\s@]*)$/.exec(upto)
  if (!m) return null
  const q = m[2] ?? ''
  return { query: q, from: upto.length - q.length - 1 }
})

const matches = computed(() => {
  const m = mention.value
  if (m === null) return []
  if (!m.query) return tracked.value.slice(0, 8)
  return fuzzyFilter(tracked.value, m.query, (x) => x, 8).map((s) => s.item)
})

const cursor = ref(0)
watch(matches, () => {
  cursor.value = 0
})
const picking = computed(() => matches.value.length > 0 && mention.value !== null)

function track(): void {
  caret.value = box.value?.selectionStart ?? 0
}

function accept(path: string): void {
  const m = mention.value
  if (!m) return
  const after = agentDraft.value.slice(caret.value)
  agentDraft.value = agentDraft.value.slice(0, m.from) + '@' + path + ' ' + after
  nextTick(() => {
    const pos = m.from + path.length + 2
    box.value?.focus()
    box.value?.setSelectionRange(pos, pos)
    caret.value = pos
  })
}

/* ── prompt history ───────────────────────────────────────────────────── */

const histAt = ref(-1)

/**
 * `↑` only walks history from an empty box, or from a prompt already recalled.
 * Anywhere else it stays the caret key it has always been — stealing it would
 * make editing a long prompt impossible.
 */
function walkHistory(step: number, ev: KeyboardEvent): void {
  const recalled = histAt.value >= 0
  if (!recalled && (agentDraft.value !== '' || step < 0)) return
  const next = histAt.value + step
  if (next < -1 || next >= state.promptHistory.length) return
  ev.preventDefault()
  histAt.value = next
  agentDraft.value = next === -1 ? '' : (state.promptHistory[next] ?? '')
}

function onKey(ev: KeyboardEvent): void {
  if (picking.value) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      cursor.value = (cursor.value + 1) % matches.value.length
      return
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      cursor.value = (cursor.value - 1 + matches.value.length) % matches.value.length
      return
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault()
      accept(matches.value[cursor.value] ?? '')
      return
    }
    if (ev.key === 'Escape') {
      ev.preventDefault()
      // Closes the list without losing the `@`: it is being typed, not undone.
      agentDraft.value += ' '
      caret.value = agentDraft.value.length
      return
    }
  }
  if (ev.key === 'ArrowUp') walkHistory(1, ev)
  else if (ev.key === 'ArrowDown') walkHistory(-1, ev)
}

function submit(): void {
  histAt.value = -1
  emit('send')
}

const sendLabel = computed(() =>
  props.mode === 'queue' ? 'Queue' : props.mode === 'continue' ? 'Continue' : 'Start',
)
const plan = computed(() => state.engineOptions.plan)
function togglePlan(): void {
  state.engineOptions.plan = !state.engineOptions.plan
}

defineExpose({ focus: () => box.value?.focus() })
</script>

<template>
  <div class="composer" :class="{ big, planning: plan }">
    <!-- The files, over the box: the list is what the word being typed could
         mean, so it belongs against the word rather than below the row. -->
    <ul v-if="picking" class="mentions">
      <li
        v-for="(m, i) in matches"
        :key="m"
        :class="{ on: i === cursor }"
        @mousedown.prevent="accept(m)"
      >
        <FileCode class="xs" />
        <span class="path">{{ m }}</span>
      </li>
    </ul>

    <textarea
      ref="box"
      v-model="agentDraft"
      class="input prompt selectable"
      :rows="big ? 3 : 2"
      :placeholder="placeholder"
      @keydown="onKey"
      @keydown.meta.enter="submit"
      @keyup="track"
      @click="track"
      @input="track"
    />

    <div class="row">
      <!-- Engine first: it decides what every control after it means. -->
      <Picker
        v-if="engineOptions.length"
        :options="engineOptions"
        :model-value="engine"
        @update:model-value="emit('update:engine', $event)"
      />
      <Picker :options="MODELS" :model-value="state.engineOptions.model" @update:model-value="pickModel" />
      <Picker
        label="Effort"
        :options="EFFORTS"
        :model-value="state.engineOptions.effort"
        @update:model-value="pickEffort"
      />

      <!-- §3.7 — the plan before the change, applied to the agent itself.
           A toggle rather than a picker: it has two states and one of them
           changes what pressing Start does. -->
      <button
        class="opt plan"
        :class="{ on: plan }"
        title="Plan mode — it reads and proposes, and writes nothing"
        @click="togglePlan"
      >
        <MapIcon class="xs" /> Plan
      </button>

      <span class="grow" />
      <button class="btn primary" :disabled="disabled" @click="submit">
        {{ sendLabel }}
        <span class="kbd">⌘⏎</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  position: relative;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--panel-raised);
  padding: 10px 10px 9px;
}
.composer.big { box-shadow: var(--shadow-sm); }
/* Plan mode changes what pressing Start *does*, so it is worth a whole-box
   signal rather than one lit chip among eleven. */
.composer.planning { border-color: var(--accent); }

.prompt {
  border: none;
  background: transparent;
  padding: 4px 4px 8px;
  resize: none;
  width: 100%;
}
.prompt:focus { box-shadow: none; border-color: transparent; }

.row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.grow { flex: 1; }

.opt {
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg);
  white-space: nowrap;
}
.opt:hover:not(:disabled) { color: var(--text); background: var(--hover); }
.opt.on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.opt.plan { display: inline-flex; align-items: center; gap: 4px; }
.xs { width: 11px; height: 11px; }

.mentions {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: calc(100% - 6px);
  z-index: 5;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--panel-raised);
  box-shadow: var(--shadow-sm);
  max-height: 220px;
  overflow-y: auto;
}
.mentions li {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border-radius: 5px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  cursor: pointer;
}
.mentions li.on { background: var(--selected); color: var(--text); }
.mentions .lucide { flex: none; color: var(--text-dim); }
.mentions .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
