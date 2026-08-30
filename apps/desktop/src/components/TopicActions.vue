<script setup lang="ts">
import { computed } from 'vue'
import { GitCompareArrows, GitMerge, Pause, Play } from '@lucide/vue'
import type { ListGroup } from '../core/store.js'
import { startTopic, mergeTopic, stopTopic, rebaseTopic } from '../core/store.js'

/**
 * §4 — the verbs of the selected topic, in the title band.
 *
 * They used to be four icons crowded into the list's group header, which made
 * the header read as a toolbar rather than as something you could stand on.
 * The band already holds the verbs of whatever the window is about; when that
 * is a topic, these are they. The agent is not among them: selecting the
 * topic already aimed the conversation at it.
 */

const props = defineProps<{ group: ListGroup }>()

const f = computed(() => props.group.topic)
const ws = computed(() => props.group.workspaces)

const ahead = computed(() => ws.value.reduce((n, w) => n + (w.git?.ahead ?? 0), 0))
const behind = computed(() => ws.value.reduce((n, w) => n + (w.git?.behind ?? 0), 0))
/** Uncommitted work: merging refuses over it, so the button says so up front. */
const dirty = computed(() =>
  ws.value.reduce((n, w) => n + (w.git?.staged ?? 0) + (w.git?.unstaged ?? 0), 0),
)

/**
 * §8 + §11 — the switch, and it is the same switch a repository has: stopped
 * means the branches are on disk and agents may still run in them, started
 * means the servers are up and the ports are bound. Only a topic Cockpit
 * actually opened has somewhere to keep that state, so an inferred one gets no
 * toggle (§3.9 — absent, not disabled).
 */
const togglable = computed(() => !!f.value && !f.value.derived && f.value.state !== 'closed')

async function toggle() {
  const topic = f.value
  if (!topic) return
  if (topic.state === 'running') await stopTopic(topic.id)
  else await startTopic(topic.id)
}
</script>

<template>
  <div class="verbs">
    <!-- §4 — the step the lifecycle was missing: the branch goes onto the
         base, in every repository the topic spans. -->
    <button
      v-if="togglable"
      class="btn ghost"
      :class="{ ready: ahead && !dirty }"
      :title="dirty
        ? 'Commit first — merging refuses over uncommitted changes'
        : 'Merge onto the base branch — one --no-ff merge per repository'"
      @click="mergeTopic(f!.id, false)"
    >
      <GitMerge />Merge
    </button>
    <!-- One plan across every repository it spans, stopping at the first
         conflict and keeping what already replayed. -->
    <button
      v-if="togglable"
      class="btn ghost"
      :class="{ nudge: behind }"
      :title="behind
        ? 'Rebase every repository onto its base — ' + behind + ' commit(s) behind'
        : 'Rebase every repository in this topic onto its base'"
      @click="rebaseTopic(f!.id)"
    >
      <GitCompareArrows />Rebase
    </button>
    <span v-if="togglable" class="vrule" />
    <button
      v-if="togglable"
      class="btn ghost toggle"
      :class="{ on: f!.state === 'running' }"
      :title="f!.state === 'running'
        ? 'Stop the servers — the branches stay where they are'
        : 'Start the servers for every repository in this topic'"
      @click="toggle"
    >
      <component :is="f!.state === 'running' ? Pause : Play" />
      {{ f!.state === 'running' ? 'Stop' : 'Start' }}
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
.verbs .btn {
  height: 30px;
  padding: 0 11px;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}
.verbs .btn:hover:not(:disabled) { background: var(--hover); border-color: var(--line); }
/* Behind its base is the one state where rebasing is the next thing to do. */
.nudge { color: var(--warn); }
/* Committed and ahead: landing is the next thing, so it says so. */
.ready { color: var(--ok); }
.toggle.on { color: var(--ok); }
.vrule {
  width: 1px;
  height: 18px;
  margin: 0 7px;
  background: var(--line);
}
</style>
