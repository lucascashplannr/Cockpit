<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Copy, FolderOpen, GitBranch, Layers, SquareDot, Stamp, X } from '@lucide/vue'
import type { WorkspaceDetails } from '@cockpit/shared'
import { adoptTopic, client, guard, renameTopic, state, toast } from '../core/store.js'

/**
 * The details sheet of one row of the list: what it is, where it came from,
 * when, and the one setting a topic has of its own — its name.
 *
 * A project's equivalent is ProjectDialog, opened by right-clicking its tile.
 */

const target = computed(() => state.detailsFor)

const ws = computed(() =>
  target.value?.kind === 'workspace'
    ? (state.workspaces.find((w) => w.id === target.value!.id) ?? null)
    : null,
)
const topic = computed(() =>
  target.value?.kind === 'topic'
    ? (state.topics.find((f) => f.id === target.value!.id) ?? null)
    : null,
)

const project = computed(() => {
  const pid = ws.value?.projectId ?? topic.value?.projectId
  return state.projects.find((p) => p.id === pid) ?? null
})

/* ── Workspace ─────────────────────────────────────────────────────────── */

const details = ref<WorkspaceDetails | null>(null)
const loading = ref(false)
/** The core running is older than this window and has no `workspace.details`. */
const unavailable = ref(false)

watch(
  () => ws.value?.id,
  async (id) => {
    details.value = null
    unavailable.value = false
    if (!id) return
    loading.value = true
    try {
      details.value = await client.call('workspace.details', { workspaceId: id })
    } catch {
      // A core older than this window answers `unknown_method`: show what the
      // probe already knows rather than nothing.
      details.value = null
      unavailable.value = true
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

const RESTART = 'restart the service to see this'

const kindLabel = computed(() => {
  switch (ws.value?.kind) {
    case 'main': return 'Repository'
    case 'worktree': return 'Branch, in a folder of its own'
    case 'external': return 'Folder'
    case 'group': return 'Topic folder'
    default: return ''
  }
})

const wsTopic = computed(() =>
  ws.value?.topicId ? (state.topics.find((f) => f.id === ws.value!.topicId) ?? null) : null,
)

/** Where the code came from, in words rather than a URL when it is a known host. */
const remoteHref = computed(() => {
  const u = details.value?.remoteUrl
  if (!u) return null
  // git@github.com:org/repo.git → https://github.com/org/repo
  const ssh = /^git@([^:]+):(.+?)(\.git)?$/.exec(u)
  if (ssh) return 'https://' + ssh[1] + '/' + ssh[2]
  return /^https?:\/\//.test(u) ? u.replace(/\.git$/, '') : null
})

const ports = computed(() => ws.value?.runtime?.ports ?? [])

/* ── Topic ─────────────────────────────────────────────────────────────── */

const name = ref('')
const saving = ref(false)
watch(topic, (f) => { name.value = f?.name ?? '' }, { immediate: true })

const renamable = computed(() => !!topic.value && !topic.value.derived && topic.value.state !== 'closed')

/**
 * §4 — why half this sheet is missing, said once and in full.
 *
 * An inferred topic is the shape of the work without the record of it: the
 * window noticed several checkouts sharing a branch name and drew a bracket
 * around them. Every verb past "open a conversation" starts by reading a row
 * that was never written, so the menus drop them (§3.9 — absent, not
 * disabled), and a row that is simply missing explains nothing. This is where
 * it gets explained, next to the button that fixes it.
 */
const inferred = computed(() => !!topic.value?.derived)
const adopting = ref(false)

async function adopt() {
  const f = topic.value
  if (!f || adopting.value) return
  adopting.value = true
  try {
    // The id survives the promotion — same `stableId` on both sides — so the
    // sheet stays open on the same row and simply grows the rest of itself.
    await adoptTopic(f.id)
  } finally {
    adopting.value = false
  }
}
const nameChanged = computed(() => !!topic.value && !!name.value.trim() && name.value.trim() !== topic.value.name)

const topicRepos = computed(() =>
  topic.value
    ? state.workspaces.filter((w) => topic.value!.workspaceIds.includes(w.id) && w.kind !== 'group')
    : [],
)

const SETUP_TEXT: Record<string, string> = {
  none: 'No setup',
  branch: 'Branch only',
  isolated: 'Isolated — its own folder per repository',
  full: 'Full — folders, seeds and servers',
}

async function saveName() {
  const f = topic.value
  if (!f || !nameChanged.value || saving.value) return
  saving.value = true
  try {
    await renameTopic(f.id, name.value.trim())
  } finally {
    saving.value = false
  }
}

/* ── Shared ────────────────────────────────────────────────────────────── */

function close() {
  state.detailsFor = null
}

function when(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function bytes(n: number | null): string {
  if (n == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return (i ? v.toFixed(1) : v) + ' ' + u[i]
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast('info', 'copied', { icon: 'copy' })
  } catch {
    toast('error', 'could not copy')
  }
}

function reveal(workspaceId: string) {
  void guard(() => client.call('workspace.openIn', { workspaceId, target: 'finder' }))
}
</script>

<template>
  <div v-if="ws || topic" class="scrim" @mousedown.self="close">
    <div class="dlg" role="dialog" aria-modal="true">
      <header class="head">
        <component :is="topic ? Layers : ws?.kind === 'worktree' ? GitBranch : SquareDot" class="sm hic" />
        <h2>{{ topic?.name ?? ws?.name }}</h2>
        <span class="grow" />
        <button class="icon-btn" title="Close (esc)" @click="close"><X class="sm" /></button>
      </header>

      <!-- ── A repository, a branch, a folder ── -->
      <div v-if="ws" class="body">
        <dl class="facts">
          <dt>Kind</dt>
          <dd>{{ kindLabel }}</dd>

          <dt>Project</dt>
          <dd>{{ project?.name ?? '—' }}</dd>

          <template v-if="wsTopic">
            <dt>Topic</dt>
            <dd>
              <button class="linkish" @click="state.detailsFor = { kind: 'topic', id: wsTopic.id }">
                {{ wsTopic.name }}
              </button>
            </dd>
          </template>

          <dt>Location</dt>
          <dd class="with-acts">
            <code class="mono path">{{ ws.path }}</code>
            <button class="icon-btn small" title="Copy the path" @click="copy(ws.path)"><Copy class="sm" /></button>
            <button class="icon-btn small" title="Reveal in Finder" @click="reveal(ws.id)"><FolderOpen class="sm" /></button>
          </dd>

          <dt>{{ ws.kind === 'worktree' ? 'Folder created' : 'On this machine since' }}</dt>
          <dd :class="{ dim: unavailable }">{{ loading ? '…' : unavailable ? RESTART : when(details?.createdAt) }}</dd>
        </dl>

        <template v-if="ws.git">
          <span class="section-label sep">Git</span>
          <dl class="facts">
            <dt>Branch</dt>
            <dd><code class="mono">{{ ws.git.branch ?? '(detached)' }}</code></dd>

            <template v-if="ws.git.base && ws.git.base !== ws.git.branch">
              <dt>Forked from</dt>
              <dd><code class="mono">{{ ws.git.base }}</code></dd>
            </template>

            <dt>Tracks</dt>
            <dd><code class="mono">{{ ws.git.upstream ?? 'nothing yet — never pushed' }}</code></dd>

            <dt>Origin</dt>
            <dd class="with-acts">
              <template v-if="details?.remoteUrl">
                <a v-if="remoteHref" class="mono path" :href="remoteHref" target="_blank" rel="noreferrer noopener">
                  {{ details.remoteUrl }}
                </a>
                <code v-else class="mono path">{{ details.remoteUrl }}</code>
                <button class="icon-btn small" title="Copy the URL" @click="copy(details.remoteUrl)"><Copy class="sm" /></button>
              </template>
              <span v-else class="dim">{{ loading ? '…' : unavailable ? RESTART : 'no remote' }}</span>
            </dd>

            <template v-if="details?.head">
              <dt>Last commit</dt>
              <dd>
                <span class="subject">{{ details.head.subject }}</span>
                <span class="dim">
                  <code class="mono">{{ details.head.sha.slice(0, 8) }}</code>
                  · {{ details.head.author }} · {{ when(details.head.at) }}
                </span>
              </dd>
            </template>
          </dl>
        </template>

        <template v-if="ws.runtime">
          <span class="section-label sep">Servers</span>
          <dl class="facts">
            <dt>Status</dt>
            <dd><span class="dot" :class="ws.runtime.status" /> {{ ws.runtime.status }} · {{ ws.runtime.impl }}</dd>
            <template v-if="ports.length">
              <dt>Ports</dt>
              <dd>
                <span v-for="p in ports" :key="p.name" class="port">
                  {{ p.name }} <code class="mono">{{ p.port }}</code>
                </span>
              </dd>
            </template>
          </dl>
        </template>

        <span class="section-label sep">On disk</span>
        <dl class="facts">
          <dt>Size</dt>
          <dd>{{ bytes(ws.diskBytes) }}</dd>
          <template v-if="ws.capabilities.length">
            <dt>Detected</dt>
            <dd>{{ ws.capabilities.map((c) => c.id + ' (' + c.impl + ')').join(', ') }}</dd>
          </template>
          <dt>Last checked</dt>
          <dd>{{ when(ws.lastProbedAt) }}</dd>
        </dl>
      </div>

      <!-- ── A topic ── -->
      <div v-else-if="topic" class="body">
        <section v-if="inferred" class="inferred">
          <h3 class="ititle">Inferred — not a topic opened here</h3>
          <p class="iprose">
            {{ topicRepos.length }} checkout{{ topicRepos.length === 1 ? '' : 's' }} share the
            branch <code class="mono">{{ topic.slug }}</code>, so the window groups them. Nothing
            recorded that they are one piece of work, so there is no row to hold a name, a state or
            a memory — which is why <strong>Rename</strong>, <strong>Start the servers</strong>,
            <strong>Close</strong> and <strong>Delete</strong> are absent rather than greyed out.
          </p>
          <div class="irow">
            <button class="btn primary" :disabled="adopting" @click="adopt">
              <Stamp class="sm" />
              {{ adopting ? 'Taking over…' : 'Take over this topic' }}
            </button>
          </div>
        </section>

        <label v-if="renamable" class="field">
          <span class="lbl">Name</span>
          <div class="row">
            <input v-model="name" class="input" type="text" spellcheck="false" @keydown.enter="saveName" />
            <button class="btn primary" :disabled="!nameChanged || saving" @click="saveName">
              {{ saving ? 'Saving…' : 'Rename' }}
            </button>
          </div>
          <span class="help">
            The branch keeps its name — <code class="mono">{{ topic.slug }}</code> — in every repository.
          </span>
        </label>

        <dl class="facts">
          <dt>Project</dt>
          <dd>{{ project?.name ?? '—' }}</dd>

          <dt>Branch</dt>
          <dd><code class="mono">{{ topic.slug }}</code></dd>

          <dt>State</dt>
          <dd>{{ topic.state }}</dd>

          <dt>Opened</dt>
          <dd>
            <template v-if="topic.derived">
              Not opened in Cockpit — inferred from branches sharing this name
            </template>
            <template v-else>{{ when(topic.createdAt) }}</template>
          </dd>

          <template v-if="!topic.derived">
            <dt>Last changed</dt>
            <dd>{{ when(topic.updatedAt) }}</dd>

            <dt>Setup</dt>
            <dd>{{ SETUP_TEXT[topic.setup] ?? topic.setup }}</dd>
          </template>

          <template v-if="topic.rootPath">
            <dt>Folder</dt>
            <dd class="with-acts">
              <code class="mono path">{{ topic.rootPath }}</code>
              <button class="icon-btn small" title="Copy the path" @click="copy(topic.rootPath)"><Copy class="sm" /></button>
            </dd>
          </template>

          <template v-if="topic.ticket">
            <dt>Ticket</dt>
            <dd>
              <a :href="topic.ticket.url" target="_blank" rel="noreferrer noopener">
                {{ topic.ticket.key }} — {{ topic.ticket.title }}
              </a>
              <span class="dim"> · {{ topic.ticket.status }}</span>
            </dd>
          </template>

          <template v-if="topic.review">
            <dt>Review</dt>
            <dd>
              <a :href="topic.review.url" target="_blank" rel="noreferrer noopener">
                #{{ topic.review.number }} — {{ topic.review.title }}
              </a>
              <span class="dim"> · {{ topic.review.state }} · CI {{ topic.review.ci }}</span>
            </dd>
          </template>
        </dl>

        <template v-if="topicRepos.length">
          <span class="section-label sep">Repositories</span>
          <div class="repos">
            <button
              v-for="w in topicRepos"
              :key="w.id"
              class="repo"
              title="Details of this repository"
              @click="state.detailsFor = { kind: 'workspace', id: w.id }"
            >
              <GitBranch class="sm" />
              <span class="rname">{{ w.name }}</span>
              <code class="mono dim">{{ w.path }}</code>
            </button>
          </div>
        </template>
      </div>

      <footer class="foot">
        <span class="grow" />
        <button class="btn ghost" @click="close">Close</button>
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
  width: min(600px, 92vw);
  max-height: 84vh;
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
  gap: 10px;
  padding: 16px 14px 14px 20px;
  border-bottom: 1px solid var(--line);
}
.hic { color: var(--text-dim); flex: none; }
.head h2 {
  margin: 0;
  min-width: 0;
  font-size: var(--fs-lg);
  font-weight: 640;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.grow { flex: 1; }

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sep { display: block; margin-top: 6px; }

/* Label and value on one line each, labels in a column of their own. */
.facts {
  display: grid;
  grid-template-columns: 150px 1fr;
  column-gap: 14px;
  row-gap: 9px;
  margin: 0;
  font-size: var(--fs-sm);
}
.facts dt { color: var(--text-dim); }
.facts dd {
  margin: 0;
  min-width: 0;
  color: var(--text);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.facts dd.with-acts { flex-direction: row; align-items: center; gap: 4px; }
.facts a { color: var(--accent); text-decoration: none; }
.facts a:hover { text-decoration: underline; }
.path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
}
.with-acts .path { flex: 1; }
.subject { overflow-wrap: anywhere; }
.dim { color: var(--text-dim); font-size: var(--fs-xs); }
.port { margin-right: 12px; }
.facts .dot { margin-right: 4px; vertical-align: middle; }

.linkish {
  align-self: flex-start;
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* A panel rather than a `.note`: it is the answer to "why is this sheet
   half empty", which is a paragraph and a verb, not an aside. */
.inferred {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 15px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface-input);
}
.ititle {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 620;
  color: var(--text);
}
.iprose {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.7;
}
.iprose strong { color: var(--text); font-weight: 600; }
.iprose code { color: var(--text); }
.irow { display: flex; margin-top: 3px; }
.irow .btn { flex: none; }

.field { display: flex; flex-direction: column; gap: 7px; }
.lbl {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.help { font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.55; }
.row { display: flex; align-items: center; gap: 8px; }
.row .input { flex: 1; min-width: 0; }
.row .btn { flex: none; }

.repos { display: flex; flex-direction: column; gap: 2px; }
.repo {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-muted);
}
.repo:hover { background: var(--hover); color: var(--text); }
.repo .lucide { color: var(--text-dim); flex: none; }
.rname { flex: none; font-size: var(--fs-sm); }
.repo code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
</style>
