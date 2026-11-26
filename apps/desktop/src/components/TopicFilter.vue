<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, Circle, ListFilter } from '@lucide/vue'
import { markIcon } from './agent/mark.js'
import {
  hiddenTopicKinds, MARK_WORDS, showAllTopicKinds, soloTopicKind, toggleTopicKind,
  TOPIC_FILTER_KINDS, topicFilterKind, workspaceGroups,
} from '../core/store.js'
import type { TopicFilterKind } from '../core/store.js'

/**
 * Which topics and repositories the list shows, by the status set on them. In the list's own
 * header, beside the width toggle: it is about the column, like that one.
 * Lit while something is left out, so a short list never passes for a whole one.
 */

const props = defineProps<{ hidden: number }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLElement | null>(null)
const place = ref<Record<string, string>>({})

const filtering = computed(() => TOPIC_FILTER_KINDS.some((k) => hiddenTopicKinds[k]))

/** How many of the list's topics carry each status: the menu's right-hand column. */
const counts = computed(() => {
  const out: Record<TopicFilterKind, number> = { none: 0, brainstorm: 0, review: 0, hold: 0, done: 0 }
  for (const g of workspaceGroups.value) {
    if (g.topicId) out[topicFilterKind(g.topic)]++
    else for (const w of g.workspaces) if (w.kind === 'main') out[w.mark?.kind ?? 'none']++
  }
  return out
})

const word = (k: TopicFilterKind) => (k === 'none' ? 'No status' : MARK_WORDS[k])
const icon = (k: TopicFilterKind) => (k === 'none' ? Circle : markIcon(k))

const tip = computed(() => {
  if (!filtering.value) return 'Filter by status'
  const shown = TOPIC_FILTER_KINDS.filter((k) => !hiddenTopicKinds[k]).map(word)
  return (shown.length ? 'Showing ' + shown.join(', ') : 'Showing nothing') +
    (props.hidden ? '\n' + props.hidden + ' hidden' : '')
})

function toggle(): void {
  open.value = !open.value
  if (!open.value || !trigger.value) return
  const r = trigger.value.getBoundingClientRect()
  place.value = {
    position: 'fixed',
    top: r.bottom + 4 + 'px',
    // Under the button, right edges aligned: the list's own width, not over the work beside it.
    left: Math.max(8, r.right - 220) + 'px',
  }
}

function pick(e: MouseEvent, k: TopicFilterKind): void {
  if (e.altKey) soloTopicKind(k)
  else toggleTopicKind(k)
}

function onDown(e: MouseEvent): void {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) {
    e.stopImmediatePropagation()
    open.value = false
  }
}
function onResize(): void {
  open.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDown)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDown)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <span ref="root" class="tf">
    <button
      ref="trigger"
      class="icon-btn"
      :class="{ on: open, lit: filtering && !open }"
      :title="tip"
      aria-label="Filter by status"
      :aria-expanded="open"
      @click="toggle"
    >
      <ListFilter class="sm" />
    </button>

    <div v-if="open" class="menu tmenu" :style="place" role="menu">
      <button
        v-for="k in TOPIC_FILTER_KINDS"
        :key="k"
        role="menuitemcheckbox"
        :aria-checked="!hiddenTopicKinds[k]"
        :class="['k-' + k, { off: hiddenTopicKinds[k] }]"
        title="⌥-click to show only these"
        @click="pick($event, k)"
      >
        <component :is="icon(k)" class="kind" />
        <span class="w">{{ word(k) }}</span>
        <span class="n">{{ counts[k] }}</span>
        <Check class="tick" />
      </button>
      <div class="rule" />
      <button :disabled="!filtering" @click="showAllTopicKinds">Show all</button>
    </div>
  </span>
</template>

<style scoped>
.tf { display: inline-flex; margin-right: 4px; -webkit-app-region: no-drag; }
.icon-btn { width: 26px; height: 26px; }
.icon-btn.lit { color: var(--accent); }

.tmenu { min-width: 220px; -webkit-app-region: no-drag; }
.tmenu .w { flex: 1; }
.tmenu .n { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.tmenu .tick { color: var(--accent); }
.tmenu .off .tick { visibility: hidden; }
.tmenu .off .w { color: var(--text-dim); }
/* The status's own ink, as the lid of a topic wears it. */
.tmenu .k-review .kind { color: var(--accent); }
.tmenu .k-done .kind { color: var(--ok); }
.tmenu .k-brainstorm .kind { color: var(--info); }
.tmenu .off .kind { opacity: 0.5; }
</style>
