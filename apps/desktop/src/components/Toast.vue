<script setup lang="ts">
import { state } from '../core/store.js'
</script>

<template>
  <Transition name="t">
    <div v-if="state.toast" class="toast" :class="state.toast.kind">
      <span class="ic">{{ state.toast.kind === 'ok' ? '✓' : state.toast.kind === 'error' ? '!' : 'i' }}</span>
      <span class="msg selectable">{{ state.toast.text }}</span>
      <button class="x" @click="state.toast = null">✕</button>
    </div>
  </Transition>
</template>

<style scoped>
.toast {
  position: fixed;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 70;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(560px, 88vw);
  padding: 9px 10px 9px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--line-strong);
  background: var(--overlay);
  box-shadow: var(--shadow-overlay);
  font-size: var(--fs-sm);
  color: var(--text);
}
.ic {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  background: var(--hover);
  color: var(--text-muted);
}
.toast.ok .ic { background: var(--ok-soft); color: var(--ok); }
.toast.error .ic { background: var(--danger-soft); color: var(--danger); }
.msg { flex: 1; min-width: 0; line-height: 1.45; }
.x { flex: none; color: var(--text-dim); font-size: 10px; padding: 2px; }
.x:hover { color: var(--text); }

.t-enter-active, .t-leave-active { transition: opacity 140ms ease, transform 140ms ease; }
.t-enter-from, .t-leave-to { opacity: 0; transform: translateX(-50%) translateY(6px); }
</style>
