<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronDown, ExternalLink, LoaderCircle, Play, SlidersHorizontal, Zap } from '@lucide/vue'
import type { DeclaredServer, Topic, Workspace } from '@cockpit/shared'
import DialogShell from './DialogShell.vue'
import OverflowMenu from './OverflowMenu.vue'
import {
  client, guard, refreshCommands, runningServers, runtimeBusy, startTopic, state, stopTopic, switchWorkspaces, toast,
  toggleWorkspaceRuntime,
} from '../core/store.js'

/**
 * §8 — what a topic or the project runs: one switch for the whole stack, and
 * beside it the stack by name. Each row starts or stops one server and says
 * whether Start includes it — written to the manifest, so it holds everywhere.
 *
 * A topic switches through `topic.start` (it settles port conflicts with other
 * topics); the project switches the checkouts it is given.
 */

const props = defineProps<{
  /** The shared folder the project's own declarations run in, if any. */
  folder: Workspace | null
  /** The repositories in scope. */
  repos: Workspace[]
  /** Set on a topic: its own switch and state. */
  topic?: Topic | null
  /** Start is waiting on the topic's setup. */
  waiting?: boolean
}>()

/** Every checkout that runs something: the folder, then the repositories. */
const hosts = computed(() =>
  [...(props.folder ? [props.folder] : []), ...props.repos].filter((w) => w.runtime),
)

/** A declared server and the checkout it runs in here. */
type Row = DeclaredServer & { ws: Workspace }

const servers = ref<Row[]>([])

const hostKey = computed(() => hosts.value.map((h) => h.id + ':' + h.runtime?.impl).join())

async function load(): Promise<void> {
  const key = hostKey.value
  const s = await Promise.all(
    hosts.value.map(async (h) =>
      (await client.call('runtime.servers', { workspaceId: h.id }).catch(() => [])).map(
        (x): Row => ({ ...x, ws: h }),
      ),
    ),
  )
  // An answer for a set nobody is looking at any more is not an answer.
  if (hostKey.value !== key) return
  servers.value = s.flat()
}

// A checkout's runtime appears once the core has read a server for it, and the
// lists change whenever the manifest is written from the window.
watch([hostKey, () => state.declarations, () => state.commands], () => void load(), { immediate: true })

/** Read off the checkout the store holds now, not the one the row was built with. */
const live = (s: Row) => state.workspaces.find((w) => w.id === s.ws.id) ?? s.ws
const isAlive = (s: Row) => runningServers(live(s)).has(s.name)

/** Something up is something Stop has to stop, whoever started it. */
const running = computed(
  () =>
    props.topic?.state === 'running' ||
    hosts.value.some((w) => w.runtime?.status === 'up' || w.runtime?.status === 'starting'),
)
/** Pressed and not answered yet — the switch, or one of its servers by name. */
const pending = computed(
  () =>
    (props.topic && runtimeBusy[props.topic.id]) || hosts.value.map((h) => runtimeBusy[h.id]).find(Boolean) || null,
)
const switchLabel = computed(() =>
  pending.value ? (pending.value === 'start' ? 'Starting…' : 'Stopping…') : running.value ? 'Stop all' : 'Start all',
)
const where = computed(() => (props.topic ? 'this topic' : 'these repositories'))
const switchTitle = computed(() => {
  if (running.value) return 'Stop the servers — the branches stay where they are'
  if (props.waiting) return 'Start waits for the setup to finish'
  const names = servers.value.filter((s) => s.inStart).map((s) => s.name)
  return names.length ? 'Start ' + names.join(', ') : 'Start the servers of ' + where.value
})

async function toggle() {
  const t = props.topic
  if (t) {
    if (running.value) await stopTopic(t.id)
    else await startTopic(t.id)
    return
  }
  await switchWorkspaces(hosts.value.map((h) => state.workspaces.find((w) => w.id === h.id) ?? h), running.value ? 'stop' : 'start')
}

async function toggleServer(s: Row) {
  await toggleWorkspaceRuntime(live(s), s.name)
}

/** On or off `start:` — the project's list, so every topic's. */
async function setOnStart(s: Row) {
  // Ticked at once: the core re-reads the whole project before it answers,
  // and a check that lags by seconds gets clicked a second time.
  const wanted = !s.inStart
  s.inStart = wanted
  const res = await guard(() =>
    client.call('declare.setStart', { projectId: s.ws.projectId, name: s.name, inStart: wanted }),
  )
  if (!res || !res.ok) {
    s.inStart = !wanted
    if (res) toast('error', res.detail)
    return
  }
  await Promise.all([load(), refreshCommands()])
}

const urlOf = (w: Workspace | null | undefined) => {
  const p = w?.runtime?.preview
  return (p?.kind === 'url' && p.value) || null
}

/**
 * Where the servers answer, while they do. The folder first, since that is
 * the project's own; otherwise the one repository that serves a page. Two or
 * more and the arrow would be a guess, so it is left to their rows.
 */
const opener = computed(() => {
  if (urlOf(props.folder)) return props.folder
  const serving = props.repos.filter((w) => urlOf(w))
  return serving.length === 1 ? serving[0]! : null
})
const openable = computed(() => urlOf(opener.value))

async function openPreview() {
  const w = opener.value
  if (w) await guard(() => client.call('workspace.openIn', { workspaceId: w.id, target: 'browser' }))
}

/** A row's own address, while it answers and is a page. */
const rowUrl = (s: Row) => (s.url && s.open && isAlive(s) ? s.url : null)

function openRow(s: Row) {
  const url = rowUrl(s)
  if (url) window.open(url, '_blank')
}

function noteOf(s: Row): string {
  if (s.unresolved.length) return 'nothing named ' + s.unresolved.map((u) => '{{' + u + '}}').join(', ')
  return ''
}

/** The port beside the name, while something is bound to it. */
const portOf = (s: Row) => (isAlive(s) && s.port ? s.port : null)

/** Running first, then the rest, each in declared order. */
const ordered = computed(() => [
  ...servers.value.filter((x) => isAlive(x)),
  ...servers.value.filter((x) => !isAlive(x)),
])

/** The sheet where Start all's list is set — a setting, not a daily act. */
const startSheet = ref(false)
</script>

<template>
  <!-- Nothing declared and nothing answering: the switch alone. -->
  <button
    v-if="!servers.length && !openable"
    class="srv btn ghost sw solo"
    :class="{ on: running, working: pending }"
    :disabled="!!pending"
    :title="switchTitle"
    @click="toggle"
  >
    <LoaderCircle v-if="pending" class="spin" />
    <i v-else-if="running" class="live" />
    <Play v-else />
    <span class="vl">{{ switchLabel }}</span>
  </button>
  <div v-else class="srv split" :class="{ working: pending }">
    <button class="btn ghost run sw" :class="{ on: running }" :disabled="!!pending" :title="switchTitle" @click="toggle">
      <LoaderCircle v-if="pending" class="spin" />
      <i v-else-if="running" class="live" />
      <Play v-else />
      <span class="vl">{{ switchLabel }}</span>
    </button>
    <template v-if="openable">
      <span class="div" />
      <button
        class="btn ghost half"
        :title="'Open ' + openable"
        :aria-label="'Open ' + openable"
        @click="openPreview"
      >
        <ExternalLink />
      </button>
    </template>
    <template v-if="servers.length">
      <span class="div" />
      <!-- Never off: a server starting shows its own spinner on its row. -->
      <OverflowMenu class="pick" :label="'The servers of ' + where">
        <template #trigger><ChevronDown /></template>
        <!-- The repository's own server menu, row for row (WorkspaceActions):
             the dot, the name, its port, a bolt when Start all starts it, and
             the way to it. -->
        <div v-for="s in ordered" :key="s.ws.id + s.name" class="srow">
          <button
            class="one"
            :disabled="!!runtimeBusy[s.ws.id]"
            :title="(isAlive(s) ? 'Stop ' : 'Start ') + s.name + ' — ' + s.ws.name"
            @click.stop="toggleServer(s)"
          >
            <LoaderCircle v-if="runtimeBusy[s.ws.id]" class="spin" />
            <i v-else class="sd" :class="{ on: isAlive(s), bad: s.unresolved.length }" />
            {{ s.name }}
            <span v-if="portOf(s)" class="pt">({{ portOf(s) }})</span>
            <!-- After the name: it comes up with Start all. -->
            <span v-if="s.inStart" class="auto" title="Starts with Start all"><Zap aria-label="starts with Start all" /></span>
            <span v-if="noteOf(s)" class="sc">{{ noteOf(s) }}</span>
          </button>
          <button
            v-if="rowUrl(s)"
            class="go"
            :title="'Open ' + rowUrl(s)"
            :aria-label="'Open ' + rowUrl(s)"
            @click="openRow(s)"
          >
            <ExternalLink />
          </button>
        </div>
        <span class="rule" />
        <button @click="startSheet = true"><SlidersHorizontal /> Start all settings</button>
      </OverflowMenu>
    </template>
  </div>
  <!-- Out of the bar: it is a container, and a fixed box inside one is
       positioned against it rather than the window. -->
  <Teleport to="body">
    <!-- Settings' own sheet, row and Off/On switch (SettingsDialog). Saves
         as you go, like Settings. -->
    <DialogShell v-if="startSheet" title="Start all" @close="startSheet = false">
      <div v-for="s in servers" :key="s.ws.id + s.name" class="row">
        <div class="txt">
          <span class="t">{{ s.name }}</span>
          <span class="d">{{ s.ws.name }}</span>
        </div>
        <div class="seg">
          <button :class="{ on: !s.inStart }" @click="s.inStart && setOnStart(s)">Off</button>
          <button :class="{ on: s.inStart }" @click="!s.inStart && setOnStart(s)">On</button>
        </div>
      </div>
    </DialogShell>
  </Teleport>
</template>

<style scoped>
/* Drawn as the bars' own verbs: 26px, ghost, on the branch chip's ground. */
.srv.btn,
.srv .btn,
.srv :deep(.btn) {
  height: 26px;
  font-size: var(--fs-xs);
  gap: 6px;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  color: var(--text-muted);
}
.srv.btn { padding: 0 9px; }
.srv.btn:hover:not(:disabled),
.srv .btn:hover:not(:disabled),
.srv :deep(.btn:hover:not(:disabled)) { background: var(--hover); color: var(--text); border-color: transparent; }
.srv .lucide,
.srv.btn .lucide { width: 14px; height: 14px; }

/* Running is one dot in the glyph's slot, not a green switch. */
.live { flex: none; display: inline-grid; place-items: center; width: 14px; height: 14px; }
.live::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }

.split {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 26px;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
}
.srv.btn.solo { background: var(--bg-sunken); }
.srv.btn.solo:hover:not(:disabled) { background: var(--hover); }
.split :deep(.btn) { border-radius: 0; }
.split .btn.run { padding: 0 6px 0 8px; border-radius: var(--radius-sm) 0 0 var(--radius-sm); }
.split .btn.half { padding: 0 6px; }
.split .btn.half:last-child { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
.split .div { flex: none; width: 1px; height: 12px; background: var(--line); }
.split :deep(.pick .btn) { padding: 0 4px; border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
.split :deep(.pick .lucide) { width: 13px; height: 13px; }

.sd {
  flex: none;
  width: var(--ic-sm);
  height: var(--ic-sm);
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--text-dim);
  transform: scale(0.5);
}
.sd.on { background: var(--ok); box-shadow: none; }
.sd.bad { background: var(--warn); box-shadow: none; }

/* ── the menu: the repository's rows, drawn the same (WorkspaceActions) ── */
/* Starts with Start all: a small bolt after the name, quiet like the port. */
.auto { flex: none; display: inline-grid; place-items: center; margin-left: -3px; color: var(--text-dim); }
.menu button .auto .lucide { width: 11px; height: 11px; color: inherit; }
.srow { display: flex; align-items: center; gap: 1px; }
.srow .one { flex: 1; min-width: 0; }
.menu .srow .one .spin { width: var(--ic-sm); height: var(--ic-sm); color: var(--accent); }
.menu .srow .go { flex: none; padding: 0 7px; color: var(--text-dim); }
.menu .srow .go:hover { color: var(--text); }
.menu .srow .go .lucide { width: 13px; height: 13px; }
.pt { margin-left: -4px; font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.sc { margin-left: auto; padding-left: 14px; font-size: 11px; color: var(--text-dim); }

/* The sheet: Settings' row — what it is, then the control (SettingsDialog). */
.row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--line-overlay);
}
.row:first-child { padding-top: 0; }
.row:last-child { border-bottom: none; }
.row > .seg { flex: none; }
.txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.t { font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.d { font-size: var(--fs-xs); line-height: 1.5; color: var(--text-dim); }

/* Narrow bar: the switch drops its word — its icon is a play triangle and
   nothing else here is. */
@container (max-width: 620px) {
  .sw .vl { display: none; }
  .srv.btn { padding: 0 6px; }
}
/* Pressed and on its way: off, but not dimmed — a dimmed spinner reads as
   "not available", and this is the opposite. */
.split.working :deep(.btn:disabled),
.srv.btn.working:disabled { opacity: 1; cursor: progress; }
.srv .spin,
.srv.btn .spin { color: var(--accent); }
</style>
