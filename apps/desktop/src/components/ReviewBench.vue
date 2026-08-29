<script setup lang="ts">
import { computed } from 'vue'
import { FlaskConical, X } from '@lucide/vue'
import { REVIEW_LAYOUTS, setReviewLayout, state } from '../core/store.js'

/**
 * Scaffolding, not a feature.
 *
 * The Agent owns the panel — that part is settled. Where the review layer goes
 * once it stops being a row of peer tabs is not, and the honest way to answer
 * it is to read a real diff in each candidate rather than to argue from a
 * mockup. So all three ship, this strip switches between them live (⌘⇧D to
 * show it, ⌘⇧1..3 to switch without it), and the choice is persisted.
 *
 * When one wins: delete this file, the losers, and `ReviewLayout` itself.
 */

const current = computed(() => REVIEW_LAYOUTS.find((l) => l.id === state.reviewLayout) ?? null)
</script>

<template>
  <div class="bench">
    <div class="head">
      <FlaskConical class="sm fl" />
      <span class="ttl">Review layer</span>
      <span class="kbd">⌘⇧D</span>
      <span class="grow" />
      <button class="icon-btn x" title="Hide (⌘⇧D)" @click="state.benchOpen = false"><X /></button>
    </div>

    <div class="seg">
      <button
        v-for="(l, i) in REVIEW_LAYOUTS"
        :key="l.id"
        :class="{ on: state.reviewLayout === l.id }"
        :title="l.hint + '  (⌘⇧' + (i + 1) + ')'"
        @click="setReviewLayout(l.id)"
      >
        {{ l.label }}
        <span class="n">{{ i + 1 }}</span>
      </button>
    </div>

    <p v-if="current" class="hint">{{ current.hint }}</p>
    <p class="how">
      Open it from the changed count, the Review button, or ⌘2..⌘5.
    </p>
  </div>
</template>

<style scoped>
/* Over everything the shell draws, under the window's own buttons.
   Bottom left, over the workspace list: it is a tool for judging the app, so
   it must never be the thing being judged — and every other edge is taken by
   one of the three candidates. Right is the panel, bottom is the drawer and
   the composer, and the middle is the conversation. The list is the one column
   with empty space in it, and the only thing at its foot is its own toolbar,
   which this clears. */
.bench {
  position: fixed;
  z-index: 90;
  left: calc(var(--rail-w) + 12px);
  bottom: 56px;
  width: 316px;
  padding: 11px 13px 12px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line-strong);
  background: var(--overlay);
  box-shadow: var(--shadow-lg);
}

.head { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.fl { color: var(--accent); }
.ttl { font-size: var(--fs-xs); font-weight: 600; color: var(--text); }
.grow { flex: 1; }
.icon-btn.x { width: 22px; height: 22px; }

.seg > button { gap: 6px; }
/* The number is the shortcut, so it is dimmer than the name it belongs to. */
.n {
  font-size: 9px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--text-dim);
}
.seg > button.on .n { background: var(--accent-soft); color: var(--accent); }

.hint { margin: 9px 2px 0; font-size: 10px; line-height: 1.5; color: var(--text-dim); }
.how { margin: 5px 2px 0; font-size: 10px; line-height: 1.5; color: var(--text-dim); opacity: 0.75; }
</style>
