<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Archive, CirclePlay, CircleStop, Copy, FileCode, FolderGit2, FolderInput, FolderOutput, FolderOpen, FolderPen, FolderPlus,
  GitBranch, Info, Layers, MessageSquarePlus, PenLine, Settings, ShieldCheck, ShieldOff, SlidersHorizontal, Stamp, Trash2, Unlink,
} from '@lucide/vue'
import { attentionIcon } from './agent/attention.js'
import { markIcon } from './agent/mark.js'
import {
  addRepoTo, adoptTopic, attentionOf, askDeleteTopic, askTrashProject, askUngroup, askUntrackProject, askUntrackRepo, client, closeTopic, groupRepos, guard, isBranchProtected, isBusy, isRepoGroup,
  markThreadRead, markThreadUnread, newConversationOn, openDeclarations, openProjectDeclarations, openMarkDialog, readThreadOn, revealLabel, selectProject, setBranchProtected, startTopic, state,
  stopTopic, toast, toggleWorkspaceRuntime,
} from '../core/store.js'

/**
 * The right-click menu on a row of the list — a repository, a branch, a topic —
 * and on a project's tile in the rail.
 *
 * The same verbs as the bars and the palette, reachable from the thing itself
 * without selecting it first. Same `.menu` look as the overflow menu, so it is
 * one kind of list in two places rather than a second design.
 */

const m = computed(() => state.contextMenu)
const root = ref<HTMLElement | null>(null)
/** Where it is drawn, once it has been measured against the window's edges. */
const pos = ref({ left: 0, top: 0 })

const ws = computed(() =>
  m.value?.target.kind === 'workspace'
    ? (state.workspaces.find((w) => w.id === m.value!.target.id) ?? null)
    : null,
)
const topic = computed(() =>
  m.value?.target.kind === 'topic'
    ? (state.topics.find((f) => f.id === m.value!.target.id) ?? null)
    : null,
)

/** A project's rail tile. */
const project = computed(() =>
  m.value?.target.kind === 'project'
    ? (state.projects.find((p) => p.id === m.value!.target.id) ?? null)
    : null,
)
/**
 * The project's own folder, when Cockpit tracks it as a checkout: the editor
 * and Finder open a checkout, so without one those two are not offered.
 */
const projectRoot = computed(() =>
  project.value
    ? (state.workspaces.find((w) => w.projectId === project.value!.id && w.path === project.value!.root) ?? null)
    : null,
)

/** A conversation's tab or History row: its status, and read or unread. */
const conv = computed(() =>
  m.value?.target.kind === 'conversation'
    ? ([...state.agents, ...state.keptAgents].find((c) => c.id === m.value!.target.id) ?? null)
    : null,
)
/** Read or unread is a choice only while the thread is neither working, asking, nor removed. */
const convRead = computed(() => {
  const c = conv.value
  if (!c || c.hiddenAt !== null || isBusy(c)) return null
  const a = attentionOf(c)
  return a === 'none' ? 'read' : a === 'reply' ? 'unread' : null
})

const serverRunning = computed(
  () => ws.value?.runtime?.status === 'up' || ws.value?.runtime?.status === 'starting',
)
/**
 * The answer this row has already shown, if it has one — what "Mark as unread"
 * puts the mark back on. Null while the row is lit, working, or has never had
 * a conversation, and the item is simply not there.
 */
const readThread = computed(() =>
  ws.value
    ? readThreadOn({ kind: 'workspace', workspaceId: ws.value.id })
    : topic.value
      ? readThreadOn({ kind: 'topic', topicId: topic.value.id })
      : project.value
        ? readThreadOn({ kind: 'project', projectId: project.value.id })
        : null,
)

/**
 * §7 — a repository of the project, as opposed to a branch of one: the row
 * that carries what is set per repository.
 */
const repo = computed(() => (ws.value?.kind === 'main' && ws.value.repoName ? ws.value : null))
/** The branch worth guarding first, and whether it already is. */
const base = computed(() => repo.value?.git?.base ?? null)
const baseProtected = computed(() => isBranchProtected(repo.value, base.value))
/** The project's own folder, when it is the repository: untracking that is untracking the project. */
const isProjectRoot = computed(
  () => !!repo.value && state.projects.find((p) => p.id === repo.value!.projectId)?.root === repo.value.path,
)

/** §4 — a group's own header, which takes the group's verbs rather than a row's. */
const group = computed(() => (ws.value && isRepoGroup(ws.value) ? ws.value : null))

/**
 * §4 — the groups this repository could move into: every other one of its
 * project's. Only a repository at its main checkout moves; a topic's branch
 * stays where the topic keeps it.
 */
const groupsElsewhere = computed(() =>
  repo.value && !isProjectRoot.value
    ? state.workspaces
        .filter((w) => w.projectId === repo.value!.projectId && isRepoGroup(w) && w.id !== repo.value!.groupId)
        .sort((a, b) => a.name.localeCompare(b.name))
    : [],
)
const groupNow = computed(() =>
  repo.value?.groupId ? (state.workspaces.find((w) => w.id === repo.value!.groupId) ?? null) : null,
)

/** An inferred topic has nowhere to keep a state, so it has no switch and nothing to close. */
const topicOwned = computed(() => !!topic.value && !topic.value.derived && topic.value.state !== 'closed')
/** … and the one verb that ends that: the record it never had, written. */
const adoptable = computed(() => !!topic.value && topic.value.derived)

function close() {
  state.contextMenu = null
}


/**
 * Every item closes the menu, and does not wait for a slow act to do it. The
 * act is *started* first: `ws` and `topic` are read off the open menu, so
 * closing it first would hand the act a null.
 */
function act(fn: () => unknown) {
  const pending = fn()
  close()
  void pending
}

watch(
  m,
  async (v) => {
    if (!v) return
    pos.value = { left: v.x, top: v.y }
    await nextTick()
    const el = root.value
    if (!el) return
    // Flip away from an edge rather than run off it, like a native menu does.
    const r = el.getBoundingClientRect()
    const pad = 8
    pos.value = {
      left: v.x + r.width + pad > window.innerWidth ? Math.max(pad, v.x - r.width) : v.x,
      top: v.y + r.height + pad > window.innerHeight ? Math.max(pad, v.y - r.height) : v.y,
    }
  },
  { immediate: true },
)

function onDown(e: MouseEvent) {
  if (m.value && root.value && !root.value.contains(e.target as Node)) close()
}

/** Captured and stopped, for the same reason as OverflowMenu: it is the innermost layer. */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && m.value) {
    e.stopImmediatePropagation()
    close()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDown, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', close)
  window.addEventListener('resize', close)
  // Captured: the list scrolls inside its own element, not the window.
  document.addEventListener('scroll', close, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDown, true)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('blur', close)
  window.removeEventListener('resize', close)
  document.removeEventListener('scroll', close, true)
})

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path)
    toast('info', 'Path copied', { icon: 'copy', lines: [path] })
  } catch {
    toast('error', 'could not copy the path')
  }
}

/** A topic is one branch name across every repository it spans. */
async function copyBranch(name: string) {
  try {
    await navigator.clipboard.writeText(name)
    toast('info', 'Branch name copied', { icon: 'copy', lines: [name] })
  } catch {
    toast('error', 'could not copy the branch name')
  }
}

/** New topic opens on the active project, so the tile's project becomes it first. */
function newTopicOn(projectId: string) {
  if (state.activeProjectId !== projectId) selectProject(projectId)
  state.topicDialogOpen = true
}
</script>

<template>
  <!-- Every target reads in the same order, parted by hairlines:
       talk (a conversation, read or unread) · act on it · what it is · end it.
       A group that would be empty is not drawn, and neither is its rule. -->
  <div
    v-if="m && (ws || topic || conv || project)"
    ref="root"
    class="menu ctx"
    role="menu"
    :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
    @contextmenu.prevent
  >
    <template v-if="group">
      <button @click="act(() => newConversationOn({ kind: 'workspace', workspaceId: group!.id }))">
        <MessageSquarePlus /> New conversation
      </button>
      <button v-if="readThread" @click="act(() => markThreadUnread(readThread!))">
        <component :is="attentionIcon('reply')" /> Mark as unread
      </button>
      <span class="rule" />
      <button
        @click="act(() => guard(() => client.call('workspace.openIn', { workspaceId: group!.id, target: 'ide' })))"
      >
        <FileCode /> Open in the editor
      </button>
      <button
        @click="act(() => guard(() => client.call('workspace.openIn', { workspaceId: group!.id, target: 'finder' })))"
      >
        <FolderOpen /> {{ revealLabel }}
      </button>
      <button @click="act(() => copyPath(group!.path))">
        <Copy /> Copy the path
      </button>
      <span class="rule" />
      <button @click="act(() => (state.groupDialog = { projectId: group!.projectId, groupId: group!.id, pick: [] }))">
        <FolderPen /> Edit the group…
      </button>
      <!-- The repositories move back out; nothing is lost, so it is not red. -->
      <button @click="act(() => askUngroup(group!.id))">
        <FolderOutput /> Ungroup…
      </button>
    </template>

    <template v-else-if="ws">
      <button @click="act(() => newConversationOn({ kind: 'workspace', workspaceId: ws!.id }))">
        <MessageSquarePlus /> New conversation
      </button>
      <button v-if="readThread" @click="act(() => markThreadUnread(readThread!))">
        <component :is="attentionIcon('reply')" /> Mark as unread
      </button>
      <template v-if="ws.runtime">
        <span class="rule" />
        <button @click="act(() => toggleWorkspaceRuntime(ws!))">
          <component :is="serverRunning ? CircleStop : CirclePlay" />
          {{ serverRunning ? 'Stop the servers' : 'Start the servers' }}
        </button>
      </template>
      <span class="rule" />
      <button
        @click="act(() => guard(() => client.call('workspace.openIn', { workspaceId: ws!.id, target: 'ide' })))"
      >
        <FileCode /> Open in the editor
      </button>
      <button
        @click="act(() => guard(() => client.call('workspace.openIn', { workspaceId: ws!.id, target: 'finder' })))"
      >
        <FolderOpen /> {{ revealLabel }}
      </button>
      <button @click="act(() => copyPath(ws!.path))">
        <Copy /> Copy the path
      </button>
      <span class="rule" />
      <button @click="act(() => (state.detailsFor = { kind: 'workspace', id: ws!.id }))">
        <Info /> Details…
      </button>
      <template v-if="repo">
        <!-- §8 — on the repositories of the project, not on a branch's
             worktree: a declaration belongs to the repository, and every
             worktree of it already runs what the repository declares. -->
        <button @click="act(() => openDeclarations(repo!.repoName))">
          <SlidersHorizontal /> Commands &amp; servers…
        </button>
        <!-- §16 — the one rule set per repository. Its patterns (`release/*`)
             are written out in project settings, a click further. -->
        <button v-if="base" @click="act(() => setBranchProtected(repo!.id, base!, !baseProtected))">
          <component :is="baseProtected ? ShieldOff : ShieldCheck" />
          {{ baseProtected ? 'Unprotect' : 'Protect' }} {{ base }}
        </button>
        <template v-if="!isProjectRoot">
          <!-- §4 — a group is a folder, so each of these moves this one. -->
          <span class="rule" />
          <button
            v-for="g in groupsElsewhere"
            :key="g.id"
            @click="act(() => groupRepos(repo!.projectId, [repo!.id], g.name))"
          >
            <FolderInput /> Move to {{ g.name }}
          </button>
          <button v-if="groupNow" @click="act(() => groupRepos(repo!.projectId, [repo!.id], null))">
            <FolderOutput /> Out of {{ groupNow.name }}
          </button>
          <button @click="act(() => (state.groupDialog = { projectId: repo!.projectId, groupId: null, pick: [repo!.id] }))">
            <FolderPlus /> New group…
          </button>
          <span class="rule" />
          <!-- Cockpit forgets it; every file stays. Not red: nothing is lost. -->
          <button @click="act(() => askUntrackRepo(repo!.projectId, repo!.id))">
            <Unlink /> Remove from Cockpit…
          </button>
        </template>
      </template>
    </template>

    <template v-else-if="topic">
      <button @click="act(() => newConversationOn({ kind: 'topic', topicId: topic!.id }))">
        <MessageSquarePlus /> New conversation
      </button>
      <button v-if="readThread" @click="act(() => markThreadUnread(readThread!))">
        <component :is="attentionIcon('reply')" /> Mark as unread
      </button>
      <template v-if="!topic.derived">
        <span class="rule" />
        <button
          v-if="topicOwned"
          @click="act(() => (topic!.state === 'running' ? stopTopic(topic!.id) : startTopic(topic!.id)))"
        >
          <component :is="topic.state === 'running' ? CircleStop : CirclePlay" />
          {{ topic.state === 'running' ? 'Stop the servers' : 'Start the servers' }}
        </button>
        <!-- Where you say it stands: the conversation's menu, at the same spot. -->
        <button v-if="!topic.derived" @click="act(() => openMarkDialog('topic', topic!.id))">
          <component :is="markIcon(topic.mark?.kind ?? 'review')" /> {{ topic.mark ? 'Change the status…' : 'Set a status…' }}
        </button>
      </template>
      <span class="rule" />
      <!-- The details sheet is where a topic is renamed, so that is what it is
           called on one that can be; an inferred one only has details. -->
      <button @click="act(() => (state.detailsFor = { kind: 'topic', id: topic!.id }))">
        <component :is="topic.derived ? Info : PenLine" /> {{ topic.derived ? 'Details…' : 'Edit the topic…' }}
      </button>
      <button @click="act(() => copyBranch(topic!.slug))">
        <GitBranch /> Copy the branch name
      </button>
      <!-- The gap this closes: an inferred topic had no verb but a conversation
           and a look, because every other one begins by reading a record that
           was never written. This writes it, and nothing else. -->
      <button
        v-if="adoptable"
        title="Record that these branches are one piece of work. Nothing on disk moves: the topic simply gains a name, a state, and Close and Delete."
        @click="act(() => adoptTopic(topic!.id))"
      >
        <Stamp /> Take over this topic
      </button>
      <template v-if="topicOwned">
        <span class="rule" />
        <!-- Close keeps the branch and refuses over unpushed work, so it is
             not red; Delete discards it (§16), and is. -->
        <button @click="act(() => closeTopic(topic!.id, true))">
          <Archive /> Close the topic…
        </button>
        <button class="warn" @click="act(() => askDeleteTopic(topic!.id))">
          <Trash2 /> Delete the topic…
        </button>
      </template>
    </template>

    <!-- A project's rail tile: its verbs, without having to stand on it first. -->
    <template v-else-if="project">
      <button @click="act(() => newConversationOn({ kind: 'project', projectId: project!.id }))">
        <MessageSquarePlus /> New conversation
      </button>
      <button v-if="readThread" @click="act(() => markThreadUnread(readThread!))">
        <component :is="attentionIcon('reply')" /> Mark as unread
      </button>
      <span class="rule" />
      <button @click="act(() => newTopicOn(project!.id))">
        <Layers /> New topic…
      </button>
      <button @click="act(() => addRepoTo(project!.id))">
        <FolderGit2 /> Add a repository…
      </button>
      <span class="rule" />
      <template v-if="projectRoot">
        <button
          @click="act(() => guard(() => client.call('workspace.openIn', { workspaceId: projectRoot!.id, target: 'ide' })))"
        >
          <FileCode /> Open in the editor
        </button>
        <button
          @click="act(() => guard(() => client.call('workspace.openIn', { workspaceId: projectRoot!.id, target: 'finder' })))"
        >
          <FolderOpen /> {{ revealLabel }}
        </button>
      </template>
      <button @click="act(() => copyPath(project!.root))">
        <Copy /> Copy the path
      </button>
      <span class="rule" />
      <button @click="act(() => (state.editingProjectId = project!.id))">
        <Settings /> Project settings…
      </button>
      <button @click="act(() => openProjectDeclarations(project!.id))">
        <SlidersHorizontal /> Commands &amp; servers…
      </button>
      <span class="rule" />
      <button @click="act(() => askUntrackProject(project!.id))">
        <Unlink /> Remove from Cockpit…
      </button>
      <button class="warn" @click="act(() => askTrashProject(project!.id))">
        <Trash2 /> Move to the Trash…
      </button>
    </template>

    <!-- A conversation: what a topic's menu says about it, for one thread. -->
    <template v-else-if="conv">
      <button v-if="convRead === 'read'" @click="act(() => markThreadUnread(conv!))">
        <component :is="attentionIcon('reply')" /> Mark as unread
      </button>
      <button v-else-if="convRead === 'unread'" @click="act(() => markThreadRead(conv!))">
        <component :is="attentionIcon('reply')" /> Mark as read
      </button>
      <button @click="act(() => openMarkDialog('conversation', conv!.id))">
        <component :is="markIcon(conv.mark?.kind ?? 'review')" /> {{ conv.mark ? 'Change the status…' : 'Set a status…' }}
      </button>
    </template>
  </div>
</template>

<style scoped>
/* At the pointer, over everything but the dialogs it can open. */
.ctx { position: fixed; z-index: 55; }
.ctx button.warn:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }
</style>
