<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowRight, Database, FileKey, GitBranch, Layers, Loader, TriangleAlert, X } from '@lucide/vue'
import { slugify } from '@cockpit/shared'
import type { DatabasePlan, SeedProposal } from '@cockpit/shared'
import { openTopic, previewDatabase, previewSeed, state } from '../core/store.js'

/**
 * §4 — opening a topic. One name, the repositories it spans, and the level
 * of setup; everything else is derived. What comes back is a plan (§3.7),
 * so this sheet never creates anything itself — it hands off to PlanDialog.
 */

const name = ref('')
const base = ref('')
const setup = ref<'branch' | 'isolated' | 'full'>('full')
const selected = ref<string[]>([])
const busy = ref(false)
const nameInput = ref<HTMLInputElement | null>(null)

/** Only main checkouts: a topic forks from them, it does not nest in one. */
const repos = computed(() =>
  state.workspaces.filter((w) => w.projectId === state.activeProjectId && w.kind === 'main' && w.repo),
)

/** The branch and folder name — the core's own function, not a copy of it.
 *  It is the branch, the folder, the hostname and the database name now. */
const slug = computed(() => slugify(name.value))

const taken = computed(() =>
  state.topics.some((f) => f.projectId === state.activeProjectId && f.slug === slug.value && f.state !== 'closed'),
)

const canOpen = computed(() => !!name.value.trim() && selected.value.length > 0 && !taken.value)

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
  if (!seedApplies.value || !name.value.trim() || !selected.value.length) {
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
    setup.value = repos.value.length > 1 ? 'full' : 'isolated'
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

function close() {
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
    ...(base.value.trim() ? { base: base.value.trim() } : {}),
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
            placeholder="Two-factor auth"
            @keydown.enter="submit"
          />
          <span class="hint">
            <GitBranch class="sm" />
            <code class="mono">{{ slug }}</code>
            <span v-if="taken" class="bad">— already in use by an open topic</span>
            <span v-else>— the branch created in every repository below</span>
          </span>
        </label>

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
            <button class="seg" :class="{ on: setup === 'full' }" @click="setup = 'full'">
              <strong>Separate + memory</strong><span>and a memory of its own</span>
            </button>
          </div>
          <span class="hint">
            You can always move up a level later; you never move down.
          </span>
        </div>

        <label class="field">
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
              {{ dbMissingTools.join(', ') }} not on PATH — Cockpit cannot copy a database
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
.hint code { color: var(--accent); }
.hint .bad { color: var(--danger); }

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
