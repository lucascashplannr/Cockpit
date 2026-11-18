<script setup lang="ts">
/**
 * The strip's counters, as the project tile draws its own one column to the
 * left (ProjectRail): three places that never move, an empty one a faint grey
 * dot. Servers on the left and changes on the right, as there; the middle is
 * the rail's agent, which a tile here already says with its glyph, so it holds
 * the thing the rail has no room for — commits not pushed.
 *
 * `busy` is the slot an act is running on right now: a server starting, a
 * push, a commit. That dot turns into a ring in its own colour and turns until
 * the act comes back, so the place that is about to change is the place that
 * says it is changing.
 */
export type StripSlot = 'run' | 'push' | 'dirty'

defineProps<{ run?: boolean; push?: boolean; dirty?: boolean; conflict?: boolean; busy?: StripSlot | null }>()
</script>

<template>
  <span class="slots">
    <i class="b run" :class="{ on: run, busy: busy === 'run' }" />
    <i class="b push" :class="{ on: push, busy: busy === 'push' }" />
    <i class="b dirty" :class="{ on: dirty || conflict, conflict, busy: busy === 'dirty' }" />
  </span>
</template>

<style scoped>
.slots {
  display: flex;
  flex: none;
  gap: 4px;
}
.b {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: block;
  box-sizing: border-box;
  background: var(--text-dim);
  opacity: 0.22;
}
.b.on { opacity: 1; }
.b.run { --hue: var(--ok); }
/* Not the green `ahead` wears in the wide row: beside a server's dot, two
   greens would be one thing said twice. */
.b.push { --hue: var(--info); }
.b.dirty { --hue: var(--warn); }
.b.dirty.conflict { --hue: var(--danger); }
.b.on { background: var(--hue); }

/* Busy: the dot becomes a ring with a gap, in the slot's own colour, lit
   whatever it was before. Same 6px footprint, so nothing beside it moves. */
.b.busy {
  opacity: 1;
  background: transparent;
  border: 1.5px solid var(--hue);
  border-right-color: transparent;
  animation: spin 0.8s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .b.busy { animation-duration: 2.4s; }
}
</style>
