<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Workspace } from '@cockpit/shared'
import { CircleStop, RotateCcw, Sparkles, Wrench } from '@lucide/vue'
import { client, guard, resumeSession, state, toast } from '../../core/store.js'

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

/** The session being picked back up, and what to say to it. */
const resuming = ref<string | null>(null)
const followUp = ref('')

/**
 * §6 — clearing a session is free because the memory is elsewhere. Resuming is
 * the same idea from the other side: the conversation is still with the engine,
 * and the memory is re-read on the way in, so it starts from what is true now.
 */
function beginResume(id: string) {
  resuming.value = resuming.value === id ? null : id
  followUp.value = ''
}

async function confirmResume(id: string) {
  if (!followUp.value.trim()) return
  const ok = await resumeSession(id, followUp.value.trim())
  if (ok) {
    resuming.value = null
    followUp.value = ''
  }
}

/**
 * §7 — the scope is the set of paths, so the picker has to make each one
 * identifiable. It listed every workspace in the project by bare name, which
 * for a feature meant four checkboxes reading `Init`, `Init-Backend`, `Init`,
 * `Init-Backend`: a main checkout and its worktree share a name, and nothing
 * said which was which. Picking a main one then failed on the protected-branch
 * refusal *after* the prompt had been typed.
 *
 * Split in two, feature first, each row carrying its branch — and the ones an
 * agent may not run in are shown as refusable rather than silently offered.
 */
interface ScopeRow {
  id: string
  name: string
  kind: string
  branch: string
  leased: boolean
  /** §7 — on its repository's protected branch, so a session here is refused. */
  blocked: boolean
}

function toRow(w: Workspace): ScopeRow {
  const branch = w.git?.branch ?? '—'
  return {
    id: w.id,
    name: w.name,
    kind: w.kind === 'worktree' ? 'worktree' : w.kind === 'main' ? 'checkout' : w.kind,
    branch,
    leased: !!w.lease,
    // The core knows the real default branch; the window only has what it was
    // pushed, so this is the honest approximation and the core still decides.
    blocked: w.kind === 'main' && ['main', 'master', 'develop'].includes(branch),
  }
}

const inFeature = computed<ScopeRow[]>(() => {
  const fid = props.workspace.featureId
  if (!fid) return []
  return state.workspaces.filter((w) => w.featureId === fid && w.kind !== 'group').map(toRow)
})

const elsewhere = computed<ScopeRow[]>(() => {
  const fid = props.workspace.featureId
  return state.workspaces
    .filter((w) => w.projectId === props.workspace.projectId && w.kind !== 'group')
    .filter((w) => !fid || w.featureId !== fid)
    .map(toRow)
})

const blockedPicked = computed(() =>
  [...inFeature.value, ...elsewhere.value].filter((r) => r.blocked && scope.value.includes(r.id)),
)

onMounted(async () => {
  const r = await guard(() => client.call('agent.engines', undefined))
  engines.value = r ?? []
  const firstAvailable = engines.value.find((e) => e.available)
  if (firstAvailable) engine.value = firstAvailable.id
  // A session opened from inside a feature means the feature, not one repo of
  // it: that is the whole reason the worktrees were created together.
  scope.value = inFeature.value.length
    ? inFeature.value.filter((r) => !r.blocked).map((r) => r.id)
    : [props.workspace.id]
})

async function start() {
  if (!prompt.value.trim()) return
  starting.value = true
  const ids = scope.value.length ? scope.value : [props.workspace.id]
  const res = await guard(() =>
    client.call('agent.start', {
      engine: engine.value,
      workspaceIds: ids,
      prompt: prompt.value,
      // The core falls back to the workspace's own feature; passing it makes
      // the memory that will be prepended explicit at the call site.
      ...(props.workspace.featureId ? { featureId: props.workspace.featureId } : {}),
    }),
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
        <Sparkles />
        <strong>No agent output yet</strong>
        <span>
          A session is a set of paths, not a feature — it works the same on a worktree and on the
          main checkout.
        </span>
      </div>
      <div v-else class="lines">
        <div v-for="e in transcript" :key="e.id" class="ln" :class="e.type">
          <span class="badge" :class="e.type === 'agent.tool_use' ? 'tool' : 'text'">
            <component :is="e.type === 'agent.tool_use' ? Wrench : Sparkles" class="sm" />
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

        <!-- §7 — the lease is taken on these paths; overlapping runs are refused.
             Each row says which checkout it is and what branch it is on: a
             worktree and its main share a name, and picking the wrong one used
             to fail only after the prompt was written. -->
        <div class="field">
          <label>scope <span class="sub">paths this run may touch</span></label>

          <template v-if="inFeature.length">
            <span class="scopehead">this feature</span>
            <label v-for="r in inFeature" :key="r.id" class="check srow2" :class="{ blocked: r.blocked }">
              <input type="checkbox" :value="r.id" v-model="scope" />
              <span class="wname">{{ r.name }}</span>
              <span class="wkind">{{ r.kind }}</span>
              <span class="wbranch mono">{{ r.branch }}</span>
              <span v-if="r.leased" class="chip warn">leased</span>
            </label>
          </template>

          <template v-if="elsewhere.length">
            <span class="scopehead">{{ inFeature.length ? 'elsewhere in the project' : 'workspaces' }}</span>
            <label v-for="r in elsewhere" :key="r.id" class="check srow2" :class="{ blocked: r.blocked }">
              <input type="checkbox" :value="r.id" v-model="scope" />
              <span class="wname">{{ r.name }}</span>
              <span class="wkind">{{ r.kind }}</span>
              <span class="wbranch mono">{{ r.branch }}</span>
              <span v-if="r.leased" class="chip warn">leased</span>
            </label>
          </template>

          <!-- §7 — say it now, not after the prompt is written and refused. -->
          <p v-if="blockedPicked.length" class="scopewarn">
            {{ blockedPicked.map((r) => r.name).join(', ') }}
            {{ blockedPicked.length > 1 ? 'are' : 'is' }} on a protected branch — an agent never
            runs there. Open a feature, or pick its worktree instead.
          </p>
        </div>

        <textarea
          v-model="prompt"
          class="input prompt selectable"
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
        <template v-for="s in sessions.slice(0, 12)" :key="s.id">
          <div class="srow">
            <span class="dot" :class="s.status === 'ended' ? 'down' : s.status === 'failed' ? 'unhealthy' : 'up'" />
            <span class="sname">{{ s.engine }}</span>
            <span class="sst">{{ s.status }}</span>
            <span class="scost num">${{ s.costUsd.toFixed(2) }}</span>
            <!-- §3.9 — no resume handle, no button; never a disabled one. -->
            <button
              v-if="s.resumable"
              class="icon-btn x"
              :class="{ on: resuming === s.id }"
              title="Resume this conversation — the memory is re-read first"
              @click="beginResume(s.id)"
            >
              <RotateCcw class="sm" />
            </button>
            <button
              v-if="s.status !== 'ended' && s.status !== 'failed'"
              class="icon-btn x"
              title="Stop this session"
              @click="stop(s.id)"
            >
              <CircleStop class="sm" />
            </button>
          </div>
          <div v-if="resuming === s.id" class="resume">
            <p class="was">{{ s.prompt || 'no prompt recorded' }}</p>
            <textarea
              v-model="followUp"
              class="input selectable"
              rows="3"
              placeholder="What next?"
              @keydown.meta.enter="confirmResume(s.id)"
            />
            <button class="btn primary full" :disabled="!followUp.trim()" @click="confirmResume(s.id)">
              Resume <span class="kbd">⌘⏎</span>
            </button>
          </div>
        </template>
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
/* §7 — the scope rows. A worktree and its main checkout share a name, so the
   kind and the branch are what tell them apart; both are part of the label,
   not a tooltip. */
.scopehead {
  display: block;
  margin: 8px 0 2px;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.srow2 { gap: 7px; }
.srow2 .wname { flex: none; color: var(--text); }
.srow2 .wkind {
  flex: none;
  font-size: 10px;
  color: var(--text-dim);
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.srow2 .wbranch {
  flex: 1;
  min-width: 0;
  font-size: 10px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.srow2.blocked .wname,
.srow2.blocked .wbranch { color: var(--text-dim); }
.srow2.blocked .wkind { border-color: var(--warn); color: var(--warn); }

.scopewarn {
  margin: 6px 0 0;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 10px;
  line-height: 1.5;
}

.agent { display: grid; grid-template-columns: minmax(0, 1fr) 320px; height: 100%; }

.stream { min-width: 0; min-height: 0; overflow-y: auto; padding: 18px 22px 34px; }
.lines { display: flex; flex-direction: column; gap: 11px; }
.ln { display: flex; gap: 11px; font-size: var(--fs-sm); line-height: 1.6; }
.badge {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--agent-soft);
  color: var(--agent);
}
.badge .lucide { width: 12px; height: 12px; }
.badge.tool { background: var(--hover); color: var(--text-dim); }
.txt { color: var(--text-muted); white-space: pre-wrap; word-break: break-word; }
.ln.agent\.tool_use .txt { color: var(--text-dim); font-family: var(--mono); font-size: var(--fs-xs); }

.side {
  border-left: 1px solid var(--line);
  background: var(--panel);
  overflow-y: auto;
  padding: 18px 16px 26px;
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
  height: 28px;
  padding: 0 12px;
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
  gap: 8px;
  height: 26px;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}
.check input { accent-color: var(--accent); }

.prompt {
  resize: vertical;
  margin-bottom: 9px;
}
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
  gap: 8px;
  height: 28px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.sname { font-weight: 550; color: var(--text); }
.sst { flex: 1; color: var(--text-dim); }
.scost { color: var(--text-muted); }
.icon-btn.x { width: 22px; height: 22px; }
.icon-btn.x:hover { color: var(--danger); }
.icon-btn.x.on { color: var(--accent); }

.resume {
  margin: 2px 0 10px;
  padding: 9px 10px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
}
.resume .was {
  margin: 0 0 7px;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-dim);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.resume textarea { resize: vertical; margin-bottom: 7px; }
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
