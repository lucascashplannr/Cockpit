<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { GitBranch, Layers, X } from '@lucide/vue'
import { openFeature, state } from '../core/store.js'

/**
 * §4 — opening a feature. One name, the repositories it spans, and the level
 * of ceremony; everything else is derived. What comes back is a plan (§3.7),
 * so this sheet never creates anything itself — it hands off to PlanDialog.
 */

const name = ref('')
const base = ref('')
const ceremony = ref<'C1' | 'C2' | 'C3'>('C3')
const selected = ref<string[]>([])
const busy = ref(false)
const nameInput = ref<HTMLInputElement | null>(null)

/** Only main checkouts: a feature forks from them, it does not nest in one. */
const repos = computed(() =>
  state.workspaces.filter((w) => w.projectId === state.activeProjectId && w.kind === 'main' && w.repo),
)

/** The branch and folder name, exactly as the core will compute it. */
const slug = computed(() =>
  name.value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'feature',
)

const taken = computed(() =>
  state.features.some((f) => f.projectId === state.activeProjectId && f.slug === slug.value && f.state !== 'archived'),
)

const canOpen = computed(() => !!name.value.trim() && selected.value.length > 0 && !taken.value)

watch(
  () => state.featureDialogOpen,
  (open) => {
    if (!open) return
    name.value = ''
    base.value = ''
    ceremony.value = repos.value.length > 1 ? 'C3' : 'C2'
    selected.value = repos.value.map((r) => r.id)
    busy.value = false
    void nextTick(() => nameInput.value?.focus())
  },
)

function close() {
  if (!busy.value) state.featureDialogOpen = false
}

async function submit() {
  if (!canOpen.value || busy.value) return
  busy.value = true
  await openFeature({
    name: name.value.trim(),
    ceremony: ceremony.value,
    repoWorkspaceIds: selected.value,
    ...(base.value.trim() ? { base: base.value.trim() } : {}),
  })
  busy.value = false
}
</script>

<template>
  <div v-if="state.featureDialogOpen" class="scrim" @mousedown.self="close" @keydown.esc="close">
    <div class="dlg" role="dialog" aria-label="Open a feature">
      <header class="head">
        <Layers class="sm gi" />
        <h2>Open a feature</h2>
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
            <span v-if="taken" class="bad">— already in use by an open feature</span>
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
            A <code class="mono">CONTEXT.md</code> will be created at the feature root. Fill it in
            before letting an agent span more than one of these.
          </p>
        </div>

        <div class="field">
          <span class="lbl">Ceremony</span>
          <div class="segs">
            <button class="seg" :class="{ on: ceremony === 'C1' }" @click="ceremony = 'C1'">
              <strong>C1</strong><span>branch in place</span>
            </button>
            <button class="seg" :class="{ on: ceremony === 'C2' }" @click="ceremony = 'C2'">
              <strong>C2</strong><span>isolated worktree</span>
            </button>
            <button class="seg" :class="{ on: ceremony === 'C3' }" @click="ceremony = 'C3'">
              <strong>C3</strong><span>worktrees + memory</span>
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
      </div>

      <footer class="foot">
        <span class="rp">Nothing is created until you approve the plan.</span>
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
