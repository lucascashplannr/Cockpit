<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronRight, X } from '@lucide/vue'
import BasePicker from './BasePicker.vue'
import { applyPendingConfirm, state } from '../core/store.js'

/**
 * A question, with the commands folded away behind it.
 *
 * §3.7 — "toute opération affiche son plan avant de s'exécuter" — is satisfied
 * by the plan being *there*, not by it being the first thing on screen. For an
 * operation that rewrites history it should be: `PlanDialog` puts every step
 * in front of you before you can agree to it. For setting work aside and
 * putting it back, that same treatment read as a warning about something
 * dangerous, when the honest answer is "yes, and you can undo it by clicking
 * the other one".
 *
 * So the words come first and the argv comes second — one click away, in the
 * same box, before the button rather than after it. Anyone who wants to know
 * exactly what runs still finds out without leaving the decision.
 *
 * Some questions have no argv at all — removing a conversation runs no git —
 * and they are asked here too, with the disclosure simply absent. A second
 * confirmation drawn its own way is how an app ends up asking "are you sure"
 * in three different voices.
 */

const c = computed(() => state.pendingConfirm)
const open = ref(false)

function cancel(): void {
  state.pendingConfirm = null
  // §4 — the base a Catch up was going to use goes with the question it
  // belonged to; left behind it would furnish the next one.
  state.pendingPlanFrom = null
  open.value = false
}

async function go(): Promise<void> {
  await applyPendingConfirm()
  open.value = false
}

/**
 * Escape closes it, and the safe button is the one holding focus.
 *
 * Which button that is depends on the question: for setting work aside the
 * answer is nearly always yes, so Return should mean yes. For dropping an
 * entry there is no undo, and a dialog that arrives with Return already
 * meaning "destroy it" is a trap — Cancel takes the focus there, and the red
 * button has to be aimed at.
 */
const yes = ref<HTMLButtonElement | null>(null)
const no = ref<HTMLButtonElement | null>(null)

function onKey(e: KeyboardEvent): void {
  if (!c.value || e.key !== 'Escape') return
  e.stopPropagation()
  cancel()
}

onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))

watch(
  c,
  (v) => {
    open.value = false
    if (v) void nextTick(() => (v.danger ? no.value : yes.value)?.focus())
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="c" class="scrim" @mousedown.self="cancel">
    <div class="dlg" role="dialog" :aria-label="c.title">
      <header class="head">
        <h2>{{ c.title }}</h2>
        <span class="grow" />
        <button class="icon-btn" title="Cancel" @click="cancel"><X class="sm" /></button>
      </header>

      <!-- Their words, not ours. Pre-wrapped: a drafted message has a subject,
           a blank line and a body, and reflowing that into a paragraph would
           show something other than what is about to be committed. -->
      <blockquote v-if="c.quote" class="quote">{{ c.quote }}</blockquote>

      <div v-if="c.body.length" class="say">
        <p v-for="(line, i) in c.body" :key="i" :class="{ lead: i === 0, danger: c.danger && i === 0 }">
          {{ line }}
        </p>
      </div>

      <!-- §4 — only on a Catch up, and only under the sentence it qualifies:
           the branch is the one word in the question that is a choice. -->
      <BasePicker class="base" />

      <!-- The plan, kept but not insisted upon. `details` rather than a
           hand-rolled toggle: it is a disclosure, the platform has one, and
           this one is reachable by keyboard without anything being wired. -->
      <details
        v-if="c.plan"
        class="what"
        :open="open"
        @toggle="open = ($event.target as HTMLDetailsElement).open"
      >
        <summary>
          <ChevronRight class="chev sm" />
          <span>
            {{ c.plan.steps.length }} command{{ c.plan.steps.length === 1 ? '' : 's' }}
          </span>
          <span class="dim">— what this runs</span>
        </summary>
        <ol class="cmds">
          <li v-for="(s, i) in c.plan.steps" :key="i">
            <!-- With one step the title only says the command again; with
                 several it says which repository each belongs to. -->
            <span v-if="c.plan.steps.length > 1" class="ct">{{ s.title }}</span>
            <code class="mono cc selectable">{{ s.command }}</code>
          </li>
        </ol>
      </details>

      <footer class="foot">
        <span class="grow" />
        <button ref="no" class="btn ghost" @click="cancel">Cancel</button>
        <button
          ref="yes"
          class="btn"
          :class="c.danger ? 'danger solid' : 'primary'"
          :disabled="state.planBusy"
          @click="go"
        >
          {{ state.planBusy ? 'Working…' : c.verb }}
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
/* Narrower than the plan dialog on purpose: it is a question, and a question
   the width of a terminal reads as a report. */
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

/* Both of these give way before the footer does: a drafted message with a
   body, or a plan with a paragraph per repository, must not push Cancel off
   the bottom of a short window. */
.say { flex: 0 1 auto; min-height: 0; overflow-y: auto; padding: 4px 20px 10px; }
/* Directly under the quote there is already its own margin, so the body does
   not add a second one. */
.quote + .say { padding-top: 0; }

/* No rule down the side of it. The block is their text and the paragraphs
   under it are the app's, and a fill says that on its own — a coloured bar
   makes a quotation of something that is not a quotation, it is the thing
   about to be committed. */
.quote {
  flex: 0 1 auto;
  min-height: 0;
  overflow-y: auto;
  margin: 6px 20px 12px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.say p {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.55;
  color: var(--text-muted);
}
.say p + p { margin-top: 7px; }
/* With no plan folded under it, the sentences are the last thing above the
   footer, and 10px there reads as the footer having crowded them. */
.say:has(+ .foot) { padding-bottom: 16px; }
/* Sits with the sentences it qualifies rather than in a band of its own: the
   dialog is a paragraph and a question, and a rule across it would make two. */
.base { margin: 0 20px 12px; }
.say .lead { color: var(--text); }
.say .danger { color: var(--danger); }

/* Its own room, above the footer rather than against it: the disclosure is
   part of the question, and 4px of margin under it read as the footer having
   swallowed the row.

   It is also the part that gives way. The dialog is capped at 80vh and clips
   what does not fit, so in a short window a long command list pushed the
   footer — Cancel and the button that does the thing — off the bottom edge.
   Everything else here is one or two sentences; this is the only piece that
   can be any length, so this is the piece that scrolls. */
.what {
  flex: 0 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin: 0 12px 12px;
  border-radius: var(--radius-sm);
}
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

.cmds {
  margin: 2px 0 2px;
  padding: 0 8px 0 28px;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
}
.what summary { flex: none; }
.cmds li + li { margin-top: 9px; }
.ct { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
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
/* The one button in the app that is filled red: it is the only one here that
   destroys something, and `danger` alone is an outline. */
.btn.danger.solid {
  background: var(--danger);
  border-color: transparent;
  color: var(--accent-text);
}
.btn.danger.solid:hover:not(:disabled) { background: var(--danger); filter: brightness(1.08); }
</style>
