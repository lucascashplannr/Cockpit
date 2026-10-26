<script setup lang="ts">
import { computed } from 'vue'
import type { AgentScope, Conversation } from '@cockpit/shared'
import {
  activeAgentScope, attentionOf, inPlayOn, isBusy, openConversation, openThreadFor, scopeKey,
} from '../core/store.js'

/**
 * §7 — bench C: the conversations running on one row of the list, hung under
 * it. With several working alongside, the list is the one place that shows
 * every one of them at once, whichever repository or topic they started on.
 */
const props = defineProps<{ scope: AgentScope; deep?: boolean }>()

const rows = computed(() => inPlayOn(props.scope))
const here = computed(() => !!activeAgentScope.value && scopeKey(activeAgentScope.value) === scopeKey(props.scope))
const onScreen = computed(() => (here.value ? openThreadFor(props.scope)?.id ?? null : null))

function dotOf(c: Conversation): string {
  if (attentionOf(c) !== 'none') return 'you'
  return isBusy(c) ? 'work' : 'open'
}
const WORD: Record<string, string> = { you: 'needs you', work: 'working', open: 'open' }
</script>

<template>
  <div v-if="rows.length" class="threads" :class="{ deep }">
    <button
      v-for="c in rows"
      :key="c.id"
      class="tr"
      :class="{ on: c.id === onScreen }"
      :title="c.title + ' — ' + WORD[dotOf(c)]"
      @click="openConversation(c)"
    >
      <span class="dot" :class="dotOf(c)" />
      <span class="t">{{ c.title || 'untitled' }}</span>
    </button>
  </div>
</template>

<style scoped>
.threads { display: flex; flex-direction: column; margin: 1px 0 3px; }
.tr {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 24px;
  /* Under the row's own glyph, one step in. */
  padding: 0 10px 0 33px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.deep .tr { padding-left: 51px; }
.tr:hover { background: var(--hover); color: var(--text); }
.tr.on { color: var(--text); }
.t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { flex: none; width: 6px; height: 6px; border-radius: 50%; }
.dot.work { background: var(--agent); box-shadow: 0 0 0 2.5px var(--agent-soft); }
.dot.you { box-shadow: inset 0 0 0 1.75px var(--warn); }
.dot.open { background: var(--text-dim); }
</style>
