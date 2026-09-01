<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Conversation } from '@cockpit/shared'
import { CircleAlert, CircleStop, Hand, Plus, Sparkles, Trash2, X } from '@lucide/vue'
import {
  activeAgentScope, attentionOf, client, deleteConversation, guard, isRunning, openThreadFor,
  pinThread, sessionsForScope, startFresh, state,
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
 * the window had no way to act on it: threads could be put away, never
 * removed, so the list only ever grew.
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

/**
 * Which row is asking "are you sure". Inline rather than a dialog: a dialog
 * over a drawer is two floating things deep, and the row itself is the only
 * place that can show *which* conversation is about to go.
 */
const confirming = ref<string | null>(null)
const busy = ref<string | null>(null)

/** Walking away from the question is answering no. */
watch(
  () => state.historyOpen,
  (open) => {
    if (!open) confirming.value = null
  },
)
watch(conversations, () => {
  if (confirming.value && !conversations.value.some((c) => c.id === confirming.value)) {
    confirming.value = null
  }
})

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
  await guard(() => client.call('agent.stop', { sessionId: c.id }), 'conversation stopped')
}

async function remove(c: Conversation): Promise<void> {
  busy.value = c.id
  const gone = await deleteConversation(c.id)
  busy.value = null
  // Only on success: a refusal ("it is still running") has to stay in front of
  // the person who asked, on the row it is about.
  if (gone) confirming.value = null
}

function ago(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago'
}

function dotClass(c: Conversation): string {
  if (isRunning(c)) return 'working'
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
        :class="{ on: selected?.id === c.id, asking: confirming === c.id }"
      >
        <button class="pick" @click="open(c)">
          <span class="crow">
            <span class="dot" :class="dotClass(c)" />
            <span class="ctitle">{{ c.title || 'untitled' }}</span>
          </span>
          <span class="crow meta">
            <span class="ceng">{{ c.engine }}</span>
            <span class="sep">·</span>
            <span>{{ c.history.length }} turn{{ c.history.length === 1 ? '' : 's' }}</span>
            <span class="sep">·</span>
            <span>{{ ago(c.startedAt) }}</span>
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
            v-if="isRunning(c)"
            class="icon-btn small"
            title="Stop this conversation"
            @click="stop(c)"
          >
            <CircleStop class="sm" />
          </button>
          <button
            class="icon-btn small del"
            :title="isRunning(c)
              ? 'Stop it first — a running conversation is not removed out from under its engine'
              : 'Remove this conversation'"
            @click="confirming = confirming === c.id ? null : c.id"
          >
            <Trash2 class="sm" />
          </button>
        </span>

        <!-- What it costs, said before it is spent rather than after. The
             sentence is the whole point: people expect Delete to take the work
             with it, and here it does not. -->
        <p v-if="confirming === c.id" class="ask">
          <span class="q">
            Remove this conversation? Its turns go with it. What the agent did
            to the code stays — the journal, the restore points, and which
            lines it wrote.
          </span>
          <button class="link" @click="confirming = null">Cancel</button>
          <button class="link go" :disabled="busy === c.id" @click="remove(c)">
            {{ busy === c.id ? 'Removing…' : 'Remove' }}
          </button>
        </p>
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

/* Under the bar and under its own button, which is at the right end of it.
   Anchored to the column's right edge rather than measured against the button:
   the instruments sit hard against that edge, so the two line up on their own
   and there is no offset to keep true as the bar's contents change. */
.drawer {
  position: absolute;
  z-index: 41;
  top: 6px;
  right: 10px;
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

/* A row is a target and two acts. Grid rather than flex so the confirmation
   can take the whole width underneath without the acts moving. */
.conv {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  border-radius: var(--radius-sm);
}
.conv:hover { background: var(--hover); }
.conv.on { background: var(--selected); }
.conv.asking { background: var(--danger-soft); }

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
.ceng { color: var(--text-muted); }
.sep { opacity: 0.5; }
.needs { display: inline-flex; color: var(--warn); }
.needs.blocked, .needs.failed { color: var(--danger); }

.acts { display: flex; align-items: center; gap: 1px; padding-right: 6px; opacity: 0; }
.conv:hover .acts,
.conv.asking .acts,
.acts:focus-within { opacity: 1; }
.acts .icon-btn.small { width: 24px; height: 24px; }
.del:hover { color: var(--danger); background: var(--danger-soft); }

/* Spans both columns: the question is about the row, not about the button. */
.ask {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 0 9px 9px;
  font-size: var(--fs-xs);
  line-height: 1.45;
  color: var(--text-muted);
}
.ask .q { flex: 1 1 100%; }
.ask .link { color: var(--text-dim); font-size: var(--fs-xs); }
.ask .link:hover { color: var(--text); }
.ask .link.go { color: var(--danger); font-weight: 600; }
.ask .link.go:disabled { opacity: 0.5; }
</style>
