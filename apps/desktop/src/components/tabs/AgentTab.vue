<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Workspace } from '@cockpit/shared'
import { client, guard, state, toast } from '../../core/store.js'

/**
 * §7 — a session is a set of paths + an engine + a lease. The scope selector
 * below is literally that: which subtrees this run may touch.
 * §16 — scope confined, never a push, never the main branch, cost displayed.
 */

const props = defineProps<{ workspace: Workspace }>()

const engines = ref<{ id: string; available: boolean; bin: string }[]>([])
const engine = ref('claude')
const prompt = ref('')
const scope = ref<string[]>([])
const starting = ref(false)

const sessions = computed(() =>
  state.agents.filter((s) => s.workspaceIds.includes(props.workspace.id) || s.status !== 'ended'),
)

const live = computed(() => sessions.value.filter((s) => s.status !== 'ended' && s.status !== 'failed'))

/** The output stream, rebuilt from the journal — the UI holds no separate
 *  transcript of its own (§3.3). */
const transcript = computed(() =>
  state.events
    .filter((e) => e.actor.kind === 'agent' && (e.type === 'agent.output' || e.type === 'agent.tool_use'))
    .slice(-200),
)

const totalCost = computed(() => sessions.value.reduce((n, s) => n + s.costUsd, 0))

const siblings = computed(() =>
  state.workspaces.filter((w) => w.projectId === props.workspace.projectId && w.kind !== 'group'),
)

onMounted(async () => {
  const r = await guard(() => client.call('agent.engines', undefined))
  engines.value = r ?? []
  const firstAvailable = engines.value.find((e) => e.available)
  if (firstAvailable) engine.value = firstAvailable.id
  scope.value = [props.workspace.id]
})

async function start() {
  if (!prompt.value.trim()) return
  starting.value = true
  const ids = scope.value.length ? scope.value : [props.workspace.id]
  const res = await guard(() =>
    client.call('agent.start', { engine: engine.value, workspaceIds: ids, prompt: prompt.value }),
  )
  starting.value = false
  if (!res) return
  if ('denied' in res) {
    // §7 — a refusal explains itself; a silent no is worse than a blocked run.
    toast('error', res.reason)
    return
  }
  prompt.value = ''
  toast('ok', 'session started')
}

async function stop(id: string) {
  await guard(() => client.call('agent.stop', { sessionId: id }), 'session stopped')
}

function payloadText(p: unknown): string {
  const o = p as { text?: string; tool?: string; paths?: string[] }
  if (o?.text) return o.text
  if (o?.tool) return o.tool + (o.paths?.length ? ' → ' + o.paths.join(', ') : '')
  return JSON.stringify(p).slice(0, 200)
}
</script>

<template>
  <div class="agent">
    <div class="stream">
      <div v-if="!transcript.length" class="empty">
        <strong>No agent output yet</strong>
        <span>
          A session is a set of paths, not a feature — it works the same on a worktree and on the
          main checkout.
        </span>
      </div>
      <div v-else class="lines">
        <div v-for="e in transcript" :key="e.id" class="ln" :class="e.type">
          <span class="badge" :class="e.type === 'agent.tool_use' ? 'tool' : 'text'">
            {{ e.type === 'agent.tool_use' ? '⚙' : '◆' }}
          </span>
          <span class="txt selectable">{{ payloadText(e.payload) }}</span>
        </div>
      </div>
    </div>

    <aside class="side">
      <div class="block">
        <span class="section-label">new session</span>

        <div class="field">
          <label>engine</label>
          <div class="engines">
            <button
              v-for="e in engines"
              :key="e.id"
              class="eng"
              :class="{ on: engine === e.id, off: !e.available }"
              :disabled="!e.available"
              :title="e.available ? e.bin : e.id + ' is not on PATH'"
              @click="engine = e.id"
            >
              {{ e.id }}
            </button>
          </div>
        </div>

        <!-- §7 — the lease is taken on these paths; overlapping runs are refused. -->
        <div class="field">
          <label>scope <span class="sub">paths this run may touch</span></label>
          <label v-for="s in siblings" :key="s.id" class="check">
            <input type="checkbox" :value="s.id" v-model="scope" />
            <span>{{ s.name }}</span>
            <span v-if="s.lease" class="chip warn">leased</span>
          </label>
        </div>

        <textarea
          v-model="prompt"
          class="prompt selectable"
          rows="5"
          placeholder="What should it do here?"
          @keydown.meta.enter="start"
        />
        <button class="btn primary full" :disabled="starting || !prompt.trim()" @click="start">
          Start <span class="kbd">⌘⏎</span>
        </button>

        <p class="guard">
          Never pushes · never the main branch · diff reviewed before any commit
        </p>
      </div>

      <div class="block">
        <span class="section-label">sessions</span>
        <div v-for="s in sessions.slice(0, 12)" :key="s.id" class="srow">
          <span class="dot" :class="s.status === 'ended' ? 'down' : s.status === 'failed' ? 'unhealthy' : 'up'" />
          <span class="sname">{{ s.engine }}</span>
          <span class="sst">{{ s.status }}</span>
          <span class="scost num">${{ s.costUsd.toFixed(2) }}</span>
          <button v-if="s.status !== 'ended' && s.status !== 'failed'" class="btn ghost x" @click="stop(s.id)">
            ✕
          </button>
        </div>
        <p v-if="!sessions.length" class="none">No session recorded.</p>
        <div v-if="live.length || totalCost" class="totals">
          <span>{{ live.length }} live</span>
          <span class="num">${{ totalCost.toFixed(2) }} total</span>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.agent { display: grid; grid-template-columns: minmax(0, 1fr) 300px; height: 100%; }

.stream { min-width: 0; min-height: 0; overflow-y: auto; padding: 14px 18px 30px; }
.lines { display: flex; flex-direction: column; gap: 8px; }
.ln { display: flex; gap: 9px; font-size: var(--fs-sm); line-height: 1.55; }
.badge {
  flex: none;
  width: 16px;
  text-align: center;
  font-size: 10px;
  color: var(--agent);
  padding-top: 2px;
}
.badge.tool { color: var(--text-dim); }
.txt { color: var(--text-muted); white-space: pre-wrap; word-break: break-word; }
.ln.agent\.tool_use .txt { color: var(--text-dim); font-family: var(--mono); font-size: var(--fs-xs); }

.side {
  border-left: 1px solid var(--line);
  background: var(--panel);
  overflow-y: auto;
  padding: 14px 14px 24px;
}
.block + .block { margin-top: 22px; }
.block .section-label { display: block; margin-bottom: 8px; }

.field { margin-bottom: 12px; }
.field > label {
  display: block;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-bottom: 5px;
}
.field .sub { color: var(--text-dim); }

.engines { display: flex; gap: 4px; }
.eng {
  height: 24px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  font-size: var(--fs-xs);
  color: var(--text-muted);
  background: var(--bg-sunken);
}
.eng.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.eng.off { opacity: 0.35; }

.check {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 22px;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}
.check input { accent-color: var(--accent); }

.prompt {
  width: 100%;
  padding: 8px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sm);
  line-height: 1.5;
  resize: vertical;
  margin-bottom: 7px;
}
.prompt:focus { border-color: var(--focus-ring); }
.btn.full { width: 100%; }

.guard {
  margin: 9px 0 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-dim);
}

.srow {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 24px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.sname { font-weight: 550; color: var(--text); }
.sst { flex: 1; color: var(--text-dim); }
.scost { color: var(--text-muted); }
.btn.x { height: 18px; width: 18px; padding: 0; font-size: 10px; }
.none { margin: 0; color: var(--text-dim); font-size: var(--fs-xs); }
.totals {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
</style>
