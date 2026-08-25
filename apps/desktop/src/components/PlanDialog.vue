<script setup lang="ts">
import { computed } from 'vue'
import { applyPendingPlan, state } from '../core/store.js'

/**
 * §3.7 — "Toute opération affiche son plan avant de s'exécuter et laisse une
 * trace annulable." This dialog is that rule made visible: every command that
 * will run, in order, with the destructive ones marked before anything starts.
 *
 * §12 budget — rebase is two clicks: the button, then this confirmation.
 */

const plan = computed(() => state.pendingPlan)
const destructive = computed(() => plan.value?.steps.some((s) => s.destructive) ?? false)

function cancel() {
  state.pendingPlan = null
}
</script>

<template>
  <div v-if="plan" class="scrim" @mousedown.self="cancel">
    <div class="dlg" role="dialog" :aria-label="plan.operation + ' plan'">
      <header class="head">
        <h2>{{ plan.operation }}</h2>
        <span v-if="destructive" class="chip danger">rewrites history</span>
        <span class="grow" />
        <span class="count num">{{ plan.steps.length }} steps</span>
      </header>

      <div class="steps">
        <div v-for="(s, i) in plan.steps" :key="i" class="step" :class="{ bad: s.destructive }">
          <span class="n num">{{ i + 1 }}</span>
          <div class="body">
            <div class="title">{{ s.title }}</div>
            <code class="cmd mono selectable">{{ s.command }}</code>
          </div>
        </div>
      </div>

      <div v-if="plan.warnings.length" class="warns">
        <div v-for="(w, i) in plan.warnings" :key="i" class="warn">{{ w }}</div>
      </div>

      <footer class="foot">
        <!-- §16 — the restore point is what makes the undo button real. -->
        <span v-if="plan.capturesRestorePoint" class="rp">
          A restore point is captured first — undo stays available.
        </span>
        <span v-else class="rp dim">Nothing destructive; no restore point needed.</span>
        <span class="grow" />
        <button class="btn ghost" @click="cancel">Cancel</button>
        <button class="btn primary" :disabled="state.planBusy" @click="applyPendingPlan">
          {{ state.planBusy ? 'Running…' : 'Apply' }}
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
  background: rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(3px);
}
.dlg {
  width: min(620px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--overlay);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-overlay);
  overflow: hidden;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--line);
}
.head h2 {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 620;
  text-transform: capitalize;
}
.grow { flex: 1; }
.count { font-size: var(--fs-xs); color: var(--text-dim); }

.steps { flex: 1; overflow-y: auto; padding: 10px 16px; }
.step { display: flex; gap: 11px; padding: 7px 0; }
.step + .step { border-top: 1px solid var(--line); }
.n {
  flex: none;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 5px;
  background: var(--hover);
  color: var(--text-dim);
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.step.bad .n { background: var(--danger-soft); color: var(--danger); }
.body { min-width: 0; flex: 1; }
.title { font-size: var(--fs-sm); color: var(--text); }
.step.bad .title { color: var(--danger); font-weight: 550; }
.cmd {
  display: block;
  margin-top: 3px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  word-break: break-all;
}

.warns { flex: none; padding: 0 16px 10px; }
.warn {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-xs);
  line-height: 1.5;
}
.warn + .warn { margin-top: 5px; }

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
.rp { font-size: var(--fs-xs); color: var(--text-muted); max-width: 55%; }
.rp.dim { color: var(--text-dim); }
</style>
