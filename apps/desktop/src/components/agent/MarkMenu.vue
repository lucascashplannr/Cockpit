<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { keepMarkMenu, leaveMarkMenu, markMenu, openMarkDialog, state } from '../../core/store.js'

/**
 * A note, read: from wherever it is shown (the line over a conversation's
 * composer, a topic's badge on the bar, its note glyph in the list). Only the
 * note; the status is already on the thing that opened it. Clicked, the note
 * opens the sheet (MarkDialog) that changes it, the way a field takes a click.
 *
 * Reading and setting were one menu for a while; a note is read far more
 * often than it is set, and the menu made every reading a form.
 */

const conv = computed(() =>
  markMenu.id && markMenu.on === 'conversation'
    ? ([...state.agents, ...state.keptAgents].find((c) => c.id === markMenu.id) ?? null)
    : null,
)
const topic = computed(() =>
  markMenu.id && markMenu.on === 'topic' ? (state.topics.find((t) => t.id === markMenu.id) ?? null) : null,
)
/** What it is about, whichever it is: its name and what is on it now. */
const target = computed(() =>
  conv.value
    ? { name: conv.value.title || 'Untitled', mark: conv.value.mark ?? null }
    : topic.value
      ? { name: topic.value.name, mark: topic.value.mark ?? null }
      : null,
)

const root = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0 })

watch(
  () => markMenu.id,
  async (id) => {
    if (!id) return
    pos.value = { left: markMenu.x, top: markMenu.y }
    await nextTick()
    const el = root.value
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    pos.value = {
      left: markMenu.x + r.width + pad > window.innerWidth ? Math.max(pad, markMenu.x - r.width) : markMenu.x,
      top: markMenu.y + r.height + pad > window.innerHeight ? Math.max(pad, markMenu.y - r.height) : markMenu.y,
    }
  },
  { immediate: true },
)

function close(): void {
  markMenu.id = null
}

function edit(): void {
  if (markMenu.id) openMarkDialog(markMenu.on, markMenu.id)
}

function onDown(e: MouseEvent): void {
  if (markMenu.id && root.value && !root.value.contains(e.target as Node)) close()
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && markMenu.id) {
    e.stopImmediatePropagation()
    close()
  }
}
function onLeave(): void {
  if (markMenu.id) close()
}
onMounted(() => {
  document.addEventListener('mousedown', onDown, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onLeave)
  window.addEventListener('resize', onLeave)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDown, true)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('blur', onLeave)
  window.removeEventListener('resize', onLeave)
})
</script>

<template>
  <div
    v-if="target?.mark?.note"
    ref="root"
    class="menu markmenu"
    role="dialog"
    :aria-label="'Note on ' + target.name"
    :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
    @contextmenu.prevent
    @mouseenter="keepMarkMenu"
    @mouseleave="leaveMarkMenu"
  >
    <button class="rnote" title="Edit the status and note" @click="edit">{{ target.mark.note }}</button>
  </div>
</template>

<style scoped>
/* One card, the window's popup surface like every other menu; like a field,
   the note takes a click to edit. */
.markmenu {
  position: fixed;
  z-index: 55;
  width: 300px;
  padding: 0;
  overflow: hidden;
}
/* A menu's buttons are 30px rows with a hover fill; this one is as tall as
   the note and keeps the card's colour. */
.rnote {
  display: block;
  width: 100%;
  height: auto;
  max-height: 240px;
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: 0;
  background: none;
  font: inherit;
  font-size: var(--fs-sm);
  line-height: 1.5;
  text-align: left;
  color: var(--text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  cursor: text;
}
.markmenu .rnote:hover { background: none; color: var(--text); }
</style>
