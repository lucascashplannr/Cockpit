<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Activity, CircleCheck, CircleX, FolderOpen, RefreshCw, TriangleAlert, X } from '@lucide/vue'
import {
  client, readLogs, refreshStatus, restartCore, revealLogs, serviceStale, state,
} from '../core/store.js'
import type { LogTail } from '../core/store.js'

/**
 * §13 — the service runs apart from the window, which is what lets agents and
 * servers survive it, and also what makes it invisible: which build it is,
 * what PATH it hands to `claude`, and what it printed on the way to failing
 * were all questions that needed a terminal. This sheet answers them from the
 * window, and puts the one fix most of them have — restart it — beside them.
 */

type Engine = { id: string; available: boolean; bin: string }

const engines = ref<Engine[] | null>(null)
const logs = ref<{ service: LogTail | null; app: LogTail | null }>({ service: null, app: null })
const which = ref<'service' | 'app'>('service')
const loading = ref(false)
const restarting = ref(false)
const pre = ref<HTMLElement | null>(null)

async function load() {
  loading.value = true
  const [, eng, l] = await Promise.all([
    refreshStatus(),
    client.call('agent.engines', undefined).catch(() => null),
    readLogs(),
  ])
  engines.value = eng
  logs.value = l
  loading.value = false
  // The end of a log is the part being looked for.
  await nextTick()
  if (pre.value) pre.value.scrollTop = pre.value.scrollHeight
}

watch(
  () => state.serviceOpen,
  (open) => {
    if (open) void load()
  },
  { immediate: true },
)

watch(which, async () => {
  await nextTick()
  if (pre.value) pre.value.scrollTop = pre.value.scrollHeight
})

const reachable = computed(() => state.connection === 'connected' || state.connection === 'outdated')
const s = computed(() => (reachable.value ? state.status : null))
const h = computed(() => state.hostInfo)

const current = computed(() => (which.value === 'service' ? logs.value.service : logs.value.app))

const pathEntries = computed(() => (s.value?.path ? s.value.path.split(/[:;]/).filter(Boolean) : []))

function since(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return sec + 's'
  const min = Math.round(sec / 60)
  if (min < 60) return min + ' min'
  const hr = Math.floor(min / 60)
  if (hr < 48) return hr + ' h ' + (min % 60) + ' min'
  return Math.floor(hr / 24) + ' days'
}

function size(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

async function restart() {
  if (restarting.value) return
  restarting.value = true
  await restartCore()
  restarting.value = false
  await load()
}

function close() {
  state.serviceOpen = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}
</script>

<template>
  <div v-if="state.serviceOpen" class="scrim" @mousedown.self="close" @keydown="onKey">
    <div class="dlg" role="dialog" aria-label="Service" tabindex="-1">
      <header class="head">
        <Activity class="sm gi" />
        <h2>Service</h2>
        <span class="pill" :class="reachable ? (serviceStale ? 'warn' : 'ok') : 'bad'">
          <i class="dot" />
          {{ reachable ? (serviceStale ? 'running an older version' : 'running') : 'unreachable' }}
        </span>
        <span class="grow" />
        <button class="icon-btn" title="Refresh" :disabled="loading" @click="load">
          <RefreshCw class="sm" :class="{ spin: loading }" />
        </button>
        <button class="icon-btn" title="Close (esc)" @click="close"><X class="sm" /></button>
      </header>

      <div class="body">
        <div v-if="serviceStale" class="note warn">
          <TriangleAlert class="sm" />
          <span>
            This window is Cockpit <b>{{ h?.version }}</b>, but the service was started by
            <b>{{ s?.version }}</b> and kept running across the update. Restart it to use this
            version's service.
          </span>
        </div>
        <div v-else-if="!reachable" class="note bad">
          <CircleX class="sm" />
          <span>
            Nothing answers on port {{ h?.port ?? '—' }}. The service log below says why it
            stopped, or why it did not start.
          </span>
        </div>

        <section class="grid">
          <div class="cell">
            <span class="lbl">This window</span>
            <span class="val">{{ h?.version ?? '—' }}</span>
            <span class="sub">{{ h ? (h.build === 'packaged' ? 'installed app' : 'from source') : 'no host' }}</span>
          </div>
          <div class="cell">
            <span class="lbl">The service</span>
            <span class="val" :class="{ warn: serviceStale }">{{ s?.version ?? '—' }}</span>
            <span class="sub">
              <template v-if="s">
                {{ s.build === 'packaged' ? 'installed app' : s.build === 'source' ? 'from source' : 'unknown build' }}
                · protocol {{ s.protocol.major }}.{{ s.protocol.minor }}
              </template>
              <template v-else>—</template>
            </span>
          </div>
          <div class="cell">
            <span class="lbl">Up for</span>
            <span class="val">{{ s ? since(s.startedAt) : '—' }}</span>
            <span class="sub">{{ s ? 'pid ' + s.pid + ' · port ' + (s.port ?? h?.port) : '—' }}</span>
          </div>
          <div class="cell">
            <span class="lbl">Running</span>
            <span class="val">{{ s ? s.activeProcesses : '—' }}</span>
            <span class="sub">{{ s ? s.activeLeases + ' agent leases · Node ' + (s.runtime ?? '?') : '—' }}</span>
          </div>
        </section>

        <section class="field">
          <span class="lbl">Data</span>
          <code class="mono path">{{ s?.home ?? h?.home ?? '—' }}</code>
          <span class="help">
            The database, attachments, checkpoints and logs.
            <template v-if="h?.build === 'source'">
              Development keeps its own, apart from the installed app's.
            </template>
          </span>
        </section>

        <section class="field">
          <span class="lbl">Agents</span>
          <div v-if="engines" class="engines">
            <div v-for="e in engines" :key="e.id" class="engine" :class="{ off: !e.available }">
              <CircleCheck v-if="e.available" class="sm ok" />
              <CircleX v-else class="sm bad" />
              <span class="name">{{ e.id }}</span>
              <code class="mono">{{ e.available ? e.bin : 'not found on the service\'s PATH' }}</code>
            </div>
          </div>
          <span v-else class="help">{{ reachable ? 'Asking the service…' : '—' }}</span>
          <details v-if="pathEntries.length" class="pathlist">
            <summary>PATH the service gives agents and servers · {{ pathEntries.length }} folders</summary>
            <code v-for="(p, i) in pathEntries" :key="i" class="mono">{{ p }}</code>
          </details>
        </section>

        <section class="field logs">
          <div class="logbar">
            <span class="lbl">Logs</span>
            <div class="seg">
              <button :class="{ on: which === 'service' }" @click="which = 'service'">Service</button>
              <button :class="{ on: which === 'app' }" @click="which = 'app'">App</button>
            </div>
            <span class="grow" />
            <span v-if="current && !current.missing" class="sub">{{ size(current.size) }}</span>
            <button class="btn ghost small" @click="revealLogs"><FolderOpen />Show in folder</button>
          </div>
          <pre ref="pre" class="mono log">{{
            current
              ? current.missing
                ? 'Nothing written yet — ' + current.path
                : current.text || '(empty)'
              : which === 'service' && !reachable
                ? 'The service is not answering, so it cannot send its log. It is in ' + (h?.coreLog ?? 'the logs folder') + '.'
                : 'No log available here.'
          }}</pre>
          <code v-if="current" class="mono sub">{{ current.path }}</code>
        </section>
      </div>

      <footer class="foot">
        <span class="rp">Restarting ends the conversations running now. Servers keep running.</span>
        <span class="grow" />
        <button class="btn ghost" @click="close">Close</button>
        <button class="btn" :class="serviceStale || !reachable ? 'primary' : ''" :disabled="restarting" @click="restart">
          <RefreshCw :class="{ spin: restarting }" />{{ restarting ? 'Restarting…' : 'Restart the service' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  backdrop-filter: blur(6px) saturate(1.1);
  animation: fade var(--dur-2) var(--ease-soft);
}
@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
.dlg {
  width: min(760px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--overlay);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg), var(--inset-top);
  overflow: hidden;
  animation: rise var(--dur-3) var(--ease);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to { opacity: 1; transform: none; }
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 16px 14px 14px 20px;
  border-bottom: 1px solid var(--line);
}
.head h2 { margin: 0; font-size: var(--fs-lg); font-weight: 640; letter-spacing: -0.01em; }
.gi { color: var(--text-dim); }
.grow { flex: 1; }

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 4px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--line);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.ok { color: var(--ok, var(--text-muted)); }
.pill.warn { color: var(--warn); }
.pill.bad { color: var(--danger); }

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 12px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
/* The body scrolls; its sections never shrink to make room instead. */
.body > * { flex: none; }

.note {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  padding: 10px 12px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  font-size: var(--fs-sm, 13px);
  line-height: 1.55;
  color: var(--text-muted);
}
.note .lucide { flex: none; margin-top: 2px; }
.note.warn .lucide { color: var(--warn); }
.note.bad .lucide { color: var(--danger); }
.note b { color: var(--text); font-weight: 600; }

.grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md, 8px);
  background: var(--line);
  overflow: hidden;
}
@media (max-width: 720px) {
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  background: var(--overlay);
  min-width: 0;
}
.val { font-size: var(--fs-lg); font-weight: 600; font-variant-numeric: tabular-nums; }
.val.warn { color: var(--warn); }
.sub { font-size: var(--fs-xs); color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.field { display: flex; flex-direction: column; gap: 7px; }
.lbl {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.help { font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.6; }
.path { font-size: var(--fs-xs); color: var(--text-muted); word-break: break-all; }

.engines { display: flex; flex-direction: column; gap: 4px; }
.engine {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm, 13px);
}
.engine .name { width: 56px; flex: none; font-weight: 550; }
.engine code { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.engine.off code { color: var(--danger); }
.lucide.ok { color: var(--ok, var(--accent)); }
.lucide.bad { color: var(--danger); }

.pathlist { font-size: var(--fs-xs); color: var(--text-dim); }
.pathlist summary { cursor: default; user-select: none; }
.pathlist code { display: block; padding: 1px 0 1px 14px; color: var(--text-muted); word-break: break-all; }

.logbar { display: flex; align-items: center; gap: 10px; }
.seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 7px;
  background: var(--bg-sunken);
  border: 1px solid var(--line);
}
.seg button {
  height: 22px;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--fs-xs);
}
.seg button.on { background: var(--overlay); color: var(--text); box-shadow: var(--shadow-sm, none); }
.btn.small { height: 24px; padding: 0 10px; font-size: var(--fs-xs); }
.btn.small .lucide { width: 12px; height: 12px; }

.log {
  margin: 0;
  height: 260px;
  overflow: auto;
  padding: 10px 12px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
.rp { font-size: var(--fs-xs); color: var(--text-dim); }
</style>
