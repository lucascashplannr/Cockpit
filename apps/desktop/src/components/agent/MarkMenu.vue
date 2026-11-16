<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from '@lucide/vue'
import type { ConversationMarkKind } from '@cockpit/shared'
import { markIcon } from './mark.js'
import { attentionIcon } from './attention.js'
import {
  attentionOf, isBusy, MARK_WORDS, markConversation, markMenu, markThreadRead, markThreadUnread, state,
} from '../../core/store.js'

/**
 * Where a person says a conversation stands, and why — at the pointer, from
 * its tab or from the line over its composer.
 *
 * Nothing applies until Save (or ⏎ in the note): a tile clicked is only
 * chosen, and the note gets the caret, because "on hold" is most often
 * followed by the reason. Leaving the menu any other way drops the draft.
 *
 * Unread is one of the tiles, though it is not kept with the others: it is
 * the list's own unread mark (the rows' "Mark as unread"), so it lights the
 * rail and the list the same way and goes out the same way, when the thread
 * is next brought up.
 */

const conv = computed(() =>
  markMenu.id ? ([...state.agents, ...state.keptAgents].find((c) => c.id === markMenu.id) ?? null) : null,
)
type Choice = ConversationMarkKind | 'unread'
const CHOICES: Choice[] = ['unread', 'review', 'hold', 'done']
const WORDS: Record<Choice, string> = { unread: 'Unread', ...MARK_WORDS }
const iconOf = (k: Choice) => (k === 'unread' ? attentionIcon('reply') : markIcon(k))

/**
 * Unread is there to choose only when the thread could be read or unread: not
 * while it is working, asking you something, or removed.
 */
const canUnread = computed(() => {
  const c = conv.value
  if (!c || c.hiddenAt !== null || isBusy(c)) return false
  const a = attentionOf(c)
  return a === 'none' || a === 'reply'
})

const root = ref<HTMLElement | null>(null)
const noteEl = ref<HTMLTextAreaElement | null>(null)
const note = ref('')
/** The tile chosen in the menu, not yet saved, and the one lit when it opened. */
const kind = ref<Choice | null>(null)
const initial = ref<Choice | null>(null)
const pos = ref({ left: 0, top: 0 })

watch(
  () => markMenu.id,
  async (id) => {
    if (!id) return
    note.value = conv.value?.mark?.note ?? ''
    const c = conv.value
    initial.value = c?.mark?.kind ?? (c && attentionOf(c) === 'reply' && !isBusy(c) ? 'unread' : null)
    kind.value = initial.value
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

/** Something chosen or typed that differs from what is saved. */
const dirty = computed(
  () => kind.value !== initial.value || note.value.trim() !== (conv.value?.mark?.note ?? '').trim(),
)

function save(): void {
  const c = conv.value
  if (c && dirty.value) {
    const k = kind.value === 'unread' ? null : kind.value
    const m = c.mark
    if (k !== (m?.kind ?? null) || note.value.trim() !== (m?.note ?? '').trim()) {
      void markConversation(c.id, { kind: k, note: note.value })
    }
    if (kind.value === 'unread' && initial.value !== 'unread') markThreadUnread(c)
    if (kind.value !== 'unread' && initial.value === 'unread') markThreadRead(c)
  }
  close()
}

function pick(k: Choice): void {
  // The one chosen, clicked again, comes off; the note stays.
  kind.value = kind.value === k ? null : k
  void nextTick(() => noteEl.value?.focus())
}

function clear(): void {
  const c = conv.value
  if (c?.mark) void markConversation(c.id, null)
  if (c && initial.value === 'unread') markThreadRead(c)
  close()
}

function onNoteKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    save()
  }
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
    v-if="conv"
    ref="root"
    class="menu markmenu"
    role="menu"
    :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
    @contextmenu.prevent
  >
    <!-- Named, so it says which conversation it is about. -->
    <div class="mhead">
      <b :title="conv.title">{{ conv.title || 'Untitled' }}</b>
    </div>
    <span class="rule" />
    <div class="chips" role="radiogroup" aria-label="Status">
      <button
        v-for="k in CHOICES"
        :key="k"
        role="radio"
        :aria-checked="kind === k"
        :class="['k-' + k, { on: kind === k }]"
        :disabled="k === 'unread' && !canUnread && initial !== 'unread'"
        @click="pick(k)"
      >
        <component :is="iconOf(k)" class="mk" />
        {{ WORDS[k] }}
      </button>
    </div>
    <textarea
      ref="noteEl"
      v-model="note"
      class="note-in"
      rows="2"
      maxlength="500"
      spellcheck="false"
      placeholder="A note for when you come back"
      @keydown="onNoteKey"
    />
    <div class="mfoot">
      <button v-if="conv.mark || initial === 'unread'" class="clr" title="Take the status and the note off" @click="clear"><X /> Clear</button>
      <button class="btn primary save" :disabled="!dirty" @click="save">Save</button>
    </div>
  </div>
</template>

<style scoped>
.markmenu { position: fixed; z-index: 55; width: 300px; }
/* Clear on the left, Save on the right, under the note. */
.mfoot { display: flex; align-items: center; gap: 6px; margin: 4px 2px 1px; }
.mfoot .save { margin-left: auto; height: 28px; padding: 0 14px; justify-content: center; }
.mfoot .clr { height: 28px; }
/* Edge to edge: the menu's padding is for its rows, not its rules. */
.markmenu .rule { margin: 4px -5px; }

.mhead { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 9px; font-size: var(--fs-sm); }
.mhead b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--text); }

/* Four tiles, one chosen: a choice to make, then Save — not four acts. */
.chips { display: flex; gap: 4px; margin: 2px 2px 4px; }
.chips button {
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  height: 52px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 11px;
  background: var(--tab-rest);
  box-shadow: inset 0 0 0 1px var(--line-soft);
  --k: var(--text-muted);
}
.chips .k-unread { --k: var(--agent); }
.chips .k-review { --k: var(--accent); }
.chips .k-done { --k: var(--ok); }
.chips button .mk { width: 15px; height: 15px; color: var(--k); }
.chips button:hover:not(:disabled) .mk { color: var(--k); }
.chips button.on,
.chips button.on:hover:not(:disabled) {
  color: var(--text);
  font-weight: 600;
  background: color-mix(in srgb, var(--k) 14%, transparent);
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--k) 55%, transparent);
}
.note-in {
  margin: 2px;
  padding: 7px 9px;
  resize: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-work);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sm);
  line-height: 1.4;
  outline: 0;
}
.note-in:focus { border-color: var(--accent); }
.note-in::placeholder { color: var(--text-dim); }
</style>
