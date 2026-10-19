<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { resolveLink } from '@cockpit/shared'
import type { DocsFlag, DocsPage, Workspace } from '@cockpit/shared'
import { ArrowLeft, BookOpen, CircleAlert, FilePen, Flag, Search, X } from '@lucide/vue'
import { docsPageText, dropDocsFlag, openDocsPage, refreshDocs, state } from '../../core/store.js'
import MarkdownPreview from '../MarkdownPreview.vue'
import DocsProposals from '../docs/DocsProposals.vue'

/**
 * §9 — the docs, as a person reads them.
 *
 * The index first — every page by what it answers, a folder at a time — and a
 * page rendered with its `[[links]]` followable and the pages that link to it
 * underneath, which is how the docs are walked rather than searched. What a
 * page lacks against the contract is a dot in the index and a line on the
 * page: the same list a proposal is checked with.
 *
 * What the Document step proposed is not the tab any more but a band on it:
 * reading is what the docs are for most of the time.
 */

const props = defineProps<{ workspace: Workspace }>()

const projectId = computed(() => props.workspace.projectId)
const info = computed(() => state.docsInfo[projectId.value] ?? null)
const index = computed(() => state.docsIndex[projectId.value] ?? [])
const sets = computed(() => state.docsPending[projectId.value] ?? [])
const opened = computed(() => state.docsOpen[projectId.value] ?? null)
const page = computed(() => (opened.value ? index.value.find((p) => p.path === opened.value!.path) ?? null : null))

void refreshDocs(projectId.value)

/* ── the proposals band ─────────────────────────────────────────────────── */

const signals = computed(() => state.docsSignals[projectId.value] ?? { flags: [], offers: [] })
/** Drafts waiting on a decision, and offers waiting on a click. */
const waiting = computed(() => sets.value.length + signals.value.offers.filter((o) => o.state === 'open').length)

const reviewing = ref(waiting.value > 0)
// A set or an offer that arrives — `/document` was just typed, a Send just
// went — is what the tab is opened for; one that goes leaves nothing to look at.
watch(
  () => waiting.value,
  (n, was) => {
    if (n > (was ?? 0)) reviewing.value = true
    if (!n) reviewing.value = false
  },
)

/* ── the index ──────────────────────────────────────────────────────────── */

const query = ref('')
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return index.value
  return index.value.filter((p) =>
    [p.title, p.path, p.summary ?? '', ...p.aliases].some((s) => s.toLowerCase().includes(q)),
  )
})

const groups = computed(() => {
  const out = new Map<string, DocsPage[]>()
  for (const p of shown.value) {
    const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : ''
    out.set(dir, [...(out.get(dir) ?? []), p])
  }
  return [...out].map(([dir, pages]) => ({ dir, pages }))
})

const issuesText = (p: DocsPage) => p.issues.map((i) => i.text).join('\n')

/* ── flags ──────────────────────────────────────────────────────────────── */

/** What agents said about each page, by path; a missing page by the name it should have. */
const flagsOf = computed(() => {
  const out = new Map<string, DocsFlag[]>()
  for (const f of signals.value.flags) out.set(f.page, [...(out.get(f.page) ?? []), f])
  return out
})
const missing = computed(() => signals.value.flags.filter((f) => f.missing))
const flagText = (fs: DocsFlag[] | undefined) => (fs ?? []).map((f) => f.text).join('\n')

/* ── a page ─────────────────────────────────────────────────────────────── */

const text = ref<string | null>(null)
const reader = ref<HTMLElement | null>(null)

watch(
  opened,
  async (o) => {
    text.value = null
    if (!o) return
    const t = await docsPageText(projectId.value, o.path)
    if (opened.value?.path !== o.path) return
    text.value = t
    await nextTick()
    land(o.anchor)
  },
  { immediate: true },
)

function land(anchor: string | null): void {
  const el = reader.value
  if (!el) return
  const target = anchor ? el.querySelector<HTMLElement>('[data-anchor="' + CSS.escape(anchor) + '"]') : null
  if (target) target.scrollIntoView({ block: 'start' })
  else el.scrollTop = 0
}

function open(path: string | null, anchor: string | null = null): void {
  reviewing.value = false
  if (path && path === opened.value?.path) {
    state.docsOpen[projectId.value] = { path, anchor }
    land(anchor)
    return
  }
  openDocsPage(projectId.value, path, anchor)
}

function resolve(target: string): { path: string; title: string } | null {
  const from = opened.value?.path ?? ''
  const path = resolveLink(target, from, index.value)
  const hit = path ? index.value.find((p) => p.path === path) : null
  return hit ? { path: hit.path, title: hit.title } : null
}

const backlinks = computed(() => (page.value ? index.value.filter((p) => p.links.includes(page.value!.path)) : []))

const where = computed(() => {
  const i = info.value
  if (!i) return ''
  return i.repo ? i.repo + (i.folder ? '/' + i.folder : '') : i.path.split('/').slice(-2).join('/')
})
</script>

<template>
  <div class="docs">
    <header class="head">
      <button v-if="opened || reviewing" class="icon-btn back" title="Back to the index" @click="open(null)">
        <ArrowLeft />
      </button>
      <BookOpen v-else class="sm dim" />
      <span v-if="reviewing" class="where">Proposals</span>
      <span v-else-if="opened" class="where mono" :title="opened.path">{{ opened.path }}</span>
      <template v-else>
        <span class="where mono" :title="info?.path">{{ where }}</span>
        <label class="find">
          <Search class="sm dim" />
          <input v-model="query" class="input" type="text" spellcheck="false" placeholder="Find a page" />
        </label>
      </template>
      <span class="grow" />
      <button
        v-if="waiting && !reviewing"
        class="btn ghost band"
        title="Offers and drafts waiting on you"
        @click="reviewing = true"
      >
        <FilePen />{{ waiting }} to review
      </button>
    </header>

    <DocsProposals v-if="reviewing" :workspace="workspace" />

    <div v-else-if="opened" ref="reader" class="reader">
      <ul v-if="flagsOf.get(opened.path)?.length" class="flags">
        <li v-for="f in flagsOf.get(opened.path)" :key="f.id">
          <Flag class="sm" /><span class="ft">{{ f.text }}</span>
          <button class="icon-btn drop" title="Not out of date — drop this flag" @click="dropDocsFlag(projectId, f.id)"><X /></button>
        </li>
      </ul>
      <ul v-if="page?.issues.length" class="issues">
        <li v-for="(i, n) in page.issues" :key="n"><CircleAlert class="sm" />{{ i.text }}</li>
      </ul>
      <MarkdownPreview v-if="text !== null" :source="text" :resolve="resolve" @open="open" />
      <footer v-if="backlinks.length" class="around">
        <span class="lbl">Linked from</span>
        <button v-for="b in backlinks" :key="b.path" class="chip" :title="b.path" @click="open(b.path)">
          {{ b.title }}
        </button>
      </footer>
    </div>

    <div v-else class="index">
      <p v-if="!index.length" class="nothing">No pages yet.</p>
      <p v-else-if="!shown.length" class="nothing">No page matches.</p>
      <!-- Pages an agent looked for and did not find: the docs' own to-do. -->
      <section v-if="missing.length && !query" class="group">
        <h4 class="dir">Missing</h4>
        <div v-for="f in missing" :key="f.id" class="row static" :title="f.text">
          <span class="line">
            <Flag class="sm flagged" /><span class="title">{{ f.page }}</span>
            <button class="icon-btn drop" title="Not needed — drop this flag" @click="dropDocsFlag(projectId, f.id)"><X /></button>
          </span>
          <span class="sum">{{ f.text }}</span>
        </div>
      </section>
      <section v-for="g in groups" :key="g.dir" class="group">
        <h4 v-if="g.dir" class="dir mono">{{ g.dir }}/</h4>
        <button v-for="p in g.pages" :key="p.path" class="row" :title="p.path" @click="open(p.path)">
          <span class="line">
            <span class="title">{{ p.title }}</span>
            <span v-if="p.kind" class="kind">{{ p.kind }}</span>
            <Flag v-if="flagsOf.get(p.path)" class="sm flagged" :title="flagText(flagsOf.get(p.path))" />
            <span v-if="p.issues.length" class="dot" :title="issuesText(p)" />
          </span>
          <span v-if="p.summary" class="sum">{{ p.summary }}</span>
        </button>
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
  padding: 0 10px 0 16px;
  border-bottom: 1px solid var(--line);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.head .back { margin-left: -6px; }
.dim { color: var(--text-dim); }
.where { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grow { flex: 1; min-width: 0; }
.find { display: flex; align-items: center; gap: 6px; flex: 1 1 140px; min-width: 0; max-width: 260px; margin-left: 6px; }
.find .input { width: 100%; height: 26px; font-size: var(--fs-xs); }
.band { flex: none; color: var(--warn); }

.index { flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; padding: 10px 10px 40px; }
.nothing { margin: 40px 0 0; text-align: center; color: var(--text-dim); font-size: var(--fs-sm); }
.group + .group { margin-top: 14px; }
.dir {
  margin: 0 8px 4px;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-dim);
}
.row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  text-align: left;
}
.row:hover { background: var(--hover); }
.line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); color: var(--text); }
.kind { flex: none; font-size: var(--fs-xs); color: var(--text-dim); }
.dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--warn); }
.sum {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}

.reader { flex: 1; overflow-y: auto; }
.flagged { flex: none; color: var(--accent); }
.row.static { cursor: default; }
.row.static:hover { background: none; }
.drop { width: 20px; height: 20px; margin-left: auto; }
.flags {
  list-style: none;
  max-width: 780px;
  margin: 14px auto 0;
  padding: 0 32px;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--accent);
}
.flags li { display: flex; gap: 6px; align-items: flex-start; }
.flags .lucide { flex: none; margin-top: 2px; }
.flags .ft { min-width: 0; }
.issues {
  list-style: none;
  max-width: 780px;
  margin: 14px auto 0;
  padding: 0 32px;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--warn);
}
.issues li { display: flex; gap: 6px; align-items: flex-start; }
.issues li + li { margin-top: 2px; }
.issues .lucide { flex: none; margin-top: 2px; }
.around {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 780px;
  margin: -24px auto 0;
  padding: 0 32px 40px;
}
.around .lbl { font-size: var(--fs-xs); color: var(--text-dim); margin-right: 2px; }
.around .chip:hover { color: var(--text); background: var(--active); }
</style>
