<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CommitPreview, DiffFile, FileDiff, Workspace } from '@cockpit/shared'
import type { Component } from 'vue'
import {
  Bot, CircleDashed, FileCode, GitCommitHorizontal, Sparkles, SquareArrowOutUpRight, TriangleAlert,
  User, UsersRound,
} from '@lucide/vue'
import {
  commit, commitPreview, guard, client, state,
} from '../../core/store.js'

/**
 * §12 — the review surface. "La distinction humain / agent est le garde-fou
 * principal : elle rend visible, donc contrôlable, la part de code jamais
 * relue." The author filter is therefore a first-class control, not a detail.
 */

const props = defineProps<{ workspace: Workspace }>()

const files = ref<DiffFile[]>([])
const current = ref<FileDiff | null>(null)
const selected = ref<string | null>(null)
const loading = ref(false)
const filter = ref<'all' | 'human' | 'agent' | 'unreviewed'>('all')

const counts = computed(() => {
  const c = { human: 0, agent: 0, mixed: 0, unknown: 0 }
  for (const f of files.value) c[f.attribution]++
  return c
})

const visible = computed(() => {
  if (filter.value === 'all') return files.value
  if (filter.value === 'unreviewed') {
    // Anything an agent wrote and a human has not since touched.
    return files.value.filter((f) => f.attribution === 'agent')
  }
  return files.value.filter((f) => f.attribution === filter.value || f.attribution === 'mixed')
})

const totals = computed(() => ({
  add: files.value.reduce((n, f) => n + f.additions, 0),
  del: files.value.reduce((n, f) => n + f.deletions, 0),
}))

async function load() {
  loading.value = true
  const r = await guard(() => client.call('diff.files', { workspaceId: props.workspace.id }))
  files.value = r ?? []
  loading.value = false
  if (files.value.length && !files.value.some((f) => f.path === selected.value)) {
    void select(files.value[0]!.path)
  } else if (!files.value.length) {
    selected.value = null
    current.value = null
  }
}

async function select(path: string) {
  selected.value = path
  current.value = null
  const r = await guard(() => client.call('diff.file', { workspaceId: props.workspace.id, path }))
  current.value = r
}

/* ── §16 — "revue humaine du diff avant tout commit" ──────────────────────
 *
 * The review was here and the commit was not, so the only way out of a dirty
 * worktree was a terminal — and `topic.close` refuses over uncommitted
 * changes, which meant Cockpit blocked you on a state it could not clear.
 * It belongs next to the diff it is a review of, not in a menu.
 */

const message = ref('')
const stageAll = ref(true)
const committing = ref(false)
const rows = ref<CommitPreview[]>([])

/** A topic commits across every repository it spans; a lone branch does not. */
const topicId = computed(() => props.workspace.topicId)

async function refreshCommit() {
  rows.value = await commitPreview(topicId.value, props.workspace.id, stageAll.value)
}

const willCommit = computed(() => rows.value.filter((r) => r.willCommit))
const fileCount = computed(() =>
  willCommit.value.reduce((n, r) => n + (stageAll.value ? r.staged + r.unstaged : r.staged), 0),
)
const blocked = computed(() => rows.value.filter((r) => r.conflicted > 0))
const canCommit = computed(
  () => !!message.value.trim() && fileCount.value > 0 && !blocked.value.length && !committing.value,
)

async function doCommit() {
  if (!canCommit.value) return
  committing.value = true
  const ok = await commit(topicId.value, props.workspace.id, message.value.trim(), stageAll.value)
  committing.value = false
  // The plan dialog takes it from here; clearing on success keeps the field
  // from re-offering a message that has already been used.
  if (ok) message.value = ''
}

watch([() => props.workspace.id, stageAll], () => void refreshCommit(), { immediate: true })
// The counts come from the core's own probe, so they follow every push.
watch(() => props.workspace.git, () => void refreshCommit())

async function openInIde() {
  if (!selected.value) return
  await guard(() =>
    client.call('workspace.openIn', {
      workspaceId: props.workspace.id,
      target: 'ide',
      path: selected.value!,
    }),
  )
}

watch(() => props.workspace.id, load, { immediate: true })
// The core re-pushes workspaces whenever the watcher fires; refresh with it.
watch(
  () => props.workspace.git && props.workspace.git.staged + props.workspace.git.unstaged + props.workspace.git.untracked,
  () => void load(),
)

/** One icon per author, and the icon is the same everywhere it appears —
 *  the filter rows below reuse it, so the legend needs no explaining. */
const mark: Record<string, Component> = {
  human: User,
  agent: Sparkles,
  mixed: UsersRound,
  unknown: CircleDashed,
}
</script>

<template>
  <div class="diff">
    <aside class="files">
      <div class="ftop">
        <span class="section-label">files ({{ files.length }})</span>
        <span class="tot num">
          <span class="add">+{{ totals.add }}</span>
          <span class="del">−{{ totals.del }}</span>
        </span>
      </div>

      <div class="scroll">
        <button
          v-for="f in visible"
          :key="f.path"
          class="frow"
          :class="{ on: f.path === selected }"
          @click="select(f.path)"
        >
          <span class="attr" :class="f.attribution" :title="'written by: ' + f.attribution">
            <component :is="mark[f.attribution]" class="sm" />
          </span>
          <span class="st" :class="f.status">{{ f.status }}</span>
          <span class="fp">{{ f.path }}</span>
          <span class="counts num">
            <span v-if="f.additions" class="add">+{{ f.additions }}</span>
            <span v-if="f.deletions" class="del">−{{ f.deletions }}</span>
          </span>
        </button>

        <div v-if="!files.length && !loading" class="empty">
          <FileCode />
          <strong>Clean</strong>
          <span>Nothing uncommitted here.</span>
        </div>
      </div>

      <!-- §12 — "par auteur". The number that matters is the agent one. -->
      <div class="by-author">
        <span class="section-label">by author</span>
        <button class="arow" :class="{ on: filter === 'all' }" @click="filter = 'all'">
          <span class="attr"><CircleDashed class="sm" /></span> all
          <span class="num">{{ files.length }}</span>
        </button>
        <button class="arow" :class="{ on: filter === 'human' }" @click="filter = 'human'">
          <span class="attr human"><User class="sm" /></span> human
          <span class="num">{{ counts.human }}</span>
        </button>
        <button class="arow" :class="{ on: filter === 'agent' }" @click="filter = 'agent'">
          <span class="attr agent"><Sparkles class="sm" /></span> agent
          <span class="num">{{ counts.agent }}</span>
        </button>
        <button
          v-if="counts.unknown"
          class="arow"
          :class="{ on: filter === 'unreviewed' }"
          @click="filter = 'unreviewed'"
          title="Changes the journal cannot attribute — edited outside the cockpit"
        >
          <span class="attr unknown"><Bot class="sm" /></span> untracked origin
          <span class="num">{{ counts.unknown }}</span>
        </button>
      </div>

      <!-- §16 — the commit lives against the review, and commits every
           repository of the topic at once because that is the unit the work
           was done in. -->
      <div class="commitbar">
        <div v-if="blocked.length" class="cblock">
          <TriangleAlert class="sm" />
          <span>{{ blocked.map((r) => r.repo).join(', ') }}: resolve the conflict first.</span>
        </div>
        <template v-else>
          <input
            v-model="message"
            class="input cmsg"
            placeholder="Commit message"
            :disabled="!fileCount"
            @keydown.meta.enter="doCommit"
          />
          <label class="call">
            <input v-model="stageAll" type="checkbox" />
            <span>stage everything</span>
          </label>
          <button class="btn primary full" :disabled="!canCommit" @click="doCommit">
            <GitCommitHorizontal />
            {{ committing ? 'Planning…' : 'Commit ' + fileCount + ' file' + (fileCount === 1 ? '' : 's') }}
          </button>
          <p v-if="willCommit.length > 1" class="cnote">
            {{ willCommit.map((r) => r.repo).join(' · ') }} — one message, one commit each.
          </p>
          <p v-else-if="!fileCount" class="cnote dim">Nothing to commit.</p>
        </template>
      </div>
    </aside>

    <div class="view">
      <div v-if="selected" class="vhead">
        <span class="mono vpath">{{ selected }}</span>
        <span class="grow" />
        <button class="btn ghost" @click="openInIde">
          <SquareArrowOutUpRight />Open in IDE
        </button>
      </div>

      <div class="hunks mono" v-if="current && current.lines.length">
        <div v-for="(l, i) in current.lines" :key="i" class="line" :class="l.kind">
          <span class="gutter num">{{ l.oldLine ?? '' }}</span>
          <span class="gutter num">{{ l.newLine ?? '' }}</span>
          <span class="sign">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ' }}</span>
          <span class="txt">{{ l.text }}</span>
        </div>
      </div>

      <div v-else-if="current && current.binary" class="empty"><strong>Binary file</strong></div>
      <div v-else-if="selected" class="empty"><span>No textual change to show.</span></div>
      <div v-else class="empty"><span>Select a file.</span></div>
    </div>
  </div>
</template>

<style scoped>
/* §16 — the commit bar. Pinned to the foot of the file list: it acts on what
   is listed above it, and a commit button that scrolls away is one nobody
   trusts they have seen the whole of. */
.commitbar {
  flex: none;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
.cmsg { width: 100%; height: 30px; }
.call {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 7px 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.call input { accent-color: var(--accent); }
.commitbar .btn.full { width: 100%; }
.cnote {
  margin: 7px 0 0;
  font-size: 10px;
  color: var(--text-dim);
  line-height: 1.45;
}
.cnote.dim { color: var(--text-dim); }
.cblock {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--fs-xs);
  color: var(--danger);
  line-height: 1.5;
}
.cblock .lucide { margin-top: 1px; flex: none; }

.diff { display: grid; grid-template-columns: 320px minmax(0, 1fr); height: 100%; }

.files {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
  min-height: 0;
  background: var(--panel);
}
.ftop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
}
.tot { display: flex; gap: 8px; font-size: var(--fs-xs); font-weight: 550; }
.add { color: var(--ok); }
.del { color: var(--danger); }

.scroll { flex: 1; overflow-y: auto; padding: 0 6px 6px; }

.frow {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 30px;
  padding: 0 9px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--text-muted);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.frow:hover { background: var(--hover); }
.frow.on { background: var(--selected); color: var(--text); }

.attr { flex: none; display: flex; align-items: center; color: var(--text-dim); }
.attr .lucide { width: 13px; height: 13px; }
.attr.human { color: var(--human); }
.attr.agent { color: var(--agent); }
.attr.mixed { color: var(--warn); }
.attr.unknown { color: var(--text-dim); }
.attr.mixed { color: var(--warn); }

.st {
  flex: none;
  width: 12px;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-dim);
}
.st.A { color: var(--ok); }
.st.D { color: var(--danger); }
.st.M { color: var(--warn); }
.st.U { color: var(--danger); }

.fp {
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
  font-family: var(--mono);
  font-size: var(--fs-xs);
}
.counts { display: flex; gap: 5px; font-size: 10px; flex: none; }

.by-author {
  flex: none;
  border-top: 1px solid var(--line);
  padding: 10px 8px;
  background: var(--panel);
}
.by-author .section-label { display: block; padding: 0 9px 6px; }
.arow {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 28px;
  padding: 0 9px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  color: var(--text-muted);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.arow:hover { background: var(--hover); }
.arow.on { background: var(--selected); color: var(--text); }
.arow .num { margin-left: auto; color: var(--text-dim); font-size: var(--fs-xs); }

.view { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.vhead {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
}
.vpath {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grow { flex: 1; }
.vhead .btn { height: 26px; padding: 0 9px; font-size: var(--fs-xs); }

.hunks {
  flex: 1;
  overflow: auto;
  padding: 6px 0 24px;
  font-size: var(--fs-sm);
  line-height: 1.5;
}
.line { display: flex; white-space: pre; }
.line.add { background: var(--diff-add-bg); }
.line.del { background: var(--diff-del-bg); }
.line.meta {
  color: var(--text-dim);
  background: var(--bg-sunken);
  font-size: var(--fs-xs);
  padding: 3px 0;
  margin: 6px 0 2px;
}

.gutter {
  flex: none;
  width: 44px;
  padding-right: 10px;
  text-align: right;
  color: var(--text-dim);
  opacity: 0.6;
  user-select: none;
}
.sign { flex: none; width: 14px; text-align: center; user-select: none; }
.line.add .sign, .line.add .txt { color: var(--diff-add-text); }
.line.del .sign, .line.del .txt { color: var(--diff-del-text); }
.txt { flex: 1; padding-right: 16px; }
</style>
