<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { CirclePlay, CircleStop, ExternalLink, RotateCw } from '@lucide/vue'
import type { ProcessLog, ServerBoardRow, Workspace } from '@cockpit/shared'
import {
  client, guard, loadRuntimeLogs, onRuntimeLogData, refreshBoard, selectWorkspace, state,
  toggleWorkspaceRuntime,
} from '../../core/store.js'

/**
 * §8 + §11 — what is running on this machine, and what it is saying.
 *
 * The two halves of "not enough feedback about starting", in one surface. The
 * board answers *where*: the port allocator has always known which workspace
 * holds which port and the window never asked it, so a person with three
 * worktrees up had no way to tell which one was on which number short of
 * reading `lsof`. The log answers *why*: the supervisor has captured every
 * dev server's stdout since it was written, into a ring buffer nothing could
 * read — so a server that failed to boot and one that booted looked exactly
 * alike from here.
 *
 * Deliberately machine-wide rather than scoped to the selected workspace.
 * Running two topics of two different projects at once is the case the global
 * allocator exists for, and a board that stopped at the project boundary
 * would not answer the question it is opened to answer.
 */

const props = defineProps<{ workspace: Workspace }>()

/** Which row's output is being read. Defaults to the workspace you came from. */
const shown = ref<string>(props.workspace.id)
const history = ref<ProcessLog[]>([])
const body = ref<HTMLElement | null>(null)
const follow = ref(true)

const rows = computed(() => state.board)
const current = computed(() => rows.value.find((r) => r.workspaceId === shown.value) ?? null)

/**
 * What was already written, then whatever arrives after. The push carries only
 * new chunks, so a tab opened onto a server that has been up for an hour would
 * otherwise start blank until the next line.
 */
const text = computed(() => {
  const past = history.value.map((h) => h.text).join('')
  return past + (state.runtimeLogs[shown.value] ?? '')
})

/** ANSI is what a dev server writes; nothing here renders it, so it goes. */
const clean = computed(() =>
  text.value
    // Written as an escape rather than a literal ESC byte: a control
    // character in source survives until something normalises it away, and
    // then strips nothing while still looking correct.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .slice(-600),
)

async function loadFor(id: string) {
  history.value = await loadRuntimeLogs(id)
}

watch(shown, (id) => void loadFor(id), { immediate: true })
watch(() => props.workspace.id, (id) => { shown.value = id })

// Refreshed on the way in: the board is a snapshot and the tab may have been
// closed while three topics came and went.
void refreshBoard()

let stop: (() => void) | null = null
watch(
  shown,
  (id) => {
    stop?.()
    stop = onRuntimeLogData(id, () => {
      if (!follow.value) return
      requestAnimationFrame(() => {
        const el = body.value
        if (el) el.scrollTop = el.scrollHeight
      })
    })
  },
  { immediate: true },
)
onBeforeUnmount(() => stop?.())

/** Scrolling up means you are reading; scrolling back down means you are not. */
function onScroll() {
  const el = body.value
  if (!el) return
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

/** The topic, or the project when it adds something the name does not. */
function contextOf(r: ServerBoardRow): string | null {
  if (r.topic) return r.topic
  return r.project === r.workspace ? null : r.project
}

function workspaceOf(id: string): Workspace | null {
  return state.workspaces.find((w) => w.id === id) ?? null
}

async function toggle(id: string) {
  const w = workspaceOf(id)
  if (w) await toggleWorkspaceRuntime(w)
}

async function open(url: string | null, id: string) {
  if (!url) return
  await guard(() => client.call('workspace.openIn', { workspaceId: id, target: 'browser' }))
}

/** The board is where you go to compare, so a row is also a way to get there. */
function reveal(id: string) {
  shown.value = id
  selectWorkspace(id)
}
</script>

<template>
  <div class="servers">
    <!-- ── the board ──────────────────────────────────────────────────── -->
    <div class="board">
      <div class="bhead">
        <span>Running</span>
        <button class="icon-btn" title="Re-probe every runtime" @click="refreshBoard()">
          <RotateCw class="sm" />
        </button>
      </div>

      <div v-if="!rows.length" class="empty">Nothing with a runtime yet.</div>

      <button
        v-for="r in rows"
        :key="r.workspaceId"
        class="row"
        :class="{ on: r.workspaceId === shown }"
        @click="reveal(r.workspaceId)"
      >
        <span class="dot" :class="r.status" />
        <span class="names">
          <span class="ws">{{ r.workspace }}</span>
          <!-- The topic is what makes two rows named `api` tell each other
               apart, so it is beside the name rather than in a column. It is
               dropped when it would only repeat the name — a single-repo
               project is usually named after its repository, and "vitedemo
               vitedemo" says nothing twice. -->
          <span v-if="contextOf(r)" class="ctx">{{ contextOf(r) }}</span>
        </span>
        <span class="ports">
          <span v-for="p in r.ports" :key="p.name" class="port">{{ p.port }}</span>
          <span v-if="!r.ports.length" class="port none">{{ r.impl }}</span>
        </span>
        <span class="acts">
          <span
            v-if="r.url && r.status === 'up'"
            class="mini"
            title="Open this server"
            @click.stop="open(r.url, r.workspaceId)"
          ><ExternalLink /></span>
          <span
            class="mini"
            :title="r.status === 'up' || r.status === 'starting' ? 'Stop' : 'Start'"
            @click.stop="toggle(r.workspaceId)"
          >
            <component :is="r.status === 'up' || r.status === 'starting' ? CircleStop : CirclePlay" />
          </span>
        </span>
      </button>
    </div>

    <!-- ── the output ─────────────────────────────────────────────────── -->
    <div class="log">
      <div class="lhead">
        <span class="lname">{{ current?.workspace ?? 'output' }}</span>
        <span v-if="current" class="lstatus" :class="current.status">{{ current.status }}</span>
        <span class="spacer" />
        <span v-if="!follow" class="tailoff" @click="follow = true; onScroll()">jump to newest</span>
      </div>
      <div ref="body" class="lbody" @scroll="onScroll">
        <p v-if="!clean.length || (clean.length === 1 && !clean[0])" class="empty">
          Nothing written yet. Output appears here as the server writes it.
        </p>
        <pre v-else>{{ clean.join('\n') }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.servers {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* ── board ─────────────────────────────────────────────────────────── */
/* Sized by its rows, capped in a unit that resolves.
 *
 * This was `max-height: 42%` inside an auto-sized grid row, which is circular:
 * the percentage has no definite base to resolve against, so the board
 * collapsed to 38px over 88px of content and both rows were simply invisible.
 * A viewport-relative cap has a base regardless of what the parent is doing. */
.board {
  flex: 0 1 auto;
  border-bottom: 1px solid var(--line);
  overflow-y: auto;
  max-height: clamp(90px, 38vh, 340px);
}
.bhead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 12px;
  height: 28px;
  color: var(--text-dim);
  font-size: var(--fs-xs);
  position: sticky;
  top: 0;
  background: var(--panel);
  z-index: 1;
}
.bhead span { flex: 1; }

.row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: var(--row-h);
  padding: 0 8px 0 12px;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sm);
  text-align: left;
}
.row:hover { background: var(--hover); }
.row.on { background: var(--selected); }

/* Status is the first thing read, so it is the first thing drawn. */
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  background: var(--text-dim);
}
.dot.up { background: var(--ok); }
.dot.starting {
  background: var(--warn);
  animation: pulse 1.4s ease-in-out infinite;
}
.dot.unhealthy { background: var(--danger); }
@media (prefers-reduced-motion: reduce) { .dot.starting { animation: none; } }
@keyframes pulse { 50% { opacity: 0.35; } }

.names { display: flex; align-items: baseline; gap: 7px; min-width: 0; flex: 1; }
.ws { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx {
  color: var(--text-dim);
  font-size: var(--fs-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ports { display: flex; gap: 4px; flex: none; }
.port {
  font-family: var(--mono);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  background: var(--hover);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
}
.port.none { font-family: var(--font); }

.acts { display: flex; gap: 2px; flex: none; opacity: 0; }
.row:hover .acts, .row.on .acts { opacity: 1; }
.mini {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}
.mini:hover { background: var(--active); color: var(--text); }
.mini .lucide { width: 14px; height: 14px; }

/* ── log ───────────────────────────────────────────────────────────── */
.log { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.lhead {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px 0 12px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  border-bottom: 1px solid var(--line-soft);
}
.lname { color: var(--text-muted); }
.lstatus { text-transform: lowercase; }
.lstatus.up { color: var(--ok); }
.lstatus.starting { color: var(--warn); }
.lstatus.unhealthy, .lstatus.down { color: var(--danger); }
.spacer { flex: 1; }
.tailoff { color: var(--accent); cursor: pointer; }
.tailoff:hover { text-decoration: underline; }

.lbody { flex: 1; overflow: auto; padding: 8px 12px; min-height: 0; }
.lbody pre {
  margin: 0;
  font-family: var(--mono);
  font-size: var(--fs-xs);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-muted);
}
.empty { color: var(--text-dim); font-size: var(--fs-sm); padding: 10px 0; }
</style>
