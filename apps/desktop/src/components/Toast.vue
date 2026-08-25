<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, X } from '@lucide/vue'
import { state } from '../core/store.js'
</script>

<template>
  <Transition name="t">
    <div v-if="state.toast" class="toast" :class="state.toast.kind">
      <span class="ic">
        <CircleCheck v-if="state.toast.kind === 'ok'" class="sm" />
        <CircleAlert v-else-if="state.toast.kind === 'error'" class="sm" />
        <Info v-else class="sm" />
      </span>
      <span class="msg selectable">{{ state.toast.text }}</span>
      <button class="x" title="Dismiss" @click="state.toast = null"><X class="sm" /></button>
    </div>
  </Transition>
</template>

<style scoped>
.toast {
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 70;
  display: flex;
  align-items: center;
  gap: 11px;
  max-width: min(560px, 88vw);
  padding: 11px 11px 11px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line-strong);
  background: var(--overlay);
  box-shadow: var(--shadow-md), var(--inset-top);
  font-size: var(--fs-sm);
  color: var(--text);
}
.ic {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}
.toast.ok .ic { color: var(--ok); }
.toast.error .ic { color: var(--danger); }
.msg { flex: 1; min-width: 0; line-height: 1.5; }
.x {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--text-dim);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.x:hover { color: var(--text); background: var(--hover); }

.t-enter-active, .t-leave-active {
  transition: opacity var(--dur-2) var(--ease-soft), transform var(--dur-2) var(--ease);
}
.t-enter-from, .t-leave-to { opacity: 0; transform: translateX(-50%) translateY(10px) scale(0.98); }
</style>
