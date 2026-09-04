<script setup lang="ts">
import { computed } from 'vue'
import { MousePointerClick } from '@lucide/vue'
import AgentTab from './tabs/AgentTab.vue'
import Wordmark from './brand/Wordmark.vue'
import { activeWorkspace } from '../core/store.js'

/**
 * The conversation, and nothing else.
 *
 * It used to be the whole right-hand column — the scope bar, the conflict
 * strip, the thread and the drawer over it — because for a while the
 * conversation *was* the right-hand column. Now the review can have the same
 * width (§12's ladder), and everything that was true whichever of the two you
 * were looking at moved up a level to the shell: the bar (ScopeBar), the
 * conflict strip, and the list of earlier threads that hangs from the bar.
 *
 * What is left is the one thing that is genuinely this column's: the thread,
 * and the welcome that stands in for it when nothing is selected.
 */

const w = computed(() => activeWorkspace.value)

</script>

<template>
  <section class="panel">
    <!-- Nothing selected is still a first impression: the app says its name. -->
    <div v-if="!w" class="welcome">
      <Wordmark :height="27" class="wm" />
      <p class="tag">Everything in flight, in one window.</p>
      <div class="hints">
        <span class="hint">
          <span class="kbd">⌘K</span> jump to a repository or branch, or run anything
        </span>
        <span class="hint"><MousePointerClick class="sm" /> or pick one on the left</span>
      </div>
    </div>

    <template v-else>
      <!-- The bar that used to head this column is above it now, across the
           window (ScopeBar): none of what it carried was about the
           conversation. What is left here is the conversation. -->
      <div class="body"><AgentTab :workspace="w" /></div>
    </template>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg);
}

/* ── welcome ─────────────────────────────────────────────────────────── */
.welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 40px;
}
.wm {
  color: var(--brand-ink);
  --wm-lead: var(--accent);
}
.tag {
  margin: -4px 0 0;
  font-size: var(--fs-md);
  color: var(--text-dim);
}
.hints {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}

.body { position: relative; flex: 1; min-height: 0; overflow: hidden; }
</style>
