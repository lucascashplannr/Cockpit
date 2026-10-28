<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { COMMIT_TYPES, normalizeCommitRules } from '@cockpit/shared'
import type { CommitRules } from '@cockpit/shared'
import {
  Bell, BellOff, FolderOpen, FolderTree, GitCommitHorizontal, Hand, MonitorCog, Moon, SlidersHorizontal, Sun,
} from '@lucide/vue'
import DialogShell from './DialogShell.vue'
import { hostNotify, pickFolder, saveSettings, setNotifyPref, setTheme, state } from '../core/store.js'

/**
 * §15 — "ce qui vit sur la machine" : settings that belong to this computer and
 * this person rather than to any repository. Anything a colleague would need
 * too belongs in the manifest instead.
 *
 * The sheet every other dialog is, with a section list down its left and one
 * row per setting. Nothing waits for a Save button: a choice is kept the
 * moment it is made, a typed value when the field is left, and the rules after
 * a short pause in typing. However the sheet closes, what is pending is kept.
 */

const SECTIONS = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'projects', label: 'Projects', icon: FolderTree },
  { id: 'commits', label: 'Commits', icon: GitCommitHorizontal },
] as const

const THEMES = [
  { id: 'system', label: 'System', icon: MonitorCog },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
] as const

const NOTIFY = [
  { id: 'all', label: 'All', title: 'Finished turns and approvals', icon: Bell },
  { id: 'approval', label: 'Approvals', title: 'Approvals only', icon: Hand },
  { id: 'off', label: 'Off', title: 'None', icon: BellOff },
] as const

const SCOPES = [
  { id: 'required', label: 'Required' },
  { id: 'optional', label: 'Optional' },
  { id: 'none', label: 'None' },
] as const

const section = computed(() => SECTIONS.find((s) => s.id === state.settingsSection) ?? SECTIONS[0])

const devRootInput = ref('')
const ide = ref('')
const rules = reactive<CommitRules>(normalizeCommitRules(null))
/** Set while the sheet loads its values, so the rules watcher does not save them back. */
let loading = false

watch(
  () => state.settingsOpen,
  (open) => {
    if (!open) {
      // The window's Escape closes this sheet without asking it, so pending
      // values are kept here, on the way out, rather than by a close button.
      void saveDevRoot()
      void saveIde()
      void saveRules()
      return
    }
    loading = true
    devRootInput.value = state.settings?.devRoot ?? ''
    ide.value = state.settings?.ide ?? ''
    Object.assign(rules, normalizeCommitRules(state.settings?.commitRules))
    queueMicrotask(() => { loading = false })
  },
  { immediate: true },
)

/* ── saving ─────────────────────────────────────────────────────────── */

async function saveDevRoot() {
  if (!state.settings) return
  const next = devRootInput.value.trim() || null
  if (next !== (state.settings.devRoot ?? null)) await saveSettings({ devRoot: next })
}

async function saveIde() {
  if (!state.settings) return
  const next = ide.value.trim()
  // The editor cannot be nothing; emptying the field puts the last one back.
  if (!next) ide.value = state.settings.ide
  else if (next !== state.settings.ide) await saveSettings({ ide: next })
}

let rulesTimer: ReturnType<typeof setTimeout> | null = null

async function saveRules() {
  if (rulesTimer) clearTimeout(rulesTimer)
  rulesTimer = null
  if (!state.settings) return
  const next = normalizeCommitRules(rules)
  if (JSON.stringify(next) === JSON.stringify(normalizeCommitRules(state.settings.commitRules))) return
  await saveSettings({ commitRules: next })
}

watch(rules, () => {
  if (loading) return
  if (rulesTimer) clearTimeout(rulesTimer)
  rulesTimer = setTimeout(() => void saveRules(), 500)
}, { deep: true })

/* ── commit rules ───────────────────────────────────────────────────── */

function toggleType(t: string) {
  // Never none: a rule that allows no prefix is one no message can follow.
  if (rules.types.includes(t)) {
    if (rules.types.length > 1) rules.types = rules.types.filter((x) => x !== t)
  } else {
    rules.types = COMMIT_TYPES.filter((x) => x === t || rules.types.includes(x))
  }
}

/** A message these rules would let through, rebuilt as they change. */
const example = computed(() => {
  const type = rules.types.includes('fix') ? 'fix' : rules.types[0] ?? 'fix'
  const head = rules.scope === 'none' ? type : type + '(core)'
  const tail = rules.sentences === 2 ? '. Release it only once the turn is undone' : ''
  return head + ': keep the lease when a turn fails' + tail
})

/* ── the sheet ──────────────────────────────────────────────────────── */

async function browse() {
  const picked = await pickFolder({
    title: 'Dev folder',
    message: 'Pick the folder that holds one folder per project',
    buttonLabel: 'Use this folder',
    ...(devRootInput.value ? { defaultPath: devRootInput.value } : {}),
  })
  if (picked) {
    devRootInput.value = picked
    await saveDevRoot()
  }
}

function close() {
  state.settingsOpen = false
}

function blurOnEnter(e: KeyboardEvent) {
  ;(e.target as HTMLInputElement).blur()
}
</script>

<template>
  <DialogShell v-if="state.settingsOpen" :title="section.label" :width="760" :height="540" @close="close">
    <template #side>
      <span class="section-label side-h">Settings</span>
      <button
        v-for="s in SECTIONS"
        :key="s.id"
        class="nav"
        :class="{ on: section.id === s.id }"
        @click="state.settingsSection = s.id"
      >
        <component :is="s.icon" class="sm ic" />{{ s.label }}
      </button>
      <span class="grow" />
      <span class="side-f" title="Kept in this machine's Cockpit folder, never in a repository">
        On this machine only
      </span>
    </template>

    <!-- General -->
    <template v-if="section.id === 'general'">
      <div class="row">
        <div class="txt"><span class="t">Theme</span></div>
        <div class="seg">
          <button
            v-for="t in THEMES"
            :key="t.id"
            :class="{ on: state.theme === t.id }"
            @click="setTheme(t.id)"
          >
            <component :is="t.icon" class="sm" />{{ t.label }}
          </button>
        </div>
      </div>

      <div v-if="hostNotify" class="row">
        <div class="txt">
          <span class="t">Notifications</span>
          <span class="d">A toast in the window, a system notification when Cockpit is in the background.</span>
        </div>
        <div class="seg">
          <button
            v-for="n in NOTIFY"
            :key="n.id"
            :class="{ on: state.notifications === n.id }"
            :title="n.title"
            @click="setNotifyPref(n.id)"
          >
            <component :is="n.icon" class="sm" />{{ n.label }}
          </button>
        </div>
      </div>
    </template>

    <!-- Projects -->
    <template v-else-if="section.id === 'projects'">
      <div class="row stack">
        <div class="txt">
          <span class="t" title="Dev/Project/repo/.git — never Dev/Project/.git">Dev folder</span>
          <span class="d">
            Where new projects are created{{
              !state.settings?.devRoot && state.suggestedDevRoot ? ' — suggested from where your projects already sit' : ''
            }}.
          </span>
        </div>
        <div class="pair">
          <input
            v-model="devRootInput"
            class="input mono"
            spellcheck="false"
            :placeholder="state.suggestedDevRoot ?? '/Users/you/Dev'"
            @change="saveDevRoot"
            @keydown.enter="blurOnEnter"
          />
          <button class="btn" title="Choose a folder" @click="browse"><FolderOpen />Browse</button>
        </div>
      </div>

      <div class="row">
        <div class="txt">
          <span class="t">Editor command</span>
          <span class="d"><span class="kbd">o</span> runs it with the folder as its argument.</span>
        </div>
        <input
          v-model="ide"
          class="input mono narrow"
          spellcheck="false"
          placeholder="code"
          @change="saveIde"
          @keydown.enter="blurOnEnter"
        />
      </div>
    </template>

    <!-- Commits: read by Draft only; a typed message is never checked. -->
    <template v-else>
      <div class="row" :class="{ stack: rules.on }">
        <div class="head-row">
          <div class="txt">
            <span class="t">Rules for Draft</span>
            <span class="d">
              {{ rules.on ? 'Draft follows these in every repository.' : 'Off: one line, in the style of the repository\'s recent commits.' }}
            </span>
          </div>
          <div class="seg">
            <button :class="{ on: !rules.on }" @click="rules.on = false">Off</button>
            <button :class="{ on: rules.on }" @click="rules.on = true">On</button>
          </div>
        </div>
        <code v-if="rules.on" class="ex mono" title="A message these rules allow">{{ example }}</code>
      </div>

      <template v-if="rules.on">
        <div class="row stack">
          <div class="txt"><span class="t">Types</span></div>
          <div class="chips">
            <button
              v-for="t in COMMIT_TYPES"
              :key="t"
              class="tchip mono"
              :class="{ off: !rules.types.includes(t) }"
              :title="rules.types.includes(t) ? 'Allowed — click to leave it out' : 'Left out — click to allow it'"
              @click="toggleType(t)"
            >{{ t }}</button>
          </div>
        </div>

        <div class="row">
          <div class="txt">
            <span class="t">Scope</span>
            <span class="d">The <code class="mono">(core)</code> after the type.</span>
          </div>
          <div class="seg">
            <button
              v-for="o in SCOPES"
              :key="o.id"
              :class="{ on: rules.scope === o.id }"
              @click="rules.scope = o.id"
            >{{ o.label }}</button>
          </div>
        </div>

        <div class="row">
          <div class="txt"><span class="t">Length</span></div>
          <div class="seg">
            <button :class="{ on: rules.sentences === 1 }" @click="rules.sentences = 1">1 sentence</button>
            <button :class="{ on: rules.sentences === 2 }" @click="rules.sentences = 2">2 sentences</button>
          </div>
        </div>

        <div class="row">
          <div class="txt"><span class="t">Language</span></div>
          <input v-model="rules.language" class="input narrow" spellcheck="false" placeholder="English" />
        </div>

        <div class="row">
          <div class="txt"><span class="t">Leave out</span></div>
          <div class="checks">
            <label class="check">
              <input v-model="rules.noTickets" type="checkbox" />
              <span>Ticket numbers <code class="mono">(#123)</code></span>
            </label>
            <label class="check">
              <input v-model="rules.noEmoji" type="checkbox" />
              <span>Emoji</span>
            </label>
          </div>
        </div>

        <div class="row stack">
          <div class="txt"><span class="t">Other rules</span></div>
          <textarea v-model="rules.extra" class="input ta" rows="3" spellcheck="false" placeholder="One rule per line" />
        </div>
      </template>
    </template>
  </DialogShell>
</template>

<style scoped>
.grow { flex: 1; }

/* ── the section list: the palette's rows, at the palette's numbers ── */
.side-h { padding: 2px 10px 12px; }
.nav {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  text-align: left;
  color: var(--text-muted);
}
.nav:hover { background: var(--hover); color: var(--text); }
.nav.on { background: var(--selected); color: var(--text); }
.ic { flex: none; color: var(--text-dim); opacity: 0.8; }
.nav.on .ic { color: var(--accent); opacity: 1; }
.side-f { padding: 0 10px; font-size: var(--fs-xs); color: var(--text-dim); }

/* ── one setting: the project sheet's row — what it is, then the control ── */
.row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--line-overlay);
}
.row:first-child { padding-top: 0; }
.row:last-child { border-bottom: none; }
.row > .seg, .row > .narrow, .row > .checks { flex: none; }
/* The control under the words, full width: a path, a list, a box. */
.row.stack { flex-direction: column; align-items: stretch; gap: 10px; }
.head-row { display: flex; align-items: center; gap: 16px; }
.txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.t { font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.d { font-size: var(--fs-xs); line-height: 1.5; color: var(--text-dim); }
.d code, .check code { color: var(--text-muted); }

.pair { display: flex; align-items: center; gap: 8px; }
.pair .input { flex: 1; min-width: 0; }
.pair .btn { flex: none; }
.narrow { width: 180px; }
.ta { resize: vertical; line-height: 1.5; }

.ex {
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

/* Allowed or left out: the project sheet's tracked / untracked chips. Neutral
   on purpose — tokens.css spends colour on meaning, and a rule is not one. */
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.tchip {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--hover);
  color: var(--text-muted);
  font-size: var(--fs-xs);
}
.tchip:hover { background: var(--active); color: var(--text); }
.tchip.off { background: none; box-shadow: inset 0 0 0 1px var(--line); color: var(--text-dim); }
.tchip.off:hover { color: var(--text-muted); }

.checks { display: flex; align-items: center; gap: 16px; }
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}
</style>
