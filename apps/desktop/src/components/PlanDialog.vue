<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ChevronRight, Flag, Layers, ShieldCheck, ShieldOff, TriangleAlert, X,
} from '@lucide/vue'
import { applyPendingPlan, state } from '../core/store.js'

/**
 * §3.7 — "Toute opération affiche son plan avant de s'exécuter et laisse une
 * trace annulable", satisfied the way `ConfirmDialog` satisfies it: the plan is
 * *there*, one click away, rather than being the first thing on screen.
 *
 * It used to open on the argv. Four numbered steps of `git fetch origin main`
 * meant the question — do you want to catch up — had to be reconstructed from
 * the commands that would answer it, and the two things worth reading in the
 * box (the warnings, and which branch you are catching up from) sat below a
 * list nobody reads twice. The words come first now, the commands fold away
 * behind a summary, and the warnings stay out in the open where they were
 * always the point.
 *
 * §12 budget — Catch up is still two clicks: the button, then this.
 */

const plan = computed(() => state.pendingPlan)

/**
 * §4 — the dialog says the verb you pressed, not the RPC that built it.
 *
 * The title rendered the operation id through `text-transform: capitalize`,
 * which is how the confirmation for **Catch up** came to be headed
 * "Topic.Rebase" — the word the lexicon renamed, plus a method name, in the
 * one place the act is named at full size. Anything unmapped falls back to the
 * raw id rather than to a guess: a new operation with an honest ugly title is
 * better than a wrong pretty one.
 */
const TITLES: Record<string, string> = {
  rebase: 'Catch up',
  'topic.rebase': 'Catch up',
  merge: 'Send to the base',
  'topic.merge': 'Send to the base',
  push: 'Push',
  'topic.push': 'Push',
  pull: 'Pull',
  switch: 'Switch branch',
  branch: 'New branch',
  worktree: 'New branch folder',
  'topic.open': 'Open topic',
  'topic.close': 'Close topic',
  'topic.delete': 'Delete topic',
  sync: 'Sync',
}
const title = computed(() => {
  const op = plan.value?.operation ?? ''
  return TITLES[op] ?? op
})
/**
 * The question, in the app's words. One sentence, and the commands say the
 * rest — the point of folding them away is that this has to stand without
 * them. An operation with no sentence here gets none rather than a generic
 * one: "This will run 4 commands" is what the summary already says.
 */
const LEADS: Record<string, string> = {
  merge: 'The branch goes onto the base as one --no-ff merge.',
  'topic.merge': 'Every branch in this topic goes onto its base, one --no-ff merge per repository.',
  switch: 'This checkout moves to another branch. Uncommitted work comes with it, or git refuses.',
  branch: 'A new branch from where you are. Uncommitted work comes with it.',
  sync: 'Every remote is fetched and pruned. Nothing local is touched.',
}
const lead = computed(() => LEADS[plan.value?.operation ?? ''] ?? null)

/** How wide it reaches, when that is more than one repository. */
const reach = computed(() => {
  const r = plan.value?.repos ?? []
  return r.length > 1 ? r.join(', ') : null
})

const destructive = computed(() => plan.value?.steps.some((s) => s.destructive) ?? false)

/** Folded by default, and per opening: a plan read once is not one you want to
 *  keep re-reading. */
const showSteps = ref(false)

/**
 * What the red mark means, which is not always the same thing. Every
 * destructive plan there had ever been rewrote history, so the chip said so
 * flatly; dropping a stash destroys work without touching a single commit,
 * and a warning that describes the wrong danger is one people learn to skip.
 */
const dangerLabel = computed(() =>
  plan.value?.operation === 'stash drop' ? 'throws work away' : 'rewrites history',
)

/**
 * §3.7 — a plan is all-or-nothing unless it says otherwise, and the difference
 * matters enough to be on screen before Apply rather than discovered after it.
 */
const halts = computed(() => plan.value?.onFailure === 'halt')

function cancel() {
  state.pendingPlan = null
}
</script>

<template>
  <div v-if="plan" class="scrim" @mousedown.self="cancel">
    <div class="dlg" role="dialog" :aria-label="plan.operation + ' plan'">
      <header class="head">
        <h2>{{ title }}</h2>
        <span v-if="destructive" class="chip danger">
          <TriangleAlert />{{ dangerLabel }}
        </span>
        <span class="grow" />
        <button class="icon-btn" title="Cancel" @click="cancel"><X class="sm" /></button>
      </header>

      <!-- The question. Everything below it is either a caveat or the argv. -->
      <div v-if="lead || reach" class="say">
        <p v-if="lead" class="p lead">{{ lead }}</p>
        <p v-if="reach" class="p">In {{ reach }}.</p>
      </div>

      <!-- Everything from here to the footer scrolls as one, rather than each
           band fighting for the height. `details` cannot be relied on to
           shrink: Chromium wraps its content in a `::details-content` box of
           its own, so a `min-height: 0` flex chain through it silently stops
           working and the steps paint straight over the warnings under them.
           One scroller, outside the disclosure, has no such seam.

           The base row stays above it on purpose — its list is a popover, and
           a popover inside a scrolling box is a popover with a scrollbar
           through it. -->
      <div class="mid">
      <!-- The plan, kept but not insisted upon — the same disclosure the stash
           confirmations use, and for the same reason. `details` rather than a
           hand-rolled toggle: it is a disclosure, the platform has one, and
           this one is reachable by keyboard without anything being wired. -->
      <details
        class="what"
        :open="showSteps"
        @toggle="showSteps = ($event.target as HTMLDetailsElement).open"
      >
        <summary>
          <ChevronRight class="chev sm" />
          <span>{{ plan.steps.length }} command{{ plan.steps.length === 1 ? '' : 's' }}</span>
          <span class="dim">— what this runs</span>
        </summary>
        <div class="steps">
          <div v-for="(s, i) in plan.steps" :key="i" class="step" :class="{ bad: s.destructive }">
            <span class="n num">{{ i + 1 }}</span>
            <div class="body">
              <div class="title">{{ s.title }}</div>
              <code class="cmd mono selectable">{{ s.command }}</code>
            </div>
          </div>
        </div>
      </details>

      <!-- Never folded. A warning behind a disclosure is a warning nobody
           reads, and these are the reason the confirmation exists at all. -->
      <div v-if="plan.warnings.length" class="warns">
        <div v-for="(w, i) in plan.warnings" :key="i" class="warn">
          <TriangleAlert class="sm" />
          <span>{{ w }}</span>
        </div>
      </div>

      <div class="mode" :class="{ halt: halts }">
        <component :is="halts ? Flag : Layers" class="sm" />
        <span v-if="halts">
          Stops at the first repository that conflicts. What already ran is kept, not rolled
          back — resolve it, then run this again.
        </span>
        <span v-else>
          All or nothing: if a step fails, the ones before it are undone in reverse.
        </span>
      </div>
      </div>

      <footer class="foot">
        <!-- §16 — the restore point is what makes the undo button real. -->
        <span v-if="plan.capturesRestorePoint" class="rp">
          <ShieldCheck class="sm ok" />
          A restore point is captured first — undo stays available.
        </span>
        <!-- §16 — a restore point anchors HEAD, so there are operations it
             cannot cover. Saying "nothing destructive" over a step marked red
             would be the dialog contradicting itself. -->
        <span v-else-if="destructive" class="rp warn">
          <ShieldOff class="sm" />
          No restore point covers this — a restore point anchors commits, and this
          discards work that was never committed.
        </span>
        <span v-else class="rp dim">
          <ShieldOff class="sm" />
          Nothing destructive; no restore point needed.
        </span>
        <span class="grow" />
        <button class="btn ghost" @click="cancel">Cancel</button>
        <button class="btn primary" :disabled="state.planBusy" @click="applyPendingPlan">
          {{ state.planBusy ? 'Running…' : 'Apply' }}
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
  /* Narrower than it was, and for the reason `ConfirmDialog` is narrower
     still: it is a question now, and a question the width of a terminal reads
     as a report. Wider than that one because when the plan *is* unfolded it is
     argv, and argv that wraps is argv nobody can check. */
  width: min(560px, 92vw);
  max-height: 80vh;
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
  padding: 16px 14px 14px 20px;
  border-bottom: 1px solid var(--line);
}
.head h2 {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 640;
  letter-spacing: -0.01em;
}
.grow { flex: 1; }
.count { font-size: var(--fs-xs); color: var(--text-dim); }

/* The question, and how wide it reaches. Gives way before the footer does: a
   plan with a paragraph per repository must not push Cancel off a short
   window. */
.say { flex: none; padding: 2px 20px 12px; }
.say .p { margin: 0; font-size: var(--fs-sm); line-height: 1.55; color: var(--text-muted); }
.say .p + .p { margin-top: 6px; }
.say .lead { color: var(--text); }

/* The disclosure that holds the plan. Same shape as the one on the stash
   confirmations, deliberately: two dialogs that fold the same thing away
   should fold it away the same way. */
/* The one scrolling region: the plan, its warnings and its failure mode. */
.mid { flex: 1 1 auto; min-height: 0; overflow-y: auto; }

.what {
  display: block;
  margin: 0 12px 10px;
  border-radius: var(--radius-sm);
}
.what summary {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  cursor: default;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  list-style: none;
  transition: background var(--dur-1) var(--ease-soft);
}
.what summary::-webkit-details-marker { display: none; }
.what summary:hover { background: var(--hover); }
.what[open] summary { color: var(--text); }
.chev {
  flex: none;
  color: var(--text-dim);
  transition: transform var(--dur-2) var(--ease-soft);
}
.what[open] .chev { transform: rotate(90deg); }
.dim { color: var(--text-dim); }

.steps { padding: 2px 8px 4px; }
.step { display: flex; gap: 13px; padding: 11px 0; }
.step + .step { border-top: 1px solid var(--line-soft); }
.n {
  flex: none;
  width: 22px;
  height: 22px;
  margin-top: 1px;
  border-radius: 7px;
  background: var(--hover);
  color: var(--text-dim);
  font-size: var(--fs-xs);
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}
.step.bad .n { background: var(--danger-soft); color: var(--danger); }
.body { min-width: 0; flex: 1; }
.title { font-size: var(--fs-sm); color: var(--text); }
.step.bad .title { color: var(--danger); font-weight: 550; }
.cmd {
  display: block;
  margin-top: 5px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  word-break: break-all;
  line-height: 1.5;
}

.warns { flex: none; padding: 0 20px 12px; }
.warn {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-xs);
  line-height: 1.55;
}
.warn .lucide { margin-top: 1px; }
.warn + .warn { margin-top: 6px; }

.mode {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 20px 12px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  line-height: 1.55;
}
.mode .lucide { margin-top: 1px; flex: none; }
.mode.halt { color: var(--text-muted); }

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
.rp {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  /* Was 58%, which fitted one line at 660px and wrapped to two at 560. The
     buttons are `flex: none` and take what they need; this takes the rest. */
  min-width: 0;
  flex: 1 1 auto;
}
.rp .ok { color: var(--ok); }
.rp.dim { color: var(--text-dim); }
.rp.warn { color: var(--warn); line-height: 1.4; align-items: flex-start; }
.rp.warn .lucide { margin-top: 2px; flex: none; }
</style>
