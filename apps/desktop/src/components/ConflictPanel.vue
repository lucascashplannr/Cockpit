<script setup lang="ts">
import { computed } from 'vue'
import { Ban, Check, CircleAlert, FileWarning, FileCode, SkipForward } from '@lucide/vue'
import {
  activeConflict, conflictBusy, markResolved, openConflictFile, resolveConflict,
} from '../core/store.js'

/**
 * §3.7 — the half of the git story that was missing.
 *
 * Cockpit already detected a stopped rebase and refused every other verb over
 * it: "this repository is in the middle of a rebase. Finish or abort it
 * first." It gave no way to do either. This is that way, and it is deliberately
 * the only thing on screen that can be acted on while the operation is open —
 * a conflict is a state to work in, not a notification to dismiss.
 *
 * Nothing here polls. The core re-probes on every file change, so a conflict
 * resolved in the IDE clears its own row.
 */

const op = computed(() => activeConflict.value)

/** Resolved here means "no markers left", which is what `continue` gates on —
 *  not "staged", which nobody should have to think about. */
const resolved = computed(() => {
  const o = op.value
  if (!o) return []
  return o.conflictedPaths.filter((p) => !o.unresolvedPaths.includes(p))
})

const ready = computed(() => !!op.value && op.value.unresolvedPaths.length === 0)

const heading = computed(() => {
  const o = op.value
  if (!o) return ''
  const where = o.branch ? o.branch : 'this branch'
  const onto = o.onto ? ' onto ' + o.onto : ''
  return o.kind === 'rebase' ? 'Rebasing ' + where + onto : o.kind + ' in progress'
})

const progress = computed(() => {
  const o = op.value
  return o?.step && o.total ? 'commit ' + o.step + ' of ' + o.total : null
})
</script>

<template>
  <div v-if="op" class="conflict-panel">
    <div class="bar">
      <CircleAlert class="sm ic" />
      <span class="head">{{ heading }}</span>
      <span v-if="progress" class="prog num">{{ progress }}</span>
      <span class="grow" />

      <button
        class="btn primary"
        :disabled="!ready || conflictBusy"
        :title="ready
          ? 'Stage the resolved files and carry on'
          : op.unresolvedPaths.length + ' file(s) still carry conflict markers'"
        @click="resolveConflict('continue')"
      >
        <Check />Continue
      </button>
      <button
        v-if="op.kind !== 'merge'"
        class="btn ghost"
        :disabled="conflictBusy"
        title="Drop this commit and move to the next"
        @click="resolveConflict('skip')"
      >
        <SkipForward />Skip
      </button>
      <button
        class="btn ghost danger"
        :disabled="conflictBusy"
        title="Put the branch back exactly where it started"
        @click="resolveConflict('abort')"
      >
        <Ban />Abort
      </button>
    </div>

    <!-- The autostash is the thing that used to go missing, so it is said out
         loud rather than left to be discovered. -->
    <p class="note">
      Uncommitted work is held by git's own autostash and comes back when this ends —
      including on abort. Nothing is stranded.
    </p>

    <ul v-if="op.conflictedPaths.length" class="files">
      <li v-for="p in op.conflictedPaths" :key="p" :class="{ done: !op.unresolvedPaths.includes(p) }">
        <component :is="op.unresolvedPaths.includes(p) ? FileWarning : Check" class="sm fi" />
        <button class="path mono" :title="'Open ' + p" @click="openConflictFile(p)">{{ p }}</button>
        <span v-if="!op.unresolvedPaths.includes(p)" class="tag ok">resolved</span>
        <button
          v-else
          class="tag act"
          title="This file is meant to contain those markers — mark it resolved anyway"
          :disabled="conflictBusy"
          @click="markResolved([p])"
        >
          mark resolved
        </button>
        <button class="icon-btn small" title="Open in the editor" @click="openConflictFile(p)">
          <FileCode class="sm" />
        </button>
        <span class="grow" />
      </li>
    </ul>

    <p v-if="op.conflictedPaths.length && resolved.length === op.conflictedPaths.length" class="ready">
      All {{ op.conflictedPaths.length }} resolved — Continue will stage them for you.
    </p>
  </div>
</template>

<style scoped>
/* Not `.conflict`: WorkspaceRow already uses that for its per-row badge, and
   two components sharing a class name is a trap for anything that queries the
   DOM by it, scoped styles or no. */
.conflict-panel {
  flex: none;
  padding: 11px 16px 12px;
  background: var(--danger-soft);
  border-bottom: 1px solid var(--line);
}

.bar { display: flex; align-items: center; gap: 8px; }
.ic { color: var(--danger); flex: none; }
.head {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--danger);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.prog { font-size: var(--fs-xs); color: var(--text-muted); flex: none; }
.grow { flex: 1; }
.bar .btn { height: 28px; padding: 0 11px; flex: none; }
/* A filled primary at 0.4 opacity still reads as a button you may press. The
   whole point of the gate is that Continue is not available yet, so it drops
   the fill entirely rather than fading it. */
.bar .btn.primary:disabled {
  opacity: 1;
  background: transparent;
  border-color: var(--line);
  color: var(--text-dim);
  box-shadow: none;
}
.bar .btn.danger { color: var(--danger); }
.bar .btn.danger:hover:not(:disabled) { border-color: var(--danger); }

.note {
  margin: 8px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.5;
}

.files { list-style: none; margin: 9px 0 0; padding: 0; }
.files li {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  font-size: var(--fs-xs);
}
.fi { flex: none; color: var(--danger); }
.files li.done .fi { color: var(--ok); }
.path {
  border: 0;
  background: none;
  padding: 0;
  max-width: 46ch;
  color: var(--text);
  font-size: var(--fs-xs);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path:hover { color: var(--accent); text-decoration: underline; }
.files li.done .path { color: var(--text-dim); }

.tag {
  flex: none;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: none;
}
.tag.ok { color: var(--ok); }
.tag.act { color: var(--text-muted); border-color: var(--line); cursor: pointer; }
.tag.act:hover:not(:disabled) { color: var(--text); background: var(--hover); }

.ready {
  margin: 8px 0 0;
  font-size: var(--fs-xs);
  color: var(--ok);
}
</style>
