<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowLeft, Plus, Server, Terminal, Trash2, X } from '@lucide/vue'
import DialogShell from './DialogShell.vue'
import type { Declaration } from '@cockpit/shared'
import { loadDeclarations, removeDeclaration, saveDeclaration, state } from '../core/store.js'

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
const scope = ref('')
const editing = ref<Declaration | null>(null)
const previousName = ref<string | undefined>(undefined)
const confirming = ref<string | null>(null)
const busy = ref(false)
const nameField = ref<HTMLInputElement | null>(null)

const scopes = computed(() => d.value?.scopes ?? [])
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
  confirming.value = null
  await nextTick()
  nameField.value?.focus()
}

function back(): void {
  editing.value = null
  previousName.value = undefined
}

function close(): void {
  state.declareOpen = false
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

async function remove(decl: Declaration): Promise<void> {
  if (confirming.value !== decl.name) {
    confirming.value = decl.name
    return
  }
  confirming.value = null
  await removeDeclaration(decl.kind, decl.name)
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

watch(
  () => state.declareOpen,
  (open) => {
    if (!open) return
    back()
    scope.value = ''
    void loadDeclarations()
  },
)
</script>

<template>
  <DialogShell
    v-if="state.declareOpen"
    :title="editing ? (previousName ?? 'New ' + editing.kind) : 'Servers and commands'"
    @close="close"
  >
    <template #lead>
      <button v-if="editing" class="icon-btn" title="Back to the list" @click="back">
        <ArrowLeft class="sm" />
      </button>
    </template>

<!-- ── the list ────────────────────────────────────────────────── -->
      <div v-if="!editing">
        <!-- Scope is chosen before anything else because it decides the
             folder, and the folder is the part that surprises people. -->
        <div class="scopes">
          <button
            v-for="s in scopes"
            :key="s.repo"
            class="chip"
            :class="{ on: s.repo === scope }"
            @click="scope = s.repo"
          >
            {{ s.repo || s.label }}
            <span v-if="!s.repo" class="dim">· project</span>
          </button>
        </div>
        <p class="folder mono" :title="folderOf">{{ folderShort }}</p>

        <section>
          <h3><Server class="sm" /> Servers <span class="dim">— what stays up</span></h3>
          <button v-for="x in servers" :key="x.name" class="row" @click="edit(x)">
            <span class="nm">{{ x.name }}</span>
            <code class="mono line">{{ x.cmd }}</code>
            <span v-if="!x.inStart" class="tag">not on Start</span>
            <span
              class="mini"
              :class="{ arm: confirming === x.name }"
              :title="confirming === x.name ? 'Click again to remove' : 'Remove'"
              @click.stop="remove(x)"
            ><Trash2 /></span>
          </button>
          <button class="add" @click="edit(null, 'server')"><Plus class="sm" /> Add a server</button>
        </section>

        <section>
          <h3><Terminal class="sm" /> Commands <span class="dim">— what you press</span></h3>
          <button v-for="x in commands" :key="x.name" class="row" @click="edit(x)">
            <span class="nm">{{ x.name }}</span>
            <code v-if="x.runs.length" class="mono line">runs {{ x.runs.join(', ') }}</code>
            <code v-else class="mono line">{{ x.cmd }}</code>
            <span
              class="mini"
              :class="{ arm: confirming === x.name }"
              :title="confirming === x.name ? 'Click again to remove' : 'Remove'"
              @click.stop="remove(x)"
            ><Trash2 /></span>
          </button>
          <button class="add" @click="edit(null, 'command')"><Plus class="sm" /> Add a command</button>
        </section>
      </div>

      <!-- ── the form ────────────────────────────────────────────────── -->
      <div v-else>
        <label class="field">
          <span class="lbl">Name</span>
          <input ref="nameField" v-model="editing.name" class="input" placeholder="build" />
        </label>

        <div class="field">
          <span class="lbl">Runs in</span>
          <div class="scopes">
            <button
              v-for="s in scopes"
              :key="s.repo"
              class="chip"
              :class="{ on: s.repo === editing.repo }"
              @click="editing.repo = s.repo"
            >
              {{ s.repo || s.label }}
              <span v-if="!s.repo" class="dim">· project</span>
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
            <button class="add" @click="addPair('env')"><Plus class="sm" /> Add a variable</button>
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
            <p v-if="editing.runs.length" class="folder">{{ editing.runs.join(' → ') }}</p>
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
            <button class="add" @click="addPair('ask')"><Plus class="sm" /> Add a question</button>
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
.chip:hover { color: var(--text); border-color: var(--line-strong); }
.chip.on { color: var(--text); border-color: var(--accent); background: var(--bg-sunken); }
/* The folder, said once and quietly — it is the answer to "where does this
   run", and it should be readable without being the loudest thing here. */
.folder { margin: 8px 0 4px; font-size: var(--fs-xs); color: var(--text-muted); word-break: break-all; }

section { margin-top: 14px; }
h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-muted);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.row:hover { background: var(--bg-raised); border-color: var(--line); }
.nm { flex: none; font-size: var(--fs-sm); font-weight: 560; }
.line {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tag {
  flex: none;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
}
.mini { flex: none; display: inline-flex; padding: 3px; border-radius: var(--radius-sm); color: var(--text-dim); }
.mini :deep(svg) { width: 14px; height: 14px; }
.mini:hover { color: var(--text); background: var(--bg-sunken); }
/* Armed, not done: one more click removes it, and the colour is the warning. */
.mini.arm { color: var(--danger, crimson); background: var(--bg-sunken); }
.add {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 5px 10px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-dim);
  font-size: var(--fs-xs);
  cursor: pointer;
}
.add:hover { color: var(--text); border-color: var(--line-strong); }

.field { display: block; margin-bottom: 14px; }
.lbl { display: block; font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: 6px; }
.dim { color: var(--text-dim); }
.ta { width: 100%; resize: vertical; line-height: 1.45; }
.pair { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.pair .input { flex: 1; min-width: 0; }
.opt { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; font-size: var(--fs-sm); color: var(--text-dim); }
</style>
