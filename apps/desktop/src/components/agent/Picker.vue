<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronDown } from '@lucide/vue'

/**
 * One choice, folded away until it is being made.
 *
 * The composer briefly laid its choices out as segmented rows — eleven buttons
 * across the foot of the box for three decisions. That reads as eleven things
 * to consider every time you write a prompt, when the honest count is three,
 * and only one of them changes on most days. A dropdown states the current
 * answer and keeps the alternatives out of the way until asked.
 */
export interface Option {
  id: string
  label: string
  hint?: string
  disabled?: boolean
}

const props = defineProps<{
  options: Option[]
  modelValue?: string
  /** Shown before the value, small: what the choice is *about*. */
  label?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

const current = computed(
  () => props.options.find((o) => o.id === props.modelValue) ?? props.options[0],
)

function pick(o: Option): void {
  if (o.disabled) return
  emit('update:modelValue', o.id)
  open.value = false
}

/**
 * Closing on any click elsewhere, listened for only while open — a permanent
 * document listener per picker is three of them running for the whole life of
 * the window to serve a menu nobody has opened.
 */
function onDocDown(ev: MouseEvent): void {
  if (!root.value?.contains(ev.target as Node)) open.value = false
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') open.value = false
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
  } else {
    document.removeEventListener('mousedown', onDocDown)
    document.removeEventListener('keydown', onKey)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="root" class="picker">
    <button class="trigger" :class="{ open }" @click="open = !open">
      <span v-if="label" class="lbl">{{ label }}</span>
      <span class="val">{{ current?.label }}</span>
      <ChevronDown class="chev" />
    </button>

    <!-- Upward: the composer sits at the foot of the window, and a menu that
         opens downward would be clipped by it. -->
    <ul v-if="open" class="menu">
      <li v-for="o in options" :key="o.id">
        <button
          class="item"
          :class="{ on: o.id === modelValue, off: o.disabled }"
          :disabled="o.disabled"
          @click="pick(o)"
        >
          <Check class="tick" :class="{ hidden: o.id !== modelValue }" />
          <span class="name">{{ o.label }}</span>
          <span v-if="o.hint" class="hint">{{ o.hint }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.picker { position: relative; }

.trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 6px 0 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg);
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
}
.trigger:hover, .trigger.open { color: var(--text); border-color: var(--line-strong); background: var(--hover); }
/* The label is context, the value is the answer: only one of them is worth
   full contrast at a glance. */
.lbl { color: var(--text-dim); }
.val { color: var(--text); font-weight: 550; }
.chev { width: 11px; height: 11px; color: var(--text-dim); }

.menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 5px);
  z-index: 10;
  margin: 0;
  padding: 4px;
  /* The picker is a narrow flex item, so an auto-width menu shrink-to-fits
     against it and every hint wraps. Size to the widest row instead. */
  width: max-content;
  min-width: 150px;
  max-width: 280px;
  list-style: none;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--panel-raised);
  box-shadow: var(--shadow-sm);
}

.item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 8px;
  border-radius: 5px;
  text-align: left;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.item:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.item.on { color: var(--text); }
.item.off { opacity: 0.4; }
.tick { width: 12px; height: 12px; flex: none; color: var(--accent); }
/* Held rather than removed, so the labels do not shift as the tick moves. */
.tick.hidden { visibility: hidden; }
.name { flex: none; }
/* Pushed to the right edge so the hints read as one column, not a ragged one. */
.hint { margin-left: auto; padding-left: 18px; color: var(--text-dim); font-size: 10px; white-space: nowrap; }
</style>
