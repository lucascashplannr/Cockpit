<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { FolderOpen, SlidersHorizontal, X } from '@lucide/vue'
import { pickFolder, saveSettings, state } from '../core/store.js'

/**
 * §15 — "ce qui vit sur la machine" : settings that belong to this computer and
 * this person rather than to any repository. Small on purpose. Anything a
 * colleague would need too belongs in the manifest instead.
 */

const devRootInput = ref('')
const ide = ref('')
const busy = ref(false)
const first = ref<HTMLInputElement | null>(null)

watch(
  () => state.settingsOpen,
  (open) => {
    if (!open) return
    devRootInput.value = state.settings?.devRoot ?? ''
    ide.value = state.settings?.ide ?? ''
    busy.value = false
    void nextTick(() => first.value?.focus())
  },
  { immediate: true },
)

const dirty = computed(
  () =>
    devRootInput.value.trim() !== (state.settings?.devRoot ?? '') ||
    ide.value.trim() !== (state.settings?.ide ?? ''),
)

function close() {
  if (!busy.value) state.settingsOpen = false
}

async function browse() {
  const picked = await pickFolder({
    title: 'Dev folder',
    message: 'Pick the folder that holds one folder per project',
    buttonLabel: 'Use this folder',
    ...(devRootInput.value ? { defaultPath: devRootInput.value } : {}),
  })
  if (picked) devRootInput.value = picked
}

async function save() {
  if (!dirty.value || busy.value) return
  busy.value = true
  const ok = await saveSettings({
    devRoot: devRootInput.value.trim() || null,
    ide: ide.value.trim() || state.settings?.ide,
  })
  busy.value = false
  if (ok) state.settingsOpen = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}
</script>

<template>
  <div v-if="state.settingsOpen" class="scrim" @mousedown.self="close" @keydown="onKey">
    <div class="dlg" role="dialog" aria-label="Settings">
      <header class="head">
        <SlidersHorizontal class="sm gi" />
        <h2>Settings</h2>
        <span class="grow" />
        <button class="icon-btn" title="Close (esc)" @click="close"><X class="sm" /></button>
      </header>

      <div class="body">
        <label class="field">
          <span class="lbl">Dev folder</span>
          <div class="row">
            <input
              ref="first"
              v-model="devRootInput"
              class="input mono"
              spellcheck="false"
              :placeholder="state.suggestedDevRoot ?? '/Users/you/Dev'"
              @keydown.enter="save"
            />
            <button class="btn" @click="browse"><FolderOpen />Browse</button>
          </div>
          <span class="help">
            Where new projects are created: one folder per project, and inside it one folder per
            repository — <code class="mono">Dev/Project/repo/.git</code>, never
            <code class="mono">Dev/Project/.git</code>. Keeping the project folder free of a
            repository of its own is what lets a second one join it later, and what an agent is
            pointed at to work across all of them at once.
          </span>
          <span v-if="!state.settings?.devRoot && state.suggestedDevRoot" class="help sug">
            Your projects already sit in
            <code class="mono">{{ state.suggestedDevRoot }}</code> — that is the suggestion above.
          </span>
        </label>

        <label class="field">
          <span class="lbl">Editor command</span>
          <input v-model="ide" class="input mono" spellcheck="false" placeholder="code" />
          <span class="help">
            Run with a folder as its argument when something is opened in an editor
            (<span class="kbd">o</span>).
          </span>
        </label>
      </div>

      <footer class="foot">
        <span class="rp">Kept on this machine, never written into a repository.</span>
        <span class="grow" />
        <button class="btn ghost" :disabled="busy" @click="close">Close</button>
        <button class="btn primary" :disabled="busy || !dirty" @click="save">
          {{ busy ? 'Saving…' : 'Save' }}
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
  animation: fade var(--dur-2) var(--ease-soft);
}
@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
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
  animation: rise var(--dur-3) var(--ease);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to { opacity: 1; transform: none; }
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

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px 8px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.field { display: flex; flex-direction: column; gap: 7px; }
.lbl {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.help { font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.65; }
.help code { color: var(--text-muted); }
.help.sug code { color: var(--accent); }
.row { display: flex; align-items: center; gap: 8px; }
.row .input { flex: 1; min-width: 0; }
.row .btn { flex: none; }

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
.rp { font-size: var(--fs-xs); color: var(--text-dim); }
</style>
