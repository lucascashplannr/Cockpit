<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronDown, ChevronRight } from '@lucide/vue'
import type { EngineModel } from '@cockpit/shared'

/**
 * Which model, by its full name.
 *
 * The newest of each family is the everyday choice, so those are the list —
 * one row each, a digit to reach them. Every older version is one level down,
 * under More models: there for the day a newer model does worse on something
 * the previous one handled, and out of the way on every other day.
 */
const props = defineProps<{
  /** Only the models the installed engine accepts, newest first per family. */
  models: EngineModel[]
  modelValue?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const open = ref(false)
const more = ref(false)
const root = ref<HTMLElement | null>(null)

/** The first of each family — the list is already newest first. */
const latest = computed(() => {
  const seen = new Set<string>()
  return props.models.filter((m) => !seen.has(m.family) && seen.add(m.family))
})
const older = computed(() => props.models.filter((m) => !latest.value.includes(m)))

/**
 * What is chosen. A bare alias (`opus`, as stored before versions were
 * offered) is that family's newest, which is what the engine resolves it to.
 */
const selected = computed(
  () =>
    props.models.find((m) => m.id === props.modelValue) ??
    latest.value.find((m) => m.family === props.modelValue),
)
const inMore = computed(() => !!selected.value && older.value.includes(selected.value))

function pick(m: EngineModel): void {
  emit('update:modelValue', m.id)
  open.value = false
}

/* ── open and close, the same rules as Picker ─────────────────────────── */

function onDocDown(ev: MouseEvent): void {
  if (!root.value?.contains(ev.target as Node)) open.value = false
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    if (more.value) more.value = false
    else open.value = false
    return
  }
  const n = Number(ev.key)
  const m = Number.isInteger(n) && n >= 1 ? latest.value[n - 1] : undefined
  if (m && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
    ev.preventDefault()
    pick(m)
  }
}
watch(open, (isOpen) => {
  more.value = false
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
    <button class="trigger" :class="{ open }" :aria-expanded="open" @click="open = !open">
      <span class="val">{{ selected?.label ?? modelValue }}</span>
      <ChevronDown class="chev" />
    </button>

    <!-- Upward: the composer sits at the foot of the window. -->
    <ul v-if="open" class="menu">
      <li v-for="(m, i) in latest" :key="m.id">
        <button class="item" :class="{ on: m === selected }" @click="pick(m)" @mouseenter="more = false">
          <span class="name">{{ m.label }}</span>
          <Check v-if="m === selected" class="tick" />
          <span v-else class="key">{{ i + 1 }}</span>
        </button>
      </li>

      <template v-if="older.length">
        <li class="rule" />
        <li class="sub">
          <button
            class="item"
            :class="{ on: inMore, hot: more }"
            aria-haspopup="menu"
            :aria-expanded="more"
            @click="more = !more"
            @mouseenter="more = true"
          >
            <span class="name">More models</span>
            <!-- Chosen from down there, the choice still shows up here: a tick
                 on a closed submenu is otherwise a tick nobody can see. -->
            <span v-if="inMore" class="current">{{ selected?.label }}</span>
            <ChevronRight class="chev-r" />
          </button>

          <ul v-if="more" class="menu side">
            <li v-for="m in older" :key="m.id">
              <button class="item" :class="{ on: m === selected }" @click="pick(m)">
                <span class="name">{{ m.label }}</span>
                <Check v-if="m === selected" class="tick" />
              </button>
            </li>
          </ul>
        </li>
      </template>
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
.val { color: var(--text); font-weight: 550; }
.chev { width: 11px; height: 11px; color: var(--text-dim); }

.menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 5px);
  z-index: 10;
  margin: 0;
  padding: 4px;
  width: max-content;
  min-width: 180px;
  list-style: none;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--panel-raised);
  box-shadow: var(--shadow-sm);
}

/* Beside its row, bottoms aligned: the parent opens upward, so this one grows
   upward too instead of running off the foot of the window. */
.sub { position: relative; }
.menu.side {
  left: calc(100% + 8px);
  bottom: -5px;
  min-width: 140px;
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
.item.on { color: var(--text); }
.item.hot { background: var(--hover); color: var(--text); }
.name { flex: none; }

/* The right edge is one column: a tick for what is chosen, the digit that
   chooses everything else. */
.tick, .key, .chev-r { margin-left: auto; }
/* Two classes deep, to outrank the global `.menu button .lucide` tint. */
.item .tick { width: 13px; height: 13px; flex: none; color: var(--accent); }
.key {
  padding-left: 18px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
}
.current { margin-left: auto; padding-left: 18px; font-size: 11px; color: var(--text-dim); }
.current + .chev-r { margin-left: 0; }
.chev-r { width: 12px; height: 12px; flex: none; }
.item .chev-r { color: var(--text-dim); }

.rule { height: 1px; margin: 4px 6px; background: var(--line); }
</style>
