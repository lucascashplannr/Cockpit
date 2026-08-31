<script setup lang="ts">
import { computed } from 'vue'
import {
  ArrowUp, ChevronRight, CircleAlert, FolderPlus, Hand, Layers, Plus, RefreshCw, Sparkles,
} from '@lucide/vue'
import WorkspaceRow from './WorkspaceRow.vue'
import {
  activeProject, activityFor, addRepoTo, client, collapsedTopics, guard, openAgentOn,
  selectedTopicId, state, toggleTopicCollapsed, workspaceGroups,
} from '../core/store.js'

/**
 * §12 — "La liste centrale liste des workspaces, groupés par topic quand un
 * topic existe. Un workspace nu et un groupe de trois cohabitent
 * naturellement." The topic header only appears when there is a topic.
 *
 * Two kinds of row, and the vocabulary is theirs: a repository on its default
 * branch, and a branch checked out in its own folder.
 */

const groups = computed(() => workspaceGroups.value)

const hasProjects = computed(() => state.projects.length > 0)

function topicSummary(ws: { git: { ahead: number } | null; runtime: { status: string } | null }[]) {
  const ahead = ws.reduce((n, w) => n + (w.git?.ahead ?? 0), 0)
  const up = ws.filter((w) => w.runtime?.status === 'up').length
  return { ahead, up, total: ws.length }
}

async function refresh() {
  await guard(() => client.call('core.reconcile', {}), 'refreshed')
}

/**
 * §4 — the topic is the unit of work, so it is something you select, exactly
 * as you select one of its rows. Selecting it aims the agent at the whole
 * topic; its verbs — merge, rebase, start — are then in the title band, where
 * the verbs of the selected thing belong (TopicActions).
 */
function selectTopic(topicId: string) {
  openAgentOn({ kind: 'topic', topicId })
}

/**
 * §4 — a topic is where the work is put down and picked back up, so it is also
 * where "an agent is on this" has to be visible. A conversation opened on the
 * topic itself lights this, and so does one opened on any single row under it:
 * from the header, both are the same answer to "is something happening here".
 */
/**
 * A folded topic still has to answer "is my selection in there": the third
 * column goes on showing a branch whose row is now hidden, and a header that
 * said nothing would leave the window pointing at something with no trace of
 * it in the list.
 */
function holdsSelection(ws: { id: string }[]): boolean {
  return ws.some((x) => x.id === state.activeWorkspaceId)
}

const ATTENTION_TEXT: Record<string, string> = {
  reply: 'an agent answered on this topic — waiting for you',
  blocked: 'an agent stopped on this topic: it was refused a tool it needed',
  failed: 'an agent failed on this topic',
}
</script>

<template>
  <section class="list">
    <div class="scroll">
      <div v-if="!hasProjects" class="empty">
        <FolderPlus />
        <strong>No project yet</strong>
        <span>
          Add one with <span class="kbd">+</span> in the rail, or run
          <code class="mono">cockpit add .</code> in any repository.
        </span>
      </div>

      <template v-else>
        <div v-for="(g, i) in groups" :key="g.topicId ?? 'loose-' + i" class="group">
          <!-- A topic is a decoration (§4): no topic, no header. And a
               header you can stand on: selecting it is selecting its scope. -->
          <div
            v-if="g.title"
            class="group-head"
            :class="{ running: g.topic?.state === 'running', selected: g.topicId === selectedTopicId }"
          >
            <!-- Its own control, because folding is not selecting: the header
                 is a place to stand as much as a lid to close. -->
            <button
              v-if="g.topicId"
              class="twist"
              :title="collapsedTopics[g.topicId] ? 'Show its branches' : 'Fold this topic away'"
              @click="toggleTopicCollapsed(g.topicId)"
            >
              <ChevronRight class="sm" :class="{ turned: !collapsedTopics[g.topicId] }" />
            </button>
            <Layers v-else class="sm gi" />
            <button
              class="pick"
              :disabled="!g.topicId"
              @click="g.topicId && selectTopic(g.topicId)"
            >
              <span class="title">{{ g.title }}</span>
            </button>
            <span class="summary num">
              <!-- Folded, and the selection is inside: the only trace left. -->
              <span
                v-if="g.topicId && collapsedTopics[g.topicId] && holdsSelection(g.workspaces)"
                class="here"
                title="The branch this window is on is inside this topic"
              />
              <span
                v-if="g.topicId && activityFor('topic', g.topicId).running"
                class="agent live"
                :title="activityFor('topic', g.topicId).running + ' conversation(s) running on this topic'"
              >
                <Sparkles class="sm" />{{ activityFor('topic', g.topicId).running }}
              </span>
              <span
                v-if="g.topicId && activityFor('topic', g.topicId).attention !== 'none'"
                class="needs"
                :class="activityFor('topic', g.topicId).attention"
                :title="ATTENTION_TEXT[activityFor('topic', g.topicId).attention]"
              >
                <component
                  :is="activityFor('topic', g.topicId).attention === 'reply' ? Hand : CircleAlert"
                  class="sm"
                />
              </span>
              <span v-if="topicSummary(g.workspaces).ahead" class="up">
                <ArrowUp class="sm" />{{ topicSummary(g.workspaces).ahead }}
              </span>
              <span class="dim">{{ topicSummary(g.workspaces).total }}</span>
            </span>
          </div>
          <div v-else-if="groups.length > 1 && i > 0" class="divider">
            <span class="section-label">not in a topic</span>
          </div>

          <WorkspaceRow
            v-for="w in (g.topicId && collapsedTopics[g.topicId] ? [] : g.workspaces)"
            :key="w.id"
            :workspace="w"
            :compact="!!g.title"
          />
        </div>
      </template>
    </div>

    <footer v-if="activeProject" class="foot">
      <span class="root" :title="activeProject.root">{{ activeProject.root }}</span>
      <!-- §7 — the widest scope, from the thing it is scoped to: every
           repository in the project, at its main checkout. -->
      <button
        class="icon-btn small go"
        title="Ask the agent across the whole project — every repository, on its default branch"
        @click="openAgentOn({ kind: 'project', projectId: activeProject.id })"
      >
        <Sparkles class="sm" />
      </button>
      <button
        class="icon-btn small"
        title="Open a topic — one named branch across every repository it touches"
        @click="state.topicDialogOpen = true"
      >
        <Plus class="sm" />
      </button>
      <!-- §7 - one folder per repository, inside the project folder. Beside
           the topic button because it is the same kind of act: adding
           something to the project rather than looking at what is in it. -->
      <button
        class="icon-btn small"
        title="Add a repository — a new one, a clone, or a folder moved in"
        @click="addRepoTo(activeProject.id)"
      >
        <FolderPlus class="sm" />
      </button>
      <button class="icon-btn small" title="Refresh everything" @click="refresh">
        <RefreshCw class="sm" />
      </button>
    </footer>
  </section>
</template>

<style scoped>
/* The one verb that is not git: it gets the accent that means agent. */
.go:hover { color: var(--agent); background: var(--agent-soft); }

.list {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--panel);
  border-right: 1px solid var(--line);
}

.scroll {
  flex: 1;
  overflow-y: auto;
  /* The column starts at its own top edge now that the search field has gone
     up into the band: --col-top is the same inset the rail and the third
     column take, so all three begin on one line. */
  padding: var(--col-top) 10px 12px;
}

.group + .group { margin-top: 14px; }

/* Same shape as a row, one step up in weight: it is selected the same way,
   and the rows beneath it are what it holds. */
.group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 11px;
  margin-bottom: 2px;
  border-radius: var(--radius-sm);
  text-align: left;
  position: relative;
  transition: background var(--dur-1) var(--ease-soft);
}
.group-head:hover { background: var(--hover); }
.group-head.selected { background: var(--selected); }

/* The lid. Wider than the glyph so it is hittable, and it turns rather than
   swapping icon: the same mark pointing somewhere else reads as one control
   in two states, where two marks read as two controls. */
.twist {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: -3px;
  border-radius: 4px;
  color: var(--text-dim);
}
.twist:hover { color: var(--text); background: var(--line-soft); }
.twist .lucide { transition: transform var(--dur-1) var(--ease-soft); }
.twist .turned { transform: rotate(90deg); }

/* The name is still the place to stand: selecting the topic aims the agent at
   it, and that must not become a second click away because folding arrived. */
.pick {
  flex: 1;
  min-width: 0;
  text-align: left;
}
.pick:disabled { cursor: default; }

/* Folded, with the selection inside. One dot, in the accent: it is the same
   statement the row's own bar makes, made in the only space left. */
.here {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}
.group-head.selected::before {
  content: '';
  position: absolute;
  left: 0;
  top: 7px;
  bottom: 7px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
}
.group-head.selected .gi { color: var(--accent); }
.gi { color: var(--text-dim); }
.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}
.summary { display: flex; align-items: center; gap: 9px; font-size: var(--fs-xs); }
.summary .up { color: var(--ok); display: inline-flex; align-items: center; gap: 2px; }
.summary .up .lucide { width: 11px; height: 11px; stroke-width: 2.4; }
.summary .dim { color: var(--text-dim); }
.summary .agent { color: var(--agent); display: inline-flex; align-items: center; gap: 2px; }
.summary .agent .lucide { width: 11px; height: 11px; stroke-width: 2.4; }
/* Only ever on the thing that is actually running — the header inherits it
   from its rows, and two pulses side by side would say nothing extra. */
.summary .live { animation: pulse 1.6s var(--ease-soft) infinite; }
.summary .needs { display: inline-flex; align-items: center; }
.summary .needs .lucide { width: 12px; height: 12px; stroke-width: 2.4; }
.summary .needs.reply { color: var(--agent); }
.summary .needs.blocked { color: var(--warn); }
.summary .needs.failed { color: var(--danger); }

/* Live reads as a state of the header, not as a badge to hunt for. */
.group-head.running .gi { color: var(--ok); }

.divider { padding: 16px 11px 6px; }

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 8px 0 14px;
  border-top: 1px solid var(--line);
  background: var(--panel);
}
.root {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* Truncate from the left; `plaintext` keeps the string itself in reading
     order, which bare `rtl` does not — it moves the leading slash to the end. */
  direction: rtl;
  unicode-bidi: plaintext;
  text-align: left;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  font-family: var(--mono);
}
.icon-btn.small { width: 26px; height: 26px; }
.empty code { font-size: var(--fs-xs); color: var(--text-muted); }
.empty .kbd { height: 18px; min-width: 18px; }
</style>
