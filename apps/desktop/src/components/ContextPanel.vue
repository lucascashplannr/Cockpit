<script setup lang="ts">
import { computed } from 'vue'
import { CircleStop, History, MousePointerClick, X } from '@lucide/vue'
import AgentTab from './tabs/AgentTab.vue'
import ConversationDrawer from './ConversationDrawer.vue'
import Wordmark from './brand/Wordmark.vue'
import {
  activeAgentScope, activeWorkspace, attentionOf, isBusy, isLive, openThreadFor,
  sessionsForScope, startFresh, state, stopConversation,
} from '../core/store.js'

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

/**
 * §6 — every conversation that has been had on this scope, and whether any of
 * them is waiting on you.
 *
 * The button was in the window's bar, beside the memory, in a case labelled
 * "the conversation's instruments". Neither of them belonged there: one bar
 * for the checkout had grown two controls that are not about the checkout at
 * all. The memory went to the review column, where the other documents you
 * read are; this is the list of *these* threads, so it belongs to the thread —
 * at the top right of it, which is also where its drawer already hung.
 */
const conversations = computed(() => sessionsForScope(activeAgentScope.value))
const waiting = computed(
  () => conversations.value.filter((c) => attentionOf(c) !== 'none').length,
)

/**
 * The ✕, next to the list it belongs with.
 *
 * It was the last thing in the conversation's own bar (AgentTab), which put it
 * on the far side of the history button and made the pair read backwards: the
 * one that opens a list of threads, then the one that shows none of them. They
 * are the same question — which conversation is on screen — so they are one
 * cluster now, in the order you would say them, and the bar keeps the room.
 *
 * There is nothing to hide when no thread is showing, so in the invitation it
 * is simply absent and the history button has the corner to itself.
 */
const thread = computed(() => openThreadFor(activeAgentScope.value))

function hide(): void {
  const s = activeAgentScope.value
  if (s) startFresh(s)
}

/**
 * §6 — the engine, let go. Between the two above rather than behind them: this
 * is the middle of the three questions the corner answers — which conversation,
 * whether its process is still up, and none of them.
 *
 * It was the last thing in the conversation's bar (AgentTab), which is where it
 * had always been; nothing about what it does has changed. A conversation that
 * is not holding a process has nothing to let go of, so the button is simply
 * absent — and the two either side of it close up.
 */
async function stop(): Promise<void> {
  if (thread.value) await stopConversation(thread.value.id)
}

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
      <div class="body">
        <AgentTab :workspace="w" />

        <!-- Over the conversation's own bar, at the end of it — and over the
             empty top of the invitation when there is no thread yet, which is
             the one moment "what did I ask here before" is most worth asking.
             One place, both states: the bar has room reserved for them (`.tbar`
             in AgentTab) rather than the buttons having two homes. -->
        <div class="instr">
          <button
            class="hist"
            :class="{ on: state.historyOpen, waiting: waiting > 0, solo: !conversations.length }"
            :title="conversations.length
              ? conversations.length + ' conversation(s) here — earlier threads on this scope'
              : 'Earlier conversations here'"
            @click="state.historyOpen = !state.historyOpen"
          >
            <History class="sm" />
            <span v-if="conversations.length" class="n">{{ conversations.length }}</span>
          </button>
          <button
            v-if="thread && isLive(thread)"
            class="icon-btn"
            :title="isBusy(thread)
              ? 'Stop what it is doing'
              : 'Let this conversation go — it is between turns and still holding its repositories'"
            @click="stop"
          >
            <CircleStop class="sm" />
          </button>
          <button
            v-if="thread"
            class="icon-btn"
            title="Show an empty composer here — this conversation stays in the history, and keeps running if it is mid-turn"
            @click="hide"
          >
            <X class="sm" />
          </button>
        </div>

        <!-- §6 — hung from the button above, over the thread rather than
             instead of it. In here, so it is clipped to the conversation's own
             box: a drawer that can spill past the column it belongs to is a
             panel with an animation. -->
        <ConversationDrawer v-if="state.historyOpen" />
      </div>
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

/* At the end of the conversation's own bar, and in the same place when there
   is no bar because there is no thread yet. Drawn here rather than inside
   `.tbar` for exactly that reason — the invitation has no bar and needs it
   most. `.tbar` keeps the room free (AgentTab), so the two never overlap.

   Floating over a bar means the bar's own arithmetic is this pair's too: 28
   tall under 10 of padding is the box `.icon-btn` gets inside `.tbar`, so both
   marks sit on the same centre line as what is left in the bar. The history
   button was 26 at 9, which is the same centre line two pixels up — near enough
   to look like a mistake rather than a difference, which is what it was.

   A fixed width for the same reason. The room `.tbar` keeps free is a constant,
   so a button that grew with its count set the gap to the ✕: wide at 3, tight
   at 30, and unpredictable at the moment a tenth conversation appeared. 44 is
   the icon, its number and the air around them at any count worth showing; with
   no count at all there is no number to hold, and it is a plain 28 like the ✕. */
/* One pixel apart: buttons of one set touch, and these three are one set —
   which conversation is on screen, whether its engine is still up, and none of
   them. The bar underneath keeps room for all three (`.tbar` in AgentTab), so
   the stop button appearing when a conversation goes live moves the history
   button along rather than over anything. */
.instr {
  position: absolute;
  z-index: 5;
  /* Centred in the bar underneath: `.tbar` is a stated 49px — 48 of content
     over its 1px rule — so a 28px instrument sits at 10 whether or not the bar
     is carrying anything else. The invitation has no bar and no ✕; the history
     button lands in the same corner either way. */
  top: 10px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 1px;
}
.hist {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 44px;
  height: 28px;
  font-variant-numeric: tabular-nums;
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--text-dim);
  transition: color var(--dur-1) var(--ease-soft), background var(--dur-1) var(--ease-soft);
}
.hist.solo { width: 28px; }
.hist:hover { color: var(--text); background: var(--hover); }
.hist.on { color: var(--accent); background: var(--accent-soft); }
/* One of them is asking something. The count is the thing that says so. */
.hist.waiting { color: var(--warn); }
.hist .n { color: inherit; font-weight: 500; }
</style>
