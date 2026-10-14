<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronDown, ChevronUp, Search, X } from '@lucide/vue'

/**
 * The find field over a file: the editor's (see `core/find.ts`) and the
 * Diff's rows. It only shows and asks; whoever owns the text does the finding.
 */

const props = defineProps<{
  /** `index` is -1 when the place is not on a match; `more` when counting stopped short. */
  hits: { index: number; count: number; more?: boolean } | null
}>()
const q = defineModel<string>({ required: true })
const emit = defineEmits<{ step: [dir: 1 | -1]; close: [] }>()

const isMac = navigator.platform.toLowerCase().includes('mac')
const input = ref<HTMLInputElement | null>(null)

const label = computed(() => {
  const h = props.hits
  if (!h || !h.count) return 'none'
  const of = h.count + (h.more ? '+' : '')
  return h.index < 0 ? of : h.index + 1 + ' of ' + of
})

function step(dir: 1 | -1) {
  if (props.hits?.count) emit('step', dir)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    step(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    // Done finding — not done with the tool.
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
    e.preventDefault()
    step(e.shiftKey ? -1 : 1)
  }
}

function focus() {
  input.value?.focus()
  input.value?.select()
}
defineExpose({ focus })
onMounted(focus)
</script>

<template>
  <div class="findbar">
    <label class="find">
      <Search class="sm" />
      <input
        ref="input"
        v-model="q"
        main-field="true"
        :placeholder="isMac ? 'Find  ⌘F' : 'Find'"
        spellcheck="false"
        @keydown="onKey"
      />
      <span v-if="q" class="count num">{{ label }}</span>
      <span class="steps">
        <button class="wipe" :title="isMac ? 'Previous  ⇧↵' : 'Previous'" :disabled="!hits?.count" @click="step(-1)">
          <ChevronUp />
        </button>
        <button class="wipe" :title="isMac ? 'Next  ↵' : 'Next'" :disabled="!hits?.count" @click="step(1)">
          <ChevronDown />
        </button>
        <button class="wipe" title="Close  Esc" @click="emit('close')"><X /></button>
      </span>
    </label>
  </div>
</template>

<style scoped>
/* The Terminal's find field, so the review tools read as one family. */
.findbar { display: flex; padding: 7px 10px 7px 14px; }
.find {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 320px;
  min-width: 120px;
  height: 28px;
  padding: 0 4px 0 9px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: var(--bg-sunken);
  color: var(--text-dim);
  font-family: var(--font);
  transition:
    border-color var(--dur-1) var(--ease-soft),
    background var(--dur-1) var(--ease-soft),
    box-shadow var(--dur-1) var(--ease-soft);
}
.find:focus-within {
  border-color: var(--accent);
  background: var(--panel-raised);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.find input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  outline: none;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-xs);
}
.find input::placeholder { color: var(--text-dim); }
.count { flex: none; font-size: 11px; color: var(--text-dim); padding-right: 2px; }
/* Three buttons, one set: closer to each other than to the count. */
.steps { display: flex; flex: none; }
.wipe {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 5px;
  color: var(--text-dim);
}
.wipe:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.wipe:disabled { opacity: 0.4; }
.wipe .lucide { width: 12px; height: 12px; }
</style>
