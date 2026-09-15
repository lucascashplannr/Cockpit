<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronDown } from '@lucide/vue'
import type { Option } from './Picker.vue'

/**
 * Effort, as a dial rather than a list.
 *
 * The levels are ordered — each one trades speed for thought a notch further
 * than the last — and a menu of rows hides that. A track from Faster to
 * Smarter says it without a word; the one line under it says what the chosen
 * notch is for, so nothing has to be hovered to find out.
 */
const props = defineProps<{
  options: Option[]
  modelValue?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const track = ref<HTMLElement | null>(null)

const index = computed(() => Math.max(0, props.options.findIndex((o) => o.id === props.modelValue)))
const current = computed(() => props.options[index.value])
const last = computed(() => Math.max(1, props.options.length - 1))
/** Percent along the rail, a stop at either end. */
const pos = (i: number): number => (i / last.value) * 100

function set(i: number): void {
  const o = props.options[Math.min(props.options.length - 1, Math.max(0, i))]
  if (o && !o.disabled && o.id !== props.modelValue) emit('update:modelValue', o.id)
}

/* ── dragging ─────────────────────────────────────────────────────────── */

function fromPointer(ev: PointerEvent): void {
  const el = track.value
  const rail = el?.firstElementChild as HTMLElement | null
  if (!rail) return
  // Measured against the rail, not the track: the end stops sit inside the
  // track's padding, where the thumb has room to be fully drawn.
  const r = rail.getBoundingClientRect()
  const t = (ev.clientX - r.left) / Math.max(1, r.width)
  set(Math.round(Math.min(1, Math.max(0, t)) * last.value))
}
function onDown(ev: PointerEvent): void {
  ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
  fromPointer(ev)
}
function onMove(ev: PointerEvent): void {
  if ((ev.currentTarget as HTMLElement).hasPointerCapture(ev.pointerId)) fromPointer(ev)
}
function onTrackKey(ev: KeyboardEvent): void {
  const step: Record<string, number> = {
    ArrowLeft: -1, ArrowDown: -1, PageDown: -1,
    ArrowRight: 1, ArrowUp: 1, PageUp: 1,
  }
  if (ev.key in step) set(index.value + step[ev.key]!)
  else if (ev.key === 'Home') set(0)
  else if (ev.key === 'End') set(last.value)
  else if (ev.key === 'Enter') close()
  else return
  ev.preventDefault()
}

/* ── open and close, the same rules as Picker ─────────────────────────── */

function close(): void {
  open.value = false
  trigger.value?.focus()
}
function onDocDown(ev: MouseEvent): void {
  if (!root.value?.contains(ev.target as Node)) open.value = false
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') close()
}
watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    // Straight onto the track, so the arrows work without a second click.
    void nextTick(() => track.value?.focus({ preventScroll: true }))
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
  <div ref="root" class="effort">
    <button
      ref="trigger"
      class="trigger"
      :class="{ open }"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="lbl">Effort</span>
      <span class="val">{{ current?.label }}</span>
      <ChevronDown class="chev" />
    </button>

    <!-- Upward, like the other pickers: the composer is at the foot of the window. -->
    <div v-if="open" class="panel" role="dialog" aria-label="Effort">
      <div class="head">
        <span class="lbl">Effort</span>
        <span class="val">{{ current?.label }}</span>
      </div>

      <div class="ends">
        <span>Faster</span>
        <span>Smarter</span>
      </div>

      <div
        ref="track"
        class="track"
        role="slider"
        tabindex="0"
        aria-label="Effort"
        :aria-valuemin="0"
        :aria-valuemax="last"
        :aria-valuenow="index"
        :aria-valuetext="current?.label"
        @pointerdown="onDown"
        @pointermove="onMove"
        @keydown="onTrackKey"
      >
        <div class="rail">
          <div class="fill" :style="{ width: `calc(${pos(index)}% + 2 * var(--pad))` }" />
          <span
            v-for="(o, i) in options"
            v-show="i !== index"
            :key="o.id"
            class="dot"
            :style="{ left: `${pos(i)}%` }"
          />
          <span class="thumb" :style="{ left: `${pos(index)}%` }" />
        </div>
      </div>

      <!-- Always drawn, empty or not: the panel must not change height as the
           thumb crosses a level with nothing to say. -->
      <p class="note">{{ current?.hint ?? '' }}</p>
    </div>
  </div>
</template>

<style scoped>
.effort { position: relative; }

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
.lbl { color: var(--text-dim); }
.val { color: var(--text); font-weight: 550; }
.chev { width: 11px; height: 11px; color: var(--text-dim); }

/* A floating panel, drawn as the drawer and the menus are. */
.panel {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 60;
  width: 248px;
  padding: 12px 12px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--overlay);
  box-shadow: var(--shadow-md);
  transform-origin: bottom left;
  animation: rise var(--dur-2) var(--ease);
}
@keyframes rise {
  from { transform: translateY(6px) scale(0.985); opacity: 0; }
  to { transform: none; opacity: 1; }
}

.head {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: var(--fs-sm);
  letter-spacing: var(--track-tight);
}
.head .val { font-weight: 600; }

.ends {
  display: flex;
  justify-content: space-between;
  margin: 14px 0 6px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}

/* The segmented control's well, with one thumb sliding along it. */
.track {
  /* Half the thumb plus its inset: at either end the thumb sits as far from
     the edge as from the top. */
  --pad: 13px;
  position: relative;
  height: 26px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  overflow: hidden;
  cursor: pointer;
  touch-action: none;
}
.track:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

.rail { position: absolute; inset: 0 var(--pad); }

.fill {
  position: absolute;
  inset: 0 auto 0 calc(-1 * var(--pad));
  border-radius: 0 5px 5px 0;
  background: var(--accent-soft);
  transition: width var(--dur-1) var(--ease-soft);
  pointer-events: none;
}

.dot {
  position: absolute;
  top: 50%;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--text-dim);
  opacity: 0.7;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  width: 20px;
  border-radius: 5px;
  /* The accent marks what is chosen, as Picker's tick does. */
  background: var(--accent);
  box-shadow: var(--shadow-xs);
  transform: translateX(-50%);
  transition: left var(--dur-1) var(--ease-soft);
  pointer-events: none;
}

.note {
  min-height: 1lh;
  margin: 8px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
</style>
