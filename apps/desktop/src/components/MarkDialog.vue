<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Layers, MessageSquare, X } from '@lucide/vue'
import type { ConversationMarkKind } from '@cockpit/shared'
import DialogShell from './DialogShell.vue'
import { markIcon } from './agent/mark.js'
import { MARK_WORDS, markConversation, markTopic, state } from '../core/store.js'

/**
 * Where a conversation or a topic stands, and why: set here, read in the
 * popup the pencil came from (MarkMenu), or from "Set a status…" in the
 * right-click menu of a tab, a History row or a topic.
 *
 * Nothing applies until Save. A status clicked again comes off, so a note
 * can stand alone. A conversation's is cleared by the next turn sent; a
 * topic's stays until it is changed here.
 *
 * Unread is not here: it is the list's own mark, not a status, and the same
 * right-click menu has it.
 */

const d = computed(() => state.markDialog)
const conv = computed(() =>
  d.value?.on === 'conversation' ? ([...state.agents, ...state.keptAgents].find((c) => c.id === d.value!.id) ?? null) : null,
)
const topic = computed(() => (d.value?.on === 'topic' ? (state.topics.find((t) => t.id === d.value!.id) ?? null) : null))
const target = computed(() =>
  conv.value
    ? { name: conv.value.title || 'Untitled', mark: conv.value.mark ?? null }
    : topic.value
      ? { name: topic.value.name, mark: topic.value.mark ?? null }
      : null,
)

const CHOICES: ConversationMarkKind[] = ['brainstorm', 'review', 'hold', 'done']

const kind = ref<ConversationMarkKind | null>(null)
const initial = ref<ConversationMarkKind | null>(null)
const note = ref('')
const busy = ref(false)
const noteEl = ref<HTMLTextAreaElement | null>(null)

watch(
  () => state.markDialog,
  async (v) => {
    if (!v) return
    initial.value = target.value?.mark?.kind ?? null
    kind.value = initial.value
    note.value = target.value?.mark?.note ?? ''
    busy.value = false
    await nextTick()
    noteEl.value?.focus()
  },
  { immediate: true },
)

const dirty = computed(() => kind.value !== initial.value || note.value.trim() !== (target.value?.mark?.note ?? '').trim())

function close(): void {
  if (!busy.value) state.markDialog = null
}

function pick(k: ConversationMarkKind): void {
  kind.value = kind.value === k ? null : k
}

async function save(): Promise<void> {
  if (!dirty.value || busy.value) return
  const k = kind.value
  busy.value = true
  let ok = true
  const t = topic.value
  if (t) ok = await markTopic(t.id, { kind: k, note: note.value })
  const c = conv.value
  if (c) ok = await markConversation(c.id, { kind: k, note: note.value })
  busy.value = false
  if (ok) state.markDialog = null
}

async function clear(): Promise<void> {
  if (busy.value) return
  busy.value = true
  let ok = true
  const t = topic.value
  if (t?.mark) ok = await markTopic(t.id, null)
  const c = conv.value
  if (c?.mark) ok = await markConversation(c.id, null)
  busy.value = false
  if (ok) state.markDialog = null
}

function onNoteKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    void save()
  }
}
</script>

<template>
  <DialogShell
    v-if="target"
    :title="'Status of ' + target.name"
    :dismissible="!busy"
    @close="close"
  >
    <template #lead><component :is="topic ? Layers : MessageSquare" class="sm gi" /></template>
    <div class="form">
      <div class="field">
        <span class="lbl">Status</span>
        <div class="seg wide" role="radiogroup" aria-label="Status">
          <button
            v-for="k in CHOICES"
            :key="k"
            role="radio"
            :aria-checked="kind === k"
            :class="['k-' + k, { on: kind === k }]"
            @click="pick(k)"
          >
            <component :is="markIcon(k)" class="mk" />{{ MARK_WORDS[k] }}
          </button>
        </div>
      </div>
      <div class="field">
        <label class="lbl" for="mark-note">Note</label>
        <textarea
          id="mark-note"
          ref="noteEl"
          v-model="note"
          class="input note-in"
          rows="4"
          maxlength="500"
          spellcheck="false"
          placeholder="A note for when you come back"
          @keydown="onNoteKey"
        />
      </div>
    </div>

    <template #foot>
      <button
        v-if="target.mark"
        class="btn ghost"
        :disabled="busy"
        title="Take the status and the note off"
        @click="clear"
      >
        <X class="sm" /> Clear
      </button>
      <span class="grow" />
      <button class="btn ghost" :disabled="busy" @click="close">Cancel</button>
      <button class="btn primary" :disabled="!dirty || busy" title="Save (⌘⏎)" @click="save">Save</button>
    </template>
  </DialogShell>
</template>

<style scoped>
/* TopicDialog's form, to the pixel. */
.grow { flex: 1; }
.gi { color: var(--text-dim); }
/* One choice among a few: the window's segmented control, as in New topic. */
.seg.wide { display: flex; }
.seg.wide > button { flex: 1; justify-content: center; gap: 7px; height: 28px; font-size: var(--fs-sm); --k: var(--text-muted); }
.seg.wide > .k-review { --k: var(--accent); }
.seg.wide > .k-done { --k: var(--ok); }
.seg.wide > .k-brainstorm { --k: var(--info); }
.seg.wide > button .mk { width: 14px; height: 14px; color: var(--k); }
.form { display: flex; flex-direction: column; gap: 20px; padding: 2px 0 16px; }
.field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.lbl { font-size: var(--fs-xs); color: var(--text-muted); }
.lbl[for] { cursor: text; }
.note-in { resize: vertical; min-height: 84px; font: inherit; font-size: var(--fs-sm); line-height: 1.45; }
</style>
