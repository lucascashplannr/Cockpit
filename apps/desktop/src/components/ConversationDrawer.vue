<script setup lang="ts">
import { computed } from 'vue'
import type { Conversation } from '@cockpit/shared'
import { CircleAlert, CircleStop, Hand, Plus, Sparkles, Trash2, X } from '@lucide/vue'
import {
  activeAgentScope, attentionOf, deleteConversation, engineName, isBusy, isLive,
  openThreadFor, pinThread, sessionsForScope, startFresh, state, stopConversation,
} from '../core/store.js'
import type { Attention } from '../core/store.js'

/**
 * §6 — every conversation on this scope, in a drawer under the column's bar.
 *
 * It was a full-height panel that *replaced* the conversation: opening the
 * history meant the thread you were reading disappeared, and closing it was
 * the only way to check what you had just been told. A list of ways back into
 * something should never be the thing that takes it off the screen.
 *
 * So it hangs from the button that opens it — under the bar, at the right end
 * of it where the instruments are — and the thread stays whole underneath.
 *
 * It is also where a conversation is disposed of. §6's promise is that
 * clearing is free — the conversation goes, the memory stays — and until now
 * the window had no way to act on it: a thread could be stepped away from,
 * never removed, so the list only ever grew.
 */

const scope = computed(() => activeAgentScope.value)
const conversations = computed(() =>
  [...sessionsForScope(scope.value)].sort((a, b) => b.startedAt - a.startedAt),
)
const selected = computed(() => openThreadFor(scope.value))

const ATTENTION_TEXT: Record<Attention, string> = {
  none: '',
  reply: 'answered — waiting for you',
  blocked: 'stopped: it was refused a tool it needed',
  failed: 'the engine failed',
}

function open(c: Conversation): void {
  if (scope.value) pinThread(scope.value, c.id)
  state.historyOpen = false
}

function fresh(): void {
  if (!scope.value) return
  startFresh(scope.value)
  state.historyOpen = false
}

async function stop(c: Conversation): Promise<void> {
  await stopConversation(c.id)
}

/**
 * The question, in the dialog every other irreversible act in the app is asked
 * through.
 *
 * It was two lines of red inside the row, with Cancel and Remove as links at
 * the end of a sentence. Which conversation was going was never in doubt — the
 * row said so — but the one act in the drawer that cannot be taken back was
 * also the only one asked in a voice no other act uses, and it re-laid the list
 * under the cursor as it opened. The title of the conversation is quoted in the
 * dialog instead: it is their words, and it is the thing being named.
 */
function ask(c: Conversation): void {
  state.pendingConfirm = {
    title: 'Remove this conversation?',
    quote: c.title || 'untitled',
    // What it costs, said before it is spent rather than after — and in one
    // sentence, not two. The clause after the full stop is the whole point:
    // people expect Delete to take the work with it, and here it does not.
    body: [
      'Its turns go with it. What the agent did to the code stays — the journal,'
        + ' the restore points, and which lines it wrote.',
    ],
    verb: 'Remove',
    done: 'conversation removed',
    danger: true,
    run: () => deleteConversation(c.id),
  }
}

function ago(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago'
}

/**
 * Three states, not two: working, open, and gone. The middle one used to be
 * painted as the first — a conversation that had answered and was still
 * holding its process pulsed exactly like one mid-turn.
 */
function dotClass(c: Conversation): string {
  if (isBusy(c)) return 'working'
  if (isLive(c)) return 'idle'
  if (c.status === 'failed') return 'unhealthy'
  return 'down'
}
</script>

<template>
  <!-- Anything else you click is you having moved on. -->
  <div class="scrim" @click="state.historyOpen = false" />
  <section class="drawer" role="dialog" aria-label="Conversations">
    <header class="dhead">
      <span class="ttl">Conversations</span>
      <span class="n">{{ conversations.length }}</span>
      <span class="grow" />
      <!-- §6 — "vider devient gratuit : la conversation part, la mémoire
           reste". The act that sentence is about, in the list it is about. -->
      <button class="btn ghost mini" title="An empty composer here — the memory is re-read on the way in" @click="fresh">
        <Plus /> New
      </button>
      <button class="icon-btn small" title="Close (Esc)" @click="state.historyOpen = false">
        <X class="sm" />
      </button>
    </header>

    <div class="list">
      <p v-if="!conversations.length" class="none">
        <Sparkles class="sm" />
        Nothing has run here yet.
      </p>

      <div
        v-for="c in conversations"
        :key="c.id"
        class="conv"
        :class="{ on: selected?.id === c.id }"
      >
        <button class="pick" @click="open(c)">
          <span class="crow">
            <span class="dot" :class="dotClass(c)" />
            <span class="ctitle">{{ c.title || 'untitled' }}</span>
          </span>
          <span class="crow meta">
            <span class="ceng">{{ engineName(c.engine) }}</span>
            <span class="sep">·</span>
            <span>{{ c.history.length }} turn{{ c.history.length === 1 ? '' : 's' }}</span>
            <span class="sep">·</span>
            <span>{{ ago(c.startedAt) }}</span>
            <span v-if="isBusy(c)" class="state on">working</span>
            <span v-else-if="isLive(c)" class="state">open</span>
            <span
              v-if="attentionOf(c) !== 'none'"
              class="needs"
              :class="attentionOf(c)"
              :title="ATTENTION_TEXT[attentionOf(c)]"
            >
              <component :is="attentionOf(c) === 'reply' ? Hand : CircleAlert" class="sm" />
            </span>
          </span>
        </button>

        <!-- The acts, on the row they act on. Quiet until the row is under the
             cursor: a list of twenty with sixty buttons lit is a toolbar. -->
        <span class="acts">
          <button
            v-if="isLive(c)"
            class="icon-btn small"
            :title="isBusy(c)
              ? 'Stop what it is doing'
              : 'Let this conversation go — it is idle and still holding its repositories'"
            @click="stop(c)"
          >
            <CircleStop class="sm" />
          </button>
          <button
            class="icon-btn small del"
            :title="isLive(c)
              ? 'Stop it first — a conversation is not removed out from under its engine'
              : 'Remove this conversation'"
            @click="ask(c)"
          >
            <Trash2 class="sm" />
          </button>
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* A catcher, not a curtain.
 *
 * This started as a dimming scrim, from when the drawer was the full width of
 * the column and reading as a layer over the work. Hung from its button it is
 * a panel of four hundred pixels, and a panel that size darkening the whole
 * window is a modal wearing a dropdown's clothes. What is left is the job that
 * actually mattered: anywhere else you click closes it. */
.scrim { position: absolute; inset: 0; z-index: 40; }

/* Directly under its own button, which floats at the top right of the
   conversation (ContextPanel). Anchored to that same right edge rather than
   measured against the button: both sit hard against it, so the two line up on
   their own and there is no offset to keep true when the count changes width.
   44px is the button's own box — 10 above it, 28 of it, 6 of air. */
.drawer {
  position: absolute;
  z-index: 41;
  top: 44px;
  right: 12px;
  width: min(400px, calc(100% - 20px));
  display: flex;
  flex-direction: column;
  /* As much as it needs and no more. Past this it stops being a way back into
     the thread and becomes a second panel over it, which is what it was. */
  max-height: min(70%, 480px);
  background: var(--overlay);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  animation: drop var(--dur-2) var(--ease);
  /* From the corner it hangs from, so it reads as coming out of the button. */
  transform-origin: top right;
}
@keyframes drop {
  from { transform: translateY(-6px) scale(0.985); opacity: 0; }
  to { transform: none; opacity: 1; }
}

.dhead {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--line-soft);
}
.ttl { font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.dhead .n {
  font-size: 11px;
  color: var(--text-dim);
  padding: 0 6px;
  height: 17px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--hover);
}
.grow { flex: 1; }
.mini { height: 24px; padding: 0 9px; font-size: var(--fs-xs); gap: 5px; color: var(--text-muted); }
.mini .lucide { width: 13px; height: 13px; }

.list { flex: 1; min-height: 0; overflow-y: auto; padding: 5px; }
.none {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 12px;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}

/* A row is a target and two acts: the title and its meta line take what is
   left, the acts take what they need, and neither pushes the other. */
.conv {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  border-radius: var(--radius-sm);
}
.conv:hover { background: var(--hover); }
.conv.on { background: var(--selected); }

.pick {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  min-width: 0;
  padding: 7px 4px 7px 9px;
  text-align: left;
}
.crow { display: flex; align-items: center; gap: 7px; min-width: 0; }
.ctitle {
  font-size: var(--fs-sm);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta { font-size: var(--fs-xs); color: var(--text-dim); }
/* "open" is a state, not an event: it gets the weight of the rest of the meta
   line. "working" is the one word here worth a colour. */
.state { color: var(--text-dim); }
.state.on { color: var(--agent); font-weight: 600; }
/* Alive and between turns: present, and not pretending to be busy. */
.dot.idle { background: var(--agent); opacity: 0.5; }
.ceng { color: var(--text-muted); }
.sep { opacity: 0.5; }
.needs { display: inline-flex; color: var(--warn); }
.needs.blocked, .needs.failed { color: var(--danger); }

.acts { display: flex; align-items: center; gap: 1px; padding-right: 6px; opacity: 0; }
.conv:hover .acts,
.acts:focus-within { opacity: 1; }
.acts .icon-btn.small { width: 24px; height: 24px; }
.del:hover { color: var(--danger); background: var(--danger-soft); }
</style>
