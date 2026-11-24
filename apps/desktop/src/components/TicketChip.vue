<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Ticket } from '@lucide/vue'
import type { Topic } from '@cockpit/shared'
import TicketCard from './TicketCard.vue'

/**
 * §5 — the ticket a topic was made from, on the bar that names the topic.
 *
 * It was a tool beside the Diff, which gave a few lines of ticket a whole
 * column and a place in ⌘1..n. It is a fact about the topic, so it sits with
 * the other one, the status you set, as a key in a small ring, and the ticket
 * itself opens under it.
 */

const props = defineProps<{ topic: Topic }>()

const t = computed(() => props.topic.ticket!)
/** Ink by where the ticket stands, read off the word the topic keeps. */
const phase = computed(() => {
  const s = t.value.status.toLowerCase()
  return /done|closed|resolved/.test(s) ? 'done' : /to ?do|open|backlog|new/.test(s) ? 'todo' : 'doing'
})

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function onDown(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}
/** Innermost layer first — see OverflowMenu for why this is the immediate form. */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.stopImmediatePropagation()
    open.value = false
  }
}
onMounted(() => {
  document.addEventListener('mousedown', onDown)
  window.addEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDown)
  window.removeEventListener('keydown', onKey, true)
})
</script>

<template>
  <span ref="root" class="tc">
    <button
      class="tcb"
      :class="[phase, { on: open }]"
      :title="open ? undefined : t.key + ' · ' + t.status + ': ' + t.title"
      @click="open = !open"
    >
      <Ticket class="ti" />
      <code class="mono tk">{{ t.key }}</code>
      <i class="dot" />
    </button>

    <div v-if="open" class="menu tcp">
      <TicketCard :project-id="topic.projectId" :topic-id="topic.id" :ticket="t" />
    </div>
  </span>
</template>

<style scoped>
/* Its own way out of the bar's drag region: the popover hangs from here. */
.tc { position: relative; flex: none; display: inline-flex; -webkit-app-region: no-drag; }

/* The mark's pill, outlined rather than tinted: the status beside it is
   yours to set and wears a colour; this is a reference, and only its dot
   says where the ticket stands. */
.tcb {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px 0 7px;
  border-radius: 999px;
  box-shadow: inset 0 0 0 1px var(--line-strong);
  color: var(--text-muted);
  transition: box-shadow var(--dur-1) var(--ease-soft), background var(--dur-1) var(--ease-soft);
}
.tcb:hover, .tcb.on { background: var(--hover); color: var(--text); }
.ti { width: 12px; height: 12px; flex: none; color: var(--text-dim); }
.tk { font-size: 11px; font-weight: 600; }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--line-strong); }
.tcb.doing .dot { background: var(--accent); }
.tcb.done .dot { background: var(--ok); }

.tcp {
  top: calc(100% + 6px);
  left: 0;
  width: 440px;
  max-width: calc(100vw - 40px);
  max-height: min(70vh, 620px);
  padding: 0;
  overflow: hidden;
}
</style>
