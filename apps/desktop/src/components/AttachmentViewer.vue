<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, X } from '@lucide/vue'
import { editDraftText, state, stepAttachment } from '../core/store.js'

/**
 * An attachment, at the size it was worth attaching — a picture, a paste or a
 * file — with the others from the same message one arrow away.
 *
 * A 72-pixel tile says *that* a screenshot or 155 lines are there; neither
 * lets anyone read the error message inside. This is where they are actually
 * looked at. One viewer for every kind rather than one per kind, because a
 * message is read in the order its tiles sit, and an arrow that stopped at the
 * first thing that was not a picture made you close and reopen to go on.
 *
 * A paste still in the composer is editable — trimming a log down to the part
 * that matters is the most common thing to want before sending one. A sent
 * turn is what was said and a file is someone else's bytes, so those only read.
 *
 * Deliberately not a dialog: there is no decision here and so no buttons to
 * weigh. A scrim, the thing, its name, and every way out you would try without
 * being told — Escape, the ✕, a click on the space around it.
 *
 * The name sits *under* the content, and that is not a taste decision: this
 * app draws its own traffic lights at (10, 19), floating above everything
 * including this scrim, so a title in the top-left corner is a title with
 * three coloured circles through it.
 *
 * Escape and ← → are handled in `App.vue` with the rest of the layers, so the
 * order things close in stays written down in one place.
 */
const v = computed(() => state.pendingView)
const shown = computed(() => v.value?.items[v.value.at] ?? null)
const many = computed(() => (v.value?.items.length ?? 0) > 1)
const sheet = ref<HTMLElement | null>(null)

function close(): void {
  state.pendingView = null
}

function edit(ev: Event): void {
  const s = shown.value
  if (s?.kind === 'text' && s.draftId) editDraftText(s.draftId, (ev.target as HTMLTextAreaElement).value)
}

// Each item starts at its own top: a sheet scrolled halfway down the last one
// is not where reading the next one begins. Not focused, though — a caret in
// the sheet would take ← and → away from stepping.
watch(
  () => v.value?.at,
  () => void nextTick(() => sheet.value?.querySelector('.body')?.scrollTo(0, 0)),
)
</script>

<template>
  <!-- `mousedown.self`, matching the dialogs: a drag that starts on the content
       and ends on the scrim is someone selecting, not someone asking to close. -->
  <div v-if="v && shown" class="scrim viewer" @mousedown.self="close">
    <!-- Top-right, where the window's own ✕ would be if it were on this side:
         the traffic lights step aside while this is open. -->
    <button class="out" title="Close — or press Escape" @click="close">
      <X class="md" />
    </button>

    <!-- One step per press and wrapping: a message's attachments are a thing
         you flick between rather than navigate. -->
    <button v-if="many" class="step back" title="Previous — or press ←" @click="stepAttachment(-1)">
      <ChevronLeft class="md" />
    </button>

    <figure class="frame" :class="shown.kind" @mousedown.self="close">
      <!-- Where you are, above the thing rather than under it: it is read
           before deciding whether to step, not after. -->
      <span v-if="many" class="count">{{ v.at + 1 }} of {{ v.items.length }}</span>
      <!-- Keyed on the source: swapping images must replace the element rather
           than repoint it, or the browser holds the old frame while the new
           one decodes and the step looks like it did nothing. -->
      <template v-if="shown.kind === 'image'">
        <img v-if="shown.src" :key="shown.src" class="shot" :src="shown.src" :alt="shown.name" />
        <div v-else class="sheet short"><p class="empty">Loading…</p></div>
      </template>
      <div v-else ref="sheet" class="sheet" :class="{ short: typeof shown.text !== 'string' }">
        <textarea
          v-if="shown.draftId"
          :key="shown.draftId"
          class="body selectable"
          spellcheck="false"
          :value="shown.text ?? ''"
          @input="edit"
        />
        <pre v-else-if="typeof shown.text === 'string'" class="body selectable">{{ shown.text }}</pre>
        <p v-else-if="shown.text === undefined" class="empty">Loading…</p>
        <p v-else class="empty">This file is not text, so there is nothing to show here.</p>
      </div>

      <!-- On a panel of its own. Bare on the scrim it was grey on blurred grey,
           and over a light window it simply could not be read. -->
      <figcaption class="cap">
        <span class="name">{{ shown.name }}</span>
        <span v-if="shown.kind === 'text'" class="of">{{ shown.meta }}</span>
      </figcaption>
    </figure>

    <button v-if="many" class="step fwd" title="Next — or press →" @click="stepAttachment(1)">
      <ChevronRight class="md" />
    </button>
  </div>
</template>

<style scoped>
/* Above the dialogs: it is opened from the thread, and whatever is under it
   stays exactly where it was. */
.scrim {
  /* The project rail and the scope bar are window-drag regions, and Electron
     decides drag from those regions alone — stacking order does not enter
     into it. Without this, the ← over the rail and the ✕ over the bar moved
     the window instead of being pressed. */
  -webkit-app-region: no-drag;
  position: fixed;
  inset: 0;
  z-index: 70;
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

.frame {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin: 0;
  /* Clear of the step buttons on either side: 16px in, 36px wide, and air. */
  max-width: calc(100vw - 150px);
  min-width: 0;
}
.frame.text { width: min(920px, calc(100vw - 150px)); align-items: stretch; }

/* A plain panel behind the image keeps a PNG with rounded corners legible in
   both themes without decorating the thing being looked at. */
.shot {
  max-width: 100%;
  /* Room for the caption and the same air above the picture as below it. */
  max-height: calc(100vh - 150px);
  object-fit: contain;
  border-radius: var(--radius);
  background: var(--panel-raised);
  box-shadow: var(--shadow-lg);
}

.sheet {
  display: flex;
  height: calc(100vh - 170px);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: var(--panel-raised);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
/* A file that is not text, or one still loading, has one sentence to say. */
.sheet.short { height: 160px; min-width: 420px; }
/* Unwrapped, so an indented line is still the line that was copied. */
.body {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 16px 18px;
  overflow: auto;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--text);
  font-family: var(--mono);
  font-size: var(--fs-xs);
  line-height: 1.6;
  white-space: pre;
  tab-size: 4;
}
.empty {
  margin: auto;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}

.cap {
  align-self: center;
  display: flex;
  align-items: baseline;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel-raised);
  box-shadow: var(--shadow-sm);
  color: var(--text);
}
.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
  font-weight: 560;
}
.of { flex: none; font-size: var(--fs-xs); color: var(--text-muted); }
.count {
  align-self: center;
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel-raised);
  box-shadow: var(--shadow-sm);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}
/* Every child too: a no-drag parent does not carve its children out on every
   Electron version, and these are the parts that are pressed. */
.scrim * { -webkit-app-region: no-drag; }

/* The same round panel as the arrows. As a bare icon on the scrim it was grey
   on blurred grey, and the one way out that is drawn rather than remembered
   has to be the easiest thing on the screen to find. */
.out {
  position: fixed;
  top: 12px;
  right: 14px;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--panel-raised);
  border: 1px solid var(--line-strong);
  color: var(--text-muted);
  box-shadow: var(--shadow-sm);
}
.out:hover { color: var(--text); background: var(--hover); }

.step {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--panel-raised);
  border: 1px solid var(--line-strong);
  color: var(--text-muted);
  box-shadow: var(--shadow-sm);
}
.step:hover { color: var(--text); background: var(--hover); }
.step.back { left: 16px; }
.step.fwd { right: 16px; }
.md { width: 17px; height: 17px; }
</style>
