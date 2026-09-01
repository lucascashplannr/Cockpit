<script setup lang="ts">
import { computed } from 'vue'
import { GitCompareArrows, GitMerge, Pause, Play } from '@lucide/vue'
import type { ListGroup } from '../core/store.js'
import OverflowMenu from './OverflowMenu.vue'
import { startTopic, mergeTopic, stopTopic, rebaseTopic } from '../core/store.js'

/**
 * §4 — the verbs of the selected topic, on the bar of the column it is about.
 *
 * Same ranking as a repository's (WorkspaceActions), for the same reason: the
 * servers' switch is always the act you came for, and the git verbs are drawn
 * only while they are the next thing to do — Merge once there is something
 * committed and ahead, Rebase while the topic is behind its base. Both are in
 * the menu at all times, so the bar being quiet never means the verb is gone.
 *
 * The agent is not among them: selecting the topic already aimed the
 * conversation at it.
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

const mergeTitle = computed(() =>
  dirty.value
    ? 'Commit first — merging refuses over uncommitted changes'
    : 'Merge onto the base branch — one --no-ff merge per repository',
)

async function toggle() {
  const topic = f.value
  if (!topic) return
  if (topic.state === 'running') await stopTopic(topic.id)
  else await startTopic(topic.id)
}
</script>

<template>
  <div v-if="togglable" class="verbs">
    <!-- Always: it is the switch. -->
    <button
      class="btn ghost sw"
      :class="{ on: f!.state === 'running' }"
      :title="f!.state === 'running'
        ? 'Stop the servers — the branches stay where they are'
        : 'Start the servers for every repository in this topic'"
      @click="toggle"
    >
      <component :is="f!.state === 'running' ? Pause : Play" />
      <span class="vl">{{ f!.state === 'running' ? 'Stop' : 'Start' }}</span>
    </button>

    <!-- §4 — the step the lifecycle was missing: the branch goes onto the
         base, in every repository the topic spans. Drawn on the bar once
         there is something to merge and nothing in the way of merging it. -->
    <button
      v-if="ahead && !dirty"
      class="btn ghost ready"
      :title="mergeTitle"
      @click="mergeTopic(f!.id, false)"
    >
      <GitMerge /><span class="vl">Merge</span>
    </button>
    <button
      v-if="behind"
      class="btn ghost nudge"
      :title="'Rebase every repository onto its base — ' + behind + ' commit(s) behind'"
      @click="rebaseTopic(f!.id)"
    >
      <GitCompareArrows /><span class="vl">Rebase</span>
    </button>

    <OverflowMenu label="Everything else this topic can do">
      <button :title="mergeTitle" @click="mergeTopic(f!.id, false)">
        <GitMerge /> Merge onto the base
      </button>
      <!-- One plan across every repository it spans, stopping at the first
           conflict and keeping what already replayed. -->
      <button @click="rebaseTopic(f!.id)">
        <GitCompareArrows /> Rebase every repository
      </button>
    </OverflowMenu>
  </div>
</template>

<style scoped>
/* Sized for the column bar rather than for the window's title band: the same
   height as the instruments beside them, so the row reads as one strip of
   controls and not as verbs visiting from somewhere else. */
.verbs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
.verbs .btn {
  height: 26px;
  padding: 0 9px;
  font-size: var(--fs-xs);
  gap: 6px;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  color: var(--text-muted);
}
.verbs .btn:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.verbs .btn .lucide { width: 14px; height: 14px; }

/* Behind its base is the one state where rebasing is the next thing to do.
   Committed and ahead is the one where merging is. */
.nudge { color: var(--warn); }
.ready { color: var(--ok); }
.verbs .btn.on { color: var(--ok); }

/* Narrow column: the switch drops its word — its icon is a play triangle and
   nothing else here is. The promoted git verbs keep theirs, which is the whole
   reason they were promoted. */
@container (max-width: 620px) {
  .verbs .btn.sw .vl { display: none; }
  .verbs .btn { padding: 0 6px; }
}
</style>
