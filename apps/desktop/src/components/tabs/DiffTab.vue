<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DiffFile, FileDiff, Workspace } from '@cockpit/shared'
import { client, guard, state } from '../../core/store.js'

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

const mark: Record<string, string> = { human: '●', agent: '◆', mixed: '◑', unknown: '·' }
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
            {{ mark[f.attribution] }}
          </span>
          <span class="st" :class="f.status">{{ f.status }}</span>
          <span class="fp">{{ f.path }}</span>
          <span class="counts num">
            <span v-if="f.additions" class="add">+{{ f.additions }}</span>
            <span v-if="f.deletions" class="del">−{{ f.deletions }}</span>
          </span>
        </button>

        <div v-if="!files.length && !loading" class="empty">
          <strong>Clean</strong>
          <span>No uncommitted change in this workspace.</span>
        </div>
      </div>

      <!-- §12 — "par auteur". The number that matters is the agent one. -->
      <div class="by-author">
        <span class="section-label">by author</span>
        <button class="arow" :class="{ on: filter === 'all' }" @click="filter = 'all'">
          <span class="dimmark">◇</span> all <span class="num">{{ files.length }}</span>
        </button>
        <button class="arow" :class="{ on: filter === 'human' }" @click="filter = 'human'">
          <span class="attr human">●</span> human <span class="num">{{ counts.human }}</span>
        </button>
        <button class="arow" :class="{ on: filter === 'agent' }" @click="filter = 'agent'">
          <span class="attr agent">◆</span> agent <span class="num">{{ counts.agent }}</span>
        </button>
        <button
          v-if="counts.unknown"
          class="arow"
          :class="{ on: filter === 'unreviewed' }"
          @click="filter = 'unreviewed'"
          title="Changes the journal cannot attribute — edited outside the cockpit"
        >
          <span class="dimmark">·</span> untracked origin <span class="num">{{ counts.unknown }}</span>
        </button>
      </div>
    </aside>

    <div class="view">
      <div v-if="selected" class="vhead">
        <span class="mono vpath">{{ selected }}</span>
        <span class="grow" />
        <button class="btn ghost" @click="openInIde">Open in IDE</button>
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
.diff { display: grid; grid-template-columns: 300px minmax(0, 1fr); height: 100%; }

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
  padding: 10px 12px 6px;
}
.tot { display: flex; gap: 6px; font-size: var(--fs-xs); }
.add { color: var(--ok); }
.del { color: var(--danger); }

.scroll { flex: 1; overflow-y: auto; padding: 0 6px 6px; }

.frow {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}
.frow:hover { background: var(--hover); }
.frow.on { background: var(--selected); color: var(--text); }

.attr { flex: none; font-size: 9px; line-height: 1; }
.attr.human { color: var(--human); }
.attr.agent { color: var(--agent); }
.attr.mixed { color: var(--warn); }
.attr.unknown { color: var(--text-dim); }
.dimmark { color: var(--text-dim); font-size: 9px; }

.st {
  flex: none;
  width: 11px;
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
  direction: rtl;
  text-align: left;
  font-family: var(--mono);
  font-size: var(--fs-xs);
}
.counts { display: flex; gap: 5px; font-size: 10px; flex: none; }

.by-author {
  flex: none;
  border-top: 1px solid var(--line);
  padding: 8px 6px;
}
.by-author .section-label { display: block; padding: 0 8px 4px; }
.arow {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  color: var(--text-muted);
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
  height: 34px;
  padding: 0 12px;
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
.vhead .btn { height: 22px; padding: 0 8px; font-size: var(--fs-xs); }

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
