<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronDown } from '@lucide/vue'
import { fuzzyFilter, highlight } from '../../core/fuzzy.js'
import type { Option } from './Picker.vue'

/**
 * §6 — which memory, as a list with a search field.
 *
 * The composer's other choices are three to five answers that never grow, and
 * a plain menu is right for them. Memories grow with the project, one per
 * thing worked on, and forty names to scroll through for "Link widgets" is a
 * list asking to be searched. So the branch menu's shape: the same chip, a
 * field on top, the rows under it.
 */
const props = defineProps<{
  options: Option[]
  modelValue?: string
  /** How many of `options` come first and are not memories: new, none, this topic. */
  fixed: number
}>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const open = ref(false)
const query = ref('')
const cursor = ref(0)
const room = ref(0)
const root = ref<HTMLElement | null>(null)
const field = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

const current = computed(
  () => props.options.find((o) => o.id === props.modelValue) ?? props.options[0],
)

interface Row { option: Option; positions: number[] }
/**
 * Unsearched, the choices that are not memories lead and the memories follow
 * in the order they come. Searched, one ranked list: "new" is as findable as
 * any name, and a heading over three hits is noise.
 */
const rows = computed<Row[]>(() => {
  const term = query.value.trim()
  if (!term) return props.options.map((option) => ({ option, positions: [] }))
  return fuzzyFilter(props.options, term, (o) => o.label, 200).map((s) => ({ option: s.item, positions: s.positions }))
})
const searching = computed(() => query.value.trim() !== '')

function toggle(): void {
  query.value = ''
  open.value = !open.value
}
function pick(o: Option | undefined): void {
  if (!o || o.disabled) return
  emit('update:modelValue', o.id)
  open.value = false
}

function scrollToCursor(): void {
  void nextTick(() => list.value?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }))
}
function move(delta: number): void {
  const n = rows.value.length
  if (!n) return
  cursor.value = (cursor.value + delta + n) % n
  scrollToCursor()
}

/**
 * How far up the menu may grow: to the nearest ancestor that clips, or the
 * window — Picker's rule, for the same reason. It opens upward because the
 * composer sits at the foot of the window.
 */
function measure(): void {
  const el = root.value
  if (!el) return
  let ceiling = 0
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY !== 'visible') {
      ceiling = Math.max(ceiling, p.getBoundingClientRect().top)
      break
    }
  }
  room.value = Math.min(420, Math.max(160, el.getBoundingClientRect().top - ceiling - 13))
}

function onDown(e: MouseEvent): void {
  if (!root.value?.contains(e.target as Node)) open.value = false
}
/** Innermost layer first — see OverflowMenu for why this is the immediate form. */
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopImmediatePropagation()
    open.value = false
  }
}

// Opened on the one chosen, so ↵ straight away keeps it; a search starts at its best hit.
watch(open, (isOpen) => {
  if (isOpen) {
    measure()
    cursor.value = Math.max(0, rows.value.findIndex((r) => r.option.id === props.modelValue))
    void nextTick(() => field.value?.focus())
    scrollToCursor()
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
  } else {
    document.removeEventListener('mousedown', onDown)
    window.removeEventListener('keydown', onKey, true)
  }
})
watch(query, () => {
  cursor.value = 0
  if (list.value) list.value.scrollTop = 0
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDown)
  window.removeEventListener('keydown', onKey, true)
})
</script>

<template>
  <div ref="root" class="mp">
    <button class="trigger" :class="{ open }" @click="toggle">
      <span class="lbl">Memory</span>
      <span class="val">{{ current?.label }}</span>
      <ChevronDown class="chev" />
    </button>

    <div v-if="open" class="menu mmenu" :style="{ maxHeight: room + 'px' }">
      <input
        ref="field"
        v-model="query"
        class="find"
        type="text"
        spellcheck="false"
        autocomplete="off"
        placeholder="Find a memory…"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="pick(rows[cursor]?.option)"
      >

      <div ref="list" class="rows">
        <template v-for="(r, i) in rows" :key="r.option.id">
          <span v-if="!searching && i === fixed && rows.length > fixed" class="sec">memories</span>
          <button
            :class="{ on: i === cursor }"
            :disabled="r.option.disabled"
            @mousemove="cursor = i"
            @click="pick(r.option)"
          >
            <Check class="tick" :class="{ hidden: r.option.id !== modelValue }" />
            <span class="nm">
              <span
                v-for="(part, j) in highlight(r.option.label, r.positions)"
                :key="j"
                :class="{ hit: part.hit }"
                >{{ part.text }}</span
              >
            </span>
            <span v-if="r.option.hint" class="note">{{ r.option.hint }}</span>
          </button>
        </template>
        <p v-if="!rows.length" class="hint">No memory matches “{{ query.trim() }}”</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mp { position: relative; }

/* The chip is Picker's, so it sits in the row as one of them. */
.trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 6px 0 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--inset, var(--bg));
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
}
.trigger:hover, .trigger.open { color: var(--text); border-color: var(--line-strong); background: var(--hover); }
.lbl { color: var(--text-dim); }
.val {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  font-weight: 550;
}
.chev { width: 11px; height: 11px; color: var(--text-dim); }

/* BranchMenu's numbers, upward. */
.mmenu {
  bottom: calc(100% + 5px);
  left: 0;
  width: 320px;
  padding: 6px;
}
.find {
  flex: none;
  height: 30px;
  margin-bottom: 5px;
  padding: 0 9px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  font-size: var(--fs-sm);
  font-family: var(--font);
}
.find:focus { outline: none; border-color: var(--focus-ring); }
.find::placeholder { color: var(--text-dim); }

.rows {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.rows > button { flex: none; width: 100%; min-width: 0; height: 26px; }
/* The cursor is the hover: the keys and the mouse move the same mark. */
.rows > button.on { background: var(--hover); color: var(--text); }
.menu button .tick { width: 12px; height: 12px; color: var(--accent); }
.tick.hidden { visibility: hidden; }
.nm { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm .hit { color: var(--text); font-weight: 600; }
.note { flex: none; margin-left: auto; padding-left: 12px; font-size: 11px; color: var(--text-dim); }
.sec {
  padding: 8px 9px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.hint { margin: 0; padding: 10px 9px; font-size: var(--fs-xs); color: var(--text-dim); }
</style>
