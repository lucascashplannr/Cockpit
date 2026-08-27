<script setup lang="ts">
import { computed } from 'vue'
import {
  AppWindow, ArrowUpFromLine, CirclePlay, CircleStop, FileCode, GitCompareArrows, Undo2,
} from '@lucide/vue'
import { activeWorkspace, client, guard, requestPlan } from '../core/store.js'

/**
 * The verbs for the selected workspace, living in the title band.
 *
 * They used to sit in the third column's title row, which pinned them to the
 * far right of a very wide column with nothing around them. The band is
 * window-wide chrome and had an empty half; putting them there balances it
 * against the mark on the left and gives the column its title row back.
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
    <button v-if="w.runtime" class="btn ghost" @click="toggleRuntime">
      <component :is="w.runtime.status === 'up' ? CircleStop : CirclePlay" />
      {{ w.runtime.status === 'up' ? 'Stop' : 'Start' }}
    </button>
    <button v-if="preview && preview.kind === 'url'" class="btn ghost" @click="openPreview">
      <AppWindow />Preview
    </button>
    <button class="btn ghost" @click="openIde"><FileCode />IDE</button>
    <span v-if="w.git" class="vrule" />
    <button v-if="w.git && !midOperation" class="btn ghost" @click="requestPlan(w.id, 'rebase')">
      <GitCompareArrows />Rebase
    </button>
    <button v-if="w.git && !midOperation" class="btn ghost" @click="requestPlan(w.id, 'push')">
      <ArrowUpFromLine />Push
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
  /* The band is the window's drag strip; without this it eats every click. */
  -webkit-app-region: no-drag;
}
/* Only 2px shorter than a standard .btn, and on the app's normal type and icon
   scale. The earlier 28px/12px shrink was there to fit a 44px band, and it
   made the primary verbs of the window read as the smallest controls in it. */
.verbs .btn {
  height: 30px;
  padding: 0 11px;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}
.verbs .btn:hover:not(:disabled) { background: var(--hover); border-color: var(--line); }
.verbs .icon-btn { width: 30px; height: 30px; }
.vrule {
  width: 1px;
  height: 18px;
  margin: 0 7px;
  background: var(--line);
}
</style>
