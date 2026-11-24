<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  Ban, Check, CircleAlert, CircleCheck, FileCode, FileWarning, LoaderCircle, Pencil, RotateCcw, SkipForward, Sparkles,
} from '@lucide/vue'
import type { ConflictFile, ConflictSegment, Workspace } from '@cockpit/shared'
import {
  client, conflictBusy, conflictKey, conflictUi, guard, markResolved, openConflictFile, proposeAllConflicts,
  proposeConflict, resolveConflict, restartConflict, saveConflict, takeConflictSide,
} from '../../core/store.js'

/**
 * §3.7 — the conflict, as a place to work rather than a banner.
 *
 * Files down the side, the one you are on as its conflicts: the side it lands
 * on to the left, yours to the right, each named by its branch — never "ours"
 * and "theirs", which git swaps in a rebase — and, under them, what Claude
 * would write instead, when asked. A choice per conflict; the file is written
 * the moment the last one is made. Nothing is staged until Continue, so the
 * list can still count what is left.
 *
 * Nothing here is the authority: the markers are (§3.4). A file fixed in the
 * IDE turns done in the list without anyone telling this tab.
 */

const props = defineProps<{ workspace: Workspace }>()
const w = computed(() => props.workspace)
const op = computed(() => w.value.git?.operation ?? null)

/* ── the list ─────────────────────────────────────────────────────────── */

watch(
  () => [conflictKey(w.value), op.value?.conflictedPaths.join('\n')] as const,
  () => {
    const k = conflictKey(w.value)
    const had = conflictUi.seen[k] ?? []
    const now = op.value?.conflictedPaths ?? []
    conflictUi.seen[k] = [...had, ...now.filter((p) => !had.includes(p))]
  },
  { immediate: true },
)

type Status = 'left' | 'done' | 'staged'
const files = computed(() => {
  const o = op.value
  if (!o) return []
  return (conflictUi.seen[conflictKey(w.value)] ?? o.conflictedPaths).map((path) => ({
    path,
    status: (o.unresolvedPaths.includes(path) ? 'left' : o.conflictedPaths.includes(path) ? 'done' : 'staged') as Status,
  }))
})
const left = computed(() => files.value.filter((f) => f.status === 'left').length)
const ready = computed(() => !!op.value && op.value.unresolvedPaths.length === 0)

/** The file on screen: the one picked, else the first still to do. */
const path = computed(() => {
  const p = conflictUi.path
  if (p && files.value.some((f) => f.path === p)) return p
  return files.value.find((f) => f.status === 'left')?.path ?? files.value[0]?.path ?? null
})

/* ── what this operation is ───────────────────────────────────────────── */

const heading = computed(() => {
  const o = op.value
  if (!o) return ''
  if (o.kind === 'rebase') return 'Catching up ' + (o.branch ?? 'this branch') + (o.onto ? ' onto ' + o.onto : '')
  if (o.kind === 'merge') return 'Merging into ' + (w.value.git?.branch ?? 'this branch')
  return o.kind === 'cherry-pick' ? 'Cherry-picking' : 'Reverting'
})
const progress = computed(() => {
  const o = op.value
  return o?.step && o.total ? 'commit ' + o.step + ' of ' + o.total : null
})
const note = computed(() => {
  const o = op.value
  if (!o) return ''
  const parts: string[] = []
  if (o.merged) parts.push(o.merged === 1 ? '1 file merged cleanly and goes into the commit Continue makes.' : o.merged + ' files merged cleanly and go into the commit Continue makes.')
  if (o.held) parts.push('Your uncommitted work is set aside and comes back when this ends, abort included.')
  return parts.join(' ')
})
const anyProposing = computed(() => Object.keys(conflictUi.proposing).some((k) => k.startsWith(w.value.id + ':')))

/* ── the file ─────────────────────────────────────────────────────────── */

const file = ref<ConflictFile | null>(null)
const loading = ref(false)
/** The text chosen for each conflict of the file on screen. */
const chosen = reactive<Record<number, string>>({})
/** The conflict being edited by hand, and its draft. */
const editing = ref<number | null>(null)
const draft = ref('')

async function load(): Promise<void> {
  const p = path.value
  if (!p) {
    file.value = null
    return
  }
  loading.value = true
  const res = await guard(() => client.call('conflict.file', { workspaceId: w.value.id, path: p }))
  loading.value = false
  if (!res || path.value !== p) return
  file.value = res
  for (const k of Object.keys(chosen)) delete chosen[Number(k)]
  editing.value = null
}

// Re-read on a new file, and whenever the markers of this one come or go.
watch(
  () => [w.value.id, path.value, op.value?.unresolvedPaths.includes(path.value ?? '')] as const,
  () => void load(),
  { immediate: true },
)

const status = computed(() => files.value.find((f) => f.path === path.value)?.status ?? 'left')

/** Left is what it lands on, right is yours. */
const sides = computed(() => {
  const f = file.value
  if (!f) return null
  const oursIsYours = f.ours.yours
  return {
    left: { key: (oursIsYours ? 'theirs' : 'ours') as 'ours' | 'theirs', side: oursIsYours ? f.theirs : f.ours },
    right: { key: (oursIsYours ? 'ours' : 'theirs') as 'ours' | 'theirs', side: oursIsYours ? f.ours : f.theirs },
  }
})

const proposal = computed(() => (path.value ? conflictUi.proposals[w.value.id + ':' + path.value] : undefined))
const proposed = computed(() => {
  const p = proposal.value
  const f = file.value
  // A proposal for an older read of the file is a proposal for other lines.
  if (!p || !f || (p.mtimeMs && f.mtimeMs && Math.abs(p.mtimeMs - f.mtimeMs) > 1)) return {} as Record<number, { text: string; why: string }>
  return Object.fromEntries(p.hunks.map((h) => [h.i, h]))
})
const proposing = computed(() => !!path.value && !!conflictUi.proposing[w.value.id + ':' + path.value])

type Hunk = Extract<ConflictSegment, { kind: 'hunk' }>
const hunks = computed(() => (file.value?.segments.filter((s) => s.kind === 'hunk') ?? []) as Hunk[])

/** A few lines either side, so a conflict is read where it sits. */
function context(i: number, where: 'before' | 'after'): string {
  const segs = file.value?.segments ?? []
  const at = segs.findIndex((s) => s.kind === 'hunk' && s.i === i)
  const s = segs[where === 'before' ? at - 1 : at + 1]
  if (!s || s.kind !== 'same') return ''
  const ls = s.text.replace(/\n$/, '').split('\n')
  // Blank lines at the edges say nothing about where the conflict sits.
  return (where === 'before' ? ls.slice(-3) : ls.slice(0, 3)).join('\n').replace(/^\s*\n|\n\s*$/g, '')
}

function sideText(h: Hunk, key: 'ours' | 'theirs'): string {
  return h[key]
}

function choose(i: number, text: string): void {
  chosen[i] = text
  editing.value = null
  void writeIfDone()
}

function both(h: Hunk): string {
  const s = sides.value!
  return sideText(h, s.left.key) + sideText(h, s.right.key)
}

function startEdit(h: Hunk): void {
  editing.value = h.i
  draft.value = chosen[h.i] ?? proposed.value[h.i]?.text ?? sideText(h, sides.value!.right.key)
}

function useAllProposals(): void {
  for (const h of hunks.value) if (proposed.value[h.i] && chosen[h.i] === undefined) chosen[h.i] = proposed.value[h.i]!.text
  void writeIfDone()
}

function compose(): string {
  return (file.value?.segments ?? [])
    .map((s) => (s.kind === 'same' ? s.text : (chosen[s.i] ?? '')))
    .join('')
}

const saving = ref(false)
async function writeIfDone(): Promise<void> {
  const f = file.value
  if (!f || hunks.value.some((h) => chosen[h.i] === undefined)) return
  saving.value = true
  const ok = await saveConflict(w.value, f.path, compose(), f.mtimeMs)
  saving.value = false
  // On to the next file that is left, the way a list of chores is worked.
  if (ok && conflictUi.path === f.path) conflictUi.path = null
}

const chosenCount = computed(() => hunks.value.filter((h) => chosen[h.i] !== undefined).length)
const proposedCount = computed(() => hunks.value.filter((h) => proposed.value[h.i]).length)

function shortLabel(label: string): string {
  return label.replace(/^origin\//, '')
}
</script>

<template>
  <div v-if="op" class="conflicts">
    <!-- What is happening, and the verbs that end it: the bar of this mode. -->
    <div class="top">
      <CircleAlert class="ic" />
      <div class="what">
        <span class="head">{{ heading }}</span>
        <span class="dim num">
          <template v-if="progress">{{ progress }} · </template>{{ left ? left + ' of ' + files.length + (files.length === 1 ? ' file' : ' files') + ' left' : 'all ' + files.length + ' resolved' }}
        </span>
      </div>
      <span class="grow" />
      <button
        v-if="left"
        class="btn ghost"
        :disabled="anyProposing"
        title="Ask Claude for a resolution of every conflict that is left. Nothing is written until you choose."
        @click="proposeAllConflicts(w)"
      >
        <LoaderCircle v-if="anyProposing" class="spin" /><Sparkles v-else />Propose all
      </button>
      <button
        v-if="op.kind !== 'merge'"
        class="btn ghost"
        :disabled="conflictBusy"
        title="Drop this commit and go on to the next"
        @click="resolveConflict('skip')"
      >
        <SkipForward />Skip commit
      </button>
      <button
        class="btn ghost danger"
        :disabled="conflictBusy"
        :title="op.kind === 'rebase' ? 'Put the branch back where it was before the Catch up' : 'Put the branch back where it was before the merge'"
        @click="resolveConflict('abort')"
      >
        <Ban />Abort
      </button>
      <span class="verb" :title="ready ? 'Stage the resolved files and carry on' : left + ' file(s) still have conflicts'">
        <button class="btn primary" :disabled="!ready || conflictBusy" @click="resolveConflict('continue')">
          <LoaderCircle v-if="conflictBusy" class="spin" /><Check v-else />Continue
        </button>
      </span>
    </div>
    <p v-if="note" class="note">{{ note }}</p>

    <div class="body">
      <ul class="files">
        <li v-for="f in files" :key="f.path">
          <button class="file" :class="[f.status, { on: f.path === path }]" :title="f.path" @click="conflictUi.path = f.path">
            <component :is="f.status === 'left' ? FileWarning : CircleCheck" class="sm fi" />
            <span class="fn">{{ f.path.split('/').pop() }}</span>
            <span class="fd">{{ f.path.split('/').slice(0, -1).join('/') }}</span>
          </button>
        </li>
      </ul>

      <section v-if="path" class="detail">
        <div class="fhead">
          <span class="fpath mono" :title="path">{{ path }}</span>
          <span v-if="status === 'left' && hunks.length" class="dim num">{{ chosenCount }} of {{ hunks.length }} chosen</span>
          <span class="grow" />
          <template v-if="status === 'left' && file?.kind === 'text'">
            <button
              v-if="proposedCount"
              class="btn ghost accent"
              title="Take every proposal for this file"
              @click="useAllProposals"
            >
              <Sparkles />Use {{ proposedCount === 1 ? 'the proposal' : proposedCount + ' proposals' }}
            </button>
            <button v-else class="btn ghost" :disabled="proposing" title="Ask Claude how to resolve this file" @click="proposeConflict(w, path)">
              <LoaderCircle v-if="proposing" class="spin" /><Sparkles v-else />{{ proposing ? 'Reading…' : 'Propose' }}
            </button>
          </template>
          <button v-if="status === 'done'" class="btn ghost" title="Put the conflict markers back and choose again" @click="restartConflict(w, path)">
            <RotateCcw />Start over
          </button>
          <button class="icon-btn" title="Open in the editor" @click="openConflictFile(path)"><FileCode class="sm" /></button>
        </div>

        <div v-if="loading && !file" class="empty"><LoaderCircle class="spin" /></div>

        <!-- Resolved: in the IDE, here, or staged by Continue's way in. -->
        <div v-else-if="status !== 'left'" class="empty ok">
          <CircleCheck />Resolved{{ status === 'staged' ? ' and staged' : '' }}. Continue takes it as it is now.
        </div>

        <!-- No markers to read: binary, or deleted on one side. -->
        <div v-else-if="file && file.kind !== 'text'" class="whole">
          <p>{{ file.kind === 'binary' ? 'A binary file changed on both sides.' : 'One side deleted this file and the other changed it.' }}</p>
          <div class="acts">
            <button class="btn ghost" @click="takeConflictSide(w, path, sides!.left.key)">Take {{ shortLabel(sides!.left.side.label) }}</button>
            <button class="btn ghost" @click="takeConflictSide(w, path, sides!.right.key)">Take yours</button>
          </div>
        </div>

        <!-- Markers git did not write, or none at all: leave it to a person. -->
        <div v-else-if="file && !hunks.length" class="whole">
          <p>No conflict markers git can read in this file.</p>
          <div class="acts"><button class="btn ghost" @click="markResolved([path])">Mark it resolved</button></div>
        </div>

        <div v-else-if="file && sides" class="hunks">
          <!-- The two columns, named once: what it lands on, and yours. -->
          <div class="cols">
            <div class="col base">
              <span class="cn"><i class="sw base" />{{ shortLabel(sides.left.side.label) }}</span>
              <span v-for="c in sides.left.side.commits.slice(0, 2)" :key="c" class="cm">{{ c }}</span>
            </div>
            <div class="col yours">
              <span class="cn"><i class="sw yours" />yours · {{ shortLabel(sides.right.side.label) }}</span>
              <span v-for="c in sides.right.side.commits.slice(0, 2)" :key="c" class="cm">{{ c }}</span>
            </div>
          </div>

          <article v-for="(h, n) in hunks" :key="h.i" class="hunk" :class="{ chosen: chosen[h.i] !== undefined }">
            <div class="hn dim">Conflict {{ n + 1 }} of {{ hunks.length }}</div>
            <pre v-if="context(h.i, 'before')" class="ctx mono">{{ context(h.i, 'before') }}</pre>

            <template v-if="chosen[h.i] !== undefined && editing !== h.i">
              <pre class="code result mono">{{ chosen[h.i] || '(nothing)' }}</pre>
              <div class="acts">
                <span class="dim"><Check class="sm" /> Chosen</span>
                <button class="btn ghost" @click="delete chosen[h.i]">Change</button>
              </div>
            </template>

            <template v-else-if="editing === h.i">
              <textarea v-model="draft" class="edit mono" spellcheck="false" :rows="Math.min(18, draft.split('\n').length + 1)" />
              <div class="acts">
                <button class="btn ghost accent" @click="choose(h.i, draft.endsWith('\n') || !draft ? draft : draft + '\n')">Use this</button>
                <button class="btn ghost" @click="editing = null">Cancel</button>
              </div>
            </template>

            <template v-else>
              <div class="pair">
                <div class="side base">
                  <pre class="code mono">{{ sideText(h, sides.left.key) || '(nothing)' }}</pre>
                </div>
                <div class="side yours">
                  <pre class="code mono">{{ sideText(h, sides.right.key) || '(nothing)' }}</pre>
                </div>
              </div>
              <div v-if="proposed[h.i]" class="prop">
                <div class="lab"><Sparkles class="sm" />Proposal</div>
                <pre class="code mono">{{ proposed[h.i]!.text || '(nothing)' }}</pre>
                <p v-if="proposed[h.i]!.why" class="why">{{ proposed[h.i]!.why }}</p>
              </div>
              <div class="acts">
                <button v-if="proposed[h.i]" class="btn ghost accent" @click="choose(h.i, proposed[h.i]!.text)">
                  <Sparkles />Use proposal
                </button>
                <button class="btn ghost" @click="choose(h.i, sideText(h, sides.left.key))">Take {{ shortLabel(sides.left.side.label) }}</button>
                <button class="btn ghost" @click="choose(h.i, sideText(h, sides.right.key))">Take yours</button>
                <button class="btn ghost" title="Theirs first, then yours" @click="choose(h.i, both(h))">Both</button>
                <button class="btn ghost" @click="startEdit(h)"><Pencil />Edit</button>
              </div>
            </template>

            <pre v-if="context(h.i, 'after')" class="ctx mono">{{ context(h.i, 'after') }}</pre>
          </article>
          <p v-if="saving" class="dim"><LoaderCircle class="spin sm" /> Writing {{ path }}…</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* A mode, not a tool: it has the right of the window to itself (App.vue), so
   it is laid out for that width and narrows only when the window does. */
.conflicts {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  font-size: var(--fs-sm);
  background: var(--surface-work, var(--bg));
}

.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--danger-soft);
  flex: none;
}
.ic { width: 18px; height: 18px; color: var(--danger); flex: none; }
.what { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.head { font-weight: 600; font-size: var(--fs-md); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dim { color: var(--text-muted); font-size: var(--fs-xs); display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.grow { flex: 1; }
.top .btn { height: 28px; padding: 0 11px; font-size: var(--fs-xs); flex: none; }
.top .btn.danger { color: var(--danger); border-color: transparent; }
.top .btn.primary:disabled { opacity: 1; background: transparent; border-color: var(--line-strong); color: var(--text-dim); box-shadow: none; }
.verb { display: inline-flex; }

.note {
  margin: 0;
  padding: 8px 20px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  border-bottom: 1px solid var(--line-soft);
  flex: none;
}

.body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
}
@container (max-width: 760px) {
  .body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .files { max-height: 150px; border-right: 0; border-bottom: 1px solid var(--line); }
}

.files { list-style: none; margin: 0; padding: 8px; overflow: auto; border-right: 1px solid var(--line); }
.file {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  padding: 6px 8px 6px 28px;
  position: relative;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  text-align: left;
  color: var(--text);
  font-size: var(--fs-xs);
  min-width: 0;
}
.file:hover { background: var(--hover); }
.file.on { background: var(--selected); }
.fi { position: absolute; left: 8px; top: 8px; color: var(--danger); }
.file.done .fi, .file.staged .fi { color: var(--ok); }
.file.done .fn, .file.staged .fn { color: var(--text-muted); }
.fn { white-space: nowrap; font-weight: 500; }
.fd { color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

.detail { overflow: auto; min-width: 0; }
.fhead {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  background: var(--surface-work, var(--bg));
  border-bottom: 1px solid var(--line-soft);
}
.fpath { font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.fhead .btn { height: 26px; padding: 0 10px; font-size: var(--fs-xs); flex: none; }
.btn.accent { color: var(--accent); }

.empty { display: flex; align-items: center; gap: 8px; padding: 28px 20px; color: var(--text-muted); font-size: var(--fs-sm); }
.empty.ok { color: var(--ok); }
.whole { padding: 20px; font-size: var(--fs-sm); color: var(--text-muted); }
.whole p { margin: 0 0 10px; }

.hunks { padding: 14px 20px 32px; max-width: 1280px; }

/* The two columns' names, once, over every conflict of the file. */
.cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
  margin: 0 9px 12px;
}
.col { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cn { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs); font-weight: 600; color: var(--text); }
.col.yours .cn { color: var(--accent); }
.cm { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 14px; }
.sw { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.sw.base { background: var(--line-strong); }
.sw.yours { background: var(--accent); }

.hunk {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 8px;
  margin-bottom: 14px;
  background: var(--panel);
}
.hunk.chosen { border-color: var(--line-soft); background: transparent; }
.hn { padding: 0 2px 4px; }
pre { margin: 0; }
.mono { font-family: var(--mono); font-size: 12px; line-height: 1.55; }
.ctx { color: var(--text-dim); padding: 2px 8px; white-space: pre; overflow-x: auto; }
.code { white-space: pre; overflow-x: auto; padding: 8px 10px; }

.pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin: 4px 0; }
@container (max-width: 620px) { .pair, .cols { grid-template-columns: minmax(0, 1fr); } }
.side { border-radius: var(--radius-sm); min-width: 0; border: 1px solid var(--line-soft); }
.side.yours { border-color: var(--accent-soft); background: color-mix(in srgb, var(--accent-soft) 35%, transparent); }
.lab { display: flex; align-items: center; gap: 5px; padding: 5px 10px 0; font-size: 10.5px; color: var(--text-muted); }
.side.yours .lab { color: var(--accent); }

.prop { margin: 8px 0 4px; border-radius: var(--radius-sm); background: var(--hover); }
.why { margin: 0; padding: 0 10px 8px; font-size: var(--fs-xs); color: var(--text-muted); }
.result { background: var(--ok-soft); border-radius: var(--radius-sm); margin: 4px 0; }

.edit {
  width: 100%;
  box-sizing: border-box;
  margin: 4px 0;
  padding: 8px 10px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--surface-input, var(--bg));
  color: var(--text);
  resize: vertical;
}

.acts { display: flex; align-items: center; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
.acts .btn { height: 26px; padding: 0 10px; font-size: var(--fs-xs); }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
