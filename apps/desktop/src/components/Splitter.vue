<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * The line between two panes, made draggable.
 *
 * The three widths were constants in `tokens.css`, which is the right default
 * and the wrong answer: how much room the list needs against the conversation
 * is a property of the work, not of the app — a project of twenty branches
 * wants a wide list, and reading a long diff wants a wide review.
 *
 * It takes rows as well as columns, because the same argument arrived a second
 * time one level down: how tall the file list should be against the commit box
 * under it depends on whether you are picking through forty files or writing
 * three sentences about two. `grows` says which way the pane it belongs to
 * opens up, and that alone decides the axis — a splitter that grows `down` is
 * a horizontal line, and there is no second prop to contradict it.
 *
 * Pointer capture rather than window listeners: the pointer keeps reporting to
 * this element once it is captured, so a fast drag that leaves the 7px strip —
 * or leaves the window entirely — keeps resizing instead of silently letting
 * go halfway.
 */
const props = defineProps<{
  /** Current size of the pane this line belongs to, along its own axis. */
  size: number
  min: number
  max: number
  /**
   * Which way the pane grows when the line is dragged that way. `right` is a
   * column on the left of the line, `left` a column on the right of it; `down`
   * is a row above the line, `up` a row below it.
   */
  grows: 'right' | 'left' | 'down' | 'up'
  label: string
}>()
const emit = defineEmits<{ resize: [number]; done: []; reset: [] }>()

/** Rows and columns differ in three places and this is all three of them. */
const vertical = computed(() => props.grows === 'down' || props.grows === 'up')
/** Dragging towards the far edge — right or down — makes the pane bigger. */
const positive = computed(() => props.grows === 'right' || props.grows === 'down')

const dragging = ref(false)
let start = 0
let startSize = 0

function clamp(n: number): number {
  return Math.min(props.max, Math.max(props.min, Math.round(n)))
}

function down(e: PointerEvent): void {
  dragging.value = true
  start = vertical.value ? e.clientY : e.clientX
  startSize = props.size
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}

function move(e: PointerEvent): void {
  if (!dragging.value) return
  const delta = (vertical.value ? e.clientY : e.clientX) - start
  emit('resize', clamp(positive.value ? startSize + delta : startSize - delta))
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
  const [less, more] = vertical.value ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']
  const sign = positive.value ? 1 : -1
  if (e.key === less) emit('resize', clamp(props.size - step * sign))
  else if (e.key === more) emit('resize', clamp(props.size + step * sign))
  else return
  e.preventDefault()
  emit('done')
}
</script>

<template>
  <div
    class="splitter"
    :class="[vertical ? 'y' : 'x', { dragging }]"
    :title="label + ' — drag, or double-click for the default'"
    role="separator"
    :aria-orientation="vertical ? 'horizontal' : 'vertical'"
    :aria-label="label"
    :aria-valuenow="size"
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
/* Seven pixels to grab, one pixel to look at: the divider the eye sees is the
   pane's own border, and this sits over it. */
.splitter {
  z-index: 6;
  /* The window is dragged by its background now that there is no band; a
     splitter that inherited that would move the window instead of the pane. */
  -webkit-app-region: no-drag;
}
/* A column line is placed by the shell over the boundary it thickens. A row
   line sits in its own layout and pulls itself back over the border above it,
   which is why one is absolute and the other is not. */
.splitter.x {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 7px;
  cursor: col-resize;
}
.splitter.y {
  position: relative;
  flex: none;
  height: 7px;
  margin: -3px 0 -4px;
  cursor: row-resize;
}
.hit {
  position: absolute;
  border-radius: 1px;
  background: transparent;
  transition: background var(--dur-1) var(--ease-soft);
}
.x .hit { inset: 0 3px; }
.y .hit { inset: 3px 0; }
.splitter:hover .hit,
.splitter:focus-visible .hit,
.splitter.dragging .hit { background: var(--accent); }
.splitter:focus-visible { outline: none; }
</style>
