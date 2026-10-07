<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowRight, ChevronDown, Cloud, Database, FileKey, FolderTree, GitBranch, Layers, Lock,
  TriangleAlert,
} from '@lucide/vue'
import { slugify } from '@cockpit/shared'
import type { BranchRef, DatabasePlan, SeedProposal, Workspace } from '@cockpit/shared'
import { client, openTopic, previewDatabase, previewSeed, state } from '../core/store.js'
import BaseSelect from './BaseSelect.vue'
import DialogShell from './DialogShell.vue'

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

/**
 * Said outright rather than left inside a list: whether the branch is made or
 * taken is the first thing this sheet has to know, and a row at the top of a
 * dropdown was the only place that asked.
 */
const mode = ref<'new' | 'existing'>('new')
/** The existing branch last chosen. Kept across a look at New and back. */
const picked = ref<string | null>(null)
/** The branch the topic opens on, when it is one that is already there. */
const onBranch = computed(() => (mode.value === 'existing' ? picked.value : null))
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

const pickedOption = computed(() => branchOptions.value.find((b) => b.name === onBranch.value) ?? null)
/** Somewhere the picked branch is missing, so the base still matters there. */
const pickedPartial = computed(
  () => !!onBranch.value && (pickedOption.value?.repos.length ?? 0) < selected.value.length,
)

/* ── the base: one for the topic, and one per repository when they differ ──
 *
 * "Fork from" was one text field for every repository, which is the right
 * default and the wrong ceiling: a front that works against `dev` beside a
 * back that works against `master` is the ordinary case, not the exotic one.
 * The field above the list sets it for all of them; a repository's own row
 * overrides it for that one.
 */

/** Base chosen for one repository, by workspace id. Absent follows the field. */
const repoBase = ref<Record<string, string>>({})

const shortOf = (b: BranchRef) => (b.remoteOnly ? b.name.replace(/^[^/]+\//, '') : b.name)

/**
 * The branches a repository can fork from. The plan fetches the base from
 * origin and branches off `origin/<base>`, so a branch that exists only here
 * is not one — offering it would be offering a step that fails.
 */
function basesIn(r: Workspace): string[] {
  const out = new Set<string>()
  for (const b of branchesByRepo.value[r.id] ?? []) {
    if (b.remoteOnly || b.upstream) out.add(shortOf(b))
  }
  return [...out]
}

/** Every base across the chosen repositories, saying whose when not all. */
const baseOptions = computed(() => {
  const chosen = repos.value.filter((r) => selected.value.includes(r.id))
  const by = new Map<string, string[]>()
  for (const r of chosen) {
    for (const n of basesIn(r)) by.set(n, [...(by.get(n) ?? []), r.name])
  }
  return [...by].map(([name, inRepos]) => ({
    name,
    ...(chosen.length > 1 && inRepos.length < chosen.length ? { note: inRepos.join(', ') } : {}),
  }))
})

/** What a repository's row resolves to when it has no choice of its own. */
function inheritedBase(r: Workspace): string {
  return base.value || r.git?.base || 'default branch'
}
function baseOf(r: Workspace): string {
  return repoBase.value[r.id] || inheritedBase(r)
}
/** A base named for this repository that its origin does not have. */
function baseProblem(r: Workspace): string {
  const named = repoBase.value[r.id] || base.value
  const known = basesIn(r)
  if (!named || !known.length || known.includes(named)) return ''
  return r.name + ' has no "' + named + '" on origin as far as this clone knows — pick another for it'
}
function setRepoBase(r: Workspace, v: string) {
  const next = { ...repoBase.value }
  if (v) next[r.id] = v
  else delete next[r.id]
  repoBase.value = next
}

/**
 * What opening the topic does *in this repository* — the answer to "whose
 * branch is this", given on the row of the repository being asked about
 * rather than as a count beside the branch.
 */
function repoPlan(r: Workspace): { text: string; tone: 'new' | 'has' | 'held' | 'idle'; title: string } {
  // Said once or not at all: an unticked row is its own explanation, and in a
  // sheet where every branch is new, "new, from" five times over is five
  // copies of the line above the list. The base alone ends the row.
  if (!selected.value.includes(r.id)) return { text: '', tone: 'idle', title: '' }
  if (mode.value === 'new') return { text: '', tone: 'new', title: '' }
  const want = onBranch.value
  if (!want) return { text: r.git?.branch ?? '—', tone: 'idle', title: 'On ' + (r.git?.branch ?? '—') + ' now' }
  const b = (branchesByRepo.value[r.id] ?? []).find((x) => shortOf(x) === want)
  if (!b) return { text: 'new, from', tone: 'new', title: want + ' is not in ' + r.name + ' — it is created there' }
  // Only here does the word earn its place: beside rows that say "already there".
  const held = b.checkedOutAt ?? (b.current && setup.value !== 'branch' ? r.path : null)
  if (held) {
    return {
      text: 'in use',
      tone: 'held',
      title: 'Already checked out at ' + held + ' — git allows a branch in one worktree at a time',
    }
  }
  return b.remoteOnly
    ? { text: 'on origin', tone: 'has', title: 'Fetched and tracked: ' + b.name }
    : { text: 'already there', tone: 'has', title: b.subject }
}

async function setMode(m: 'new' | 'existing') {
  mode.value = m
  branchOpen.value = false
  // Nothing chosen yet, so the list is the next thing wanted: open it rather
  // than leave an empty field and a second click.
  if (m === 'existing' && !picked.value) await toggleBranch()
}

async function toggleBranch() {
  branchOpen.value = !branchOpen.value
  if (!branchOpen.value) return
  branchQ.value = ''
  await nextTick()
  branchField.value?.focus()
}

function pickBranch(b: BranchOption) {
  if (b.heldAt) return
  picked.value = b.name
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
const slug = computed(() => (mode.value === 'existing' ? (picked.value ?? '') : slugify(name.value)))

const taken = computed(() =>
  state.topics.some((f) => f.projectId === state.activeProjectId && f.slug === slug.value && f.state !== 'closed'),
)

/** On an existing branch the name is optional: the branch's own will do. */
const ready = computed(() => (mode.value === 'existing' ? !!picked.value : !!name.value.trim()))
const canOpen = computed(() => ready.value && selected.value.length > 0 && !taken.value)

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

/**
 * Only the repositories with something to decide. One that carries nothing
 * used to get a heading and a sentence saying so, and in a project of five
 * that was most of the section: three paragraphs about nothing above the one
 * file that needed a look.
 */
const seedShown = computed(() => seed.value.filter((p) => p.files.length || p.skipped.length))

/** Debounced: this runs while the topic name is being typed. */
async function refreshSeed() {
  if (!seedApplies.value || !ready.value || !selected.value.length) {
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
    repoBase.value = {}
    mode.value = 'new'
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
  // Only where a base is used at all: a repository that already has the
  // branch forks nothing, and one left out of the topic is not asked.
  const forks = !onBranch.value || pickedPartial.value
  const bases = Object.fromEntries(
    Object.entries(repoBase.value).filter(([id, v]) => v && selected.value.includes(id)),
  )
  await openTopic({
    name: name.value.trim(),
    setup: setup.value,
    repoWorkspaceIds: selected.value,
    ...(onBranch.value ? { branch: onBranch.value } : {}),
    ...(forks && base.value ? { base: base.value } : {}),
    ...(forks && Object.keys(bases).length ? { bases } : {}),
    ...(approved.length ? { seed: approved, rememberSeed: remember.value } : {}),
    ...(seedApplies.value && cloneDb.value && dbClonable.value.length ? { cloneDatabase: true } : {}),
  })
  busy.value = false
}
</script>

<template>
  <DialogShell
    v-if="state.topicDialogOpen"
    title="Open a topic"
    :dismissible="!busy"
    :on-escape="close"
    @close="close"
  >
    <template #lead><Layers class="sm gi" /></template>

    <div class="form">
      <label class="field">
        <span class="lbl">Name <span v-if="mode === 'existing'" class="dim">optional</span></span>
        <input
          ref="nameInput"
          v-model="name"
          class="input"
          :placeholder="onBranch ?? 'Two-factor auth'"
          @keydown.enter="submit"
        />
      </label>

      <!-- §4 — made or taken, asked as the question it is. The base sits on
           the same line because it is the same sentence: this branch, from
           that one. -->
      <div class="field">
        <div class="lblrow">
          <span class="lbl">Branch</span>
          <div class="seg">
            <button :class="{ on: mode === 'new' }" @click="setMode('new')">New</button>
            <button :class="{ on: mode === 'existing' }" @click="setMode('existing')">Existing</button>
          </div>
        </div>

        <div class="row">
          <div v-if="mode === 'new'" class="bbox" :class="{ blank: !name.trim() }">
            <GitBranch class="sm" />
            <code class="mono bname">{{ name.trim() ? slug : 'named after the topic' }}</code>
          </div>

          <div v-else ref="branchRoot" class="bpick">
            <button class="bbox press" :class="{ on: branchOpen, blank: !picked }" @click="toggleBranch">
              <GitBranch class="sm" />
              <code class="mono bname">{{ picked ?? 'Choose a branch…' }}</code>
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
                <p v-if="branchLoading" class="bhint">Reading the branches…</p>
                <template v-else>
                  <button
                    v-for="b in branchMatches"
                    :key="b.name"
                    :class="{ sel: b.name === picked }"
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

          <template v-if="mode === 'new' || pickedPartial">
            <span class="from">from</span>
            <BaseSelect
              v-model="base"
              :options="baseOptions"
              :loading="branchLoading"
              fallback="default branch"
            />
          </template>
        </div>

        <!-- No sentence under a branch that is fine: the rows below already
             say, per repository, what becomes of it. -->
        <span v-if="taken" class="help bad">An open topic already holds this branch.</span>
      </div>

      <div class="field">
        <span class="lbl">Repositories</span>
        <div v-if="repos.length" class="list">
          <!-- A div, with the label inside it: a row that is one big label
               ticks its checkbox for a click anywhere in the base list. -->
          <div v-for="r in repos" :key="r.id" class="check lrow" :class="{ off: !selected.includes(r.id) }">
            <label class="rpick">
              <input v-model="selected" type="checkbox" :value="r.id" />
              <span class="rname">{{ r.name }}</span>
            </label>
            <span v-if="repoPlan(r).text" class="rplan" :class="repoPlan(r).tone" :title="repoPlan(r).title">
              <Lock v-if="repoPlan(r).tone === 'held'" />
              {{ repoPlan(r).text }}
            </span>
            <BaseSelect
              v-if="repoPlan(r).tone === 'new'"
              variant="word"
              :model-value="repoBase[r.id] ?? ''"
              :options="basesIn(r).map((name) => ({ name }))"
              :loading="branchLoading"
              :fallback="inheritedBase(r)"
              :problem="baseProblem(r)"
              @update:model-value="setRepoBase(r, $event)"
            />
          </div>
        </div>
        <span v-else class="help">No repository in this project.</span>
      </div>

      <div class="field">
        <span class="lbl">Setup</span>
        <div class="cards">
          <button class="card" :class="{ on: setup === 'branch' }" @click="setup = 'branch'">
            <GitBranch class="sm" />
            <strong>Here</strong>
            <span>In the repositories themselves</span>
          </button>
          <button class="card" :class="{ on: setup === 'isolated' }" @click="setup = 'isolated'">
            <FolderTree class="sm" />
            <strong>Separate</strong>
            <span>A folder of its own per repository</span>
          </button>
        </div>
      </div>

      <!-- §7 — git checks out tracked files only. Without this the worktree
           has no .env and will not boot; with it copied verbatim, three
           worktrees fight over one hostname and one database. -->
      <div v-if="seedApplies && seedShown.length" class="field">
        <span class="lbl">Local config <span class="dim">what git will not check out</span></span>

        <div class="list pad">
          <div v-for="p in seedShown" :key="p.repo" class="seedrepo">
            <div v-if="selected.length > 1" class="seedhead">
              <span class="rname">{{ p.repo }}</span>
              <span v-if="p.source === 'manifest'" class="src">declared in cockpit.yaml</span>
            </div>
            <!-- §8 — why this list is shorter than it used to be: the address
                 and the ports are not carried in a file any more, they are
                 resolved when something starts. -->
            <p v-if="p.wired" class="none">
              Its address and ports come from <code class="mono">cockpit.yaml</code> at start.
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
                  <span v-if="c.from" class="was mono">{{ c.from }}</span>
                  <ArrowRight class="sm ar" />
                  <span class="to mono">{{ c.to }}</span>
                </label>
                <!-- Why it changes is on the row's tooltip. Under every key it
                     doubled the height of a list whose point is the values. -->
              </div>
            </div>

            <p v-for="sk in p.skipped" :key="sk.path" class="none">
              <code class="mono">{{ sk.path }}</code> — {{ sk.reason }}
            </p>
          </div>
        </div>

        <label v-if="seedCount && seed.some((p) => p.source !== 'manifest')" class="check remember">
          <input v-model="remember" type="checkbox" />
          <span>Remember this in <code class="mono">cockpit.yaml</code></span>
        </label>
      </div>

      <!-- §10 — the third thing that is global. Ports and hostnames are
           already scoped per topic; the database is not, and folder
           isolation cannot fix it. -->
      <div v-if="seedApplies && dbs.length" class="field">
        <span class="lbl">Database <span class="dim">shared until it is not</span></span>

        <div class="list pad">
          <label v-if="dbClonable.length" class="check">
            <input v-model="cloneDb" type="checkbox" :disabled="dbMissingTools.length > 0" />
            <Database class="sm fi" />
            <span class="rname">Give each branch its own copy</span>
          </label>

          <div v-for="d in dbs" :key="d.repo" class="dbrow">
            <span class="dbrepo">{{ d.repo }}</span>
            <span class="dbengine">{{ d.engine }}</span>
            <template v-if="d.to">
              <code class="mono was">{{ d.from }}</code>
              <ArrowRight class="sm ar" />
              <code class="mono to">{{ d.to }}</code>
            </template>
            <span v-else class="why inline">{{ d.detail }}</span>
          </div>
        </div>

        <p v-if="dbMissingTools.length" class="warnline">
          <TriangleAlert class="sm" />
          <span>
            {{ dbMissingTools.join(', ') }} not found — Cockpit cannot copy a database
            without the client. The branch still gets its own name in
            <code class="mono">.env</code>; create the database yourself.
          </span>
        </p>
        <span v-else-if="cloneDb" class="help">
          A full copy: slow for a large database, and dropped for good with the topic.
        </span>
        <span v-else-if="dbClonable.length" class="help">
          Otherwise a migration run in one branch reaches the others.
        </span>
      </div>
    </div>

    <template #foot>
      <span class="grow" />
      <button class="btn ghost" :disabled="busy" @click="close">Cancel</button>
      <button class="btn primary" :disabled="!canOpen || busy" @click="submit">
        {{ busy ? 'Planning…' : 'Preview plan' }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
/* The chrome is DialogShell's. What is here is the form: the same uppercase
   label, 7px under it, 18px between fields, that Add a repository and the
   project sheet use — this one was written before they agreed on it. */
.gi { color: var(--text-dim); }
.grow { flex: 1; }

.form { display: flex; flex-direction: column; gap: 18px; padding-bottom: 14px; }
.field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.lbl {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.lbl .dim { margin-left: 4px; font-weight: 500; letter-spacing: 0; text-transform: none; opacity: 0.7; }
.lblrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 22px; }
.help { font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.55; }
.help code { color: var(--text-muted); }
.help.bad { color: var(--danger); }

.row { display: flex; align-items: center; gap: 8px; }

/* The branch, drawn as the field it sits among: the box of the name above it,
   so a name that is derived and a name that is chosen read as one kind of
   answer. Only the chosen one is pressable, and only it says so. */
.bpick { position: relative; flex: 1; min-width: 0; }
.bbox {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  font-size: var(--fs-sm);
  line-height: 1.55;
  text-align: left;
  transition:
    border-color var(--dur-1) var(--ease-soft),
    background var(--dur-1) var(--ease-soft);
}
/* Derived, not typed: no well to type into, so no sunken fill either. */
div.bbox { background: none; border-style: dashed; }
.bbox.press:hover { border-color: var(--line-strong); }
.bbox.press.on { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.bbox .lucide { flex: none; color: var(--text-dim); }
.bbox .ch { width: 12px; height: 12px; opacity: 0.6; }
.bname {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
}
.bbox.blank .bname { color: var(--text-dim); font-family: var(--font); }
.from { flex: none; font-size: var(--fs-xs); color: var(--text-dim); }

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
.rows > button.sel { color: var(--text); background: var(--hover); }
.nm { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The repository names give way before the branch does, but never to nothing. */
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
.bhint { margin: 0; padding: 10px 9px; font-size: var(--fs-xs); color: var(--text-dim); }

/* One bordered list, as On disk is in Add a repository: the rows are a set,
   and loose checkboxes on the card read as three unrelated settings. */
.list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
}
.list.pad { padding: 6px 12px 8px; }
.check {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 30px;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}
.lrow { padding: 0 12px; min-height: 34px; gap: 5px; }
.lrow + .lrow { border-top: 1px solid var(--line-soft); }
/* No `overflow: hidden` on the list — a row's base list has to leave it — so
   the hover fill rounds its own two ends instead. */
.lrow:first-child { border-radius: calc(var(--radius-sm) - 1px) calc(var(--radius-sm) - 1px) 0 0; }
.lrow:last-child { border-radius: 0 0 calc(var(--radius-sm) - 1px) calc(var(--radius-sm) - 1px); }
.lrow:only-child { border-radius: calc(var(--radius-sm) - 1px); }
.lrow:hover { background: var(--hover); }
.rpick { flex: 1; min-width: 0; display: flex; align-items: center; gap: 9px; align-self: stretch; }
.rname { flex: 1; min-width: 0; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lrow.off .rname { color: var(--text-dim); }
/* What happens here, in the repository's own row. Ink only where there is
   something to read: a branch that is already there, or one in the way. */
.rplan {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.rplan .lucide { width: 11px; height: 11px; flex: none; }
.rplan.has { color: var(--ok); }
.rplan.held { color: var(--warn); }
.rplan.idle { opacity: 0.7; }

/* The two setups, as the cards a new project's sources are. */
.cards { display: flex; gap: 8px; }
.card {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 10px 11px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  text-align: left;
  transition:
    border-color var(--dur-1) var(--ease-soft),
    background var(--dur-1) var(--ease-soft);
}
.card .lucide { color: var(--text-dim); margin-bottom: 2px; }
.card strong { font-size: var(--fs-sm); color: var(--text); font-weight: 620; }
.card > span { font-size: 10px; color: var(--text-dim); line-height: 1.4; }
.card:hover { border-color: var(--line-strong); background: var(--hover); }
.card.on,
.card.on:hover { border-color: var(--accent); background: var(--accent-soft); }
.card.on strong,
.card.on .lucide { color: var(--accent); }

.none { margin: 4px 0 0; font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.55; }

/* §7 — the seed section. Dense on purpose: it is a review, and a review that
   needs scrolling to see three keys is one nobody reads. */
.seedrepo + .seedrepo { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line-soft); }
.seedhead { display: flex; align-items: baseline; gap: 8px; margin: 4px 0; }
.seedhead .rname { flex: none; font-size: var(--fs-xs); font-weight: 600; }
.src { font-size: 10px; color: var(--ok); }

.seedfile + .seedfile { margin-top: 6px; }
.fi { color: var(--text-dim); flex: none; }
.fname { color: var(--text); font-size: var(--fs-xs); }
.bytes { font-size: 10px; color: var(--text-dim); }

.chg { margin: 0 0 2px 25px; }
.chg.off { opacity: 0.4; }
.check.sub { min-height: 22px; gap: 7px; }
.ckey { font-size: 10px; color: var(--text-muted); flex: none; }
.was {
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
.why { margin: 0 0 4px 23px; font-size: 10px; color: var(--text-dim); line-height: 1.45; }

.remember { min-height: 0; gap: 8px; font-size: var(--fs-xs); }

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
.dbrow .why.inline { flex: 1; min-width: 0; margin: 0; }
.dbrepo { color: var(--text); }
.dbengine {
  font-size: 10px;
  color: var(--text-dim);
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

.warnline {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-xs);
  line-height: 1.5;
}
.warnline .lucide { margin-top: 1px; flex: none; }

</style>
