<script setup lang="ts">
import { computed } from 'vue'
import { FileDiff, Redo2, ShieldCheck, Undo2, X } from '@lucide/vue'
import { applyPendingRevert, state } from '../core/store.js'

/**
 * §3.7 — "toute opération affiche son plan avant de s'exécuter", for the one
 * operation whose entire purpose is to throw work away.
 *
 * This was a strip of text inside the thread with two words on it. That is the
 * right weight for a filter or a fold; it is the wrong weight for discarding
 * a turn's work, where the cost of a mis-click is the work itself. It is a
 * dialog now, for the same reason `PlanDialog` is one: the app confirms things
 * it cannot silently take back, over a scrim, with the numbers in front of you.
 *
 * The reassurance in the footer is not decoration. The whole reason this can
 * be pressed without ceremony is that it snapshots what it discards on the way
 * in — and a person who does not know that will hesitate over a button that is
 * safer than it looks.
 */

const r = computed(() => state.pendingRevert)

const total = computed(() => {
  const p = r.value?.plan ?? []
  return {
    files: p.reduce((n, e) => n + e.files, 0),
    insertions: p.reduce((n, e) => n + e.insertions, 0),
    deletions: p.reduce((n, e) => n + e.deletions, 0),
  }
})

/** Nothing to do is a real answer, and it is not an error. */
const noop = computed(() => !!r.value?.plan && r.value.plan.length === 0)

function cancel(): void {
  if (r.value?.busy) return
  state.pendingRevert = null
}
</script>

<template>
  <div v-if="r" class="scrim" @mousedown.self="cancel">
    <div class="dlg" role="dialog" :aria-label="r.redo ? 'redo this turn' : 'undo this turn'">
      <header class="head">
        <span class="mk" :class="{ fwd: r.redo }">
          <component :is="r.redo ? Redo2 : Undo2" class="sm" />
        </span>
        <h2>{{ r.redo ? 'Bring this turn back' : 'Undo this turn' }}</h2>
        <span class="grow" />
        <span class="count num">turn {{ r.turnSeq }}</span>
        <button class="icon-btn" title="Cancel (Esc)" @click="cancel"><X class="sm" /></button>
      </header>

      <div class="body">
        <!-- Which turn, in the words it was asked in: a sequence number names
             a row in a table, not a thing anybody remembers doing. -->
        <p class="asked selectable">{{ r.turnPrompt }}</p>

        <p class="what">
          {{
            r.redo
              ? 'The files go back to how they were after this turn ran.'
              : 'The files go back to how they were before this turn was asked.'
          }}
        </p>

        <!-- §3.7 — the size of the decision, per repository. -->
        <div v-if="!r.plan" class="reading">Reading what would change…</div>

        <p v-else-if="noop" class="reading">
          The files are already in that state — there is nothing to put back.
        </p>

        <div v-else class="plan">
          <div v-for="e in r.plan" :key="e.workspaceId" class="prow">
            <FileDiff class="sm si" />
            <span class="nm">{{ e.name }}</span>
            <span class="grow" />
            <span class="n num">{{ e.files }} file{{ e.files === 1 ? '' : 's' }}</span>
            <span class="num add">+{{ e.insertions }}</span>
            <span class="num del">−{{ e.deletions }}</span>
          </div>
          <div v-if="r.plan.length > 1" class="prow sum">
            <span class="nm">All {{ r.plan.length }} repositories</span>
            <span class="grow" />
            <span class="n num">{{ total.files }} files</span>
            <span class="num add">+{{ total.insertions }}</span>
            <span class="num del">−{{ total.deletions }}</span>
          </div>
        </div>
      </div>

      <footer class="foot">
        <!-- §16 — the snapshot is what makes this safe to press, so it is said
             where the pressing happens rather than in a doc nobody opens. -->
        <span class="safe">
          <ShieldCheck class="sm ok" />
          {{
            r.redo
              ? 'What this replaces is snapshotted first — Undo brings it back.'
              : 'What this discards is snapshotted first — Redo brings it back.'
          }}
        </span>
        <span class="grow" />
        <button class="btn ghost" :disabled="r.busy" @click="cancel">Cancel</button>
        <button
          class="btn primary"
          :class="{ warn: !r.redo }"
          :disabled="r.busy || !r.plan || noop"
          @click="applyPendingRevert"
        >
          {{ r.busy ? 'Putting it back…' : r.redo ? 'Bring it back' : 'Undo' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  backdrop-filter: blur(6px) saturate(1.1);
  animation: fade var(--dur-2) var(--ease-soft);
}
@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
.dlg {
  /* Wide enough for the footer's one sentence to stay one sentence: it
     wrapped at 560 and a reassurance broken across two lines reads as fine
     print. */
  width: min(620px, 92vw);
  display: flex;
  flex-direction: column;
  background: var(--overlay);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg), var(--inset-top);
  overflow: hidden;
  animation: rise var(--dur-3) var(--ease);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to { opacity: 1; transform: none; }
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 15px 14px 13px 18px;
  border-bottom: 1px solid var(--line);
}
.head h2 { margin: 0; font-size: var(--fs-lg); font-weight: 640; letter-spacing: -0.01em; }
/* The direction, as the one glyph that says which way this goes. */
.mk {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn);
}
.mk.fwd { background: var(--accent-soft); color: var(--accent); }
.grow { flex: 1; }
.count { font-size: var(--fs-xs); color: var(--text-dim); }

.body { padding: 16px 18px 4px; }

/* The question, quoted rather than restated: it is the one thing that says
   which turn this is about. */
.asked {
  margin: 0 0 12px;
  padding: 9px 12px;
  border-left: 2px solid var(--line-strong);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--panel-raised);
  font-size: var(--fs-xs);
  line-height: 1.55;
  color: var(--text-muted);
  max-height: 84px;
  overflow: hidden;
  white-space: pre-wrap;
}
.what { margin: 0 0 12px; font-size: var(--fs-sm); color: var(--text); line-height: 1.55; }
.reading { margin: 0 0 6px; font-size: var(--fs-xs); color: var(--text-dim); }

.plan {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.prow {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 11px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.prow + .prow { border-top: 1px solid var(--line-soft); }
.prow .si { color: var(--text-dim); flex: none; }
.prow .nm { color: var(--text); font-weight: 550; }
.prow .n { color: var(--text-dim); }
.prow .add { color: var(--ok); }
.prow .del { color: var(--danger); }
/* A total only exists when there is more than one thing to total. */
.prow.sum { background: var(--panel-raised); }

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 14px 14px 18px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
.safe {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-dim);
}
.safe .lucide { flex: none; }
.safe .ok { color: var(--ok); }
/* Undo discards the agent's work, so it carries the colour this app uses for
   "look at this before you do it". Redo puts that work back and is an ordinary
   action — matching the glyph at the top is what makes the two read as
   directions of one thing rather than as two different verbs. */
.btn.primary.warn { background: var(--warn); border-color: var(--warn); color: var(--bg); }
.btn.primary.warn:hover:not(:disabled) { filter: brightness(1.08); }
</style>
