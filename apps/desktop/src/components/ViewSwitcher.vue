<script setup lang="ts">
import { SHELL_VIEWS, setView, state } from '../core/store.js'
import type { ShellView } from '../core/store.js'

/**
 * §12 — how the right of the window is divided, as one control.
 *
 * The button this replaces was a two-state toggle: the review was beside the
 * conversation or it was nowhere. Reading a long diff, or a file, or a
 * terminal, wants the whole window and does not want a chat column next to it,
 * and the only way to get that was to drag the divider across the screen and
 * drag it back afterwards. So there are three views and one control that shows
 * all three at once — the state you are in is lit, the other two are one click
 * away, and no click is a guess about what the next one will do.
 *
 * Drawn as a ladder, left to right, in the order the review grows: none of the
 * window, some of it, all of it. That is also the order ⌘⌥← and ⌘⌥→ walk, so
 * the keystroke and the control tell the same story.
 *
 * It ends the bar because it is the one control there that is about the
 * *window* rather than about the thing the window is showing.
 */

const META: Record<ShellView, { label: string; hint: string }> = {
  agent: { label: 'Agent', hint: 'Agent only — the conversation takes the width (⌘⌥←)' },
  split: { label: 'Split', hint: 'Agent and review side by side' },
  review: { label: 'Review', hint: 'Review only — diff, code, journal, terminal (⌘⌥→)' },
}

/**
 * One picture, three times, with the divider in three places: hard right, the
 * middle, hard left. The window and where it is cut — which is exactly what
 * the control does.
 *
 * The first attempt shaded the review's share instead, and shading is what was
 * wrong with it: a filled region beside a stroked frame is two tones in an icon
 * set that has exactly one, so the three sat in a row of lucide glyphs looking
 * like something from another app. Stroke only, at lucide's own weight, and
 * the three read as one family because they are one drawing.
 */
/* At a quarter, a half and three quarters of the box — spaced off both walls
   by the same 2.7, so the outer two are mirror images rather than one line
   crowding the frame and the other clear of it. */
const CUT: Record<ShellView, number> = { agent: 10.7, split: 8, review: 5.3 }

const views = SHELL_VIEWS.map((v) => ({ id: v, cut: CUT[v], ...META[v] }))
</script>

<template>
  <span class="vs">
    <button
      v-for="v in views"
      :key="v.id"
      :class="{ on: state.view === v.id }"
      :title="v.hint"
      :aria-label="v.label"
      :aria-pressed="state.view === v.id"
      @click="setView(v.id)"
    >
      <svg class="g" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2.6" y="3.6" width="10.8" height="8.8" rx="1.6" />
        <path :d="`M${v.cut} 3.6 V12.4`" />
      </svg>
    </button>
  </span>
</template>

<style scoped>
/* The instrument case beside it, to the pixel: same ground, same border, same
   padding, same 22px buttons. They are two cases on one bar and the eye reads
   a difference of a pixel in either as a mistake. */
.vs {
  -webkit-app-region: no-drag;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 3px;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  border: 1px solid var(--line-soft);
}

.vs > button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 22px;
  border-radius: 5px;
  color: var(--text-dim);
  transition: color var(--dur-1) var(--ease-soft), background var(--dur-1) var(--ease-soft);
}
.vs > button:hover { color: var(--text); background: var(--hover); }
/* The one you are in, at the weight the instruments use for the same fact. */
.vs > button.on { background: var(--panel-raised); color: var(--accent); box-shadow: var(--shadow-xs); }

/* 16px at 1.5, which is what `.sm` gives every lucide glyph on this bar. */
.g { width: 16px; height: 16px; flex: none; }
.g rect,
.g path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}
</style>
