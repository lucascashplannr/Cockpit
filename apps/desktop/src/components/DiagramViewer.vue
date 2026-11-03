<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Minus, Plus, X } from '@lucide/vue'
import { state } from '../core/store.js'

/**
 * A Mermaid diagram from a markdown preview, full-window, to be read.
 *
 * In the preview a diagram is fitted to the 780px measure, and an architecture
 * drawing is often three times that wide — fine for its shape, too small for
 * its words. Here it opens fitted to the window and can be zoomed (pinch, or
 * ⌘/Ctrl + wheel, or the buttons) around the pointer and moved (scroll, or
 * drag). Clicking the percentage fits it again.
 *
 * Escape is handled in `App.vue` with the rest of the layers.
 */
const svg = computed(() => state.diagramView)
const stage = ref<HTMLElement | null>(null)
const canvas = ref<HTMLElement | null>(null)

const scale = ref(1)
const x = ref(0)
const y = ref(0)
let size = { w: 0, h: 0 }

const MIN = 0.1
const MAX = 8

function close(): void {
  state.diagramView = null
}

function fit(): void {
  const el = stage.value
  if (!el || !size.w) return
  const pad = 32
  const s = Math.min((el.clientWidth - pad * 2) / size.w, (el.clientHeight - pad * 2) / size.h, 2)
  scale.value = s
  x.value = (el.clientWidth - size.w * s) / 2
  y.value = (el.clientHeight - size.h * s) / 2
}

/** Zoom by `f` keeping the point (cx, cy) of the stage where it is. */
function zoomAt(f: number, cx: number, cy: number): void {
  const s = scale.value
  const next = Math.min(MAX, Math.max(MIN, s * f))
  x.value = cx - ((cx - x.value) * next) / s
  y.value = cy - ((cy - y.value) * next) / s
  scale.value = next
}

function zoomCentre(f: number): void {
  const el = stage.value
  if (el) zoomAt(f, el.clientWidth / 2, el.clientHeight / 2)
}

// A trackpad pinch arrives as a wheel event with ctrlKey set; a two-finger
// scroll as a plain one. The mouse wheel needs ⌘ or Ctrl to zoom.
function onWheel(e: WheelEvent): void {
  if (e.ctrlKey || e.metaKey) {
    const r = stage.value!.getBoundingClientRect()
    zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top)
  } else {
    x.value -= e.deltaX
    y.value -= e.deltaY
  }
}

let drag: { id: number; x: number; y: number } | null = null
const dragging = ref(false)
function onDown(e: PointerEvent): void {
  if (e.button !== 0) return
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
  dragging.value = true
  stage.value?.setPointerCapture(e.pointerId)
}
function onMove(e: PointerEvent): void {
  if (!drag || drag.id !== e.pointerId) return
  x.value += e.clientX - drag.x
  y.value += e.clientY - drag.y
  drag.x = e.clientX
  drag.y = e.clientY
}
function onUp(e: PointerEvent): void {
  if (drag?.id !== e.pointerId) return
  drag = null
  dragging.value = false
}

// The SVG comes sized to fit its old column (`width="100%"` and a max-width);
// here it is drawn at its own size and the transform does the scaling.
watch(svg, (markup) => {
  if (!markup) return
  void nextTick(() => {
    const el = canvas.value?.querySelector('svg')
    if (!el) return
    const vb = el.viewBox.baseVal
    size = { w: vb?.width || el.getBBox().width, h: vb?.height || el.getBBox().height }
    el.setAttribute('width', String(size.w))
    el.setAttribute('height', String(size.h))
    el.style.maxWidth = 'none'
    fit()
  })
})

const percent = computed(() => Math.round(scale.value * 100) + '%')
</script>

<template>
  <div v-if="svg" class="scrim viewer" @mousedown.self="close">
    <button class="out" title="Close — or press Escape" @click="close">
      <X class="md" />
    </button>

    <div
      ref="stage"
      class="stage"
      :class="{ grabbing: dragging }"
      @wheel.prevent="onWheel"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @dblclick="fit"
    >
      <div
        ref="canvas"
        class="canvas"
        :style="{ transform: `translate(${x}px, ${y}px) scale(${scale})` }"
        v-html="svg"
      />
      <div class="zoom" @pointerdown.stop @dblclick.stop>
        <button title="Zoom out" @click="zoomCentre(1 / 1.25)"><Minus class="sm" /></button>
        <button class="pct mono" title="Fit to the window" @click="fit">{{ percent }}</button>
        <button title="Zoom in" @click="zoomCentre(1.25)"><Plus class="sm" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The same layer as the attachment viewer, for the same reasons: above the
   dialogs, and out of the window's drag regions. */
.scrim {
  -webkit-app-region: no-drag;
  position: fixed;
  inset: 0;
  z-index: 70;
  background: var(--scrim);
  backdrop-filter: blur(6px) saturate(1.1);
  animation: fade var(--dur-2) var(--ease-soft);
}
.scrim * { -webkit-app-region: no-drag; }
@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* A solid sheet: a diagram's hairlines on a blurred scrim cannot be read.
   Clear of the traffic lights at the top. */
.stage {
  position: absolute;
  inset: 56px 24px 24px;
  overflow: hidden;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line-strong);
  background: var(--surface-review);
  box-shadow: var(--shadow-lg);
  cursor: grab;
  touch-action: none;
}
.stage.grabbing { cursor: grabbing; }

.canvas {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.canvas :deep(svg) { display: block; }

.zoom {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: var(--panel-raised);
  border: 1px solid var(--line-strong);
  box-shadow: var(--shadow-sm);
  cursor: default;
}
.zoom button {
  display: grid;
  place-items: center;
  min-width: 28px;
  height: 26px;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--text-muted);
}
.zoom button:hover { color: var(--text); background: var(--hover); }
.zoom .pct { min-width: 52px; font-size: var(--fs-xs); }

.out {
  position: fixed;
  top: 12px;
  right: 14px;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--panel-raised);
  border: 1px solid var(--line-strong);
  color: var(--text-muted);
  box-shadow: var(--shadow-sm);
}
.out:hover { color: var(--text); background: var(--hover); }
</style>
