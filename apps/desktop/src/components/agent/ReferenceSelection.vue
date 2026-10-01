<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TextQuote } from '@lucide/vue'
import type { QuoteSource } from '@cockpit/shared'

/**
 * A passage selected in the thread, and the one thing to do with it.
 *
 * "This part, here" used to be said by copying the passage, pasting it into
 * the box and writing around it — three gestures to point at something already
 * on screen, and a prompt that then carried a paragraph of the agent's own
 * words back to it as though they were new. Selecting is the pointing; this is
 * the button that appears where the selection is, and what it hands the box is
 * a reference rather than a copy.
 *
 * It is drawn inside the scroller it is given rather than fixed to the window:
 * the selection scrolls with the thread, and so does this.
 */
const props = defineProps<{
  /** The thread. A selection anywhere else is not this component's business. */
  root: HTMLElement | null
}>()
const emit = defineEmits<{ reference: [text: string, from: QuoteSource] }>()

const el = ref<HTMLElement | null>(null)
const at = ref<{ x: number; y: number } | null>(null)

/** Whose words are selected, if the button were pressed now. */
let from: QuoteSource | null = null
/** The pointer is down, so the selection is still being made. */
let dragging = false

/** The gap between the button and the line it belongs to. */
const GAP = 6

function hide(): void {
  at.value = null
  from = null
}

/**
 * The selection as words: what copying it would take, and nothing else.
 *
 * `Selection.toString()` is not that. It returns every character between the
 * two ends, including the ones the page marks as not content — so a selection
 * running from one paragraph of an answer to the next brought the "Ran 3
 * commands" line between them, and one running into the following turn
 * brought its "2m ago". Copy leaves those out; nothing hands a script the
 * string copy would produce.
 *
 * So the passage is laid out again, off screen, inside a shell of everything
 * it sat in — the shell is what keeps a bubble's line breaks and a code
 * block's indentation, which belong to the elements around the text rather
 * than to the text — and every run the page says cannot be selected is taken
 * out before it is read back. One synchronous step: built, read and removed
 * before anything is painted.
 */
function selectedText(range: Range, root: HTMLElement): string {
  let node: Node = range.cloneContents()
  const top = range.commonAncestorContainer
  let up = top.nodeType === Node.ELEMENT_NODE ? (top as Element) : top.parentElement
  for (; up && up !== root; up = up.parentElement) {
    const shell = up.cloneNode(false)
    shell.appendChild(node)
    node = shell
  }
  const stage = document.createElement('div')
  stage.setAttribute('aria-hidden', 'true')
  stage.style.cssText =
    'position:fixed;left:-99999px;top:0;pointer-events:none;width:' + root.clientWidth + 'px'
  stage.appendChild(node)
  root.appendChild(stage)
  try {
    const walk = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT)
    const drop: Node[] = []
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const inside = t.parentElement
      if (inside && getComputedStyle(inside).userSelect === 'none') drop.push(t)
    }
    for (const t of drop) t.parentNode?.removeChild(t)
    // Where something was taken out, the blank lines either side of it meet.
    return stage.innerText.replace(/\n{3,}/g, '\n\n').trim()
  } finally {
    stage.remove()
  }
}

/**
 * Where the selection is now, and whether it is one this can refer to.
 *
 * Read from the live selection every time rather than remembered: the thread
 * scrolls, the panel resizes, a streamed paragraph lands above it — and the
 * only position that is never stale is the one asked for at the moment of
 * drawing.
 */
function read(): void {
  const sel = window.getSelection()
  const root = props.root
  const me = el.value
  const host = me?.offsetParent
  if (!sel || sel.isCollapsed || !sel.rangeCount || !root || !me || !host) return hide()
  const range = sel.getRangeAt(0)
  const node = range.commonAncestorContainer
  if (!root.contains(node)) return hide()
  // Only whether there is anything there: the words themselves are read when
  // the button is pressed, not on every scroll.
  if (!sel.toString().trim()) return hide()

  // Whose words they are. Inside one half of an exchange it is that half's;
  // across both, or across two turns, it is simply the conversation's.
  const inside = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const said = inside?.closest('[data-said]')?.getAttribute('data-said')
  from = said === 'agent' || said === 'user' ? said : 'thread'

  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
  const first = rects[0]
  const last = rects[rects.length - 1]
  if (!first || !last) return hide()
  const view = root.getBoundingClientRect()
  // Scrolled out of sight: the selection is kept, and this comes back with it.
  if (last.bottom < view.top || first.top > view.bottom) {
    at.value = null
    return
  }
  const frame = host.getBoundingClientRect()
  const w = me.offsetWidth
  const h = me.offsetHeight
  // Over the start of the selection, where the eye was when it began. Under
  // its end instead when the start is above the top of what is showing —
  // and held inside the thread either way, so it is never under the bar.
  let y = first.top - h - GAP
  if (y < view.top + 4) y = last.bottom + GAP
  y = Math.min(Math.max(y, view.top + 4), view.bottom - h - 4)
  const x = Math.min(Math.max(first.left, view.left + 8), view.right - w - 8)
  at.value = { x: x - frame.left, y: y - frame.top }
}

function onDown(ev: MouseEvent): void {
  // Pressing the button is not starting a new selection.
  if (el.value?.contains(ev.target as Node)) return
  dragging = true
  at.value = null
}
function onUp(): void {
  if (!dragging) return
  dragging = false
  // After the click has had its say: a press inside an existing selection only
  // collapses it once the button is released.
  window.setTimeout(read, 0)
}
/** Shift and the arrows select too; a drag in progress is left alone until it ends. */
function onSelection(): void {
  if (!dragging) read()
}

function refer(): void {
  const sel = window.getSelection()
  const root = props.root
  if (!from || !root || !sel?.rangeCount) return
  const text = selectedText(sel.getRangeAt(0), root)
  if (text) emit('reference', text, from)
  // It has been taken: leaving it lit would offer the same passage twice.
  window.getSelection()?.removeAllRanges()
  hide()
}

onMounted(() => {
  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('mouseup', onUp, true)
  document.addEventListener('selectionchange', onSelection)
  window.addEventListener('resize', read)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDown, true)
  document.removeEventListener('mouseup', onUp, true)
  document.removeEventListener('selectionchange', onSelection)
  window.removeEventListener('resize', read)
})

watch(
  () => props.root,
  (now, was) => {
    was?.removeEventListener('scroll', read)
    now?.addEventListener('scroll', read, { passive: true })
  },
  { immediate: true },
)
onBeforeUnmount(() => props.root?.removeEventListener('scroll', read))
</script>

<template>
  <!-- Always in the page and only sometimes visible, so its size can be read
       before it is placed. `mousedown.prevent` is what keeps the selection —
       and the caret in the box below — where they were while it is pressed. -->
  <button
    ref="el"
    class="refsel"
    :class="{ on: at }"
    :style="at ? { left: at.x + 'px', top: at.y + 'px' } : undefined"
    :tabindex="at ? 0 : -1"
    title="Refer to this passage in your message"
    @mousedown.prevent
    @click="refer"
  >
    <TextQuote class="ic" />
    Reference
  </button>
</template>

<style scoped>
/* The weight of "Latest", which floats over the same thread: a raised panel
   and a word. No motion on the way in — it is where the selection is, and
   anything that travelled there would be the window performing. */
.refsel {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--panel-raised);
  box-shadow: var(--shadow-md);
  font-size: var(--fs-xs);
  color: var(--text);
  white-space: nowrap;
  visibility: hidden;
  pointer-events: none;
}
.refsel.on { visibility: visible; pointer-events: auto; }
.refsel:hover { background: var(--hover); }
.ic { width: 13px; height: 13px; flex: none; color: var(--text-muted); }
</style>
