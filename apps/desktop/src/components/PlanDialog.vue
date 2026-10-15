<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ChevronRight, Flag, TriangleAlert, X } from '@lucide/vue'
import { applyPendingPlan, state } from '../core/store.js'

/**
 * §3.7 — "Toute opération affiche son plan avant de s'exécuter et laisse une
 * trace annulable", satisfied the way `ConfirmDialog` satisfies it: the plan is
 * *there*, one click away, rather than being the first thing on screen.
 *
 * Drawn as `ConfirmDialog`'s twin, because to the person reading it that is
 * what it is — a question about something they pressed. It used to be a sheet
 * of its own: a red chip claiming "rewrites history" over plans that rewrote
 * nothing (closing a topic removes folders), filled amber boxes for every
 * caveat, and a footer paragraph about restore points that most plans could
 * only answer with "none". Red now lives where `ConfirmDialog` puts it, on the
 * button that does the thing; whether a restore point is taken is said in the
 * button's tooltip, where the one person who wants to know will look.
 *
 * §12 budget — Catch up is still two clicks: the button, then this.
 */

const plan = computed(() => state.pendingPlan)

/**
 * §4 — the dialog says the verb you pressed, not the RPC that built it.
 * Anything unmapped falls back to the raw id rather than to a guess: a new
 * operation with an honest ugly title is better than a wrong pretty one.
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
  'topic.open': 'Create topic',
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
 * rest. An operation with no sentence here gets none rather than a generic
 * one: "This will run 4 commands" is what the summary already says.
 */
const LEADS: Record<string, string> = {
  merge: 'The branch goes onto the base as one --no-ff merge.',
  'topic.merge': 'Every branch in this topic goes onto its base, one --no-ff merge per repository.',
  switch: 'This checkout moves to another branch. Uncommitted work comes with it, or git refuses.',
  branch: 'A new branch from where you are. Uncommitted work comes with it.',
  sync: 'Every remote is fetched and pruned. Nothing local is touched.',
  'topic.close': 'Its branch folders are removed. The branches and their commits stay.',
}
const lead = computed(() => LEADS[plan.value?.operation ?? ''] ?? null)

/** How wide it reaches, when that is more than one repository. */
const reach = computed(() => {
  const r = plan.value?.repos ?? []
  return r.length > 1 ? r.join(', ') : null
})

const destructive = computed(() => plan.value?.steps.some((s) => s.destructive) ?? false)

/**
 * §3.7 — a plan is all-or-nothing unless it says otherwise. Only the exception
 * — a plan that stops and keeps what already ran — is worth a line before Apply.
 */
const halts = computed(() => plan.value?.onFailure === 'halt')

/** §16 — the restore point is what makes undo real; said where it is asked about. */
const applyTitle = computed(() =>
  plan.value?.capturesRestorePoint ? 'A restore point is captured first — undo stays available' : undefined,
)

/** Folded by default, and per opening. */
const showSteps = ref(false)

/**
 * The safe button holds the focus, as in `ConfirmDialog`: Return means yes for
 * a plan that destroys nothing, and Cancel for one that does — a dialog that
 * arrives with Return already meaning "remove it" is a trap.
 */
const yes = ref<HTMLButtonElement | null>(null)
const no = ref<HTMLButtonElement | null>(null)
watch(
  plan,
  (p) => {
    showSteps.value = false
    if (p) void nextTick(() => (destructive.value ? no.value : yes.value)?.focus())
  },
  { immediate: true },
)

function cancel() {
  state.pendingPlan = null
}
</script>

<template>
  <div v-if="plan" class="scrim" @mousedown.self="cancel">
    <div class="dlg" role="dialog" :aria-label="title">
      <header class="head">
        <h2>{{ title }}</h2>
        <span class="grow" />
        <button class="icon-btn" title="Cancel" @click="cancel"><X class="sm" /></button>
      </header>

      <!-- The one scroller: in a short window the caveats and the argv give
           way, and Cancel stays on screen. `details` cannot be the scroller
           itself — Chromium wraps its content in a `::details-content` box,
           and a `min-height: 0` chain through it silently stops working. -->
      <div class="mid">
        <div v-if="lead || reach" class="say">
          <p v-if="lead" class="lead">{{ lead }}</p>
          <p v-if="reach">In {{ reach }}.</p>
        </div>

        <!-- Never folded: these are the reason the question is asked at all. -->
        <ul v-if="plan.warnings.length" class="warns">
          <li v-for="(w, i) in plan.warnings" :key="i">
            <TriangleAlert class="sm" />
            <span>{{ w }}</span>
          </li>
        </ul>

        <p v-if="halts" class="mode">
          <Flag class="sm" />
          <span>
            Stops at the first repository that conflicts. What already ran is kept — resolve it,
            then run this again.
          </span>
        </p>

        <details
          class="what"
          :open="showSteps"
          @toggle="showSteps = ($event.target as HTMLDetailsElement).open"
        >
          <summary>
            <ChevronRight class="chev sm" />
            <span>{{ plan.steps.length + (plan.after?.length ?? 0) }} command{{ plan.steps.length + (plan.after?.length ?? 0) === 1 ? '' : 's' }}</span>
            <span class="dim">— what this runs</span>
          </summary>
          <ol class="cmds">
            <li v-for="(s, i) in plan.steps" :key="i" :class="{ bad: s.destructive }">
              <span v-if="plan.steps.length > 1" class="ct">{{ s.title }}</span>
              <code class="mono cc selectable">{{ s.command }}</code>
            </li>
            <!-- §7 — not plan steps: they run once the folders exist, and a
               failure there leaves the topic open rather than undoing it.
               In the same list, so the list stays the one scroller. -->
          <template v-if="plan.after?.length">
            <li class="then">Then, in the new folders</li>
            <li v-for="(s, i) in plan.after" :key="'a' + i">
              <span class="ct">{{ s.title }}</span>
              <code class="mono cc selectable">{{ s.command }}</code>
            </li>
          </template>
        </ol>
        </details>
      </div>

      <footer class="foot">
        <span class="grow" />
        <button ref="no" class="btn ghost" @click="cancel">Cancel</button>
        <button
          ref="yes"
          class="btn"
          :class="destructive ? 'danger solid' : 'primary'"
          :disabled="state.planBusy"
          :title="applyTitle"
          @click="applyPendingPlan"
        >
          {{ state.planBusy ? 'Running…' : 'Apply' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Every measure here is `ConfirmDialog`'s, on purpose: two dialogs that ask the
   same kind of question should not look like two kinds of dialog. */
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
  width: min(480px, 92vw);
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
  padding: 16px 14px 6px 20px;
}
.head h2 {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 640;
  letter-spacing: -0.01em;
}
.grow { flex: 1; }

/* A warning can carry a path, and a path has no place to break: without
   `anywhere` it pushed the box wider, and `overflow-y: auto` turns the other
   axis into a scroller too. */
.mid {
  flex: 0 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding-bottom: 4px;
  overflow-wrap: anywhere;
}
.warns li > span,
.mode > span { min-width: 0; }

.say { padding: 4px 20px 10px; }
.say p {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.55;
  color: var(--text-muted);
}
.say p + p { margin-top: 7px; }
.say .lead { color: var(--text); }

/* Amber text, not amber boxes: a caveat is a sentence in the question, and a
   stack of filled cards made a two-line plan read like an incident report. */
.warns { margin: 0; padding: 0 20px 10px; list-style: none; }
.warns li,
.mode {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--warn);
}
.warns li + li { margin-top: 6px; }
.warns .lucide,
.mode .lucide { flex: none; margin-top: 2px; }
.mode { margin: 0; padding: 0 20px 10px; color: var(--text-muted); }

.what { display: block; margin: 0 12px 8px; border-radius: var(--radius-sm); }
.what summary {
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

.cmds { margin: 2px 0; padding: 0 8px 0 28px; list-style: none; }
.cmds li + li { margin-top: 9px; }
.cmds li.then {
  margin-top: 14px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.ct { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
.bad .ct { color: var(--danger); }
.cc {
  display: block;
  margin-top: 3px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  line-height: 1.5;
  word-break: break-all;
}

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
.btn.danger.solid {
  background: var(--danger);
  border-color: transparent;
  color: var(--accent-text);
}
.btn.danger.solid:hover:not(:disabled) { background: var(--danger); filter: brightness(1.08); }
</style>
