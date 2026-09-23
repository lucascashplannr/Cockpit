<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Archive, CirclePlay, CircleStop, Copy, FileCode, FolderOpen, Info, MessageSquarePlus, Pause, Play,
  SlidersHorizontal, Stamp, Trash2,
} from '@lucide/vue'
import {
  adoptTopic, askDeleteTopic, client, closeTopic, guard, newConversationOn, openDeclarations,
  startTopic, state, stopTopic, toast, toggleWorkspaceRuntime,
} from '../core/store.js'

/**
 * The right-click menu on a row of the list — a repository, a branch, a topic.
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

const serverRunning = computed(
  () => ws.value?.runtime?.status === 'up' || ws.value?.runtime?.status === 'starting',
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
    toast('info', 'path copied', { icon: 'copy' })
  } catch {
    toast('error', 'could not copy the path')
  }
}
</script>

<template>
  <div
    v-if="m && (ws || topic)"
    ref="root"
    class="menu ctx"
    role="menu"
    :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
    @contextmenu.prevent
  >
    <template v-if="ws">
      <button @click="act(() => newConversationOn({ kind: 'workspace', workspaceId: ws!.id }))">
        <MessageSquarePlus /> New conversation here
      </button>
      <!-- §8 — on the repositories of the project, not on a branch's
           worktree: a declaration belongs to the repository, and every
           worktree of it already runs what the repository declares. -->
      <button
        v-if="ws.kind === 'main' && ws.repoName"
        @click="act(() => openDeclarations(ws!.repoName))"
      >
        <SlidersHorizontal /> Manage commands &amp; servers
      </button>
      <button v-if="ws.runtime" @click="act(() => toggleWorkspaceRuntime(ws!))">
        <component :is="serverRunning ? CircleStop : CirclePlay" />
        {{ serverRunning ? 'Stop the servers' : 'Start the servers' }}
      </button>
      <span class="rule" />
      <button
        @click="act(() => guard(() => client.call('workspace.openIn', { workspaceId: ws!.id, target: 'ide' })))"
      >
        <FileCode /> Open in the editor
      </button>
      <button
        @click="act(() => guard(() => client.call('workspace.openIn', { workspaceId: ws!.id, target: 'finder' })))"
      >
        <FolderOpen /> Reveal in Finder
      </button>
      <button @click="act(() => copyPath(ws!.path))">
        <Copy /> Copy the path
      </button>
      <span class="rule" />
      <button @click="act(() => (state.detailsFor = { kind: 'workspace', id: ws!.id }))">
        <Info /> Details…
      </button>
    </template>

    <template v-else-if="topic">
      <button @click="act(() => newConversationOn({ kind: 'topic', topicId: topic!.id }))">
        <MessageSquarePlus /> New conversation on this topic
      </button>
      <button
        v-if="topicOwned"
        @click="act(() => (topic!.state === 'running' ? stopTopic(topic!.id) : startTopic(topic!.id)))"
      >
        <component :is="topic.state === 'running' ? Pause : Play" />
        {{ topic.state === 'running' ? 'Stop the servers' : 'Start the servers' }}
      </button>
      <span class="rule" />
      <!-- The gap this closes: an inferred topic had no verb but a conversation
           and a look, because every other one begins by reading a record that
           was never written. This writes it, and nothing else. -->
      <button
        v-if="adoptable"
        title="Record that these branches are one piece of work. Nothing on disk moves — the topic simply gains a name, a state, and the close and delete verbs."
        @click="act(() => adoptTopic(topic!.id))"
      >
        <Stamp /> Take over this topic
      </button>
      <button @click="act(() => (state.detailsFor = { kind: 'topic', id: topic!.id }))">
        <Info /> Details…
      </button>
      <template v-if="topicOwned">
        <span class="rule" />
        <!-- Refuses over unpushed work, and removing the checkouts is a plan
             of its own that is shown before anything happens. -->
        <button class="warn" @click="act(() => closeTopic(topic!.id, true))">
          <Archive /> Close the topic…
        </button>
        <!-- The other half of §16: close keeps, delete discards. Without it
             here, a topic you simply do not want had no verb but the palette. -->
        <button class="warn" @click="act(() => askDeleteTopic(topic!.id))">
          <Trash2 /> Delete the topic…
        </button>
      </template>
    </template>
  </div>
</template>

<style scoped>
/* At the pointer, over everything but the dialogs it can open. */
.ctx { position: fixed; z-index: 55; }
.ctx button.warn:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }
</style>
