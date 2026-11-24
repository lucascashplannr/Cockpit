<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  Ban, Check, CircleAlert, CircleCheck, Combine, FileCode, FileWarning, LoaderCircle, Pencil, RotateCcw, SkipForward, Sparkles,
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

/** A side's text as the lines the Diff draws, one row each. */
function lines(text: string): string[] {
  return text ? text.replace(/\n$/, '').split('\n') : []
}

function shortLabel(label: string): string {
  return label.replace(/^origin\//, '')
}
</script>

<template>
  <div v-if="op" class="conflicts">
    <!-- What is happening, and the verbs that end it: the bar of this mode.
         The surface of the column, not a red band: the mark says conflict. -->
    <div class="top">
      <CircleAlert class="mark" />
      <div class="what">
        <span class="head">{{ heading }}</span>
        <span class="sub num">
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
      <!-- The Diff's file list: the same header, the same rows. -->
      <aside class="files">
        <div class="ftop"><span class="section-label">files ({{ files.length }})</span></div>
        <div class="scroll">
          <button
            v-for="f in files"
            :key="f.path"
            class="frow"
            :class="[f.status, { on: f.path === path }]"
            :title="f.path"
            @click="conflictUi.path = f.path"
          >
            <component :is="f.status === 'left' ? FileWarning : CircleCheck" class="fi" />
            <span class="fp">
              <span class="fname">{{ f.path.split('/').pop() }}</span>
              <span class="fdir">{{ f.path.split('/').slice(0, -1).join('/') }}</span>
            </span>
          </button>
        </div>
      </aside>

      <section v-if="path" class="detail">
        <div class="vhead">
          <span class="mono vpath" :title="path">{{ path }}</span>
          <span v-if="status === 'left' && hunks.length" class="count num">{{ chosenCount }} of {{ hunks.length }} chosen</span>
          <span class="grow" />
          <template v-if="status === 'left' && file?.kind === 'text'">
            <button
              v-if="proposedCount"
              class="btn ghost agent"
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

        <div v-if="loading && !file" class="msg"><LoaderCircle class="spin sm" /></div>

        <!-- Resolved: in the IDE, here, or staged by Continue's way in. -->
        <div v-else-if="status !== 'left'" class="msg ok">
          <CircleCheck class="sm" />Resolved{{ status === 'staged' ? ' and staged' : '' }}. Continue takes it as it is now.
        </div>

        <!-- No markers to read: binary, or deleted on one side. -->
        <div v-else-if="file && file.kind !== 'text'" class="msg col">
          <p>{{ file.kind === 'binary' ? 'A binary file changed on both sides.' : 'One side deleted this file and the other changed it.' }}</p>
          <div class="acts flush">
            <button class="btn" @click="takeConflictSide(w, path, sides!.left.key)">Take {{ shortLabel(sides!.left.side.label) }}</button>
            <button class="btn" @click="takeConflictSide(w, path, sides!.right.key)">Take yours</button>
          </div>
        </div>

        <!-- Markers git did not write, or none at all: leave it to a person. -->
        <div v-else-if="file && !hunks.length" class="msg col">
          <p>No conflict markers git can read in this file.</p>
          <div class="acts flush"><button class="btn" @click="markResolved([path])">Mark it resolved</button></div>
        </div>

        <div v-else-if="file && sides" class="hunks">
          <article v-for="(h, n) in hunks" :key="h.i" class="hunk">
            <!-- The Diff's hunk header line: which conflict, and the verbs that
                 are not one side's. Each side carries its own Take. -->
            <div class="hhead">
              <span class="hn">Conflict {{ n + 1 }} of {{ hunks.length }}</span>
              <span class="grow" />
              <template v-if="chosen[h.i] !== undefined && editing !== h.i">
                <span class="hok"><Check />Chosen</span>
                <button class="btn ghost" @click="delete chosen[h.i]"><RotateCcw />Change</button>
              </template>
              <template v-else-if="editing !== h.i">
                <button class="btn ghost" :title="shortLabel(sides.left.side.label) + ' first, then yours'" @click="choose(h.i, both(h))">
                  <Combine />Both
                </button>
                <button class="btn ghost" @click="startEdit(h)"><Pencil />Edit</button>
              </template>
            </div>

            <div v-for="(l, k) in lines(context(h.i, 'before'))" :key="'b' + k" class="line ctx">{{ l }}</div>

            <div v-if="chosen[h.i] !== undefined && editing !== h.i" class="side result">
              <div v-for="(l, k) in lines(chosen[h.i]!)" :key="k" class="line">{{ l }}</div>
              <div v-if="!chosen[h.i]" class="line none">nothing</div>
            </div>

            <template v-else-if="editing === h.i">
              <textarea v-model="draft" class="edit" spellcheck="false" :rows="Math.min(18, draft.split('\n').length + 1)" />
              <div class="acts">
                <button class="btn primary" @click="choose(h.i, draft.endsWith('\n') || !draft ? draft : draft + '\n')">Use this</button>
                <button class="btn ghost" @click="editing = null">Cancel</button>
              </div>
            </template>

            <template v-else>
              <!-- The two candidates, each named where it is read, each with its own Take. -->
              <div class="pair">
                <div v-for="s in [{ c: 'base', at: sides.left }, { c: 'yours', at: sides.right }]" :key="s.c" class="side" :class="s.c">
                  <div class="shead" :title="s.at.side.commits.join('\n')">
                    <i class="sw" />
                    <span class="cn">{{ s.c === 'yours' ? 'yours · ' : '' }}{{ shortLabel(s.at.side.label) }}</span>
                    <span v-if="s.at.side.commits[0]" class="cm">{{ s.at.side.commits[0] }}</span>
                    <span class="grow" />
                    <button class="btn ghost take" @click="choose(h.i, sideText(h, s.at.key))"><Check />Take</button>
                  </div>
                  <div v-for="(l, k) in lines(sideText(h, s.at.key))" :key="k" class="line">{{ l }}</div>
                  <div v-if="!sideText(h, s.at.key)" class="line none">nothing</div>
                </div>
              </div>
              <div v-if="proposed[h.i]" class="side prop">
                <div class="shead">
                  <Sparkles class="pi" />
                  <span class="cn">Proposal</span>
                  <span v-if="proposed[h.i]!.why" class="cm">{{ proposed[h.i]!.why }}</span>
                  <span class="grow" />
                  <button class="btn ghost take" @click="choose(h.i, proposed[h.i]!.text)"><Check />Take</button>
                </div>
                <div v-for="(l, k) in lines(proposed[h.i]!.text)" :key="k" class="line">{{ l }}</div>
                <div v-if="!proposed[h.i]!.text" class="line none">nothing</div>
              </div>
            </template>

            <div v-for="(l, k) in lines(context(h.i, 'after'))" :key="'a' + k" class="line ctx">{{ l }}</div>
          </article>
          <p v-if="saving" class="msg"><LoaderCircle class="spin sm" />Writing {{ path }}…</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* A mode, not a tool: it has the right of the window to itself (App.vue), so
   it is laid out for that width and narrows only when the window does. It is
   built from the Diff's parts (the file list, the 40px file header, lines
   drawn edge to edge) so the two read as one app. */
.conflicts {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  font-size: var(--fs-sm);
  background: var(--surface-review);
}
.grow { flex: 1; }

/* ── the bar of the mode ──────────────────────────────────────────────
   One surface with the column under it and a hairline where it ends (the
   rule in tokens.css). Conflict is said by the mark, not by a band. */
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 52px;
  padding: 8px 14px 8px 16px;
  border-bottom: 1px solid var(--line);
  flex: none;
}
.mark { width: 16px; height: 16px; color: var(--danger); flex: none; margin-right: 4px; }
.what { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.head { font-weight: 600; font-size: var(--fs-sm); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; }
.top .btn { height: 28px; padding: 0 10px; font-size: var(--fs-xs); flex: none; }
.top .btn.danger,
.top .btn.danger:hover:not(:disabled) { color: var(--danger); }
.top .btn.danger:hover:not(:disabled) { background: var(--danger-soft); }
.verb { display: inline-flex; margin-left: 4px; }

.note {
  margin: 0;
  padding: 8px 16px;
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

/* ── the files: the Diff's list ───────────────────────────────────────── */
.files { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); }
.ftop { display: flex; align-items: center; padding: 12px 15px 8px; flex: none; }
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
.fi { width: 13px; height: 13px; flex: none; color: var(--danger); }
.frow.done .fi, .frow.staged .fi { color: var(--ok); }
.fp { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; overflow: hidden; white-space: nowrap; }
.fname { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.fdir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}

/* ── the file: the Diff's header, the Diff's lines ────────────────────── */
.detail { overflow: auto; min-width: 0; }
.vhead {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-review);
}
.vpath { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.count { flex: none; font-size: var(--fs-xs); color: var(--text-dim); }
.vhead .btn { height: 26px; padding: 0 9px; font-size: var(--fs-xs); flex: none; }

/* Anything written by an agent wears the agent's ink (tokens.css). */
.btn.agent { color: var(--agent); }
.btn.agent:hover:not(:disabled) { color: var(--agent); }

.msg { display: flex; align-items: center; gap: 8px; margin: 0; padding: 24px 20px; font-size: var(--fs-sm); color: var(--text-muted); }
.msg.ok { color: var(--ok); }
.msg.col { flex-direction: column; align-items: flex-start; gap: 0; }
.msg p { margin: 0; }

.hunks { padding-bottom: 32px; }

.hunk { margin-top: 14px; }
/* The Diff's hunk header line: the count, and the verbs no one side owns. */
.hhead {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 32px;
  padding: 0 10px 0 20px;
  background: var(--bg-sunken);
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.hn { white-space: nowrap; }
.hok { display: inline-flex; align-items: center; gap: 4px; margin-right: 6px; color: var(--ok); }
.hok .lucide { width: 12px; height: 12px; }
.hhead + .line { margin-top: 6px; }
.hunk > .line.ctx:last-child { margin-bottom: 2px; }

/* The header's verbs and each side's Take: the Diff header's ghost buttons. */
.hhead .btn,
.shead .btn { height: 24px; padding: 0 8px; gap: 5px; font-size: var(--fs-xs); }
.hhead .btn .lucide,
.shead .btn .lucide { width: 12px; height: 12px; }

.line {
  padding: 0 16px 0 20px;
  font-family: var(--mono);
  font-size: var(--fs-sm);
  line-height: 1.5;
  tab-size: 4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text);
}
.line.ctx { color: var(--text-dim); }
.line.none { font-family: var(--font); font-size: var(--fs-xs); font-style: italic; color: var(--text-dim); }

/* The candidates. Each is a band of its own ink with an edge in its colour,
   so it reads apart from the faint lines around it, and is named on its own
   first line rather than once at the top of the file. */
.pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1px; margin: 6px 0; }
@container (max-width: 620px) { .pair { grid-template-columns: minmax(0, 1fr); gap: 6px; } }
.side {
  --edge: var(--line-strong);
  min-width: 0;
  padding: 0 0 6px;
  background: var(--hover);
  box-shadow: inset 2px 0 0 var(--edge);
}
.side.yours { --edge: var(--accent); background: var(--selected); }
.side.prop { --edge: var(--agent); background: var(--agent-soft); margin: 6px 0; }
.side.result { --edge: var(--ok); background: var(--diff-add-bg); padding-top: 6px; margin: 6px 0; }

.shead {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 8px 0 20px;
  font-size: var(--fs-xs);
}
.sw { width: 8px; height: 8px; border-radius: 2px; flex: none; background: var(--edge); }
.pi { width: 12px; height: 12px; flex: none; color: var(--agent); }
.cn { flex: none; font-weight: 600; color: var(--text); }
.side.yours .cn { color: var(--accent); }
.side.prop .cn { color: var(--agent); }
.cm { min-width: 0; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.take { flex: none; }
/* The side a Take would keep lights up while the pointer is on it. */
.side:has(.take:hover) { box-shadow: inset 2px 0 0 var(--edge), inset 0 0 0 1px var(--edge); }

.edit {
  display: block;
  width: calc(100% - 32px);
  box-sizing: border-box;
  margin: 6px 16px;
  padding: 8px 10px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--surface-input);
  color: var(--text);
  font-family: var(--mono);
  font-size: var(--fs-sm);
  line-height: 1.5;
  resize: vertical;
}

.acts { display: flex; align-items: center; gap: 6px; padding: 8px 16px 6px 20px; flex-wrap: wrap; }
.acts.flush { padding: 12px 0 0; }
.acts .btn { height: 26px; padding: 0 10px; font-size: var(--fs-xs); }
</style>
