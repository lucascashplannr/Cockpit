<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { DocsProposal, DocsProposalSet, Workspace } from '@cockpit/shared'
import { BookMarked, BookOpen, Check, CircleAlert, FilePen, FilePlus, FileX, Pencil, X } from '@lucide/vue'
import { dismissDocsSet, resolveDocsForget, resolveDocsPage, state } from '../../core/store.js'
import { lineDiff } from '../../core/linediff.js'
import { createMarked } from '../../core/markdown.js'

/**
 * §9 — what the Document step proposed to the docs, waiting on a person.
 *
 * The memory is written freely, because it is disposable. The docs are
 * forever, so nothing reaches them unseen: every page the agent drafted is a
 * card here — its diff, and why — until it is accepted, edited and accepted,
 * or rejected. (A second way, every page written in at once and read in the
 * Diff, was tried beside this one and dropped on 2026-09-30.)
 */

const props = defineProps<{ workspace: Workspace }>()

const info = computed(() => state.docsInfo[props.workspace.projectId] ?? null)
const sets = computed(() => state.docsPending[props.workspace.projectId] ?? [])

/** Which pages are unfolded, and which are being edited, by `set:path`. */
const open = reactive<Record<string, boolean>>({})
const editing = reactive<Record<string, string>>({})
const busy = ref<string | null>(null)

const key = (s: DocsProposalSet, f: DocsProposal) => s.id + ':' + f.path

/* ── the memory, emptying into the docs ────────────────────────────────────
 *
 * What the agent took out of its copy of the memory because a page now says
 * it. One card, after the pages, every entry ticked; untick what should stay.
 */
const md = createMarked({ breaks: false })
const kept = reactive<Record<string, string[]>>({})
const pagesOpen = (s: DocsProposalSet) => s.files.some((f) => f.state === 'pending')
function entryHtml(line: string): string {
  const text = line
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\s*_\([^()]{1,60},\s*\d{1,2}\s+[A-Za-z]{3,5}\)_\s*$/, '')
  return md.parseInline(text) as string
}
function toggleKeep(s: DocsProposalSet, line: string): void {
  const list = kept[s.id] ?? []
  kept[s.id] = list.includes(line) ? list.filter((l) => l !== line) : [...list, line]
}
async function forget(s: DocsProposalSet, accept: boolean): Promise<void> {
  busy.value = s.id + ':forget'
  try {
    await resolveDocsForget(s, accept, kept[s.id] ?? [])
  } finally {
    busy.value = null
  }
}
const waiting = (s: DocsProposalSet) => s.files.filter((f) => f.state === 'pending')

function tail(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : path
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return Math.round(s / 60) + ' min ago'
  if (s < 86400) return Math.round(s / 3600) + ' h ago'
  return Math.round(s / 86400) + ' d ago'
}

const KIND = {
  new: { label: 'New page', icon: FilePlus },
  changed: { label: 'Changed', icon: FilePen },
  deleted: { label: 'Delete', icon: FileX },
} as const

async function decide(s: DocsProposalSet, f: DocsProposal, accept: boolean): Promise<void> {
  const k = key(s, f)
  busy.value = k
  try {
    const content = k in editing ? editing[k] : undefined
    await resolveDocsPage(s, f.path, accept, content)
    delete editing[k]
  } finally {
    busy.value = null
  }
}

function edit(s: DocsProposalSet, f: DocsProposal): void {
  editing[key(s, f)] = f.after ?? ''
  open[key(s, f)] = true
}

async function acceptAll(s: DocsProposalSet): Promise<void> {
  busy.value = s.id
  try {
    for (const f of waiting(s)) await resolveDocsPage(s, f.path, true)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="docs">
    <header class="head">
      <BookOpen class="sm dim" />
      <span v-if="info" class="where mono" :title="info.path">{{ tail(info.path) }}</span>
      <span v-if="info?.guide" class="guide" :title="'Agents are handed ' + info.guide + ' at launch'">
        guide: {{ info.guide }}
      </span>
    </header>

    <div class="list">
      <div v-if="!sets.length" class="empty">
        <BookOpen />
        <strong>Nothing waiting</strong>
        <span>
          <span class="mono">/document</span> in a conversation drafts proposals to the docs here —
          and so does <span class="mono">/clear</span>. Nothing reaches the docs until you accept it.
        </span>
      </div>

      <section v-for="s in sets" :key="s.id" class="set">
        <div class="shead">
          <strong class="stitle" :title="s.title">{{ s.title }}</strong>
          <span class="when">{{ ago(s.createdAt) }}</span>
        </div>
        <!-- Its own row: in a 440px column the title and three buttons on one
             line left the title a word long. -->
        <div class="sacts">
          <button
            v-if="s.status === 'ready' && waiting(s).length"
            class="btn"
            :disabled="busy === s.id"
            @click="acceptAll(s)"
          >
            <Check />Accept all
          </button>
          <button class="btn ghost" title="Reject everything in this set" @click="dismissDocsSet(s)">
            <X />Dismiss
          </button>
        </div>

        <!-- No animation: the conversation is where the turn is seen running. -->
        <p v-if="s.status === 'drafting'" class="state">Drafting in the conversation…</p>
        <p v-else-if="s.status === 'failed'" class="state bad"><CircleAlert class="sm" />{{ s.detail }}</p>
        <p v-else-if="!s.files.length" class="state">{{ s.detail ?? 'Nothing worth documenting.' }}</p>

        <!-- One page, its diff, and the decision. -->
        <article v-for="f in waiting(s)" :key="f.path" class="card">
            <button class="chead" @click="open[key(s, f)] = !open[key(s, f)]">
              <component :is="KIND[f.kind].icon" class="sm dim" />
              <span class="kind">{{ KIND[f.kind].label }}</span>
              <span class="path mono">{{ f.path }}</span>
            </button>
            <p v-if="f.why" class="why">{{ f.why }}</p>
            <p v-if="f.drifted" class="drift">
              <CircleAlert class="sm" />This page changed in the docs after the proposal was drafted —
              accepting replaces what is there now.
            </p>

            <textarea
              v-if="key(s, f) in editing"
              v-model="editing[key(s, f)]"
              class="editor mono selectable"
              spellcheck="false"
            />
            <div v-else-if="open[key(s, f)] !== false" class="diff mono">
              <div v-for="(l, i) in lineDiff(f.before, f.after)" :key="i" class="dl" :class="l.kind">
                <span class="sg">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '' }}</span>
                <span class="tx">{{ l.text }}</span>
              </div>
            </div>

            <div class="cfoot">
              <button class="btn primary" :disabled="busy === key(s, f)" @click="decide(s, f, true)">
                <Check />{{ key(s, f) in editing ? 'Accept edited' : 'Accept' }}
              </button>
              <button v-if="!(key(s, f) in editing) && f.kind !== 'deleted'" class="btn ghost" @click="edit(s, f)">
                <Pencil />Edit
              </button>
              <button v-else-if="key(s, f) in editing" class="btn ghost" @click="delete editing[key(s, f)]">
                Cancel edit
              </button>
              <span class="grow" />
              <button class="btn ghost" :disabled="busy === key(s, f)" @click="decide(s, f, false)">
                <X />Reject
              </button>
            </div>
          </article>

        <article v-if="s.forget?.state === 'pending'" class="card">
          <div class="chead static">
            <BookMarked class="sm dim" />
            <span class="kind">Memory</span>
            <span class="path">
              {{ s.forget.entries.length }} {{ s.forget.entries.length === 1 ? 'entry' : 'entries' }} the docs now cover
            </span>
          </div>
          <p class="why">
            {{
              pagesOpen(s)
                ? 'Decide the pages first — a note goes only once a page says it for good.'
                : 'The accepted pages say these for good, so the memory can let them go. Untick what should stay.'
            }}
          </p>
          <ul class="forget selectable">
            <li v-for="e in s.forget.entries" :key="e">
              <label>
                <input
                  type="checkbox"
                  :checked="!(kept[s.id] ?? []).includes(e)"
                  :disabled="pagesOpen(s)"
                  @change="toggleKeep(s, e)"
                />
                <span class="etext" v-html="entryHtml(e)" />
              </label>
            </li>
          </ul>
          <div class="cfoot">
            <button
              class="btn primary"
              :disabled="pagesOpen(s) || busy === s.id + ':forget' || (kept[s.id]?.length ?? 0) === s.forget.entries.length"
              @click="forget(s, true)"
            >
              <Check />Remove from memory
            </button>
            <span class="grow" />
            <button class="btn ghost" :disabled="busy === s.id + ':forget'" @click="forget(s, false)">
              <X />Keep all
            </button>
          </div>
        </article>
      </section>
    </div>
  </div>
</template>

<style scoped>
.docs { display: flex; flex-direction: column; height: 100%; min-width: 0; }

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.dim { color: var(--text-dim); }
.where { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.guide { flex: none; color: var(--text-dim); }
.grow { flex: 1; min-width: 0; }

.list { flex: 1; overflow-y: auto; padding: 16px 18px 40px; }

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: 360px;
  margin: 60px auto 0;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--fs-sm);
  line-height: 1.5;
}
.empty .lucide { width: 22px; height: 22px; color: var(--text-dim); }
.empty strong { color: var(--text); }

.set + .set { margin-top: 26px; }
.shead { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.sacts { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.stitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
  color: var(--text);
}
.when { flex: none; font-size: var(--fs-xs); color: var(--text-dim); }

.state { margin: 0 0 8px; font-size: var(--fs-sm); color: var(--text-muted); display: flex; gap: 6px; align-items: center; }
.state.bad { color: var(--danger); }

.why { color: var(--text-dim); }

.card {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-review);
  overflow: hidden;
}
.card + .card { margin-top: 10px; }
.chead {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  text-align: left;
}
.chead.static { cursor: default; }
.forget { list-style: none; margin: 0; padding: 2px 12px 8px; font-size: var(--fs-sm); color: var(--text-muted); }
.forget li + li { margin-top: 4px; }
.forget label { display: flex; gap: 8px; align-items: flex-start; line-height: 1.5; }
.forget input { flex: none; margin-top: 3px; }
.forget .etext :deep(code) { padding: 1px 4px; border-radius: 4px; background: var(--active); font-family: var(--mono); font-size: 0.88em; }
.kind { flex: none; font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); }
.path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); color: var(--text); }
.card > .why { margin: -4px 12px 8px; font-size: var(--fs-xs); line-height: 1.5; }
.drift {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: 0 12px 8px;
  padding: 6px 9px;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-xs);
  line-height: 1.5;
}

.diff {
  max-height: 360px;
  overflow: auto;
  border-top: 1px solid var(--line);
  font-size: 11px;
  line-height: 1.55;
  padding: 4px 0;
}
.dl { display: flex; white-space: pre-wrap; word-break: break-word; }
.dl.add { background: var(--diff-add-bg); }
.dl.del { background: var(--diff-del-bg); }
.dl.gap { color: var(--text-dim); font-style: italic; padding: 2px 0; }
.sg { flex: none; width: 20px; text-align: center; user-select: none; opacity: 0.7; }
.tx { padding-right: 14px; min-width: 0; }
.dl.add .sg, .dl.add .tx { color: var(--diff-add-text); }
.dl.del .sg, .dl.del .tx { color: var(--diff-del-text); }

.editor {
  display: block;
  width: calc(100% - 24px);
  min-height: 220px;
  margin: 0 12px 4px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  font-size: var(--fs-sm);
  line-height: 1.55;
  resize: vertical;
}

.cfoot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
}
</style>
