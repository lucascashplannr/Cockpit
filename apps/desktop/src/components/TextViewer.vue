<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { X } from '@lucide/vue'
import { editDraftText, state } from '../core/store.js'

/**
 * A paste or a file, at the size it takes to read it.
 *
 * The sibling of `ImageViewer`: a 72-pixel tile says *that* 155 lines are
 * attached, and this is where they are read. A paste still in the composer is
 * editable here — trimming the log down to the part that matters is the most
 * common thing to want before sending one — and everything else is read-only,
 * because a sent turn is what was said and a file is someone else's bytes.
 *
 * The name sits at the bottom for the same reason it does under a picture: the
 * top-left corner belongs to the drawn traffic lights. Escape is handled in
 * `App.vue` with the other layers.
 */
const v = computed(() => state.pendingText)
const editable = computed(() => !!v.value?.draftId)
const area = ref<HTMLTextAreaElement | null>(null)

function close(): void {
  state.pendingText = null
}

function edit(ev: Event): void {
  const id = v.value?.draftId
  if (id) editDraftText(id, (ev.target as HTMLTextAreaElement).value)
}

// Focused at the top rather than wherever the browser would put it: the start
// of a paste is where reading it begins.
watch(
  () => v.value?.draftId,
  (id) => {
    if (!id) return
    void nextTick(() => {
      area.value?.focus()
      area.value?.setSelectionRange(0, 0)
      area.value?.scrollTo(0, 0)
    })
  },
)
</script>

<template>
  <div v-if="v" class="scrim" @mousedown.self="close">
    <button class="icon-btn out" title="Close — or press Escape" @click="close">
      <X class="sm" />
    </button>

    <figure class="frame">
      <div class="sheet">
        <textarea
          v-if="editable"
          ref="area"
          class="body selectable"
          spellcheck="false"
          :value="v.text ?? ''"
          @input="edit"
        />
        <pre v-else-if="typeof v.text === 'string'" class="body selectable">{{ v.text }}</pre>
        <p v-else-if="v.text === undefined" class="empty">Loading…</p>
        <p v-else class="empty">This file is not text, so there is nothing to show here.</p>
      </div>
      <figcaption class="cap">
        <span class="name">{{ v.name }}</span>
        <span class="of">{{ v.meta }}</span>
        <span v-if="editable" class="of">· edits go with the message</span>
      </figcaption>
    </figure>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  backdrop-filter: blur(6px) saturate(1.1);
  animation: fade var(--dur-2) var(--ease-soft);
}
@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.frame {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  margin: 0;
  width: min(920px, 92vw);
}

.sheet {
  display: flex;
  height: calc(100vh - 120px);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: var(--panel-raised);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
/* Unwrapped, so an indented line is still the line that was copied. */
.body {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 16px 18px;
  overflow: auto;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--text);
  font-family: var(--mono);
  font-size: var(--fs-xs);
  line-height: 1.6;
  white-space: pre;
  tab-size: 4;
}
.empty {
  margin: auto;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}
/* A file that is not text has one sentence to say, not a page to fill. */
.sheet:has(.empty) { height: 160px; }

.cap {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  color: var(--text);
}
.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
}
.of { flex: none; font-size: var(--fs-xs); color: var(--text-dim); }

.out {
  position: fixed;
  top: 13px;
  right: 14px;
  color: var(--text-muted);
}
.out:hover { color: var(--text); }
</style>
