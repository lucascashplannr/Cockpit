<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Check, Layers } from '@lucide/vue'
import { activeProject, projectNarrowing, shortName, toggleProjectRepo, widenProject } from '../../core/store.js'

/**
 * §7 — which of the project's repositories the next conversation is on.
 *
 * `Picker`'s menu behind an icon, with the one difference that it does not
 * close on a choice: this is several answers, not one, and a menu that shut after each
 * tick would be opened once per repository.
 *
 * Once the conversation exists the set is a fact about it — its paths were
 * fixed at launch — so the same place states it and offers nothing.
 */
const n = computed(() => projectNarrowing.value)
const open = ref(false)
const root = ref<HTMLElement | null>(null)

const names = computed(() =>
  (n.value?.every ?? [])
    .filter((w) => n.value!.picked.includes(w.id))
    .map((w) => shortName(w.name, activeProject.value?.name)),
)

function onDocDown(ev: MouseEvent): void {
  if (!root.value?.contains(ev.target as Node)) open.value = false
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') open.value = false
}
watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
  } else {
    document.removeEventListener('mousedown', onDocDown)
    document.removeEventListener('keydown', onKey)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <span
    v-if="n && n.frozen"
    class="fact"
    :title="'This conversation runs in ' + names.join(', ') + ' — fixed when it started'"
  >
    <Layers class="xs" />{{ n.narrowed ? names.join(', ') : 'all ' + n.every.length }}
  </span>
  <div v-else-if="n && n.every.length > 1" ref="root" class="picker">
    <!-- A glyph, not a labelled choice: the rows in the list are where this is
         usually said (⌘-click), and the count is in the bar. This is the same
         thing for a hand that is already down here. -->
    <button
      class="trigger"
      :class="{ open, narrowed: n.narrowed }"
      :title="n.narrowed ? 'Runs in ' + names.join(', ') + ' — click to change' : 'Runs in all ' + n.every.length + ' repositories — click to leave some out, or ⌘-click a repository in the list'"
      aria-label="Repositories"
      @click="open = !open"
    >
      <Layers class="ic" />
    </button>

    <div v-if="open" class="menu">
      <!-- What the list is, how much of it is in, and the way back to all of
           it — on one line, so the rows under it are only repositories. -->
      <div class="head">
        <span class="k">Runs in</span>
        <span class="count num">{{ n.picked.length }} of {{ n.every.length }}</span>
        <button v-if="n.narrowed" class="all" @click="widenProject(n.projectId)">Select all</button>
      </div>
      <button
        v-for="w in n.every"
        :key="w.id"
        class="item"
        :class="{ on: n.picked.includes(w.id) }"
        :title="n.picked.length === 1 && n.picked[0] === w.id ? 'The last one stays: a conversation needs somewhere to run' : w.path"
        @click="toggleProjectRepo(w.id)"
      >
        <span class="box"><Check v-if="n.picked.includes(w.id)" /></span>
        <span class="name">{{ w.name }}</span>
        <span v-if="w.git?.branch" class="hint" :title="w.git.branch">{{ w.git.branch }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.picker { position: relative; }

.trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* The clip's box, to the pixel: the two sit side by side. */
  width: 27px;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--inset, var(--bg));
  color: var(--text-muted);
}
.trigger:hover, .trigger.open { color: var(--text); border-color: var(--line-strong); background: var(--hover); }
.trigger .ic { width: 11px; height: 11px; }
/* Narrowed is the one state of this control that changes what Start does. */
.trigger.narrowed { color: var(--agent); background: var(--agent-soft); border-color: transparent; }

.menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 5px);
  z-index: 10;
  display: flex;
  flex-direction: column;
  padding: 4px;
  width: max-content;
  min-width: 240px;
  max-width: 340px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--panel-raised);
  box-shadow: var(--shadow-sm);
}
.head {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 5px 8px 6px;
  font-size: 10px;
  line-height: 1;
  color: var(--text-dim);
}
.head .k { letter-spacing: 0.05em; text-transform: uppercase; }
.head .count { color: var(--text-muted); }
.head .all {
  margin: -3px -4px -3px auto;
  padding: 3px 4px;
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-muted);
}
.head .all:hover { color: var(--text); background: var(--hover); }

.item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 8px;
  border-radius: 5px;
  text-align: left;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.item:hover { background: var(--hover); color: var(--text); }
.item.on { color: var(--text); }
/* A box, not a bare tick: several of these are on at once, and a column of
   ticks with gaps in it reads as a single choice that moved. */
.box {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  color: var(--accent-text);
}
.box .lucide { width: 9px; height: 9px; stroke-width: 3; color: var(--accent-text); opacity: 1; }
.item.on .box { background: var(--accent); border-color: var(--accent); }
.item:hover:not(.on) .box { border-color: var(--text-dim); }
.name { flex: 0 0 auto; white-space: nowrap; }
/* The branch gives way, never the name: it is a ticket title with slashes in
   it, and it is already on the row in the list. */
.hint {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  padding-left: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-dim);
}

/* Said, not asked: the memory chip's shape, one control to its left. */
.fact {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--text-muted);
}
.fact .xs { flex: none; width: 11px; height: 11px; color: var(--text-dim); }
</style>
