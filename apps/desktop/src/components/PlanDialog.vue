<script setup lang="ts">
import { computed } from 'vue'
import { Flag, Layers, ShieldCheck, ShieldOff, TriangleAlert, X } from '@lucide/vue'
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

/**
 * §3.7 — a plan is all-or-nothing unless it says otherwise, and the difference
 * matters enough to be on screen before Apply rather than discovered after it.
 */
const halts = computed(() => plan.value?.onFailure === 'halt')

function cancel() {
  state.pendingPlan = null
}
</script>

<template>
  <div v-if="plan" class="scrim" @mousedown.self="cancel">
    <div class="dlg" role="dialog" :aria-label="plan.operation + ' plan'">
      <header class="head">
        <h2>{{ plan.operation }}</h2>
        <span v-if="destructive" class="chip danger">
          <TriangleAlert />rewrites history
        </span>
        <span class="grow" />
        <span class="count num">{{ plan.steps.length }} steps</span>
        <button class="icon-btn" title="Cancel" @click="cancel"><X class="sm" /></button>
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
        <div v-for="(w, i) in plan.warnings" :key="i" class="warn">
          <TriangleAlert class="sm" />
          <span>{{ w }}</span>
        </div>
      </div>

      <div class="mode" :class="{ halt: halts }">
        <component :is="halts ? Flag : Layers" class="sm" />
        <span v-if="halts">
          Stops at the first repository that conflicts. What already ran is kept, not rolled
          back — resolve it, then run this again.
        </span>
        <span v-else>
          All or nothing: if a step fails, the ones before it are undone in reverse.
        </span>
      </div>

      <footer class="foot">
        <!-- §16 — the restore point is what makes the undo button real. -->
        <span v-if="plan.capturesRestorePoint" class="rp">
          <ShieldCheck class="sm ok" />
          A restore point is captured first — undo stays available.
        </span>
        <span v-else class="rp dim">
          <ShieldOff class="sm" />
          Nothing destructive; no restore point needed.
        </span>
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
  background: var(--scrim);
  backdrop-filter: blur(6px) saturate(1.1);
  animation: fade var(--dur-2) var(--ease-soft);
}
@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
.dlg {
  width: min(660px, 92vw);
  max-height: 80vh;
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
  gap: 10px;
  padding: 16px 14px 14px 20px;
  border-bottom: 1px solid var(--line);
}
.head h2 {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 640;
  letter-spacing: -0.01em;
  text-transform: capitalize;
}
.grow { flex: 1; }
.count { font-size: var(--fs-xs); color: var(--text-dim); }

.steps { flex: 1; overflow-y: auto; padding: 8px 20px 12px; }
.step { display: flex; gap: 13px; padding: 11px 0; }
.step + .step { border-top: 1px solid var(--line-soft); }
.n {
  flex: none;
  width: 22px;
  height: 22px;
  margin-top: 1px;
  border-radius: 7px;
  background: var(--hover);
  color: var(--text-dim);
  font-size: var(--fs-xs);
  font-weight: 600;
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
  margin-top: 5px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  word-break: break-all;
  line-height: 1.5;
}

.warns { flex: none; padding: 0 20px 12px; }
.warn {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-xs);
  line-height: 1.55;
}
.warn .lucide { margin-top: 1px; }
.warn + .warn { margin-top: 6px; }

.mode {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 20px 12px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  line-height: 1.55;
}
.mode .lucide { margin-top: 1px; flex: none; }
.mode.halt { color: var(--text-muted); }

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
.rp {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  max-width: 58%;
}
.rp .ok { color: var(--ok); }
.rp.dim { color: var(--text-dim); }
</style>
