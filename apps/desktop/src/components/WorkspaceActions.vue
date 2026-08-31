<script setup lang="ts">
import { computed } from 'vue'
import {
  AppWindow, ArrowUpFromLine, CirclePlay, CircleStop, FileCode, GitCompareArrows, Undo2,
} from '@lucide/vue'
import { activeWorkspace, client, guard, requestPlan } from '../core/store.js'

/**
 * The verbs for the selected workspace, on the bar of the column it is about.
 *
 * They spent a while in the window's title band, which balanced that band but
 * put them across all four columns — and dragged the workspace's *name* up
 * there with them, purely so they would have a subject beside them. Both are
 * back beside the thing they act on.
 *
 * §3.9 still governs what is drawn: no workspace, no verbs; no git, no rebase.
 */

const w = computed(() => activeWorkspace.value)
const preview = computed(() => w.value?.runtime?.preview ?? null)

/**
 * §3.9 — while a rebase is stopped, Rebase and Push are not verbs this
 * workspace has: git refuses both, and the three that do apply are in the
 * conflict panel. Absent, not greyed out.
 */
const midOperation = computed(() => !!w.value?.git?.operation)

async function toggleRuntime() {
  const ws = w.value
  if (!ws?.runtime) return
  const method = ws.runtime.status === 'up' ? 'runtime.down' : 'runtime.up'
  await guard(() => client.call(method, { workspaceId: ws.id }))
}

async function openIde() {
  const ws = w.value
  if (!ws) return
  await guard(() => client.call('workspace.openIn', { workspaceId: ws.id, target: 'ide' }))
}

async function openPreview() {
  const ws = w.value
  if (!ws) return
  await guard(() => client.call('workspace.openIn', { workspaceId: ws.id, target: 'browser' }))
}

async function undo() {
  const ws = w.value
  if (!ws) return
  await guard(() => client.call('git.undo', { workspaceId: ws.id }))
}
</script>

<template>
  <div v-if="w" class="verbs">
    <button
      v-if="w.runtime"
      class="btn ghost"
      :title="w.runtime.status === 'up' ? 'Stop the servers' : 'Start the servers'"
      @click="toggleRuntime"
    >
      <component :is="w.runtime.status === 'up' ? CircleStop : CirclePlay" />
      <span class="vl">{{ w.runtime.status === 'up' ? 'Stop' : 'Start' }}</span>
    </button>
    <button
      v-if="preview && preview.kind === 'url'"
      class="btn ghost"
      title="Open this workspace's preview"
      @click="openPreview"
    >
      <AppWindow /><span class="vl">Preview</span>
    </button>
    <button class="btn ghost" title="Open in the configured editor" @click="openIde">
      <FileCode /><span class="vl">IDE</span>
    </button>
    <span v-if="w.git" class="vrule" />
    <button
      v-if="w.git && !midOperation"
      class="btn ghost"
      title="Rebase onto the base branch"
      @click="requestPlan(w.id, 'rebase')"
    >
      <GitCompareArrows /><span class="vl">Rebase</span>
    </button>
    <button
      v-if="w.git && !midOperation"
      class="btn ghost"
      title="Push this branch"
      @click="requestPlan(w.id, 'push')"
    >
      <ArrowUpFromLine /><span class="vl">Push</span>
    </button>
    <button
      v-if="w.git && !midOperation"
      class="icon-btn"
      title="Roll back to the last restore point"
      @click="undo"
    >
      <Undo2 class="sm" />
    </button>
  </div>
</template>

<style scoped>
.verbs {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: none;
}
/* Sized for the column bar rather than for a 50px band: the same height as the
   instruments beside them, so the row reads as one strip of controls and not
   as verbs visiting from somewhere else. */
.verbs .btn {
  height: 28px;
  padding: 0 9px;
  font-size: var(--fs-xs);
  gap: 6px;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  color: var(--text-muted);
}
.verbs .btn:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.verbs .icon-btn { width: 28px; height: 28px; }
.verbs .btn .lucide { width: 14px; height: 14px; }
.vrule {
  width: 1px;
  height: 16px;
  margin: 0 5px;
  background: var(--line);
}

/* Narrow column: the icons carry the verbs on their own. Every one of them
   keeps its tooltip, so nothing becomes unnameable — it becomes unlabelled,
   which is the trade a 380px column is asking for. */
@container (max-width: 700px) {
  .verbs .vl { display: none; }
  .verbs .btn { padding: 0 6px; }
}
</style>
