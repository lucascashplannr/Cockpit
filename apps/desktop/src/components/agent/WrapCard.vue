<script setup lang="ts">
import { X } from '@lucide/vue'
import type { AgentWrap } from '@cockpit/shared'

/**
 * Where the work stands once a turn is over — the agent's own recap
 * (`wrap_up`, core `wrapTools.ts`), as a card under the latest answer.
 *
 * As little chrome as a card can have: a hairline and the words. No fill, no
 * heading, no icon — the muted ink already says it is beside the answer
 * rather than part of it, and the X only shows when the pointer is on it.
 *
 * Mostly the recap alone. A choice sits inside it only when the agent left a
 * decision that is the person's to make; a reply goes in as their message,
 * exactly as written. The first is the agent's pick, and the one accent on the card.
 */
defineProps<{
  wrap: AgentWrap
  /** Replies can go in: the conversation is not mid-turn and nothing locks it. */
  canReply: boolean
}>()

const emit = defineEmits<{ reply: [text: string]; dismiss: [] }>()
</script>

<template>
  <div class="wcard" :class="{ choosing: !!(wrap.ask && wrap.replies.length) }">
    <div class="top">
      <p class="recap selectable">{{ wrap.recap }}</p>
      <button class="x" title="Put it away" aria-label="Put the recap away" @click="emit('dismiss')"><X /></button>
    </div>
    <template v-if="wrap.ask && wrap.replies.length">
      <p class="q selectable">{{ wrap.ask }}</p>
      <div class="acts">
        <button
          v-for="(r, i) in wrap.replies"
          :key="r"
          class="b"
          :class="{ first: i === 0 }"
          :disabled="!canReply"
          :title="'Send “' + r + '”'"
          @click="emit('reply', r)"
        >
          {{ r }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wcard {
  margin: 14px 0 4px;
  padding: 13px 10px 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.top { display: flex; align-items: flex-start; gap: 9px; }
.recap {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.75;
  color: var(--text-muted);
}
.x {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  margin: -2px 0 0;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft);
}
/* Only while the pointer is on the card — or while it asks, when putting it
   away is one of the answers. */
.wcard:hover .x, .wcard.choosing .x, .x:focus-visible { opacity: 1; }
.x:hover { color: var(--text); background: var(--hover); }
.x .lucide { width: 13px; height: 13px; }
.q {
  margin: 14px 0 0;
  font-size: var(--fs-sm);
  font-weight: 550;
  line-height: 1.45;
  color: var(--text);
}
.acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.b {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  color: var(--text);
  transition: background var(--dur-1) var(--ease-soft);
}
.b:not(:disabled):hover { background: var(--hover); }
.b.first { border-color: transparent; background: var(--accent); color: var(--accent-text); font-weight: 550; }
.b.first:not(:disabled):hover { background: var(--accent-hover); }
.b:disabled { opacity: 0.5; cursor: default; }
</style>
