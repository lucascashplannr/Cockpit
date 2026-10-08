<script setup lang="ts">
/**
 * The strip's counters, as the project tile draws its own one column to the
 * left (ProjectRail): three places that never move, an empty one a faint grey
 * dot. Servers on the left and changes on the right, as there; the middle is
 * the rail's agent, which a tile here already says with its glyph, so it holds
 * the thing the rail has no room for — commits not pushed.
 */
defineProps<{ run?: boolean; push?: boolean; dirty?: boolean; conflict?: boolean }>()
</script>

<template>
  <span class="slots">
    <i class="b run" :class="{ on: run }" />
    <i class="b push" :class="{ on: push }" />
    <i class="b dirty" :class="{ on: dirty || conflict, conflict }" />
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
  background: var(--text-dim);
  opacity: 0.22;
}
.b.on { opacity: 1; }
.b.run.on { background: var(--ok); }
/* Not the green `ahead` wears in the wide row: beside a server's dot, two
   greens would be one thing said twice. */
.b.push.on { background: var(--info); }
.b.dirty.on { background: var(--warn); }
.b.dirty.conflict { background: var(--danger); }
</style>
