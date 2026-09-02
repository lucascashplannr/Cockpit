<script setup lang="ts">
import { ref } from 'vue'

/**
 * The line between two columns, made draggable.
 *
 * The three widths were constants in `tokens.css`, which is the right default
 * and the wrong answer: how much room the list needs against the conversation
 * is a property of the work, not of the app — a project of twenty branches
 * wants a wide list, and reading a long diff wants a wide review.
 *
 * Pointer capture rather than window listeners: the pointer keeps reporting to
 * this element once it is captured, so a fast drag that leaves the 6px strip —
 * or leaves the window entirely — keeps resizing instead of silently letting
 * go halfway.
 */
const props = defineProps<{
  /** Current width of the column this line belongs to. */
  width: number
  min: number
  max: number
  /**
   * Which way the column grows. `right` is a column on the left of the line
   * (dragging right makes it wider); `left` is a column on the right of it.
   */
  grows: 'right' | 'left'
  label: string
}>()
const emit = defineEmits<{ resize: [number]; done: []; reset: [] }>()

const dragging = ref(false)
let startX = 0
let startW = 0

function clamp(n: number): number {
  return Math.min(props.max, Math.max(props.min, Math.round(n)))
}

function down(e: PointerEvent): void {
  dragging.value = true
  startX = e.clientX
  startW = props.width
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}

function move(e: PointerEvent): void {
  if (!dragging.value) return
  const delta = e.clientX - startX
  emit('resize', clamp(props.grows === 'right' ? startW + delta : startW - delta))
}

function up(e: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  emit('done')
}

/** The keyboard reaches it too: a splitter nobody can tab to is a mouse-only
 *  control in an app whose shell is otherwise driven from the keyboard. */
function key(e: KeyboardEvent): void {
  const step = e.shiftKey ? 40 : 8
  const sign = props.grows === 'right' ? 1 : -1
  if (e.key === 'ArrowLeft') emit('resize', clamp(props.width - step * sign))
  else if (e.key === 'ArrowRight') emit('resize', clamp(props.width + step * sign))
  else return
  e.preventDefault()
  emit('done')
}
</script>

<template>
  <div
    class="splitter"
    :class="{ dragging }"
    :title="label + ' — drag, or double-click for the default'"
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuenow="width"
    :aria-valuemin="min"
    :aria-valuemax="max"
    tabindex="0"
    @pointerdown="down"
    @pointermove="move"
    @pointerup="up"
    @pointercancel="up"
    @keydown="key"
    @dblclick="emit('reset')"
  >
    <span class="hit" />
  </div>
</template>

<style scoped>
/* Six pixels wide to grab, one pixel wide to look at: the divider the eye sees
   is the column's own border, and this sits over it. */
.splitter {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 7px;
  z-index: 6;
  cursor: col-resize;
  /* The window is dragged by its background now that there is no band; a
     splitter that inherited that would move the window instead of the column. */
  -webkit-app-region: no-drag;
}
.hit {
  position: absolute;
  inset: 0 3px;
  border-radius: 1px;
  background: transparent;
  transition: background var(--dur-1) var(--ease-soft);
}
.splitter:hover .hit,
.splitter:focus-visible .hit,
.splitter.dragging .hit { background: var(--accent); }
.splitter:focus-visible { outline: none; }
/* While dragging, the line stays lit even as the pointer runs ahead of it. */
.splitter.dragging { cursor: col-resize; }
</style>
