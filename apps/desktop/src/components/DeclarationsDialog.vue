<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { ArrowLeft, FolderOpen, Pencil, Plus, Server, SlidersHorizontal, Terminal, Trash2, X } from '@lucide/vue'
import DialogShell from './DialogShell.vue'
import type { Declaration } from '@cockpit/shared'
import { askDeleteDeclaration, loadDeclarations, saveDeclaration, state } from '../core/store.js'

/**
 * §8 — where servers and commands are written, without opening the file.
 *
 * Scope first, and scope is the whole idea: a declaration belongs to a
 * repository or to the project, and the two mean different folders. A
 * repository's runs in its checkout — in a topic, in *that topic's* worktree.
 * The project's runs in the folder holding the repositories, which inside a
 * topic is the topic's own folder. Nothing here is ever scoped to a topic:
 * a topic is where a declaration runs, never where it is written (§4).
 *
 * The list is the front door and the form is one click in, rather than both at
 * once. A sheet with a list down one side and eleven fields down the other is
 * how a five-minute file (§11) starts looking like a settings screen.
 */

/**
 * The placeholder names, as data.
 *
 * Written in the template they would be read as interpolations — `{{ '{{port' }}`
 * is where Vue stops, because the first `}}` closes the mustache and the
 * string is left unterminated. So the one place that must *show* a
 * placeholder passes it as a value instead.
 */
const T = { port: '{' + '{port}' + '}', api: '{' + '{api.url}' + '}', name: '{' + '{name}' + '}' }

const d = computed(() => state.declarations)
/**
 * The scope this sheet opens on.
 *
 * Read at setup rather than in a watcher: App.vue mounts this component with
 * `v-if`, so it is created *after* `declareOpen` flipped and a watcher on that
 * flag never sees the change that brought it here.
 */
const scope = ref(state.declareLock ?? '')
/**
 * The half this sheet was opened on, read at setup for the same reason the
 * scope is: the component is mounted by `v-if` after the flag flipped.
 *
 * Null is both, which is what the general ways in still ask for.
 */
const section = ref(state.declareSection)
const shows = (kind: Declaration['kind']) => !section.value || section.value === kind
const editing = ref<Declaration | null>(null)
const previousName = ref<string | undefined>(undefined)
const busy = ref(false)
const nameField = ref<HTMLInputElement | null>(null)

const scopes = computed(() => d.value?.scopes ?? [])

/**
 * Locked to what the click meant, or free when nothing meant anything.
 *
 * `''` is a scope — the project — so this is a null check, never a falsy one.
 */
const locked = computed(() => state.declareLock !== null)
const scopeLabel = computed(
  () => scopes.value.find((x) => x.repo === scope.value)?.label ?? scope.value,
)
/** What the sheet is of: one half names itself, both keep the old title. */
const heading = computed(() =>
  section.value === 'server' ? 'Servers' : section.value === 'command' ? 'Commands' : 'Servers and commands',
)
const title = computed(() => {
  if (editing.value) return previousName.value ?? 'New ' + editing.value.kind
  return locked.value ? heading.value + ' · ' + scopeLabel.value : heading.value
})
const inScope = (kind: Declaration['kind']) =>
  (d.value?.declarations ?? []).filter((x) => x.kind === kind && x.repo === scope.value)

const servers = computed(() => inScope('server'))
const commands = computed(() => inScope('command'))

/** Everything a `runs:` list may name — the project's whole vocabulary. */
const runnable = computed(() =>
  (d.value?.declarations ?? [])
    .filter((x) => x.name !== editing.value?.name)
    .map((x) => ({ name: x.name, kind: x.kind, repo: x.repo })),
)

const folderOf = computed(() => scopes.value.find((s) => s.repo === scope.value)?.path ?? '')

/**
 * The last two segments, with the whole of it on hover.
 *
 * The full path is the honest answer and a terrible label: two wrapped lines
 * of `/Users/…/Developpement/…` above a four-line list makes the folder the
 * loudest thing in a sheet that is about what runs in it. The tail is what
 * anyone actually reads to tell one folder from another.
 */
const folderShort = computed(() => {
  const parts = folderOf.value.split('/').filter(Boolean)
  return (parts.length > 2 ? '…/' : '/') + parts.slice(-2).join('/')
})

/**
 * What a row says about itself under its name.
 *
 * One line, and the truest one available: a `runs:` list is what that command
 * does, and printing the (absent) `cmd` for it said nothing at all.
 */
function lineOf(x: Declaration): string {
  return x.runs.length ? x.runs.join(' → ') : x.cmd
}

/** Only the surprising half is worth a chip; the default is silence. */
function tagOf(x: Declaration): string {
  if (x.kind === 'server') return x.inStart ? '' : 'not on Start'
  if (x.ask.length) return 'asks ' + x.ask.length
  return x.confirm ? 'confirms' : ''
}

function blank(kind: Declaration['kind']): Declaration {
  return {
    kind,
    name: '',
    repo: scope.value,
    cmd: '',
    url: kind === 'server' ? 'http://localhost:{{port}}' : '',
    health: '',
    env: [],
    ask: [],
    runs: [],
    confirm: '',
    inStart: kind === 'server',
  }
}

async function edit(decl: Declaration | null, kind: Declaration['kind'] = 'command'): Promise<void> {
  // A copy, always: binding the list's own object would write every keystroke
  // into the row behind the form, including the ones that are cancelled.
  editing.value = decl ? JSON.parse(JSON.stringify(decl)) as Declaration : blank(kind)
  previousName.value = decl?.name
  await nextTick()
  nameField.value?.focus()
}

function back(): void {
  editing.value = null
  previousName.value = undefined
}

function close(): void {
  state.declareOpen = false
  state.declareSection = null
  back()
}

const valid = computed(() => {
  const e = editing.value
  if (!e) return false
  return !!e.name.trim() && (!!e.cmd.trim() || e.runs.length > 0)
})

async function save(): Promise<void> {
  const e = editing.value
  if (!e || !valid.value || busy.value) return
  busy.value = true
  const ok = await saveDeclaration(e, previousName.value)
  busy.value = false
  if (ok) back()
}

/**
 * The question is `ConfirmDialog`'s, the same one the rest of the window asks.
 *
 * Deleting from the form closes the form first: the sheet behind the question
 * should be the list, so that answering yes leaves you looking at what is
 * left rather than at a form for something that no longer exists.
 */
function remove(decl: Declaration): void {
  back()
  askDeleteDeclaration(decl)
}

function toggleRun(name: string): void {
  const e = editing.value
  if (!e) return
  const at = e.runs.indexOf(name)
  if (at >= 0) e.runs.splice(at, 1)
  else e.runs.push(name)
}

function addPair(list: 'env' | 'ask'): void {
  const e = editing.value
  if (!e) return
  if (list === 'env') e.env.push({ key: '', value: '' })
  else e.ask.push({ key: '', label: '' })
}

onMounted(() => {
  back()
  void loadDeclarations()
})
</script>

<template>
  <DialogShell
    v-if="state.declareOpen"
    :title="title"
    @close="close"
  >
    <template #lead>
      <button v-if="editing" class="icon-btn" title="Back to the list" @click="back">
        <ArrowLeft class="sm" />
      </button>
    </template>

    <!-- Composed rather than concatenated.
         `Servers · Init` put two different kinds of thing — what this sheet
         is, and what it is scoped to — in one weight, one colour and one size,
         joined by a dot that had to carry the whole distinction. They are the
         same two facts the bar at the top of the window shows, so they are
         drawn the way the bar draws them: the thing, and then a chip for the
         scope it belongs to. In the form the title is a name, and a name is
         a string. -->
    <template v-if="!editing" #title>
      <!-- The kind, when the sheet is of one kind. Showing both, it is neither
           — so it takes the icon the menus use for the sheet itself. -->
      <component
        :is="section === 'server' ? Server : section === 'command' ? Terminal : SlidersHorizontal"
        class="sm ti"
      />
      <span class="tn">{{ heading }}</span>
      <span v-if="locked" class="chip ts">
        <!-- Kind first, then the name — the order the bar at the top of the
             window puts them in, and the order you read them in: `Project`
             says which of the two kinds of scope this is, `Init` says which
             one. A repository needs no kicker; it is the ordinary case, and
             the sheet's icon has already said what kind of sheet this is. -->
        <template v-if="!scope"><span class="dim">Project</span><span class="sep" aria-hidden="true" /></template>{{ scope || scopeLabel }}
      </span>
    </template>

<!-- ── the list ────────────────────────────────────────────────── -->
      <div v-if="!editing" class="list">
        <!-- Scope is chosen before anything else because it decides the
             folder, and the folder is the part that surprises people — unless
             the way in already chose it, and then showing the choice again is
             offering to undo the click that got you here. -->
        <div v-if="!locked" class="scopes">
          <button
            v-for="s in scopes"
            :key="s.repo"
            class="chip"
            :class="{ on: s.repo === scope }"
            @click="scope = s.repo"
          >
            <template v-if="!s.repo"><span class="dim">Project</span><span class="sep" aria-hidden="true" /></template>{{ s.repo || s.label }}
          </button>
        </div>

        <!-- Where all of this runs, said once, quietly, and labelled.
             It was a bare `…/Init/Init` at the top of the sheet — the loudest
             thing above the list and an answer to a question nobody could
             tell it was answering. -->
        <p class="where" :title="folderOf">
          <FolderOpen class="sm" />
          <span class="wl">Runs in</span>
          <code class="mono">{{ folderShort }}</code>
        </p>

        <!-- One section per half. The heading is dropped when the sheet is
             *of* that half — the title already says `Servers`, and repeating
             it two lines lower is a label on a list of one thing. -->
        <section v-if="shows('server')">
          <h3 v-if="!section" class="section-label"><Server class="sm" /> Servers</h3>
          <!-- One card per declaration, and the row itself is not a target:
               editing and deleting are both buttons, so there is no part of
               this that does something without saying which thing. -->
          <div v-if="servers.length" class="rows">
            <div v-for="x in servers" :key="x.name" class="row">
              <span class="nm">{{ x.name }}</span>
              <code class="mono line">{{ lineOf(x) }}</code>
              <span v-if="tagOf(x)" class="chip">{{ tagOf(x) }}</span>
              <span class="acts">
                <button class="icon-btn" :title="'Edit ' + x.name" @click="edit(x)">
                  <Pencil class="sm" />
                </button>
                <button class="icon-btn del" :title="'Delete ' + x.name" @click="remove(x)">
                  <Trash2 class="sm" />
                </button>
              </span>
            </div>
          </div>
          <p v-else class="none">Nothing declared here yet. A server is something that stays up.</p>
          <button class="btn ghost addb" @click="edit(null, 'server')">
            <Plus class="sm" /> Add a server
          </button>
        </section>

        <section v-if="shows('command')">
          <h3 v-if="!section" class="section-label"><Terminal class="sm" /> Commands</h3>
          <div v-if="commands.length" class="rows">
            <div v-for="x in commands" :key="x.name" class="row">
              <span class="nm">{{ x.name }}</span>
              <code class="mono line">{{ lineOf(x) }}</code>
              <span v-if="tagOf(x)" class="chip">{{ tagOf(x) }}</span>
              <span class="acts">
                <button class="icon-btn" :title="'Edit ' + x.name" @click="edit(x)">
                  <Pencil class="sm" />
                </button>
                <button class="icon-btn del" :title="'Delete ' + x.name" @click="remove(x)">
                  <Trash2 class="sm" />
                </button>
              </span>
            </div>
          </div>
          <p v-else class="none">Nothing declared here yet. A command is something you press once.</p>
          <button class="btn ghost addb" @click="edit(null, 'command')">
            <Plus class="sm" /> Add a command
          </button>
        </section>
      </div>

      <!-- ── the form ────────────────────────────────────────────────── -->
      <div v-else class="form">
        <label class="field">
          <span class="lbl">Name</span>
          <input ref="nameField" v-model="editing.name" class="input" placeholder="build" />
        </label>

        <div class="field">
          <span class="lbl">Runs in</span>
          <!-- Locked, the scope is a fact rather than a choice: moving this
               entry to another repository from inside a sheet that only shows
               one would make it vanish as it saved. -->
          <p v-if="locked" class="where" :title="folderOf">
            <FolderOpen class="sm" />
            <code class="mono">{{ folderShort }}</code>
          </p>
          <div v-else class="scopes">
            <button
              v-for="s in scopes"
              :key="s.repo"
              class="chip"
              :class="{ on: s.repo === editing.repo }"
              @click="editing.repo = s.repo"
            >
              <template v-if="!s.repo"><span class="dim">Project</span><span class="sep" aria-hidden="true" /></template>{{ s.repo || s.label }}
            </button>
          </div>
        </div>

        <label v-if="editing.kind === 'server' || !editing.runs.length" class="field">
          <span class="lbl">
            Command line
            <span class="dim">— not a shell: no pipes, no &amp;&amp;. <code class="mono">{{ T.port }}</code> is its own port.</span>
          </span>
          <textarea v-model="editing.cmd" class="input mono ta" rows="2" :placeholder="'npm run dev -- --port ' + T.port" />
        </label>

        <template v-if="editing.kind === 'server'">
          <label class="field">
            <span class="lbl">Address <span class="dim">— leave empty for something with no URL</span></span>
            <input v-model="editing.url" class="input mono" :placeholder="'http://localhost:' + T.port" />
          </label>
          <label class="field">
            <span class="lbl">Health path <span class="dim">— optional</span></span>
            <input v-model="editing.health" class="input mono" placeholder="/up" />
          </label>

          <div class="field">
            <span class="lbl">
              Environment
              <span class="dim">— <code class="mono">{{ T.api }}</code> reaches another server</span>
            </span>
            <div v-for="(e, i) in editing.env" :key="i" class="pair">
              <input v-model="e.key" class="input mono" placeholder="API_URL" />
              <input v-model="e.value" class="input mono" :placeholder="T.api" />
              <button class="icon-btn" title="Remove" @click="editing.env.splice(i, 1)"><X class="sm" /></button>
            </div>
            <button class="btn ghost addb" @click="addPair('env')"><Plus class="sm" /> Add a variable</button>
          </div>

          <label class="opt">
            <input v-model="editing.inStart" type="checkbox" />
            <span class="lab">Start it with one click</span>
          </label>
        </template>

        <template v-else>
          <div class="field">
            <span class="lbl">
              Runs <span class="dim">— in order, stopping at the first failure</span>
            </span>
            <div class="scopes">
              <button
                v-for="r in runnable"
                :key="r.kind + r.name"
                class="chip"
                :class="{ on: editing.runs.includes(r.name) }"
                @click="toggleRun(r.name)"
              >
                {{ r.name }}
                <span class="dim">· {{ r.kind === 'server' ? 'server' : r.repo || 'project' }}</span>
              </button>
            </div>
            <p v-if="editing.runs.length" class="order">{{ editing.runs.join(' → ') }}</p>
          </div>

          <div class="field">
            <span class="lbl">
              Asks first
              <span class="dim">— each becomes <code class="mono">{{ T.name }}</code> in the line</span>
            </span>
            <div v-for="(a, i) in editing.ask" :key="i" class="pair">
              <input v-model="a.key" class="input mono" placeholder="version" />
              <input v-model="a.label" class="input" placeholder="Version number" />
              <button class="icon-btn" title="Remove" @click="editing.ask.splice(i, 1)"><X class="sm" /></button>
            </div>
            <button class="btn ghost addb" @click="addPair('ask')"><Plus class="sm" /> Add a question</button>
          </div>

          <label class="opt">
            <input
              :checked="!!editing.confirm"
              type="checkbox"
              @change="editing.confirm = (($event.target as HTMLInputElement).checked ? 'true' : '')"
            />
            <span class="lab">Ask before running it</span>
          </label>
        </template>
      </div>

    <template #foot>
      <!-- Editing something that exists, the way to drop it is here, on the
           left, away from Save: it is the one act in this sheet that takes
           something away, and the list's trash is a 20px target on a row you
           are aiming at for another reason entirely. -->
      <button
        v-if="editing && previousName"
        class="btn ghost del"
        :disabled="busy"
        @click="remove(editing)"
      >
        <Trash2 class="sm" /> Delete
      </button>
      <span class="grow" />
      <template v-if="editing">
        <button class="btn ghost" @click="back">Cancel</button>
        <button class="btn primary" :disabled="!valid || busy" @click="save">
          {{ busy ? 'Saving…' : 'Save' }}
        </button>
      </template>
      <button v-else class="btn ghost" @click="close">Done</button>
    </template>
  </DialogShell>
</template>

<style scoped>
.grow { flex: 1; }
.dim { color: var(--text-dim); }

/* ── the title ─────────────────────────────────────────────────────── */
/* The icon is the kind, at the dim weight every other leading icon in this
   window has: it labels the heading, it is not part of it. */
.ti { flex: none; color: var(--text-dim); }
.tn { flex: none; }
/* The scope, as a chip — the same shape the bar uses for the branch, and the
   same one the scope chooser in this very sheet uses for the choice this is
   the result of. It is the part that gives way on a narrow window, because
   `Servers` is the answer to what the sheet is and the repository is context. */
/* The dot between a kind and a name — drawn, not typed.
 *
 * `·` sits a fixed distance above its own baseline, and that distance scales
 * with the font size: enlarging the glyph to make it visible also lifted it,
 * so it floated above the two words it was meant to sit between. A box has no
 * baseline of its own to drift from, and `vertical-align: middle` puts it on
 * the text's optical centre whatever the face is doing. */
.sep {
  display: inline-block;
  width: 3px;
  height: 3px;
  margin: 0 5px;
  border-radius: 50%;
  background: var(--text-dim);
  /* `middle` is the closest CSS gets: it centres on the x-height, which is
     where a dot belongs between two lowercase words. Both words here start
     with a capital, so the optical centre is higher — hence the nudge, in em
     so it tracks the type rather than the pixel it was measured at. A
     transform, because this is a correction to where it is *drawn* and it
     should not move anything around it. */
  vertical-align: middle;
  transform: translateY(-0.09em);
}

.ts {
  flex: 0 1 auto;
  min-width: 0;
  font-size: var(--fs-xs);
  font-weight: 500;
  letter-spacing: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
  line-height: 22px;
}

/* One rhythm for both faces of the sheet, and the same one SettingsDialog
   uses: a column with a fixed gap, rather than every block carrying its own
   margin and the sheet reading as whatever those happened to add up to. */
.list,
.form { display: flex; flex-direction: column; gap: 16px; padding-bottom: 6px; }

.scopes { display: flex; flex-wrap: wrap; gap: 6px; }
/* Only the chips you can press.
 *
 * These are the scope chooser's and the `runs:` picker's, and they answer to
 * the pointer because pressing them does something. The other two chips in
 * this sheet are labels — the scope on the title, and `not on Start` on a row
 * — and an unscoped `.chip:hover` had them lighting up under the cursor,
 * promising a click that does nothing. */
.scopes .chip:hover { color: var(--text); border-color: var(--line-strong); }
.scopes .chip.on { color: var(--text); border-color: var(--accent); background: var(--bg-sunken); }

/* Where this runs — the one fact above the list, and a labelled one.
   Bare, it was a path with no question attached to it, set in the loudest
   face on the sheet. */
.where {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.where .lucide { flex: none; width: 13px; height: 13px; opacity: 0.8; }
.where .wl { flex: none; }
.where code {
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

section { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
h3 { display: flex; align-items: center; gap: 6px; margin: 0; }
h3 .lucide { width: 13px; height: 13px; }

/* One card per declaration, spaced apart.
 *
 * They were a single block with hairlines through it, which is right for a
 * list you scan and pick from — and this is not one. Nothing here is
 * selected; each row is a thing with two buttons on it, and things you act on
 * individually should have an edge each rather than share one. */
.rows {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 6px 6px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-sunken);
  color: var(--text);
  text-align: left;
}
.nm { flex: none; font-size: var(--fs-sm); font-weight: 560; }
.line {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row .chip { flex: none; }

/* The two acts, named and aimable.
 *
 * The row used to be the edit button, with a small trash sitting inside it —
 * so the whole card did something, and the one part of it that did something
 * else was the smallest target on the sheet. Now neither is implicit: both
 * are `.icon-btn`, the window's own 28px square.
 *
 * Paired in a box of their own rather than left as two children of the row,
 * which is what put the row's own 10px between them: that gap is there to
 * part the name from the line from the chip, and applied between two buttons
 * that belong together it read as two unrelated controls drifting apart.
 * Inside here they are one cluster, and the 10px stays where it is useful —
 * between the cluster and everything to its left. */
.acts { flex: none; display: flex; align-items: center; gap: 1px; }

/* An empty half says what the half is for, rather than showing a heading with
   nothing under it. Not the full `.empty` block: this is one line inside a
   section that still has its button, not a screen with nothing on it. */
.none {
  align-self: stretch;
  margin: 0;
  padding: 12px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  font-size: var(--fs-xs);
  color: var(--text-dim);
  text-align: center;
}

/* The same button as every other button here, at the size the sheet's own
   controls are. It was a dashed box — a third shape, in a window that has
   exactly two. */
.addb {
  /* Never stretched. A `.btn` centres its label, so inside a `.field` — a
     column that stretches its children — "Add a question" sat in the middle
     of the sheet looking like a heading. The list's own sections align to the
     start already; this is the same rule where the column does not. */
  align-self: flex-start;
  height: 28px;
  padding: 0 10px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.addb:hover:not(:disabled) { color: var(--text); }
.addb .lucide { width: 13px; height: 13px; }

/* ── the form ──────────────────────────────────────────────────────── */
/* Uppercase kickers like SettingsDialog's, so a label reads as a label and
   the sentence beside it reads as help rather than as part of the name. */
.field { display: flex; flex-direction: column; gap: 7px; margin: 0; }
.lbl {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
}
/* The half of a label that is a sentence: not a kicker, so not uppercase and
   not letterspaced — `— NOT A SHELL: NO PIPES` was being shouted. */
.lbl .dim {
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}
.lbl code { font-size: var(--fs-xs); color: var(--text-muted); }
.ta { resize: vertical; line-height: 1.45; }
.pair { display: flex; align-items: center; gap: 6px; }
.pair .input { flex: 1; min-width: 0; }

/* What a `runs:` list will actually do, under the chips that build it. */
.order { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }

/* A row, not a checkbox with words after it — the same shape ConfirmDialog
   gives the one decision inside a question. */
.opt {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  color: var(--text-muted);
  transition: background var(--dur-1) var(--ease-soft);
}
.opt:hover { background: var(--hover); }
.opt input { flex: none; }

/* Red on hover only, for both Deletes — the row's icon button and the footer's.
   The footer one sits there for the whole time a form is open, and a
   permanently red button beside Save is a footer that looks alarmed.

   The size rule is the footer's alone: `.btn.del`, not `.del`, because the
   row's is an `.icon-btn` whose whole point is to be the window's full 28px
   target. Unscoped it shrank the thing it was meant to enlarge. */
.del { color: var(--text-dim); }
.del:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }
.btn.del .lucide { width: 13px; height: 13px; }
</style>
