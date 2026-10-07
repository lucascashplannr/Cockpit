<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowRight, ChevronDown, Cloud, Database, FileKey, GitBranch, Layers, Loader, Lock, Plus,
  TriangleAlert, X,
} from '@lucide/vue'
import { slugify } from '@cockpit/shared'
import type { BranchRef, DatabasePlan, SeedProposal } from '@cockpit/shared'
import { client, openTopic, previewDatabase, previewSeed, state } from '../core/store.js'

/**
 * §4 — opening a topic. One name, the repositories it spans, and the level
 * of setup; everything else is derived. What comes back is a plan (§3.7),
 * so this sheet never creates anything itself — it hands off to PlanDialog.
 */

const name = ref('')
const base = ref('')
const setup = ref<'branch' | 'isolated'>('isolated')
const selected = ref<string[]>([])
const busy = ref(false)
const nameInput = ref<HTMLInputElement | null>(null)

/** Only main checkouts: a topic forks from them, it does not nest in one. */
const repos = computed(() =>
  state.workspaces.filter((w) => w.projectId === state.activeProjectId && w.kind === 'main' && w.repo),
)

/* ── §4 — the branch: a new one, or one that is already there ─────────────
 *
 * A topic used to be able to *make* a branch and nothing else, so work begun
 * in the terminal, or a colleague's branch on origin, had no way into a folder
 * of its own short of `git worktree add` by hand. The picker lists what the
 * chosen repositories already have; taking one opens the topic on it, as it
 * stands, and only a repository that lacks it forks from the base.
 */

/** The existing branch the topic opens on; null is a new one named after it. */
const picked = ref<string | null>(null)
const branchOpen = ref(false)
const branchLoading = ref(false)
const branchQ = ref('')
const branchRoot = ref<HTMLElement | null>(null)
const branchField = ref<HTMLInputElement | null>(null)
const branchesByRepo = ref<Record<string, BranchRef[]>>({})

/** §3.4 — read when the sheet opens, never remembered between two of them. */
async function loadBranches() {
  branchLoading.value = true
  const out: Record<string, BranchRef[]> = {}
  await Promise.all(
    repos.value.map(async (r) => {
      try {
        out[r.id] = await client.call('git.branches', { workspaceId: r.id })
      } catch {
        // One unreadable repository must not cost the others their list.
        out[r.id] = []
      }
    }),
  )
  branchesByRepo.value = out
  branchLoading.value = false
}

interface BranchOption {
  name: string
  /** The chosen repositories that have it, here or on origin, by name. */
  repos: string[]
  /** On origin only, everywhere it is: taking it creates the tracking branch. */
  remoteOnly: boolean
  /** Where it is already checked out, when that would stop the plan. */
  heldAt: string | null
  ts: number
  subject: string
}

/**
 * One row per branch name across the chosen repositories — `origin/dev` and a
 * local `dev` are the same branch said twice, as in every other picker here.
 *
 * `heldAt` depends on the setup: a new folder cannot take a branch that is out
 * anywhere, the repository's own checkout included, while a switch in place
 * only minds the other folders.
 */
const branchOptions = computed<BranchOption[]>(() => {
  const by = new Map<string, BranchOption>()
  for (const r of repos.value) {
    if (!selected.value.includes(r.id)) continue
    for (const b of branchesByRepo.value[r.id] ?? []) {
      const short = b.remoteOnly ? b.name.replace(/^[^/]+\//, '') : b.name
      const held = b.checkedOutAt ?? (b.current && setup.value !== 'branch' ? r.path : null)
      const o = by.get(short)
      if (!o) {
        by.set(short, {
          name: short, repos: [r.name], remoteOnly: b.remoteOnly, heldAt: held, ts: b.ts, subject: b.subject,
        })
        continue
      }
      o.repos.push(r.name)
      o.remoteOnly &&= b.remoteOnly
      o.heldAt ??= held
      if (b.ts > o.ts) {
        o.ts = b.ts
        o.subject = b.subject
      }
    }
  }
  return [...by.values()].sort((a, b) => b.ts - a.ts)
})

const branchMatches = computed(() => {
  const t = branchQ.value.trim().toLowerCase()
  return t ? branchOptions.value.filter((b) => b.name.toLowerCase().includes(t)) : branchOptions.value
})

const pickedOption = computed(() => branchOptions.value.find((b) => b.name === picked.value) ?? null)
/** Somewhere the picked branch is missing, so the base still matters there. */
const pickedPartial = computed(
  () => !!picked.value && (pickedOption.value?.repos.length ?? 0) < selected.value.length,
)
/** The chosen repositories the picked branch is missing from, by name. */
const pickedMissing = computed(() => {
  const has = new Set(pickedOption.value?.repos ?? [])
  return repos.value.filter((r) => selected.value.includes(r.id) && !has.has(r.name)).map((r) => r.name)
})

async function toggleBranch() {
  branchOpen.value = !branchOpen.value
  if (!branchOpen.value) return
  branchQ.value = ''
  await nextTick()
  branchField.value?.focus()
}

function pickBranch(b: BranchOption | null) {
  if (b?.heldAt) return
  picked.value = b?.name ?? null
  branchOpen.value = false
}

function branchTitle(b: BranchOption): string {
  if (b.heldAt) {
    return 'Already checked out at ' + b.heldAt + ' — git allows a branch in one worktree at a time'
  }
  return b.name + ' — in ' + b.repos.join(', ') + (b.subject ? ' — ' + b.subject : '')
}

/**
 * Which repositories, by name. A count answered "how many" to someone asking
 * "whose branch is this" — with five repositories, `1 of 5` names none of them.
 */
function branchNote(b: BranchOption): string {
  if (b.heldAt) return 'in use'
  if (selected.value.length < 2) return ''
  return b.repos.length === selected.value.length ? 'all' : b.repos.join(', ')
}

function onDown(e: MouseEvent) {
  if (branchRoot.value && !branchRoot.value.contains(e.target as Node)) branchOpen.value = false
}
onMounted(() => document.addEventListener('mousedown', onDown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDown))

/** The branch and folder name — the core's own function, not a copy of it.
 *  It is the branch, the folder, the hostname and the database name now.
 *  An existing branch is taken as it is named: the topic is found by it. */
const slug = computed(() => picked.value ?? slugify(name.value))

const taken = computed(() =>
  state.topics.some((f) => f.projectId === state.activeProjectId && f.slug === slug.value && f.state !== 'closed'),
)

/** On an existing branch the name is optional: the branch's own will do. */
const canOpen = computed(
  () => (!!name.value.trim() || !!picked.value) && selected.value.length > 0 && !taken.value,
)

/* ── §7 — the local config a worktree cannot check out ───────────────────
 *
 * `git worktree add` gives tracked files only, so everything git ignores —
 * `.env`, `auth.json` — is absent and the worktree will not boot. Cockpit
 * detects what to carry and what in it is per-worktree; this section is where
 * that proposal is approved, because a detection nobody has seen must not
 * write into anyone's `.env` (§5). Approve once and it goes into cockpit.yaml.
 */

const seed = ref<SeedProposal[]>([])
const seedLoading = ref(false)
const remember = ref(true)
/** Keys of the form `repo/path` and `repo/path#KEY`, both opted out by hand. */
const dropped = ref(new Set<string>())
let seedToken = 0

const fileKey = (repo: string, path: string) => repo + '/' + path
const changeKey = (repo: string, path: string, key: string) => repo + '/' + path + '#' + key

function toggle(k: string) {
  const next = new Set(dropped.value)
  if (next.has(k)) next.delete(k)
  else next.add(k)
  dropped.value = next
}

/** C1 branches in place, so there is no new checkout to carry anything into. */
const seedApplies = computed(() => setup.value !== 'branch')

const seedCount = computed(() =>
  seed.value.reduce(
    (n, p) => n + p.files.filter((f) => !dropped.value.has(fileKey(p.repo, f.path))).length,
    0,
  ),
)

/** Debounced: this runs while the topic name is being typed. */
async function refreshSeed() {
  if (!seedApplies.value || !(name.value.trim() || picked.value) || !selected.value.length) {
    seed.value = []
    return
  }
  const token = ++seedToken
  seedLoading.value = true
  const [files, databases] = await Promise.all([
    previewSeed(slug.value, selected.value),
    previewDatabase(slug.value, selected.value),
  ])
  // A slower earlier request must not overwrite a newer answer.
  if (token !== seedToken) return
  seed.value = files
  dbs.value = databases
  seedLoading.value = false
}

let debounce: ReturnType<typeof setTimeout> | null = null
watch([slug, selected, setup], () => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => void refreshSeed(), 250)
})

/* ── §10 — one database per worktree ─────────────────────────────────────
 *
 * The third global thing, after the port and the hostname. Folder isolation
 * cannot help: two worktrees pointing at one database means a migration run by
 * an agent in one breaks the other. Off by default, because copying a whole
 * database is slow and costs the disk again — the honest trade, stated rather
 * than decided for the user.
 */

const dbs = ref<DatabasePlan[]>([])
const cloneDb = ref(false)

/** sqlite needs nothing: its database is a file the worktree seed carries. */
const dbClonable = computed(() => dbs.value.filter((d) => d.engine !== 'sqlite' && d.to))
const dbMissingTools = computed(() => [
  ...new Set(dbClonable.value.flatMap((d) => d.missingTools)),
])

/** The proposal minus everything switched off — what the core is handed. */
function approvedSeed(): SeedProposal[] {
  return seed.value
    .map((p) => ({
      ...p,
      files: p.files
        .filter((f) => !dropped.value.has(fileKey(p.repo, f.path)))
        .map((f) => ({
          ...f,
          changes: f.changes.filter((c) => !dropped.value.has(changeKey(p.repo, f.path, c.key))),
        })),
    }))
    .filter((p) => p.files.length)
}

watch(
  () => state.topicDialogOpen,
  (open) => {
    if (!open) return
    name.value = ''
    base.value = ''
    picked.value = null
    branchOpen.value = false
    branchesByRepo.value = {}
    void loadBranches()
    setup.value = 'isolated'
    selected.value = repos.value.map((r) => r.id)
    busy.value = false
    seed.value = []
    dbs.value = []
    cloneDb.value = false
    dropped.value = new Set()
    remember.value = true
    void nextTick(() => nameInput.value?.focus())
  },
)

/** Innermost layer first: esc closes the branch list before it closes the sheet. */
function close() {
  if (branchOpen.value) {
    branchOpen.value = false
    return
  }
  if (!busy.value) state.topicDialogOpen = false
}

async function submit() {
  if (!canOpen.value || busy.value) return
  busy.value = true
  const approved = seedApplies.value ? approvedSeed() : []
  await openTopic({
    name: name.value.trim(),
    setup: setup.value,
    repoWorkspaceIds: selected.value,
    ...(picked.value ? { branch: picked.value } : {}),
    ...(base.value.trim() && (!picked.value || pickedPartial.value) ? { base: base.value.trim() } : {}),
    ...(approved.length ? { seed: approved, rememberSeed: remember.value } : {}),
    ...(seedApplies.value && cloneDb.value && dbClonable.value.length ? { cloneDatabase: true } : {}),
  })
  busy.value = false
}
</script>

<template>
  <div v-if="state.topicDialogOpen" class="scrim" @mousedown.self="close" @keydown.esc="close">
    <div class="dlg" role="dialog" aria-label="Open a topic">
      <header class="head">
        <Layers class="sm gi" />
        <h2>Open a topic</h2>
        <span class="grow" />
        <button class="icon-btn" title="Close (esc)" @click="close"><X class="sm" /></button>
      </header>

      <div class="body">
        <label class="field">
          <span class="lbl">Name</span>
          <input
            ref="nameInput"
            v-model="name"
            class="input"
            :placeholder="picked ?? 'Two-factor auth'"
            @keydown.enter="submit"
          />
        </label>

        <div class="field">
          <span class="lbl">Branch</span>
          <div ref="branchRoot" class="bpick">
            <button class="input bbtn" :class="{ on: branchOpen }" @click="toggleBranch">
              <GitBranch class="sm" />
              <code class="mono bname">{{ slug }}</code>
              <span class="bkind">{{ picked ? 'existing' : 'new' }}</span>
              <ChevronDown class="ch" />
            </button>

            <div v-if="branchOpen" class="menu bmenu">
              <input
                ref="branchField"
                v-model="branchQ"
                class="find"
                type="text"
                spellcheck="false"
                autocomplete="off"
                placeholder="Find a branch…"
              >
              <div class="rows">
                <button class="mk" @click="pickBranch(null)">
                  <Plus />
                  <span class="nm">New branch, named after the topic</span>
                </button>
                <span class="rule" />
                <p v-if="branchLoading" class="bhint">Reading the branches…</p>
                <template v-else>
                  <button
                    v-for="b in branchMatches"
                    :key="b.name"
                    :disabled="!!b.heldAt"
                    :title="branchTitle(b)"
                    @click="pickBranch(b)"
                  >
                    <component :is="b.heldAt ? Lock : b.remoteOnly ? Cloud : GitBranch" />
                    <span class="nm">{{ b.name }}</span>
                    <span v-if="branchNote(b)" class="bnote">{{ branchNote(b) }}</span>
                  </button>
                  <p v-if="!branchMatches.length" class="bhint">
                    {{ branchQ.trim() ? 'Nothing matches.' : 'No branch in the chosen repositories.' }}
                  </p>
                </template>
              </div>
            </div>
          </div>
          <span class="hint">
            <span v-if="taken" class="bad">Already in use by an open topic.</span>
            <span v-else-if="!picked">Created in every repository below.</span>
            <span v-else-if="pickedPartial">
              <template v-if="pickedOption">Opened as it stands in {{ pickedOption.repos.join(', ') }}; created</template>
              <template v-else>Created</template>
              from the base in {{ pickedMissing.join(', ') }}.
            </span>
            <span v-else>Opened as it stands; nothing is forked.</span>
          </span>
        </div>

        <div class="field">
          <span class="lbl">Repositories</span>
          <label v-for="r in repos" :key="r.id" class="check">
            <input v-model="selected" type="checkbox" :value="r.id" />
            <span class="rname">{{ r.name }}</span>
            <span class="rbranch mono">{{ r.git?.branch ?? '—' }}</span>
          </label>
          <p v-if="!repos.length" class="none">No repository in this project.</p>
          <p v-else-if="selected.length > 1" class="note">
            A <code class="mono">CONTEXT.md</code> will be created at the topic root. Fill it in
            before letting an agent span more than one of these.
          </p>
        </div>

        <div class="field">
          <span class="lbl">Setup</span>
          <div class="segs">
            <button class="seg" :class="{ on: setup === 'branch' }" @click="setup = 'branch'">
              <strong>Here</strong><span>a branch in each repository</span>
            </button>
            <button class="seg" :class="{ on: setup === 'isolated' }" @click="setup = 'isolated'">
              <strong>Separate</strong><span>each branch in its own folder</span>
            </button>
          </div>
          <span class="hint">
            You can always move up a level later; you never move down.
          </span>
        </div>

        <label v-if="!picked || pickedPartial" class="field">
          <span class="lbl">Fork from <span class="opt">optional</span></span>
          <input v-model="base" class="input" placeholder="each repository's default branch" />
        </label>

        <!-- §7 — git checks out tracked files only. Without this the worktree
             has no .env and will not boot; with it copied verbatim, three
             worktrees fight over one hostname and one database. -->
        <div v-if="seedApplies && (seed.length || seedLoading)" class="field">
          <span class="lbl">
            Local config
            <span class="opt">— what git will not check out</span>
          </span>

          <p v-if="seedLoading && !seed.length" class="none">
            <Loader class="sm spin" /> looking…
          </p>

          <div v-for="p in seed" :key="p.repo" class="seedrepo">
            <div v-if="seed.length > 1" class="seedhead">
              <span class="rname">{{ p.repo }}</span>
              <span v-if="p.source === 'manifest'" class="src">declared in cockpit.yaml</span>
            </div>
            <!-- §8 — why this list is shorter than it used to be: the address
                 and the ports are not carried in a file any more, they are
                 resolved when something starts. -->
            <p v-if="p.wired" class="none">
              Its address and ports come from <code class="mono">cockpit.yaml</code> at start.
            </p>
            <p v-if="!p.files.length" class="none">
              Nothing to carry — this branch checks out everything it needs.
            </p>

            <div v-for="f in p.files" :key="f.path" class="seedfile">
              <label class="check">
                <input
                  type="checkbox"
                  :checked="!dropped.has(fileKey(p.repo, f.path))"
                  @change="toggle(fileKey(p.repo, f.path))"
                />
                <FileKey class="sm fi" />
                <code class="mono fname">{{ f.path }}</code>
                <span class="grow" />
                <span class="bytes num">{{ f.bytes }} B</span>
              </label>

              <div
                v-for="c in f.changes"
                :key="c.key"
                class="chg"
                :class="{ off: dropped.has(fileKey(p.repo, f.path)) }"
              >
                <label class="check sub" :title="c.reason">
                  <input
                    type="checkbox"
                    :disabled="dropped.has(fileKey(p.repo, f.path))"
                    :checked="!dropped.has(changeKey(p.repo, f.path, c.key))"
                    @change="toggle(changeKey(p.repo, f.path, c.key))"
                  />
                  <code class="mono ckey">{{ c.key }}</code>
                  <span v-if="c.from" class="from mono">{{ c.from }}</span>
                  <ArrowRight class="sm ar" />
                  <span class="to mono">{{ c.to }}</span>
                </label>
                <!-- The repo header already says "declared in cockpit.yaml"; repeating
                     it under every key is noise where the reason should be. -->
                <p v-if="c.reason !== 'declared in cockpit.yaml'" class="why">{{ c.reason }}</p>
              </div>
            </div>

            <p v-for="sk in p.skipped" :key="sk.path" class="none">
              <code class="mono">{{ sk.path }}</code> — {{ sk.reason }}
            </p>
          </div>

          <label v-if="seedCount && seed.some((p) => p.source !== 'manifest')" class="check remember">
            <input v-model="remember" type="checkbox" />
            <span>Remember this in <code class="mono">cockpit.yaml</code></span>
            <span class="opt">— the next topic carries it without asking</span>
          </label>
        </div>

        <!-- §10 — the third thing that is global. Ports and hostnames are
             already scoped per topic; the database is not, and folder
             isolation cannot fix it. -->
        <div v-if="seedApplies && dbs.length" class="field">
          <span class="lbl">Database <span class="opt">— shared until it is not</span></span>

          <label v-if="dbClonable.length" class="check remember">
            <input v-model="cloneDb" type="checkbox" :disabled="dbMissingTools.length > 0" />
            <Database class="sm fi" />
            <span>Give each branch its own copy</span>
          </label>

          <div v-for="d in dbs" :key="d.repo" class="dbrow">
            <span class="dbrepo">{{ d.repo }}</span>
            <span class="dbengine">{{ d.engine }}</span>
            <template v-if="d.to">
              <code class="mono from">{{ d.from }}</code>
              <ArrowRight class="sm ar" />
              <code class="mono to">{{ d.to }}</code>
            </template>
            <span v-else class="why inline">{{ d.detail }}</span>
          </div>

          <p v-if="dbMissingTools.length" class="warnline">
            <TriangleAlert class="sm" />
            <span>
              {{ dbMissingTools.join(', ') }} not found — Cockpit cannot copy a database
              without the client. The branch still gets its own name in
              <code class="mono">.env</code>; create the database yourself.
            </span>
          </p>
          <p v-else-if="cloneDb" class="why">
            A full copy per branch: slow for a large database, and the same disk again.
            Dropping them is part of deleting the topic — and unlike the folder, a database
            has no Trash.
          </p>
          <p v-else-if="dbClonable.length" class="why">
            Without this every branch points at
            <code class="mono">{{ dbClonable[0]!.from }}</code>, so a migration run in one
            reaches the others.
          </p>
        </div>
      </div>

      <footer class="foot">
        <span class="rp">
          Nothing is created until you approve the plan.
          <template v-if="seedApplies && seedCount">
            {{ seedCount }} local file(s) carried in after it.
          </template>
        </span>
        <span class="grow" />
        <button class="btn ghost" @click="close">Cancel</button>
        <button class="btn primary" :disabled="!canOpen || busy" @click="submit">
          {{ busy ? 'Planning…' : 'Preview plan' }}
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
}
.dlg {
  width: min(560px, 92vw);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  background: var(--overlay);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg), var(--inset-top);
  overflow: hidden;
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

.body { flex: 1; overflow-y: auto; padding: 18px 20px 6px; }
.field { display: block; margin-bottom: 18px; }
.lbl {
  display: block;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  margin-bottom: 6px;
}
.opt { color: var(--text-dim); }
.hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.hint .bad { color: var(--danger); }

/* The branch, drawn as the field it sits among: same box as the name above it,
   so choosing one reads as filling in the sheet rather than opening a menu. */
.bpick { position: relative; }
.bbtn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
}
.bbtn .lucide { flex: none; color: var(--text-dim); }
.bbtn .ch { width: 12px; height: 12px; opacity: 0.6; }
.bname {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
}
.bkind { flex: none; font-size: 10px; color: var(--text-dim); }

.bmenu {
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 280px;
  padding: 6px;
}
.find {
  flex: none;
  height: 30px;
  margin-bottom: 5px;
  padding: 0 9px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  font-size: var(--fs-sm);
  font-family: var(--font);
}
.find:focus { outline: none; border-color: var(--focus-ring); }
.find::placeholder { color: var(--text-dim); }
/* Same list as the branch chip's: rows that keep their height whatever their
   number, and a name that gives way before the row grows sideways. */
.rows { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.rows > button { flex: none; width: 100%; min-width: 0; height: 26px; }
.rows > button:disabled { opacity: 0.45; cursor: default; }
.nm { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Its own class: `.note` is already the paragraph under Repositories, and its
   top margin dropped this a few pixels below the name it sits beside. The
   repository names give way before the branch does, but never to nothing. */
.bnote {
  flex: 0 1 auto;
  min-width: 48px;
  max-width: 50%;
  margin-left: auto;
  padding-left: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-dim);
}
.mk .nm { color: var(--accent); }
.bhint { margin: 0; padding: 10px 9px; font-size: var(--fs-xs); color: var(--text-dim); }

.check {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}
.check input { accent-color: var(--accent); }
.rname { flex: 1; color: var(--text); }
.rbranch { font-size: var(--fs-xs); color: var(--text-dim); }
.none, .note { margin: 6px 0 0; font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.55; }

/* §7 — the seed section. Dense on purpose: it is a review, and a review that
   needs scrolling to see three keys is one nobody reads. */
.seedrepo + .seedrepo { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line-soft); }
.seedhead { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.seedhead .rname { font-size: var(--fs-xs); color: var(--text); font-weight: 600; }
.src { font-size: 10px; color: var(--ok); }

.seedfile + .seedfile { margin-top: 6px; }
.fi { color: var(--text-dim); flex: none; }
.fname { color: var(--text); font-size: var(--fs-xs); }
.bytes { font-size: 10px; color: var(--text-dim); }

.chg { margin: 0 0 2px 22px; }
.chg.off { opacity: 0.4; }
.check.sub { height: 22px; gap: 7px; }
.ckey { font-size: 10px; color: var(--text-muted); flex: none; }
.from {
  font-size: 10px;
  color: var(--text-dim);
  text-decoration: line-through;
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ar { color: var(--text-dim); flex: none; width: 11px; height: 11px; }
.to {
  font-size: 10px;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.why { margin: 0 0 4px 21px; font-size: 10px; color: var(--text-dim); line-height: 1.45; }

.remember { height: auto; margin-top: 10px; gap: 8px; font-size: var(--fs-xs); }
.remember .opt { color: var(--text-dim); }

.dbrow {
  display: flex;
  /* baseline, not center: the detail on an undeclared engine wraps to two
     lines, and a fixed height made it spill over the row below. */
  align-items: baseline;
  gap: 8px;
  min-height: 24px;
  padding: 2px 0;
  font-size: var(--fs-xs);
}
.dbrow .why.inline { flex: 1; min-width: 0; }
.dbrepo { color: var(--text); }
.dbengine {
  font-size: 10px;
  color: var(--text-dim);
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.dbrow .from, .dbrow .to { font-size: 10px; }
.why.inline { margin: 0; }

.warnline {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-xs);
  line-height: 1.5;
}
.warnline .lucide { margin-top: 1px; flex: none; }

.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.segs { display: flex; gap: 6px; }
.seg {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  text-align: left;
}
.seg strong { font-size: var(--fs-sm); color: var(--text); font-weight: 620; }
.seg span { font-size: 10px; color: var(--text-dim); }
.seg.on { border-color: var(--accent); background: var(--accent-soft); }
.seg.on strong { color: var(--accent); }

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
.rp { font-size: var(--fs-xs); color: var(--text-muted); }
</style>
